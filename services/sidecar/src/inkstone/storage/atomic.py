"""原子写与内容哈希。

**为什么临时文件必须与目标同目录**：``os.replace`` 只在**同一卷**内是原子的。
放系统 temp 目录（常在另一个盘）会退化成"先删后拷"，断电就得到半截文件。

**为什么 Windows 上要重试**：用户很可能正用 VS Code 开着这个 ``chapter.md``。
Windows 不允许替换被其他进程打开的文件，``os.replace`` 会抛 ``PermissionError``。
重试只是"等对方松手"，不是掩盖错误 —— 重试耗尽必须抛出去，
否则就是静默丢字，那是这个应用最不能犯的错。

详见 docs/03-M0-详细设计.md §4.4 / §4.5。
"""

from __future__ import annotations

import hashlib
import os
import tempfile
import time
from collections.abc import Iterable
from contextlib import suppress
from pathlib import Path

from ..errors import WriteFailed

# 重试间隔：100ms / 200ms / 300ms。取这个量级是因为占用的通常是编辑器保存动作，很短。
_RETRY_DELAYS = (0.1, 0.2, 0.3)

# 残留临时文件的判定年龄：1 小时。比这新的可能是正在进行的写。
STALE_TMP_AGE_SECONDS = 3600.0


def atomic_write_bytes(path: Path, payload: bytes, *, retries: int = 3) -> None:
    """原子写入原始字节。写正文走这条 —— 落盘字节与调用方算 hash 的字节同一份。"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)

    last_error: Exception | None = None
    for attempt in range(retries):
        fd, tmp_name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
        tmp = Path(tmp_name)
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(payload)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, path)
            return
        except OSError as exc:
            last_error = exc
            with suppress(OSError):
                os.unlink(tmp)
            if attempt < retries - 1:
                time.sleep(_RETRY_DELAYS[min(attempt, len(_RETRY_DELAYS) - 1)])

    raise WriteFailed(f"{type(last_error).__name__}: {last_error}")


def atomic_write_text(
    path: Path,
    text: str,
    *,
    encoding: str = "utf-8",
    retries: int = 3,
) -> None:
    """原子地把 ``text`` 写入 ``path``。失败抛 :class:`WriteFailed`。

    走"自己 encode 再写字节"而不是文本模式，是为了绕开平台的换行转换：
    文本模式在 Windows 上会把 ``\\n`` 写成 ``\\r\\n``，而正文必须永远是 LF。
    """
    atomic_write_bytes(Path(path), text.encode(encoding), retries=retries)


def content_hash(raw: bytes) -> str:
    """内容指纹，取 sha256 前 16 个 hex 字符。

    **基于原始字节**，不是规范化后的文本。理由：外部编辑器哪怕只多打了一个
    行尾空格，也应该被认成"文件被改动"，从而触发冲突提示；若先规范化再比，
    这类改动会被悄悄抹平 —— 那正是 H2 假设要防的事。
    """
    return hashlib.sha256(raw).hexdigest()[:16]


def read_text(path: Path, *, encoding: str = "utf-8") -> str:
    return Path(path).read_text(encoding=encoding)


def read_bytes(path: Path) -> bytes:
    return Path(path).read_bytes()


def cleanup_stale_tmp(
    dirs: Iterable[Path], *, max_age_seconds: float = STALE_TMP_AGE_SECONDS
) -> int:
    """清理上次异常退出留下的临时文件，返回删除个数。

    只在**明确的目录集合**内扫（作品目录），不做全盘搜索。
    """
    now = time.time()
    removed = 0
    for base in dirs:
        base = Path(base)
        if not base.is_dir():
            continue
        # 命名规则来自 atomic_write_text：.{name}.{random}.tmp
        for candidate in base.rglob(".*.tmp"):
            if not candidate.is_file():
                continue
            with suppress(OSError):
                if now - candidate.stat().st_mtime > max_age_seconds:
                    candidate.unlink()
                    removed += 1
    return removed
