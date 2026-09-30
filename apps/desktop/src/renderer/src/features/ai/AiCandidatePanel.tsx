/**
 * 候选条（`docs/11` §6.1 / §6.4 / §6.5）。
 *
 * ## 为什么不用模态框
 *
 * §6.5 明说失败提示"**不弹模态框**"。生成是件高频、随时可能失败的事
 * （断网、额度用完、模型抽风），每失败一次就挡住整个编辑器，会让人不敢再用它。
 * 所以候选与错误都落在同一条窄带上：它出现时光标还在正文里，用户可以先继续写。
 *
 * ## 这一条**不显示候选全文**
 *
 * 全文在光标处的幽灵文本里（那是用户真正在看的位置）。把它再抄一份到面板上，
 * 面板就变成了第二个渲染源 —— 而流式时它每帧都要重渲染（`gen-state.ts` 文件头有理由）。
 */

import type { GenSnapshot } from './gen-state';
import { candidateMetaLine, costText, durationText, lengthNotice } from './gen-state';
import './ai-panel.css';

export interface AiCandidatePanelProps {
  snapshot: GenSnapshot;
  onStop: () => void;
  onAccept: () => void;
  onDiscard: () => void;
  onRetry: () => void;
}

export function AiCandidatePanel({
  snapshot,
  onStop,
  onAccept,
  onDiscard,
  onRetry,
}: AiCandidatePanelProps) {
  if (snapshot.phase === 'idle') return null;

  if (snapshot.phase === 'error') {
    return (
      <div className="ai-panel ai-panel-error" role="alert">
        <div className="ai-panel-main">
          <strong className="ai-panel-title">生成失败</strong>
          <span className="ai-panel-detail">{snapshot.failure?.message ?? '未知原因。'}</span>
          {snapshot.egressChars > 0 ? (
            // 失败前那一次**确实把内容发出去了**（审计口径见 `ai/runs.py`）。
            // 不说出来，用户会以为"失败了就等于什么都没发"
            <span className="ai-panel-hint">这次尝试已外发 {snapshot.egressChars} 字。</span>
          ) : null}
        </div>
        <div className="ai-panel-actions">
          <button type="button" className="primary" onClick={onRetry}>
            重试
          </button>
          <button type="button" onClick={onDiscard}>
            关闭
          </button>
        </div>
      </div>
    );
  }

  if (snapshot.running) {
    return (
      <div className="ai-panel ai-panel-running">
        <div className="ai-panel-main">
          <span className="spinner" />
          <strong className="ai-panel-title">{snapshot.model || '正在生成'}……</strong>
          <span className="ai-panel-detail">
            {/* 首字延迟是"模型到底动没动"的唯一线索：没有它，用户只能盯着一个转圈 */}
            {snapshot.firstTokenMs === null
              ? '等待第一个字……'
              : `已收到第一个字（${durationText(snapshot.firstTokenMs)}）`}
          </span>
        </div>
        <div className="ai-panel-actions">
          <button type="button" onClick={onStop}>
            停止
          </button>
        </div>
      </div>
    );
  }

  const length = lengthNotice(snapshot);
  return (
    <div className="ai-panel ai-panel-ready">
      <div className="ai-panel-main">
        <span className="ai-panel-title">已生成 {snapshot.chars} 字，在光标处预览</span>
        <span className="ai-panel-detail">{candidateMetaLine(snapshot)}</span>
        {snapshot.dropsText === null ? null : (
          <span className="ai-panel-hint">{snapshot.dropsText}</span>
        )}
        {length === null ? null : <span className="ai-panel-hint">{length}</span>}
        {snapshot.budget === null ? null : (
          <span className="ai-panel-hint">
            本次上下文 {snapshot.budget.used} / {snapshot.budget.budget} token · 外发{' '}
            {snapshot.egressChars} 字 · {costText(snapshot.costCny)}
          </span>
        )}
      </div>
      <div className="ai-panel-actions">
        <button type="button" className="primary" onClick={onAccept}>
          接受
        </button>
        <button type="button" onClick={onDiscard}>
          不要
        </button>
      </div>
    </div>
  );
}
