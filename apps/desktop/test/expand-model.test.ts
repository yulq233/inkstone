/**
 * AI 扩充设定纯逻辑测试（`docs/16` D-6 / D-7）。
 *
 * 只测 `expand-model.ts` 的纯函数：标记的增删、多段顺序、`runId` 对不上时的保守行为、
 * summary/body 的分流、请求体形状。组件与钩子靠真机验收（无 jsdom）。
 *
 * 为什么要为"删错一段"写这么多条：`removeAiBodySegment` 一旦切错位置**不可逆**
 * （用户手写的草稿会跟着没），所以它的每条边界都要钉住。
 */

import { describe, expect, it } from 'vitest';

import {
  aiBodyMarker,
  appendAiBody,
  applyExpandResult,
  buildExpandRequest,
  EXPAND_TARGET_LABELS,
  listAiBodySegments,
  removeAiBodySegment,
  segmentPreview,
} from '../src/renderer/src/features/codex/expand-model';

describe('aiBodyMarker', () => {
  it('是个 HTML 注释（Markdown 渲染时不可见）', () => {
    expect(aiBodyMarker('abc123')).toBe('<!-- ai:abc123 -->');
  });

  it('产出的标记能被 listAiBodySegments 认回来（同一份语法的往返）', () => {
    const body = appendAiBody('', 'run-1', '甲');
    expect(listAiBodySegments(body).map((s) => s.runId)).toEqual(['run-1']);
  });
});

describe('appendAiBody', () => {
  it('空 body 时只留标记与正文，不留开头的空行', () => {
    expect(appendAiBody('', 'r1', '一段描述')).toBe('<!-- ai:r1 -->\n一段描述');
  });

  it('非空 body 时用空行隔开，保住已有草稿', () => {
    expect(appendAiBody('手写草稿', 'r1', 'AI 段')).toBe('手写草稿\n\n<!-- ai:r1 -->\nAI 段');
  });

  it('正文首尾空白被剥掉（模型常在前后带换行）', () => {
    expect(appendAiBody('', 'r1', '\n\n  内容  \n')).toBe('<!-- ai:r1 -->\n内容');
  });

  it('已有 body 末尾的空白先收拾掉，避免攒出三四个连续换行', () => {
    expect(appendAiBody('草稿\n\n  ', 'r1', 'AI')).toBe('草稿\n\n<!-- ai:r1 -->\nAI');
  });

  it('连续追加三次，顺序与内容都对（D-7 的核心场景）', () => {
    let body = '';
    body = appendAiBody(body, 'r1', '第一次');
    body = appendAiBody(body, 'r2', '第二次');
    body = appendAiBody(body, 'r3', '第三次');
    const segments = listAiBodySegments(body);
    expect(segments.map((s) => s.runId)).toEqual(['r1', 'r2', 'r3']);
    expect(segments.map((s) => s.text)).toEqual(['第一次', '第二次', '第三次']);
  });
});

describe('listAiBodySegments', () => {
  it('没有标记时返回空数组', () => {
    expect(listAiBodySegments('')).toEqual([]);
    expect(listAiBodySegments('纯手写，没有 AI 段落')).toEqual([]);
  });

  it('一段的正文 = 标记之后到下一个标记之前（含中间的空行被 trim）', () => {
    const body = '<!-- ai:r1 -->\nAAA\n\n<!-- ai:r2 -->\nBBB';
    expect(listAiBodySegments(body)).toEqual([
      { runId: 'r1', text: 'AAA' },
      { runId: 'r2', text: 'BBB' },
    ]);
  });

  it('标记之前的手写草稿**不算一段**（它不该有删除按钮）', () => {
    const body = '手写草稿\n\n<!-- ai:r1 -->\nAI 段';
    const segments = listAiBodySegments(body);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toEqual({ runId: 'r1', text: 'AI 段' });
  });

  it('runId 的字符集外的写法不被认成标记（手滑写坏的反引号不会吞掉正文）', () => {
    // 含空格与中文的"标记"不是我们写的，不该被当成一段
    expect(listAiBodySegments('<!-- ai:不 是:id -->\n正文')).toEqual([]);
  });

  it('标记之间空白与换行的写法都能认（`<!--ai:x-->` 无空格亦可）', () => {
    expect(listAiBodySegments('<!--ai:r1-->\nX').map((s) => s.runId)).toEqual(['r1']);
  });
});

