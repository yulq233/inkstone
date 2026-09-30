/**
 * 会话状态迁移的单测（04 文档 §8）。
 *
 * 这个 reducer 值得测，是因为它的**非法态是表示不出来的**（判别联合），
 * 所以真正的风险不在"状态组合错了"，而在某条迁移把不该丢的字段丢了 ——
 * 比如失败页需要 `work` 来告诉用户是哪个作品出的错。
 */

import { describe, expect, it } from 'vitest';
import type { ChapterSummary, WorkSummary } from '@inkstone/shared';

import {
  initialSessionState,
  screenFor,
  sessionReducer,
  type SessionState,
} from '../src/renderer/src/features/session/session-reducer';

function work(id = 'w1', title = '云京旧事'): WorkSummary {
  return {
    id,
    title,
    author: '小方同学',
    genre: '悬疑',
    tags: [],
    wordGoal: 100_000,
    dailyGoal: 2_000,
    rootPath: `E:/novels/${id}`,
    createdAt: '2026-09-20T10:00:00+08:00',
    updatedAt: '2026-09-20T10:00:00+08:00',
    chapterCount: 1,
    totalWords: 0,
  };
}

function chapter(id = 'c1', order = 1): ChapterSummary {
  return {
    id,
    order,
    title: `第${order}章`,
    status: 'draft',
    wordCount: 0,
    dirName: `${String(order).padStart(3, '0')}-第${order}章`,
  };
}

describe('会话状态 · 打开作品', () => {
  it('初始态是入口页', () => {
    expect(initialSessionState).toEqual({ kind: 'entry' });
  });

  it('entry → opening：只带标题，不带（此刻还拿不到的）作品摘要', () => {
    const next = sessionReducer(initialSessionState, { type: 'work/opening', title: '云京旧事' });
    expect(next).toEqual({ kind: 'opening', title: '云京旧事' });
  });

  it('opening → ready：作品与章节一起落位', () => {
    const opening = sessionReducer(initialSessionState, {
      type: 'work/opening',
      title: '云京旧事',
    });
    const ready = sessionReducer(opening, {
      type: 'work/opened',
      work: work(),
      chapter: chapter(),
    });

    expect(ready.kind).toBe('ready');
    if (ready.kind !== 'ready') return;
    expect(ready.work.title).toBe('云京旧事');
    expect(ready.chapter?.order).toBe(1);
  });

  it('work/opened 传 null 章节是合法态：作品已打开但还没选章', () => {
    const ready = sessionReducer(initialSessionState, {
      type: 'work/opened',
      work: work(),
      chapter: null,
    });
    expect(ready).toEqual({ kind: 'ready', work: work(), chapter: null });
  });
});

describe('会话状态 · 失败', () => {
  it('从 ready 失败时保留 work，失败页才能显示是哪个作品', () => {
    const ready: SessionState = { kind: 'ready', work: work('w2', '另一本'), chapter: chapter() };
    const failed = sessionReducer(ready, { type: 'work/failed', error: '目录不可写' });

    expect(failed).toEqual({ kind: 'failed', work: work('w2', '另一本'), error: '目录不可写' });
  });

  it('从 entry 失败时 work 为 null（还没有过作品）', () => {
    const failed = sessionReducer(initialSessionState, { type: 'work/failed', error: '炸了' });
    expect(failed).toEqual({ kind: 'failed', work: null, error: '炸了' });
  });

  it('从 opening 失败时 work 为 null —— opening 本来就不持有摘要', () => {
    const opening = sessionReducer(initialSessionState, {
      type: 'work/opening',
      title: '云京旧事',
    });
    const failed = sessionReducer(opening, { type: 'work/failed', error: '连不上' });
    expect(failed).toEqual({ kind: 'failed', work: null, error: '连不上' });
  });
});

describe('会话状态 · 返回入口与切章', () => {
  it('work/leave 清空章节，只回入口页（不碰磁盘）', () => {
    const ready: SessionState = { kind: 'ready', work: work(), chapter: chapter('c9', 9) };
    expect(sessionReducer(ready, { type: 'work/leave' })).toEqual({ kind: 'entry' });
  });

  it('chapter/selected 在 ready 下替换章节且不动作品', () => {
    const ready: SessionState = { kind: 'ready', work: work(), chapter: chapter('c1', 1) };
    const next = sessionReducer(ready, { type: 'chapter/selected', chapter: chapter('c2', 2) });

    expect(next.kind).toBe('ready');
    if (next.kind !== 'ready') return;
    expect(next.chapter?.id).toBe('c2');
    expect(next.work).toEqual(work());
  });

  it('非法态下收到 chapter/selected 被忽略（返回原对象，不新建）', () => {
    const states: SessionState[] = [
      { kind: 'entry' },
      { kind: 'opening', title: '云京旧事' },
      { kind: 'failed', work: null, error: '炸了' },
    ];

    for (const state of states) {
      expect(sessionReducer(state, { type: 'chapter/selected', chapter: chapter() })).toBe(state);
    }
  });
});

/**
 * `screenFor` —— 哪个屏幕负责哪个会话状态（`docs/13` M19）。
 *
 * 这条映射只有四行，但它错了会**静默弄丢两条通道**：入口页在 `opening` 期间必须
 * 保持挂载，否则卡片上的「打开中……」与条目级失败提示都没机会显示，
 * 而界面上看不出任何异常（只是"点了没反应 / 失败后不知道去哪了"）。
 * 所以这里逐状态钉死，而不是靠"看代码觉得对"。
 */
describe('screenFor', () => {
  it('opening 归入口页 —— 书架上的「打开中……」与条目级失败提示活在那里', () => {
    expect(screenFor('entry')).toBe('entry');
    expect(screenFor('opening')).toBe('entry');
  });

  it('ready / failed 归工作台（failed 是全屏失败页，与条目级失败不是一回事）', () => {
    expect(screenFor('ready')).toBe('workbench');
    expect(screenFor('failed')).toBe('workbench');
  });
});
