/**
 * 设定侧栏 pane（docs/15 B3）。
 *
 * 单独一个组件而不是在 WorkShell 里直接调 `useCodex`，是为了让**切作品**能靠
 * `key={workId}` 重挂载来重置 codex 的全部状态（清单/详情/新建表单）——
 * 而不是在 effect 里手动 setState 清空（那是 react-hooks/set-state-in-effect
 * 的告警点，且容易漏清某个状态）。
 */

import type { ApiClient } from '../../lib/api';
import type { EgressGateCheck } from '../ai/use-egress-gate';
import { CodexPanel } from './CodexPanel';
import { useCodex } from './use-codex';

interface Props {
  client: ApiClient | null;
  workId: string | null;
  /**
   * 外发确认闸门（`docs/16` §3.3）。由 WorkShell 的 `useEgressGate` 提供并透传，
   * 而不是在这里新建一个 —— 闸门的"每家供应商只确认一次"名单必须与续写/快捷生成共用，
   * 各建一个会让同一家供应商被问好几遍。
   */
  checkEgress?: EgressGateCheck;
}

export function CodexSidebarPane({ client, workId, checkEgress }: Props) {
  const codex = useCodex({ client, workId });
  return <CodexPanel codex={codex} client={client} workId={workId} checkEgress={checkEgress} />;
}
