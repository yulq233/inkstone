/**
 * 大纲面板纯逻辑测试（docs/15 B4）。
 *
 * 只测 `outline-model.ts` 的纯函数 —— 超期/孤儿是 sidecar 现算好的（前端只翻译
 * 成文案），这里测的是「翻译」的正确性：徽标优先级、提示优先级、卷排序。
 */

import { describe, expect, it } from 'vitest';
import {
  expectResolveByText,
  foreshadowBadge,
  foreshadowHint,
  isForeshadowAttention,
  sortVolumes,
} from '../src/renderer/src/features/outline/outline-model';
import type { ForeshadowItem, VolumeOutlineSummary } from '@inkstone/shared';

function foreshadow(overrides: Partial<ForeshadowItem>): ForeshadowItem {
  return {
    id: 'fs_x',
    title: '旧宅地窖的半封信',
    expectResolveBy: null,
    status: 'open',
    resolvedIn: null,
    chapterId: 'ch_1',
    orphan: false,
    overdue: false,
    ...overrides,
  };
}

function volume(order: number): VolumeOutlineSummary {
  return { order, title: `卷${order}`, slug: `卷${order}`, hash: 'h' };
}

describe('sortVolumes', () => {
  it('按 order 升序（不是字典序）', () => {
    const sorted = sortVolumes([volume(10), volume(2), volume(1)]);
    expect(sorted.map((v) => v.order)).toEqual([1, 2, 10]);
  });

  it('不改动入参数组（返回副本）', () => {
    const items = [volume(2), volume(1)];
    sortVolumes(items);
    expect(items.map((v) => v.order)).toEqual([2, 1]);
  });
});

describe('foreshadowBadge', () => {
  it('超期 → 已超期', () => {
    expect(foreshadowBadge(foreshadow({ overdue: true }))).toBe('已超期');
  });

  it('孤儿（章节已删）→ 章节已删', () => {
    expect(foreshadowBadge(foreshadow({ orphan: true }))).toBe('章节已删');
  });

  it('open 且有期望回收卷 → 待回收', () => {
    expect(foreshadowBadge(foreshadow({ status: 'open', expectResolveBy: 2 }))).toBe('待回收');
  });

  it('无限期 open → 无徽标', () => {
    expect(foreshadowBadge(foreshadow({ status: 'open', expectResolveBy: null }))).toBeNull();
  });

  it('已回收/已放弃 → 无徽标', () => {
    expect(foreshadowBadge(foreshadow({ status: 'resolved' }))).toBeNull();
    expect(foreshadowBadge(foreshadow({ status: 'dropped' }))).toBeNull();
  });
});

describe('foreshadowHint', () => {
  it('超期优先于孤儿', () => {
    const hint = foreshadowHint(foreshadow({ overdue: true, orphan: true, expectResolveBy: 3 }));
    expect(hint).toContain('第 3 卷');
  });

  it('超期带期望卷号', () => {
    const hint = foreshadowHint(foreshadow({ overdue: true, expectResolveBy: 2 }));
    expect(hint).toContain('第 2 卷');
  });

  it('孤儿给孤悬线索提示', () => {
    const hint = foreshadowHint(foreshadow({ orphan: true }));
    expect(hint).toContain('删除');
  });

  it('正常伏笔无提示', () => {
    expect(foreshadowHint(foreshadow({}))).toBeNull();
  });
});

describe('expectResolveByText', () => {
  it('null → 无限期', () => {
    expect(expectResolveByText(null)).toBe('无限期');
  });
  it('数字 → 第 N 卷前', () => {
    expect(expectResolveByText(3)).toBe('第 3 卷前');
  });
});

describe('isForeshadowAttention', () => {
  it('超期或孤儿为 true，正常为 false', () => {
    expect(isForeshadowAttention(foreshadow({ overdue: true }))).toBe(true);
    expect(isForeshadowAttention(foreshadow({ orphan: true }))).toBe(true);
    expect(isForeshadowAttention(foreshadow({}))).toBe(false);
  });
});
