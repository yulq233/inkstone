/**
 * AI 流式请求客户端（`docs/11` §3.2）。
 *
 * ## 为什么不复用 `api.ts` 的 `request()`
 *
 * `request()` 硬编码了 `AbortSignal.timeout(10_000)` —— 那是为"本地服务毫秒级响应"
 * 定的。AI 请求的耗时由**上游模型**决定，30~120 秒是常态，套上 10 秒必被掐断；
 * 更糟的是掐断之后报出来的是 `NETWORK`，界面上显示"无法连接本地服务"，
 * 把用户引去查一个完全没问题的东西（本地服务好好的，是模型在写）。
 *
 * 所以这里单独一条通路，超时策略只有两条：
 *
 * - **没有总超时**。生成多长由模型决定，给一个总时限等于给长文本设了一个随机截断点，
 *   而截断点落在句子里的时候，用户看到的是"模型写到一半不写了"。
 * - **只有"首个字节"超时**（{@link FIRST_BYTE_TIMEOUT_MS}）。它管的是"本地服务收下了请求
 *   却一直没开口"，与"模型正在写"是两件事，必须能分开说。
 *
 * 中断长生成的正确手段是**用户点停止**（传 `signal`），不是超时。
 *
 * ## ⚠️ 首个字节之后，任何静默都不设超时（刻意的）
 *
 * sidecar 只转发 `delta.content`，推理模型的思考过程（`reasoning_content`）**不进这条流**。
 * 于是"模型想了 90 秒才开口"与"上游连接死了"在客户端看起来一模一样 ——
 * 都是长时间没有字节。按静默去掐，被掐掉的是一段完全健康的生成；而客户端并没有
 * 比用户更可靠的信息来分辨这两者（能分辨的那一侧在 sidecar：它看得见 TCP 层）。
 *
 * ## ⚠️ 解码必须用 `TextDecoder` 的流式模式
 *
 * SSE 是字节流，一个汉字占 3 字节，可能被切在两个网络分片之间。逐片 `decode()`
 * 会把半个汉字解成替换字符（表现为乱码），**且只在流式长句上偶尔复现** ——
 * 用 `{ stream: true }` 让解码器自己攒着不完整的尾巴。
 * 契约源头在 `services/sidecar/src/inkstone/ai/service.py` 的模块头，那边写得更细。
 *
 * ## 这里只做传输，不做状态
 *
 * "候选文本攒到哪了""这一路能不能接受"属于 `features/ai/` 的状态机。
 * 保持这个文件无状态，是为了它能被测透：一个只有入参和出参的异步生成器。
 */

import { ErrorCode, isFinishReason, type AiStreamEvent } from '@inkstone/shared';

import { ApiError, NETWORK_ERROR_CODE, apiEndpoint, toApiError, type ApiConnection } from './api';

/**
 * 从发起请求到**收到第一个字节**的时限。
 *
 * ⚠️ 它与 sidecar 的 `FIRST_CHUNK_TIMEOUT`（也是 60 秒）**不是同一件事**，
 * 虽然数字一样：
 * - 这个管 `fetch()` 到首个字节，也就是"本地服务有没有开始回应"（正常应当在毫秒级，
 *   它真正兜的是 `prepare()` 卡住 —— 装配上下文要读磁盘）；
 * - 那个管**上游**的沉默，起点是 meta 帧之后。
 *
 * 两个窗口不重叠，所以两边各留 60 秒不会互相掩盖。
 */
export const FIRST_BYTE_TIMEOUT_MS = 60_000;

/**
 * 客户端侧的伪错误码：流式响应的格式不对。
 *
 * 与 `NETWORK` 一样**不出现在 HTTP 信封里** —— 它描述的是"我们收到了看不懂的东西"，
 * 而 sidecar 能发出来的信封错误码是另一族。分开是为了让排查一眼看出问题在哪一侧。
 */
export const STREAM_PROTOCOL_ERROR_CODE = 'STREAM_PROTOCOL';

/** 拼进错误文案的原始片段上限。够定位问题，又不至于把半篇正文塞进提示框。 */
const RAW_SNIPPET_LIMIT = 200;

