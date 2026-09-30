/**
 * 唯一的 TipTap 实例（`05` §4）。
 *
 * 对外只暴露**一组动词**，不透出 `Editor` 对象：一旦透出，步骤 03/04 的组件就要
 * `import type { Editor } from '@tiptap/core'`，编辑器库的类型会渗到整个渲染进程，
 * 将来换内核要改一圈。这组动词里"读写正文"恰好就是适配层的两个方向。
 *
 * ## 句柄为什么不绑定实例（2026-09-28 白屏事故的直接修复）
 *
 * 原来 `makeHandle(editor)` 把实例闭包进句柄，而句柄**只在 `onCreate` 里造一次**。
 * 于是有一个必然后果和一个放大器：
 *
 * 1. **句柄造出来之后，再也没有刷新它的时机。** `create` 由 `mount()` 里的
 *    `window.setTimeout(…, 0)` 发出（`@tiptap/core` 6234–6238），而它自带
 *    `if (this.isDestroyed) return;` —— 也就是说**载荷本身一定是活实例，但句柄
 *    也不会因为实例被换掉而重建**。
 *    `useEditor` 换实例只有两条路，都在 `@tiptap/react` 里：`refreshEditorInstance`
 *    （react:423）与 `scheduleDestroy` 的 1ms 定时器（react:441）。
 *    只要在其中任何一条上走了，句柄就永远指着一具尸体 —— 而 `scheduleDestroy`
 *    这条在本应用里**可达**：`WorkShell` 在 `state.kind !== 'ready'` 时整棵树
 *    `return null`（`WorkShell.tsx:259`），`EditorPane` 在 `chapter === null` 时
 *    也不渲染编辑器（`EditorPane.tsx:114`）—— 两处都会卸载 `TipTapEditor`。
 * 2. **`destroy()` 会把 `commandManager` 置成 `null`**（`@tiptap/core` 6624），
 *    而 `get commands()` 正是 `return this.commandManager.commands`（core 6271–6272）
 *    —— 于是碰一具尸体就抛
 *    `Cannot read properties of null (reading 'commands')`。
 *
 * 把这个"可恢复的失败"放大成"整个界面变白"的是**旧 `catch` 的兜底又用了同一个死实例**：
 * 异常在 `setMarkdown` 的 `try` 里被接住，`catch` 里再去调 `deadEditor.commands`
 * → 二次抛出 → 逃出 `EditorPane` 的 effect → React 19 在没有错误边界时卸载整棵根
 * → **连 header 都不剩**（日志：`The above error occurred in the <EditorPane> component`）。
 *
 * 所以现在：**句柄是一组"把命令交给当前编辑器"的函数**，不持有实例；每个动词先过
 * `usable()`（`editor.isDestroyed` 是 TipTap 官方判据），不可用就安全退化。
 * 这样"实例被换掉"与"实例已销毁"都不再可能把一次调用升级成界面崩溃。
 *
 * 唯一不能"退化成一个空动作"的是**读正文** —— 它的返回值会被直接写盘，
 * 空动作等于拿空文件覆盖手稿。它的退化方式是"返回最近一次已知正文"，
 * 理由见 `markdownCache`。
 */

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import type { Editor, JSONContent } from '@tiptap/core';
import { TextSelection, type Transaction } from '@tiptap/pm/state';
import { fromMd, inkstoneSchema, toMd } from '@inkstone/md-adapter';
import type { AdapterWarning, ToMdResult } from '@inkstone/md-adapter';
import {
  assertExtensionsMatchWhitelist,
  createEditorExtensions,
} from '../../lib/editor-extensions';
import { planCharCount, planGhostInsert } from '../ai/ghost-insert';
import {
  clearGhostMeta,
  createGhostTextExtension,
  readGhost,
  setGhostMeta,
} from '../ai/ghost-text';
import { handleAiShortcut } from '../ai/shortcuts';
import { SlashMenu } from '../ai/SlashMenu';
import type { SlashCommandId } from '../ai/slash-commands';
import { createSlashExtension, type SlashState } from '../ai/slash-plugin';

