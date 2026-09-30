/**
 * 大纲面板的纯逻辑（docs/15 B4）。**零 React 依赖**，vitest 直接 import。
 *
 * 与 codex-model.ts 同一条纪律：把「排序 / 状态标签 / 超期与孤儿文案」从组件里
 * 抽出来，组件只做「把状态交给这些函数、再渲染返回结果」，判定逻辑可穷举测试。
 *
 * 注意：伏笔的 `overdue` / `orphan` **不是**前端算的 —— sidecar 的
 * `GET /foreshadows` 已经现算好（`outline_store.py::_foreshadows_sync`），
 * 前端只负责把它们翻译成展示文案。这里不重复实现判定逻辑，否则两处必然漂移。
 */

import type { ForeshadowItem, VolumeOutlineSummary } from '@inkstone/shared';

/** 卷纲清单排序：按 order 升序（order 是人可感知的卷序号，不是字典序）。 */
export function sortVolumes(items: VolumeOutlineSummary[]): VolumeOutlineSummary[] {
  return [...items].sort((a, b) => a.order - b.order);
}

/** 伏笔状态 → 展示标签。 */
export const FORESHADOW_STATUS_LABELS: Record<ForeshadowItem['status'], string> = {
  open: '未回收',
  resolved: '已回收',
  dropped: '已放弃',
};

/**
 * 一条伏笔的状态徽标（展示用）。返回 null = 无需徽标（已回收/已放弃的伏笔
 * 不需要再强调什么，正文里看得到）。
 */
export function foreshadowBadge(item: ForeshadowItem): string | null {
  if (item.overdue) return '已超期';
  if (item.orphan) return '章节已删';
  if (item.status === 'open' && item.expectResolveBy !== null) return '待回收';
  return null;
}

/**
 * 伏笔的超期/孤儿提示行（一句人能看懂的话，挂在清单项下方）。
 * 返回 null = 该条无需额外提示。
 *
 * 超期优先于孤儿：一条伏笔既超期又住在已删章节里时，用户更该关心「该收了」，
 * 而不是「这章没了」。
 */
export function foreshadowHint(item: ForeshadowItem): string | null {
  if (item.overdue) {
    return item.expectResolveBy !== null
      ? `原计划在第 ${item.expectResolveBy} 卷之前回收，现在已经写过去了。`
      : '这条伏笔已经超期，尽快安排回收。';
  }
  if (item.orphan) {
    return '登记它的章节已被删除，这条伏笔成了孤悬的线索。';
  }
  return null;
}

/** 期望回收卷的展示：None（无限期）→ 「无限期」。 */
export function expectResolveByText(value: number | null): string {
  return value === null ? '无限期' : `第 ${value} 卷前`;
}

/** 一条伏笔是否处于「需要提醒」的醒目状态（超期或孤儿）。 */
export function isForeshadowAttention(item: ForeshadowItem): boolean {
  return item.overdue || item.orphan;
}
