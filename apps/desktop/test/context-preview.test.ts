/**
 * 「将发送什么」的纯逻辑（`features/ai/context-preview.ts`）。
 *
 * 这里护的是一件有分量的事：**确认卡上那句话**。
 * "这次会把 4820 个字符发给 DeepSeek（api.deepseek.com）" 说错了，
 * 用户就是在一次错误的认知上按了「继续」——所以每个分支都要有断言钉住。
 *
 * 分块顺序那条尤其值得测：服务端返回的是**丢块优先级**，界面要的是**阅读顺序**，
 * 两者刻意不同；一旦有人把 `orderPreviewBlocks` 换成裸 `sort`，
 * 未知槽位之间的相对顺序就没了，而那是将来加新来源时唯一的线索。
 */

import { describe, expect, it } from 'vitest';
import type { AiPreviewBlock, AiPreviewResponse } from '@inkstone/shared';

import {
  dropReasonText,
  hostOf,
  orderPreviewBlocks,
  previewStats,
  previewSummary,
  slotLabel,
} from '../src/renderer/src/features/ai/context-preview';

function block(overrides: Partial<AiPreviewBlock> = {}): AiPreviewBlock {
  return {
    slot: 'prefix',
    title: '本章前文',
    source: 'L4',
    tokens: 120,
    truncated: false,
    text: '正文……',
    ...overrides,
  };
}

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

describe('orderPreviewBlocks', () => {
  it('按阅读顺序重排（设定 → 前文 → 光标之后 → 相邻章节）', () => {
    const blocks = [
      block({ slot: 'adjacent', title: '相邻章节片段' }),
      block({ slot: 'prefix', title: '本章前文' }),
      block({ slot: 'settings', title: '作品设定' }),
      block({ slot: 'suffix', title: '光标之后' }),
    ];
    expect(orderPreviewBlocks(blocks).map((item) => item.slot)).toEqual([
      'settings',
      'prefix',
      'suffix',
      'adjacent',
    ]);
  });

  it('已经是目标顺序时保持不动（稳定）', () => {
    const blocks = [
      block({ slot: 'settings' }),
      block({ slot: 'prefix' }),
      block({ slot: 'suffix' }),
    ];
    expect(orderPreviewBlocks(blocks).map((item) => item.slot)).toEqual([
      'settings',
      'prefix',
      'suffix',
    ]);
  });

  it('认不出的槽位排在末尾，且相互之间保持服务端给的相对顺序', () => {
    // 裸 sort 会把这四个的顺序打乱（比较函数返回 0 时各引擎行为不同），
    // 而"装配器加了新来源"正是要靠这个顺序才看得出来。
    const blocks = [
      block({ slot: 'zeta', title: '未知 A' }),
      block({ slot: 'prefix' }),
      block({ slot: 'alpha', title: '未知 B' }),
      block({ slot: 'settings' }),
    ];
    expect(orderPreviewBlocks(blocks).map((item) => item.slot)).toEqual([
      'settings',
      'prefix',
      'zeta',
      'alpha',
    ]);
  });

  it('不改动传入的数组', () => {
    const blocks = [block({ slot: 'adjacent' }), block({ slot: 'settings' })];
    const before = blocks.map((item) => item.slot);
    orderPreviewBlocks(blocks);
    expect(blocks.map((item) => item.slot)).toEqual(before);
  });

  it('空数组进空数组出', () => {
    expect(orderPreviewBlocks([])).toEqual([]);
  });
});

describe('slotLabel', () => {
  it('已知槽位用界面文案，不用服务端的机器名', () => {
    expect(slotLabel('prefix', '本章前文')).toBe('本章前文');
    expect(slotLabel('adjacent', 'x')).toBe('相邻章节片段');
  });

  it('认不出的槽位回落到服务端给的标题（而不是隐藏整行）', () => {
    expect(slotLabel('some-new-source', '某新来源')).toBe('某新来源');
  });
});

describe('hostOf', () => {
  it('切掉协议与路径', () => {
    expect(hostOf('https://api.deepseek.com/v1')).toBe('api.deepseek.com');
  });

  it('保留端口（自建端点常带端口，丢了就答不了"去了哪"）', () => {
    expect(hostOf('http://127.0.0.1:11434/v1')).toBe('127.0.0.1:11434');
  });

  it('切掉查询串与片段', () => {
    expect(hostOf('https://example.com/v1?key=1#frag')).toBe('example.com');
  });

  it('协议大小写不敏感', () => {
    expect(hostOf('HTTPS://Example.COM/v1')).toBe('Example.COM');
  });

  it('没有协议时原样返回（宁显示用户填的怪字符串，也不显示猜的主机名）', () => {
    expect(hostOf('  api.deepseek.com/v1  ')).toBe('api.deepseek.com/v1');
  });

  it('空串进空串出', () => {
    expect(hostOf('')).toBe('');
  });
});

describe('previewSummary', () => {
  it('云端：说清字符数、去哪家、打哪个地址、用哪个模型', () => {
    const text = previewSummary(preview({ egressChars: 4820, model: 'deepseek-chat' }));
    expect(text).toContain('4820');
    expect(text).toContain('DeepSeek');
    expect(text).toContain('api.deepseek.com');
    expect(text).toContain('deepseek-chat');
  });

  it('本机模型：说"不外传"，不说"将发送"', () => {
    const text = previewSummary(
      preview({
        local: true,
        providerLabel: 'Ollama',
        providerBaseUrl: 'http://127.0.0.1:11434/v1',
        needsConfirm: false,
      }),
    );
    expect(text).toContain('本机模型');
    expect(text).toContain('不外传');
    expect(text).toContain('127.0.0.1:11434');
    expect(text).not.toContain('个字符');
  });

  it('被纯本地模式拦下：说"不会真的发送"，不说"将发送"', () => {
    const text = previewSummary(preview({ offlineBlocked: true, needsConfirm: false }));
    expect(text).toContain('不会真的发送');
    expect(text).toContain('纯本地模式');
    expect(text).not.toContain('个字符');
  });

  it('本机 + 纯本地模式：本机优先（它是更具体的那句）', () => {
    const text = previewSummary(preview({ local: true, offlineBlocked: true }));
    expect(text).toContain('不外传');
  });
});

describe('previewStats', () => {
  it('统计外发字符、token、截断块与被丢弃块', () => {
    const stats = previewStats(
      preview({
        egressChars: 4820,
        blocks: [
          block({ truncated: true }),
          block({ truncated: false }),
          block({ slot: 'suffix', truncated: true }),
        ],
        dropped: [
          { source: 'L4', title: '相邻章节', tokens: 900, reason: 'budget' },
          { source: 'manual', title: '批注', tokens: 40, reason: 'offline' },
        ],
        budget: { budget: 8000, used: 7100, remaining: 900 },
      }),
    );
    expect(stats).toEqual({
      egressChars: 4820,
      usedTokens: 7100,
      budgetTokens: 8000,
      truncatedBlocks: 2,
      droppedBlocks: 2,
    });
  });

  it('没有块时截断计数为 0（而不是 undefined）', () => {
    expect(previewStats(preview()).truncatedBlocks).toBe(0);
    expect(previewStats(preview()).droppedBlocks).toBe(0);
  });
});

describe('dropReasonText', () => {
  it('两种已知原因各有一句人话', () => {
    expect(dropReasonText('budget')).toBe('超出上下文预算');
    expect(dropReasonText('offline')).toBe('纯本地模式');
  });

  it('认不出的原因照原样显示（藏着它会没人发现装配器多了新原因）', () => {
    expect(dropReasonText('something-new')).toBe('something-new');
  });
});
