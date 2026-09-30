/**
 * 外发记录面板（`docs/11` §6.7 的「外发记录」）。
 *
 * ## 落在工作台内，不是设置页（D-10）
 *
 * §6.7 原设计把外发记录表放在设置页的隐私控制面板里。落地时发现一个数据现实：
 * `runs.jsonl` 是**按作品**存的，`GET /ai/runs` 必须带 `workId` —— 而设置面板是全局的，
 * 没有"当前作品"这个概念。要支持"设置页常驻的跨作品记录"，sidecar 得新开一个
 * 跨作品聚合端点（扫 recent works 的 runs.jsonl），那是另一条链路。
 *
 * 所以本轮把逐条记录落在**工作台内**（有 `workId`，数据链路 `listAiRuns` 已就绪），
 * 设置页的隐私分区先只保留纯本地模式开关与文案。跨作品聚合留到后续。
 *
 * ## 为什么是"点击展开"而不是常驻一栏
 *
 * 外发记录是"偶尔看一眼"的审计需求，不是写作时的常驻信息。常驻一栏会永久占用
 * 编辑器上方本就紧张的空间（那里还有候选条、保存状态、告警）。折中：一个
 * 轻量入口（「外发记录」按钮 + 当日用量一句话），点开才拉全表。
 */

import { useCallback, useState } from 'react';
import type { AiRun, AiUsageSummary } from '@inkstone/shared';

import { ApiClient, describeApiError } from '../../lib/api';
import { downloadText, runsToCsv, runsToJson } from './egress-export';
import { costText } from './gen-state';
import './ai-panel.css';

interface EgressPanelProps {
  client: ApiClient | null;
  workId: string | null;
}

export function EgressPanel({ client, workId }: EgressPanelProps) {
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState<AiRun[] | null>(null);
  const [usage, setUsage] = useState<AiUsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const toggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      // 展开时拉一次：直接在 setState 回调里判断，避免"展开后 effect 里再拉"的
      // 级联渲染（`react-hooks/set-state-in-effect`）。作品变了重拉由 `workId`
      // 进 `load` 的依赖自然触发。
      if (next && client !== null && workId !== null) {
        setLoading(true);
        setError(null);
        void client
          .listAiRuns(workId)
          .then((res) => {
            setRuns(res.items);
            setUsage(res.usage);
          })
          .catch((err: unknown) => setError(describeApiError(err)))
          .finally(() => setLoading(false));
      }
      return next;
    });
  }, [client, workId]);

  const exportJson = useCallback(() => {
    if (runs !== null) downloadText('外发记录.json', runsToJson(runs), 'application/json');
  }, [runs]);

  const exportCsv = useCallback(() => {
    if (runs !== null) downloadText('外发记录.csv', runsToCsv(runs), 'text/csv;charset=utf-8');
  }, [runs]);

  return (
    <div className="egress-panel">
      <button type="button" className="linkish" onClick={toggle}>
        外发记录{open ? ' ▲' : ' ▼'}
      </button>
      {usage === null ? null : (
        <span className="hint">
          今日 {usage.runs} 次 · {usage.egressChars} 字 · {costText(usage.spentCny)}
          {usage.exceeded ? '（已达上限）' : ''}
        </span>
      )}

      {open ? (
        <div className="egress-body">
          {loading ? (
            <span className="spinner" />
          ) : error !== null ? (
            <p className="inline-error">{error}</p>
          ) : runs === null || runs.length === 0 ? (
            <p className="hint">这个作品还没有外发记录。</p>
          ) : (
            <>
              <div className="egress-actions">
                <button type="button" onClick={exportJson}>
                  导出 JSON
                </button>
                <button type="button" onClick={exportCsv}>
                  导出 CSV
                </button>
              </div>
              <table className="egress-table">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>任务</th>
                    <th>提供方</th>
                    <th>模型</th>
                    <th>外发字符</th>
                    <th>成本</th>
                    <th>采纳</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => (
                    <tr key={run.id}>
                      <td>{run.at}</td>
                      <td>{run.taskType}</td>
                      <td>{run.providerId}</td>
                      <td>{run.model}</td>
                      <td>{run.egressChars}</td>
                      <td>{costText(run.costCny)}</td>
                      <td>{run.accepted ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
