import { useEffect, useRef, useState } from 'react';
import type { SaveState } from '../../lib/autosave';
import { SaveStatusPresenter, describeSaveState, type SaveStatusView } from './save-status';

/** 相对时间会随时间走，"刚刚"该变成"3 分钟前"。半分钟推一次就够，不必更密。 */
const REFRESH_MS = 30_000;

export interface SaveStatusIndicatorProps {
  state: SaveState;
  savedAt: string | null;
  /** 只有 `conflict` 态会传（点击打开冲突对话框） */
  onClick?: () => void;
}

/**
 * 保存状态指示（`06` §5）。
 *
 * 永远可见，不隐藏 —— 它是用户对"我的稿子在不在"的唯一依据。
 * 六态到四种说法的映射全在 `save-status.ts` 里，这里只负责渲染，
 * 以及一处与渲染有关的规则：`dirty` 延迟 1 秒才显示（迟滞器负责）。
 */
export function SaveStatusIndicator({ state, savedAt, onClick }: SaveStatusIndicatorProps) {
  const [view, setView] = useState<SaveStatusView>(() => describeSaveState(state, savedAt));
  const presenterRef = useRef<SaveStatusPresenter | null>(null);

  useEffect(() => {
    // 初始值必须与上面的 useState 初值一致，否则首帧会闪一下再被 update 纠正。
    const presenter = new SaveStatusPresenter(setView, { state: 'idle', savedAt: null });
    presenterRef.current = presenter;
    const timer = setInterval(() => presenter.refresh(), REFRESH_MS);
    return () => {
      clearInterval(timer);
      presenter.dispose();
      presenterRef.current = null;
    };
  }, []);

  useEffect(() => {
    presenterRef.current?.update(state, savedAt);
  }, [state, savedAt]);

  const className = `save-status tone-${view.tone}${view.busy ? ' is-busy' : ''}`;
  const body = (
    <>
      {view.busy ? <span className="save-status-pulse" aria-hidden="true" /> : null}
      <span className="save-status-label">{view.label}</span>
      {view.hint === '' ? null : <span className="save-status-hint">{view.hint}</span>}
    </>
  );

  if (view.actionable) {
    return (
      <button
        type="button"
        className={className}
        onClick={onClick}
        title="查看冲突详情并选择处理方式"
      >
        {body}
      </button>
    );
  }

  return (
    <span className={className} role="status" aria-live="polite">
      {body}
    </span>
  );
}

export interface BackupNoticeProps {
  /** 磁盘旧版本的备份路径 */
  backupPath: string;
  onDismiss: () => void;
}

/**
 * 覆盖发生后的**一次性**提示（`06` §5）。
 *
 * 不常出现，但出现时用户需要知道去哪找 —— 否则"选了保留我的并覆盖"之后，
 * 磁盘上原来那一版就成了一笔没人知道去向的账。
 */
export function BackupNotice({ backupPath, onDismiss }: BackupNoticeProps) {
  return (
    <span className="backup-notice">
      <span className="backup-notice-text">
        磁盘上的旧版本已备份到 <code>{backupPath}</code>
      </span>
      <button type="button" className="linkish" onClick={onDismiss}>
        知道了
      </button>
    </span>
  );
}
