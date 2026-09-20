"""字数统计（双口径）。

口径（03 文档 §6.4）：
- **含标点**：非空白字符全部计 1（CJK 与拉丁字符同权）。
- **不含标点**：再排除 Unicode ``P``（标点）与 ``S``（符号）类别。

两个必须注意的点：
1. 按**码点**迭代（``for ch in text``），不要用 ``len(text)`` —— 后者算的是
   UTF-16 代理对数量，会把 emoji 与部分生僻字算成两个。
2. 全角空格 ``\\u3000`` 必须算空白，中文正文里它是真实存在的排版字符。

**这一份实现刻意不用 ``str.isspace()``**（原实现用的是它，已改掉）。
口径的真源是 03 文档 §6.4 给出的 TypeScript 写法 ``/[\\s\\u3000]/u``，
即 **ECMAScript 的空白定义**；而 ``str.isspace()`` 与它并不等价，实测有 6 个码点分歧：

===============  ==================  ==================  ==================
码点              ECMAScript ``\\s``   ``str.isspace()``   分歧后果
===============  ==================  ==================  ==================
U+001C–U+001F    False               True                后端少算 4 字
U+0085 (NEL)     False               True                后端少算 1 字
U+FEFF (BOM)     True                False               后端**多算** 1 字
===============  ==================  ==================  ==================

U+FEFF 那条是会真踩到的：正文中间混入一个零宽 BOM（从 Word/网页粘贴很常见），
于是界面显示 N 字、``meta.json`` 缓存 N+1 字，用户看到的就是"字数对不上"。
所以这里显式列出 ECMAScript 的空白码点集合，而不是依赖 `str` 的默认判断。

口径一致性由 ``packages/shared/fixtures/wordcount-cases.json`` 这份共享用例锁死：
``tests/test_wordcount.py`` 与 ``packages/shared/test/wordcount.test.ts`` 都读它、都必须全绿。
"""

from __future__ import annotations

import unicodedata
from typing import NamedTuple

# ECMAScript WhiteSpace ∪ LineTerminator（即 TS 侧 /[\s\u3000]/u 的匹配集）：
#   WhiteSpace = TAB(09) VT(0B) FF(0C) SP(20) NBSP(A0) ZWNBSP(FEFF) ∪ 全部 Zs
#   LineTerminator = LF(0A) CR(0D) LS(2028) PS(2029)
_WHITESPACE: frozenset[int] = frozenset(
    {
        0x09,
        0x0A,
        0x0B,
        0x0C,
        0x0D,
        0x20,
        0xA0,
        0xFEFF,
        0x1680,
        0x2028,
        0x2029,
        0x202F,
        0x205F,
        0x3000,
    }
) | frozenset(range(0x2000, 0x200B))  # Zs 段（含 U+2000–U+200A）


class WordCount(NamedTuple):
    with_punct: int
    without_punct: int


def count_words(text: str) -> WordCount:
    with_punct = 0
    without_punct = 0
    for ch in text:
        if ord(ch) in _WHITESPACE:
            continue
        with_punct += 1
        # category 首字母 P = 标点，S = 符号（含数学符号、货币符号、emoji 等）
        if unicodedata.category(ch)[0] not in ("P", "S"):
            without_punct += 1
    return WordCount(with_punct=with_punct, without_punct=without_punct)


def count_words_default(text: str) -> int:
    """默认口径（不含标点）—— 网文平台习惯口径，也是 meta 缓存要存的那个数。"""
    return count_words(text).without_punct
