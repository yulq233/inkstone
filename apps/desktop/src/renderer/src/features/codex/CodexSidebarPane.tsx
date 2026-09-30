/**
 * 设定侧栏 pane（docs/15 B3）。
 *
 * 单独一个组件而不是在 WorkShell 里直接调 `useCodex`，是为了让**切作品**能靠
 * `key={workId}` 重挂载来重置 codex 的全部状态（清单/详情/新建表单）——
 * 而不是在 effect 里手动 setState 清空（那是 react-hooks/set-state-in-effect
 * 的告警点，且容易漏清某个状态）。
 */

import type { ApiClient } from '../../lib/api';
import { CodexPanel } from './CodexPanel';
import { useCodex } from './use-codex';

interface Props {
  client: ApiClient | null;
  workId: string | null;
}

export function CodexSidebarPane({ client, workId }: Props) {
  const codex = useCodex({ client, workId });
  return <CodexPanel codex={codex} />;
}
