/**
 * 大纲正文编辑器（docs/15 B4）—— 一个受控的 Markdown textarea + 保存按钮。
 *
 * P0 不上 TipTap：章纲/总纲/卷纲是低频的结构化草稿，不是正文，不该背一套
 * 幽灵文本/斜杠指令的工程（docs/15 §3.2）。纯 textarea 就够，还能直接贴 Markdown。
 *
 * 数据流：`value` 只作**初始正文**（挂载时初始化一次），之后由本地 state 持有，
 * `onChange` 回传变化；「保存」时调 `onSave(body, hash)`，成功后父级回填新 hash。
 * **父级切换编辑对象时用 `key` 重挂载本组件**，避免"渲染期同步 state"的派生复杂化。
 * 保存失败的错误由本组件就近展示（响亮点，别让用户以为保存了）。
 */

import { useCallback, useState } from 'react';
import { describeApiError } from '../../lib/api';

interface Props {
  /** 初始正文（仅挂载时读一次）。 */
  value: string;
  /** 初始 hash（ifMatch 用）。空串 = 尚未创建。 */
  hash: string;
  placeholder: string;
  /** 保存回调（异步）。成功回填新 hash 由父级负责。 */
  onSave: (body: string, ifMatch: string) => Promise<void>;
}

export function OutlineEditor({ value, hash, placeholder, onSave }: Props) {
  const [body, setBody] = useState(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await onSave(body, hash);
    } catch (err) {
      setError(describeApiError(err));
    } finally {
      setBusy(false);
    }
  }, [body, hash, onSave]);

  const dirty = body !== value;

  return (
    <div className="outline-editor">
      {error === null ? null : (
        <div className="outline-error" role="alert">
          {error}
        </div>
      )}
      <textarea
        className="outline-editor-text"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={placeholder}
      />
      <div className="outline-editor-bar">
        <span className="outline-dirty">{dirty ? '有未保存修改' : ''}</span>
        <button
          type="button"
          className="outline-save"
          disabled={busy || !dirty}
          onClick={() => void submit()}
        >
          {busy ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  );
}
