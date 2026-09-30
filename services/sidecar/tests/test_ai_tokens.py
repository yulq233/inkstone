"""token 估算与截断（``ai/tokens.py``）。

这一份测的重点不是"估得准不准"（它本来就只是个估），而是**两条不变式**：

1. ``estimate_tokens(truncate_xxx(t, n)) <= n`` —— 截断与估算共用同一套走法。
   两处各写一套"怎么数"时，会出现"截完反而超预算"，而那只在预算刚好卡边界时出现。
2. 方向正确：``truncate_tail`` 留的是**结尾**（续写要的是最近写的那段），
   ``truncate_head`` 留的是**开头**（参考资料要的是前几行）。
   这两条一旦写反，症状是"模型接的是半天前的情节"，而错误信息里一个字都不会提。
"""

from __future__ import annotations

import pytest

from inkstone.ai.tokens import estimate_tokens, truncate_head, truncate_tail

#: 覆盖中英混排、标点、空白、扩展区汉字、emoji、全角字符。
SAMPLES = [
    "",
    "   ",
    "你好",
    "hello world",
    "Hello, world.",
    "他说：“今天就走。”",
    "第 3 章 · 云京",
    "㐀㞂𠀋",  # 扩展 A / 扩展 B 汉字
    "他笑了 🙂 然后转身。",
    "mixed 中英 text with 123 numbers and — dashes",
    "a" * 200,
    "字" * 200,
    "。，、！？；：" * 40,
]


class TestEstimate:
    def test_empty_is_zero_not_one(self) -> None:
        # 空串算 0 而不是 1：它会被 plan_blocks 用来判"这块不算块"。
        assert estimate_tokens("") == 0

    def test_whitespace_costs_nothing(self) -> None:
        assert estimate_tokens("   \n\t  ") == 0

    def test_cjk_counts_per_character(self) -> None:
        assert estimate_tokens("你好世界") == 4

    def test_latin_counts_per_word(self) -> None:
        # "Hello, world." → Hello(1) + ,(1) + world(1) + .(1)
        assert estimate_tokens("Hello, world.") == 4
        assert estimate_tokens("hello world") == 2

    @pytest.mark.parametrize("text", ["㐀", "㞂", "\U0002000b", "豈"])
    def test_extended_cjk_is_recognised(self, text: str) -> None:
        # 生僻字用于人名。漏掉扩展区的话它们会被当"其它非空白"算 1 —— 数值一样，
        # 但下一个读代码的人会以为这里没有处理过扩展区。
        assert estimate_tokens(text) == 1

    def test_monotonic_in_length(self) -> None:
        assert estimate_tokens("你好") <= estimate_tokens("你好世界")


class TestTruncate:
    @pytest.mark.parametrize("text", SAMPLES)
    @pytest.mark.parametrize("limit", [0, 1, 3, 10, 64, 200])
    def test_result_is_within_limit(self, text: str, limit: int) -> None:
        """**核心不变式**：截断的产出必须真的在限额内。"""
        assert estimate_tokens(truncate_tail(text, limit)) <= limit
        assert estimate_tokens(truncate_head(text, limit)) <= limit

    @pytest.mark.parametrize("text", SAMPLES)
    @pytest.mark.parametrize("limit", [0, 1, 3, 10, 64, 200])
    def test_short_text_passes_through_unchanged(self, text: str, limit: int) -> None:
        if estimate_tokens(text) <= limit:
            assert truncate_tail(text, limit) == text
            assert truncate_head(text, limit) == text

    def test_tail_keeps_the_end(self) -> None:
        # 续写要接着写，所以留下的是**最后**那段。
        text = "开头在很远的地方。" + "中间拖得很长。" * 20 + "结尾就在眼前。"
        assert truncate_tail(text, 10).endswith("结尾就在眼前。")

    def test_head_keeps_the_beginning(self) -> None:
        text = "开头就在眼前。" + "中间拖得很长。" * 20 + "结尾在很远的地方。"
        assert truncate_head(text, 10).startswith("开头就在眼前。")

    def test_tail_strips_leading_whitespace(self) -> None:
        # 截在空格上会留下一个前导空格，模型接着写时会多出一个空格。
        text = "前面一段话。" * 10 + " 后半段。"
        assert not truncate_tail(text, 4).startswith(" ")

    def test_head_strips_trailing_whitespace(self) -> None:
        text = "前面一段话。  " + "后半段。" * 20
        assert not truncate_head(text, 6).endswith(" ")

    def test_zero_limit_is_empty(self) -> None:
        assert truncate_tail("有内容", 0) == ""
        assert truncate_head("有内容", 0) == ""

    def test_empty_text_stays_empty(self) -> None:
        assert truncate_tail("", 100) == ""
        assert truncate_head("", 100) == ""
