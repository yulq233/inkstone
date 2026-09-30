/**
 * 冲突三条路径的单测（`06` 文档 §6.2、§9）。
 *
 * 这里的两条断言是**这一步最重要的测试**：
 *
 * 1. 「保留我的并覆盖」的请求体必须 `baseHash === detail.diskHash` 且 `backup === true`。
 *    写错任一条都不会报错 —— 前者的症状是反复弹冲突，后者的症状是
 *    **用户选了覆盖的那一刻，磁盘上那一版就彻底没了**。
 * 2. 「另存副本」必须先写副本、再动当前章。顺序反了，一旦写副本失败，
 *    用户的内容既不在当前章、也不在副本里。
 *
 * 之所以能这样测，是因为编排被抽成了不依赖 React 的纯函数 —— 渲染进程的测试环境
 * 是 node、没有 jsdom，挂在钩子里的逻辑一行都测不到。
 */

import { describe, expect, it } from 'vitest';
import type {
  ChapterContent,
  ChapterSummary,
  CreateChapterRequest,
  ExternalModifiedDetail,
  UpdateChapterRequest,
  WriteChapterResult,
} from '@inkstone/shared';

import type { ApiClient } from '../src/renderer/src/lib/api';
import {
  applyConflictChoice,
  availableChoices,
  previewMarkdown,
  type ConflictContext,
} from '../src/renderer/src/features/editor/conflict-actions';

const DETAIL: ExternalModifiedDetail = {
  diskHash: 'hash-from-disk',
  diskMarkdown: '# 磁盘上的第一章\n\n别人的改动。',
  diskSavedAt: '2026-09-20T08:00:00.000Z',
};

interface WriteCall {
  workId: string;
  chapterId: string;
  body: UpdateChapterRequest;
}

interface SetupOptions {
  /** 让「写副本」那一次调用失败，用来验证顺序 */
  failCopyWrite?: boolean;
}

function setup(options: SetupOptions = {}) {
  const calls: string[] = [];
  const writes: WriteCall[] = [];
  const creates: Array<{ workId: string; body: CreateChapterRequest }> = [];

  const client = {
    async writeChapter(
      workId: string,
      chapterId: string,
      body: UpdateChapterRequest,
    ): Promise<WriteChapterResult> {
      calls.push(`write:${chapterId}`);
      writes.push({ workId, chapterId, body });
      if (options.failCopyWrite === true && chapterId !== 'biz-1') {
        throw new Error('磁盘写满了');
      }
      return {
        hash: `hash-after-${chapterId}`,
        wordCount: 12,
        savedAt: '2026-09-20T09:30:00.000Z',
        backupPath: body.backup === true ? '/w/.inkstone/backups/biz-1-1.md' : null,
      };
    },

    async createChapter(workId: string, body: CreateChapterRequest): Promise<ChapterSummary> {
      calls.push('create');
      creates.push({ workId, body });
      return {
        id: 'copy-1',
        order: 2,
        title: body.title,
        status: 'draft',
        wordCount: 0,
        dirName: '002-副本',
      };
    },

    async readChapter(_workId: string, chapterId: string): Promise<ChapterContent> {
      calls.push(`read:${chapterId}`);
      return {
        id: chapterId,
        order: 1,
        title: '第一章',
        status: 'draft',
        markdown: `disk:${chapterId}`,
        hash: `hash-of-${chapterId}`,
        wordCount: 3,
        savedAt: null,
      };
    },
  } as unknown as ApiClient;

  return { client, calls, writes, creates };
}

function context(client: ApiClient, overrides: Partial<ConflictContext> = {}): ConflictContext {
  return {
    client,
    workId: 'w1',
    chapterId: 'biz-1',
    detail: DETAIL,
    mine: '# 我的第一章\n\n我写的。',
    chapterTitle: '第一章',
    ...overrides,
  };
}

describe('availableChoices —— detail 为 null 时不给「覆盖」', () => {
  it('有 detail 时三选一齐全', () => {
    expect(availableChoices(DETAIL)).toEqual(['use-disk', 'keep-mine', 'save-as-copy']);
  });

  it('没有 detail 时只剩两条：覆盖需要 diskHash 当 baseHash，没有它就只能瞎写一个', () => {
    expect(availableChoices(null)).toEqual(['use-disk', 'save-as-copy']);
    expect(availableChoices(null)).not.toContain('keep-mine');
  });
});

