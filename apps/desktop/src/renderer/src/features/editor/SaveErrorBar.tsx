export interface SaveErrorBarProps {
  message: string;
  canRetry: boolean;
  onRetry: () => void;
}

/**
 * 保存失败的顶部条（`06` §5）。
 *
 * 文案的第一句必须是**"内容仍在编辑器里"** —— 保存失败时用户的第一反应是恐慌，
 * 而事实是他一个字都没丢（内容在 ProseMirror 文档里，只是在磁盘上还没有）。
 * 把这句话放在原因前面，而不是后面：他读前五个字就该安心。
 *
 * 401 时不给「重试」按钮（`canRetry === false`）：那种情况重试一万次还是 401。
 */
export function SaveErrorBar({ message, canRetry, onRetry }: SaveErrorBarProps) {
  return (
    <div className="save-error-bar" role="alert">
      <span className="save-error-mark" aria-hidden="true" />
      <span className="save-error-text">
        <strong>保存失败，内容仍在编辑器里。</strong> {message}
      </span>
      {canRetry ? (
        <button type="button" onClick={onRetry}>
          重试
        </button>
      ) : null}
    </div>
  );
}
