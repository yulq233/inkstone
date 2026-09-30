/**
 * 错误码全集。sidecar（Python）返回的 code 必须与此处一一对应。
 * 详见 docs/03-M0-详细设计.md §1.2
 */
export const ErrorCode = {
  INVALID_PARAM: 'INVALID_PARAM',
  UNAUTHORIZED: 'UNAUTHORIZED',
  WORK_NOT_FOUND: 'WORK_NOT_FOUND',
  CHAPTER_NOT_FOUND: 'CHAPTER_NOT_FOUND',
  /**
   * Codex（设定条目）不存在。
   *
   * ⚠️ 不复用 `CHAPTER_NOT_FOUND`：错误码会进渲染层的分支判断，
   * "请刷新章节列表"这条文案对设定面板是错误的指引。
   */
  CODEX_NOT_FOUND: 'CODEX_NOT_FOUND',
  /** 卷纲不存在（章纲是 upsert 语义，不存在不算错误） */
  OUTLINE_NOT_FOUND: 'OUTLINE_NOT_FOUND',
  WORK_EXISTS: 'WORK_EXISTS',
  EXTERNAL_MODIFIED: 'EXTERNAL_MODIFIED',
  WRITE_FAILED: 'WRITE_FAILED',
  READ_FAILED: 'READ_FAILED',
  /**
   * 章节正文不是 UTF-8。
   *
   * 400 而非 500：这是**用户自己转一次编码就能修**的，不是服务端故障。
   * 之所以要报错而不是"尽力解码"——`errors="replace"` 会把解不出来的字节换成 U+FFFD，
   * 保存时按 UTF-8 回写就把原稿永久改坏；且 `read_chapter` 的 `hash` 算的是**原始字节**，
   * 那份替换后的文本回存时哈希对得上，冲突检测拦不住。宁可让这一章打不开。
   */
  NOT_UTF8: 'NOT_UTF8',
  INTERNAL: 'INTERNAL',

  // ---- AI（`docs/11` §4.2）----
  /** 还没选供应商 / 模型 */
  AI_NOT_CONFIGURED: 'AI_NOT_CONFIGURED',
  /** 没配 Key，或 sidecar 内存里没有（通常是推送失败） */
  AI_CREDENTIAL_MISSING: 'AI_CREDENTIAL_MISSING',
  /**
   * **上游**鉴权失败。
   *
   * ⚠️ 绝不能用 `UNAUTHORIZED` 代替：渲染进程的 `ApiError.isUnauthorized` 是判 code 的，
   * 会把"模型 Key 不对"误判成"本地服务 token 失效"，直接把整个界面推进 FAILED 界面 ——
   * 用户明明什么都没坏，却看到"本地服务连接失败"。
   */
  AI_AUTH_FAILED: 'AI_AUTH_FAILED',
  AI_RATE_LIMITED: 'AI_RATE_LIMITED',
  AI_UPSTREAM_ERROR: 'AI_UPSTREAM_ERROR',
  AI_TIMEOUT: 'AI_TIMEOUT',
  /** 用户主动停止。**不是错误**，界面上不报警 */
  AI_ABORTED: 'AI_ABORTED',
  AI_BUDGET_EXCEEDED: 'AI_BUDGET_EXCEEDED',
  /** 已开启纯本地模式，云端供应商被网关拦下 */
  AI_OFFLINE_ONLY: 'AI_OFFLINE_ONLY',
  AI_CONTEXT_TOO_LONG: 'AI_CONTEXT_TOO_LONG',
  /**
   * 同一章已经有一个生成任务在跑。
   *
   * ⚠️ **`docs/11` §4.2 的错误码表里没有它**，是写 P1 时补的（§7.3.1 的 D-6）：
   * 那张表只覆盖"上游出错"与"配置不对"，而"两路生成同时改同一章"是**本地并发**问题。
   * 复用 `INVALID_PARAM` 会让用户看到"请求参数不合法"（参数没问题，等一等就行），
   * 复用 `EXTERNAL_MODIFIED` 更错 —— 那会让界面弹出冲突解决框。
   */
  AI_BUSY: 'AI_BUSY',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** sidecar 的统一错误信封 */
export interface ApiErrorBody {
  error: {
    /**
     * 已知的码见 `ErrorCode`，但类型上**只写 `string`**。
     *
     * 写 `ErrorCode | string` 是自欺：`ErrorCode` 是字面量联合，会被 `string` 整个吸收，
     * 类型系统直接化简成 `string`（ESLint 的 `no-redundant-type-constituents` 就是报这个），
     * 既没换来收窄，又让人误以为这里做过校验。真实约束是运行时的：
     * sidecar 是另一个进程、另一个语言，可能先于前端引入新码。比对时用 `ErrorCode.X`
     * 常量即可，认不出的码按"未知错误"降级展示。
     */
    code: string;
    message: string;
    detail?: unknown;
    traceId?: string;
  };
}

export function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null) return false;
  const e = (value as Record<string, unknown>).error;
  return (
    typeof e === 'object' && e !== null && typeof (e as Record<string, unknown>).code === 'string'
  );
}
