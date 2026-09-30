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
#: 章纲子目录（`docs/15` D-3）。放 outline/ 下而不是 manuscript/<章目录>/ 里：
#: 那会让"删章"顺手删掉章纲 —— 违反"失效进待办、不静默丢弃"。
CHAPTER_OUTLINE_DIR = "章纲"
CODEX_DIR = "codex"
SNIPPETS_DIR = "snippets"
STYLES_DIR = "styles"
PRIVATE_DIR = ".inkstone"
LOGS_DIR = "logs"
BACKUPS_DIR = "backups"
AI_DIR = "ai"

CHAPTER_MD = "chapter.md"
CHAPTER_META = "meta.json"

#: 总纲（`docs/15` §2.2）。GET 语义是"必然要写"，不存在时返回空正文而非 404。
GENERAL_OUTLINE_MD = "总纲.md"

#: v1 装配器的「L0 替代」：用户手写的作品设定（`docs/11` §4.5）。
#: 它放在**作品根目录**而不是 `.inkstone/` 下 —— 它是**正文级**的东西（人可读、要备份、
#: 丢了影响写作），而 `.inkstone/` 里的东西按既有约定**删掉不影响写作**。
WORK_SETTINGS_MD = "设定.md"

AI_RUNS_JSONL = "runs.jsonl"
AI_FEEDBACK_JSONL = "feedback.jsonl"

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
    def chapter_outline_dir(self) -> Path:
        return self.outline_dir / CHAPTER_OUTLINE_DIR

    @property
    def general_outline_md(self) -> Path:
        return self.outline_dir / GENERAL_OUTLINE_MD

    def volume_outline_md(self, order: int, slug: str) -> Path:
        """卷纲文件：``outline/卷纲/NNN-<slug>.md``。NNN 与 frontmatter 的 order
        **双写一致**（照章节目录的既有约定，重排时两者一起改）。"""
        return self.volume_outline_dir / f"{order:03d}-{slug}.md"

    def chapter_outline_md(self, chapter_id: str) -> Path:
        """章纲文件：``outline/章纲/<chapterId>.md``。文件名用稳定 id ——
        排序信息属于章节清单，章纲被机器引用的键只有 chapterId（D-3）。"""
        return self.chapter_outline_dir / f"{chapter_id}.md"

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

    @property
    def settings_md(self) -> Path:
        """用户手写的作品设定（正文级，**不可删**）。v1 装配器拿它当 L0 的替代。"""
        return self.root / WORK_SETTINGS_MD

    @property
    def ai_dir(self) -> Path:
        """AI 的运行时目录。整棵可删 —— 删掉只是统计归零，正文一个字不受影响。"""
        return self.private_dir / AI_DIR

    @property
    def ai_runs_jsonl(self) -> Path:
        return self.ai_dir / AI_RUNS_JSONL

    @property
    def ai_feedback_jsonl(self) -> Path:
        """采纳结果单独一个文件。

        不回头改 `runs.jsonl` 的行：它是**追加写的审计流**（`docs/11` §3.6），
        覆盖式写入会让"某次外发记录被改过"变成可能 —— 而外发审计（`egressChars`）
        的全部价值就在于它没被改过。读的时候按 `id` 合并。
        """
        return self.ai_dir / AI_FEEDBACK_JSONL

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
