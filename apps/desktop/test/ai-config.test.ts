/**
 * 推给 sidecar 的 AI 配置（`docs/11` §3.3 / §4.2）。
 *
 * 这里能直接测，是因为 `ai-config.ts` 刻意不 import electron：
 * 它只做"组装 body → 发 PUT → 收结果"。凭据真源在主进程、明文 Key 只走回环
 * 这两条约束，正好可以用"看发出去的那个 body"来钉住。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AI_SETTINGS, DEFAULT_SETTINGS, PROVIDER_PRESETS } from '@inkstone/shared';
import type { AiConfigRequest, Settings, SidecarConnection } from '@inkstone/shared';
import { buildAiConfigBody, postAiConfig, pushAiConfig } from '../src/main/ai-config';

const CONNECTION: SidecarConnection = {
  baseUrl: 'http://127.0.0.1:54321',
  token: 'tok-abcdefghijklmn',
};

/** 用内置预设，避免手写一份与 `PROVIDER_PRESETS` 漂移的假配置。 */
function settings(overrides: Partial<Settings['ai']> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ai: { ...DEFAULT_AI_SETTINGS, ...overrides } };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface Captured {
  url: string;
  init: RequestInit;
  /** 请求体原文。单独存一份，是为了让断言能直接 `JSON.parse`（`init.body` 的类型是 `BodyInit`）。 */
  body: string;
}

function stubFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): Captured[] {
  const captured: Captured[] = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit): Promise<Response> => {
    captured.push({ url, init, body: typeof init.body === 'string' ? init.body : '' });
    return Promise.resolve(handler(url, init));
  });
  return captured;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildAiConfigBody', () => {
  it('九个字段全部写出来（少一个会让 sidecar 整份拒绝）', () => {
    const body = buildAiConfigBody({ settings: settings(), credentials: new Map() });

    // 逐字段列举而不是 `toMatchObject`：漏写一个字段的后果是**整份配置被 400**，
    // 而它在界面上只表现为"设置没保存上"，排查方向很容易跑偏到网络去。
    // `offlineOnly` 更是隐私开关：sidecar 侧必填，漏传会被 Pydantic 判 400 而不是当成 false。
    // `acknowledgedEgressProviders` 同理（P1-b 的第 9 个字段）：漏推的后果是"已确认过的
    // 供应商又开始弹确认卡"，方向安全但仍是一次契约漂移 —— 照样要在这里被拦下。
    expect(Object.keys(body).sort()).toEqual([
      'acknowledgedEgressProviders',
      'credentials',
      'dailyBudgetCny',
      'defaultModel',
      'defaultProviderId',
      'offlineOnly',
      'providers',
      'routing',
      'styleCard',
    ]);
    expect(body.providers).toEqual([...PROVIDER_PRESETS]);
    expect(body.offlineOnly).toBe(false);
    expect(body.defaultProviderId).toBeNull();
  });

  it('把已确认外发的供应商名单推过去（docs/11 §2.3 的确认卡靠它决定弹不弹）', () => {
    const body = buildAiConfigBody({
      settings: settings({ acknowledgedEgressProviders: ['deepseek', 'moonshot'] }),
      credentials: new Map(),
    });

    // 原样带上：过滤"只留当前存在的供应商"由两侧各自做
    // （落盘那份是 `parseEgressAcks`，运行时那份是 `AiState.apply`）——
    // 在这里再造第三份规则只会让它与那两处漂移。
    expect(body.acknowledgedEgressProviders).toEqual(['deepseek', 'moonshot']);
  });

  it('把默认模型 / 风格卡 / 日预算也推过去（P1 补的三项，见 docs/11 §7.3.1 的 D-5）', () => {
    const body = buildAiConfigBody({
      settings: settings({
        defaultProviderId: 'deepseek',
        defaultModel: 'deepseek-chat',
        styleCard: '短句为主，少用形容词。',
        dailyBudgetCny: 8,
      }),
      credentials: new Map(),
    });

    // 三个值任一漏推的症状都是**静默失效**：生成报未配置 / 风格卡不生效 / 预算永不拦截
    expect(body.defaultModel).toBe('deepseek-chat');
    expect(body.styleCard).toBe('短句为主，少用形容词。');
    expect(body.dailyBudgetCny).toBe(8);
  });

  it('带上纯本地模式与分模型（改完要立刻让 sidecar 知道）', () => {
    const body = buildAiConfigBody({
      settings: settings({
        offlineOnly: true,
        defaultProviderId: 'ollama',
        routing: {
          ...DEFAULT_AI_SETTINGS.routing,
          continue: { providerId: 'ollama', model: 'qwen3:8b' },
        },
      }),
      credentials: new Map(),
    });

    expect(body.offlineOnly).toBe(true);
    expect(body.defaultProviderId).toBe('ollama');
    expect(body.routing.continue).toEqual({ providerId: 'ollama', model: 'qwen3:8b' });
  });

  it('只发当前存在的供应商的密钥', () => {
    const body = buildAiConfigBody({
      settings: settings({ providers: [PROVIDER_PRESETS[0]] }),
      credentials: new Map([
        ['deepseek', 'sk-kept'],
        ['deleted-provider', 'sk-should-not-travel'],
      ]),
    });

    // 已删供应商的 Key 留在磁盘上是为了"删错了能恢复"，但没必要再让它上一次网络
    expect(body.credentials).toEqual({ deepseek: 'sk-kept' });
    expect(JSON.stringify(body)).not.toContain('sk-should-not-travel');
  });

  it('空串密钥不发（半填状态不该占一个条目）', () => {
    const body = buildAiConfigBody({
      settings: settings({ providers: [PROVIDER_PRESETS[0]] }),
      credentials: new Map([['deepseek', '']]),
    });
    expect(body.credentials).toEqual({});
  });

  it('不改动传入的 settings（推送是只读的）', () => {
    const source = settings();
    const snapshot = JSON.stringify(source);
    buildAiConfigBody({ settings: source, credentials: new Map([['deepseek', 'sk-x']]) });
    expect(JSON.stringify(source)).toBe(snapshot);
  });
});

