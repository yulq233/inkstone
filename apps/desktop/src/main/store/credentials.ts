/**
 * 凭据的落盘与读取（`docs/11` §3.3）。
 *
 * 位置：`app.getPath('userData')/credentials.enc`，与 `settings.json` 同一个目录。
 *
 * ## 为什么必须加密，且必须由 `safeStorage` 加密
 *
 * 明文写在 `settings.json` 里的诱惑很大（少一个文件、少一次加解密、少一个"解不开"的分支）。
 * 但那份文件会被：
 * - 备份软件、云同步目录整个搬走；
 * - 用户为排查问题直接贴进 issue；
 * - 渲染进程通过 `settings:changed` 广播拿到（**它根本不需要 Key**）。
 *
 * `safeStorage` 走系统级加密（Windows DPAPI / macOS Keychain），密钥绑定当前用户账户，
 * 文件被复制到别的机器上也解不开。刻意**不引入 keytar**：它久未维护、带原生依赖，
 * 而我们需要的能力 Electron 已经内置。
 *
 * ## 为什么 `isEncryptionAvailable() === false` 时拒绝存储
 *
 * 某些 Linux 环境（没有 keyring）会返回 false。此时若退化成明文写盘，
 * 用户会以为"已经安全存好了"——**假加密比不加密更危险**，因为它改变了用户的行为
 * （敢把设备借给别人、敢贴配置文件）。所以宁可明确报错，让用户改用环境变量。
 *
 * ## 内存缓存是刻意的
 *
 * 每次请求都解密一遍既慢又会让 `decryptString` 的失败面变大。缓存与磁盘的一致性
 * 由"只有本模块能写"来保证：`app:` 没有任何其它地方碰这个文件。
 */

import fs from 'node:fs';
import path from 'node:path';
import { app, safeStorage } from 'electron';
import type { CredentialStatus, ProviderConfig } from '@inkstone/shared';
import {
  InvalidApiKeyError,
  credentialStatuses,
  decodeCredentialDoc,
  normalizeApiKey,
  parseCredentialDoc,
  serializeCredentialDoc,
  type CredentialCipher,
} from './credentials-io';
import { writeFileAtomicallySync } from './atomic-write';

/** 加密不可用时抛这个：IPC 层据此回一条"照着做就行"的提示，而不是 500。 */
export class SecureStorageUnavailableError extends Error {
  constructor() {
    super('系统加密不可用，无法安全保存密钥。');
    this.name = 'SecureStorageUnavailableError';
  }
}

/** 缓存：`null` 表示还没读盘。空 `Map` 是合法状态（用户清空过）。 */
let cache: Map<string, string> | null = null;

function log(message: string): void {
  // 只写 stderr：stdout 是 sidecar 的握手通道（`03` §6.1）
  process.stderr.write(`[inkstone] ${message}\n`);
}

export function credentialsFilePath(): string {
  return path.join(app.getPath('userData'), 'credentials.enc');
}

export function isSecureStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch (err) {
    // 在 app ready 之前调用会抛。这里当作"不可用"处理 —— 调用方本来就要处理这一支。
    log(`查询系统加密可用性失败：${String(err)}`);
    return false;
  }
}

function cipher(): CredentialCipher {
  if (!isSecureStorageAvailable()) throw new SecureStorageUnavailableError();
  return {
    encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
    decrypt: (encoded) => {
      try {
        return safeStorage.decryptString(Buffer.from(encoded, 'base64'));
      } catch {
        // 换机器 / 系统密钥重置 → 解不开。返回 null 让上层丢弃这一条并提示重填，
        // 而不是让整个文件读不出来（那会连能用的 Key 一起丢掉）。
        return null;
      }
    },
  };
}

/**
 * 原子写：先写同目录临时文件并**刷到介质**，再 rename（与 `settings.json` 同一策略）。
 *
 * 这里比 `settings.json` 更不能只做 rename（`docs/13` M16）：丢的是一个空文件的话，
 * 用户看到的不是"设置回到默认"，而是**所有 Key 一起没了**，且没有任何线索指向掉电。
 */
