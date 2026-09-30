/**
 * "编辑器扩展集 == 语法白名单" 的一致性断言（03 文档 §5.7 明确要求）。
 *
 * 这是 5.1 验收（「无法输入白名单外语法的内容」）的静态一半：
 * 另一半是运行时行为，但那一半建立在"扩展根本没加载"之上。
 */

import { describe, expect, it } from 'vitest';

import { DOC_NODE_NAME, TEXT_NODE_NAME } from '@inkstone/shared';
import type { Extensions } from '@tiptap/core';

import {
  assertExtensionsMatchWhitelist,
  createEditorExtensions,
  describeExtensionSchema,
} from '../src/renderer/src/lib/editor-extensions';

/** 明确禁止加载的扩展（§6.2 的"不加载"清单 + DEGRADABLE_SYNTAX 里的对应项）。 */
const FORBIDDEN = [
  'bulletList',
  'orderedList',
  'listItem',
  'taskList',
  'codeBlock',
  'code',
  'link',
  'image',
  'table',
  'tableRow',
  'tableCell',
  'underline',
  'strike',
  'hardBreak',
  'highlight',
];

describe('编辑器扩展集与白名单一致', () => {
  it('默认扩展集自身通过一致性断言（不一致会抛错）', () => {
    expect(() => createEditorExtensions()).not.toThrow();
  });

  it('生效的节点与标记恰好等于白名单', () => {
    const { nodes, marks } = describeExtensionSchema(createEditorExtensions());

    // ⚠️ 这里的清单**有意手抄**，不用 shared 的 `ALLOWED_BLOCK_NODES` /
    // `ALLOWED_MARK_NAMES` 真源 —— 生产侧那条断言（`assertExtensionsMatchWhitelist`）
    // 已经拿真源比过了，这里再比一遍真源只会重复它、不会多查任何东西。
    // 手抄的增量在另一边：它还能抓住「**两边一起改**」—— 真源与编辑器同时加了
    // 一个节点时，生产断言恰好通过，只有这份冻结清单会失败，逼你回到
    // editor-extensions.ts 头注那句「新增扩展 = 新增白名单语法，还要同步序列化与往返测试」。
    expect(nodes).toEqual(
      [
        'blockquote',
        DOC_NODE_NAME,
        'heading',
        'horizontalRule',
        'paragraph',
        TEXT_NODE_NAME,
      ].sort(),
    );
    expect(marks).toEqual(['bold', 'italic']);
  });

  it('白名单外的扩展一个都没加载', () => {
    const { nodes, marks } = describeExtensionSchema(createEditorExtensions());
    const loaded = new Set([...nodes, ...marks]);

    for (const name of FORBIDDEN) {
      expect(loaded.has(name), `${name} 不该被加载`).toBe(false);
    }
  });

  it('History / Placeholder 是行为类扩展，不参与 schema', () => {
    const { nodes, marks, others } = describeExtensionSchema(createEditorExtensions());
    // 注意 History 的**运行时名是 `undoRedo`**：v3 里这个扩展内部叫 UndoRedo，
    // `History` 只是包对外的旧名字（`@tiptap/extension-history` 的 default 导出才是 UndoRedo）。
    // 名字对不上不影响功能 —— 它本来就不参与 schema 比对 —— 但写测试时容易踩。
    expect(others).toEqual(['placeholder', 'undoRedo']);
    // 它们不能混进白名单比对，否则断言会永远失败。
    expect(nodes).not.toContain('undoRedo');
    expect(marks).not.toContain('placeholder');
  });

  it('多加载一个节点扩展会被断言拦下', () => {
    const withExtra = [
      ...createEditorExtensions(),
      { name: 'bulletList', type: 'node' },
    ] as unknown as Extensions;

    expect(() => assertExtensionsMatchWhitelist(withExtra)).toThrow(/bulletList/);
  });

  it('少加载一个标记扩展会被断言拦下', () => {
    const withoutItalic = createEditorExtensions().filter(
      (ext) => (ext as { name?: string }).name !== 'italic',
    ) as Extensions;

    expect(() => assertExtensionsMatchWhitelist(withoutItalic)).toThrow(/italic/);
  });
});
