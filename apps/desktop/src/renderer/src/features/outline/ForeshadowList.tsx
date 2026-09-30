/**
 * 伏笔清单（docs/15 B4）—— 只读的扫描聚合结果 + 超期/孤儿提醒。
 *
 * 数据来自 `GET /foreshadows`（sidecar 现算，见 use-outline 的 foreshadows）。
 * 这里是**纯展示**：不做登记/编辑（登记在章纲编辑视图里做），只把 sidecar
 * 算好的 `overdue` / `orphan` 翻译成醒目的提醒卡。超期/孤儿判定不在前端重复
 * 实现（见 outline-model.ts 文件头注释）。
 */

import type { ForeshadowItem } from '@inkstone/shared';
import {
  FORESHADOW_STATUS_LABELS,
  expectResolveByText,
  foreshadowBadge,
  foreshadowHint,
  isForeshadowAttention,
} from './outline-model';

interface Props {
  items: ForeshadowItem[];
}

export function ForeshadowList({ items }: Props) {
  const attention = items.filter(isForeshadowAttention);

  return (
    <div className="foreshadow-list">
      {attention.length > 0 ? (
        <div className="foreshadow-alert" role="alert">
          <strong>{attention.length} 条伏笔需要留意</strong>
          <ul>
            {attention.map((item) => (
              <li key={item.id}>{item.title}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {items.length === 0 ? (
        <div className="outline-empty">还没有登记伏笔。在某一章的纲里登记后，这里会汇总。</div>
      ) : (
        <ul className="foreshadow-items">
          {items.map((item) => (
            <li key={item.id} className="foreshadow-item">
              <div className="foreshadow-row">
                <span className="foreshadow-title">{item.title}</span>
                {foreshadowBadge(item) === null ? null : (
                  <span className="foreshadow-badge">{foreshadowBadge(item)}</span>
                )}
              </div>
              <div className="foreshadow-meta">
                {FORESHADOW_STATUS_LABELS[item.status]} ·{' '}
                {expectResolveByText(item.expectResolveBy)}
                {item.resolvedIn !== null ? ` · 回收于 ${item.resolvedIn}` : ''}
              </div>
              {foreshadowHint(item) === null ? null : (
                <div className="foreshadow-hint">{foreshadowHint(item)}</div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
