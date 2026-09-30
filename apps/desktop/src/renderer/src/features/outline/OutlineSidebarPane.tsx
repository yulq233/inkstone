/**
 * 大纲侧栏 pane（docs/15 B4）。
 *
 * 单独一个组件而不是在 WorkShell 里直接调 `useOutline`，是为了让**切作品**能靠
 * `key={workId}` 重挂载来重置大纲的全部状态（总纲/卷纲/章纲/伏笔）——
 * 而不是在 effect 里手动 setState 清空。与 CodexSidebarPane 同一个理由。
 *
 * 与设定 pane 的一个差异：大纲还要**当前章**（章纲跟当前章走），所以这里多收一个
 * `chapterId`。切章**不**重挂载（key 只看 workId），章纲跟随靠 use-outline 内部的
 * `loadChapter` effect。
 */

import type { ApiClient } from '../../lib/api';
import { OutlinePanel } from './OutlinePanel';
import { useOutline } from './use-outline';

interface Props {
  client: ApiClient | null;
  workId: string | null;
  chapterId: string | null;
}

export function OutlineSidebarPane({ client, workId, chapterId }: Props) {
  const outline = useOutline({ client, workId, chapterId });
  return <OutlinePanel outline={outline} chapterId={chapterId} />;
}
