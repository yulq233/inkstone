/**
 * 归一化。
 *
 * 目标：把同一段内容的不同"写法差异"抹平成唯一形式，使得
 * "加载 → 规范化一次 → 之后不再漂移"成立（docs/03 §5.2 / §5.3）。
 *
 * **偏离设计文档 §5.2 第 7 步的一处决定**：文档要求 `__`→`**` 且 `_`→`*`。
 * 这里只做 `__`→`**`，**不做 `_`→`*`**。原因很具体：本文法只把 `*` 当强调符，
 * 于是 `_` 天然是普通字符。而中文技术流写作里 `snake_case`、`file_name`、
 * `__init__` 这类标识符很常见，把 `_` 改写成 `*` 会把 `file_name` 变成
 * `file*name` —— 这不是"统一标记"，是**静默改坏用户正文**。
 * `_斜体_` 的代价是显示为字面量（可见、无损、用户可自行改成 `*`），比改坏标识符轻得多。
 */

import { BOLD_DELIMITER, THEMATIC_BREAK } from '@inkstone/shared';

/**
 * 归一化之后的一行，附带它在**原文**里的起点。
 *
 * `origin === -1` 表示这一行是归一化凭空补出来的（标题/分隔线前后那个空行）——
 * 它在原文里没有对应内容，任何偏移计算都该跳过它。
 */
export interface NormalizedLine {
  text: string;
  origin: number;
}

/** 标题：只认 ATX（`#` 开头 + 至少一个空白），不认 setext。 */
const ATX_HEADING = /^#{1,3}[ \t]/;

/** 分隔线：整行只有 3 个以上短横。 */
const THEMATIC_LINE = /^-{3,}$/;

/**
 * `__强调__` → `**强调**`。
 *
 * 刻意加了三道限制，都是为了"只改真正想表达强调的地方"：
 * - 两端必须在词边界上 —— CommonMark 同样不把 `a__b__` 当强调，这里保持一致；
 * - 内容不能含 `_` 或 `*`，两端紧贴非空白 —— 挡掉 `___x___` 这类想太多的写法。
 *
 * 已知后果：`__init__` 会被当成强调改写成 `**init**`。对小说正文来说这个交换划算，
 * 且它是**幂等**的（改完不再变），不会来回抖。
 */
const DUNDER_EMPHASIS = /(?<![\w])__(?=[^\s_*])([^_*]*[^\s_*])__(?![\w])/g;

/**
 * 把连续空行压成最多一个，并去掉首尾空行。
 *
 * 单独抽出来是因为"插入空行"和"压缩空行"会互相打架：
 * 给标题加空行可能产生三个连续换行，必须再压一次才幂等。
 */
function collapseBlankLines(lines: NormalizedLine[]): NormalizedLine[] {
  const collapsed: NormalizedLine[] = [];
  for (const line of lines) {
    if (line.text === '' && collapsed.at(-1)?.text === '') continue;
    collapsed.push(line);
  }
  while (collapsed[0]?.text === '') collapsed.shift();
  while (collapsed.at(-1)?.text === '') collapsed.pop();
  return collapsed;
}

/**
 * 按**原文**切行，并记住每行在原文里的起点。
 *
 * ⚠️ 刻意**不用** `split(/\r\n|\r|\n/)` 再按 `+1` 累加起点：`\r\n` 是**两个**字符，
 * 而 `split` 不告诉你分隔符有多长 —— 按 +1 累加会让后面每一行都差一位，
 * 症状是"告警摘录串到相邻行"。所以手动扫，用 `match[0].length` 推进。
 */
function splitWithOrigins(markdown: string): NormalizedLine[] {
  const lines: NormalizedLine[] = [];
  const separator = /\r\n|\r|\n/g;
  let start = 0;
  let match = separator.exec(markdown);
  while (match !== null) {
    lines.push({ text: markdown.slice(start, match.index), origin: start });
    start = match.index + match[0].length;
    match = separator.exec(markdown);
  }
  lines.push({ text: markdown.slice(start), origin: start });
  return lines;
}

/**
 * 归一化的**逐行版本**：返回结果的同时，把"这一行是从原文哪一行来的"带出来。
 *
 * 为什么要它（`docs/13` M26）：`fromMd` 的降级告警带 `from`/`to` 偏移，界面据此
 * 从原文里切片给用户看。而归一化会增删字符（BOM、`\r\n`、行尾空白、补空行），
 * 只拿"归一化之后的下标"去切**原文**必然错位 —— 摘录会串到相邻行上，
 * 严重时切出半行。所以偏移必须回到原文坐标，而只有在这里才知道映射关系。
 */
export function normalizeToLines(markdown: string): NormalizedLine[] {
  const raw = splitWithOrigins(markdown);

  // 1. 去掉 BOM（外部编辑器另存为 UTF-8 时经常带上）。
  //    只认**第一个字符**：原来是在拼好的整串上判 `charCodeAt(0)`，
  //    效果一样，但这里必须顺手把该行的起点往后挪一位。
  if (raw.length > 0 && raw[0].text.charCodeAt(0) === 0xfeff) {
    raw[0] = { text: raw[0].text.slice(1), origin: 1 };
  }

  // 2. 换行统一为 LF —— 已经在切行时完成（形状上不再有 `\r`）
  // 3. 行尾空白 + 4. 强调标记统一
  const trimmed = raw.map((line) => ({
    origin: line.origin,
    text: line.text
      .replace(/[ \t]+$/, '')
      .replace(DUNDER_EMPHASIS, `${BOLD_DELIMITER}$1${BOLD_DELIMITER}`),
  }));

  // 5/6. 标题与分隔线前后各保证一个空行；分隔线统一写法。
  //      补出来的空行 `origin: -1` —— 它在原文里没有对应行。
  const spaced: NormalizedLine[] = [];
  for (const line of trimmed) {
    if (ATX_HEADING.test(line.text) || THEMATIC_LINE.test(line.text)) {
      if (spaced.length > 0 && spaced.at(-1)?.text !== '') spaced.push({ text: '', origin: -1 });
      spaced.push(
        THEMATIC_LINE.test(line.text) ? { text: THEMATIC_BREAK, origin: line.origin } : line,
      );
      spaced.push({ text: '', origin: -1 });
      continue;
    }
    spaced.push(line);
  }

  return collapseBlankLines(spaced);
}

/**
 * 幂等：`normalize(normalize(x)) === normalize(x)`。
 *
 * 步骤顺序不可换 —— 比如必须先统一换行再 trim 行尾，否则 `\r` 会被当成行尾空白的一部分。
 */
export function normalize(markdown: string): string {
  const lines = normalizeToLines(markdown);
  // 7. 末尾恰好一个换行（空文件除外）
  if (lines.length === 0) return '';
  return `${lines.map((line) => line.text).join('\n')}\n`;
}
