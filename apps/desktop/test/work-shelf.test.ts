/**
 * 书架纯逻辑的单测（`04` §11）。
 *
 * 每条断言都对应一个**用户能看见**的症状：
 * - 把 `null`（还没读到）当成 `[]`（真的没有）→ 首帧闪一下"书架空着"；
 * - 让错误盖住列表 → 刷新失败一次，用户以为作品都没了（而它们还能打开）；
 * - `sortShelf` 不把坏时间排最后 → 一条被手工改坏的记录占住第一个格子；
 * - `coverGlyph` 按 UTF-16 码元切 → 标题以 emoji 开头时封面上是个方框；
 * - `shelfCardStatus` 的判定顺序反了 → "正在打开"被上一次的失败信息盖掉。
 */

import { describe, expect, it } from 'vitest';
import type { RecentWork } from '@inkstone/shared';

import {
  coverGlyph,
  shelfCardStatus,
  shelfView,
  sortShelf,
} from '../src/renderer/src/features/work/shelf-view';

function work(partial: Partial<RecentWork> & { rootPath: string }): RecentWork {
  return {
    title: '未命名',
    lastOpenedAt: '2026-09-20T10:00:00+08:00',
    exists: true,
    ...partial,
  };
}

describe('shelfView —— 列表状态与错误是两件事', () => {
  it('还没拿到列表 → loading（不是空态）', () => {
    expect(shelfView(null, null)).toEqual({ list: { kind: 'loading' }, error: null });
  });

  it('确实没有作品 → empty', () => {
    expect(shelfView([], null)).toEqual({ list: { kind: 'empty' }, error: null });
  });

  it('没拿到过列表且这次失败 → unavailable，**不能**显示成 loading 让人干等', () => {
    expect(shelfView(null, '连接被拒绝')).toEqual({
      list: { kind: 'unavailable' },
      error: '连接被拒绝',
    });
  });

  it('先成功过、之后刷新失败 → 列表**保留**，错误只作附注', () => {
    const items = [work({ rootPath: 'D:/书/A', title: '甲' })];
    const view = shelfView(items, '连接被拒绝');
    expect(view.error).toBe('连接被拒绝');
    expect(view.list.kind).toBe('ready');
    expect(view.list.kind === 'ready' && view.list.items).toHaveLength(1);
  });

  it('ready 时顺带排好序（免得调用方漏排）', () => {
    const view = shelfView(
      [
        work({ rootPath: 'D:/书/旧', lastOpenedAt: '2026-09-01T10:00:00+08:00' }),
        work({ rootPath: 'D:/书/新', lastOpenedAt: '2026-09-20T10:00:00+08:00' }),
      ],
      null,
    );
    expect(view.list.kind === 'ready' && view.list.items.map((i) => i.rootPath)).toEqual([
      'D:/书/新',
      'D:/书/旧',
    ]);
  });
});

describe('sortShelf —— 最近打开的在前，坏时间垫底', () => {
  it('按真实时间戳倒序，不是按 ISO 字符串', () => {
    const sorted = sortShelf([
      work({ rootPath: 'a', lastOpenedAt: '2026-09-20T09:00:00+08:00' }),
      work({ rootPath: 'b', lastOpenedAt: '2026-09-20T09:00:00+09:00' }), // 早一小时
    ]);
    expect(sorted.map((i) => i.rootPath)).toEqual(['a', 'b']);
  });

  it('时间解析不出来（空串 / 被手工改坏）的排**最后**，不占头一格', () => {
    const sorted = sortShelf([
      work({ rootPath: '坏', lastOpenedAt: '' }),
      work({ rootPath: '好', lastOpenedAt: '2026-09-01T10:00:00+08:00' }),
    ]);
    expect(sorted.map((i) => i.rootPath)).toEqual(['好', '坏']);
  });

  it('时间相同时按书名给稳定次序，避免每次渲染位置在跳', () => {
    const same = '2026-09-20T10:00:00+08:00';
    const sorted = sortShelf([
      work({ rootPath: 'x', title: '乙', lastOpenedAt: same }),
      work({ rootPath: 'y', title: '甲', lastOpenedAt: same }),
    ]);
    expect(sorted.map((i) => i.title)).toEqual(['甲', '乙']);
  });

  it('不原地改数组：改的是副本，原引用保持不动', () => {
    const items = [
      work({ rootPath: 'a', lastOpenedAt: '2026-09-01T10:00:00+08:00' }),
      work({ rootPath: 'b', lastOpenedAt: '2026-09-20T10:00:00+08:00' }),
    ];
    const snapshot = [...items];
    sortShelf(items);
    expect(items).toEqual(snapshot);
  });
});

describe('coverGlyph —— 封面上的那个大字', () => {
  it('取书名首字，前后空白先剪掉', () => {
    expect(coverGlyph('  三体 ')).toBe('三');
  });

  it('空标题退回一个字，而不是渲染出空白封面', () => {
    expect(coverGlyph('')).toBe('书');
    expect(coverGlyph('   ')).toBe('书');
  });

  it('以 emoji 开头时整颗取，不切出半个字符（那是半个方框）', () => {
    expect(coverGlyph('🎈气球')).toBe('🎈');
  });
});

describe('shelfCardStatus —— 四条出路的优先级', () => {
  it('正常：显示上次打开时间', () => {
    expect(
      shelfCardStatus({
        opening: false,
        failureMessage: null,
        exists: true,
        lastOpenedText: '2026-09-20 10:00',
      }),
    ).toEqual({ text: '上次打开 2026-09-20 10:00', bad: false });
  });

  it('目录没了：红字提示，且标记 bad（组件据此显示「从列表移除」）', () => {
    expect(
      shelfCardStatus({ opening: false, failureMessage: null, exists: false, lastOpenedText: '' }),
    ).toEqual({ text: '目录已移动或删除', bad: true });
  });

  it('刚打开失败：显示失败原因，优先级高于"目录没了"', () => {
    expect(
      shelfCardStatus({
        opening: false,
        failureMessage: '作品目录不存在',
        exists: false,
        lastOpenedText: '',
      }),
    ).toEqual({ text: '作品目录不存在', bad: true });
  });

  it('正在打开：盖过之前留下的失败信息（否则显示的是上一次的报错）', () => {
    expect(
      shelfCardStatus({
        opening: true,
        failureMessage: '作品目录不存在',
        exists: false,
        lastOpenedText: '',
      }),
    ).toEqual({ text: '打开中……', bad: false });
  });
});
