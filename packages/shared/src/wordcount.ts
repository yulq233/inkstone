/**
 * 字数统计（双口径）—— 渲染进程的**唯一实现**。
 *
 * 口径定义见 docs/03-M0-详细设计.md §6.4：
 * - **含标点**：非空白字符全部计 1（CJK 与拉丁字符同权）。
 * - **不含标点**：再排除 Unicode `P`（标点）与 `S`（符号）类别。
 * - M0 默认展示「不含标点」，符合网文平台习惯。
 *
 * ## 为什么必须按码点迭代
 *
 * `for (const ch of text)` 走的是**码点**；`text.length` 走的是 UTF-16 码元。
 * 生僻字 `𠮷`（U+20BB7）与 emoji 在 UTF-16 里是代理对，用 `length` 会被算成 2 ——
 * 用户拿 Word 对数时会发现差了几个字，而这类差异极难定位。
 *
 * ## 与 Python 侧的一致性（重要）
 *
 * sidecar 里有一份对应的实现（`domain/wordcount.py`），它算出来的数字要写进
 * `meta.json` 的 `wordCountCache`，而界面上显示的是这一份。两份一旦漂移，
 * 症状就是「界面显示 N 字，重启后变 N+1」。
 *
 * 所以：空白定义以**本文件为准**（即 ECMAScript 的 `\s`，而非 Python 的 `str.isspace()`，
 * 两者实测有 6 个码点分歧，其中 U+FEFF 会导致后端多算 1 字），
 * 并且两份实现都必须通过 `packages/shared/fixtures/wordcount-cases.json` 里的同一批用例。
 * 改这一份之前先去看那份用例。
 */

/** 空白：ECMAScript 的 `\s` 加上显式列出的全角空格（其实 `\s` 已含 U+3000，写出来是为了自证口径）。 */
const WHITESPACE = /[\s\u3000]/u;

/** Unicode 标点（P）与符号（S）。emoji 属 S，因此只出现在「含标点」口径里。 */
const PUNCT_OR_SYMBOL = /[\p{P}\p{S}]/u;

export interface WordCount {
  /** 含标点：非空白字符数 */
  withPunct: number;
  /** 不含标点：再排除 P / S 类别 */
  withoutPunct: number;
}

export function countWords(text: string): WordCount {
  let withPunct = 0;
  let withoutPunct = 0;
  for (const ch of text) {
    if (WHITESPACE.test(ch)) continue;
    withPunct += 1;
    if (!PUNCT_OR_SYMBOL.test(ch)) withoutPunct += 1;
  }
  return { withPunct, withoutPunct };
}

/** 默认口径（不含标点）—— 与 sidecar 写入 `meta.json` 的那个数一致。 */
export function countWordsDefault(text: string): number {
  return countWords(text).withoutPunct;
}
