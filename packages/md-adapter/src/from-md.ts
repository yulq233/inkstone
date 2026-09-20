/**
 * Markdown → ProseMirror。
 *
 * ## 为什么用手写解析器，而不是 remark
 *
 * 设计文档 §5.4 的方案是"用 remark 解析，再按 position 原始偏移把禁忌节点降级为段落"。
 * 实现时改成了行级手写解析，理由有两条，都是实打实的：
 *
 * 1. **三个中文坑在我们这里根本不存在，而不是"被绕过去了"。**
 *    `1. 他说`、`- 他说`、`---` 之所以在 remark 里出问题，是因为 CommonMark 认为它们是列表
 *    和 setext 下划线。我们的文法里**根本没有列表和 setext**，所以这些行天然就是段落。
 *    修一个不存在的问题，比让它不存在更贵。
 *
 * 2. **remark 的降级路径会改写字符。** 文档 §5.4 自己承认了副作用：降级行里的 `*`
 *    在序列化时会被转义成 `\*`。手写解析器只在**必要**时转义（见 `escape` 相关函数），
 *    普通正文一个字符都不动。
 *
 * 代价是：真实的富文本 Markdown（表格、代码块、链接）不会被"解析后降级"，
 * 而是**整行当纯文本**。内容不丢，结构丢了 —— 这一点通过 `AdapterWarning` 显式告知用户。
 * 对一个"正文只有段落/标题/引用/分隔线"的小说编辑器来说，这个交换是划算的。
 *
 * ## 文法（与 md-schema.ts 一致）
 *
 * ```
 * 文档     := 块*
 * 块       := 段落 | ATX标题 | 引用 | 分隔线
 * 段落     := 一行（行内*）
 * ATX标题  := "##{1,3} " 行内*
 * 引用     := 连续若干以 ">" 开头的行，剥掉前缀后递归解析
 * 分隔线   := 独占一行的 ---
 * 行内     := 文本 | 加粗 | 斜体
 * ```
 *
 * `行内` 的分隔符配对规则是**先等长、后退让**（见 `findClosingRun` 的说明）。
 * 这条规则同时满足两件事：`**粗***斜*` 这类"被拼在一起的相邻分隔符"能正确拆开，
 * 而 `*a **b** c*` 这类嵌套结构不会被提前收口。
 */

import {
  BLOCKQUOTE_PREFIX,
  DOC_NODE_NAME,
  HEADING_LEVELS,
  ITALIC_DELIMITER,
} from '@inkstone/shared';
import type { Node as PMNode } from 'prosemirror-model';

import { normalize } from './normalize';
import { emptyParagraph, inkstoneSchema } from './schema';
import type { AdapterWarning, FlatText, FromMdResult } from './types';

/** 标记的规范顺序：加粗在外、斜体在内。序列化时的开合顺序由它决定。 */
const MARK_ORDER = ['bold', 'italic'] as const;

/** 行内转义中会被识别的字符。与序列化端的转义集合必须完全一致。 */
const ESCAPABLE = '\\*#>-';

/** 标题只认 ATX，且必须带空白分隔（`#第一章` 不算标题）。 */
const ATX_HEADING = /^(#{1,6})[ \t]+(.*)$/;

/** 分隔线：整行 3 个以上短横。 */
const THEMATIC_LINE = /^-{3,}$/;

interface Line {
  text: string;
  /** 该行首字符在规范化后文本中的偏移，用于告警定位 */
  start: number;
}

interface Tok {
  ch: string;
  escaped: boolean;
}

// ---------------------------------------------------------------------------
// 降级检测
// ---------------------------------------------------------------------------

const DEGRADATION_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^[-*+][ \t]+\S/, '无序列表标记'],
  [/^\d+[.)][ \t]+\S/, '有序列表标记'],
  [/^\|.*\|[ \t]*$/, '表格行'],
  [/^(```|~~~)/, '代码块围栏'],
  [/`[^`]+`/, '行内代码'],
  [/!\[[^\]]*\]\([^)]*\)/, '图片'],
  [/\[[^\]]*\]\([^)]*\)/, '链接'],
  [/^\[\^[^\]]+\]:/, '脚注定义'],
  [/^\[[^\]]+\]:[ \t]*\S/, '链接定义'],
  [/<\/?[a-zA-Z!][^>]*>/, 'HTML 标签'],
  [/^={2,}[ \t]*$/, 'setext 标题下划线'],
];