/**
 * 适配层的文档 → TipTap 的 JSON 内容。
 *
 * 需要这一步是因为 `PMNode.toJSON()` 在 `prosemirror-model` 的类型声明里返回 `any`，
 * 直接喂给 `setContent` 会触发 `no-unsafe-argument`。这里显式收敛成 `JSONContent`，
 * 顺带把"要传 JSON 而不是 PMNode"（见下方那条长注释）写在类型上。
 *
 * 参数用结构化类型 `{ toJSON(): unknown }` 而不是 `import type { Node } from 'prosemirror-model'`
 * —— 后者正是 `no-restricted-imports` 要拦的那种导入，而且适配层的 `Node` 与编辑器的
 * 也不是同一个实例。任何能 `toJSON()` 的 PM 节点都满足这个形状，兜底文档也复用同一个函数。
 */
function toTipTapContent(doc: { toJSON(): unknown }): JSONContent {
  return doc.toJSON() as JSONContent;
}

export interface EditorHandle {
  /**
   * PM → Markdown。内部走 `toMd(editor.state.doc)`。
   *
   * 实例不可用时返回**最近一次已知的正文**（`markdownCache`），不抛也不返回空串
   * —— 这个返回值会被直接写盘，详细理由见 `markdownCache`。
   */
  getMarkdown(): ToMdResult;
  /** Markdown → 文档。返回 warnings 供告警条展示 */
  setMarkdown(markdown: string): { warnings: AdapterWarning[] };
  /** 光标移到文首（载入 / 切章后调用） */
  focusStart(): void;
  /**
   * 撤销 / 重做。菜单里的那两项转发到这里（`09` §4.3）。
   *
   * 走 `editor.commands.undo()`，即 **`prosemirror-history` 自己的撤销栈** ——
   * 与编辑器内 `Ctrl+Z` 完全同一条路径。刻意不用 Electron 的 `role: 'undo'`：
   * 那条走 Chromium 原生撤销栈，绕过插件直接改 DOM 会被 ProseMirror 的 DOM observer
   * 当成"外部变更"接住，重则文档状态错乱，而**错乱意味着存盘存进去一堆乱结构**。
   */
  undo(): void;
  redo(): void;
  /**
   * 光标前后文（纯文本，块之间用空行分隔）。
   *
   * AI 的 prompt 用它，**不用 `getMarkdown()`**：读磁盘或者读整个文档都答不对这个问题
   * —— 要的是"光标之前用户看得见的那些字"。用户刚敲完还没保存的部分只存在于编辑器里，
   * 而那恰恰是最该被续上的（`ai-types.ts` 的 `AiGenRequest.prefix`）。
   */
  getContextAroundCursor(): { prefix: string; suffix: string };
  /**
   * 在**当前光标处**钉下幽灵文本的锚点并清空内容。
   *
   * 返回 `false` 表示编辑器不可用（此时整次生成都不该发出去 —— 内容回来也没地方放）。
   */
  ghostBegin(): boolean;
  /** 替换幽灵文本的内容。**纯装饰**：不进文档、不进撤销栈、不触发 `onUpdate` */
  ghostUpdate(text: string): void;
  /** 清掉幽灵文本 */
  ghostClear(): void;
  /**
   * 接受幽灵文本：**一个事务**插进文档（`docs/11` §6.6：接受 = 一次 Ctrl+Z 可撤）。
   *
   * 返回插入的字符数；没有可接受的内容或插入失败时返回 `null`。
   */
  ghostAccept(): number | null;
  /**
   * 在当前光标处插入一段 Markdown（快捷生成"点选插入"用）。
   *
   * 与 `ghostAccept` 同一条插入逻辑，只是位置取当前光标、不动幽灵文本。
   * 返回插入的字符数；插入失败时返回 `null`。
   */
  insertAtCursor(markdown: string): number | null;
}

export interface TipTapEditorProps {
  placeholder?: string;
  /**
   * 能不能编辑。**运行时会生效**（走 `editor.setEditable`，见下面的 effect），
   * 不只是创建时的初值。切章遮罩靠它真正挡住敲键盘 —— 只靠遮罩的 `z-index`
   * 挡得住鼠标，挡不住已经聚焦在正文里的输入。
   */
  editable?: boolean;
  /**
   * 内容变化。**刻意不带参数** —— 正文只能有一个来源（`getMarkdown()`）。
   * 从 `transaction` 里顺手取 doc 看着方便，但那会造出第二条来源，
   * 两者在批量更新时可能不一致，而这种不一致极难复现。
   */
  onChange: () => void;
  /** 编辑器就绪，把 handle 交给上层 */
  onReady: (handle: EditorHandle) => void;
  /** `Ctrl/Cmd + Enter`：在光标处续写。不传则不接管这个键 */
  onContinue?: () => void;
  /** 斜杠菜单选中 `/续写`。 */
  onSlashContinue?: () => void;
  /** 斜杠菜单选中某个快捷 kind。 */
  onSlashQuick?: (kind: SlashCommandId) => void;
}

