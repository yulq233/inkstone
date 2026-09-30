/**
 * 首次把内容发往某个非本机供应商时的确认卡（`docs/11` §2.3）。
 *
 * ## 为什么这张卡不能被任何开关绕过
 *
 * §2.3 把它写成一条**知情要求**：AI 让"正文片段离开本机"从"可选"（M2 的云端 embedding）
 * 变成"每次生成都发生"，所以第一次必须明确说一次。因此：
 *
 * - 它**不看** `confirmContextPreview`（那个开关管的是"之后每次要不要都预览"，
 *   而那个语义本轮没接线，见 `docs/11` §7.3.3 的 D-12）；
 * - 「取消」**不写**确认记录 —— 拒绝过的东西不该在下次悄悄放过；
 * - 本机模型（Ollama）走不到这里（`needsConfirm` 为假），列表里另标「本机模型·不外传」。
 *
 * ## 卡片上必须有的三件事
 *
 * 1. **去哪家、打哪个地址、用哪个模型** —— `providerBaseUrl` 是用户可改的，
 *    只报 label 答不了"到底去了哪里"；
 * 2. **真实 payload**（`ContextPreview`）—— "可展开看真实 payload"不是修饰语，
 *    它是用户唯一能核对"我的哪一段文字要出门"的东西；
 * 3. **一句可撤销的承诺** —— 告诉他这个确认是记下来的、能在设置里撤回，
 *    否则按「继续」像是在签一份无法反悔的东西。
 */

import { useEffect } from 'react';

import { ContextPreview } from './ContextPreview';
import type { EgressGateSlot } from './use-egress-gate';
import './ai-panel.css';

interface EgressConfirmDialogProps {
  slot: EgressGateSlot;
  onConfirm: () => void;
  onCancel: () => void;
}

export function EgressConfirmDialog({ slot, onConfirm, onCancel }: EgressConfirmDialogProps) {
  const { preview } = slot;

  // Esc = 取消。挂在 window 上而不是对话框上：卡片里到处是可展开的 `<details>`，
  // 挂在元素上就得先保证焦点在卡片内（还得为此写焦点陷阱）。
  // 与 `SettingsPanel` 的 Esc 处理同一写法。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  return (
    <div className="modal-backdrop">
      <div
        className="modal egress-confirm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="egress-confirm-title"
      >
        <div className="row modal-head">
          <h2 id="egress-confirm-title">首次把正文发给「{preview.providerLabel}」</h2>
          {/* 与 `NewWorkDialog` 同款：出口是一个明确动作，不做点遮罩关闭。
              这里与它不同的是**保留 Esc** —— 那张卡里没有任何"填了一半的东西"
              可以被误触清空，而"按 Esc 关掉一个对话框"是用户的默认预期。 */}
          <button type="button" onClick={onCancel}>
            取消
          </button>
        </div>

        <p>
          接下来这一次生成会把下面这些内容发送到 <strong>{preview.providerBaseUrl}</strong>，它们
          <strong>会离开这台电脑</strong>。请先确认你接受这一点。
        </p>
        <p className="hint">
          只会问这一次。之后想撤回，可以在「设置 → AI 模型 → 已确认外发的供应商」里取消确认。
        </p>

        <ContextPreview preview={preview} />

        <div className="actions">
          <button type="button" className="primary" onClick={onConfirm}>
            我了解了，继续
          </button>
        </div>
      </div>
    </div>
  );
}
