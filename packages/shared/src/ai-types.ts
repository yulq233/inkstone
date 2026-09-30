/**
 * AI 能力的共享契约（`docs/11` §4.1）。
 *
 * ## 一条贯穿全文件的原则：**一个事实只有一个真源**
 *
 * 最容易出错的是"Key 配没配"。三处都可能想知道（渲染进程画徽标、主进程决策、sidecar 发请求），
 * 于是很自然会想让 sidecar 的 `/ai/providers` 直接返回 `hasCredential` —— 但那会造出两个真源：
 * 一旦推送失败，两边就会分叉，界面显示"已配置"而请求报 `AI_CREDENTIAL_MISSING`。
 *
 * 所以：
 * - **凭据真源 = 主进程**（`safeStorage` 加密文件），渲染进程只从 IPC 读 `CredentialStatus`；
 * - **供应商配置真源 = 主进程**（`settings.json` 的 `ai.providers`），推送副本给 sidecar 用于发请求；
 * - sidecar 的 `/ai/providers` 只回"配置"，**不含任何凭据信息**。
 *
 * ## 为什么供应商配置放在 shared 而不是各写一份
 *
 * 与 `settings.ts` 同一条理由：`PROVIDER_PRESETS` 的默认 `baseUrl` 要同时被
 * 渲染进程（填进输入框）、主进程（校验与落盘）、sidecar（拼接请求 URL）用到。
 * 各写一份的结果是"界面里是 A 地址、实际请求发给 B 地址"这种只在特定供应商上复现的怪问题。
 */

/** 上游协议类型。v1 只有两种（`docs/11` §3.4）。 */
export type ProviderKind = 'openai-compatible' | 'ollama';

export const PROVIDER_KINDS = ['openai-compatible', 'ollama'] as const;

export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  /** 界面上显示的名字 */
  label: string;
  /** 基础地址，**不带** `/chat/completions` 这类路径后缀 */
  baseUrl: string;
  /**
   * 本机模型（不外传）。决定两件事：是否受"纯本地模式"限制、隐私文案怎么写。
   * 这是一条**语义**字段而不是从 baseUrl 猜出来的：自定义端点也可能指向本机代理，
   * 猜错的代价是"用户以为不出门，其实出门了"。
   */
  local: boolean;
  /** 是否需要 API Key。Ollama 不需要 —— 它决定了界面上要不要显示 Key 输入框 */
  needsKey: boolean;
}

/**
 * 内置预设。用户可以在界面上改 `baseUrl`，也可以新增自定义项。
 *
 * 全部走 OpenAI 兼容协议：国产主流（DeepSeek / 百炼 / Kimi / GLM / 硅基流动）
 * 都提供兼容端点，一套客户端就够（`docs/11` §3.4 的判据）。
 */
export const PROVIDER_PRESETS: readonly ProviderConfig[] = [
  {
    id: 'deepseek',
    kind: 'openai-compatible',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    local: false,
    needsKey: true,
  },
  {
    id: 'dashscope',
    kind: 'openai-compatible',
    label: '通义千问（百炼）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    local: false,
    needsKey: true,
  },
  {
    id: 'moonshot',
    kind: 'openai-compatible',
    label: 'Kimi（月之暗面）',
    baseUrl: 'https://api.moonshot.cn/v1',
    local: false,
    needsKey: true,
  },
  {
    id: 'zhipu',
    kind: 'openai-compatible',
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    local: false,
    needsKey: true,
  },
  {
    id: 'openai',
    kind: 'openai-compatible',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    local: false,
    needsKey: true,
  },
  {
    id: 'ollama',
    kind: 'ollama',
    label: 'Ollama（本机）',
    baseUrl: 'http://127.0.0.1:11434',
    local: true,
    needsKey: false,
  },
] as const;

/** 一个可供选择的模型。v1 只用到 `id` 与展示名，不猜上下文窗口（拉不到就不编）。 */
export interface ModelSpec {
  id: string;
  label: string;
}

