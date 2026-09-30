/**
 * 探针：把「AI 生成的文本」落进正文这一步，**到底能不能走块级插入**。
 *
 * ## 为什么要探
 *
 * `docs/11` §6.1 要求"接受生成 = 一次事务"。落笔这一步有两个候选：
 *
 * - **A 块级插入**：`fromMd(生成文本) → toJSON() → insertContentAt(pos, 数组)`。
 *   好处是生成文本里的 `#` / `**` / `>` 会被解析成对应结构，与手工写的一致。
 * - **B 纯文本插入**：只把文本塞进光标处。稳，但多段与标题都变成一坨。
 *
 * 选 A 有一个**必须实测**的前提：`insertContentAt` 对块级内容最终走的是
 * `tr.replaceWith(from, to, nodes)`（`@tiptap/core` dist 744 行），而 `replaceWith`
 * 在 ProseMirror 里要求位置落在**节点边界**上。光标停在段落中间时它到底会
 * 自动拆段、还是抛 `RangeError`，光看文档定不下来。
 *
 * ## 怎么探（不依赖 DOM）
 *
 * `EditorState` 与 `Transform` 都是纯数据操作，不需要 `document` ——
 * 所以这个包的 node 环境就够，不必引入 jsdom。而且这里**复刻了 TipTap 的实现路径**
 * （读的是 dist 里 `insertContentAt` 的同一段逻辑：`insertText` 分支与
 * `replaceWith` 分支），不是另写一套。
 *
 * ⚠️ 复刻的部分只有"怎么构造要插入的节点"：TipTap 用 `createNodeFromContent(value, schema)`
 * 把 JSON 变成节点，这里用等价的 `schema.nodeFromJSON()`。**位置调整那两行是逐行照抄的**
 * （空段落时 `from-1/to+1`；段落起点且内容是块级时 `from-1`）—— 它们正是决定
 * 行为的分支，抄错就等于没探。
 *
 * 结论写在本文件末尾的用例名里，`features/ai` 的落笔实现按它写。
 *
 * ## 实测结论（2026-09-28）
 *
 * | 问题 | 结论 |
 * |---|---|
 * | 光标在段落**中间**，插入块级内容 | ✅ **能自动拆段，不抛错**。`replaceWith` 把原段落切成"前半 + 生成内容 + 后半"，四段文本一字不少 |
 * | 光标在**空段落**里 | ✅ TipTap 的 `from-1/to+1` 那两行生效，整个空段落被替换掉，尾部不留空段 |
 * | 生成文本会走哪条分支 | ⚠️ **一定走 `replace-with`**。`fromMd()` 的产出**永远是块级**（哪怕只有一句没有换行），所以 TipTap 的 `insertText` 稳路**用不上** —— 上面第一条不是"可选优化"，而是这条链路的必要前提 |
 * | 白名单外语法（列表） | ✅ `fromMd` 会降级，产出的节点都能过 `node.check()`，不会造出编辑器没加载的结构 |
 *
 * 据此，落笔方案定为 **A（块级插入）**，且实现里**必须**保留一条兜底：
 * `insertContentAt` 抛错时退回"把纯文本插到光标处" —— 探针证明它现在不抛，
 * 但那依赖 ProseMirror 的 fit 策略，不是契约。
 */

import { describe, expect, it } from 'vitest';
import { getSchema } from '@tiptap/core';
import { EditorState, type Transaction } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import { fromMd } from '@inkstone/md-adapter';

import { createEditorExtensions } from '../src/renderer/src/lib/editor-extensions';

const schema = getSchema(createEditorExtensions());

/** 造一个"已经打开了一章"的状态。走 `toJSON()` 中转为的是与真实路径同源。 */
function stateOf(markdown: string): EditorState {
  return EditorState.create({ doc: docOf(markdown) });
}

function docOf(markdown: string): PMNode {
  return schema.nodeFromJSON(fromMd(markdown).doc.toJSON());
}

