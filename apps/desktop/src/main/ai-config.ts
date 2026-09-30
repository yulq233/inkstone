/**
 * 把 AI 配置与凭据推给 sidecar（`docs/11` §3.3 / §4.2 的 `PUT /ai/config`）。
 *
 * ## 为什么是"主进程推"，不是"sidecar 自己读"
 *
 * 凭据的真源在主进程（`safeStorage` 加密文件），sidecar 没有解密的钥匙，
 * 也不该有 —— 让它去读 `credentials.enc` 就等于把系统级加密降级成"谁都能读的文件"。
 * 于是由主进程解密后，经**本地回环 HTTP** 推过去，sidecar 只留在内存里。
 *
 * 代价是每次 sidecar 重启都要重推一次（内存里的东西没了）。这是**刻意的**：
 * sidecar 崩溃重启是它的正常自愈路径，重推挂在那条路径上，比"持久化在 sidecar 侧"
 * 少一份明文副本。
 *
 * ## 这个文件刻意不 import electron
 *
 * 它是纯的：入参是 `Settings` 与一份凭据表，出参是一个结果对象。
 * 测试因此能直接断言"推出去的 body 长什么样"，而不需要起整个 Electron。
 * `ConnectionSource` 用结构化类型而不是 `SidecarSupervisor`，就是为了不断掉这条可测性。
 */

import type {
  AiConfigRequest,
  AiConfigResponse,
  ProviderConfig,
  Settings,
  SidecarConnection,
} from '@inkstone/shared';
import { redactSecrets } from './redact';

/** 能提供当前连接信息的东西。`SidecarSupervisor` 天然满足，测试可以给个假的。 */
export interface ConnectionSource {
  getConnection(): SidecarConnection | null;
}

export interface AiPushDeps {
  settings: Settings;
  /** 明文密钥。**只在这里、只往回环地址发一次**，不进日志、不落盘 */
  credentials: ReadonlyMap<string, string>;
}

export type AiPushOutcome =
  { ok: true; providers: number; credentials: number } | { ok: false; reason: string };

/** 回环请求，5 秒足够。刻意不复用渲染进程的 `lib/api.ts`（它硬编码 10 秒且面向长任务）。 */
const PUSH_TIMEOUT_MS = 5_000;

/**
 * 只写 stderr：stdout 是 sidecar 的握手通道（`03` §6.1）。
 *
 * 刻意从 `globalThis` 上取 `process` 而不是直接写 `process.stderr.write`：
 * 本模块**没有环境依赖**，而它被单元测试直接 import —— 测试跑在
 * `tsconfig.web.json` 下（`types: ["vite/client"]`，没有 node 类型），
 * 直接写 `process` 会编译不过。这与 `settings-io.ts` 保持 electron-free 是同一条约束：
 * 「能被测试直接 import 的主进程模块」不能依赖主进程独有的全局。
 */
function log(message: string): void {
  const sink = (globalThis as { process?: { stderr?: { write(chunk: string): void } } }).process;
  sink?.stderr?.write(`[inkstone] ${message}\n`);
}

/**
 * 组装推送体。
 *
 * **每个字段都显式写出来**，不做 `{...something}` 的展开：
 * sidecar 侧每个字段都是必填（`schemas.py` 有理由 —— `offlineOnly` 是隐私开关，
 * 漏传它会 fail-open）。展开写法在重构时最容易漏掉一个，而漏掉的症状是
 * "整份配置被拒"，排查方向会跑偏到网络去。
 *
 * P1 把 `defaultModel` / `styleCard` / `dailyBudgetCny` 也加了进来
 * （`docs/11` §7.3.1 的 D-5）：这三个 P0 时不需要（P0 只做"测试连接"），
 * 但一次生成要用到它们 —— 少一个的症状分别是"生成报未配置""风格卡不生效"
 * "预算永不拦截"，全是**静默失效**，所以宁可在这里多写三行。
 */
