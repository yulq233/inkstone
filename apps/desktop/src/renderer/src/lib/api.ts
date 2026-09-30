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
  type AiModelsResponse,
  type AiPreviewRequest,
  type AiPreviewResponse,
  type AiRunsResponse,
  type AiRunFeedback,
  type AiTestResponse,
  type BrokenRelationsResponse,
  type ChapterContent,
  type ChapterOutline,
  type ChapterOutlineResponse,
  type ChapterSummary,
  type CodexEntry,
  type CodexEntryResponse,
  type CodexListResponse,
  type CodexType,
  type CreateChapterRequest,
  type CreateCodexRequest,
  type CreateWorkRequest,
  type ForeshadowInput,
  type ForeshadowListResponse,
  type GeneralOutline,
  type HealthzResponse,
  type ModelSpec,
  type RecentWork,
  type UpdateChapterRequest,
  type UpdateCodexRequest,
  type VolumeListResponse,
  type VolumeOutline,
  type VolumeOutlineResponse,
  type WorkSummary,
  type WriteChapterResult,
} from '@inkstone/shared';

/** 普通请求超时。本地服务正常时是毫秒级，10s 说明出事了。 */
const DEFAULT_TIMEOUT_MS = 10_000;

/** 探活超时短一些：它只用来回答"还活着吗"，卡住就该早点判定失败。 */
const PROBE_TIMEOUT_MS = 4_000;

/**
 * AI 请求超时。
 *
 * **必须与普通请求分开**（所以上面那条 10 秒的规则对 AI 不适用）：
 * AI 的耗时由**上游模型**决定，不是本地服务 —— 一次冷启动的云端请求
 * 加上 DNS/TLS 往返，10 秒很容易不够。而超时的表现是 `NETWORK`，
 * 界面上会显示"本地服务响应超时"，把用户引到完全错误的方向去查。
 *
 * 这个值比 sidecar 侧网关的超时（connect 8s + read 30s）留足余量：
 * 让**网关**先超时，它给的错误（`AI_TIMEOUT`，带"换一个模型"的建议）比这里的
 * `NETWORK` 有用得多。
 */
const AI_TIMEOUT_MS = 45_000;

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

/**
 * 拼完整 URL。
 *
 * 单独一个函数而不是在各处写模板串：`/api/v1` 前缀漏掉一次的症状是 404，
 * 而 404 的文案会指向"作品不存在"，排查起来要绕一大圈。多一个共用点就少一条这种路。
 */
export function apiEndpoint(connection: ApiConnection, path: string): string {
  return `${connection.baseUrl}${API_PREFIX}${path}`;
}

/**
 * 把一次失败的响应收敛成 `ApiError`。
 *
 * 抽出来给**流式请求**复用（`lib/ai-stream.ts`）：它不能用 `request()`
 * （那条路有 10 秒总超时），但"信封怎么解"必须与它逐字一致 ——
 * 各写一份的下场是"加了一个新错误码，只有一边认得"。
 */
