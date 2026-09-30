/**
 * 凭据文件的**纯逻辑**（`docs/11` §3.3 / §4.5）。
 *
 * 这个文件一行 electron 都没有 —— 与 `settings-io.ts` 同一条理由：
 * 加解密是 `safeStorage` 的事，但"文件里该长什么样、坏成什么样还能救、密钥形状合不合法"
 * 全是纯判断，测试环境载不进 electron，混在一起就只能靠手点验证。
 * 所以这里把加密算法抽象成 `CredentialCipher` 注入进来，真实实现（`credentials.ts`）
 * 是唯一 import electron 的地方。
 *
 * ## 文件形态
 *
 * ```json
 * { "schemaVersion": 1, "entries": { "deepseek": "<base64 密文>" } }
 * ```
 *
 * 为什么是"一个文件、多条密文"，而不是"每条一个文件"：
 * 一次修改就要整体重写一次，多文件会引入"部分写成功"的中间态
 * —— 而它的表现是"某个供应商的 Key 时有时无"，最难查。
 *
 * 为什么外面套一层 `schemaVersion` 而不是直接放 entries：
 * 将来可能换加密方式（或加 `createdAt`），有版本号就能像 `settings.json` 那样原地迁移。
 */

import type { CredentialStatus, ProviderConfig } from '@inkstone/shared';

export const CREDENTIALS_SCHEMA_VERSION = 1;

/** 认识的版本。将来加 v2 时把 2 塞进来，`parseCredentialDoc` 就能原地迁移。 */
const SUPPORTED_VERSIONS: readonly number[] = [1];

/** 密钥长度的合法区间（去空白之后）。 */
const KEY_MIN_LENGTH = 4;
const KEY_MAX_LENGTH = 512;

/**
 * 加解密接口。
 *
 * `decrypt` 返回 `null` 而不是抛异常：解不开是一个**正常事件**
 * （换了机器、DPAPI 密钥被重置、手工替换过文件），不是程序错误 ——
 * 让它抛异常会把"某个 Key 失效"升级成"整个凭据文件读不出来"，于是所有 Key 一起丢。
 */
export interface CredentialCipher {
  encrypt(plain: string): string;
  decrypt(encoded: string): string | null;
}

/** 密钥形状不合法。单独成类是为了让 IPC 层能把它和"写盘失败"分开报。 */
export class InvalidApiKeyError extends Error {
  constructor() {
    super('密钥格式看起来不对，请重新复制粘贴一次。');
    this.name = 'InvalidApiKeyError';
  }
}

export interface CredentialDoc {
  schemaVersion: number;
  /** providerId → base64(密文)。**不含明文** */
  entries: Record<string, string>;
}

export interface ParsedCredentials {
  doc: CredentialDoc;
  /** 有字段被丢弃/修正（坏条目、未知版本）。调用方据此决定要不要写回 */
  repaired: boolean;
  /** 版本号完全不认识 → 调用方应留档后重建，而不是就地迁移 */
  unsupportedVersion: boolean;
}