describe('removeAiBodySegment', () => {
  const twoMarks = '<!-- ai:r1 -->\nAAA\n\n<!-- ai:r2 -->\nBBB';

  it('删第一段 → 第二段连同它的标记留下', () => {
    expect(removeAiBodySegment(twoMarks, 'r1')).toBe('<!-- ai:r2 -->\nBBB');
  });

  it('删最后一段 → 前一段留下，且不留多余空行', () => {
    expect(removeAiBodySegment(twoMarks, 'r2')).toBe('<!-- ai:r1 -->\nAAA');
  });

  it('删中间一段 → 前后两段都还在（顺序不变）', () => {
    const body = appendAiBody(appendAiBody(appendAiBody('', 'r1', 'A'), 'r2', 'B'), 'r3', 'C');
    const after = removeAiBodySegment(body, 'r2');
    expect(listAiBodySegments(after).map((s) => s.runId)).toEqual(['r1', 'r3']);
    expect(listAiBodySegments(after).map((s) => s.text)).toEqual(['A', 'C']);
  });

  it('删掉唯一一段 → 只剩手写草稿', () => {
    const body = appendAiBody('我写的设定', 'r1', 'AI 段的补充');
    expect(removeAiBodySegment(body, 'r1')).toBe('我写的设定');
  });

  it('删掉唯一一段且没有草稿 → 空串', () => {
    const body = appendAiBody('', 'r1', 'AI 段');
    expect(removeAiBodySegment(body, 'r1')).toBe('');
  });

  it('⚠️ runId 对不上时**原样返回**（不抛、不误切）', () => {
    // 这条删除动作可能晚于一次外部改动到达；切错位置不可逆，宁可这次不生效
    expect(removeAiBodySegment(twoMarks, '不存在的 id')).toBe(twoMarks);
  });

  it('对没有任何标记的 body 删一次 → 原样返回', () => {
    expect(removeAiBodySegment('纯手写', 'r1')).toBe('纯手写');
  });
});

describe('applyExpandResult', () => {
  it('target=summary → 替换 summary，body 原样（追加对"一段话"没有意义）', () => {
    const next = applyExpandResult(
      { summary: '旧梗概', body: '草稿' },
      'summary',
      '  新梗概  ',
      'r1',
    );
    expect(next).toEqual({ summary: '新梗概', body: '草稿' });
  });

  it('target=body → 追加到 body 末尾（带标记），summary 原样', () => {
    const next = applyExpandResult({ summary: '梗概', body: '草稿' }, 'body', '完整小传', 'r7');
    expect(next.summary).toBe('梗概');
    expect(next.body).toBe('草稿\n\n<!-- ai:r7 -->\n完整小传');
  });

  it('body 是空的时候追加也不留前导空行', () => {
    const next = applyExpandResult({ summary: '梗概', body: '' }, 'body', '小传', 'r7');
    expect(next.body).toBe('<!-- ai:r7 -->\n小传');
  });

  it('采纳的文本能被 list 认回来（写入与展示同源）', () => {
    const next = applyExpandResult({ summary: '', body: '' }, 'body', '小传', 'r7');
    expect(listAiBodySegments(next.body)).toEqual([{ runId: 'r7', text: '小传' }]);
  });
});

describe('buildExpandRequest', () => {
  const entry = { type: 'character', slug: 'shen-guanlan' } as const;

  it('只带 expand 需要的字段（无 chapterId / prefix，避免 extra=forbid 400）', () => {
    expect(buildExpandRequest('w1', entry, 'body', '')).toEqual({
      workId: 'w1',
      type: 'character',
      slug: 'shen-guanlan',
      target: 'body',
    });
  });

  it('intent 为空或纯空白时**不出现该键**（而不是空串）', () => {
    expect('intent' in buildExpandRequest('w1', entry, 'summary', '   ')).toBe(false);
  });

  it('intent 非空时剥掉首尾空白再带上', () => {
    expect(buildExpandRequest('w1', entry, 'summary', '  多写他早年的师门经历 ').intent).toBe(
      '多写他早年的师门经历',
    );
  });
});

describe('segmentPreview', () => {
  it('取第一行非空文字', () => {
    expect(segmentPreview('第一行\n第二行')).toBe('第一行');
    expect(segmentPreview('\n\n  内容行  \n其余')).toBe('内容行');
  });

  it('超长时截断并加省略号', () => {
    const long = 'x'.repeat(70);
    expect(segmentPreview(long, 60)).toBe(`${'x'.repeat(60)}…`);
  });

  it('空文本/纯空白 → 空串', () => {
    expect(segmentPreview('')).toBe('');
    expect(segmentPreview('\n\n')).toBe('');
  });
});

describe('EXPAND_TARGET_LABELS', () => {
  it('两个目标都有中文标签（面板标题与按钮文案共用同一份真源）', () => {
    expect(EXPAND_TARGET_LABELS.summary).toBe('梗概');
    expect(EXPAND_TARGET_LABELS.body).toBe('描述');
  });
});