export function buildAiConfigBody(deps: AiPushDeps): AiConfigRequest {
  const { settings, credentials } = deps;
  const providers: ProviderConfig[] = settings.ai.providers;
  const known = new Set(providers.map((provider) => provider.id));

  const outgoing: Record<string, string> = {};
  for (const [providerId, secret] of credentials) {
    // 只发当前存在的供应商的 Key：已删供应商的 Key 留在磁盘上是为了"删错了能恢复"，
    // 但没有任何理由再让它上一次网络（哪怕只是回环）。
    if (known.has(providerId) && secret !== '') outgoing[providerId] = secret;
  }

  return {
    providers,
    credentials: outgoing,
    offlineOnly: settings.ai.offlineOnly,
    routing: settings.ai.routing,
    defaultProviderId: settings.ai.defaultProviderId,
    defaultModel: settings.ai.defaultModel,
    styleCard: settings.ai.styleCard,
    dailyBudgetCny: settings.ai.dailyBudgetCny,
    // P1-b：侧车靠它算 `POST /ai/preview` 的 `needsConfirm`（"这一次要不要弹确认卡"）。
    // 只在**当前仍存在**的供应商上生效由两边各自过滤（`parseEgressAcks` / `AiState.apply`），
    // 所以这里原样带上即可 —— 多一层过滤只会造出第三份规则。
    acknowledgedEgressProviders: settings.ai.acknowledgedEgressProviders,
  };
}

/**
 * 把失败信息压成一句能进日志、也能直接显示给用户的话。
 *
 * **出口统一脱敏**（`redact.ts`）：`reason` 会同时进日志与 IPC 提示，
 * 而上游（我们的 sidecar、或它转述的模型服务）有可能把请求头原样带回来。
 * 在这里擦一次，两条路都覆盖 —— 放到日志那一层就漏了 UI 这一层。
 */
function describeHttpError(status: number, text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null) {
      const envelope = (parsed as { error?: { code?: unknown; message?: unknown } }).error;
      const code = typeof envelope?.code === 'string' ? envelope.code : '';
      const message = typeof envelope?.message === 'string' ? envelope.message : '';
      if (code !== '' || message !== '')
        return redactSecrets(`HTTP ${status} ${code} ${message}`.trim());
    }
  } catch {
    // 不是 JSON：多半是反代/错误页，往下走用状态码说话
  }
  return `HTTP ${status}`;
}

/** 发一次推送。**不抛异常** —— 调用方有两处是"顺带推一次"的旁路，抛出来没人接。 */
export async function postAiConfig(
  connection: SidecarConnection,
  body: AiConfigRequest,
): Promise<AiPushOutcome> {
  try {
    const response = await fetch(`${connection.baseUrl}/api/v1/ai/config`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Inkstone-Token': connection.token,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    });

    if (!response.ok)
      return { ok: false, reason: describeHttpError(response.status, await response.text()) };

    const payload = (await response.json()) as AiConfigResponse;
    return {
      ok: true,
      providers: payload.applied.providers,
      credentials: payload.applied.credentials,
    };
  } catch (err) {
    // 传输层异常也过一遍脱敏：`fetch` 的报错里出现过完整 URL 与请求头的情况
    return { ok: false, reason: redactSecrets(`请求失败：${String(err)}`) };
  }
}

/**
 * 取当前连接 → 组装 → 推送 → 记日志。
 *
 * sidecar 还没就绪（`getConnection()` 为 `null`）时直接返回失败而**不排队**：
 * 就绪那一刻 `onStatus(HEALTHY)` 会再触发一次，排队反而会出现"两次推送、后一次带着旧设置"。
 */
export async function pushAiConfig(
  source: ConnectionSource,
  deps: AiPushDeps,
): Promise<AiPushOutcome> {
  const connection = source.getConnection();
  if (connection === null) {
    return { ok: false, reason: '本地服务还没就绪' };
  }

  const body = buildAiConfigBody(deps);
  const outcome = await postAiConfig(connection, body);

  if (outcome.ok) {
    log(`AI 配置已推送 providers=${outcome.providers} credentials=${outcome.credentials}`);
  } else {
    // 刻意不打印 body（里面有明文 Key）
    log(`AI 配置推送失败：${outcome.reason}`);
  }
  return outcome;
}
