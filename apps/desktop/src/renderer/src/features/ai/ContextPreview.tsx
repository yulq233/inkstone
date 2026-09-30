/**
 * 「将发送什么」的展示体（`docs/11` §6.4 / §6.7）。
 *
 * ## 一份组件、两处复用
 *
 * §6.7 要求预览"与 §6.4 同一份组件"。这里兑现的方式是：**确认卡**（`EgressConfirmDialog`）
 * 与**工作台里的常驻预览入口**（`PreviewPanel`）都渲染这一个组件 ——
 * 两处各写一遍的后果是"首次确认时看到的"与"事后想回看时看到的"不是同一份东西，
 * 而用户正是拿后者去核对前者的。
 *
 * ## 为什么用原生 `<details>` 而不是自己管展开状态
 *
 * 这里最多有 2 + N 个可展开块（系统指令 / 原文 / 每个分块）。自己管就要一组
 * `Set<string>` 状态 + 每个块一个回调，而它带来的能力（同时展开多个）原生
 * `<details>` 本来就有。另外原生元素自带键盘与无障碍语义，等于白拿。
 *
 * ## 展开项默认全关（除系统指令）
 *
 * 预览的全部价值是"用户真的看了"。默认全展开会把确认卡撑成一屏半的正文，
 * 用户只会直接滚到底按「继续」—— 那等于没看。所以只默认展开**系统指令**
 * （它最容易被忽略、却包含风格卡与本次约束），其余按需展开。
 */

import type { AiPreviewResponse } from '@inkstone/shared';

import {
  dropReasonText,
  orderPreviewBlocks,
  previewStats,
  previewSummary,
  slotLabel,
} from './context-preview';
import './ai-panel.css';

interface ContextPreviewProps {
  preview: AiPreviewResponse;
}

export function ContextPreview({ preview }: ContextPreviewProps) {
  const stats = previewStats(preview);
  const blocks = orderPreviewBlocks(preview.blocks);

  return (
    <div className="ctx-preview">
      <p className="ctx-summary">{previewSummary(preview)}</p>
      <p>
        {/* 三态而不是两态：被纯本地模式拦下时那份"不会发出"的摘要，配一个「会发往云端」的
            徽标会自相矛盾 —— 而这张卡的唯一用途就是让用户相信眼前这一份 */}
        <span
          className={preview.local || preview.offlineBlocked ? 'ai-badge ai-badge-ok' : 'ai-badge'}
        >
          {preview.local
            ? '本机模型 · 不外传'
            : preview.offlineBlocked
              ? '纯本地模式 · 不会发出'
              : '会发往云端'}
        </span>
      </p>

      {/*
        `open` 是**初始值**，不是受控属性：React DOM 只在 prop 值**变化**时才写 DOM，
        所以用户手动收起之后，后续重渲染不会把它顶回展开。写成 state 反而是多余的
        —— 那块内容没有"需要被程序改开合"的场景。
      */}
      <details className="ctx-block" open>
        <summary>
          系统指令<span className="hint">（含风格卡与本次约束）</span>
        </summary>
        {/* `pre` 而不是普通段落：原文里的换行与缩进是**要发出去的样子**的一部分，
            重排之后用户看到的就不是它实际收到的了 */}
        <pre className="ctx-text">{preview.system}</pre>
      </details>

      <details className="ctx-block">
        <summary>
          将发送的正文与设定<span className="hint">（模型收到的原文）</span>
        </summary>
        <pre className="ctx-text">{preview.user}</pre>
      </details>

      <details className="ctx-block">
        <summary>
          分块明细<span className="hint">（{blocks.length} 块，按模型看到的顺序）</span>
        </summary>
        <ul className="ctx-blocks">
          {blocks.map((block, index) => (
            <li key={`${block.slot}-${index}`}>
              <details>
                <summary>
                  <span className="ctx-slot">{slotLabel(block.slot, block.title)}</span>
                  <span className="hint">
                    {block.source} · {block.tokens} token
                    {block.truncated ? ' · 已按预算截断' : ''}
                  </span>
                </summary>
                <pre className="ctx-text">{block.text}</pre>
              </details>
            </li>
          ))}
        </ul>
      </details>

      {/* 被丢掉的部分单独一块：它**不会**发出去，所以不能混在"将要发送"里，
          但它必须可见 —— 用户问"它为什么写得不对"时，答案常常在这里（§3.5） */}
      {preview.dropped.length === 0 ? null : (
        <details className="ctx-block">
          <summary>
            不会发送的部分<span className="hint">（{preview.dropped.length} 块，被预算丢掉）</span>
          </summary>
          <ul className="ctx-blocks">
            {preview.dropped.map((drop, index) => (
              <li key={`${drop.source}-${index}`}>
                <span className="ctx-slot">{drop.title}</span>
                <span className="hint">
                  {drop.source} · {drop.tokens} token · {dropReasonText(drop.reason)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <p className="hint">
        上下文占用 {stats.usedTokens} / {stats.budgetTokens} token · 外发 {stats.egressChars} 字
        {stats.truncatedBlocks === 0 ? '' : ` · ${stats.truncatedBlocks} 块被截断`}
      </p>
    </div>
  );
}
