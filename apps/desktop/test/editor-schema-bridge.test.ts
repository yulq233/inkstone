/**
 * 适配层与编辑器 schema 的**接缝**测试（`05` 坑 #2 的实证）。
 *
 * 设计文档 §2 坑 #2 的结论是"可以直接把 `fromMd()` 的 PMNode 传给 `setContent`，
 * 不需要 `toJSON()`"。读源码后这个结论**不成立**，这个文件就是证据：
 *
 * - `@tiptap/core` 的 `isProseMirrorContent()` 判的是"有没有 `nodesBetween` 方法"，
 *   所以**任何** schema 造出的 PMNode 都会被原样放行，绕过编辑器 schema 的校验；
 * - `prosemirror-model` 的 `ContentMatch.matchType()` 用的是 `==`（**身份**比较），
 *   不是按节点名比较。适配层的 `inkstoneSchema` 与 TipTap 的是两个 `Schema` 实例，
 *   同名节点类型对象互不相等 → 内容校验必然失败。
 *
 * 失败的样子不是"报个错"，而是节点带着**外来 schema 的 type** 留在文档里，
 * 后续每次编辑都可能踩到身份比较。所以 `setMarkdown` 一律走 `doc.toJSON()`，
 * 交给编辑器自己的 schema 重建节点。
 */

import { describe, expect, it } from 'vitest';
import { getSchema } from '@tiptap/core';
import { fromMd, inkstoneSchema, toMd } from '@inkstone/md-adapter';

import { createEditorExtensions } from '../src/renderer/src/lib/editor-extensions';

const editorSchema = getSchema(createEditorExtensions());

const SAMPLE = [
  '# 第一章 夜行',
  '',
  '他**说**了：*云京*的风很大。',
  '',
  '> 引用一段',
  '',
  '---',
  '',
].join('\n');

describe('适配层 schema 与编辑器 schema 是两份实例', () => {
  it('节点名一致，但类型对象不是同一个', () => {
    expect(editorSchema.nodes.doc).toBeDefined();
    expect(inkstoneSchema.nodes.doc).toBeDefined();
    expect(editorSchema.nodes.doc).not.toBe(inkstoneSchema.nodes.doc);
    expect(editorSchema.nodes.heading.name).toBe('heading');
    expect(editorSchema.marks.bold.name).toBe('bold');
  });
});

describe('PMNode 直传 vs JSON 中转', () => {
  const { doc } = fromMd(SAMPLE);

  it('把适配层的 PMNode 直接塞进编辑器 schema 会被内容校验拒绝', () => {
    // 这一条就是"必须走 toJSON()"的理由。它一旦不再抛错，说明 TipTap 或
    // prosemirror-model 改了匹配策略 —— 那时可以重新评估，但别默默删掉这条断言。
    expect(() => editorSchema.nodes.doc.createChecked(null, doc.content)).toThrow();
  });

  it('走 JSON 中转，编辑器 schema 能重建出结构等价的文档', () => {
    const converted = editorSchema.nodeFromJSON(doc.toJSON());

    expect(converted.type.name).toBe('doc');
    expect(converted.childCount).toBe(doc.childCount);
    expect(converted.textContent).toBe(doc.textContent);
    // 行内标记也在：加粗 / 斜体各一处
    const names = new Set<string>();
    converted.descendants((node) => {
      for (const mark of node.marks) names.add(mark.type.name);
      return true;
    });
    expect([...names].sort()).toEqual(['bold', 'italic']);
  });

  it('编辑器 schema 造出的文档能被 toMd 原样序列化回来（往返稳定）', () => {
    const converted = editorSchema.nodeFromJSON(fromMd(SAMPLE).doc.toJSON());
    const once = toMd(converted).markdown;

    // 结构逐块都在。刻意不写死整串字面量：`toMd` **不在块之间插空行**
    // （方言里"一行即一段"，空行只是分隔符，插进去反而是多余字符），
    // 写死字面量只会把"我以为的格式"固化下来。
    expect(once).toContain('# 第一章 夜行');
    expect(once).toContain('他**说**了：*云京*的风很大。');
    expect(once).toContain('> 引用一段');
    expect(once).toContain('---');

    // "往返稳定"的正确定义：再解析、再序列化不再漂移
    expect(toMd(fromMd(once).doc).markdown).toBe(once);

    // 全程走编辑器 schema 也得到同一个结果 —— 这条才是"两个方向都接通了"
    const reconverted = editorSchema.nodeFromJSON(fromMd(once).doc.toJSON());
    expect(toMd(reconverted).markdown).toBe(once);
  });
});
