/**
 * 保存状态"说法层"的单测（`06` 文档 §5、§8、§9）。
 *
 * 这一层值得单测，是因为它的失效方式是**误导**而不是崩溃：
 * 状态明明没落盘却显示"已保存"，用户就会放心地关掉应用。
 * 六态到四种说法的映射、`dirty` 的 1 秒迟滞、401 不给重试 —— 都属于这类。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '@inkstone/shared';

import { ApiError, NETWORK_ERROR_CODE } from '../src/renderer/src/lib/api';
import type { SaveState } from '../src/renderer/src/lib/autosave';
import {
  DIRTY_HOLD_MS,
  SaveStatusPresenter,
  describeSaveError,
  describeSaveState,
  formatSavedAt,
  type SaveStatusView,
} from '../src/renderer/src/features/editor/save-status';

const T0 = Date.parse('2026-09-20T09:00:00.000Z');

describe('describeSaveState —— 六态 → 四种说法', () => {
  it('idle 显示「已保存」，且不带相对时间（刚载入，还没有一次写入）', () => {
    const view = describeSaveState('idle', null, T0);
    expect(view.label).toBe('已保存');
    expect(view.tone).toBe('muted');
    expect(view.hint).toBe('');
    expect(view.busy).toBe(false);
    expect(view.actionable).toBe(false);
  });

  it('saving 带进度指示', () => {
    const view = describeSaveState('saving', null, T0);
    expect(view.label).toBe('保存中');
    expect(view.busy).toBe(true);
    expect(view.tone).toBe('muted');
  });

  it('dirty 是唯一的警示态 —— 它表示"你的字还没落盘"', () => {
    const view = describeSaveState('dirty', null, T0);
    expect(view.label).toBe('未保存');
    expect(view.tone).toBe('warn');
  });

  it('error 用危险色，且不显示相对时间（那会让人以为刚存过）', () => {
    const view = describeSaveState('error', new Date(T0).toISOString(), T0);
    expect(view.label).toBe('保存失败');
    expect(view.tone).toBe('danger');
    expect(view.hint).toBe('');
    expect(view.busy).toBe(false);
  });

  it('conflict 可点击（点开三选一）', () => {
    const view = describeSaveState('conflict', null, T0);
    expect(view.label).toBe('文件被外部修改');
    expect(view.tone).toBe('danger');
    expect(view.actionable).toBe(true);
  });

  it('saved 显示相对时间', () => {
    const view = describeSaveState('saved', new Date(T0 - 5_000).toISOString(), T0);
    expect(view.label).toBe('已保存');
    expect(view.hint).toBe('刚刚');
  });

  it('所有状态都给得出四种说法之一，没有落空的 default', () => {
    const states: SaveState[] = ['idle', 'dirty', 'saving', 'saved', 'conflict', 'error'];
    const labels = new Set(states.map((s) => describeSaveState(s, null, T0).label));
    // 六态收敛成四种说法：已保存 / 未保存 / 保存中 / 保存失败 / 文件被外部修改
    expect(labels).toEqual(new Set(['已保存', '未保存', '保存中', '保存失败', '文件被外部修改']));
  });
});

describe('formatSavedAt', () => {
  it('null / 空串 / 非法时间都返回空串，而不是抛错或显示 "Invalid Date"', () => {
    expect(formatSavedAt(null, T0)).toBe('');
    expect(formatSavedAt('', T0)).toBe('');
    expect(formatSavedAt('不是时间', T0)).toBe('');
  });

  it('按档位给相对时间', () => {
    expect(formatSavedAt(new Date(T0 - 3_000).toISOString(), T0)).toBe('刚刚');
    expect(formatSavedAt(new Date(T0 - 30_000).toISOString(), T0)).toBe('30 秒前');
    expect(formatSavedAt(new Date(T0 - 5 * 60_000).toISOString(), T0)).toBe('5 分钟前');
    expect(formatSavedAt(new Date(T0 - 2 * 3_600_000).toISOString(), T0)).toBe('2 小时前');
    expect(formatSavedAt(new Date(T0 - 3 * 86_400_000).toISOString(), T0)).toBe('3 天前');
  });

  it('时钟回拨按「刚刚」处理 —— 显示"−3 秒前"只会让人怀疑软件坏了', () => {
    expect(formatSavedAt(new Date(T0 + 3_000).toISOString(), T0)).toBe('刚刚');
  });
});

describe('describeSaveError —— 401 不给重试（§8）', () => {
  it('401 说明 token 失效，重试一万次还是 401，所以不给按钮', () => {
    const view = describeSaveError(new ApiError(ErrorCode.UNAUTHORIZED, '鉴权失败', 401));
    expect(view.canRetry).toBe(false);
    expect(view.message).toContain('重启应用');
  });

  it('网络失败可重试，且明说正在自动恢复（supervisor 会拉起 sidecar）', () => {
    const view = describeSaveError(new ApiError(NETWORK_ERROR_CODE, '连不上', 0));
    expect(view.canRetry).toBe(true);
    expect(view.message).toContain('自动恢复');
  });

  it('5xx 可重试', () => {
    const view = describeSaveError(new ApiError('INTERNAL', '炸了', 500));
    expect(view.canRetry).toBe(true);
    expect(view.message).toBe('炸了');
  });

  it('非 ApiError 也不吞掉信息', () => {
    const view = describeSaveError(new Error('意外'));
    expect(view.canRetry).toBe(true);
    expect(view.message).toBe('意外');
  });
});

describe('SaveStatusPresenter —— dirty 的 1 秒迟滞（§5）', () => {
  const collect = () => {
    const views: SaveStatusView[] = [];
    const presenter = new SaveStatusPresenter((view) => views.push(view));
    return { views, presenter };
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  it('dirty 在 1 秒内不显示（500ms 防抖窗口里的一闪而过是噪音）', () => {
    vi.useFakeTimers();
    const { views, presenter } = collect();

    presenter.update('dirty', null);
    expect(views).toHaveLength(0);

    vi.advanceTimersByTime(DIRTY_HOLD_MS - 1);
    expect(views).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(views).toHaveLength(1);
    expect(views[0]?.label).toBe('未保存');

    presenter.dispose();
  });

  it('1 秒内已经保存成功，就永远不显示「未保存」', () => {
    vi.useFakeTimers();
    const { views, presenter } = collect();

    presenter.update('dirty', null);
    vi.advanceTimersByTime(300);
    presenter.update('saved', new Date().toISOString());
    vi.advanceTimersByTime(10_000);

    expect(views.map((v) => v.label)).toEqual(['已保存']);
    presenter.dispose();
  });

  it('状态没变时不重复 emit（避免每个字符都触发一次渲染）', () => {
    const { views, presenter } = collect();

    presenter.update('idle', null);
    presenter.update('idle', null);
    expect(views).toHaveLength(0);

    presenter.update('saving', null);
    presenter.update('saving', null);
    expect(views).toHaveLength(1);
    expect(views[0]?.label).toBe('保存中');

    presenter.dispose();
  });

  it('dispose 之后不再 emit（定时器要先清掉，否则会出现"组件已卸载还在 setState"）', () => {
    vi.useFakeTimers();
    const { views, presenter } = collect();

    presenter.update('dirty', null);
    presenter.dispose();
    vi.advanceTimersByTime(10_000);

    expect(views).toHaveLength(0);
  });
});
