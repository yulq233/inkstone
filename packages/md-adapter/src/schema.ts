/**
 * ProseMirror schema —— 与 `@inkstone/shared` 的白名单同源。
 *
 * 这份 schema 的作用不是"给编辑器用"（编辑器用 TipTap 自己那份），
 * 而是**保证适配层永远不会产出非法文档**：`nodeFromJSON` 会在结构不合法时抛错，
 * 而不是把一个坏 JSON 交给 TipTap 让它静默丢弃半个章节。
 *
 * 节点名与 TipTap 运行时一致（见 md-schema.ts 的说明），所以两边可以直接互喂 JSON。
 */

import { ALLOWED_MARK_NAMES, DOC_NODE_NAME, TEXT_NODE_NAME } from '@inkstone/shared';
import { Schema } from 'prosemirror-model';

export const inkstoneSchema = new Schema({
  nodes: {
    [DOC_NODE_NAME]: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    heading: {
      attrs: { level: { default: 1 } },
      content: 'inline*',
      group: 'block',
    },
    blockquote: { content: 'block+', group: 'block' },
    horizontalRule: { group: 'block' },
    [TEXT_NODE_NAME]: { group: 'inline' },
  },
  marks: Object.fromEntries(ALLOWED_MARK_NAMES.map((name) => [name, {}])),
});

/** 空文档也要有一个空段落 —— `doc` 的 content 是 `block+`，零块不合法。 */
export function emptyParagraph() {
  return inkstoneSchema.node('paragraph');
}