/** 凭据状态。**只有主进程能回答**（见文件头）。 */
export interface CredentialStatus {
  providerId: string;
  /**
   * 是否已存有密钥。
   *
   * 刻意**没有** "脱敏提示" 字段（形如 `sk-a***xyz`）：`docs/11` §4.4 规定
   * "Key 只在此通道出现，主进程不外回显"。而"存的到底是哪一把"由「测试连接」回答
   * —— 那是一次真请求，比看四个字符可靠得多，也少一份 Key 片段在渲染进程里流动。
   */
  hasCredential: boolean;
}

/** `ai:setCredential` 的入参。**明文 Key 只在这条 IPC 上出现一次**。 */
export interface AiCredentialSetRequest {
  providerId: string;
  apiKey: string;
}

/**
 * `ai:setCredential` / `ai:clearCredential` 的结果。
 *
 * 刻意用**返回值**而不是抛异常：`ipcMain.handle` 里抛出的错误到了渲染进程只剩一句
 * "Error invoking remote method 'ai:setCredential': ..."，用户看不懂、我们也定位不到。
 * 返回值能让失败原因（`kind`）与用户可读文案（`message`）各归各位。
 */
export type AiCredentialResult =
  | { ok: true; statuses: CredentialStatus[] }
  | {
      ok: false;
      kind: 'invalid-key' | 'storage-unavailable' | 'write-failed' | 'unknown-provider';
      message: string;
    };

/** 按任务分模型的目标（`docs/01` §4.3）。 */
export interface AiRouteTarget {
  providerId: string;
  model: string;
}

/**
 * 任务槽位。**别急着合并**：这里的每个值都会变成用户可见的一行设置，
 * 也会变成 `ai_run.taskType` 的取值 —— 两者必须是同一份清单，否则统计口径会漂移。
 */
export const AI_TASKS = ['continue', 'rewrite', 'deai', 'quick', 'outline', 'summarize'] as const;

export type AiTask = (typeof AI_TASKS)[number];

export const AI_TASK_LABEL: Record<AiTask, string> = {
  continue: '续写',
  rewrite: '改写 / 润色',
  deai: '去 AI 味',
  quick: '快捷生成（起名、对白、钩子…）',
  outline: '大纲与蓝图',
  summarize: '摘要抽取（建议用便宜模型）',
};

export type AiRouting = Record<AiTask, AiRouteTarget | null>;

/** 未配置时的 routing：全部为 null，由界面提示"先选一个模型"。 */
export function emptyAiRouting(): AiRouting {
  return {
    continue: null,
    rewrite: null,
    deai: null,
    quick: null,
    outline: null,
    summarize: null,
  };
}

/**
 * AI 偏好。落在主进程 `settings.json` 的 `ai` 段（`docs/11` §4.1 / §4.5）。
 *
 * ⚠️ **这里永远不出现 API Key**。Key 在 `safeStorage` 加密过的另一个文件里。
 * 把 Key 放进这个接口的诱惑很大（省一个文件、省一条 IPC），代价是它会随
 * `settings:changed` 广播给渲染进程、并被 `settings.json` 以明文写盘 —— 两条都不能接受。
 */
