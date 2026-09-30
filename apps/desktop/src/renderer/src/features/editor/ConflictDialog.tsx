import { useState } from 'react';
import { countWords, type ExternalModifiedDetail } from '@inkstone/shared';
import { describeApiError } from '../../lib/api';
import {
  CONFLICT_CHOICE_TEXT,
  availableChoices,
  previewMarkdown,
  type ConflictChoice,
} from './conflict-actions';
import { formatSavedAt } from './save-status';

export interface ConflictDialogProps {
  /** 服务端 409 的 detail；信封形状不对时为 null（此时不给「覆盖」） */
  detail: ExternalModifiedDetail | null;
  /** 「你的版本」的快照（冲突发生那一刻的内容） */
  mine: string;
  /**
   * 关掉对话框继续写。
   *
   * 刻意留这个出口：`06` §8 要求"对话框弹出后编辑器仍可编辑"，
   * 而全屏遮罩不放行就等于把编辑锁死。冲突不解决并不会丢字（内容还在编辑器里，
   * 只是不再自动写盘），所以"先写一会儿再处理"是合法选择 ——
   * 状态指示会一直停在「文件被外部修改」，点它就能回到这里。
   */
  onDismiss: () => void;
  /** 失败会抛；本组件就地显示错误并**保持三选一界面不关**（§8） */
  onChoose: (choice: ConflictChoice) => Promise<void>;
}

/** 预览截断长度。两栏并列，各 400 字已经够判断"这是不是我要的那一版"。 */
const PREVIEW_LIMIT = 400;

/**
 * 冲突三选一（`06` §6）。
 *
 * M0 刻意**不做行级 diff**：两版并排 + 前 400 字预览能覆盖 90% 的判断需求，
 * 而行级高亮只有配合版本功能才有价值（`03` §11）。
 */
export function ConflictDialog({ detail, mine, onDismiss, onChoose }: ConflictDialogProps) {
  const [busy, setBusy] = useState<ConflictChoice | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const choices = availableChoices(detail);
  const mineCount = countWords(mine).withoutPunct;
  const diskMarkdown = detail?.diskMarkdown ?? '';
  const diskCount = detail === null ? null : countWords(diskMarkdown).withoutPunct;

  const handleChoose = async (choice: ConflictChoice): Promise<void> => {
    setBusy(choice);
    setFailure(null);
    try {
      await onChoose(choice);
    } catch (err) {
      // 就地报错，**不关闭**对话框：关掉的话用户既没解决问题，也看不到发生了什么。
      setFailure(describeApiError(err));
      setBusy(null);
    }
    // 成功时父组件会把 conflict 清掉，本组件随之卸载，不在这里收尾。
  };

  return (
    <div className="modal-backdrop">
      <div
        className="modal conflict-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="conflict-title"
      >
        <div className="conflict-head">
          <h2 id="conflict-title">文件被外部修改</h2>
          <button type="button" className="linkish" onClick={onDismiss}>
            稍后处理
          </button>
        </div>
        <p className="hint">
          磁盘上的这一章不是应用最后写入的版本（可能被编辑器、同步工具或另一台机器改过）。
          为避免覆盖别人的内容，自动保存已经停下 —— 你的内容还在，请选择怎么处理。
        </p>

        <div className="conflict-columns">
          <section className="conflict-column">
            <h3>你的版本</h3>
            <p className="hint">{formatCount(mineCount)} 字 · 未写入磁盘</p>
            <pre className="conflict-preview">{previewMarkdown(mine, PREVIEW_LIMIT)}</pre>
          </section>
          <section className="conflict-column">
            <h3>磁盘上的版本</h3>
            <p className="hint">
              {diskSavedAtText(detail)} ·{' '}
              {diskCount === null ? '字数未知' : `${formatCount(diskCount)} 字`}
            </p>
            <pre className="conflict-preview">
              {detail === null
                ? '（未能读取磁盘版本内容，只能选择重新载入）'
                : previewMarkdown(diskMarkdown, PREVIEW_LIMIT)}
            </pre>
          </section>
        </div>

        {failure === null ? null : <p className="inline-error">处理失败：{failure}</p>}

        <div className="actions">
          {choices.map((choice) => (
            <button
              key={choice}
              type="button"
              disabled={busy !== null}
              onClick={() => void handleChoose(choice)}
            >
              {busy === choice ? '处理中……' : CONFLICT_CHOICE_TEXT[choice].label}
            </button>
          ))}
        </div>

        <ul className="conflict-notes">
          {choices.map((choice) => (
            <li key={choice}>
              <strong>{CONFLICT_CHOICE_TEXT[choice].label}</strong>
              <span>：{CONFLICT_CHOICE_TEXT[choice].hint}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function diskSavedAtText(detail: ExternalModifiedDetail | null): string {
  if (detail === null) return '时间未知';
  const relative = formatSavedAt(detail.diskSavedAt);
  if (relative === '') return detail.diskSavedAt === null ? '时间未知' : detail.diskSavedAt;
  return `磁盘写入于 ${relative}`;
}

/** 与 `WordCountBar` 同口径的千分位。刻意重复三行也不抽公共模块：抽了反而多一处要维护的抽象。 */
function formatCount(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