export function TipTapEditor({
  placeholder = '开始写……',
  editable = true,
  onChange,
  onReady,
  onContinue,
  onSlashContinue,
  onSlashQuick,
}: TipTapEditorProps) {
  // 用 ref 包住回调，这样 useEditor 的 deps 可以是空数组（编辑器只创建一次）。
  const onChangeRef = useRef(onChange);
  const onReadyRef = useRef(onReady);
  const onContinueRef = useRef(onContinue);
  const onSlashContinueRef = useRef(onSlashContinue);
  const onSlashQuickRef = useRef(onSlashQuick);
  useEffect(() => {
    onChangeRef.current = onChange;
    onReadyRef.current = onReady;
    onContinueRef.current = onContinue;
    onSlashContinueRef.current = onSlashContinue;
    onSlashQuickRef.current = onSlashQuick;
  });

  /** 斜杠菜单状态。插件的 `onChange` 更新它，`SlashMenu` 消费它。 */
  const [slashState, setSlashState] = useState<SlashState | null>(null);

  /**
   * 扩展集：白名单那一套 + AI 的幽灵文本装饰 + 斜杠菜单插件。
   *
   * 斜杠插件的 `onChange` 直接闭包 `setSlashState`（它是稳定的 setter），
   * 所以扩展集仍是 `useMemo([placeholder])`，不会因为状态变化而重建编辑器。
   */
  const extensions = useMemo(() => {
    const all = [
      ...createEditorExtensions(placeholder),
      // 幽灵文本是**装饰**：它不进文档，所以不参与白名单（白名单管的是语法）
      createGhostTextExtension(),
      // 斜杠菜单也是纯插件（不引入节点/标记），同样不参与白名单
      createSlashExtension({ onChange: setSlashState }),
    ];
    // 对**最终**这一组做断言，而不是只断言白名单那部分：
    // 保证"加装饰/斜杠菜单不会顺手把某个语法扩展也带进来"（`editor-extensions.ts` 有理由）
    assertExtensionsMatchWhitelist(all);
    return all;
  }, [placeholder]);

  /**
   * **当前**编辑器实例。
   *
   * 句柄靠它取实例，而不是靠事件载荷 —— `useEditor` 内部会换实例（见文件头），
   * 而事件里带的那个可能在触发时就已经是旧的。这个 ref 在每次渲染后同步，
   * 而 `create` 是宏任务里发的，必然读到本次渲染的值。
   */
  const editorRef = useRef<Editor | null>(null);

  /**
   * 最后一次**已知**的正文，只在"实例不可用"这条安全网上被读到。
   *
   * 为什么读正文不能像别的动词那样静默退化 —— 两条看似更"诚实"的路都会造成更大伤害：
   *
   * - **返回 `''`**：调用方（`Autosave`）会把这具空文件写盘，直接覆盖用户的手稿，
   *   正是本项目红线里的"静默丢字"。
   * - **抛异常**：`Autosave.attemptSave()` 是在 `try` **之外**调本方法的，而它的
   *   `runLoop` 在调用之前已经把 `mustSave` 清成了 `false`。异常逃出去只会变成
   *   一个无人接收的 rejection —— 改动既没落盘、也不会进重试、界面上还什么都不说。
   *   （`EditorPane.handleChange` 那条路更糟：它同步跑在 TipTap 的 `onUpdate` 里，
   *   异常会直接打断 ProseMirror 的事务派发。）
   *
   * 缓存里存的是"`getMarkdown()` 上一次的返回值"，所以重存它最多是白写一次，
   * 绝不会把正文换成别的内容 —— 它永远不会比磁盘上的版本更旧（每次成功保存后二者相同）。
   *
   * ⚠️ 它**跨章存活**：切章时 `content` 只换值、组件不重挂（`EditorPane` 与
   * `TipTapEditor` 都没有 `key`，且 `setContent` 从不传 `null`）。所以 `setMarkdown`
   * 成功时必须顺手刷新它，否则缓存里留的会是**上一章的正文**。
   */
  const markdownCache = useRef('');

  const editor = useEditor({
    extensions,
    editable,
    onUpdate: () => onChangeRef.current(),
    onCreate: () => {
      // 刻意**忽略事件里的 `editor`**：见文件头「句柄为什么不绑定实例」。
      onReadyRef.current(makeHandle(() => editorRef.current, markdownCache));
    },
    // 刻意**不传** `immediatelyRender`：它只是 SSR 的补丁，而桌面端没有 SSR。
    // 传 false 会让返回值变成 `Editor | null`，白搭一堆判空分支。
  });

  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  /**
   * `editable` 的**运行时**开关（`docs/13` M17）。
   *
   * 只把它写进 `useEditor({ editable })` 是**不够**的，两头都堵着：
   *
   * 1. 本组件的 `useEditor` deps 恒为 `[]`，实例一次都不重建 —— 传进去的只是初值；
   * 2. 更关键：`@tiptap/react` 的 `onRender` 在 `deps.length === 0` 时会
   *    `setOptions({ ...options, editable: this.editor.isEditable })`
   *    —— **刻意把 `editable` 顶回当前值**，所以改 prop 永远不会生效。
   *
   * 用途是切章遮罩：读大章节期间旧章的正文还在编辑器里，而新章的 `content`
   * 还没换上。此时敲的字会写进**正在被切走的那一章**（并且带旧 baseHash），
   * 紧接着 `setMarkdown` 把内容整体替换 —— 这段输入凭空消失，且没有任何提示。
   * 遮罩的 `inset:0` 只挡鼠标；键盘挡不挡得住取决于这一行。
   *
   * `isDestroyed` 要判：`setEditable` 内部会碰 `view`，而句柄安全网存在的理由
   * 就是实例可能已经被 `useEditor` 换掉（见文件头）。
   */
  useEffect(() => {
    if (editor === null || editor.isDestroyed) return;
    editor.setEditable(editable);
  }, [editor, editable]);

  /**
   * 把 AI 快捷键挂上去。
   *
   * 放在 effect 里、并经由 ref 取回调，是因为**两者都必须是"最新"的**：
   * - 回调要最新：它闭包着 `WorkShell` 的当前作品与章节，闭错了就会把这一章的内容续到上一章；
   * - 挂载只做一次：`setOptions` 会 `view.setProps()`，每次渲染都调是白干活。
   *
   * 展开 `editor.options.editorProps` 再覆盖 `handleKeyDown`：`setOptions` 是**浅合并**的，
   * 直接传 `{ editorProps: { handleKeyDown } }` 会把别的 props（粘贴、拖放等）整块抹掉。
   */
  useEffect(() => {
    if (editor === null) return;
    editor.setOptions({
      editorProps: {
        ...editor.options.editorProps,
        handleKeyDown: (_view, event) =>
          handleAiShortcut(event, {
            onContinue: () => {
              onContinueRef.current?.();
            },
          }),
      },
    });
  }, [editor]);

  return (
    <div className="inkstone-editor">
      <EditorContent editor={editor} />
      <SlashMenu
        state={slashState}
        getView={() => editorRef.current?.view ?? null}
        onContinue={() => onSlashContinueRef.current?.()}
        onQuick={(kind) => onSlashQuickRef.current?.(kind)}
      />
    </div>
  );
}