/**
 * 找出这一行里"看起来像 Markdown 富文本、但我们只能按纯文本处理"的地方。
 *
 * 刻意**不**把"内容被改动"当成告警条件 —— 告警只在结构与用户预期不符时发出，
 * 否则每条正文都挂一串提示，提示就没价值了。
 */
function detectDegradations(line: string, start: number): AdapterWarning[] {
  const warnings: AdapterWarning[] = [];
  for (const [pattern, label] of DEGRADATION_PATTERNS) {
    if (!pattern.test(line)) continue;
    warnings.push({
      code: 'DEGRADED_BLOCK',
      message: `${label}已按纯文本保留`,
      from: start,
      to: start + line.length,
    });
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// 行内解析
// ---------------------------------------------------------------------------

function tokenize(text: string): Tok[] {
  const toks: Tok[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\' && i + 1 < text.length && ESCAPABLE.includes(text[i + 1])) {
      toks.push({ ch: text[i + 1], escaped: true });
      i += 1;
      continue;
    }
    // 反斜杠后面跟别的字符时，反斜杠本身是普通文本 —— 保证 `\x` 不会吞掉 x。
    toks.push({ ch, escaped: false });
  }
  return toks;
}

function countRun(toks: Tok[], from: number): number {
  let length = 0;
  while (from + length < toks.length && !toks[from + length].escaped && toks[from + length].ch === '*') {
    length += 1;
  }
  return length;
}

function scanForRun(toks: Tok[], from: number, accept: (runLength: number) => boolean): number {
  let i = from;
  while (i < toks.length) {
    if (toks[i].escaped || toks[i].ch !== '*') {
      i += 1;
      continue;
    }
    const run = countRun(toks, i);
    if (accept(run)) return i;
    // 跳过整个 run：否则 `**` 的第二个星会被当成新 run 的起点。
    i += run;
  }
  return -1;
}

/**
 * 找闭合分隔符。策略是**先等长、后退让**，两步都必要：
 *
 * 1. **优先等长**。`*a **b** c*`（斜体在外、加粗在内）里，若只找"长度 >= 1"的 run，
 *    会在 `**` 的第一个星上就收口，把加粗内容切到斜体外面去。等长匹配才能跳过它。
 *
 * 2. **等长找不到时退让给更长的 run**。`**粗**` 紧跟 `*斜*` 会拼成 `**粗***斜*`，
 *    两个分隔符粘成了一个三星 run。这时必须从 `***` 里只取 2 个当加粗的收尾，
 *    剩下 1 个继续当斜体的开头 —— 否则整段会被当成纯文本，**用户重开文件格式全没了**。
 *
 * 消耗的永远只有 `length` 个星号，所以 `i` 严格递增，不会打转。
 */
function findClosingRun(toks: Tok[], from: number, length: number): number {
  const exact = scanForRun(toks, from, (run) => run === length);
  if (exact !== -1) return exact;
  return scanForRun(toks, from, (run) => run > length);
}

function normalizeMarks(marks: readonly string[]): string[] {
  const unique = new Set(marks);
  return MARK_ORDER.filter((name) => unique.has(name));
}

function parseTokens(toks: Tok[]): FlatText[] {
  const out: FlatText[] = [];
  let buffer: string[] = [];

  const flush = (): void => {
    if (buffer.length === 0) return;
    out.push({ text: buffer.join(''), marks: [] });
    buffer = [];
  };

  let i = 0;
  while (i < toks.length) {
    const tok = toks[i];
    if (tok.escaped || tok.ch !== '*') {
      buffer.push(tok.ch);
      i += 1;
      continue;
    }

    const runLength = countRun(toks, i);
    const closing = findClosingRun(toks, i + runLength, runLength);
    if (closing === -1) {
      // 配不成对就是字面量。这正是 `3*4=12` 能原样保留的原因。
      buffer.push(ITALIC_DELIMITER.repeat(runLength));
      i += runLength;
      continue;
    }

    const inner = parseTokens(toks.slice(i + runLength, closing));
    const marks = runLength >= 3 ? ['bold', 'italic'] : runLength === 2 ? ['bold'] : ['italic'];
    flush();
    for (const segment of inner) {
      out.push({ text: segment.text, marks: normalizeMarks([...segment.marks, ...marks]) });
    }
    i = closing + runLength;
  }

  flush();
  return out;
}

function sameMarks(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((mark, index) => mark === b[index]);
}

/** 把平坦的文本段落成真正的 ProseMirror 行内节点，顺手合并标记相同的相邻段。 */
function toInlineNodes(flat: FlatText[]): PMNode[] {
  const merged: FlatText[] = [];
  for (const segment of flat) {
    if (segment.text === '') continue;
    const last = merged.at(-1);
    if (last !== undefined && sameMarks(last.marks, segment.marks)) {
      last.text += segment.text;
      continue;
    }
    merged.push({ text: segment.text, marks: [...segment.marks] });
  }
  return merged.map((segment) =>
    inkstoneSchema.text(
      segment.text,
      segment.marks.map((name) => inkstoneSchema.marks[name].create()),
    ),
  );
}

function parseInline(text: string): FlatText[] {
  return parseTokens(tokenize(text));
}

// ---------------------------------------------------------------------------
// 块级解析
// ---------------------------------------------------------------------------

function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let offset = 0;
  for (const raw of text.split('\n')) {
    lines.push({ text: raw, start: offset });
    offset += raw.length + 1;
  }
  return lines;
}