/** 生成文本 → 节点数组。这就是"落笔"要插入的东西。 */
function nodesOf(markdown: string): PMNode[] {
  const json = fromMd(markdown).doc.toJSON() as { content?: unknown[] };
  return (json.content ?? []).map((child) => schema.nodeFromJSON(child));
}

/** 某段文本里第 offset 个字的位置。找不到返回 -1。 */
function posInText(doc: PMNode, needle: string, offset = 0): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found !== -1) return false;
    if (node.isText && node.text !== undefined) {
      const at = node.text.indexOf(needle);
      if (at !== -1) {
        found = pos + at + offset;
        return false;
      }
    }
    return true;
  });
  return found;
}

/**
 * 照抄 `@tiptap/core` dist:704–745 的分支，返回实际用的路径与事务。
 *
 * 返回值里的 `path` 就是判断"块级插入到底可不可行"的凭据：
 * `insert-text` 说明内容全是纯文本（TipTap 自己降级了），
 * `replace-with` 才是块级路径。
 */
function insertLikeTipTap(
  state: EditorState,
  pos: number,
  nodes: PMNode[],
): { path: 'insert-text' | 'replace-with'; tr?: Transaction; error?: unknown } {
  const isOnlyTextContent = nodes.every((node) => node.isText && node.marks.length === 0);
  const tr = state.tr;
  let from = pos;
  let to = pos;

  if (isOnlyTextContent) {
    tr.insertText(nodes.map((node) => node.text ?? '').join(''), from, to);
    return { path: 'insert-text', tr };
  }

  const isOnlyBlockContent = nodes.every((node) => node.isBlock);
  if (from === to && isOnlyBlockContent) {
    const { parent } = tr.doc.resolve(from);
    if (parent.isTextblock && !parent.type.spec.code && !parent.childCount) {
      from -= 1;
      to += 1;
    }
  }
  const $from = tr.doc.resolve(from);
  const $fromNode = $from.node();
  const fromSelectionAtStart = $from.parentOffset === 0;
  const isTextSelection = $fromNode.isText || $fromNode.isTextblock;
  const hasContent = $fromNode.content.size > 0;
  if (fromSelectionAtStart && isTextSelection && hasContent && isOnlyBlockContent) from -= 1;

  try {
    tr.replaceWith(from, to, nodes);
    return { path: 'replace-with', tr };
  } catch (error) {
    return { path: 'replace-with', error };
  }
}

/**
 * 把 catch 到的任意值变成一句能读的话。
 *
 * 不能用 `String(value)`：值是对象时会得到 `[object Object]`，
 * 而这条断言的全部意义就是"让失败时看得见原因"。ESLint 的
 * `no-base-to-string` 拦的正是这个。
 */
function describeError(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

const CHAPTER = [
  '# 第一章 夜行',
  '',
  '他在云京的夜里走着，风把灯笼吹得晃。',
  '',
  '末尾一段。',
].join('\n');

describe('生成文本 → 可插入节点的形状', () => {
  it('多段续写产出的是块级节点（段落）', () => {
    const nodes = nodesOf('第一段续写。\n\n第二段续写。');
    expect(nodes.length).toBe(2);
    expect(nodes.every((node) => node.isBlock)).toBe(true);
    expect(nodes.map((node) => node.type.name)).toEqual(['paragraph', 'paragraph']);
  });

  it('带 markdown 标记的续写会被解析成真实结构，而不是原样字符', () => {
    const nodes = nodesOf('他**说**了一句。\n\n> 引用');
    const names = new Set<string>();
    for (const node of nodes) {
      node.descendants((child) => {
        for (const mark of child.marks) names.add(mark.type.name);
        return true;
      });
    }
    expect(names.has('bold')).toBe(true);
    expect(nodes.some((node) => node.type.name === 'blockquote')).toBe(true);
  });

  it('白名单外的语法（列表）不会造出编辑器认不得的节点', () => {
    // 关键：`fromMd` 会把它降级，绝不能产出 `bulletList` 这种编辑器没加载的节点，
    // 否则插进去就是一个 schema 不认识的结构。
    const nodes = nodesOf('- 一\n- 二');
    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) {
      expect(() => node.check()).not.toThrow();
      expect(schema.nodes[node.type.name]).toBeDefined();
    }
  });
});

