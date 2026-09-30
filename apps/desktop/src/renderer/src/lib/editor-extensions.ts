/**
 * 编辑器扩展集 —— 必须与 `@inkstone/shared` 的 `md-schema.ts` 白名单**严格一致**。
 *
 * 这是"白名单外语法在应用内根本产生不出来"的落实点（03 文档 §5.7 的约束）：
 * 编辑器不加载 List / CodeBlock / Link / Image / Table / Underline / Strike，
 * 用户就**没办法**在正文里造出解析器不认识的结构，于是"编辑器里看着正常、
 * 存盘再打开变了"这条最恶心的 bug 路径从源头被切断。
 *
 * 一致性由 `assertExtensionsMatchWhitelist()` 在模块加载时检查，并由
 * `test/editor-extensions.test.ts` 断言。**新增扩展 = 新增白名单语法**，
 * 必须同步改 schema、序列化、往返测试 —— 这个断言就是提醒你别只改一处。
 *
 * ⚠️ 断言比对的期望值**直接取自 `@inkstone/shared`**（`ALLOWED_BLOCK_NODES` /
 * `ALLOWED_MARK_NAMES`），本文件不再留第二份手抄副本。原先这里写死一个
 * `WHITELIST_BLOCK_NAMES`，看着"也在比对白名单"，但那份副本自己会跟着漂移 ——
 * 真源改了、副本没改，断言照样通过，等于没查（`docs/13` M25）。
 *
 * ## 与设计文档的一处偏离（已确认为文档笔误）
 *
 * §6.2 给出的扩展列表是：Document / Paragraph / Text / Bold / Italic / Blockquote /
 * HorizontalRule / History / Placeholder —— **漏了 Heading**。
 * 而同一份文档 §5.1 的白名单和 §5.7 的 schema 都把 `heading` 当作一等公民。
 *
 * 按 §5.1/§5.7 实现（即加载 Heading），理由：不加载它的后果不是"少个功能"，
 * 而是**已有稿件里的 `# 第一章` 会被编辑器视为非法节点而丢弃或报错**，
 * 直接踩中"重开之后内容变了"这条底线。§6.2 应为笔误。
 */

import { Blockquote } from '@tiptap/extension-blockquote';
import { Bold } from '@tiptap/extension-bold';
import { Document } from '@tiptap/extension-document';
import { Heading } from '@tiptap/extension-heading';
import { History } from '@tiptap/extension-history';
import { HorizontalRule } from '@tiptap/extension-horizontal-rule';
import { Italic } from '@tiptap/extension-italic';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Placeholder } from '@tiptap/extension-placeholder';
import { Text } from '@tiptap/extension-text';
import type { AnyExtension, Extensions } from '@tiptap/core';
import {
  ALLOWED_BLOCK_NODES,
  ALLOWED_MARK_NAMES,
  DOC_NODE_NAME,
  HEADING_LEVELS,
  TEXT_NODE_NAME,
} from '@inkstone/shared';

export function createEditorExtensions(placeholder = '开始写……'): Extensions {
  const extensions: Extensions = [
    Document,
    Paragraph,
    Text,
    Heading.configure({ levels: [...HEADING_LEVELS] }),
    Bold,
    Italic,
    Blockquote,
    HorizontalRule,
    // 明确不加载：BulletList / OrderedList / ListItem / CodeBlock / Code / Link /
    // Image / Table / Underline / Strike / HardBreak。
    // 它们都在 DEGRADABLE_SYNTAX 里 —— 已有稿件里出现时按纯文本保留并告警。
    History,
    Placeholder.configure({ placeholder }),
  ];
  assertExtensionsMatchWhitelist(extensions);
  return extensions;
}

/** 编辑器里实际生效的节点名 / 标记名，供一致性断言与测试使用。 */
export function describeExtensionSchema(extensions: Extensions): {
  nodes: string[];
  marks: string[];
  others: string[];
} {
  const nodes: string[] = [];
  const marks: string[] = [];
  const others: string[] = [];
  for (const ext of extensions as AnyExtension[]) {
    const name = ext.name;
    if (ext.type === 'node') nodes.push(name);
    else if (ext.type === 'mark') marks.push(name);
    else others.push(name);
  }
  return { nodes: nodes.sort(), marks: marks.sort(), others: others.sort() };
}

/**
 * 断言"编辑器扩展集 == 语法白名单"。
 *
 * 期望值取自 shared 真源，不是本文件的副本 —— 这样"真源改了、编辑器没跟"
 * 与"编辑器改了、真源没跟"两个方向都会当场抛错。
 *
 * 抛出而不是 console.warn：不一致时编辑器会产生适配层解析不了的结构，
 * 而这个后果是**静默丢用户正文**。宁可让它开不起来 —— 开发态立刻发现，
 * 也好过上线后由用户来发现。
 */
export function assertExtensionsMatchWhitelist(extensions: Extensions): void {
  const { nodes, marks } = describeExtensionSchema(extensions);

  // `doc` / `text` 是 ProseMirror 的结构节点，不在"块级语法"白名单里，单独补上。
  const expectedNodes = [...ALLOWED_BLOCK_NODES, DOC_NODE_NAME, TEXT_NODE_NAME].sort();
  const expectedMarks = [...ALLOWED_MARK_NAMES].sort();

  assertSameSet('节点', nodes, expectedNodes);
  assertSameSet('行内标记', marks, expectedMarks);
}

function assertSameSet(label: string, actual: string[], expected: string[]): void {
  const missing = expected.filter((name) => !actual.includes(name));
  const extra = actual.filter((name) => !expected.includes(name));
  if (missing.length === 0 && extra.length === 0) return;
  throw new Error(
    `编辑器扩展集与 md-schema 白名单不一致（${label}）：` +
      `${missing.length > 0 ? ` 缺少 ${missing.join('、')}` : ''}` +
      `${extra.length > 0 ? ` 多出 ${extra.join('、')}` : ''}。` +
      `两边必须同源 —— 见 packages/shared/src/md-schema.ts 的说明。`,
  );
}