export interface DecodedCredentials {
  entries: Map<string, string>;
  /** 解不开的 providerId。进日志（不含密文），用于解释"为什么 Key 要重填" */
  failed: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 空文档。第一次运行、或文件坏到无法挽救时用它。 */
export function emptyCredentialDoc(): CredentialDoc {
  return { schemaVersion: CREDENTIALS_SCHEMA_VERSION, entries: {} };
}

/**
 * 解析磁盘上的任意内容。
 *
 * 与 `settings.json` 的自愈策略一致，但**更保守**：凭据不像主题那样有默认值可回退，
 * 所以任何一条不认识的内容都只丢弃那一条，其余照用 ——
 * "一个 providerId 写成大写"不该让其它供应商的 Key 一起失效。
 */
export function parseCredentialDoc(raw: unknown): ParsedCredentials {
  if (!isRecord(raw)) {
    return { doc: emptyCredentialDoc(), repaired: true, unsupportedVersion: false };
  }

  const version = raw.schemaVersion;
  if (typeof version === 'number' && !SUPPORTED_VERSIONS.includes(version)) {
    // 版本不认识：不动它的内容，交给调用方留档 —— 万一是"未来版本写出来的"，
    // 就地按 v1 解读会把新字段全删掉。
    return {
      doc: emptyCredentialDoc(),
      repaired: true,
      unsupportedVersion: true,
    };
  }

  const rawEntries = raw.entries;
  const entries: Record<string, string> = {};
  let repaired = version !== CREDENTIALS_SCHEMA_VERSION || !isRecord(rawEntries);

  if (isRecord(rawEntries)) {
    for (const [providerId, encoded] of Object.entries(rawEntries)) {
      // 只收非空字符串：`null` / 数字 / 对象都是被改坏的行，留着会在解密时抛
      if (typeof encoded === 'string' && encoded !== '') entries[providerId] = encoded;
      else repaired = true;
    }
  }

  return {
    doc: { schemaVersion: CREDENTIALS_SCHEMA_VERSION, entries },
    repaired,
    unsupportedVersion: false,
  };
}

export function serializeCredentialDoc(
  entries: ReadonlyMap<string, string>,
  cipher: CredentialCipher,
): CredentialDoc {
  const out: Record<string, string> = {};
  for (const [providerId, plain] of entries) {
    if (plain === '') continue;
    out[providerId] = cipher.encrypt(plain);
  }
  return { schemaVersion: CREDENTIALS_SCHEMA_VERSION, entries: out };
}

/**
 * 把文档里的密文解成明文表。
 *
 * 解不开的条目**如实报告并跳过**，绝不整体失败：一次系统级密钥变更会让所有密文都解不开，
 * 那时用户看到的应该是"需要重填 Key"，而不是"读取凭据文件失败，请重装应用"。
 */
export function decodeCredentialDoc(
  doc: CredentialDoc,
  cipher: CredentialCipher,
): DecodedCredentials {
  const entries = new Map<string, string>();
  const failed: string[] = [];
  for (const [providerId, encoded] of Object.entries(doc.entries)) {
    const plain = cipher.decrypt(encoded);
    if (plain === null || plain === '') failed.push(providerId);
    else entries.set(providerId, plain);
  }
  return { entries, failed };
}

/**
 * 密钥形状检查：去空白后长度在区间内，且**不含空白与控制字符**。
 *
 * 为什么先 trim：从网页复制 Key 时带上首尾换行/空格是极高频的事，
 * 直接判"含空白 → 不合法"会把一个几乎人人都踩的坑变成一次拦截 ——
 * 而真正该修的是那个不可见的字符，不是用户。
 *
 * 为什么**不检查前缀**（`sk-` 之类）：自定义供应商与中转服务的 Key 形态不限，
 * 按前缀拒绝会把能用的配置拦在门外。形状检查只拦"明显不是密钥"的输入。
 */
export function normalizeApiKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length < KEY_MIN_LENGTH || trimmed.length > KEY_MAX_LENGTH) return null;
  // eslint-disable-next-line no-control-regex -- 就是要拦控制字符（粘贴时混进来的 U+0000~U+001F）
  if (/[\s\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

/**
 * 给渲染进程看的凭据状态。
 *
 * **只回布尔，不回任何形式的 Key**（`docs/11` §4.4）：连脱敏提示也不给 ——
 * "存的是哪一把"这件事由「测试连接」回答，那是一次真请求，比看四个字符可靠。
 */
export function credentialStatuses(
  providers: readonly ProviderConfig[],
  entries: ReadonlyMap<string, string>,
): CredentialStatus[] {
  return providers.map((provider) => ({
    providerId: provider.id,
    hasCredential: (entries.get(provider.id) ?? '') !== '',
  }));
}