export interface AiSettings {
  /** 用户当前认识的供应商（预设 + 自定义）。真源在主进程 */
  providers: ProviderConfig[];
  /** 界面上"默认用哪个"，也是 routing 未配置时的兜底 */
  defaultProviderId: string | null;
  /**
   * 默认模型名（`defaultProviderId` 那一家的）。
   *
   * ⚠️ **`docs/11` §4.1 的原始契约里漏了这一个字段**，是写 P0 时补的：
   * 只有 `defaultProviderId` + `routing` 的话，"配好了供应商但还没给每个任务分模型"
   * 这个**唯一真实存在过的中间状态**没有任何地方能存模型名 ——
   * 于是"填好 Key → 测试连接 → 重启后仍可用"这条 P0 验收走不通。
   *
   * 与 `routing` 的优先级（P1 实现生成时按此取值）：`routing[task]` 优先，
   * 为 `null` 时回落到 `{defaultProviderId, defaultModel}`，两者任一为空则视为未配置。
   */
  defaultModel: string;
  routing: AiRouting;
  /** 单日成本上限（元）。0 = 不限，但仍记录用量 */
  dailyBudgetCny: number;
  /**
   * 纯本地模式：**禁止一切外发**（`docs/01` §9.3）。
   *
   * 由网关**单点**拦截（`docs/11` §9）。放在这里而不是界面上，
   * 是因为它是"该不该发请求"的判断依据，必须能随配置一起推给 sidecar。
   */
  offlineOnly: boolean;
  /**
   * 每次生成前是否弹"将发送什么"确认（本机模型忽略此开关）。
   *
   * ⚠️ **本字段目前没有任何读取点**（`docs/11` §7.3.3 的 D-12）。它在 P0 就写进了契约，
   * 但"每次生成前都弹一次"对写作流是实打实的打扰，而它的默认值恰好是 `true` ——
   * 接线等于把打扰设成默认行为，还要顺带做一次默认值迁移。
   * 所以 P1-b/3b 只做**首次强制确认**（见下一条）与**手动打开预览**，
   * 这个开关留到后续批次，届时连同默认值一起定。
   */
  confirmContextPreview: boolean;
  /**
   * 已经确认过"可以把内容发往这家"的**非本机**供应商 id。
   *
   * ## 为什么必须有它，以及为什么真源在主进程
   *
   * `docs/11` §2.3 要求「首次启用某个非本机供应商时，必须弹一次」，即**不可被开关绕过**。
   * 于是"弹过没有"必须能跨启动保留。而 sidecar 的 `AiState` 是纯内存、
   * 每次重启由主进程重推（`ai/state.py` 文件头）—— 把它存在 sidecar 就等于
   * "每次 sidecar 自愈都重新弹一次卡"，那是把一个安全提示变成噪声。
   *
   * ## 只记 id，不记时间戳
   *
   * 记时间戳会让"撤销确认"变成"删掉一行"，而 `settings.json` 的未知字段保留策略
   * 会让历史越攒越多。这里要回答的问题只有"这家确认过没有"。
   */
  acknowledgedEgressProviders: string[];
  /** 风格卡（`docs/01` §3.7.4）。v1 是手写文本，自动统计留到 P3 */
  styleCard: string;
  /** 接受生成后是否在文末追加"AI 草稿"标记。默认关 */
  markAiDraft: boolean;
}

/** 单日成本上限的合法范围。0 表示不限；上限是防手滑输入一个天文数字。 */
export const DAILY_BUDGET = { min: 0, max: 10_000 } as const;

export const DEFAULT_AI_SETTINGS: AiSettings = {
  providers: PROVIDER_PRESETS.map((preset) => ({ ...preset })),
  defaultProviderId: null,
  defaultModel: '',
  routing: emptyAiRouting(),
  dailyBudgetCny: 0,
  offlineOnly: false,
  confirmContextPreview: true,
  acknowledgedEgressProviders: [],
  styleCard: '',
  markAiDraft: false,
};

/**
 * 按 id 找供应商。找不到回 `null`（**不回第一个**：静默换一家会让请求打到用户没看的地方）。
 */
export function providerById(
  providers: readonly ProviderConfig[],
  id: string | null,
): ProviderConfig | null {
  if (id === null) return null;
  return providers.find((provider) => provider.id === id) ?? null;
}

/**
 * 用新的配置替换掉同 id 的那一条，**其余字段与顺序不动**，返回新数组。
 *
 * 为什么值得单独一个函数：界面上改 `baseUrl` 时最容易写成
 * `{ id, baseUrl }` 这样一个"半截对象"，而 `local` / `needsKey` 一旦丢了，
 * 后果是**一个本机模型被当成云端**（受纯本地模式拦截）或反过来。
 * 这个函数要求传入完整的 `ProviderConfig`，编译期就堵住那条路。
 */
