/**
 * 设定扩充候选面板（`docs/16` §3.2 / D-3）。
 *
 * ## 为什么另起一个组件，不复用 `AiCandidatePanel`
 *
 * `AiCandidatePanel` 是续写专用的：它的接受动作是"插到光标处"，而且**刻意不显示全文**
 * ——续写的全文在编辑器光标的幽灵文本里，抄一份到面板上就变成第二个渲染源，流式时
 * 每帧都要重渲染（`gen-state.ts` 文件头有完整理由）。
 *
 * expand 恰好相反：它的产物是"一段要写回设定文件的文本"，用户必须先通读再决定，
 * 所以**全文必须在这里显示**。这也是 `use-expand.ts` 要把全文节流写进 React state
 * 的原因。
 *
 * ## 不弹模态框
 *
 * 它挂在设定编辑页内、编辑表单上方，是一条**就地卡片**，不是 `QuickGenPanel` 那种
 * 独占注意力的浮层。理由：expand 的结果要被"塞进正在编辑的那张卡"，用户读候选时
 * 手边就是目标条目（summary / body 输入框），一眼能对照。
 */

import type { ExpandSnapshot } from './use-expand';
import { EXPAND_TARGET_LABELS } from './expand-model';
import { costText, durationText } from '../ai/gen-state';
import './codex.css';

export interface SettingCandidatePanelProps {
  snapshot: ExpandSnapshot;
  /** 流式全文（`use-expand` 节流更新）。 */
  text: string;
  /** 采纳中（写回设定的 PUT 在飞）时禁用按钮，避免连点产生并发写。 */
  busy?: boolean;
  onStop: () => void;
  onAccept: () => void;
  onDiscard: () => void;
}

export function SettingCandidatePanel({
  snapshot,
  text,
  busy = false,
  onStop,
  onAccept,
  onDiscard,
}: SettingCandidatePanelProps) {
  if (snapshot.phase === 'idle') return null;

  const targetLabel = snapshot.target === null ? '设定' : EXPAND_TARGET_LABELS[snapshot.target];

  return (
    <section className="codex-candidate" aria-live="polite">
      <header className="codex-candidate-head">
        <span className="codex-candidate-title">AI 生成{targetLabel}</span>
        {snapshot.model === '' ? null : (
          <span className="codex-candidate-model">{snapshot.model}</span>
        )}
      </header>

      {snapshot.phase === 'running' ? (
        <div className="codex-candidate-status">
          <span className="spinner" />
          <span className="hint">
            {snapshot.firstTokenMs === null
              ? '等待第一个字……'
              : `已收到第一个字（${durationText(snapshot.firstTokenMs)}），正在生成……`}
          </span>
        </div>
      ) : null}

      {snapshot.phase === 'error' ? (
        <div className="codex-candidate-error" role="alert">
          <span>{snapshot.failure?.message ?? '生成失败。'}</span>
          {snapshot.egressChars > 0 ? (
            // 失败前那一次**确实把内容发出去了**（审计口径见 `ai/runs.py`）。
            // 不说，用户会以为"失败了就等于什么都没发"。
            <span className="hint">这次尝试已外发 {snapshot.egressChars} 字。</span>
          ) : null}
        </div>
      ) : (
        // 运行中也把已收到的字显示出来：这不只是"进度"，用户能据此判断这次方向对不对
        // 而提前按停止 —— 比等它写完 3000 字再推翻省钱。
        <pre className="codex-candidate-text">{text === '' ? '……' : text}</pre>
      )}

      {snapshot.phase === 'ready' ? (
        <div className="codex-candidate-meta">
          <span className="hint">
            {snapshot.costCny === null ? '成本未知' : costText(snapshot.costCny)} · 外发{' '}
            {snapshot.egressChars} 字
          </span>
        </div>
      ) : null}

      <div className="codex-candidate-actions">
        {snapshot.phase === 'running' ? (
          <button type="button" onClick={onStop}>
            停止
          </button>
        ) : snapshot.phase === 'error' ? (
          <button type="button" onClick={onDiscard}>
            关闭
          </button>
        ) : (
          <>
            <button
              type="button"
              className="primary"
              disabled={busy || text.trim() === ''}
              onClick={onAccept}
            >
              {busy ? '写入中…' : '采纳'}
            </button>
            <button type="button" disabled={busy} onClick={onDiscard}>
              放弃
            </button>
          </>
        )}
      </div>
    </section>
  );
}
