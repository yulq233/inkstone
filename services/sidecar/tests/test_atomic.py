"""原子写与内容哈希测试（03 文档 §4.4 / §4.5）。

这块是整个"文件即真源"的地基：写坏了就是用户的原稿没了。所以边界情形要测满。
"""

from __future__ import annotations

import os
import time
from pathlib import Path

import pytest

from inkstone.errors import WriteFailed
from inkstone.storage import atomic


def test_writes_utf8_without_bom(tmp_path: Path) -> None:
    target = tmp_path / "chapter.md"
    atomic.atomic_write_text(target, "# 第一章\n\n他推开门。\n")

    raw = target.read_bytes()
    assert not raw.startswith(b"\xef\xbb\xbf")
    assert raw.decode("utf-8").startswith("# 第一章")


def test_newlines_are_lf_only(tmp_path: Path) -> None:
    """Windows 上文本模式会把 \\n 写成 \\r\\n，必须绕开。

    一旦落盘出现 CRLF，跨平台的往返比对、git diff 都会出现无意义的整文件差异。
    """
    target = tmp_path / "chapter.md"
    atomic.atomic_write_text(target, "第一行\n第二行\n")

    assert b"\r\n" not in target.read_bytes()


def test_creates_parent_directories(tmp_path: Path) -> None:
    target = tmp_path / "001-第一章" / "chapter.md"
    atomic.atomic_write_text(target, "内容")
    assert target.read_text(encoding="utf-8") == "内容"


def test_overwrite_replaces_content_entirely(tmp_path: Path) -> None:
    target = tmp_path / "a.md"
    atomic.atomic_write_text(target, "很长的一段旧内容，比新的长很多很多")
    atomic.atomic_write_text(target, "短")
    assert target.read_text(encoding="utf-8") == "短"


def test_no_temp_files_left_behind_on_success(tmp_path: Path) -> None:
    for _ in range(3):
        atomic.atomic_write_text(tmp_path / "a.md", "内容")
    assert list(tmp_path.glob(".*.tmp")) == []


def test_bytes_writer_keeps_exact_bytes(tmp_path: Path) -> None:
    target = tmp_path / "a.bin"
    payload = "中文🙂\n".encode()
    atomic.atomic_write_bytes(target, payload)
    assert target.read_bytes() == payload


def test_gives_up_with_write_failed_after_retries(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """重试耗尽必须抛出去，不能静默吞掉。

    真实触发场景：用户在 VS Code 里开着这个 md，Windows 不允许替换被占用的文件。
    """

    def always_busy(*_args: object, **_kwargs: object) -> None:
        raise PermissionError(13, "文件被其他程序占用")

    # 直接 patch `os` / `time` 这两个**模块对象**，不写 `atomic.os`：
    # `atomic.os is os`，两种写法打的是同一处；而写 `atomic.os` 会踩
    # `no_implicit_reexport`（`os` 只是 atomic.py 的 import，不是它的导出）。
    monkeypatch.setattr(os, "replace", always_busy)
    monkeypatch.setattr(time, "sleep", lambda _seconds: None)

    with pytest.raises(WriteFailed) as excinfo:
        atomic.atomic_write_text(tmp_path / "a.md", "内容")

    assert "PermissionError" in excinfo.value.detail["reason"]
    # 失败后不能留下半截临时文件——下次启动会被当成残留清掉，但更该根本不产生。
    assert list(tmp_path.glob(".*.tmp")) == []


def test_retries_then_succeeds(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """第一次被占用、第二次成功——这正是"用户在编辑器里关掉文件"的真实时序。"""
    real_replace = os.replace
    calls = {"n": 0}

    def flaky(src: str | os.PathLike[str], dst: str | os.PathLike[str]) -> None:
        calls["n"] += 1
        if calls["n"] == 1:
            raise PermissionError(13, "忙")
        real_replace(src, dst)

    monkeypatch.setattr(os, "replace", flaky)
    monkeypatch.setattr(time, "sleep", lambda _seconds: None)

    target = tmp_path / "a.md"
    atomic.atomic_write_text(target, "内容")

    assert calls["n"] == 2
    assert target.read_text(encoding="utf-8") == "内容"


# ---- 内容哈希 ----


def test_hash_is_sixteen_hex_chars() -> None:
    digest = atomic.content_hash(b"hello")
    assert len(digest) == 16
    assert all(c in "0123456789abcdef" for c in digest)


def test_hash_is_stable_and_content_sensitive() -> None:
    assert atomic.content_hash(b"abc") == atomic.content_hash(b"abc")
    assert atomic.content_hash(b"abc") != atomic.content_hash(b"abd")


def test_hash_detects_trailing_whitespace_change() -> None:
    """哈希必须基于原始字节，不能被"规范化"抹平。

    外部编辑器多打一个行尾空格，就该被认成"文件被改动"，从而触发冲突提示 ——
    这正是 H2 假设（文件即真源经得起外部编辑）要守住的东西。
    """
    assert atomic.content_hash("# 第一章\n".encode()) != atomic.content_hash("# 第一章 \n".encode())


def test_hash_distinguishes_crlf_from_lf() -> None:
    assert atomic.content_hash("甲\n".encode()) != atomic.content_hash("甲\r\n".encode())


# ---- 残留清理 ----


def test_cleanup_removes_only_stale_temp_files(tmp_path: Path) -> None:
    manuscript = tmp_path / "manuscript"
    chapter = manuscript / "001-第一章"
    chapter.mkdir(parents=True)

    stale = chapter / ".chapter.md.stale.tmp"
    fresh = chapter / ".chapter.md.fresh.tmp"
    stale.write_text("旧", encoding="utf-8")
    fresh.write_text("新", encoding="utf-8")

    old = time.time() - 7200
    os.utime(stale, (old, old))

    removed = atomic.cleanup_stale_tmp([manuscript])

    assert removed == 1
    assert not stale.exists()
    # 正在进行的写不能被误删。
    assert fresh.exists()


def test_cleanup_ignores_missing_base_dir(tmp_path: Path) -> None:
    assert atomic.cleanup_stale_tmp([tmp_path / "不存在"]) == 0


def test_cleanup_ignores_unrelated_hidden_files(tmp_path: Path) -> None:
    """.DS_Store 这类隐藏文件不能被当成临时文件删掉。"""
    (tmp_path / ".DS_Store").write_text("x", encoding="utf-8")
    old = time.time() - 7200
    os.utime(tmp_path / ".DS_Store", (old, old))

    assert atomic.cleanup_stale_tmp([tmp_path]) == 0
    assert (tmp_path / ".DS_Store").exists()