function parseBlocks(lines: Line[], warnings: AdapterWarning[]): PMNode[] {
  const blocks: PMNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.text.trim() === '') {
      i += 1;
      continue;
    }

    // 分隔线
    if (THEMATIC_LINE.test(line.text)) {
      blocks.push(inkstoneSchema.node('horizontalRule'));
      i += 1;
      continue;
    }

    // 标题
    const heading = ATX_HEADING.exec(line.text);
    if (heading !== null) {
      const level = heading[1].length;
      if ((HEADING_LEVELS as readonly number[]).includes(level)) {
        blocks.push(
          inkstoneSchema.node('heading', { level }, toInlineNodes(parseInline(heading[2]))),
        );
      } else {
        warnings.push({
          code: 'DEGRADED_BLOCK',
          message: `${level} 级标题超出白名单（只支持 1~3 级），已按纯文本保留`,
          from: line.start,
          to: line.start + line.text.length,
        });
        blocks.push(
          inkstoneSchema.node('paragraph', null, toInlineNodes(parseInline(line.text))),
        );
      }
      i += 1;
      continue;
    }

    // 引用：收集连续以 `>` 开头的行，剥掉前缀后递归解析
    if (line.text.startsWith(BLOCKQUOTE_PREFIX)) {
      const collected: Line[] = [];
      while (i < lines.length && lines[i].text.startsWith(BLOCKQUOTE_PREFIX)) {
        const current = lines[i];
        const stripped = current.text.replace(/^>[ \t]?/, '');
        collected.push({
          text: stripped,
          start: current.start + (current.text.length - stripped.length),
        });
        i += 1;
      }
      const inner = parseBlocks(collected, warnings);
      blocks.push(
        inkstoneSchema.node('blockquote', null, inner.length > 0 ? inner : [emptyParagraph()]),
      );
      continue;
    }

    // 其余一律是段落。以 `\` 开头的行也走这里：转义字符由行内 tokenize 还原，
    // 且它天然不会命中上面的块级判定。
    if (!line.text.startsWith('\\')) {
      warnings.push(...detectDegradations(line.text, line.start));
    }
    blocks.push(inkstoneSchema.node('paragraph', null, toInlineNodes(parseInline(line.text))));
    i += 1;
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// 公开入口
// ---------------------------------------------------------------------------

export function fromMd(markdown: string): FromMdResult {
  const text = normalize(markdown);
  const warnings: AdapterWarning[] = [];
  const blocks = parseBlocks(splitLines(text), warnings);

  const doc = inkstoneSchema.node(
    DOC_NODE_NAME,
    null,
    // `doc` 的 content 是 `block+`，零块不合法 —— 空文档给一个空段落。
    blocks.length > 0 ? blocks : [emptyParagraph()],
  );

  return { doc, warnings };
}

/** 取首个 H1 的文本；没有 H1 时返回 null。 */
export function extractTitle(markdown: string): string | null {
  for (const line of normalize(markdown).split('\n')) {
    const match = /^#[ \t]+(.*)$/.exec(line);
    if (match !== null) {
      const title = match[1].trim();
      return title === '' ? null : title;
    }
  }
  return null;
}
