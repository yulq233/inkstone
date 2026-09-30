/**
 * AI 的编辑器内快捷键。
 *
 * ## 为什么不走主进程的全局快捷键
 *
 * 主进程的菜单命令（`lib/app-commands.ts`）是**全局**的：`Ctrl+C` 级别的组合键一旦注册，
 * 应用里每个输入框都会被它抢走。本项目已经因为这件事吃过一次亏 ——
 * `role: 'undo'` 自带 `CmdOrCtrl+Z`，结果在设置页的输入框里按 Ctrl+Z 触发的是编辑器的撤销。
 *
 * `Ctrl+Enter` 的语义是"**在这里**续写"（这里 = 光标处），它天然是编辑器作用域的事：
 * 没有编辑器就没有"这里"。
 *
 * ## 为什么不是 TipTap 的 `addKeyboardShortcuts` 扩展
 *
 * 那样写要造一个 `Extension`，而扩展集是 `useMemo` 出来的（TipTap 只按 deps 判断重建，
 * 重建的可见症状是"打字时焦点乱跳"）。回调一旦闭包进去，要么进 deps（每次渲染换一个
 * 回调就重建编辑器），要么经 ref 取 —— 而经 ref 取会被 `react-hooks/refs` 判成
 * "渲染期读 ref"（它看不出真正的调用发生在按键时）。
 *
 * 于是这里只留一个**纯判定函数**，由 `TipTapEditor` 在 effect 里挂到
 * `editorProps.handleKeyDown` 上 —— effect 里读 ref 是正当用法，而纯函数可以直接单测。
 *
 * `Mod` 的语义（macOS 上是 Cmd）在这里手动展开成 `ctrlKey || metaKey`：
 * 这个函数刻意不依赖 ProseMirror 的 keymap 工具，于是它连编辑器都不需要就能测。
 */

/** 只用到这几个字段 —— 于是测试里不必造一个真的 `KeyboardEvent`。 */
export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
}

export interface AiKeyHandlers {
  /** `Ctrl/Cmd + Enter`：在光标处续写。没传就**不接管**这个组合键。 */
  onContinue?: (() => void) | undefined;
}

/**
 * 处理 AI 快捷键。返回 `true` = 已消费（调用方应阻止默认行为）。
 *
 * 返回 `false` 时 TipTap 会把它交还给默认行为（`Enter` 插入一段）——
 * 这对"没有接续写功能"的场景是对的：宁可插入一段，也不要静默吞掉用户的按键。
 * 而**"有功能但没配模型"不在这条路上**：那时 `onContinue` 存在，
 * 由候选条说清为什么不干活（`use-ai-continue.ts` 的 `blocked`）。
 */
export function handleAiShortcut(event: KeyLike, handlers: AiKeyHandlers): boolean {
  if (event.key !== 'Enter') return false;
  if (!event.ctrlKey && !event.metaKey) return false;
  const handler = handlers.onContinue;
  if (handler === undefined) return false;
  handler();
  return true;
}
