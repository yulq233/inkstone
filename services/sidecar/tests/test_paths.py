"""路径规则测试（03 文档 §4.1）。

``paths.py`` 是全项目路径规则的唯一定义处，所以这里要测死：
slug 生成的各种脏输入、目录名解析的三种情形、以及目录布局本身。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from inkstone.domain.paths import (
    WorkPaths,
    format_chapter_dirname,
    parse_chapter_dirname,
    slugify,
)

# ---- slugify ----


def test_slugify_keeps_chinese() -> None:
    # 中文目录名在 NTFS/APFS 上原生可用，转拼音反而让人认不出是第几章。
    assert slugify("第一章 初入宗门") == "第一章-初入宗门"


@pytest.mark.parametrize("bad", ['<>:"/\\|?*'])
def test_slugify_removes_each_illegal_char(bad: str) -> None:
    assert bad not in slugify(f"第{bad}一章")


def test_slugify_removes_control_chars() -> None:
    assert slugify("第\x00一\x1f章") == "第一章"


def test_slugify_collapses_whitespace_into_single_dash() -> None:
    assert slugify("第一章    初入    宗门") == "第一章-初入-宗门"


def test_slugify_drops_control_chars_before_collapsing() -> None:
    """制表符会被**删除**而不是折成连字符。

    顺序是"先删非法字符（含全部控制字符），再把剩余空白折成 -"，
    所以 tab 参与不到折连字符那一步。这是 ``ILLEGAL_CHARS`` 含 ``chr(0..31)`` 的直接结果，
    写下来是为了防止后人以为这里漏了处理。
    """
    assert slugify("第一章\t初入宗门") == "第一章初入宗门"


@pytest.mark.parametrize("blank", ["", "   ", "\t\n", "///"])
def test_slugify_falls_back_when_nothing_left(blank: str) -> None:
    assert slugify(blank) == "untitled"


def test_slugify_truncates_to_max_len() -> None:
    assert len(slugify("あ" * 200)) == 30


def test_slugify_never_ends_with_dot_or_space_after_truncation() -> None:
    # 截断可能正好切在点上，而 Windows 不允许目录名以点或空格结尾。
    result = slugify("a" * 29 + ".xyz")
    assert not result.endswith(".")
    assert not result.endswith(" ")


@pytest.mark.parametrize("reserved", ["CON", "con", "NUL", "com1", "LPT9"])
def test_slugify_escapes_windows_reserved_names(reserved: str) -> None:
    assert slugify(reserved) == f"_{reserved}"


def test_slugify_keeps_non_reserved_lookalike() -> None:
    assert slugify("CONSOLE") == "CONSOLE"


# ---- 目录名 ----


def test_format_chapter_dirname_pads_to_three() -> None:
    assert format_chapter_dirname(1, "第一章") == "001-第一章"
    assert format_chapter_dirname(42, "第四十二章") == "042-第四十二章"


def test_format_chapter_dirname_grows_beyond_999() -> None:
    assert format_chapter_dirname(1000, "第一千章") == "1000-第一千章"


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("001-第一章", (1, "第一章")),
        ("042-第四十二章", (42, "第四十二章")),
        ("1000-第一千章", (1000, "第一千章")),
    ],
)
def test_parse_chapter_dirname_accepts_three_and_four_digits(
    name: str, expected: tuple[int, str]
) -> None:
    assert parse_chapter_dirname(name) == expected


@pytest.mark.parametrize("name", ["001", "001-", "abc-001", "大纲", "第一章", "1-第一章", ""])
def test_parse_chapter_dirname_rejects_non_chapter_dirs(name: str) -> None:
    # 用户会在 manuscript 里放别的东西，这时必须返回 None 让调用方优雅跳过。
    assert parse_chapter_dirname(name) is None


def test_dirname_round_trip() -> None:
    for order in (1, 9, 10, 999, 1000):
        slug = slugify(f"第{order}章")
        assert parse_chapter_dirname(format_chapter_dirname(order, slug)) == (order, slug)


# ---- 目录布局 ----


def test_work_paths_layout(tmp_path: Path) -> None:
    paths = WorkPaths(tmp_path / "我的小说")

    assert paths.work_json == tmp_path / "我的小说" / "work.json"
    assert paths.outline_dir == tmp_path / "我的小说" / "outline"
    assert paths.volume_outline_dir == tmp_path / "我的小说" / "outline" / "卷纲"
    assert paths.manuscript_dir == tmp_path / "我的小说" / "manuscript"
    assert paths.codex_dir == tmp_path / "我的小说" / "codex"
    assert paths.snippets_dir == tmp_path / "我的小说" / "snippets"
    assert paths.styles_dir == tmp_path / "我的小说" / "styles"
    # 私有目录必须藏在点目录下，用户的文件管理器默认不干扰它。
    assert paths.private_dir == tmp_path / "我的小说" / ".inkstone"
    assert paths.logs_dir == tmp_path / "我的小说" / ".inkstone" / "logs"
    assert paths.backups_dir == tmp_path / "我的小说" / ".inkstone" / "backups"


def test_chapter_paths_nest_under_manuscript(tmp_path: Path) -> None:
    paths = WorkPaths(tmp_path)
    chapter_dir = paths.chapter_dir(3, "第三章")

    assert chapter_dir == paths.manuscript_dir / "003-第三章"
    assert paths.chapter_md(3, "第三章") == chapter_dir / "chapter.md"
    assert paths.chapter_meta(3, "第三章") == chapter_dir / "meta.json"


def test_scaffold_dirs_cover_the_documented_skeleton(tmp_path: Path) -> None:
    names = {p.name for p in WorkPaths(tmp_path).scaffold_dirs()}
    assert names == {
        "outline", "卷纲", "manuscript", "codex",
        "snippets", "styles", ".inkstone", "logs", "backups",
    }
