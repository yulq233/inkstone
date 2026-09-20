/**
 * ProseMirror → Markdown。
 *
 * 序列化的验收标准是"**二次往返不再漂移**"：把输出再解析一遍、再序列化，结果必须一模一样。
 * 写的时候有两类东西会破坏它，都在这一个文件里处理掉了：
 *
 * 1. **空段落 / 空标题**。我们的方言里"一行即一段、空行是分隔符"，所以空段落**根本无法表示**。
 *    序列化时直接丢掉（它不带任何内容），而不是输出一个空行 —— 输出空行会在下次解析时
 *    被当作分隔符吃掉，那才是真正的不稳定。
 *
 * 2. **行首歧义**。正文以 `---`、`# `、`>` 开头时会被块级解析器抢走。这里在**行首**加一个
 *    反斜杠来消歧；行内解析端能原样还原（见 `from-md.ts` 的 ESCAPABLE）。
 *    注意只加在行首，正文中间一个字符都不动 —— 这是"不污染用户内容"的具体含义。
 */

import {
  BLOCKQUOTE_PREFIX,
  BOLD_DELIMITER,
  DOC_NODE_NAME,
  HEADING_LEVELS,
  ITALIC_DELIMITER,
  THEMATIC_BREAK,
} from '@inkstone/shared';
import type { Node as PMNode } from 'prosemirror-model';

import { normalize } from './normalize';
import type { AdapterWarning, FlatText, ToMdResult } from './types';

/** 标记的开合顺序：加粗在外、斜体在内。与 `from-md.ts` 的 MARK_ORDER 必须一致。 */
const MARK_ORDER = ['bold', 'italic'] as const;

const DELIMITER: Record<string, string> = {
  bold: BOLD_DELIMITER,
  italic: ITALIC_DELIMITER,
};

const KNOWN_MARKS: readonly string[] = MARK_ORDER;

/** 明文里必须转义的字符：反斜杠本身，以及唯一有语义的星号。 */
function escapeInline(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\*/g, '\\*')
    // 行内换行不存在（没有加载 HardBreak），真出现就当空格，至少不把两段粘成一个词。
    .replace(/\r?\n/g, ' ');
}

/**
 * 行首消歧。只在这三种"会被块级解析器抢走"的情况下加反斜杠：
 * 整行分隔线、ATX 标题、引用行。
 *
 * 刻意**不**处理"行首是反斜杠"的情况：`\\abc` 会被行内解析器还原成 `\abc`，本来就正确，
 * 再补一个反斜杠反而会多出一个字符。
 */
function escapeLineStart(line: string): string {
  if (line === '') return line;
  if (/^-{3,}$/.test(line) || /^#{1,6}[ \t]/.test(line) || line.startsWith(BLOCKQUOTE_PREFIX)) {
    return `\\${line}`;
  }
  return line;
}

function canonicalMarks(names: readonly string[]): string[] {
  const unique = new Set(names);
  return MARK_ORDER.filter((name) => unique.has(name));
}

function flattenInline(node: PMNode, warnings: AdapterWarning[]): FlatText[] {
  const segments: FlatText[] = [];
  node.forEach((child) => {
    const rawMarks = child.marks.map((mark) => mark.type.name);
    const marks = canonicalMarks(rawMarks);
    const dropped = rawMarks.filter((name) => !KNOWN_MARKS.includes(name));
    if (dropped.length > 0) {
      warnings.push({
        code: 'UNSUPPORTED_INLINE',
        message: `行内标记 ${dropped.join('、')} 不在白名单内，已忽略（文字保留）`,
        // 输出侧没有"原文偏移"可言，用 0/0 表示"整段"。
        from: 0,
        to: 0,
      });
    }
    if (child.isText) {
      segments.push({ text: child.text ?? '', marks });
      return;
    }
    // 非文本的行内节点（不该出现）：保留其文字，宁可降级也不丢内容。
    segments.push({ text: child.textContent, marks });
  });
  return segments;
}

function emitInline(segments: FlatText[]): string {
  let out = '';
  let previous: readonly string[] = [];

  for (const segment of segments) {
    const current = canonicalMarks(segment.marks);
    // 先关掉这一段不再有的标记（逆序关，保证 `**a *b* c**` 这种嵌套收得干净）
    for (let i = previous.length - 1; i >= 0; i -= 1) {
      if (!current.includes(previous[i])) out += DELIMITER[previous[i]];
    }
    // 再打开新出现的标记（正序开，加粗在外层）
    for (const mark of current) {
      if (!previous.includes(mark)) out += DELIMITER[mark];
    }
    out += escapeInline(segment.text);
    previous = current;
  }

  for (let i = previous.length - 1; i >= 0; i -= 1) out += DELIMITER[previous[i]];
  return out;
}

function clampLevel(level: unknown, warnings: AdapterWarning[]): number {
  const numeric = typeof level === 'number' && Number.isFinite(level) ? level : 1;
  if ((HEADING_LEVELS as readonly number[]).includes(numeric)) return numeric;
  warnings.push({
    code: 'DEGRADED_BLOCK',
    message: `${numeric} 级标题不在白名单内，已按 3 级输出`,
    from: 0,
    to: 0,
  });
  return 3;
}

function renderBlock(node: PMNode, lines: string[], warnings: AdapterWarning[]): void {
  switch (node.type.name) {
    case 'paragraph': {
      // 空段落在本方言里无法表示，直接丢掉（见文件头说明）。
      if (node.content.size === 0) return;
      lines.push(escapeLineStart(emitInline(flattenInline(node, warnings))));
      return;
    }
    case 'heading': {
      if (node.content.size === 0) return;
      const level = clampLevel(node.attrs.level, warnings);
      const body = emitInline(flattenInline(node, warnings));
      lines.push(`${'#'.repeat(level)} ${body}`);
      return;
    }
    case 'horizontalRule': {
      lines.push(THEMATIC_BREAK);
      return;
    }
    case 'blockquote': {
      const inner: string[] = [];
      node.forEach((child) => renderBlock(child, inner, warnings));
      if (inner.length === 0) return;
      lines.push(
        ...inner.map((line) => (line === '' ? BLOCKQUOTE_PREFIX : `${BLOCKQUOTE_PREFIX} ${line}`)),
      );
      return;
    }
    default: {
      warnings.push({
        code: 'DEGRADED_BLOCK',
        message: `未知块级节点 ${node.type.name}，已按纯文本输出`,
        from: 0,
        to: 0,
      });
      const text = node.textContent.trim();
      if (text !== '') lines.push(escapeLineStart(escapeInline(text)));
    }
  }
}

export function toMd(doc: PMNode): ToMdResult {
  const warnings: AdapterWarning[] = [];
  const lines: string[] = [];

  if (doc.type.name === DOC_NODE_NAME) {
    doc.forEach((child) => renderBlock(child, lines, warnings));
  } else {
    renderBlock(doc, lines, warnings);
  }

  // 统一过一遍归一化：保证 toMd 的输出自身就是 normalize 的不动点，
  // 这样"再解析再序列化"必然得到同一个字符串。
  return { markdown: normalize(lines.join('\n')), warnings };
}
