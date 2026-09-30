/**
 * `@inkstone/md-adapter` —— 正文 Markdown ↔ ProseMirror 的**唯一入口**。
 *
 * 渲染进程里任何地方读写正文都必须经过这里，不允许自己拼 Markdown 或自己解析 JSON。
 * 这不是洁癖：适配层一旦出现第二个实现，两个实现就会慢慢分叉，症状是
 * "编辑器里看着好好的，存盘再打开就变了" —— 这类 bug 极难定位。
 *
 * 语法白名单在 `@inkstone/shared` 的 `md-schema.ts`，是三方（编辑器扩展集、
 * 这份适配层、白名单常量）共享的唯一真源。
 *
 * 详见 docs/03-M0-详细设计.md §5。
 */

export const MD_ADAPTER_VERSION = 1;

export { normalize, normalizeToLines } from './normalize';
export { extractTitle, fromMd } from './from-md';
export { toMd } from './to-md';
export { emptyParagraph, inkstoneSchema } from './schema';

export type { NormalizedLine } from './normalize';
export type { AdapterWarning, FlatText, FromMdResult, ToMdResult } from './types';
