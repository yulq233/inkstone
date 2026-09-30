/**
 * 斜杠菜单的 ProseMirror 插件（`docs/11` §6.3）。
 *
 * ## 一个刻意的简化：**不做实时查询过滤**
 *
 * 斜杠菜单只有 8 个指令，全列出来 + 上下键导航就够（像一块迷你命令面板）。
 * "边打字边过滤"要求跟踪查询串，而查询串里会混进中文 —— 输入法（IME）的
 * 组合态下 `handleTextInput` 的行为和英文完全不同，为 8 条指令去把输入法路径
 * 摸透、测透，是拿复杂换一个用户根本用不到的体验（他顶多敲一两个字母）。
 *
 * 所以：触发后 `/` 留在文档里（正常输入），菜单列出**全部**指令，↑/↓/Enter/Esc 导航，
 * 选中后删掉那一个 `/`。没有查询串，也就没有输入法问题。
 *
 * ## 触发条件：只在**行首**敲 `/`
 *
 * 行内触发会和正文冲突（"和/或""1/3"这些写法里的斜杠不该弹菜单）。
 * 行首是"要写指令"的强信号，误触率最低。
 *
 * ## 菜单不在这里渲染
 *
 * 插件只负责：检测触发、记录 `/` 的位置、处理导航/确认/取消的按键。
 * 状态经 `onChange` 回调交给 React，`SlashMenu` 组件画浮层、记高亮索引。
 * "选中谁"由 React 决定（它知道高亮索引），删除 `/` 由插件做（删文本必须走事务）。
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

import type { SlashCommandId } from './slash-commands';

export interface SlashState {
  active: boolean;
  /** `/` 的文档位置。选中/取消时要删掉这一个字符。 */
  from: number;
}

export const SLASH_KEY = new PluginKey<SlashState | null>('inkstoneSlashMenu');

export function readSlashState(state: EditorState): SlashState | null {
  return SLASH_KEY.getState(state) ?? null;
}

const TRIGGER = '/';

export interface SlashPluginOptions {
  /** 状态变化通知（交给 React 触发渲染）。传新状态，`null` 表示退出。 */
  onChange: (state: SlashState | null) => void;
}

/**
 * 包装成 TipTap 扩展（与 `ghost-text.ts` 的 `createGhostTextExtension` 同构）。
 *
 * 裸 `Plugin` 不能直接进 `extensions` 数组（那里面要的是 `Extension`/`Node`/`Mark`），
 * 包一层 `addProseMirrorPlugins` 是 TipTap 的标准做法；测试里则可以单独取
 * `createSlashPlugin()` 造 `EditorState`，不必拉起真编辑器。
 */
export function createSlashExtension(options: SlashPluginOptions): Extension {
  return Extension.create({
    name: 'inkstoneSlashMenu',
    addProseMirrorPlugins() {
      return [createSlashPlugin(options)];
    },
  });
}

export function createSlashPlugin({ onChange }: SlashPluginOptions): Plugin<SlashState | null> {
  return new Plugin<SlashState | null>({
    key: SLASH_KEY,
    state: {
      init: () => null,
      apply(tr, prev) {
        const meta = tr.getMeta(SLASH_KEY) as
          { kind: 'activate'; from: number } | { kind: 'deactivate' } | undefined;

        if (meta?.kind === 'deactivate') {
          onChange(null);
          return null;
        }
        if (meta?.kind === 'activate') {
          const next: SlashState = { active: true, from: meta.from };
          onChange(next);
          return next;
        }
        // 其它事务（含后续打字）。若文档把 `/` 删掉了（用户退格、或别的写入），
        // 菜单就该消失，否则选中时会删一个已经不存在的位置。
        if (prev !== null && tr.docChanged) {
          const alive =
            prev.from <= tr.doc.content.size &&
            tr.doc.textBetween(prev.from, Math.min(prev.from + 1, tr.doc.content.size)) === TRIGGER;
          if (!alive) {
            onChange(null);
            return null;
          }
        }
        return prev;
      },
    },
    props: {
      handleTextInput(view: EditorView, from: number, to: number, text: string): boolean {
        // 只在行首、插入单个 `/`、且当前没有活动的菜单时触发。
        if (text !== TRIGGER || from !== to) return false;
        if (readSlashState(view.state)?.active) return false;
        if (!isLineStart(view, from)) return false;

        // 手动插入 `/` 并在同一事务里激活：`handleTextInput` 返回 true 表示
        // "我已处理这个输入"，否则 ProseMirror 会再插一次。
        const tr = view.state.tr;
        tr.insertText(TRIGGER, from, to).setMeta(SLASH_KEY, { kind: 'activate', from });
        view.dispatch(tr);
        return true;
      },
      handleKeyDown(view: EditorView, event: KeyboardEvent): boolean {
        const state = readSlashState(view.state);
        if (state === null || !state.active) return false;

        switch (event.key) {
          case 'Escape':
          case 'ArrowUp':
          case 'ArrowDown':
          case 'Enter':
          case 'Tab':
            // 这些键都交给 React（它知道高亮索引、会调 confirm/cancel），
            // 这里只阻止默认行为（回车插段、Tab 跳焦点、方向键移光标）。
            event.preventDefault();
            // Escape 由 React 调 cancelSlash；Enter/Tab 由 React 调 confirmSlash。
            // 方向键由 React 更新高亮。插件不在这里继续处理。
            return true;
          default:
            // 其它键（继续打字 / 退格）返回 false 让默认行为发生；
            // apply() 里的"`/` 是否还在"检查会在文档变化后决定菜单去留。
            return false;
        }
      },
    },
  });
}

function isLineStart(view: EditorView, pos: number): boolean {
  const $pos = view.state.doc.resolve(pos);
  // 行首 = 某个块（paragraph/heading 等）的**内容**第一个字符位置。
  // `parentOffset === 0` 表示「在这个 inline 父节点里指向第 0 个子节点」；
  // `depth >= 1` 排除 doc 边界（pos 0 的 parentOffset 也是 0，但那里不是字符位置，
  // 用户的光标也到不了 doc 边界 —— 真实敲 / 时 from 最小是块内容起点，即 pos 1）。
  return $pos.parentOffset === 0 && $pos.depth >= 1;
}

/**
 * 选中了某个指令：删掉 `/` 并退出菜单。
 *
 * `id` 不在这里用（动作由 React 侧按 id 映射到续写/快捷面板），
 * 但这个入口只负责"删 `/` + 退出"，保证无论选的是哪个指令，文本清理一致。
 */
export function confirmSlash(view: EditorView, _id: SlashCommandId): void {
  const state = readSlashState(view.state);
  if (state === null) return;
  const tr = view.state.tr;
  tr.delete(state.from, state.from + 1).setMeta(SLASH_KEY, { kind: 'deactivate' });
  view.dispatch(tr);
}

/** 取消菜单：删掉 `/` 并退出（Esc 用）。 */
export function cancelSlash(view: EditorView): void {
  const state = readSlashState(view.state);
  if (state === null) return;
  const tr = view.state.tr;
  tr.delete(state.from, state.from + 1).setMeta(SLASH_KEY, { kind: 'deactivate' });
  view.dispatch(tr);
}
