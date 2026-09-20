"""路径规则 —— **全项目唯一的路由定义处**。

任何模块都不得手拼作品目录下的路径。原因很实际：作品目录里同时存在
"人可读的排序信息"（目录名前缀 ``001-``）和"机器引用的稳定标识"（``meta.json`` 里的 id），
一旦有人在别处手拼字符串，重排章节时就会漏改一处，锚点失效这类 bug 极难查。

详见 docs/03-M0-详细设计.md §4.1。
"""

from __future__ import annotations

import re
from pathlib import Path

# ---- 目录与文件名常量 ----
WORK_JSON = "work.json"
MANUSCRIPT_DIR = "manuscript"
OUTLINE_DIR = "outline"
VOLUME_OUTLINE_DIR = "卷纲"
CODEX_DIR = "codex"
SNIPPETS_DIR = "snippets"
STYLES_DIR = "styles"
PRIVATE_DIR = ".inkstone"
LOGS_DIR = "logs"
BACKUPS_DIR = "backups"

CHAPTER_MD = "chapter.md"
CHAPTER_META = "meta.json"

# Windows 保留设备名：作为目录名会直接创建失败（或行为诡异）。
WINDOWS_RESERVED: frozenset[str] = frozenset(
    {
        "CON",
        "PRN",
        "AUX",
        "NUL",
        *(f"COM{i}" for i in range(1, 10)),
        *(f"LPT{i}" for i in range(1, 10)),
    }
)

# Windows 文件名非法字符 + 全部控制字符。
ILLEGAL_CHARS: frozenset[str] = frozenset('<>:"/\\|?*') | {chr(c) for c in range(32)}

# 兼容 3 位与 4 位（超过 999 章自动扩位）。
_CHAPTER_DIR_RE = re.compile(r"^(\d{3,})-(.+)$")


def slugify(title: str, max_len: int = 30) -> str:
    """把章节标题转成可安全用作目录名的 slug。

    中文不需要转拼音 —— Windows/macOS 的 NTFS 与 APFS 都原生支持 UTF-8 目录名，
    保留中文反而让人在资源管理器里一眼能认出来是第几章。
    """
    s = "".join("" if ch in ILLEGAL_CHARS else ch for ch in title).strip()
    s = re.sub(r"\s+", "-", s)
    # 截断之后再 rstrip 一次：截断可能正好切在点或空格上，而 Windows 不允许目录名以它们结尾。
    s = s[:max_len].rstrip(". ")
    if not s:
        return "untitled"
    if s.upper() in WINDOWS_RESERVED:
        # 前缀下划线即可绕开保留名，比加随机后缀更可读。
        s = f"_{s}"
    return s


def format_chapter_dirname(order: int, slug: str) -> str:
    return f"{order:03d}-{slug}"


def parse_chapter_dirname(name: str) -> tuple[int, str] | None:
    """``001-第一章`` → ``(1, "第一章")``；不匹配返回 ``None``（调用方记 warn 并忽略）。"""
    m = _CHAPTER_DIR_RE.match(name)
    if m is None:
        return None
    return int(m.group(1)), m.group(2)


class WorkPaths:
    """一部作品在磁盘上的全部路径。**不要绕过它手拼路径。**"""

    __slots__ = ("root",)

    def __init__(self, root: Path) -> None:
        self.root = Path(root)

    @property
    def work_json(self) -> Path:
        return self.root / WORK_JSON

    @property
    def outline_dir(self) -> Path:
        return self.root / OUTLINE_DIR

    @property
    def volume_outline_dir(self) -> Path:
        return self.outline_dir / VOLUME_OUTLINE_DIR

    @property
    def manuscript_dir(self) -> Path:
        return self.root / MANUSCRIPT_DIR

    @property
    def codex_dir(self) -> Path:
        return self.root / CODEX_DIR

    @property
    def snippets_dir(self) -> Path:
        return self.root / SNIPPETS_DIR

    @property
    def styles_dir(self) -> Path:
        return self.root / STYLES_DIR

    @property
    def private_dir(self) -> Path:
        return self.root / PRIVATE_DIR

    @property
    def logs_dir(self) -> Path:
        return self.private_dir / LOGS_DIR

    @property
    def backups_dir(self) -> Path:
        return self.private_dir / BACKUPS_DIR

    def chapter_dir(self, order: int, slug: str) -> Path:
        return self.manuscript_dir / format_chapter_dirname(order, slug)

    def chapter_md(self, order: int, slug: str) -> Path:
        return self.chapter_dir(order, slug) / CHAPTER_MD

    def chapter_meta(self, order: int, slug: str) -> Path:
        return self.chapter_dir(order, slug) / CHAPTER_META

    def scaffold_dirs(self) -> tuple[Path, ...]:
        """新建作品时需要建全的目录。M0 一次建全，避免后续迁移。"""
        return (
            self.outline_dir,
            self.volume_outline_dir,
            self.manuscript_dir,
            self.codex_dir,
            self.snippets_dir,
            self.styles_dir,
            self.private_dir,
            self.logs_dir,
            self.backups_dir,
        )