export function replaceProvider(
  providers: readonly ProviderConfig[],
  next: ProviderConfig,
): ProviderConfig[] {
  return providers.map((provider) => (provider.id === next.id ? { ...next } : provider));
}

/** 模型名的形状：非空、无空白与控制字符。省得把 `'  '` 当成一个配好的模型存下去。 */
export function normalizeModelName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > 200) return null;
  // 模型名里合法地出现 `/` `:` `-` `_` `.`（`deepseek/deepseek-chat`、`qwen3:8b`），
  // 但**不会有空白** —— 有空白只可能是粘贴时带进来的
  // eslint-disable-next-line no-control-regex -- 就是要拦控制字符
  if (/[\s\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

/** 把任意输入收敛成本地限额。非有限数一律落回 0（不限）。 */
export function clampDailyBudget(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : DAILY_BUDGET.min;
  return Math.min(DAILY_BUDGET.max, Math.max(DAILY_BUDGET.min, n));
}

/** 供应商 id 的形状：小写字母、数字、连字符。它会被拼进日志与 URL，不许有空白与斜杠。 */
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function isValidProviderId(value: unknown): value is string {
  return typeof value === 'string' && PROVIDER_ID_PATTERN.test(value);
}

export function isProviderKind(value: unknown): value is ProviderKind {
  return typeof value === 'string' && (PROVIDER_KINDS as readonly string[]).includes(value);
}

/**
 * `baseUrl` 的形态检查：必须带 `http://` 或 `https://` 前缀，且有非空 host。
 *
 * ⚠️ **刻意不用 `new URL()`**：本包的 `lib` 只有 `ES2023`、`types` 为空
 * （见 `tsconfig.json`）—— 它刻意不依赖 DOM 与 Node 的全局对象，因为渲染进程与主进程
 * 都要引它。`URL` 在两边都有，但在这里就是编译不过；为了一个校验函数去放开 `lib`，
 * 代价是以后谁都能在这个包里写 `document.xxx`，那是更大的问题。
 *
 * 这条检查的作用是拦"用户少打一个 `https://`"与"填了个 `javascript:`"这两种情况。
 * 它们不检查的后果分别是：请求发不出去（错误信息只说 Invalid URL，定位不到用户填了什么）
 * 和 `fetch` 被喂进一个奇怪的东西。
 */
const BASE_URL_PATTERN = /^https?:\/\/[^\s/?#]+(?::\d{1,5})?(?:\/[^\s]*)?$/i;

export function isValidBaseUrl(value: unknown): value is string {
  return typeof value === 'string' && BASE_URL_PATTERN.test(value.trim());
}

/** 把用户填的 baseUrl 规范化：去空白、去末尾斜杠（拼接路径时少一个坑）。 */
export function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

// ---------------------------------------------------------------------------
// 生成（P1，docs/11 §4.1）
// ---------------------------------------------------------------------------

/**
 * 快捷生成的子类型。
 *
 * ⚠️ **必须与 sidecar 的 `ai/prompts/quick.toml` 里的 `[kinds]` 键逐字一致**：
 * 那边认不出一个 kind 时不会报错，只会渲染出空指令 —— 用户拿到的是一段
 * "没按要求来的"输出，而错误信息里一个字都不会提。改这里就要改那边。
 */
export const AI_QUICK_KINDS = [
  'naming',
  'dialogue',
  'scene',
  'hook',
  'direction',
  'synopsis',
  'title',
] as const;

export type AiQuickKind = (typeof AI_QUICK_KINDS)[number];

export const AI_QUICK_LABEL: Record<AiQuickKind, string> = {
  naming: '起名（人名、地名、组织名）',
  dialogue: '写一段对白',
  scene: '补一个场景描写',
  hook: '给章末写几个钩子',
  direction: '给几个剧情走向',
  synopsis: '写作品简介',
  title: '给这一章起标题',
};

/** 一次生成请求（`POST /ai/continue` 与 `/ai/quick` 的请求体）。 */
export interface AiGenRequest {
  workId: string;
  chapterId: string;
  /**
   * 光标前文。**由渲染进程提供** —— sidecar 读磁盘读到的是上次保存的版本，
   * 用户刚敲完还没保存的那些字它看不见，而那恰恰是最该被续上的部分。
   */
  prefix: string;
  /** 光标之后的已有内容。续写时为 `''`。 */
  suffix: string;
  /** 用户附加的指令（"别改人名""节奏慢一点"）。 */
  intent?: string;
  /** 风格卡的临时覆盖（不写回设置）。 */
  styleCard?: string;
  /** 覆盖模板里的 temperature。 */
  temperature?: number;
  maxTokens?: number;
  /**
   * 忽略单日预算拦截。
   *
   * 存在的理由：`docs/11` §6.4 要求超预算时"弹一次确认"而不是硬阻断，
   * 而确认之后重发的那一次必须能过。没有这个开关的话，护栏只能二选一 ——
   * 要么硬阻断，要么形同虚设。
   */
  force?: boolean;
}

/**
 * 预览请求（`POST /ai/preview`，`docs/11` §6.4 / §6.7）。
 *
 * 与 `AiGenRequest` **同一份字段**再加一个 `kind`：预览要回答的是
 * "这一次真的要发什么"，所以它必须走**同一条路由解析与同一份装配**。
 * 另造一套精简请求的后果是"预览里显示的模型与实际用的不是同一个"——
 * 那比不给预览更糟（用户据此做的判断是错的）。
 */
export interface AiPreviewRequest extends AiGenRequest {
  /** 快捷生成的子类型（`AI_QUICK_KINDS`）。留空 = 续写。 */
  kind?: AiQuickKind;
}

/**
 * `ai:setEgressAck` 的入参 —— 记录/撤销"已确认可以把内容发往这家"。
 *
 * 为什么是一条**主进程独占读改写**的通道，而不是让渲染进程算好整个数组再 `settings:set`：
 * 渲染进程要算数组就得先读到它，而读到的副本可能与磁盘上的已经不同
 * （设置面板开着时主进程改了、或多窗口）。这里只有"加一个 id / 去一个 id"两种意图，
 * 交给主进程在**同一份当前值**上做，就不存在覆盖别人改动的问题。
 */
export interface AiEgressAckRequest {
  providerId: string;
  /** `true` = 记下"已确认"；`false` = 撤销（下次生成会重新弹卡）。 */
  acknowledged: boolean;
}

/** `ai:setEgressAck` 的结果。与凭据那条同款：用返回值而不是抛异常。 */
export type AiEgressAckResult =
  | { ok: true; acknowledgedEgressProviders: string[] }
  | { ok: false; kind: 'unknown-provider' | 'write-failed'; message: string };

/** 传给模型的上下文里，因预算被丢掉的一块。**必须回报给 UI**（docs/11 §3.5）。 */
export interface AiDropInfo {
  /** `docs/01` 的记忆金字塔层级：`L0`~`L5` 或 `manual`。 */
  source: string;
  title: string;
  tokens: number;
  reason: 'budget' | 'offline';
}

export interface AiBudgetReport {
  budget: number;
  used: number;
  remaining: number;
}

/**
 * 一次生成的收尾方式。**闭合三值**，由 sidecar 保证：
 *
 * - `stop` —— 模型正常收尾。上游的 `tool_calls` / `end_turn` / `stop_sequence`
 *   等方言由网关归一到这个值（见 `gateway.py` 的 `_FINISH_REASON_ALIASES`）。
 * - `length` —— 撞到 `max_tokens`，正文可能被截断（界面据此提示"可继续写"）。
 * - `aborted` —— 用户点了停止。**本地产生**，上游永远不会发这个值。
 *
 * ⚠️ 上游的 `finish_reason` 是**开放集合**，归一化发生在 sidecar 网关里。
 * 渲染进程对不认识的值报协议错误是**安全**的（它确实只可能是实现 bug）——
 * 正因为归一化在源头，这个严格校验才成立。
 */
export type AiFinishReason = 'stop' | 'length' | 'aborted';

export const FINISH_REASONS = ['stop', 'length', 'aborted'] as const;

export function isFinishReason(value: unknown): value is AiFinishReason {
  return typeof value === 'string' && (FINISH_REASONS as readonly string[]).includes(value);
}

/**
 * SSE 事件（每条 `data:` 都是一个 JSON）。
 *
 * `meta` 里带 `dropped` / `budget` 而不是单独开一个"预览"接口：
 * 用户问"它到底看到了什么"时，要的正是**这一次**实际发出去的东西。
 * 顺带满足隐私要求（`docs/11` §6.4 的「将发送什么」）—— 一份数据两个用途。
 */
export type AiStreamEvent =
  | {
      type: 'meta';
      runId: string;
      providerId: string;
      model: string;
      /** 本次用的提示模板，便于"同一段文字、换了模板"的回归对比。 */
      templateId: string;
      templateVersion: number;
      dropped: AiDropInfo[];
      budget: AiBudgetReport;
      /** 外发字符量（发给上游的 system+user 字符数）。审计口径，见 `AiRun.egressChars`。 */
      egressChars: number;
    }
  | { type: 'delta'; text: string }
  | { type: 'usage'; promptTokens: number; completionTokens: number; costCny: number | null }
  | { type: 'done'; finishReason: AiFinishReason }
  | { type: 'error'; code: string; message: string; traceId?: string };

/**
 * 一条 AI 运行记录（`docs/11` §3.6，落在 `<作品>/.inkstone/ai/runs.jsonl`）。
 *
 * 字段与 `docs/01` §5.1 的 `ai_run` 表逐列对齐，这样 M2 建 SQLite 时是纯搬运。
 */
export interface AiRun {
  id: string;
  workId: string;
  /** 本地时间带时区偏移。**不是 UTC** —— "今日用量"是按用户本地的今天算的。 */
  at: string;
  taskType: AiTask;
  /** `chapter:<id>` 或 `work:<id>` */
  targetRef: string;
  providerId: string;
  model: string;
  /** 只存摘要，**不存 prompt 正文**（体积 + 隐私，docs/11 §3.6 的 D5）。 */
  promptDigest: string;
  contextTokens: number;
  outputTokens: number;
  /** **外发字符量** —— 外发审计（docs/01 §9.3）靠它。 */
  egressChars: number;
  /** 估算成本（元）。认不出模型时是 `null`，**不编数**。 */
  costCny: number | null;
  latencyMs: number;
  firstTokenMs: number;
  /** 采纳结果来自 `feedback.jsonl`，读的时候按 id 合并（见 sidecar 的 `ai/runs.py`）。 */
  accepted: 'full' | 'partial' | 'none' | null;
  acceptedChars: number | null;
  /**
   * 这次生成是否被中断（用户点停止，或连接断了）。
   *
   * 由 **sidecar** 判定并写进 `runs.jsonl`：它观察得到上游连接被关闭。
   * 渲染进程不再单独上报这个字段 —— 两个真源会在"用户点了停止但请求其实已经正常结束"
   * 这种竞态下分叉。
   */
  stopped: boolean;
  error: string | null;
}

/** `POST /ai/runs/{id}/feedback` 的请求体。 */
export interface AiRunFeedback {
  /** 运行记录是**按作品**存的，所以必须带上是哪个作品。 */
  workId: string;
  accepted: 'full' | 'partial' | 'none';
  acceptedChars: number;
}

/** `GET /ai/runs` 的当日用量汇总（跨作品）。 */
export interface AiUsageSummary {
  /** 本地日期 `YYYY-MM-DD`。 */
  date: string;
  spentCny: number;
  runs: number;
  /**
   * 无法估价（模型名认不出）的条数。**它 > 0 时 `spentCny` 是偏低的**，
   * 所以必须报出来 —— 否则用户会以为"预算还早着呢"。
   */
  unpricedRuns: number;
  egressChars: number;
  limitCny: number;
  /** 是否已达上限。0（不限）时恒为 false。 */
  exceeded: boolean;
}
