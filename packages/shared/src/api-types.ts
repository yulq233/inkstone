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
}

export interface PickDirectoryRequest {
  title?: string;
  defaultPath?: string;
}

export interface PickDirectoryResult {
  canceled: boolean;
  path?: string;
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
