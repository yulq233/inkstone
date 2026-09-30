import type {
  AiBudgetReport,
  AiDropInfo,
  AiRouting,
  AiRun,
  AiUsageSummary,
  ModelSpec,
  ProviderConfig,
} from './ai-types';

/** GET /api/v1/healthz */
export interface HealthzResponse {
  ok: boolean;
  version: string;
  uptimeMs: number;
}

/**
 * 我们真正会支持的平台。
 * 刻意不用 `NodeJS.Platform` —— 那会把共享包绑到 @types/node 上，
 * 而渲染进程的 tsconfig 并不加载 node 类型（浏览器里本来就没有 process）。
 */
export type DesktopPlatform = 'win32' | 'darwin' | 'linux';

/** 主进程握手就绪行解析结果（INKSTONE_READY {...}） */
export interface SidecarReadyPayload {
  /** 协议版本 */
  v: number;
  /** 内核分配的实际监听端口 */
  port: number;
  /** sidecar 进程号，供主进程强杀使用 */
  pid: number;
  /** sidecar 版本 */
  version: string;
}

export interface AppInfo {
  /** 桌面应用版本 */
  version: string;
  platform: DesktopPlatform;
  userDataPath: string;
  logDir: string;
  isPackaged: boolean;
  /**
   * 实际的 Chromium `proxy-bypass-list` 取值。
   *
   * 之所以由主进程透出来而不是渲染进程自己拼一份：故障页要回答的是"**实际生效的**
   * 是什么"，渲染进程猜一份等于没答。见 `proxy.ts`。
   */
  proxyBypassList: string;
}

export interface PickDirectoryRequest {
  title?: string;
  defaultPath?: string;
}

export interface PickDirectoryResult {
  canceled: boolean;
  path?: string;
}

/**
 * 关窗前"请渲染进程落盘"的答复（IPC `app:flushResult`）。
 *
 * 刻意不复用 `Autosave.flush()` 的返回值语义：渲染侧把 `flush() === false`
 * 翻译成 `{ ok: false, reason }`，主进程据此决定是直接关还是问用户。
 * `ok: true` 也包含"本来就没有未保存内容"这一情况 —— 主进程不需要区分。
 */
