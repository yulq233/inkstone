/**
 * 语法白名单 —— **唯一真源**。
 *
 * 编辑器扩展集、ProseMirror schema、Markdown 解析/序列化三方都必须与这里一致。
 * 任何一方漂移，症状都是"编辑器里看着正常，存盘再打开就变了"这类极难查的 bug。
 * 所以这里只放事实，不放行为：具体解析在 `packages/md-adapter`。
 *
 * 节点/标记名沿用 **TipTap 运行时的名字**（`horizontalRule` / `bold` / `italic`），
 * 而不是另起一套语义名。理由：转换出来的文档要直接喂给 TipTap 的 `setContent`，
 * 名字不同就得靠 `extend({ name })` 硬改，一旦 TipTap 升级改了内部结构就会静默错位。
 * 一个名字比一层映射脆弱得多。
 *
 * 详见 docs/03-M0-详细设计.md §5.1 / §5.7。
 */

/** 文档根节点名 */
export const DOC_NODE_NAME = 'doc';

/** 行内文本节点名 */
export const TEXT_NODE_NAME = 'text';

/** 允许的块级节点 */
export const ALLOWED_BLOCK_NODES = [
  'paragraph',
  'heading',
  'blockquote',
  'horizontalRule',
] as const;

/** 允许的行内标记 */
export const ALLOWED_MARK_NAMES = ['bold', 'italic'] as const;

/** 标题只到 3 级：再深的层级在小说里没有意义，多一级就多一种往返出错的可能。 */
export const HEADING_LEVELS = [1, 2, 3] as const;

/** 分隔线的规范写法 */
export const THEMATIC_BREAK = '---';

/** 引用行前缀 */
export const BLOCKQUOTE_PREFIX = '>';

/** 加粗 / 斜体的分隔符。斜体刻意只用 `*` 不用 `_` —— 见 `normalize.ts` 的说明。 */
export const BOLD_DELIMITER = '**';
export const ITALIC_DELIMITER = '*';

/** 块级语法 → Markdown 写法（文档与测试共用） */
export const BLOCK_SYNTAX: Record<(typeof ALLOWED_BLOCK_NODES)[number], string> = {
  paragraph: '纯文本行（一行即一段）',
  heading: 'ATX 标题：`# ` / `## ` / `### `（不支持 setext）',
  blockquote: '引用：行首 `> `',
  horizontalRule: '独占一行的 `---`',
};

/** 行内标记 → Markdown 写法 */
export const MARK_SYNTAX: Record<(typeof ALLOWED_MARK_NAMES)[number], string> = {
  bold: '`**粗体**`',
  italic: '`*斜体*`',
};

/**
 * 明确不支持、遇到时降级为纯文本的语法。
 * 这份清单是给用户看的（"检测到 N 处不支持的格式，已保留为纯文本"），
 * 也是给测试用的（每一类都要有一条"内容不丢"的用例）。
 */
export const DEGRADABLE_SYNTAX = [
  '有序列表',
  '无序列表',
  '表格',
  '代码块',
  '行内代码',
  '链接',
  '图片',
  'HTML 标签',
  '脚注',
  '链接定义',
  '四级及更深标题',
  'setext 标题',
  '硬换行',
] as const;

/** 全部允许的节点与标记名，供"编辑器扩展集 == 白名单"的一致性检查使用 */
export const INKSTONE_ALLOWED_NAMES = [
  ...ALLOWED_BLOCK_NODES,
  ...ALLOWED_MARK_NAMES,
] as const;