export interface StreamAiOptions {
  connection: ApiConnection;
  /** **不带** `/api/v1` 前缀的路径，如 `'/ai/continue'`。前缀由 `apiEndpoint()` 统一拼。 */
  path: string;
  body: unknown;
  /** 用户主动停止。`abort()` 之后这个生成器抛 `AI_ABORTED`。 */
  signal?: AbortSignal;
  /** 只给测试用：把首个字节超时压到毫秒级，免得用例要等 60 秒。 */
  firstByteTimeoutMs?: number;
}

/**
 * 跑一次流式生成，逐条产出 SSE 事件。
 *
 * 失败分两种形态，**与 sidecar 的分层一一对应**（`ai/service.py` 模块头有完整理由）：
 *
 * - `prepare()` 阶段的失败（没配模型 / 超预算 / 同章已在生成）→ **抛 `ApiError`**，
 *   `code` 是 `AI_NOT_CONFIGURED` / `AI_BUDGET_EXCEEDED` / `AI_BUSY` 等，
 *   与普通请求走同一套判断；
 * - 响应体里的失败（上游 401/429/5xx、首 chunk 超时）→ **产出 `{type:'error'}` 事件**，
 *   不抛。因为此时已经有过 `delta` 了，用户手里有文本，抛异常会把它连同"这些字是真的"
 *   这个事实一起丢掉。
 */