/**
 * 造一组动词。**不接收实例，只接收"去哪取当前实例"** —— 这是本文件的核心决定。
 *
 * `usable()` 用 `isDestroyed` 判断实例是否还能用（TipTap 自己的判据：`editorView?.isDestroyed ?? true`）。
 * 注意它的语义是"**现在**能不能用"而不是"曾经创建成功"：
 * 实例被 `destroy()` 之后它为真，`EditorContent` 还没把它挂上 DOM 时它也为真。
 *
 * `markdownCache` 是唯一一处"退化时不能什么都不做"的落点，见它的声明处。
 */
function makeHandle(
  resolveEditor: () => Editor | null,
  markdownCache: RefObject<string>,
): EditorHandle {
  const usable = (): Editor | null => {
    const editor = resolveEditor();
    return editor === null || editor.isDestroyed ? null : editor;
  };

  /**
   * 失效原因。**这两种在排障上意义不同**，所以日志里要分开说：
   * "实例不存在"说明库已经把实例丢掉了（`scheduleDestroy` 里的 `setEditor(null)`）；
   * "实例已销毁"说明实例还在、只是被 `destroy()` 过 —— 即**句柄指着一具尸体**，
   * 那正是本次白屏事故的形状。
   * 只在走安全网时才调用，正常路径不产生任何日志噪声。
   */
  const describeUnusable = (): string => {
    const editor = resolveEditor();
    if (editor === null) return '编辑器实例不存在（已被 useEditor 丢弃）';
    return '编辑器实例已销毁（句柄指向的是旧实例）';
  };

  const warnUnusable = (action: string): void => {
    // 走 console.warn → 主进程会把它转发到终端（`main/renderer-diagnostics.ts`）。
    // 这条日志本身就是诊断价值：它出现说明"实例被换掉"真的在发生，
    // 而在修复之前，同一件事的表现是整个界面白掉、且什么都不说。
    console.warn(`[inkstone] ${describeUnusable()}，已跳过一次「${action}」调用。`);
  };

  /**
   * 换文档时清掉幽灵文本。
   *
   * 锚点是按**旧文档**的位置算出来的，文档一换它就只剩一个数字 ——
   * 留着它的后果是"接受时把上一章的内容插进这一章"。切章、重载、解决冲突
   * 走的都是 `setMarkdown`，在这一处清掉就全覆盖了。
   */
  const dropGhost = (editor: Editor): void => {
    editor.commands.command(({ tr }) => {
      clearGhostMeta(tr);
      return true;
    });
  };

  return {
    getMarkdown: () => {
      const editor = usable();
      if (editor === null) {
        // 安全网，正常走不到：句柄取的是"当前"实例，实例在，编辑才可能发生。
        // 退化方式见 `markdownCache` —— 返回缓存，既不抛也不返回空串。
        warnUnusable('读取正文');
        return { markdown: markdownCache.current, warnings: [] };
      }
      const result = toMd(editor.state.doc);
      markdownCache.current = result.markdown;
      return result;
    },

    setMarkdown: (markdown) => {
      const editor = usable();
      if (editor === null) {
        warnUnusable('载入正文');
        return { warnings: [] };
      }
      try {
        const { doc, warnings } = fromMd(markdown);
        // 必须走 `toJSON()` 中转，**不能**直接把 `doc` 塞进去。
        //
        // 设计文档 §2 坑 #2 说"可以直接传 PMNode，不需要 toJSON()"，那个结论不成立：
        // - TipTap 的 `isProseMirrorContent()` 只看"有没有 nodesBetween 方法"，
        //   所以任何 schema 造出的 PMNode 都会被原样放行，绕过编辑器 schema 的校验；
        // - `prosemirror-model` 的 `ContentMatch.matchType()` 用的是 `==`（**身份**比较），
        //   而适配层的 `inkstoneSchema` 与编辑器的 schema 是两个实例，同名类互不相等。
        // 后果不是"报个错"，而是节点带着外来 schema 的 type 留在文档里，
        // 之后每次编辑都可能踩到身份比较。证据见 `test/editor-schema-bridge.test.ts`。
        editor.commands.setContent(toTipTapContent(doc), { emitUpdate: false });
        dropGhost(editor);
        // 顺手刷新缓存：这一章此刻的正文就是 `doc`。**这一步不能省** —— 切章不重挂
        // 组件，不在这里写一次，缓存里留的就是上一章的正文（见 `markdownCache`）。
        // 存 `toMd(doc)` 而不是入参 `markdown`：前者才是"再调一次 `getMarkdown()`
        // 会拿到的值"，缓存与真实读取口径一致，退化才是真正无感的。
        markdownCache.current = toMd(doc).markdown;
        return { warnings };
      } catch (error) {
        // 兜底：解析器抛出时**绝不出现白板**。整章按纯文本塞进一个段落，
        // 内容一个字不少，代价是丢了结构 —— 而这会由告警条明说。
        //
        // 这里**重新取一次实例**：走到这个分支的原因可能是解析失败（实例还好），
        // 也可能是上面那行本身撞上了一个刚被换掉的实例。旧代码在这里直接复用外层的
        // `editor`，于是"兜底"自己又抛一次 —— 一次可恢复的失败就这么升级成了整树卸载。
        const alive = usable();
        if (alive !== null) {
          const degraded = fallbackDoc(markdown);
          alive.commands.setContent(toTipTapContent(degraded), { emitUpdate: false });
          dropGhost(alive);
          markdownCache.current = toMd(degraded).markdown;
        }
        return {
          warnings: [
            {
              code: 'DEGRADED_BLOCK',
              message:
                alive === null
                  ? '该章内容未能载入：编辑器实例已失效，请重新打开这一章。'
                  : `该章内容未能完整解析（${errorText(error)}），已按纯文本显示`,
              from: 0,
              to: 0,
            },
          ],
        };
      }
    },

    focusStart: () => {
      const editor = usable();
      if (editor === null) return;
      editor.commands.focus('start', { scrollIntoView: false });
    },

    // 用大括号包住：`commands.undo()` 返回 boolean，直接当表达式返回会让
    // 调用方误以为这里能拿到"有没有可撤的"。菜单的语义是"按一下试试"，
    // 没有可撤的内容时静默不动，与编辑器内 Ctrl+Z 一致。
    //
    // 不可用时也**静默**：撤销/重做不动数据（只是没有效果），
    // 而切章、载入这种会产生副作用的才值得留一条日志。
    undo: () => {
      usable()?.commands.undo();
    },

    redo: () => {
      usable()?.commands.redo();
    },

    getContextAroundCursor: () => {
      const editor = usable();
      if (editor === null) {
        warnUnusable('读取光标前后的正文');
        return { prefix: '', suffix: '' };
      }
      const { from, to } = editor.state.selection;
      const doc = editor.state.doc;
      // 块之间用**空行**连接：模型要输出的就是 Markdown，让它看到同形的上下文。
      // 写成单个 `\n` 会让相邻两段看起来像同一段里的软换行，而本 schema 里
      // 根本没有软换行（HardBreak 不在白名单里），那就是一个不存在的结构。
      //
      // 选区非空时（`from < to`）选区本身**不进 prompt**：续写的语义是"从这里往下写"，
      // 而"改写选中内容"是 P2 的另一条路（§7.4）。混在一起会让模型收到两段互相矛盾的指令。
      return {
        prefix: doc.textBetween(0, from, '\n\n'),
        suffix: doc.textBetween(to, doc.content.size, '\n\n'),
      };
    },

    ghostBegin: () => {
      const editor = usable();
      if (editor === null) {
        warnUnusable('锚定生成位置');
        return false;
      }
      const pos = editor.state.selection.from;
      editor.commands.command(({ tr }) => {
        setGhostMeta(tr, pos, '');
        return true;
      });
      return true;
    },

    ghostUpdate: (text) => {
      const editor = usable();
      // 这里**静默**：它每次流式刷新都会被调用，走 `warnUnusable` 会把终端刷爆，
      // 真正的信号反而被埋掉。
      if (editor === null) return;
      const ghost = readGhost(editor.state);
      if (ghost === null) return;
      // 用**插件里记的锚点**而不是当前光标：锚点在生成开始那一刻就钉住了，
      // 生成期间用户把光标移走是正常的，但内容该落在原来那个位置。
      editor.commands.command(({ tr }) => {
        setGhostMeta(tr, ghost.pos, text);
        return true;
      });
    },

    ghostClear: () => {
      const editor = usable();
      if (editor === null) return;
      dropGhost(editor);
    },

    ghostAccept: () => {
      const editor = usable();
      if (editor === null) {
        warnUnusable('接受生成内容');
        return null;
      }
      const ghost = readGhost(editor.state);
      if (ghost === null) return null;
      return insertPlanAt(editor, ghost.pos, planGhostInsert(ghost.text), true);
    },

    /**
     * 在当前光标处插入一段 Markdown（快捷生成的"点选插入"用）。
     *
     * 与 `ghostAccept` 共用同一条插入逻辑（`insertPlanAt`），区别只在：
     * 位置取**当前光标**而不是幽灵锚点，且**不清幽灵文本**（点选插入时本来就没有）。
     * 返回插入的字符数，失败返回 `null`。
     */
    insertAtCursor: (markdown) => {
      const editor = usable();
      if (editor === null) {
        warnUnusable('插入生成内容');
        return null;
      }
      const pos = editor.state.selection.from;
      return insertPlanAt(editor, pos, planGhostInsert(markdown), false);
    },
  };
}

