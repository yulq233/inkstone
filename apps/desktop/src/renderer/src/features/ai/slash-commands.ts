/**
 * 斜杠指令菜单的纯逻辑（`docs/11` §6.3 的「斜杠指令」入口）。
 *
 * ## 为什么这里只放元数据，不放"选中后做什么"
 *
 * 指令选中后的动作分两类：`/续写` 触发续写编排，其余 7 个 kind 打开快捷面板。
 * 两者依赖的上下文（`useAiContinue` / `useAiQuick` 的句柄）都在 React 侧。
 * 所以这里只定义**指令的元数据**（id / 文案 / 快捷键提示），
 * "点中之后调哪个 hook"由 `SlashMenu` 组件按 `id` 映射 —— 这样这个模块可以
 * 在无 DOM 的环境里直接测过滤与排序，动作映射反而测不了（也测不出名堂）。
 *
 * ## 快捷键提示必须与指令一起出现
 *
 * §6.3 明确：「斜杠指令的候选列表要同时列快捷键，否则用户永远学不会第二条路径」。
 * 所以每个指令带上 `shortcut`，菜单渲染时展示 —— 用户用几次 `/续写`，
 * 自然就记住了还有个 `Ctrl+Enter`。
 */

import { AI_QUICK_KINDS, AI_QUICK_LABEL, type AiQuickKind } from '@inkstone/shared';

export type SlashCommandId = 'continue' | AiQuickKind;

export interface SlashCommand {
  id: SlashCommandId;
  /** 菜单里显示的名字，**不带斜杠**（斜杠是触发符，不是名字的一部分）。 */
  label: string;
  /** 给用户看的快捷键提示（如 `Ctrl+Enter`）。没有就省略。 */
  shortcut?: string;
}

/** 指令全集。顺序 = 菜单里的顺序，把最常用的续写放第一。 */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { id: 'continue', label: '续写', shortcut: 'Ctrl+Enter' },
  ...AI_QUICK_KINDS.map((kind) => ({ id: kind, label: AI_QUICK_LABEL[kind] })),
];

/**
 * 按用户敲的查询串过滤指令。
 *
 * `query` 是触发符**之后**的文本（不含 `/`）。匹配规则：标签包含查询串。
 * 中文没有大小写，英文 id 匹配时归一化到小写，避免 `/naming` 与 `/Naming` 行为不一致。
 *
 * 返回的是**新数组**（调用方可能要重排/加高亮索引），但元素是共享引用 ——
 * 指令元数据是常量，复制引用无副作用。
 */
export function filterSlashCommands(query: string): SlashCommand[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...SLASH_COMMANDS];
  return SLASH_COMMANDS.filter(
    (cmd) => cmd.label.toLowerCase().includes(q) || cmd.id.toLowerCase().includes(q),
  );
}
