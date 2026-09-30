/**
 * 快捷生成面板（`docs/11` §6.3）。
 *
 * ## 与候选条（`AiCandidatePanel`）的分工
 *
 * 候选条挂在编辑器**上方**，管"续写的流式预览 + 接受/不要"；
 * 这个面板是**模态浮层**，管"快捷生成的候选列表 + 点选插入"。
 * 两者不合并：候选条是无阻塞的窄带（流式时用户在正文里继续写），
 * 快捷面板要独占注意力 —— 用户进来就是"挑一个"，不让他挑完之前分心去改正文，
 * 反而更顺（§6.3 把快捷生成定位成"手不离开键盘"的快速操作，不是长驻 UI）。
 *
 * ## 逐行型点选插入、段落型整段插入
 *
 * `parseQuickCandidates` 已经把 `shape` 分好：`line` 是"点一行插一行"，
 * `block` 是"整段作为一个候选"。这里照 shape 渲染，不在这里再猜一次。
 */

import { AI_QUICK_KINDS, AI_QUICK_LABEL, type AiQuickKind } from '@inkstone/shared';

import type { QuickSnapshot } from './use-ai-quick';
import { costText, durationText } from './gen-state';
import './ai-panel.css';

export interface QuickGenPanelProps {
  snapshot: QuickSnapshot;
  onStop: () => void;
  onInsert: (item: string) => void;
  onClose: () => void;
  /** 换一种 kind（关闭本面板、打开另一种）。可选。 */
  onSwitchKind?: (kind: AiQuickKind) => void;
}

export function QuickGenPanel({
  snapshot,
  onStop,
  onInsert,
  onClose,
  onSwitchKind,
}: QuickGenPanelProps) {
  if (snapshot.phase === 'idle') return null;

  return (
    <div className="quick-backdrop" role="dialog" aria-modal="true" aria-label="快捷生成">
      <div className="quick-panel">
        <header className="quick-head">
          <h3>{snapshot.kind === null ? '快捷生成' : AI_QUICK_LABEL[snapshot.kind]}</h3>
          <button type="button" className="linkish" onClick={onClose}>
            关闭
          </button>
        </header>

        {snapshot.phase === 'running' ? (
          <div className="quick-body quick-running">
            <span className="spinner" />
            <span className="hint">
              {snapshot.firstTokenMs === null
                ? '等待第一个字……'
                : `已收到第一个字（${durationText(snapshot.firstTokenMs)}），正在生成……`}
            </span>
            <button type="button" onClick={onStop}>
              停止
            </button>
          </div>
        ) : snapshot.phase === 'error' ? (
          <div className="quick-body quick-error">
            <p className="inline-error">{snapshot.failure?.message ?? '生成失败。'}</p>
            {snapshot.egressChars > 0 ? (
              <p className="hint">这次尝试已外发 {snapshot.egressChars} 字。</p>
            ) : null}
          </div>
        ) : (
          <QuickResults snapshot={snapshot} onInsert={onInsert} onSwitchKind={onSwitchKind} />
        )}

        {snapshot.phase === 'ready' && snapshot.costCny !== null ? (
          <footer className="quick-foot">
            <span className="hint">
              {snapshot.model || '模型'} · {costText(snapshot.costCny)}
            </span>
          </footer>
        ) : null}
      </div>
    </div>
  );
}

function QuickResults({
  snapshot,
  onInsert,
  onSwitchKind,
}: {
  snapshot: QuickSnapshot;
  onInsert: (item: string) => void;
  onSwitchKind?: (kind: AiQuickKind) => void;
}) {
  const candidates = snapshot.candidates;
  if (candidates === null || candidates.items.length === 0) {
    return (
      <div className="quick-body">
        <p className="hint">模型没有返回任何内容，可以关闭后重试。</p>
      </div>
    );
  }

  if (candidates.shape === 'block') {
    const text = candidates.items[0] ?? '';
    return (
      <div className="quick-body">
        <pre className="quick-block">{text}</pre>
        <div className="quick-actions">
          <button type="button" className="primary" onClick={() => onInsert(text)}>
            插入到光标处
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="quick-body">
      <ol className="quick-list">
        {candidates.items.map((item, index) => (
          <li key={`${item}-${index}`}>
            {/* 点整行插入，比"行 + 小按钮"命中面积大、更接近"挑一个"的直觉 */}
            <button type="button" className="quick-item" onClick={() => onInsert(item)}>
              {item}
            </button>
          </li>
        ))}
      </ol>
      {onSwitchKind === undefined ? null : (
        <div className="quick-actions">
          {AI_QUICK_KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              onClick={() => onSwitchKind(kind)}
              disabled={kind === snapshot.kind}
            >
              {AI_QUICK_LABEL[kind]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