describe('落笔位置：把块级内容插到段落中间（探针主体）', () => {
  it('光标在段落**中间**时，replaceWith 能自动拆段而不是抛错', () => {
    const state = stateOf(CHAPTER);
    const pos = posInText(state.doc, '夜里走着', 2);
    expect(pos).toBeGreaterThan(0);

    const result = insertLikeTipTap(state, pos, nodesOf('第一段。\n\n第二段。'));

    if (result.error !== undefined) {
      // 这条分支出现即说明"块级插入不可行"，落笔必须退到纯文本方案。
      // 把错误内容打出来（`-t` 只影响是否输出 stdout，断言信息永远可见）。
      expect.fail(`块级插入在段落中间失败：${describeError(result.error)}`);
    }
    expect(result.path).toBe('replace-with');
    const after = result.tr?.doc;
    expect(after).toBeDefined();
    // 拆段之后：原文被切成"他在云京的" + [生成的第一段 / 生成的第二段] + "风把灯笼吹得晃。"
    const text = after?.textContent ?? '';
    expect(text).toContain('第一段。');
    expect(text).toContain('第二段。');
    expect(text).toContain('他在云京的');
    expect(text).toContain('风把灯笼吹得晃。');
  });

  it('光标落在**空段落**里时，TipTap 会整段替换掉那个空段落', () => {
    // 空段落**必须手工造**：`fromMd` 不会为尾随空行产出空段落（见下面那条用例）。
    const state = EditorState.create({
      doc: schema.nodeFromJSON({
        type: 'doc',
        content: [
          { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: '第一章' }] },
          { type: 'paragraph', content: [{ type: 'text', text: '前面一段。' }] },
          { type: 'paragraph' },
        ],
      }),
    });
    const empty = firstEmptyParagraphPos(state.doc);
    expect(empty).toBeGreaterThan(0);

    const result = insertLikeTipTap(state, empty, nodesOf('续写一段。'));
    expect(result.error).toBeUndefined();
    const text = result.tr?.doc.textContent ?? '';
    expect(text).toContain('续写一段。');
    expect(text).toContain('前面一段。');
    // 尾部不该再留一个空段落（那正是 `from-1/to+1` 那两行在防的事）
    const last = result.tr?.doc.lastChild;
    expect(last?.type.name).toBe('paragraph');
    expect(last?.textContent).toBe('续写一段。');
  });

  it('`fromMd` 的产出**永远是块级**，所以落笔一定走 replaceWith 分支', () => {
    // 这条反直觉，值得钉住：我原以为"短句没有换行 → 会产出 text 节点 → 走 TipTap 的
    // insertText 稳路"，实测不是 —— `fromMd()` 一定包一层 `paragraph`。
    // 后果：`features/ai` 的落笔**只有** replaceWith 一条路，没有"纯文本降级"可用，
    // 所以上面那条"段落中间能拆段"的结论是这条链路的**必要前提**，不是可选项。
    const nodes = nodesOf('接一句');
    expect(nodes.length).toBe(1);
    expect(nodes[0]?.type.name).toBe('paragraph');
    expect(nodes.every((node) => node.isBlock)).toBe(true);

    const state = stateOf(CHAPTER);
    const pos = posInText(state.doc, '夜里走着', 2);
    expect(insertLikeTipTap(state, pos, nodes).path).toBe('replace-with');
  });
});

function firstEmptyParagraphPos(doc: PMNode): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found !== -1) return false;
    if (node.type.name === 'paragraph' && node.childCount === 0) {
      found = pos + 1;
      return false;
    }
    return true;
  });
  return found;
}