function writeDoc(entries: ReadonlyMap<string, string>): void {
  const file = credentialsFilePath();
  const doc = serializeCredentialDoc(entries, cipher());
  writeFileAtomicallySync(
    { file, tmp: `${file}.tmp`, dir: path.dirname(file) },
    `${JSON.stringify(doc, null, 2)}\n`,
  );
  // 权限收紧：即便内容已加密，也没必要让同机其它用户可读
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows 上 chmod 基本是空操作，失败不影响功能
  }
}

/** 读盘（首次调用时读，之后走缓存）。读不动就当空 —— 凭据缺失是可恢复状态。 */
export function loadCredentialStore(): ReadonlyMap<string, string> {
  if (cache !== null) return cache;

  const file = credentialsFilePath();
  let raw: unknown = null;
  let existed = false;
  try {
    if (fs.existsSync(file)) {
      existed = true;
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch (err) {
    log(`credentials.enc 不可读，按空处理（需要重新填写密钥）：${String(err)}`);
    raw = null;
  }

  const parsed = parseCredentialDoc(raw);

  // 版本不认识：留档、重建。**不删原文件** —— 万一那是未来版本写的，删掉就丢光了。
  if (parsed.unsupportedVersion && existed) {
    try {
      fs.renameSync(file, `${file}.bak`);
      log(`credentials.enc 的 schemaVersion 不认识，已留档为 ${file}.bak`);
    } catch (err) {
      log(`credentials.enc 留档失败：${String(err)}`);
    }
  }

  let entries = new Map<string, string>();
  let undecryptable = 0;
  if (Object.keys(parsed.doc.entries).length > 0) {
    const decoded = decodeCredentialDoc(parsed.doc, cipher());
    entries = decoded.entries;
    undecryptable = decoded.failed.length;
    if (undecryptable > 0) {
      // 只报 providerId，不报密文
      log(`有 ${undecryptable} 条凭据无法解密，已忽略：${decoded.failed.join(', ')}`);
    }
  }

  cache = entries;

  /**
   * 修正过 / 有解不开的条目 → 立刻写回，让磁盘与内存一致（同 `settings.json` 的策略）。
   *
   * ⚠️「解不开」也算修正，而且**这一支以前是漏的**（`docs/13` M16）：不回写的话，
   * 那些解不开的密文会永远留在文件里 —— 每次启动重复报同一条日志，
   * 而用户即使重填了 Key，文件里仍留着一条永远解不开的垃圾行。
   * 写回之后，内存里那份（已经只含成功的条目）就是唯一真源。
   */
  if (existed && (parsed.repaired || parsed.unsupportedVersion || undecryptable > 0)) {
    try {
      writeDoc(entries);
    } catch (err) {
      log(`credentials.enc 回写失败：${String(err)}`);
    }
  }

  return cache;
}

export function getCredential(providerId: string): string | null {
  return loadCredentialStore().get(providerId) ?? null;
}

/**
 * 写入一条密钥。返回规范化后的值（去掉了粘贴时带进来的首尾空白）。
 *
 * 写盘失败**不吞**：与设置不同，凭据失败必须让用户知道 ——
 * 否则会出现"界面上显示已保存，重启后要重填"这种无法解释的行为。
 */
export function setCredential(providerId: string, apiKey: string): void {
  const normalized = normalizeApiKey(apiKey);
  if (normalized === null) throw new InvalidApiKeyError();

  const next = new Map(loadCredentialStore());
  next.set(providerId, normalized);
  writeDoc(next);
  cache = next;
}

export function clearCredential(providerId: string): void {
  const current = loadCredentialStore();
  if (!current.has(providerId)) return;
  const next = new Map(current);
  next.delete(providerId);
  writeDoc(next);
  cache = next;
}

/**
 * 给渲染进程看的凭据状态。判断逻辑在 `credentials-io.ts`（纯函数、有单测），
 * 这里只负责"从缓存里取一份"这个副作用。
 */
export function credentialStatusesFor(providers: readonly ProviderConfig[]): CredentialStatus[] {
  return credentialStatuses(providers, loadCredentialStore());
}

/** 测试与"清空重来"用：丢掉缓存，下次访问重新读盘。 */
export function resetCredentialCache(): void {
  cache = null;
}