export async function* streamAiEvents(options: StreamAiOptions): AsyncGenerator<AiStreamEvent> {
  const { connection, path, body, signal } = options;
  const firstByteTimeoutMs = options.firstByteTimeoutMs ?? FIRST_BYTE_TIMEOUT_MS;

  // 自建 controller 而不是直接把用户的 signal 交给 fetch：需要区分"谁按下了中止"。
  // 只看 `AbortError` 的名字是分不出超时与用户操作的，而这两件事对用户的说法完全不同
  // （一个是"已停止"，一个是"本地服务没响应，重试一次"）。
  const controller = new AbortController();
  let reason: 'user' | 'timeout' | null = null;
  // 单独一个标志而不是只看 `clearTimeout`：定时器已经排进队列、正要执行时，
  // `clearTimeout` 是拦不住它的。没有这个标志就存在一个极窄的窗口 ——
  // 首个字节恰好与超时同一刻到达，于是这次完全正常的生成被自己判成超时。
  let started = false;
  const onUserAbort = (): void => {
    reason ??= 'user';
    controller.abort();
  };
  if (signal !== undefined) {
    // 已经中止过的 signal 不会再触发事件，这个分支不能省：用户可能在
    // 请求发出前就点了停止。
    if (signal.aborted) onUserAbort();
    else signal.addEventListener('abort', onUserAbort);
  }
  const timer = setTimeout(() => {
    if (started) return;
    reason ??= 'timeout';
    controller.abort();
  }, firstByteTimeoutMs);

  try {
    let res: Response;
    try {
      res = await fetch(apiEndpoint(connection, path), {
        method: 'POST',
        headers: {
          'X-Inkstone-Token': connection.token,
          'Content-Type': 'application/json',
          // 显式要 SSE，而不是 `application/json`。
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      throw streamFailure(err, reason, firstByteTimeoutMs);
    }

    if (!res.ok) {
      // 这一支是"提前失败"，响应体是一个正常的 JSON 错误信封 ——
      // 解析逻辑与 `request()` 共用（`toApiError`），不抄第二份。
      clearTimeout(timer);
      throw await toApiError(res);
    }

    const bodyStream = res.body;
    if (bodyStream === null) {
      throw new ApiError(
        STREAM_PROTOCOL_ERROR_CODE,
        '本地服务返回了空响应体，无法读取生成结果。',
        res.status,
      );
    }

    const reader = bodyStream.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (err) {
        throw streamFailure(err, reason, firstByteTimeoutMs);
      }
      if (chunk.done) {
        // 用户中止时，真 fetch 有时抛 `AbortError`、有时干脆把流正常结束掉
        // （取决于中止落在"读取进行中"还是"两次读取之间"）。两种都必须让上层看到
        // "这是被停的" —— 否则它会以为生成正常结束，然后去找那个永远不来的 `done`
        // 事件，最后报一个假的"输出中断"。
        if (reason !== null) throw streamFailure(null, reason, firstByteTimeoutMs);
        break;
      }
      // 第一个字节到了，首个字节超时的使命结束。**此后不再设任何超时**（见文件头）。
      started = true;
      clearTimeout(timer);
      buffer += decoder.decode(chunk.value, { stream: true });
      const { events, rest } = parseSseBuffer(buffer);
      buffer = rest;
      // 逐帧 yield 而不是攒成数组：调用方要靠"现在多了一个字"立刻更新幽灵文本，
      // 攒起来等于把流式退化成一次性返回。
      for (const event of events) yield event;
    }
    // 尾部残留按 SSE 规范**丢弃**：一个没有以空行收尾的帧是"没发完"的帧。
    // 这不是掩盖问题 —— 丢掉的多半是 `done`，而上层正是靠"有没有收到 done"
    // 判断这次生成有没有完整结束，于是它会被如实报成"输出中断"。
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onUserAbort);
    // 提前退出（用户停止、上层抛错、调用方 `break`）时把连接放掉。
    // 不放的后果不只是内存：sidecar 那一侧的生成还在占着这个作品的并发名额，
    // 要等它自己跑完才释放 —— 用户点了停止却被告知"这一章正在生成中"。
    controller.abort();
  }
}

/**
 * 把 fetch / read 的异常收敛成 `ApiError`。
 *
 * 判定依据是**我们自己记的 `reason`**，不是异常的名字：`AbortController` 触发的中止
 * 在超时与用户操作下长得一模一样，靠 `err.name === 'AbortError'` 判会把两者弄混。
 */
function streamFailure(
  err: unknown,
  reason: 'user' | 'timeout' | null,
  firstByteTimeoutMs: number,
): ApiError {
  if (reason === 'user') {
    // 复用 `AI_ABORTED` 而不是自造一个码：sidecar 观察到连接被关时用的也是这个码，
    // 于是上层只需判一个码，不必关心这次中止是谁先发现的。
    return new ApiError(ErrorCode.AI_ABORTED, '已停止生成。', 0);
  }
  if (reason === 'timeout') {
    return new ApiError(
      NETWORK_ERROR_CODE,
      `本地服务在 ${Math.round(firstByteTimeoutMs / 1000)} 秒内没有开始响应，请重试。`,
      0,
    );
  }
  return new ApiError(
    NETWORK_ERROR_CODE,
    `无法连接本地服务：${err instanceof Error ? err.message : String(err)}`,
    0,
  );
}

export interface ParsedSse {
  events: AiStreamEvent[];
  /**
   * 还没成帧的尾巴。**必须留到下一次 `decode()` 之后再用** ——
   * 网络分片不会照顾帧边界，一个 `data:` 行被切成两半是常态而非异常。
   *
   * ⚠️ 它包含**整帧**的原文，而不只是"最后一个没换行的半行"。
   * 少了这点，一个已经收全 `data:` 行、只差空行收尾的帧就会在两次调用之间被丢掉 ——
   * 那个 bug 只在"帧被切在 `data:` 行与空行之间"时复现，而逐字节喂数据时它必然发生。
   */
  rest: string;
}

/**
 * 从累积缓冲区里取出所有**完整**的帧。
 *
 * 纯函数（无 IO、无状态），这样"帧被切在网络边界上"这件事可以逐字节地测，
 * 而不必真的去造一个会切分片的服务器。
 *
 * 支持的语法是 SSE 规范的一个子集：
 * - `data:` 累积，空行处派发（多行 `data:` 按规范用 `\n` 连接）；
 * - `:` 开头的行是注释（keep-alive），跳过；
 * - 其它字段（`id` / `event` / `retry`）忽略 —— 我们用 JSON 里的 `type` 判别事件类型，
 *   再支持一套 `event:` 命名就是同一件事有两个真源，迟早分叉；
 * - **不支持单独的 `\r` 作为换行**。副作用是我们的服务端从来不产生它
 *   （`service.py` 的 `_sse()` 写死 `\n\n`），而支持它需要跨分片回看一个字节的状态，
 *   为一条不存在的输入引入一份要长期维护的复杂度，不值。
 *
 * 实现上只记一个 `frameStart`（当前未完成帧的起点），已派发的部分不留在返回值里。
 * 未完成的帧下一次**从头重扫**：这样多行 `data` 的累积状态天然跟着原文走，
 * 不需要在这里维护一份跨调用的中间状态 —— 那种状态一旦忘了清，症状就是
 * "上一章的半句话跑到这一章的生成结果里"。
 */
export function parseSseBuffer(buffer: string): ParsedSse {
  const events: AiStreamEvent[] = [];
  let frameStart = 0;
  let offset = 0;
  let data: string[] = [];

  while (offset < buffer.length) {
    const newline = buffer.indexOf('\n', offset);
    // 最后一行还没等到换行符 → 不完整，连它带上面整个未完成的帧一起留在 rest 里
    if (newline === -1) break;

    const rawLine = buffer.slice(offset, newline);
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    offset = newline + 1;

    if (line === '') {
      if (data.length > 0) {
        const payload = data.join('\n');
        // 空 data 帧按规范是"派发一个空事件"。我们没有这种事件，直接跳过比报错合适。
        if (payload !== '') events.push(decodeAiEvent(payload));
        data = [];
      }
      frameStart = offset;
      continue;
    }
    if (line.startsWith(':')) continue;

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    // 规范：冒号后跟的**一个**空格属于分隔符，不属于值
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
  }

  return { events, rest: buffer.slice(frameStart) };
}

/**
 * 把一帧 `data:` 的载荷解成事件。
 *
 * **认不出的形状一律抛错，不跳过**：少一个 `text` 字段的 `delta` 如果被放行，
 * 上层会往候选文本里追加一个 `undefined`，用户看到的是正文里凭空多出这几个字母 ——
 * 这种"能跑但结果错了"的失败比报错难查得多。
 */
function decodeAiEvent(payload: string): AiStreamEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw protocolError(`流式响应里有一条不是合法 JSON 的帧`, payload);
  }
  if (!isAiStreamEvent(parsed)) {
    throw protocolError('流式响应里有一条不认识的事件', payload);
  }
  return parsed;
}

