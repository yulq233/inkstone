/**
 * 保存状态的"说法"层（`06` 文档 §5、§8）。
 *
 * `Autosave` 内部有 6 个状态，用户只该看到 4 种说法：
 *
 * | 内部状态 | 界面文案 |
 * |---|---|
 * | `idle` / `saved` | 已保存（配相对时间） |
 * | `dirty` | 未保存 |
 * | `saving` | 保存中 |
 * | `error` | 保存失败 |
 * | `conflict` | 文件被外部修改 |
 *
 * 为什么把这一层抽成纯逻辑而不是写在组件里：文案与颜色是**规则**，不是样式。
 * 抽出来之后 `dirty` 的延迟显示、`conflict` 的可点击性这些判断都能被单测钉住，
 * 而组件只剩"把 view 渲染出来"。
 *
 * 本模块不碰 React、不碰 DOM —— 渲染进程的测试环境是 node，没有 jsdom
 * （`vitest.config.mts` 的注释写明了这个取舍），碰了就无法自动验证。
 */

import type { SaveState } from '../../lib/autosave';
import { ApiError } from '../../lib/api';

export type SaveTone = 'muted' | 'warn' | 'danger';

export interface SaveStatusView {
  label: string;
  tone: SaveTone;
  /** 有请求在飞，显示细进度指示 */
  busy: boolean;
  /** 点它可以打开冲突对话框 */
  actionable: boolean;
  /** 附加说明（`saved` 时是相对时间） */
  hint: string;
}

export function describeSaveState(
  state: SaveState,
  savedAt: string | null,
  now: number = Date.now(),
): SaveStatusView {
  switch (state) {
    case 'saving':
      return { label: '保存中', tone: 'muted', busy: true, actionable: false, hint: '' };
    case 'dirty':
      // 警示色：这是唯一一个"你的字还没落盘"的状态，用户需要立刻能看出来。
      return { label: '未保存', tone: 'warn', busy: false, actionable: false, hint: '' };
    case 'error':
      // 文案刻意短。完整的安抚句（"内容仍在编辑器里"）由 SaveErrorBar 承担 ——
      // 状态指示是个窄条，塞长句会被截断，反而看不清。
      return { label: '保存失败', tone: 'danger', busy: false, actionable: false, hint: '' };
    case 'conflict':
      return { label: '文件被外部修改', tone: 'danger', busy: false, actionable: true, hint: '' };
    default:
      return {
        label: '已保存',
        tone: 'muted',
        busy: false,
        actionable: false,
        hint: state === 'saved' ? formatSavedAt(savedAt, now) : '',
      };
  }
}

/**
 * 相对时间。刻意粗糙 —— 这里回答的是"我刚敲的字进去了吗"，
 * 精度到秒没有意义，而精确到秒反而让人盯着看。
 *
 * 时钟回拨（`diff < 0`）按"刚刚"处理：显示"−3 秒前"只会让人怀疑软件坏了。
 */
export function formatSavedAt(savedAt: string | null, now: number = Date.now()): string {
  if (savedAt === null || savedAt === '') return '';
  const at = Date.parse(savedAt);
  if (!Number.isFinite(at)) return '';

  const diff = now - at;
  if (diff < 10_000) return '刚刚';
  if (diff < 60_000) return `${Math.floor(diff / 1_000)} 秒前`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

export interface SaveErrorView {
  message: string;
  /**
   * 是否给「重试」按钮。
   *
   * 规则来自 §8：只有 401 不给 —— 那种情况说明 token 失效（bug 或应用被外部重启），
   * 重试一万次还是 401，按钮只会骗人。其余（含 4xx 校验失败）都给：
   * 用户改一笔就能绕过它，按钮至少在语义上成立。
   */
  canRetry: boolean;
}

export function describeSaveError(err: unknown): SaveErrorView {
  if (err instanceof ApiError) {
    if (err.isUnauthorized) {
      return { message: '本地服务鉴权失效，保存未完成。请重启应用。', canRetry: false };
    }
    if (err.isNetwork) {
      // 端口变了 / sidecar 正在重启：主进程的 supervisor 会自动拉起来，
      // 所以这里说的是"正在等待自动恢复"，而不是让用户去干什么。
      return { message: '本地服务无响应，内容仍在编辑器里，正在等待自动恢复。', canRetry: true };
    }
    return { message: err.message, canRetry: true };
  }
  return { message: err instanceof Error ? err.message : String(err), canRetry: true };
}

/** `dirty` 的延迟窗口（§5）：500ms 防抖内一闪而过的"未保存"是噪音，不该出现在界面上。 */
export const DIRTY_HOLD_MS = 1_000;

/**
 * 展示态的迟滞器：把一闪而过的 `dirty` 挡掉。
 *
 * 为什么必须是定时器，而不是渲染时判"距上次改动多少毫秒"：后者要求组件按时间重渲染，
 * 于是每敲一个字都要重算一遍"该不该显示未保存"，等于为了一个提示把整块界面拖进高频更新。
 *
 * 语义上它是 `SaveState` 的**低通滤波**：状态最终一定会显示出来（不会永久吞掉），
 * 只是短暂经过的状态会被跳过。所以它不持有"要不要保存"这类判断 —— 那是 `Autosave` 的事。
 */
export class SaveStatusPresenter {
  private lastState: SaveState;
  private lastSavedAt: string | null;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private holding = false;
  private disposed = false;

  constructor(
    private readonly emit: (view: SaveStatusView) => void,
    initial: { state: SaveState; savedAt: string | null } = { state: 'idle', savedAt: null },
    private readonly holdMs: number = DIRTY_HOLD_MS,
  ) {
    this.lastState = initial.state;
    this.lastSavedAt = initial.savedAt;
  }

  update(state: SaveState, savedAt: string | null): void {
    if (this.disposed) return;

    if (state === 'dirty') {
      // 已经在延迟窗口里，或已经显示着"未保存"：都不用重复动作。
      if (this.holding || this.lastState === 'dirty') return;
      this.holding = true;
      this.holdTimer = setTimeout(() => {
        this.holdTimer = null;
        this.holding = false;
        this.commit('dirty', savedAt);
      }, this.holdMs);
      return;
    }

    this.cancelHold();
    this.commit(state, savedAt);
  }

  /** 相对时间会随时间走，"刚刚"该变成"3 分钟前" —— 定时调它来推进显示。 */
  refresh(): void {
    if (this.disposed) return;
    this.commit(this.lastState, this.lastSavedAt);
  }

  dispose(): void {
    this.disposed = true;
    this.cancelHold();
  }

  private cancelHold(): void {
    if (this.holdTimer !== null) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
    this.holding = false;
  }

  private commit(state: SaveState, savedAt: string | null): void {
    const next = describeSaveState(state, savedAt);
    const prev = describeSaveState(this.lastState, this.lastSavedAt);
    this.lastState = state;
    this.lastSavedAt = savedAt;
    if (sameView(prev, next)) return;
    this.emit(next);
  }
}

function sameView(a: SaveStatusView, b: SaveStatusView): boolean {
  return (
    a.label === b.label &&
    a.tone === b.tone &&
    a.busy === b.busy &&
    a.actionable === b.actionable &&
    a.hint === b.hint
  );
}