/**
 * 把一份插入计划落到文档上（**一个事务**）。`ghostAccept` 与 `insertAtCursor` 共用。
 *
 * `clearGhost` 为真时顺手清掉幽灵文本（且与插入同一个事务）；为假时不动。
 * 返回插入的字符数，失败（编辑器被换掉 / 位置越界 / schema 拒绝）返回 `null`，
 * **不抛**：这条路跑在 React 事件里，抛出去就是一次未捕获异常。
 *
 * 插入形状见 `ghost-insert.ts`：第一段按内联接进当前段落、其余按块插；
 * 末尾位置取最后一步的 `newTo`（累积映射会重复位移，实测踩过）。
 */
function insertPlanAt(
  editor: Editor,
  pos: number,
  plan: ReturnType<typeof planGhostInsert>,
  clearGhost: boolean,
): number | null {
  if (plan.lead.length === 0 && plan.rest.length === 0) return null;
  try {
    const tr = editor.state.tr;
    // 夹一次范围：用户在生成期间把光标附近整段删掉是可能的
    let end = Math.max(0, Math.min(pos, tr.doc.content.size));
    if (plan.lead.length > 0) {
      // 第一段走**内联**插入，接进当前段落。整批当块插会走 PM 的
      // "在光标处拆段"，于是"他推开门" + "，看见了她"变成两段（见 `ghost-insert.ts`）。
      tr.insert(end, fragmentOf(editor, 'paragraph', plan.lead));
      // 此刻累积映射里只有这一步，所以 `map()` 是安全的
      end = tr.mapping.map(end, 1);
    }
    if (plan.rest.length > 0) {
      tr.insert(end, fragmentOf(editor, 'doc', plan.rest));
      // ⚠️ 这里**不能**再 `tr.mapping.map(end, 1)`：累积映射会把 `end`
      // 连前面的步骤一起重走一遍，等于重复位移。实测给出 22，而文档总长只有 18，
      // 于是 `doc.resolve()` 抛 `Position out of range` —— **整段内容一个字都插不进去**。
      // 取最后一步的 `newTo` 才是"插入内容的末尾"。
      end = endOfLastInsert(tr, end);
    }
    tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(end, tr.doc.content.size)), -1));
    // 清幽灵文本与插入内容**同一个事务**：分两次的话中间会有一帧
    // "内容进去了、鬼影还在"，看起来像是插了两遍。
    if (clearGhost) clearGhostMeta(tr);
    editor.view.dispatch(tr);
    return planCharCount(plan);
  } catch (error) {
    console.error(`[inkstone] 插入生成内容失败：${errorText(error)}`);
    return null;
  }
}