describe('keep-mine —— 覆盖路径（静默丢数据的重灾区）', () => {
  it('baseHash 取磁盘 hash、backup 必须为 true', async () => {
    const { client, writes } = setup();

    const result = await applyConflictChoice('keep-mine', context(client));

    expect(writes).toHaveLength(1);
    const body = writes[0].body;
    expect(body.markdown).toBe('# 我的第一章\n\n我写的。');
    // 写错 -> 再撞一次 409，陷入死循环
    expect(body.baseHash).toBe(DETAIL.diskHash);
    // 漏掉 -> 磁盘上那一版彻底没了
    expect(body.backup).toBe(true);

    expect(result.hash).toBe('hash-after-biz-1');
    expect(result.backupPath).toBe('/w/.inkstone/backups/biz-1-1.md');
    // 磁盘已经写成我们的内容了，编辑器不需要换
    expect(result.applyMarkdown).toBeNull();
  });

  it('detail 为 null 时直接拒绝，绝不瞎写一个 baseHash', async () => {
    const { client, writes } = setup();

    await expect(
      applyConflictChoice('keep-mine', context(client, { detail: null })),
    ).rejects.toThrow(/不可用/);
    expect(writes).toHaveLength(0);
  });
});

describe('use-disk —— 用磁盘版本', () => {
  it('优先用 409 信封里带的内容，省一次往返', async () => {
    const { client, calls } = setup();

    const result = await applyConflictChoice('use-disk', context(client));

    expect(calls).toEqual([]);
    expect(result.hash).toBe(DETAIL.diskHash);
    expect(result.applyMarkdown).toBe(DETAIL.diskMarkdown);
    expect(result.backupPath).toBeNull();
  });

  it('信封形状不对时才真的去读一次磁盘 —— 这条路的语义本来就是"以磁盘为准"', async () => {
    const { client, calls } = setup();

    const result = await applyConflictChoice('use-disk', context(client, { detail: null }));

    expect(calls).toEqual(['read:biz-1']);
    expect(result.hash).toBe('hash-of-biz-1');
    expect(result.applyMarkdown).toBe('disk:biz-1');
  });
});

describe('save-as-copy —— 顺序不能反', () => {
  it('先建副本、再写副本、最后才重载当前章', async () => {
    const { client, calls, creates, writes } = setup();

    const result = await applyConflictChoice('save-as-copy', context(client));

    // 有 detail 时最后一步用信封里的内容，所以不会出现 read:biz-1
    expect(calls).toEqual(['create', 'read:copy-1', 'write:copy-1']);
    expect(creates[0].body.title).toBe('第一章-副本');

    const copyWrite = writes.find((w) => w.chapterId === 'copy-1');
    expect(copyWrite?.body.markdown).toBe('# 我的第一章\n\n我写的。');
    // 新章只有摘要、没有 hash，必须先读一次拿到它
    expect(copyWrite?.body.baseHash).toBe('hash-of-copy-1');

    expect(result.copyChapterId).toBe('copy-1');
    expect(result.applyMarkdown).toBe(DETAIL.diskMarkdown);
    expect(result.hash).toBe(DETAIL.diskHash);
  });

  it('写副本失败时，当前章**一个字都没被动过**（这就是顺序的全部意义）', async () => {
    const { client, calls } = setup({ failCopyWrite: true });

    await expect(
      applyConflictChoice('save-as-copy', context(client, { detail: null })),
    ).rejects.toThrow('磁盘写满了');

    // 关键断言：没有 read:biz-1 —— 当前章没有被重载，用户的内容还在编辑器里
    expect(calls).toEqual(['create', 'read:copy-1', 'write:copy-1']);
    expect(calls).not.toContain('read:biz-1');
  });
});

describe('previewMarkdown —— 按码点截断', () => {
  it('不超限就原样返回', () => {
    expect(previewMarkdown('短正文', 10)).toBe('短正文');
  });

  it('超限时截断并加省略号', () => {
    const result = previewMarkdown('字'.repeat(50), 10);
    expect(Array.from(result).slice(0, 10).join('')).toBe('字'.repeat(10));
    expect(result.endsWith('…')).toBe(true);
  });

  it('不把代理对（emoji / 生僻字）从中间切开 —— 切开就是两个乱码方块', () => {
    const result = previewMarkdown('😀'.repeat(500), 400);
    // 400 个码点 + 省略号，而不是 400 个 UTF-16 码元切出半截
    expect(Array.from(result)).toHaveLength(401);
    expect(result.startsWith('😀')).toBe(true);
    expect(result.includes('\uFFFD')).toBe(false);
  });

  it('默认上限 400 字', () => {
    const result = previewMarkdown('啊'.repeat(1_000));
    expect(Array.from(result)).toHaveLength(401);
  });
});
