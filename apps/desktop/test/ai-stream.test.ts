/**
 * AI 流式客户端（`lib/ai-stream.ts`）。
 *
 * 这组用例的重心是三件容易"看起来对、其实错"的事：
 *
 * 1. **分片切在汉字中间**。逐字节喂一遍是最狠的版本 —— 一个汉字 3 字节，
 *    逐字节喂必然有一次切在字里。不用 `TextDecoder({stream:true})` 就会出替换字符。
 * 2. **首个字节之后不能再有超时**。一个推理模型可以静默很久才吐第一个字，
 *    也可以吐了第一个字之后又想很久。后者被"静默超时"掐掉时，用户看到的是
 *    "写到一半不写了"，而我们会报一个网络错误。
 * 3. **HTTP 错误与 SSE 错误是两种形态**。前者是"提前失败"（`prepare()` 阶段），
 *    后者是"流已经开始了才失败" —— 混成一种，界面就没法决定要不要保留已生成的文本。
 *
 * 还钉住一条容易被悄悄改掉的细节：URL 必须带 `/api/v1` 前缀。
 * 漏掉它的症状是 404，而 404 的文案会说"作品不存在"，排查要绕一大圈。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ErrorCode, type AiStreamEvent } from '@inkstone/shared';

import { ApiError, NETWORK_ERROR_CODE, type ApiConnection } from '../src/renderer/src/lib/api';
import {
  FIRST_BYTE_TIMEOUT_MS,
  STREAM_PROTOCOL_ERROR_CODE,
  parseSseBuffer,
  streamAiEvents,
} from '../src/renderer/src/lib/ai-stream';

const CONNECTION: ApiConnection = { baseUrl: 'http://127.0.0.1:51234', token: 't-test' };

const META = {
  type: 'meta',
  runId: 'r_1',
  providerId: 'deepseek',
  model: 'deepseek-chat',
  templateId: 'continue',
  templateVersion: 1,
  dropped: [{ source: 'L4', title: '设定.md', tokens: 300, reason: 'budget' }],
  budget: { budget: 4000, used: 1200, remaining: 2800 },
  egressChars: 1500,
} as const;

function frame(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

const encoder = new TextEncoder();

function encode(text: string): Uint8Array {
  return encoder.encode(text);
}

/** 一步：立刻给一片字节，或先等一会儿再继续（用来测"静默"）。 */
type Step = Uint8Array | { sleep: number };

interface FakeFetch {
  /** 按顺序给出的步骤。`hold` 为真时，走完步骤也**不关闭**流。 */
  steps?: Step[];
  status?: number;
  contentType?: string;
  body?: string;
  hold?: boolean;
}

/**
 * 换掉全局 `fetch`。
 *
 * 假的 `fetch` **必须**把响应体与 `signal` 绑起来（真 fetch 就是这么做的）：
 * 中止时让流报错，`reader.read()` 才会 reject。不绑的话"用户点停止"的用例
 * 会永远挂在 `read()` 上 —— 那不是测试写法问题，是把产品行为测漏了。
 */
function installFetch(options: FakeFetch): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const signal = init?.signal ?? null;

    if (options.body !== undefined) {
      return new Response(options.body, {
        status: options.status ?? 200,
        headers: { 'content-type': options.contentType ?? 'application/json' },
      });
    }

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener('abort', () => {
          try {
            controller.error(new DOMException('The operation was aborted.', 'AbortError'));
          } catch {
            // 流已经关了 —— 中止只是没赶上，不是问题
          }
        });

        const steps = options.steps ?? [];
        const run = (index: number): void => {
          if (index >= steps.length) {
            if (options.hold !== true) {
              try {
                controller.close();
              } catch {
                /* 已被中止打断 */
              }
            }
            return;
          }
          const step = steps[index];
          if (step instanceof Uint8Array) {
            try {
              controller.enqueue(step);
            } catch {
              // 中止之后就不再喂了
              return;
            }
            run(index + 1);
            return;
          }
          setTimeout(() => run(index + 1), step.sleep);
        };
        run(0);
      },
    });

    return new Response(stream, {
      status: options.status ?? 200,
      headers: { 'content-type': options.contentType ?? 'text/event-stream; charset=utf-8' },
    });
  });

  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** 走完一整条流，收集事件。抛错就抛出去（用例自带 `rejects` / try-catch）。 */
async function collect(
  overrides: Partial<Parameters<typeof streamAiEvents>[0]> = {},
): Promise<AiStreamEvent[]> {
  const events: AiStreamEvent[] = [];
  for await (const event of streamAiEvents({
    connection: CONNECTION,
    path: '/ai/continue',
    body: { workId: 'w_1', chapterId: 'c_1', prefix: '灯还' },
    ...overrides,
  })) {
    events.push(event);
  }
  return events;
}