/**
 * 用**编辑器自己的 schema** 把 JSON 造成节点片段。
 *
 * ⚠️ 不能用 `fromMd()` 直接拿到的节点，也不能 `Fragment.fromJSON(适配层schema, …)`：
 * 适配层的 `inkstoneSchema` 与编辑器的 schema 是**两个实例**，而
 * `ContentMatch.matchType()` 用的是 `==`（身份比较）—— 外来节点会带着一个
 * 编辑器不认识的 type 留在文档里（`test/editor-schema-bridge.test.ts` 记的就是这条）。
 * 绕一圈 JSON 再让编辑器自己造，身份就对了。
 *
 * `wrapper` 是为了满足 `doc` / `paragraph` 的内容表达式（`block+` / `inline*`）——
 * `nodeFromJSON` 会**校验**内容，包错了会当场抛，而不是把结构问题留到后面。
 */
function fragmentOf(editor: Editor, wrapper: 'doc' | 'paragraph', content: JSONContent[]) {
  return editor.schema.nodeFromJSON({ type: wrapper, content }).content;
}

/**
 * 最后一步**插入内容**的末尾位置（用来放光标）。
 *
 * 取最后一步的 `newTo`，而不是 `tr.mapping.map(pos)`：后者是**累积**映射，
 * 会把目标位置连前面的步骤一起重走一遍 —— 而那正是"新内容插不进去"那个 bug 的形态
 * （`ghostAccept` 的注释里有实测数字）。TipTap 自己的 `selectionToInsertionEnd`
 * 用的也是这个取法。
 */
function endOfLastInsert(tr: Transaction, fallback: number): number {
  const maps = tr.mapping.maps;
  const last = maps[maps.length - 1];
  if (last === undefined) return fallback;
  let end = 0;
  last.forEach((_from, _to, _newFrom, newTo) => {
    if (end === 0) end = newTo;
  });
  return end === 0 ? fallback : end;
}

/** 解析失败时的兜底文档：一个段落装下全部文本。 */
function fallbackDoc(markdown: string) {
  const inline = markdown === '' ? [] : [inkstoneSchema.text(markdown)];
  return inkstoneSchema.node('doc', null, [inkstoneSchema.node('paragraph', null, inline)]);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
