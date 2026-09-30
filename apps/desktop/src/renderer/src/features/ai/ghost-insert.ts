/**
 * 把候选文本拆成"接在光标处的一段"与"落在后面的若干段"（`docs/11` §6.1）。
 *
 * ## 为什么要拆，不能一把 `insertContentAt`
 *
 * §6.1 写的是"接受：`editor.chain().focus().insertContentAt(pos, content).run()`"。
 * 实测下来那条路对**续写**这个主场景是错的：`insertContentAt` 遇到块级内容会走
 * `tr.replaceWith(from, to, blocks)`，而它的语义是**在光标处把当前段落切开、把块塞进去**
 * （实测见 `test/ghost-text.test.ts` 的「段落中间插入块级内容」）。后果是：
 *
 * ```
 * 原文「他推开门」   光标在末尾   模型续写「，看见了她」
 * replaceWith →  「他推开门」「，看见了她」     ← 断了，成了两段
 * 本模块     →  「他推开门，看见了她」          ← 接着
 * ```
 *
 * 续写是这个功能的主场景，而模型被要求"接着写"时不会先给一个段落分隔 ——
 * 所以第一段必须**按内联内容接进当前段落**，只有后面的段落才该另起。
 * 这不是优化：另起一段会让用户看到"它把我的句子劈开了"，属于一眼可见的坏结果。
 *
 * ## 纯函数：这里只产出 JSON，不碰编辑器
 *
 * 返回的是**编辑器 schema 的 JSON 形状**（`JSONContent`），由调用方用
 * `schema.nodeFromJSON()` 造节点。为什么不在这里直接造 PM 节点：
 *
 * - 适配层的 `inkstoneSchema` 与编辑器的 schema 是**两个实例**，`ContentMatch.matchType`
 *   用的是 `==`（身份比较）—— 跨 schema 传节点是 `02` 文档 §2 坑 #2 记的那条老路，
 *   后果是外来节点留在文档里，之后每次编辑都可能踩到身份比较。
 * - 只产出 JSON 还有一个好处：这个模块可以在**没有 DOM 的 node 测试环境**里跑，
 *   于是"第一段有没有被接上"这件事能被直接断言，而不是靠肉眼看窗口。
 */

import { fromMd } from '@inkstone/md-adapter';
import type { JSONContent } from '@tiptap/core';

export interface GhostInsertPlan {
  /**
   * 紧接着光标插入的**内联**内容（取第一段）。
   * 空数组 = 没有可接的内容，此时全部走 `rest`。
   */
  lead: JSONContent[];
  /** 落在后面的**块级**内容。 */
  rest: JSONContent[];
}

const EMPTY: GhostInsertPlan = { lead: [], rest: [] };

export function planGhostInsert(markdown: string): GhostInsertPlan {
  // 先 trim：模型输出常常以换行开头，不 trim 会在文档里多出一个空段落。
  // 行尾也一样 —— 一个结尾的换行会渲染成"光标后面空了一段"。
  const text = markdown.trim();
  if (text === '') return EMPTY;

  const { doc } = fromMd(text);
  const json = doc.toJSON() as JSONContent;
  const blocks = json.content ?? [];
  if (blocks.length === 0) return EMPTY;

  const [first, ...others] = blocks;
  // 只有**段落**能接：标题、引用、分隔线都是块，它们的内联内容接进当前段落等于
  // 把"一级标题"降级成普通正文（用户会以为模型丢了格式）。
  if (first.type !== 'paragraph') return { lead: [], rest: blocks };

  const inline = first.content ?? [];
  // 第一段是空段落：接一条空的内联内容什么都不会发生，而 `rest` 的落点会因此
  // 落在段首 —— 那时内容会插到光标**之前**（实测 TipTap 在段首插块会把 `from` 前移一格）。
  // 宁可整批当块处理。
  if (inline.length === 0) return { lead: [], rest: blocks };

  return { lead: inline, rest: others };
}

/**
 * 这次插入会往文档里加多少字。
 *
 * 用途是回填采纳结果（`acceptedChars`）。**不拿 `ghost.text.length` 顶替**：
 * 那是原始 Markdown 的长度，与"进到文档里的字"差着一个 trim 和全部标记符号
 * （`**加粗**` 四进二出）。统计口径只要差一点，用户就会觉得"这个数字不准"。
 */
export function planCharCount(plan: GhostInsertPlan): number {
  return inlineLength(plan.lead) + inlineLength(plan.rest);
}

function inlineLength(nodes: readonly JSONContent[]): number {
  let total = 0;
  for (const node of nodes) {
    if (node.text !== undefined) total += node.text.length;
    if (node.content !== undefined) total += inlineLength(node.content);
  }
  return total;
}
