"""字数统计测试（03 文档 §6.4）。

两个口径都必须测，因为网文平台普遍用"不含标点"，而用户拿 Word 对数时用的是另一边。
默认口径若与外部工具对不上，用户会认为这个字数统计是坏的。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from inkstone.domain.wordcount import WordCount, count_words, count_words_default


def test_chinese_punctuation_excluded_in_second_count() -> None:
    # 你好，世界 → 非空白 5 个（含全角逗号），去掉 Po 类标点后 4 个
    assert count_words("你好，世界") == WordCount(with_punct=5, without_punct=4)


def test_english_words_count_chars_not_lexemes() -> None:
    # "Hello world" 是 10 个非空白字符 —— 中文写作场景按字符数计，不按英文单词数计。
    assert count_words("Hello world") == WordCount(with_punct=10, without_punct=10)


def test_english_punctuation_excluded() -> None:
    assert count_words("Hi!") == WordCount(with_punct=3, without_punct=2)


def test_fullwidth_space_is_whitespace() -> None:
    # \u3000 在中文排版里是真实存在的缩进字符，绝不能算进字数。
    assert count_words("你\u3000好") == WordCount(with_punct=2, without_punct=2)


def test_emoji_counts_as_symbol_not_punctuation() -> None:
    # emoji 的 Unicode 类别是 So（符号），所以只出现在"含标点"里。
    assert count_words("你好😀") == WordCount(with_punct=3, without_punct=2)


def test_ascii_whitespace_variants_are_all_skipped() -> None:
    assert count_words("a b\tc\nd\r\ne") == WordCount(with_punct=5, without_punct=5)


def test_empty_and_whitespace_only() -> None:
    assert count_words("") == WordCount(0, 0)
    assert count_words("   \n\t\u3000") == WordCount(0, 0)


def test_mixed_chinese_digits_and_punctuation() -> None:
    # 第1章：开始 → 第 / 1 / 章 / ：/ 开 / 始 = 6，其中 ： 是 Po
    assert count_words("第1章：开始") == WordCount(with_punct=6, without_punct=5)


def test_iterates_code_points_not_utf16_units() -> None:
    """生僻字必须算 1。

    ``len()`` 在 UTF-16 语义下会把基本平面外的字算成 2 —— Python 3 的 str 是码点序列，
    所以这里天然正确；这条用例是防止有人后来改成字节级统计。
    """
    assert count_words("\U0001f600\U0001f601") == WordCount(with_punct=2, without_punct=0)


def test_default_metric_is_without_punctuation() -> None:
    assert count_words_default("你好，世界。") == 4


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("《书名》", 2),          # Ps/Pe 括号类
        ("“引号”", 2),            # Pi/Pf 引号类
        ("—破折号", 3),           # Pd 破折号类
        ("……省略", 2),            # Po 类
        ("¥100", 3),              # Sc 货币符号
    ],
)
def test_symbol_and_punctuation_categories(text: str, expected: int) -> None:
    assert count_words_default(text) == expected


# ---------------------------------------------------------------------------
# 与前端口径的一致性
# ---------------------------------------------------------------------------

_FIXTURE = (
    Path(__file__).resolve().parents[3]
    / "packages"
    / "shared"
    / "fixtures"
    / "wordcount-cases.json"
)


def _load_shared_cases() -> list[dict[str, object]]:
    """读跨语言共享用例。

    文件不存在时**故意让测试失败**而不是 skip：这份用例是"前后端口径不漂移"的唯一保障，
    静默跳过等于取消保障。
    """
    assert _FIXTURE.is_file(), f"共享用例文件缺失：{_FIXTURE}"
    return json.loads(_FIXTURE.read_text(encoding="utf-8"))["cases"]


def _text_of(case: dict[str, object]) -> str:
    """用例文本由 ``text`` 给出；不可见字符在 JSON 里写成 \\uXXXX 转义，json 会解好。"""
    text = case["text"]
    assert isinstance(text, str)
    return text


@pytest.mark.parametrize("case", _load_shared_cases(), ids=lambda c: str(c["id"]))
def test_matches_shared_ts_fixture(case: dict[str, object]) -> None:
    result = count_words(_text_of(case))
    assert result.with_punct == case["withPunct"], f"{case['id']}：{case['note']}"
    assert result.without_punct == case["withoutPunct"], f"{case['id']}：{case['note']}"


@pytest.mark.parametrize(
    ("codepoint", "note"),
    [
        (0xFEFF, "BOM/ZWNBSP：ECMAScript 当空白，str.isspace() 不认 —— 会多算 1 字"),
        (0x0085, "NEL：str.isspace() 当空白，ECMAScript 不认"),
        (0x001C, "C1 信息分隔符：同上"),
    ],
)
def test_ecmascript_whitespace_boundary(codepoint: int, note: str) -> None:
    """三个分歧码点的定向回归。

    这条用例的意义不是"某个字符算不算字"，而是逼着实现方明确表态用哪套空白定义。
    改回 ``ch.isspace()`` 会让这三个用例失败。
    """
    ch = chr(codepoint)
    in_ecmascript = codepoint == 0xFEFF
    assert ch.isspace() is not in_ecmascript, f"前提失效，请重新核对：{note}"
    expected = WordCount(0, 0) if in_ecmascript else WordCount(1, 1)
    assert count_words(f"甲{ch}乙") == WordCount(
        with_punct=2 + expected.with_punct, without_punct=2 + expected.without_punct
    )