function protocolError(what: string, payload: string): ApiError {
  const snippet =
    payload.length > RAW_SNIPPET_LIMIT ? `${payload.slice(0, RAW_SNIPPET_LIMIT)}…` : payload;
  return new ApiError(STREAM_PROTOCOL_ERROR_CODE, `${what}：${snippet}`, 0, { payload: snippet });
}

/**
 * 运行时校验。
 *
 * 只校验**我们会读的**字段：校验得越全，越会把"sidecar 加了一个字段"变成"界面报错"。
 * （sidecar 与渲染进程是同一次安装里的两个进程，版本不会分叉 —— 所以遇到不认识的
 * `type` 报错是安全的，它只可能是真的写错了。）
 */
function isAiStreamEvent(value: unknown): value is AiStreamEvent {
  if (typeof value !== 'object' || value === null) return false;
  const event = value as Record<string, unknown>;
  switch (event.type) {
    case 'meta':
      return (
        typeof event.runId === 'string' &&
        typeof event.providerId === 'string' &&
        typeof event.model === 'string' &&
        typeof event.egressChars === 'number' &&
        Array.isArray(event.dropped)
      );
    case 'delta':
      return typeof event.text === 'string';
    case 'usage':
      return (
        typeof event.promptTokens === 'number' &&
        typeof event.completionTokens === 'number' &&
        (event.costCny === null || typeof event.costCny === 'number')
      );
    case 'done':
      // 上游的方言（`content_filter` / `end_turn` / `tool_calls` …）在 sidecar 网关里
      // 已被归一化，这里只认契约三值。原来手抄的三值判断改走 shared 的单一真源，
      // 免得两处漂移（漂移的症状见 H3：整段内容不可采纳）。
      return isFinishReason(event.finishReason);
    case 'error':
      return typeof event.code === 'string' && typeof event.message === 'string';
    default:
      return false;
  }
}