function deltaText(events: readonly AiStreamEvent[]): string {
  let text = '';
  for (const event of events) if (event.type === 'delta') text += event.text;
  return text;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseSseBuffer', () => {
  it('没收到空行之前，这一帧的原文原样留在 rest 里', () => {
    const one = 'data: {"type":"delta","text":"灯"}\n';
    const first = parseSseBuffer(one);
    expect(first.events).toEqual([]);
    // 留的是整帧原文，不是"最后一个半行" —— 逐字节喂数据时，
    // 只留半行的实现会把这个帧连同已经收全的 data 行一起丢掉
    expect(first.rest).toBe(one);

    const second = parseSseBuffer(`${first.rest}\n`);
    expect(second.events).toEqual([{ type: 'delta', text: '灯' }]);
    expect(second.rest).toBe('');
  });

  it('已派发的帧不再留在 rest 里，未完成的帧接着留', () => {
    const { events, rest } = parseSseBuffer(
      'data: {"type":"done","finishReason":"stop"}\n\ndata: {"type":"del',
    );
    expect(events).toEqual([{ type: 'done', finishReason: 'stop' }]);
    expect(rest).toBe('data: {"type":"del');
  });

  it('不完整的帧留在 rest 里，不解析也不丢弃', () => {
    const { events, rest } = parseSseBuffer('data: {"type":"del');
    expect(events).toEqual([]);
    expect(rest).toBe('data: {"type":"del');
  });

  it('注释行（keep-alive）不是事件，也不影响后面的帧', () => {
    const { events } = parseSseBuffer(
      ': keep-alive\n\ndata: {"type":"done","finishReason":"stop"}\n\n',
    );
    expect(events).toEqual([{ type: 'done', finishReason: 'stop' }]);
  });

  it('多行 data 按规范用换行连接', () => {
    const { events } = parseSseBuffer('data: {"type":"delta",\ndata: "text":"灯"}\n\n');
    expect(events).toEqual([{ type: 'delta', text: '灯' }]);
  });

  it('吃掉冒号后的一个空格，这是分隔符不是值', () => {
    const { events } = parseSseBuffer('data:{"type":"done","finishReason":"length"}\n\n');
    expect(events).toEqual([{ type: 'done', finishReason: 'length' }]);
  });

  it('\\r\\n 行尾同样可用', () => {
    const { events, rest } = parseSseBuffer('data: {"type":"done","finishReason":"stop"}\r\n\r\n');
    expect(events).toEqual([{ type: 'done', finishReason: 'stop' }]);
    expect(rest).toBe('');
  });

  it('认不出的形状直接报错，不静默跳过', () => {
    // 少了 text 的 delta 如果被放行，上层会往候选文本里塞进一个 undefined
    expect(() => parseSseBuffer('data: {"type":"delta"}\n\n')).toThrowError(/不认识的事件/);
  });

  it('不是 JSON 的帧也报错', () => {
    expect(() => parseSseBuffer('data: {啊这}\n\n')).toThrowError(/不是合法 JSON/);
  });
});

