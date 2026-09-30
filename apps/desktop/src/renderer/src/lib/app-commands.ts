/**
 * 菜单命令在渲染侧的转发层（`09` §4.4）。
 *
 * ## 为什么不直接在根组件里 if/else
 *
 * 命令的宿主分散在不同组件里：「新建作品」只有入口页有表单，「撤销」只有 `WorkShell`
 * 拿得到编辑器句柄。把命令**广播**出去、各自认领自己那条，比在根组件里攒一堆 ref
 * 再分派清楚得多 —— 而且新增一种屏幕（比如将来的设置页）不用改根组件。
 */

import type { AppCommand } from '@inkstone/shared';

type CommandHandler = (command: AppCommand) => void;

const handlers = new Set<CommandHandler>();

export function subscribeAppCommand(handler: CommandHandler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

export function emitAppCommand(command: AppCommand): void {
  // 复制一份再遍历：处理函数里可能顺手取消订阅（比如它触发了离开当前屏幕）
  for (const handler of [...handlers]) handler(command);
}

/** 「回到入口页之后要做什么」 */
export type EntryIntent = 'new' | 'open';

/**
 * 菜单里的「新建作品 / 打开作品」在**作品内**触发时，要先离开当前作品才到得了入口页。
 * 而离开是一次状态迁移 —— 入口页在那一刻还不存在，没法直接调它的函数。
 *
 * 所以意图先记在这里，由入口页挂载时取走。用单槽而不是队列：这是"用户接下来想干什么"，
 * 只有最后一个意图有意义，攒起来反而会让用户连点两次菜单后打开两个目录对话框。
 */
let pendingEntryIntent: EntryIntent | null = null;

export function setPendingEntryIntent(intent: EntryIntent): void {
  pendingEntryIntent = intent;
}

/** 取走并清空。返回 `null` 表示没有待办意图。 */
export function takePendingEntryIntent(): EntryIntent | null {
  const intent = pendingEntryIntent;
  pendingEntryIntent = null;
  return intent;
}
