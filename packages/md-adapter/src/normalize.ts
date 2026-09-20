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
function collapseBlankLines(lines: string[]): string[] {
  const collapsed: string[] = [];
  for (const line of lines) {
    if (line === '' && collapsed.at(-1) === '') continue;
    collapsed.push(line);
  }
  while (collapsed[0] === '') collapsed.shift();
  while (collapsed.at(-1) === '') collapsed.pop();
  return collapsed;
}

/**
 * 幂等：`normalize(normalize(x)) === normalize(x)`。
 *
 * 步骤顺序不可换 —— 比如必须先统一换行再 trim 行尾，否则 `\r` 会被当成行尾空白的一部分。
 */
export function normalize(markdown: string): string {
  let text = markdown;

  // 1. 去掉 BOM（外部编辑器另存为 UTF-8 时经常带上）
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  // 2. 换行统一为 LF
  text = text.replace(/\r\n?/g, '\n');

  // 3. 行尾空白 + 4. 强调标记统一
  const trimmed = text.split('\n').map((line) => {
    const withoutTrailing = line.replace(/[ \t]+$/, '');
    return withoutTrailing.replace(DUNDER_EMPHASIS, `${BOLD_DELIMITER}$1${BOLD_DELIMITER}`);
  });

  // 5/6. 标题与分隔线前后各保证一个空行；分隔线统一写法。
  const spaced: string[] = [];
  for (const line of trimmed) {
    if (ATX_HEADING.test(line) || THEMATIC_LINE.test(line)) {
      if (spaced.length > 0 && spaced.at(-1) !== '') spaced.push('');
      spaced.push(THEMATIC_LINE.test(line) ? THEMATIC_BREAK : line);
      spaced.push('');
      continue;
    }
    spaced.push(line);
  }

  const lines = collapseBlankLines(spaced);

  // 7. 末尾恰好一个换行（空文件除外）
  if (lines.length === 0) return '';
  return `${lines.join('\n')}\n`;
}