export async function toApiError(res: Response): Promise<ApiError> {
  const payload = await readJson(res);
  if (isApiErrorBody(payload)) {
    const { code, message, detail, traceId } = payload.error;
    return new ApiError(code, message, res.status, detail, traceId);
  }
  // 不是我们的信封（比如框架直接返回的页面）。保留状态码，别假装看得懂。
  return new ApiError(`HTTP_${res.status}`, `请求失败：HTTP ${res.status}`, res.status);
}

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
      res = await fetch(apiEndpoint(this.conn, path), init);
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

    if (!res.ok) throw await toApiError(res);

    const payload = await readJson(res);
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

  // ---- AI（`docs/11` P0）----

  /**
   * 拉供应商的模型列表。
   *
   * 超时按 AI 算：这是一次真实的外发请求，服务端要等上游返回。
   */
  async listAiModels(providerId: string): Promise<ModelSpec[]> {
    const res = await this.get<AiModelsResponse>(
      `/ai/providers/${encodeURIComponent(providerId)}/models`,
      { timeoutMs: AI_TIMEOUT_MS },
    );
    return res.items;
  }

  /**
   * 「将发送什么」（`POST /ai/preview`，`docs/11` §6.4 / §6.7）。
   *
   * ⚠️ 超时按**普通请求**算，不是 `AI_TIMEOUT_MS`：这条端点只做本地装配
   * （读设定文件 + 渲染模板），**不碰上游模型**。用 45 秒会让"本地服务真出事了"
   * 这件事晚 35 秒才被说出来，而预览恰好是每次生成之前的那一步 ——
   * 卡在这里等于整个写作流卡住。
   */
  previewAi(body: AiPreviewRequest): Promise<AiPreviewResponse> {
    return this.post<AiPreviewResponse>('/ai/preview', body);
  }

  /**
   * 连接测试。服务端会**真的发一次最小对话请求**，所以它能验出"密钥对不对"，
   * 而不只是"地址通不通"。
   *
   * 失败时抛 `ApiError`，`code` 是 `AI_*` 那一族 —— 注意 `AI_AUTH_FAILED` 与
   * `UNAUTHORIZED` 是**两个码**：前者是上游拒绝了密钥，后者才是本地 token 失效。
   * 所以这里**不能**用 `err.isUnauthorized` 去判断要不要进 FAILED 界面。
   */
  testAiConnection(providerId: string, model: string): Promise<AiTestResponse> {
    return this.post<AiTestResponse>(
      '/ai/test',
      { providerId, model },
      { timeoutMs: AI_TIMEOUT_MS },
    );
  }

  /**
   * 拉生成记录 + 当日用量。
   *
   * 超时按普通请求算：这两项都是读本地文件（用量那边还有按 `mtime` 的缓存），
   * 不涉及上游模型 —— 用 `AI_TIMEOUT_MS` 只会让"sidecar 真出事了"这件事晚 35 秒才被说出来。
   */
  listAiRuns(
    workId: string,
    options: { since?: string; limit?: number } = {},
  ): Promise<AiRunsResponse> {
    const query = new URLSearchParams({ workId });
    if (options.since !== undefined && options.since !== '') query.set('since', options.since);
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    return this.get<AiRunsResponse>(`/ai/runs?${query.toString()}`);
  }

  /**
   * 回填采纳结果（accepted）。
   *
   * 失败**不该打断用户**：这只是统计，删掉候选文本这件事与它是否记上无关。
   * 所以调用方应吞掉这里的异常（记一条日志即可），不要弹提示。
   */
  sendAiFeedback(runId: string, body: AiRunFeedback): Promise<{ ok: boolean }> {
    return this.post<{ ok: boolean }>(`/ai/runs/${encodeURIComponent(runId)}/feedback`, body);
  }

  // ---- Codex（设定条目，docs/15 B1）----

  async listCodex(workId: string): Promise<CodexListResponse['items']> {
    const res = await this.get<CodexListResponse>(`/works/${encodeURIComponent(workId)}/codex`);
    return res.items;
  }

  async createCodexEntry(workId: string, body: CreateCodexRequest): Promise<CodexEntry> {
    const res = await this.post<CodexEntryResponse>(
      `/works/${encodeURIComponent(workId)}/codex`,
      body,
    );
    return res.entry;
  }

  async readCodexEntry(workId: string, entryType: CodexType, slug: string): Promise<CodexEntry> {
    const res = await this.get<CodexEntryResponse>(
      `/works/${encodeURIComponent(workId)}/codex/${encodeURIComponent(entryType)}/${encodeURIComponent(slug)}`,
    );
    return res.entry;
  }

  /** PUT 条目。`body` 不含 slug/hash（服务端派生字段，回灌会被 400）。 */
  async writeCodexEntry(
    workId: string,
    entryType: CodexType,
    slug: string,
    body: UpdateCodexRequest,
  ): Promise<CodexEntry> {
    const res = await this.put<CodexEntryResponse>(
      `/works/${encodeURIComponent(workId)}/codex/${encodeURIComponent(entryType)}/${encodeURIComponent(slug)}`,
      body,
    );
    return res.entry;
  }

  async deleteCodexEntry(workId: string, entryType: CodexType, slug: string): Promise<void> {
    await this.delete<{ ok: boolean }>(
      `/works/${encodeURIComponent(workId)}/codex/${encodeURIComponent(entryType)}/${encodeURIComponent(slug)}`,
    );
  }

  async listBrokenRelations(workId: string): Promise<BrokenRelationsResponse['items']> {
    const res = await this.get<BrokenRelationsResponse>(
      `/works/${encodeURIComponent(workId)}/codex/broken-relations`,
    );
    return res.items;
  }

  // ---- 大纲（docs/15 B2）----

  async readGeneralOutline(workId: string): Promise<GeneralOutline> {
    return this.get<GeneralOutline>(`/works/${encodeURIComponent(workId)}/outline/general`);
  }

  async writeGeneralOutline(
    workId: string,
    body: string,
    ifMatch: string,
  ): Promise<{ hash: string }> {
    return this.put<{ hash: string }>(`/works/${encodeURIComponent(workId)}/outline/general`, {
      body,
      ifMatch,
    });
  }

  async listVolumes(workId: string): Promise<VolumeListResponse['items']> {
    const res = await this.get<VolumeListResponse>(
      `/works/${encodeURIComponent(workId)}/outline/volumes`,
    );
    return res.items;
  }

  async readVolume(workId: string, order: number): Promise<VolumeOutline> {
    const res = await this.get<VolumeOutlineResponse>(
      `/works/${encodeURIComponent(workId)}/outline/volumes/${order}`,
    );
    return res.volume;
  }

  async createVolume(workId: string, title: string, body: string): Promise<VolumeOutline> {
    const res = await this.post<VolumeOutlineResponse>(
      `/works/${encodeURIComponent(workId)}/outline/volumes`,
      { title, body },
    );
    return res.volume;
  }

  async writeVolume(
    workId: string,
    order: number,
    body: { title: string; body: string; order?: number | null; ifMatch: string },
  ): Promise<VolumeOutline> {
    const res = await this.put<VolumeOutlineResponse>(
      `/works/${encodeURIComponent(workId)}/outline/volumes/${order}`,
      body,
    );
    return res.volume;
  }

  async deleteVolume(workId: string, order: number): Promise<void> {
    await this.delete<{ ok: boolean }>(
      `/works/${encodeURIComponent(workId)}/outline/volumes/${order}`,
    );
  }

  async reorderVolume(workId: string, order: number, direction: 'up' | 'down'): Promise<void> {
    await this.post<{ ok: boolean }>(
      `/works/${encodeURIComponent(workId)}/outline/volumes/${order}/reorder`,
      { direction },
    );
  }

  async readChapterOutline(workId: string, chapterId: string): Promise<ChapterOutline> {
    const res = await this.get<ChapterOutlineResponse>(
      `/works/${encodeURIComponent(workId)}/outline/chapters/${encodeURIComponent(chapterId)}`,
    );
    return res.outline;
  }

  async writeChapterOutline(
    workId: string,
    chapterId: string,
    body: { body: string; foreshadow: ForeshadowInput[] | null; ifMatch: string },
  ): Promise<ChapterOutline> {
    const res = await this.put<ChapterOutlineResponse>(
      `/works/${encodeURIComponent(workId)}/outline/chapters/${encodeURIComponent(chapterId)}`,
      body,
    );
    return res.outline;
  }

  async listForeshadows(workId: string): Promise<ForeshadowListResponse['items']> {
    const res = await this.get<ForeshadowListResponse>(
      `/works/${encodeURIComponent(workId)}/foreshadows`,
    );
    return res.items;
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