describe('streamAiEvents', () => {
  const HAPPY = [
    frame(META),
    frame({ type: 'delta', text: '灯还' }),
    frame({ type: 'delta', text: '亮着。' }),
    frame({ type: 'usage', promptTokens: 1200, completionTokens: 6, costCny: 0.0002 }),
    frame({ type: 'done', finishReason: 'stop' }),
  ].join('');

  it('一路正常：事件按顺序产出，类型与载荷都对', async () => {
    installFetch({ steps: [encode(HAPPY)] });

    const events = await collect();

    expect(events.map((event) => event.type)).toEqual(['meta', 'delta', 'delta', 'usage', 'done']);
    expect(deltaText(events)).toBe('灯还亮着。');
    expect(events[0]).toMatchObject({ runId: 'r_1', model: 'deepseek-chat', egressChars: 1500 });
    expect(events[3]).toMatchObject({ promptTokens: 1200, costCny: 0.0002 });
  });

  it('请求带 /api/v1 前缀与鉴权头', async () => {
    const fetchMock = installFetch({ steps: [encode(HAPPY)] });

    await collect();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:51234/api/v1/ai/continue');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      'X-Inkstone-Token': 't-test',
      Accept: 'text/event-stream',
    });
  });

  it('一个汉字被切成两半时不乱码（逐字节喂一遍）', async () => {
    const bytes = encode(HAPPY);
    // 逐字节给，必然有一次切在汉字的三个字节中间
    installFetch({ steps: Array.from(bytes, (byte) => Uint8Array.of(byte)) });

    const events = await collect();

    expect(deltaText(events)).toBe('灯还亮着。');
    // 帧本身没被复制或漏掉
    expect(events).toHaveLength(5);
  });

  it('分片正好切在汉字的三个字节中间', async () => {
    const bytes = encode(frame({ type: 'delta', text: '砚' }));
    // 定位「砚」的第一个字节：它前面的前缀全是 ASCII，所以字符数 == 字节数
    const head = encode('data: {"type":"delta","text":"').length;
    expect(bytes[head]).toBeGreaterThan(0x7f); // 确实是多字节字符的第一字节

    installFetch({ steps: [bytes.slice(0, head + 1), bytes.slice(head + 1)] });

    const events = await collect();

    expect(deltaText(events)).toBe('砚');
  });

  it('首个字节之后的长时间静默不掐断（没有总超时）', async () => {
    installFetch({
      steps: [
        encode(frame({ type: 'delta', text: '灯' })),
        // 远大于首字节超时。若实现把超时套在整条流上，这里会报 NETWORK
        { sleep: 80 },
        encode(frame({ type: 'delta', text: '还亮着。' })),
        encode(frame({ type: 'done', finishReason: 'stop' })),
      ],
    });

    const events = await collect({ firstByteTimeoutMs: 20 });

    expect(deltaText(events)).toBe('灯还亮着。');
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });

  it('首个字节超时时报 NETWORK（本地服务没开口，不是用户停止）', async () => {
    installFetch({ steps: [], hold: true });

    const failure = await collect({ firstByteTimeoutMs: 20 }).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe(NETWORK_ERROR_CODE);
    expect((failure as ApiError).isRetryable).toBe(true);
    expect(FIRST_BYTE_TIMEOUT_MS).toBe(60_000);
  });

  it('prepare() 阶段的失败是 HTTP 信封错误（走 ApiError，不是 SSE 事件）', async () => {
    installFetch({
      steps: [],
      status: 409,
      body: JSON.stringify({
        error: { code: ErrorCode.AI_BUSY, message: '这一章已经有一个生成任务在进行。' },
      }),
    });

    const failure = await collect().catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe(ErrorCode.AI_BUSY);
    expect((failure as ApiError).status).toBe(409);
    // 409 不是"重试就会好"，界面该提示等待而不是给重试按钮
    expect((failure as ApiError).isRetryable).toBe(false);
  });

  it('流已经开始之后的失败是 error 事件，不抛异常', async () => {
    installFetch({
      steps: [
        encode(frame({ type: 'delta', text: '灯还' })),
        encode(frame({ type: 'error', code: ErrorCode.AI_AUTH_FAILED, message: '密钥无效。' })),
      ],
    });

    const events = await collect();

    // 已生成的文本必须还在 —— 抛异常会让调用方连"这些字是真的"一起丢掉
    expect(deltaText(events)).toBe('灯还');
    expect(events.at(-1)).toMatchObject({ type: 'error', code: ErrorCode.AI_AUTH_FAILED });
  });

  it('用户中止 → AI_ABORTED，已收到的文本仍可读', async () => {
    installFetch({
      steps: [encode(frame({ type: 'delta', text: '灯还' })), encode(HAPPY)],
    });

    const abort = new AbortController();
    const events: AiStreamEvent[] = [];
    let failure: unknown = null;
    try {
      for await (const event of streamAiEvents({
        connection: CONNECTION,
        path: '/ai/continue',
        body: {},
        signal: abort.signal,
      })) {
        events.push(event);
        if (event.type === 'delta') abort.abort();
      }
    } catch (err) {
      failure = err;
    }

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe(ErrorCode.AI_ABORTED);
    expect(deltaText(events)).toBe('灯还');
  });

  it('请求还没发出就中止，同样是 AI_ABORTED', async () => {
    installFetch({ steps: [encode(HAPPY)] });

    const abort = new AbortController();
    abort.abort();

    const failure = await collect({ signal: abort.signal }).catch((err: unknown) => err);

    expect((failure as ApiError).code).toBe(ErrorCode.AI_ABORTED);
  });

  it('没有响应体是协议错误，不是"生成完成但内容为空"', async () => {
    // `new Response(null)` 的 body 就是 null —— 200 但没内容，
    // 不拦的话调用方会当成"模型什么都没写"
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200 })),
    );

    const failure = await collect().catch((err: unknown) => err);

    expect((failure as ApiError).code).toBe(STREAM_PROTOCOL_ERROR_CODE);
  });
});