export interface FlushResult {
  ok: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// 作品与章节（POST /works、/works/open、/works/{id}/chapters …）
// ---------------------------------------------------------------------------

/**
 * 章节状态。**必须与 `domain/chapter.py` 的 `CHAPTER_STATUSES` 一致** ——
 * 少列一个值不会报错，只会让前端在某章进入那个状态时拿到一个"类型上不可能"的字符串，
 * 然后 switch 落到 default 分支静默显示成别的东西。
 */
export type ChapterStatus = 'draft' | 'revising' | 'done';

/**
 * 作品概要。`chapterCount` 与 `totalWords` 是**现算**的，
 * 不是从 work.json 里读的 —— 那里面不存可推导的信息（02 文档 §6.3）。
 */
export interface WorkSummary {
  id: string;
  title: string;
  author: string;
  genre: string;
  tags: string[];
  wordGoal: number;
  dailyGoal: number;
  /** 作品目录绝对路径。是"打开已有作品"的凭据，也是删除最近记录时的键 */
  rootPath: string;
  createdAt: string;
  updatedAt: string;
  chapterCount: number;
  totalWords: number;
}

/** 章节列表项。刻意不含正文 —— 上百章时整文件读入会明显变慢。 */
export interface ChapterSummary {
  id: string;
  /** 从 1 开始。真源是目录名前缀，重排后这个值会变而 `id` 不变 */
  order: number;
  /** 取自正文首个 ATX 标题行；没有标题行时是占位文字 */
  title: string;
  status: ChapterStatus;
  wordCount: number;
  /** 章节目录名（`001-第一章`），仅供排查问题与展示 */
  dirName: string;
}

/** 章节正文。`hash` 是乐观并发控制用的基值，必须原样回传给 PUT。 */
export interface ChapterContent {
  id: string;
  order: number;
  title: string;
  status: ChapterStatus;
  markdown: string;
  /** 磁盘内容的 sha256 前 16 位 */
  hash: string;
  wordCount: number;
  /** 文件 mtime；文件不存在时为 null */
  savedAt: string | null;
}

/** PUT 章节正文的返回。 */
export interface WriteChapterResult {
  /** 写入后内容的新 hash，下一次保存要拿它当 baseHash */
  hash: string;
  wordCount: number;
  savedAt: string | null;
  /**
   * 本次写入覆盖掉了磁盘版本时，备份文件的绝对路径；没有覆盖时为 null。
   * 服务端**总是**返回这个键（不传就是 null），所以这里不是可选字段 ——
   * 写成可选会让"字段名被改坏"这件事在编译期溜过去。
   */
  backupPath: string | null;
}

/** 最近打开列表项。`exists` 是读取时现算的，目录被移动后为 false。 */
export interface RecentWork {
  rootPath: string;
  title: string;
  lastOpenedAt: string;
  exists: boolean;
}

// ---- 请求体 ----

export interface CreateWorkRequest {
  parentDir: string;
  title: string;
  author?: string;
  genre?: string;
  wordGoal?: number;
}

export interface OpenWorkRequest {
  rootPath: string;
}

export interface CreateChapterRequest {
  title: string;
  /** 插到这一章后面；不传则追加到末尾 */
  afterChapterId?: string | null;
}

export interface UpdateChapterRequest {
  markdown: string;
  /** 读取时拿到的 hash。与磁盘不一致会返回 409 EXTERNAL_MODIFIED */
  baseHash: string;
  /**
   * 冲突后"保留我的并覆盖"时置 true。
   * 服务端会先把磁盘版本原子备份到 `.inkstone/backups/`，再写入 —— 这一条不可省，
   * 否则用户选择覆盖的那一刻，磁盘上的版本就彻底没了（03 文档 §6.6）。
   */
  backup?: boolean;
}

// ---- 响应体 ----

export interface WorkResponse {
  work: WorkSummary;
}

export interface RecentWorksResponse {
  items: RecentWork[];
}

export interface RemoveRecentResponse {
  removed: boolean;
}

export interface ChapterListResponse {
  items: ChapterSummary[];
}

export interface ChapterResponse {
  chapter: ChapterContent;
}

export interface CreateChapterResponse {
  chapter: ChapterSummary;
}

/** 409 EXTERNAL_MODIFIED 的 `detail` 形状 —— 冲突对话框据此展示磁盘版本。 */
export interface ExternalModifiedDetail {
  diskHash: string;
  diskMarkdown: string;
  diskSavedAt: string | null;
}

export function isExternalModifiedDetail(value: unknown): value is ExternalModifiedDetail {
  if (typeof value !== 'object' || value === null) return false;
  const d = value as Record<string, unknown>;
  return typeof d.diskHash === 'string' && typeof d.diskMarkdown === 'string';
}

// ---------------------------------------------------------------------------
// Codex（设定条目，docs/15 B1）与大纲（B2）—— 与 sidecar 的响应形状一一对应。
// ---------------------------------------------------------------------------

/** 设定条目类型。与 sidecar `domain/codex.py` 的 `CodexType` 一致。 */
export type CodexType = 'character' | 'location' | 'faction' | 'item' | 'concept';

/** 有向关系。`to` 是对方条目的 slug（文件名）。 */
export interface CodexRelation {
  to: string;
  kind: string;
  note: string;
}

/** 清单项（不含 body/fields/relations —— 清单不放大字段）。 */
export interface CodexEntrySummary {
  type: CodexType;
  slug: string;
  name: string;
  aliases: string[];
  tags: string[];
  summary: string;
  hash: string;
}

/** 全量条目（含 body/fields/relations）。 */
export interface CodexEntry extends CodexEntrySummary {
  fields: Record<string, unknown>;
  relations: CodexRelation[];
  body: string;
}

/** 断链清单项（D-2）。 */
export interface BrokenRelation {
  type: CodexType;
  slug: string;
  name: string;
  to: string;
  kind: string;
}

export interface CodexListResponse {
  items: CodexEntrySummary[];
}

export interface CodexEntryResponse {
  entry: CodexEntry;
}

export interface BrokenRelationsResponse {
  items: BrokenRelation[];
}

/** 新建/更新条目。`slug`/`hash` 是服务端派生字段，不在请求体里（extra=forbid 会拦）。 */
export interface CreateCodexRequest {
  type: CodexType;
  name: string;
  aliases?: string[];
  tags?: string[];
  fields?: Record<string, unknown>;
  summary?: string;
  relations?: CodexRelation[];
  body?: string;
}

export interface UpdateCodexRequest extends CreateCodexRequest {
  ifMatch: string;
}

/** 伏笔登记。`id` 空串 = 服务端补齐。 */
export interface Foreshadow {
  id: string;
  title: string;
  expectResolveBy: number | null;
  status: 'open' | 'resolved' | 'dropped';
  resolvedIn: string | null;
}

export interface ForeshadowInput {
  id?: string;
  title: string;
  expectResolveBy?: number | null;
  status?: 'open' | 'resolved' | 'dropped';
  resolvedIn?: string | null;
}

/** 伏笔聚合项（含扫描派生的 orphan / overdue）。 */
export interface ForeshadowItem extends Foreshadow {
  chapterId: string;
  orphan: boolean;
  overdue: boolean;
}

export interface ForeshadowListResponse {
  items: ForeshadowItem[];
}

/** 总纲（纯正文）。`hash` 空串 = 尚未创建。 */
export interface GeneralOutline {
  body: string;
  hash: string;
}

/** 卷纲清单项。 */
export interface VolumeOutlineSummary {
  order: number;
  title: string;
  slug: string;
  hash: string;
}

export interface VolumeOutline extends VolumeOutlineSummary {
  body: string;
}

export interface VolumeListResponse {
  items: VolumeOutlineSummary[];
}

export interface VolumeOutlineResponse {
  volume: VolumeOutline;
}

export interface ChapterOutline {
  chapterId: string;
  foreshadow: Foreshadow[];
  body: string;
  hash: string;
}

export interface ChapterOutlineResponse {
  outline: ChapterOutline;
}

// ---------------------------------------------------------------------------
// AI（`docs/11` P0）—— 与 `ai-types.ts` 的分工：那里是**跨进程共享的领域类型**，
// 这里是**端点的信封**。混在一起会让"改一个字段"变成"改两处"。
// ---------------------------------------------------------------------------

/** GET /ai/providers —— 只回配置，**不含任何凭据信息**（见 `ai-types.ts` 文件头）。 */
export interface AiProvidersResponse {
  items: ProviderConfig[];
}

/** GET /ai/providers/{id}/models */
export interface AiModelsResponse {
  items: ModelSpec[];
}

/** POST /ai/test —— 真发一次最小请求，所以能验出"Key 对不对"，而不只是"地址通不通"。 */
export interface AiTestRequest {
  providerId: string;
  model: string;
}

export interface AiTestResponse {
  ok: boolean;
  /** 端到端耗时（含 DNS / TLS / 首 token），界面直接显示，比"很快"这种词有用 */
  latencyMs: number;
  model: string;
  /** 模型实际回的前几个字，用于确认"确实是这个模型在答" */
  echo: string;
}

/**
 * GET /ai/runs —— 记录与用量**一起回**。
 *
 * `since` 为空串时按 `limit` 取最近若干条；带 `since` 时按时间戳过滤（增量刷新用）。
 */
export interface AiRunsRequest {
  workId: string;
  since?: string;
  limit?: number;
}

export interface AiRunsResponse {
  /**
   * 当前作品的生成记录。
   *
   * ⚠️ 是**按作品**的：`runs.jsonl` 落在 `<作品>/.inkstone/ai/` 下。
   * 换作品就要重新拉，别把上一个作品的外发记录显示给用户。
   */
  items: AiRun[];
  /** ⚠️ 是**跨作品**的：单日预算是用户的钱包，不是某一部作品的钱包。 */
  usage: AiUsageSummary;
}

/**
 * PUT /ai/config —— **主进程 → sidecar 的单向推送**，不是渲染进程调用的端点。
 *
 * 为什么是一条"推全量配置"的端点，而不是 `/ai/credentials` 那种单项接口：
 * sidecar 侧需要配置是**一致的一份快照**（provider 列表 + 凭据 + 纯本地开关 + 分模型），
 * 分三次推会在中途产生"provider 有了但凭据没到"的窗口，表现为偶发的
 * `AI_CREDENTIAL_MISSING` —— 而它只在启动那几秒出现，最难复现。
 *
 * ⚠️ `credentials` 里是**明文 Key**。它只允许出现在这条本地回环请求上：
 * 不进日志（sidecar 侧 `register_secrets` 会按值擦除）、不落盘、不回显。
 */
export interface AiConfigRequest {
  providers: ProviderConfig[];
  /** providerId → 明文 API Key。没有 Key 的供应商（如 Ollama）不出现在这里 */
  credentials: Record<string, string>;
  offlineOnly: boolean;
  routing: AiRouting;
  defaultProviderId: string | null;
  /**
   * 默认模型名（`defaultProviderId` 那一家的）。
   *
   * ⚠️ **P0 漏推、P1 补上的字段**（`docs/11` §7.3.1 的 D-5）。
   * 单看 P0 的验收（填 Key → 测试连接 → 重启仍可用）它确实用不到，
   * 所以当初只推了 `routing`。但生成时要按 `docs/01` §4.3 取值 ——
   * `routing[task]` 优先、为 null 时回落到 `{defaultProviderId, defaultModel}` ——
   * 少了这一个，**"配好了供应商、还没给任何任务分模型"这个唯一真实存在过的中间状态
   * 在 sidecar 侧无从落地**，生成会直接报 `AI_NOT_CONFIGURED`，而界面上明明配好了。
   */
  defaultModel: string;
  /** 风格卡（`docs/01` §3.7.4）。v1 是用户手写的文本，装配器把它拼进系统指令 */
  styleCard: string;
  /**
   * 单日成本上限（元）。0 = 不限。
   *
   * 也属于 P0 漏推：`AiSettings.dailyBudgetCny` 与 `AI_BUDGET_EXCEEDED`
   * 这个错误码在 P0 就存在，但**没有这个字段就永远触发不了**（D-5）。
   */
  dailyBudgetCny: number;
  /**
   * 已确认可以把内容发往的**非本机**供应商 id（`docs/11` §2.3）。
   *
   * 为什么侧车要知道它：预览端点 `POST /ai/preview` 要回答 `needsConfirm`
   * —— 「这一次要不要弹确认卡」。这个判据必须与**真正决定路由的那份配置**
   * 待在一起（同一次 `resolve_route` 的结果），否则会出现"预览说不用确认、
   * 生成时却用了另一家"的错位。
   *
   * 同样是**全必填**（与另外八个字段一致）：漏推它会退化成空数组，
   * 表现为"已经确认过的供应商又开始弹卡"—— 是 fail-closed（多弹一次），
   * 方向正确，但仍是一次契约漂移，所以宁可让它响亮地 400。
   */
  acknowledgedEgressProviders: string[];
}

export interface AiConfigResponse {
  /** 实际生效的条目数，便于推送侧确认"推到了"（对不上就是契约漂移） */
  applied: { providers: number; credentials: number };
}

/**
 * `POST /ai/preview` 里的一块内容（`docs/11` §6.4 的「分组展示」）。
 *
 * ## 为什么把 `text` 一起回给渲染进程
 *
 * §6.4 的要求是"可展开看**真实 payload**"。只回 token 数与标题的话，
 * 那块展不开 —— 而用户要回答的问题恰恰是"我的哪一段文字要出门了"。
 *
 * 这条内容本来就要发往上游模型，回给本机渲染进程不构成任何**新增**的暴露面：
 * 它走的是同一条回环 HTTP（同一把 token），而渲染进程本来就是拼出 `prefix` 的人。
 *
 * ## `tokens` / `truncated` 与 `AiDropInfo` 同口径
 *
 * 它们是**装配之后**的值（截断已经发生），不是"本来有多少"。
 * 混用两种口径会让预览里的数字与候选卡上的对不上。
 */
export interface AiPreviewBlock {
  /** 渲染槽位：`prefix` / `settings` / `suffix` / `adjacent`。 */
  slot: string;
  title: string;
  /** `docs/01` 的记忆金字塔层级（`L3` / `L4`）或 `manual`。 */
  source: string;
  /** 这一块实际占的 token（按 `ai/tokens.py` 的口径估算）。 */
  tokens: number;
  /** 是否因为预算被截断过。 */
  truncated: boolean;
  text: string;
}

/**
 * `POST /ai/preview` 的响应 —— 「**将发送什么**」（`docs/11` §6.4 / §6.7）。
 *
 * ## 为什么不复用生成流的 `meta` 帧
 *
 * `meta` 里有 `dropped` / `budget` / `egressChars`，但 **① 它不含正文**，
 * **② 它在生成已经发起之后才到**。而这里要回答的是"**要不要发**"，
 * 只能发生在发出去之前。
 *
 * ## `needsConfirm` 由**服务端**算
 *
 * 判据是 `!local && providerId ∉ acknowledgedEgressProviders && !offlineBlocked`。
 * 放在服务端而不是渲染进程，是因为它依赖**路由解析的结果**：
 * "这个任务最终会用哪一家"只有 `resolve_route()` 知道（`routing[task]` 优先，
 * 为 null 时回落默认）。渲染进程自己判会造出第二份实现，而两份一定会漂移。
 */
export interface AiPreviewResponse {
  providerId: string;
  /** 展示用。渲染进程可能还没拉到最新供应商列表，用它比查 id 稳。 */
  providerLabel: string;
  /**
   * 这次实际要打过去的地址（`ProviderConfig.baseUrl`）。
   *
   * 刻意回**地址**而不是只回 label：`baseUrl` 是用户可以改的（自建中转、
   * 本机反代都走这一条），而"内容到底去了哪里"正是这张卡要回答的问题。
   * 两家 label 相同、地址不同的配置是可能的，那时 label 答不了。
   */
  providerBaseUrl: string;
  /** 本机模型（Ollama 等）。`true` 时界面标「本机模型·不外传」且**不弹确认卡**。 */
  local: boolean;
  model: string;
  templateId: string;
  templateVersion: number;
  /**
   * 这一次要不要弹「将发送什么」确认卡。
   *
   * 服务端已把所有条件算完（本机 / 已确认 / 被纯本地模式拦下），
   * 渲染进程**只判这一个布尔** —— 任何一个条件漏判都会变成"该弹时不弹"。
   */
  needsConfirm: boolean;
  /**
   * 这次路由会被"纯本地模式"拦下。
   *
   * 单独回给界面是为了**不要白弹一次卡**：用户确认完之后生成仍然会被拒，
   * 那时他才看到 `AI_OFFLINE_ONLY`。所以这种情形下直接放行，
   * 让真正的生成去报那句"已开启纯本地模式"。
   */
  offlineBlocked: boolean;
  /** 系统指令全文（含风格卡与本次附加约束）。 */
  system: string;
  /** 用户消息全文（模板渲染之后，即上游真正收到的那一段）。 */
  user: string;
  blocks: AiPreviewBlock[];
  /** 因预算被丢掉、**不会发出去**的块。必须回报（`docs/11` §3.5）。 */
  dropped: AiDropInfo[];
  budget: AiBudgetReport;
  /** 外发字符量，与 `AiRun.egressChars` 同口径。 */
  egressChars: number;
}