describe('postAiConfig', () => {
  it('用 PUT 打 /api/v1/ai/config，并带上本地 token', async () => {
    const captured = stubFetch(() =>
      jsonResponse(200, { applied: { providers: 6, credentials: 1 } }),
    );
    const body = buildAiConfigBody({ settings: settings(), credentials: new Map() });

    await postAiConfig(CONNECTION, body);

    expect(captured[0]?.url).toBe('http://127.0.0.1:54321/api/v1/ai/config');
    expect(captured[0]?.init.method).toBe('PUT');
    const headers = captured[0]?.init.headers as Record<string, string>;
    expect(headers['X-Inkstone-Token']).toBe(CONNECTION.token);
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('成功时回应用到的条目数（推送侧据此确认"推到了"）', async () => {
    stubFetch(() => jsonResponse(200, { applied: { providers: 6, credentials: 2 } }));

    const outcome = await postAiConfig(
      CONNECTION,
      buildAiConfigBody({ settings: settings(), credentials: new Map() }),
    );

    expect(outcome).toEqual({ ok: true, providers: 6, credentials: 2 });
  });

  it('把 sidecar 的错误信封翻成一句可读的话', async () => {
    stubFetch(() =>
      jsonResponse(400, { error: { code: 'INVALID_PARAM', message: '请求参数不合法。' } }),
    );

    const outcome = await postAiConfig(
      CONNECTION,
      buildAiConfigBody({ settings: settings(), credentials: new Map() }),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain('INVALID_PARAM');
    expect(outcome.reason).toContain('请求参数不合法');
  });

  it('非 JSON 的错误页只用状态码说话', async () => {
    stubFetch(() => new Response('<html>502 Bad Gateway</html>', { status: 502 }));

    const outcome = await postAiConfig(
      CONNECTION,
      buildAiConfigBody({ settings: settings(), credentials: new Map() }),
    );

    expect(outcome).toEqual({ ok: false, reason: 'HTTP 502' });
  });

  it('连不上时返回失败而不是抛异常（调用方有两处是旁路，没人接异常）', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('ECONNREFUSED')));

    const outcome = await postAiConfig(
      CONNECTION,
      buildAiConfigBody({ settings: settings(), credentials: new Map() }),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain('请求失败');
  });

  it('**出口脱敏**：上游把 Key 带回来时，失败信息里也不能出现它', async () => {
    const secret = 'sk-leakedfromupstream9876';
    const captured = stubFetch(() =>
      jsonResponse(400, {
        error: { code: 'INVALID_PARAM', message: `bad request apiKey=${secret}` },
      }),
    );
    const outcome = await postAiConfig(
      CONNECTION,
      buildAiConfigBody({ settings: settings(), credentials: new Map() }),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // 这条信息会同时进主进程日志与界面提示
    expect(outcome.reason).not.toContain(secret);
    expect(outcome.reason).toContain('<redacted>');
    // 顺便确认这次调用真的发出去了（否则上面的断言是空转）
    expect(captured).toHaveLength(1);
  });

  it('请求体里**确实**有明文 Key（这条链路的目的就是这个）', async () => {
    const captured = stubFetch(() =>
      jsonResponse(200, { applied: { providers: 1, credentials: 1 } }),
    );
    const body = buildAiConfigBody({
      settings: settings({ providers: [PROVIDER_PRESETS[0]] }),
      credentials: new Map([['deepseek', 'sk-reallysent']]),
    });

    await postAiConfig(CONNECTION, body);

    const sent = JSON.parse(captured[0]?.body ?? '') as AiConfigRequest;
    expect(sent.credentials.deepseek).toBe('sk-reallysent');
  });
});

describe('pushAiConfig', () => {
  it('sidecar 还没就绪时直接返回失败，不排队', async () => {
    const captured = stubFetch(() =>
      jsonResponse(200, { applied: { providers: 0, credentials: 0 } }),
    );

    const outcome = await pushAiConfig(
      { getConnection: () => null },
      { settings: settings(), credentials: new Map() },
    );

    // 不排队的理由：就绪那一刻 onStatus(HEALTHY) 会再推一次，
    // 排队反而会出现"两次推送、后一次带着旧设置"
    expect(outcome).toEqual({ ok: false, reason: '本地服务还没就绪' });
    expect(captured).toEqual([]);
  });

  it('就绪时用当前连接推一次', async () => {
    const captured = stubFetch(() =>
      jsonResponse(200, { applied: { providers: 6, credentials: 1 } }),
    );

    const outcome = await pushAiConfig(
      { getConnection: () => CONNECTION },
      { settings: settings(), credentials: new Map([['deepseek', 'sk-x123456']]) },
    );

    expect(outcome).toEqual({ ok: true, providers: 6, credentials: 1 });
    expect(captured).toHaveLength(1);
  });
});
