/**
 * sidecar HTTP 客户端（03 文档 §6.7）。
 *
 * 按设计，渲染进程**直连** sidecar 的 HTTP，正文读写不走 IPC：
 * 少一层转发，DevTools 里能直接看到请求与响应；M3 的流式生成也要走 SSE，
 * 直连是天然形态。IPC 只负责系统能力（窗口、目录选择器、连接信息）。
 *
 * 三条硬规矩：
 * 1. **写操作绝不重试**。幂等性由 `baseHash` 保证，而重试反而危险 ——
 *    第一次其实写成功了、只是响应没回来，重试会拿旧 baseHash 撞 409，
 *    用户看到的是"明明保存了却报冲突"。重试决策交给上层（ConflictDialog）。
 * 2. **错误一律抛 `ApiError`**，`code` 取自信封。上层只判 `code`，不判 HTTP 状态码 ——
 *    状态码到错误码的映射只在 sidecar 的 `errors.py` 里定义一处。
 * 3. **401 说明 token 失效**（通常是 bug 或应用被外部重启），
 *    上层据此直接进 FAILED 界面，不做重试。
 */

import {
  ErrorCode,
  isApiErrorBody,
  type ChapterContent,
  type ChapterSummary,
  type CreateChapterRequest,
  type CreateWorkRequest,
  type HealthzResponse,
  type RecentWork,
  type UpdateChapterRequest,
  type WorkSummary,
  type WriteChapterResult,
} from '@inkstone/shared';

/** 普通请求超时。本地服务正常时是毫秒级，10s 说明出事了。 */
const DEFAULT_TIMEOUT_MS = 10_000;

/** 探活超时短一些：它只用来回答"还活着吗"，卡住就该早点判定失败。 */
const PROBE_TIMEOUT_MS = 4_000;

/** 网络层失败（连不上、超时）用的伪错误码。它不出现在 HTTP 信封里。 */
export const NETWORK_ERROR_CODE = 'NETWORK';

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly detail?: unknown,
    readonly traceId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** 磁盘上这个章节被外部改过 —— 需要走冲突流程 */
  get isConflict(): boolean {
    return this.code === ErrorCode.EXTERNAL_MODIFIED;
  }

  /** token 失效。上层应直接进 FAILED，而不是重试 */
  get isUnauthorized(): boolean {
    return this.code === ErrorCode.UNAUTHORIZED;
  }

  /** 压根没连上（sidecar 崩了 / 端口变了） */
  get isNetwork(): boolean {
    return this.code === NETWORK_ERROR_CODE;
  }

  /** 值得让用户点「重试」的：5xx 与网络层 */
  get isRetryable(): boolean {
    return this.isNetwork || this.status >= 500;
  }
}

export interface ApiConnection {
  baseUrl: string;
  token: string;
}

interface RequestOptions {
  timeoutMs?: number;
}

const API_PREFIX = '/api/v1';

export class ApiClient {
  constructor(private readonly conn: ApiConnection) {}

  /** 连接信息在 sidecar 重启后会变（端口变、token 不变），所以由外部每次重建客户端。 */
  get connection(): ApiConnection {
    return this.conn;
  }

  async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<T> {
    const init: RequestInit = {
      method,
      headers: {
        'X-Inkstone-Token': this.conn.token,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    };
    if (body !== undefined) init.body = JSON.stringify(body);

    let res: Response;
    try {
      res = await fetch(`${this.conn.baseUrl}${API_PREFIX}${path}`, init);
    } catch (err) {
      // 这里包含超时（AbortSignal）与 sidecar 已死。两者对用户的含义相同：
      // "本地服务没响应"，重试一次通常就好了（主进程会自动重启 sidecar）。
      throw new ApiError(
        NETWORK_ERROR_CODE,
        err instanceof Error && err.name === 'TimeoutError'
          ? '本地服务响应超时。'
          : `无法连接本地服务：${err instanceof Error ? err.message : String(err)}`,
        0,
      );
    }

    const payload = await readJson(res);

    if (!res.ok) {
      if (isApiErrorBody(payload)) {
        const { code, message, detail, traceId } = payload.error;
        throw new ApiError(code, message, res.status, detail, traceId);
      }
      // 不是我们的信封（比如框架直接返回的页面）。保留状态码，别假装看得懂。
      throw new ApiError(`HTTP_${res.status}`, `请求失败：HTTP ${res.status}`, res.status);
    }

    return payload as T;
  }

  get<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>('GET', path, undefined, options);
  }

  post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>('POST', path, body, options);
  }

  put<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>('PUT', path, body, options);
  }

  delete<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>('DELETE', path, undefined, options);
  }

  // ---- 作品 ----

  async createWork(body: CreateWorkRequest): Promise<WorkSummary> {
    const res = await this.post<{ work: WorkSummary }>('/works', body);
    return res.work;
  }

  async openWork(rootPath: string): Promise<WorkSummary> {
    const res = await this.post<{ work: WorkSummary }>('/works/open', { rootPath });
    return res.work;
  }

  async listRecent(): Promise<RecentWork[]> {
    const res = await this.get<{ items: RecentWork[] }>('/works/recent');
    return res.items;
  }

  /** 只从最近列表移除，**不碰作品目录**。目录已被移动时这是唯一能做的清理。 */
  async forgetRecent(rootPath: string): Promise<boolean> {
    const res = await this.delete<{ removed: boolean }>(
      `/works/recent?rootPath=${encodeURIComponent(rootPath)}`,
    );
    return res.removed;
  }

  // ---- 章节 ----

  async listChapters(workId: string, refresh = false): Promise<ChapterSummary[]> {
    const query = refresh ? '?refresh=true' : '';
    const res = await this.get<{ items: ChapterSummary[] }>(
      `/works/${encodeURIComponent(workId)}/chapters${query}`,
    );
    return res.items;
  }

  async createChapter(workId: string, body: CreateChapterRequest): Promise<ChapterSummary> {
    const res = await this.post<{ chapter: ChapterSummary }>(
      `/works/${encodeURIComponent(workId)}/chapters`,
      body,
    );
    return res.chapter;
  }

  async readChapter(workId: string, chapterId: string): Promise<ChapterContent> {
    const res = await this.get<{ chapter: ChapterContent }>(
      `/works/${encodeURIComponent(workId)}/chapters/${encodeURIComponent(chapterId)}`,
    );
    return res.chapter;
  }

  writeChapter(
    workId: string,
    chapterId: string,
    body: UpdateChapterRequest,
  ): Promise<WriteChapterResult> {
    return this.put<WriteChapterResult>(
      `/works/${encodeURIComponent(workId)}/chapters/${encodeURIComponent(chapterId)}`,
      body,
    );
  }
}

/** 解析 JSON；空响应体返回 undefined 而不是抛错。 */
async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * 探活。保留成独立函数是因为它要用更短的超时，而且不依赖 ApiClient 的完整能力。
 */
export async function probeHealth(connection: ApiConnection): Promise<HealthzResponse> {
  const client = new ApiClient(connection);
  return client.get<HealthzResponse>('/healthz', { timeoutMs: PROBE_TIMEOUT_MS });
}

/** 把任意异常收敛成一句能给用户看的话。 */
export function describeApiError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : String(err);
}
