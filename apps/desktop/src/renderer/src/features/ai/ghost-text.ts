/**
 * 幽灵文本：把流式生成的候选文本**画在文档外面**（`docs/11` §6.1）。
 *
 * ## 为什么必须是 Decoration，而不是"先插进去、不要了再撤掉"
 *
 * 后者是这类功能最自然的写法，也是本项目里**最贵的一个错**。它一次踩三条红线：
 *
 * 1. **污染保存状态**。插入 = 文档变化 = `EditorPane.handleChange` = `Autosave.onChange`
 *    → `mustSave` 置脏。用户没采纳任何东西，界面却开始保存 —— 而保存进去的是 AI 草稿。
 *    P1 验收第 3 条要求"生成过程中关掉应用，磁盘上一个字节都没变"，靠的就是
 *    装饰不产生 step。
 * 2. **污染撤销栈**。`prosemirror-history` 会记下插入，于是 Ctrl+Z 撤掉的是
 *    "AI 草稿"，而不是用户自己的上一笔。§6.6 要求"接受 = 一个事务 = 一次 Ctrl+Z"，
 *    前提是此前栈里**没有**这堆草稿。
 * 3. **崩溃即落盘**。一旦崩在生成中途，草稿就留在磁盘上了。
 *
 * 装饰（`DecorationSet`）只影响**视图**，不进文档、不进撤销栈、不影响 `docChanged`。
 * 这条性质由 `test/ghost-text.test.ts` 直接断言（"只带 meta 的事务 `docChanged === false`"），
 * 因为它是整个 P1 验收 3 的地基 —— 靠注释保证不够。
 *
 * ## 锚点为什么要跟着文档映射
 *
 * 生成期间用户可以继续打字（我们**不锁编辑器**，锁了反而像卡住）。他在锚点之前敲字，
 * 锚点就得跟着挪 —— 不映射的话，接受时这段文本会插到一个和光标无关的位置上。
 * 映射只写一次、放在插件状态里，是因为只有 `Transaction.mapping` 知道"这个位置挪到哪了"。
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

/** 幽灵文本的状态。`pos` 是**接受时插入位置**的锚点。 */
export interface GhostState {
  pos: number;
  text: string;
}

/** 通过事务 meta 下发的指令。 */
type GhostAction = { kind: 'set'; pos: number; text: string } | { kind: 'clear' };

export const GHOST_KEY = new PluginKey<GhostState | null>('inkstoneGhostText');

/**
 * 读幽灵文本状态。
 *
 * 单独一个函数是为了收掉 `getState()` 的 `undefined`：插件没注册时它返回 `undefined`，
 * 而"没有幽灵文本"在业务上就是 `null`。让调用方各自处理两种"没有"，迟早有人漏一种。
 */
export function readGhost(state: EditorState): GhostState | null {
  return GHOST_KEY.getState(state) ?? null;
}

/** 幽灵文本的 class。样式在 `ai.css`，`white-space: pre-wrap` 才能显示换行。 */
const GHOST_CLASS = 'ai-ghost-text';

export function createGhostTextExtension(): Extension {
  return Extension.create({
    name: 'inkstoneGhostText',
    addProseMirrorPlugins() {
      return [createGhostPlugin()];
    },
  });
}

/**
 * 插件本身。
 *
 * 与上面那个 `Extension` 分开导出，是为了让"插件状态怎么变"能被**直接测到**：
 * 测试里可以 `EditorState.create({ plugins: [createGhostPlugin()] })` 然后自己造事务，
 * 不必拉起一个真的编辑器（这个包的测试环境没有 DOM）。
 */
export function createGhostPlugin(): Plugin<GhostState | null> {
  return new Plugin<GhostState | null>({
    key: GHOST_KEY,
    state: {
      init: () => null,
      apply(tr, value) {
        const action = tr.getMeta(GHOST_KEY) as GhostAction | undefined;
        if (action?.kind === 'clear') return null;
        let next = value;
        if (action?.kind === 'set') next = { pos: action.pos, text: action.text };
        if (next === null) return null;
        if (tr.docChanged) next = { pos: tr.mapping.map(next.pos), text: next.text };
        return next;
      },
    },
    props: {
      decorations(state) {
        const ghost = readGhost(state);
        if (ghost === null || ghost.text === '') return null;
        // 位置越界会直接抛（`DecorationSet` 会校验），而"用户刚把光标附近整段删掉"
        // 是正常的，不是 bug。夹到合法范围里，最坏只是显示在不该显示的地方。
        const pos = Math.max(0, Math.min(ghost.pos, state.doc.content.size));
        return DecorationSet.create(state.doc, [
          Decoration.widget(pos, () => ghostElement(ghost.text), { side: 1 }),
        ]);
      },
    },
  });
}

function ghostElement(text: string): HTMLElement {
  const span = document.createElement('span');
  span.className = GHOST_CLASS;
  span.textContent = text;
  // 不让光标进得来：它不在文档里，能进去只会让用户以为自己选中了它
  span.contentEditable = 'false';
  // 屏幕阅读器不该念出还没被采纳的文本
  span.setAttribute('aria-hidden', 'true');
  return span;
}

/**
 * 往事务里写一条"设为幽灵文本"的 meta。
 *
 * 拿 `tr` 而不是自己 dispatch："写入幽灵文本"必须由调用方决定**和谁在同一个事务里** ——
 * 接受生成时它要跟插入内容的那些 step 同一个事务（否则装饰会在插入后多活一帧，
 * 那一帧里用户看到的是"接受成功了，但鬼影还在"）。
 */
export function setGhostMeta(tr: Transaction, pos: number, text: string): void {
  tr.setMeta(GHOST_KEY, { kind: 'set', pos, text } satisfies GhostAction);
  // 没有 step 的事务本来就进不了撤销栈，写上是为了让"它不该进"这件事在代码里看得见
  tr.setMeta('addToHistory', false);
}

/** 往事务里写一条"清掉幽灵文本"的 meta。 */
export function clearGhostMeta(tr: Transaction): void {
  tr.setMeta(GHOST_KEY, { kind: 'clear' } satisfies GhostAction);
  tr.setMeta('addToHistory', false);
}
