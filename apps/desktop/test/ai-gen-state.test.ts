/**
 * 生成状态的纯函数（`features/ai/gen-state.ts`）。
 *
 * 重点钉三处**两边说法容易漂移**的口径：
 * 1. "用户停止"不是错误（§6.5）—— 有内容转候选、没内容回 idle；
 * 2. 上游正常返回但内容为空 → 报 `EMPTY_OUTPUT`，**不是**把空候选交给用户；
 * 3. 成本 `null` 显示"成本未知"，**不编 0**（`ai/pricing.py` 的口径）。
 */

import { describe, expect, it } from 'vitest';
import type { AiStreamEvent } from '@inkstone/shared';

import {
  IDLE_GEN_STATE,
  absorbGenEvent,
  beginGen,
  candidateMetaLine,
  costText,
  dropsText,
  durationText,
  failGen,
  genSnapshot,
  settleGen,
} from '../src/renderer/src/features/ai/gen-state';

const T0 = 1_000;

function feed(events: AiStreamEvent[], from = IDLE_GEN_STATE) {
  return events.reduce((state, event) => absorbGenEvent(state, event, T0), from);
}

const META: AiStreamEvent = {
  type: 'meta',
  runId: 'r_1',
  providerId: 'deepseek',
  model: 'deepseek-chat',
  templateId: 'continue',
  templateVersion: 1,
  dropped: [],
  budget: { budget: 4000, used: 1200, remaining: 2800 },
  egressChars: 1500,
};

describe('事件的吸收', () => {
  it('meta 落进状态，其余保持默认', () => {
    const state = feed([META], beginGen(T0));
    expect(state).toMatchObject({
      phase: 'running',
      runId: 'r_1',
      model: 'deepseek-chat',
      egressChars: 1500,
    });
  });

  it('第一个 delta 记录首字延迟，后面的 delta 不改它', () => {
    const running = beginGen(T0);
    const first = absorbGenEvent(running, { type: 'delta', text: '灯' }, T0 + 1_200);
    expect(first.firstTokenMs).toBe(1_200);

    const second = absorbGenEvent(first, { type: 'delta', text: '还亮着。' }, T0 + 3_000);
    expect(second.firstTokenMs).toBe(1_200);
    expect(second.text).toBe('灯还亮着。');
  });

  it('usage 记下 token 与成本，done 记下总耗时', () => {
    const state = feed(
      [
        META,
        { type: 'delta', text: '灯' },
        { type: 'usage', promptTokens: 1_200, completionTokens: 6, costCny: 0.0002 },
        { type: 'done', finishReason: 'stop' },
      ],
      beginGen(T0),
    );
    expect(state).toMatchObject({
      phase: 'ready',
      promptTokens: 1_200,
      completionTokens: 6,
      costCny: 0.0002,
      totalMs: 0,
      finishReason: 'stop',
    });
  });
});

describe('结束的形状', () => {
  it('正常结束且有内容 → ready（可接受）', () => {
    const state = settleGen({ ...beginGen(T0), text: '灯还亮着。' }, 'stop', T0 + 2_000);
    expect(state.phase).toBe('ready');
    expect(genSnapshot(state).acceptable).toBe(true);
  });

  it('用户停止且有内容 → 也是 ready（§6.5：不算错误）', () => {
    const state = settleGen({ ...beginGen(T0), text: '灯还' }, 'aborted', T0 + 900);
    expect(state.phase).toBe('ready');
    expect(state.finishReason).toBe('aborted');
    expect(state.failure).toBeNull();
  });

  it('用户停止且一个字都没有 → 回 idle（别责怪用户自己的按钮）', () => {
    const state = settleGen(beginGen(T0), 'aborted', T0 + 500);
    expect(state).toMatchObject(IDLE_GEN_STATE);
  });

  it('上游正常返回但内容为空 → EMPTY_OUTPUT（空格不算内容）', () => {
    const state = settleGen({ ...beginGen(T0), text: ' \n\n ' }, 'stop', T0);
    expect(state.phase).toBe('error');
    expect(state.failure?.code).toBe('EMPTY_OUTPUT');
  });

  it('流内 error 事件 → error 相，但已生成的文本还在', () => {
    const state = feed(
      [
        { type: 'delta', text: '灯还' },
        { type: 'error', code: 'AI_AUTH_FAILED', message: '密钥无效。' },
      ],
      beginGen(T0),
    );
    expect(state.phase).toBe('error');
    expect(state.failure).toEqual({ code: 'AI_AUTH_FAILED', message: '密钥无效。' });
    expect(state.text).toBe('灯还');
  });

  it('失败也记总耗时（面板要显示"等了多久才失败"）', () => {
    const state = failGen(beginGen(T0), { code: 'AI_TIMEOUT', message: '超时' }, T0 + 45_000);
    expect(state.totalMs).toBe(45_000);
  });
});

describe('快照与文案', () => {
  it('快照不含全文，只有字数', () => {
    const state = { ...beginGen(T0), text: '灯还亮着。'.repeat(50) };
    const snap = genSnapshot(state);
    expect(snap.chars).toBe('灯还亮着。'.repeat(50).length);
    expect(JSON.stringify(snap)).not.toContain('灯还亮着');
  });

  it('dropsText 分开说"超预算"与"纯本地模式"', () => {
    const budget = [{ source: 'L4', title: '设定.md', tokens: 300, reason: 'budget' as const }];
    const offline = [{ source: 'L2', title: '近章摘要', tokens: 90, reason: 'offline' as const }];
    const both = [...budget, ...offline];

    expect(dropsText([])).toBeNull();
    expect(dropsText(budget)).toBe('已省略 1 块上下文（约 300 token）');
    expect(dropsText(offline)).toContain('纯本地模式');
    expect(dropsText(both)).toContain('1 块超出预算，1 块因「纯本地模式」未发送');
  });

  it('成本文案：认不出的模型不编数，小额也显示得出', () => {
    expect(costText(null)).toBe('成本未知');
    expect(costText(0)).toBe('¥0');
    expect(costText(0.0031)).toBe('¥0.0031');
    expect(costText(1.2)).toBe('¥1.20');
  });

  it('耗时文案与候选卡那一行', () => {
    expect(durationText(null)).toBe('—');
    expect(durationText(450)).toBe('450ms');
    expect(durationText(2_340)).toBe('2.3s');

    const line = candidateMetaLine(
      genSnapshot({
        ...IDLE_GEN_STATE,
        model: 'deepseek-chat',
        firstTokenMs: 1_800,
        totalMs: 6_400,
        completionTokens: 88,
        promptTokens: 1_200,
        costCny: 0.0031,
      }),
    );
    expect(line).toBe(
      'deepseek-chat · 首字 1.8s · 共 6.4s · 输出 88 token · 上下文 1200 token · ¥0.0031',
    );
  });

  it('达到输出上限时给一句人能懂的话', () => {
    const snap = genSnapshot({ ...IDLE_GEN_STATE, text: 'x', finishReason: 'length' });
    expect(snap.finishReason).toBe('length');
  });
});
