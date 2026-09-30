/**
 * 侧栏列表纯操作的单测（`07` 文档 §4、§8）。
 *
 * 这里的每条断言都对应一个**用户能看见**的症状：
 * - `sortChapters` 错了 → 侧栏乱序，看起来像"章节丢了"；
 * - `patchChapterWordCount` 按 `order` 而不是 `id` 匹配 → 重排后改错项，
 *   用户看到"我改的是第 3 章，字数却变在第 5 章"；
 * - `patchChapterWordCount` 原地改数组 → React 看不到变化，保存完字数不动；
 * - `chapterLabel` 漏掉占位标题 → 显示成「第 3 章 · 第 3 章」。
 */

import { describe, expect, it } from 'vitest';
import type { ChapterSummary, ChapterStatus } from '@inkstone/shared';

import {
  chapterLabel,
  defaultChapterTitle,
  describeChapterStatus,
  firstChapter,
  formatWordCount,
  patchChapterWordCount,
  sortChapters,
  TITLE_FALLBACK,
} from '../src/renderer/src/features/chapter/chapter-list';

function chapter(partial: Partial<ChapterSummary> & { id: string }): ChapterSummary {
  return {
    order: 1,
    title: '第 1 章',
    status: 'draft',
    wordCount: 0,
    dirName: '001-x',
    ...partial,
  };
}

describe('sortChapters —— 按 order 升序，防御性排序', () => {
  it('乱序输入被排好（服务端换排序依据时不会静默乱掉）', () => {
    const sorted = sortChapters([
      chapter({ id: 'c', order: 3 }),
      chapter({ id: 'a', order: 1 }),
      chapter({ id: 'b', order: 2 }),
    ]);
    expect(sorted.map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });

  it('order 相同时用 id 兜底，保证顺序稳定（不然每次渲染可能换位）', () => {
    const sorted = sortChapters([chapter({ id: 'z', order: 1 }), chapter({ id: 'a', order: 1 })]);
    expect(sorted.map((c) => c.id)).toEqual(['a', 'z']);
  });

  it('返回新数组，不改动入参（原地 sort 会让 React 看不到变化）', () => {
    const input = [chapter({ id: 'b', order: 2 }), chapter({ id: 'a', order: 1 })];
    const snapshot = input.map((c) => c.id);

    const sorted = sortChapters(input);

    expect(sorted).not.toBe(input);
    expect(input.map((c) => c.id)).toEqual(snapshot);
  });

  it('空列表 → 空列表', () => {
    expect(sortChapters([])).toEqual([]);
  });
});

describe('firstChapter —— 空列表返回 null（界面据此显示空态，不自动补建）', () => {
  it('取 order 最小的一章', () => {
    const first = firstChapter([chapter({ id: 'b', order: 2 }), chapter({ id: 'a', order: 1 })]);
    expect(first?.id).toBe('a');
  });

  it('空列表 → null', () => {
    expect(firstChapter([])).toBeNull();
  });
});

describe('patchChapterWordCount —— 按 id 匹配，本地更新', () => {
  it('命中项的字数变了', () => {
    const next = patchChapterWordCount(
      [
        chapter({ id: 'a', order: 1, wordCount: 10 }),
        chapter({ id: 'b', order: 2, wordCount: 20 }),
      ],
      'b',
      99,
    );
    expect(next.find((c) => c.id === 'b')?.wordCount).toBe(99);
    expect(next.find((c) => c.id === 'a')?.wordCount).toBe(10);
  });

  it('**按 id 不是按 order** —— 重排后 order 会变，按它匹配会改错项', () => {
    // b 章被重排到 order=1，但 id 没变。按 order 匹配会误改到 a。
    const next = patchChapterWordCount(
      [
        chapter({ id: 'a', order: 1, wordCount: 10 }),
        chapter({ id: 'b', order: 2, wordCount: 20 }),
      ],
      'b',
      99,
    );
    expect(next.find((c) => c.id === 'a')?.wordCount).toBe(10);
    expect(next.find((c) => c.id === 'b')?.wordCount).toBe(99);
  });

  it('没有实际变化时返回原引用（避免调用方白触发一次渲染）', () => {
    const input = [chapter({ id: 'a', wordCount: 10 })];
    expect(patchChapterWordCount(input, 'a', 10)).toBe(input);
  });

  it('id 不存在时原样返回原引用', () => {
    const input = [chapter({ id: 'a', wordCount: 10 })];
    expect(patchChapterWordCount(input, 'nope', 99)).toBe(input);
  });

  it('命中且变化时返回新数组（否则 React 认为没变）', () => {
    const input = [chapter({ id: 'a', wordCount: 10 })];
    const next = patchChapterWordCount(input, 'a', 11);
    expect(next).not.toBe(input);
  });
});

describe('defaultChapterTitle —— 新章占位标题', () => {
  it('空列表 → 第 1 章', () => {
    expect(defaultChapterTitle([])).toBe('第 1 章');
  });

  it('取最大 order + 1（不是长度 + 1 —— 删过章后两者会分叉）', () => {
    expect(
      defaultChapterTitle([chapter({ id: 'a', order: 1 }), chapter({ id: 'c', order: 7 })]),
    ).toBe('第 8 章');
  });
});

describe('describeChapterStatus —— 状态标签（M0 只读展示）', () => {
  const cases: Array<[ChapterStatus, string, string]> = [
    ['draft', '草稿', 'draft'],
    ['revising', '修改中', 'revising'],
    ['done', '已完成', 'done'],
  ];

  for (const [status, label, tone] of cases) {
    it(`${status} → ${label}`, () => {
      expect(describeChapterStatus(status)).toEqual({ label, tone });
    });
  }
});

describe('formatWordCount —— 千分位', () => {
  it('千位以下不加分隔', () => {
    expect(formatWordCount(999)).toBe('999');
  });

  it('千位以上加分隔', () => {
    expect(formatWordCount(1234567)).toBe('1,234,567');
  });

  it('0 → "0"（不是空串）', () => {
    expect(formatWordCount(0)).toBe('0');
  });
});

describe('chapterLabel —— 列表行文字', () => {
  it('正常标题：序号 · 标题，用正文色', () => {
    expect(chapterLabel(chapter({ id: 'a', order: 3, title: '夜行' }))).toEqual({
      text: '第 3 章 · 夜行',
      muted: false,
    });
  });

  it('空标题：只显示序号，次要色（别让它冒充章节名）', () => {
    expect(chapterLabel(chapter({ id: 'a', order: 3, title: '' }))).toEqual({
      text: '第 3 章',
      muted: true,
    });
  });

  it('服务端回退值「未命名」：当成没标题', () => {
    expect(chapterLabel(chapter({ id: 'a', order: 3, title: TITLE_FALLBACK }))).toEqual({
      text: '第 3 章',
      muted: true,
    });
  });

  it('标题恰好是「第 N 章」（新章占位）：不重复显示成「第 3 章 · 第 3 章」', () => {
    expect(chapterLabel(chapter({ id: 'a', order: 3, title: '第 3 章' }))).toEqual({
      text: '第 3 章',
      muted: true,
    });
  });

  it('只有空白字符的标题也当空处理', () => {
    expect(chapterLabel(chapter({ id: 'a', order: 3, title: '   ' }))).toEqual({
      text: '第 3 章',
      muted: true,
    });
  });

  it('「第 3 章」但 order 是 5：不是占位，正常显示（按实际 order 判等）', () => {
    expect(chapterLabel(chapter({ id: 'a', order: 5, title: '第 3 章' }))).toEqual({
      text: '第 5 章 · 第 3 章',
      muted: false,
    });
  });
});
