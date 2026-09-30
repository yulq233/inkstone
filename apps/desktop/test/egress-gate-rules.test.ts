/**
 * 确认闸门的纯判定（`features/ai/egress-gate-rules.ts`）。
 *
 * 钩子本体是一段无法在纯 node 里驱动的异步交错（无 jsdom），但链上**会静默错**的
 * 只有两个判定点，它们在这里穷举。剩下的顺序问题（在飞何时归还、序号何时自增）
 * 归属手工验收 —— `docs/12` 的 E 组有对应条目。
 */

import { describe, expect, it } from 'vitest';
import type { AiPreviewResponse } from '@inkstone/shared';

import {
  admitEgressCheck,
  needsEgressConfirm,
} from '../src/renderer/src/features/ai/egress-gate-rules';

function preview(overrides: Partial<AiPreviewResponse> = {}): AiPreviewResponse {
  return {
    providerId: 'deepseek',
    providerLabel: 'DeepSeek',
    providerBaseUrl: 'https://api.deepseek.com/v1',
    local: false,
    model: 'deepseek-chat',
    templateId: 'continue',
    templateVersion: 3,
    needsConfirm: true,
    offlineBlocked: false,
    system: '你是……',
    user: '设定……',
    blocks: [],
    dropped: [],
    budget: { budget: 8000, used: 3200, remaining: 4800 },
    egressChars: 1500,
    ...overrides,
  };
}

describe('admitEgressCheck', () => {
  // 用一个假客户端就够：这个模块刻意不 import `ApiClient`（零运行时依赖），
  // 判定函数对 C 泛型 —— 真实调用处的 `C` 是 `ApiClient`。
  const fakeClient = { previewAi: () => Promise.resolve(null) };

  it('已经有一张卡在等 → 丢弃这次申请（否则连点会叠出第二张卡）', () => {
    expect(admitEgressCheck({ hasPending: true, inflight: false, client: fakeClient })).toEqual({
      kind: 'ignore',
    });
  });

  it('一次预览在飞 → 丢弃这次申请（否则连点会发两次预览请求）', () => {
    expect(admitEgressCheck({ hasPending: false, inflight: true, client: fakeClient })).toEqual({
      kind: 'ignore',
    });
  });

  it('守卫优先于"没有客户端"：卡片开着时不该再走一遍放行', () => {
    // 顺序反过来的话，用户在卡片上点第一次生成、又点第二次，第二次会**直接发出去** ——
    // 也就是说"等着确认"这件事被一次连点绕过了。
    expect(admitEgressCheck({ hasPending: true, inflight: false, client: null })).toEqual({
      kind: 'ignore',
    });
    expect(admitEgressCheck({ hasPending: false, inflight: true, client: null })).toEqual({
      kind: 'ignore',
    });
  });

  it('没有客户端 → 放行（调用方自己会给 NO_CLIENT 那句话）', () => {
    expect(admitEgressCheck({ hasPending: false, inflight: false, client: null })).toEqual({
      kind: 'bypass',
    });
  });

  it('一切正常 → 去问服务端，并把客户端原样带出来', () => {
    // `client` 带出来是为了免掉调用方一次非空断言：`kind: 'preview'` 蕴含它非空。
    expect(admitEgressCheck({ hasPending: false, inflight: false, client: fakeClient })).toEqual({
      kind: 'preview',
      client: fakeClient,
    });
  });
});

describe('needsEgressConfirm', () => {
  it('服务端说不用确认（本机模型 / 已确认过 / 被纯本地模式拦下）→ 不弹卡', () => {
    expect(needsEgressConfirm(preview({ needsConfirm: false }))).toBe(false);
    expect(needsEgressConfirm(preview({ local: true, needsConfirm: false }))).toBe(false);
    expect(needsEgressConfirm(preview({ offlineBlocked: true, needsConfirm: false }))).toBe(false);
  });

  it('服务端说要确认 → 弹卡', () => {
    expect(needsEgressConfirm(preview({ needsConfirm: true }))).toBe(true);
  });

  it('预览失败（null）→ 放行，**不是**弹一张空卡', () => {
    // 伪造一张"将发送 0 字"的卡会让用户在错误的认知上按「继续」，比不弹卡更糟。
    // 放行的代价被限死在"有一次生成没弹卡"：确认只在用户点「继续」时才写，
    // 所以下一次生成照样会弹。
    expect(needsEgressConfirm(null)).toBe(false);
  });
});
