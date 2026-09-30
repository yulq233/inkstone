import { useMemo, useState } from 'react';
import type { AdapterWarning } from '@inkstone/md-adapter';
import { describeWarning, summarizeWarnings } from './warning-text';

/** 明细一次最多渲染多少条：几百条会把界面卡住，而用户也不会真的逐条读。 */
const MAX_DETAILS = 50;

interface AdapterWarningsBarProps {
  warnings: AdapterWarning[];
  /** 用于从原文切片（片段的偏移是相对**载入的那份 markdown**） */
  markdown: string;
}

/**
 * 降级告警条（`03` §5.8、`05` §7）。
 *
 * 刻意**不用 toast**：这条信息的性质是"你稿子里有一段东西没能完整显示"，
 * 三秒后消失等于让用户遗忘。所以它是一条常驻横幅，可折叠但不可忽略，
 * 且只在下次 `setMarkdown` 时重算 —— 不做"编辑后自动消失"（那是在骗人）。
 */
export function AdapterWarningsBar({ warnings, markdown }: AdapterWarningsBarProps) {
  const [expanded, setExpanded] = useState(false);

  const details = useMemo(
    () => warnings.slice(0, MAX_DETAILS).map((warning) => describeWarning(warning, markdown)),
    [warnings, markdown],
  );

  if (warnings.length === 0) return null;

  const hidden = warnings.length - details.length;

  return (
    <div className="adapter-warnings">
      <div className="adapter-warnings-head">
        <span className="adapter-warnings-text">{summarizeWarnings(warnings)}</span>
        <button type="button" className="linkish" onClick={() => setExpanded((prev) => !prev)}>
          {expanded ? '收起' : '查看'}
        </button>
      </div>
      {expanded ? (
        <ol className="adapter-warnings-list">
          {details.map((detail, index) => (
            <li key={`${index}-${detail.title}-${detail.excerpt}`}>
              <span>{detail.title}</span>
              {detail.excerpt === '' ? null : <code>{detail.excerpt}</code>}
            </li>
          ))}
          {hidden > 0 ? <li className="hint">还有 {hidden} 条未列出</li> : null}
        </ol>
      ) : null}
    </div>
  );
}
