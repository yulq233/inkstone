"""作品与章节仓储。

这是"文件即真源"的落地层：**没有任何数据库**，全部状态现场读文件。
章节清单有一层内存缓存，但它只是性能优化 —— 任何 miss 都必须能现场重算。

并发模型（03 文档 §1.3）：
- 同一章节的写入用**进程内 ``asyncio.Lock`` per chapterId** 串行化。
  两个并发 PUT 可能乱序落盘，导致"先到的旧内容覆盖后到的新内容"。
- 章节清单的重建与新建用 per-work 锁，避免两处同时重排目录名。
- 阻塞的文件 IO 一律丢进 ``anyio.to_thread``，不占事件循环。
"""

from __future__ import annotations

import asyncio
import json
import logging
from contextlib import suppress
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import anyio

from ..config import Settings
from ..domain.chapter import (
    TITLE_FALLBACK,
    ChapterMeta,
    parse_chapter_meta,
    title_from_first_line,
)
from ..domain.clock import compact_stamp, iso_from_timestamp, now_iso
from ..domain.paths import (
    CHAPTER_MD,
    CHAPTER_META,
    WORK_JSON,
    WorkPaths,
    format_chapter_dirname,
    parse_chapter_dirname,
    slugify,
)
from ..domain.work import WorkMeta, needs_rewrite, parse_work_meta
from ..domain.wordcount import count_words_default
from ..errors import (
    ChapterNotFound,
    DomainError,
    InvalidParam,
    WorkExists,
    WorkNotFound,
    WriteFailed,
)
from .atomic import atomic_write_bytes, atomic_write_text, cleanup_stale_tmp, content_hash, read_bytes
from .recent import RecentStore

logger = logging.getLogger("inkstone.repo")

MAX_TITLE_LEN = 200


@dataclass(slots=True)
class ChapterRecord:
    id: str
    order: int
    slug: str
    dir_name: str
    title: str
    status: str
    word_count: int

    def to_api(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "order": self.order,
            "title": self.title,
            "status": self.status,
            "wordCount": self.word_count,
            "dirName": self.dir_name,
        }


@dataclass(slots=True)
class WorkContext:
    paths: WorkPaths
    meta: WorkMeta
    # None = 尚未扫描。"空列表"与"没扫过"是两件事，不能混。
    chapters: list[ChapterRecord] | None = field(default=None)
    manuscript_mtime: float = 0.0


class WorkRegistry:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._works: dict[str, WorkContext] = {}
        self._chapter_locks: dict[str, asyncio.Lock] = {}
        self._work_locks: dict[str, asyncio.Lock] = {}
        self._recents = RecentStore(settings.home)

    # ------------------------------------------------------------------
    # 锁
    # ------------------------------------------------------------------

    def _chapter_lock(self, chapter_id: str) -> asyncio.Lock:
        lock = self._chapter_locks.get(chapter_id)
        if lock is None:
            lock = asyncio.Lock()
            self._chapter_locks[chapter_id] = lock
        return lock

    def _work_lock(self, work_id: str) -> asyncio.Lock:
        lock = self._work_locks.get(work_id)
        if lock is None:
            lock = asyncio.Lock()
            self._work_locks[work_id] = lock
        return lock

    # ------------------------------------------------------------------
    # 查找
    # ------------------------------------------------------------------

    def _get(self, work_id: str) -> WorkContext:
        ctx = self._works.get(work_id)
        if ctx is None:
            raise WorkNotFound(work_id)
        return ctx

    def _ensure_chapters(self, ctx: WorkContext, *, force: bool = False) -> list[ChapterRecord]:
        try:
            mtime = ctx.paths.manuscript_dir.stat().st_mtime
        except OSError:
            mtime = 0.0
        if force or ctx.chapters is None or mtime != ctx.manuscript_mtime:
            ctx.chapters = self._scan_chapters(ctx)
            with suppress(OSError):
                ctx.manuscript_mtime = ctx.paths.manuscript_dir.stat().st_mtime
        return ctx.chapters

    def _find(self, ctx: WorkContext, chapter_id: str) -> ChapterRecord:
        for record in self._ensure_chapters(ctx):
            if record.id == chapter_id:
                return record
        raise ChapterNotFound(chapter_id)

    # ------------------------------------------------------------------
    # 扫描
    # ------------------------------------------------------------------

    def _scan_chapters(self, ctx: WorkContext) -> list[ChapterRecord]:
        manuscript = ctx.paths.manuscript_dir
        if not manuscript.is_dir():
            return []

        records: list[ChapterRecord] = []
        for entry in sorted(manuscript.iterdir(), key=lambda p: p.name):
            if not entry.is_dir():
                continue
            parsed = parse_chapter_dirname(entry.name)
            if parsed is None:
                # 用户可能在目录里放了别的东西。忽略但留痕，不报错中断整个列表。
                logger.warning("忽略无法解析的章节目录", extra={"extra_fields": {"name": entry.name}})
                continue
            order, slug = parsed
            try:
                records.append(self._scan_one(ctx, entry, order=order, slug=slug))
            except OSError as exc:
                logger.warning(
                    "章节目录读取失败，已跳过",
                    extra={"extra_fields": {"name": entry.name, "error": str(exc)}},
                )
        records.sort(key=lambda r: r.order)
        return records

    def _scan_one(self, ctx: WorkContext, chapter_dir: Path, *, order: int, slug: str) -> ChapterRecord:
        md_path = chapter_dir / CHAPTER_MD
        meta_path = chapter_dir / CHAPTER_META

        meta = self._load_or_heal_meta(meta_path, order)
        if meta.order != order:
            # 目录名才是 order 的真源（重排只改目录名）。meta 里的 order 是副本，
            # 不一致就顺手对齐，失败也不影响正确性。
            meta.order = order
            self._try_write_meta(meta_path, meta)

        title, word_count = self._read_title_and_wordcount(md_path, meta)
        if meta.word_count_cache != word_count:
            meta.word_count_cache = word_count
            self._try_write_meta(meta_path, meta)

        return ChapterRecord(
            id=meta.id,
            order=order,
            slug=slug,
            dir_name=chapter_dir.name,
            title=title,
            status=meta.status,
            word_count=word_count,
        )

    def _load_or_heal_meta(self, meta_path: Path, order: int) -> ChapterMeta:
        if meta_path.is_file():
            try:
                return parse_chapter_meta(json.loads(meta_path.read_text(encoding="utf-8")))
            except (OSError, json.JSONDecodeError, InvalidParam) as exc:
                # 用户在外部把 meta.json 改坏了：不要连累整部作品打不开，
                # 重建一个（id 会变，这是可接受的代价，并会在日志里留下痕迹）。
                logger.warning(
                    "meta.json 不可用，已重建",
                    extra={"extra_fields": {"path": str(meta_path), "error": str(exc)}},
                )
        meta = ChapterMeta(order=order)
        self._try_write_meta(meta_path, meta)
        return meta

    def _read_title_and_wordcount(self, md_path: Path, meta: ChapterMeta) -> tuple[str, int]:
        if not md_path.is_file():
            return TITLE_FALLBACK, 0
        try:
            with md_path.open("r", encoding="utf-8") as f:
                first_line = f.readline()
            title = title_from_first_line(first_line) or TITLE_FALLBACK
        except (OSError, UnicodeDecodeError) as exc:
            logger.warning(
                "章节正文读取失败",
                extra={"extra_fields": {"path": str(md_path), "error": str(exc)}},
            )
            return TITLE_FALLBACK, 0

        if meta.word_count_cache is not None:
            # 列表页只读首行 —— 几十上百章时整文件读入会明显变慢。
            return title, meta.word_count_cache

        # 缓存缺失（首次扫描、外部新建的章）才整文件读一次，读完就写回缓存。
        try:
            text = md_path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            return title, 0
        return title, count_words_default(text)

    def _try_write_meta(self, meta_path: Path, meta: ChapterMeta) -> None:
        try:
            atomic_write_text(meta_path, meta.to_json())
        except WriteFailed as exc:
            # 缓存写不进去不该让请求失败：正文（md）才是真源。
            logger.warning(
                "meta.json 写入失败，缓存暂不可用",
                extra={"extra_fields": {"path": str(meta_path), "error": str(exc)}},
            )

    # ------------------------------------------------------------------
    # 新建 / 打开
    # ------------------------------------------------------------------

    async def create(
        self,
        *,
        parent_dir: str,
        title: str,
        author: str = "",
        genre: str = "",
        word_goal: int = 0,
    ) -> dict[str, Any]:
        clean_title = _clean_title(title, field_name="作品标题")
        return await anyio.to_thread.run_sync(
            self._create_sync,
            parent_dir,
            clean_title,
            author,
            genre,
            word_goal,
        )

    def _create_sync(
        self, parent_dir: str, title: str, author: str, genre: str, word_goal: int
    ) -> dict[str, Any]:
        parent = Path(parent_dir).expanduser()
        if not parent.is_dir():
            raise InvalidParam("父目录不存在或不是一个目录，请重新选择。")

        # 目录名用 slug 而不是原始标题：标题里的 `/` `:` 会直接导致创建失败。
        root = parent / slugify(title)
        if root.exists() and any(root.iterdir()):
            raise WorkExists(str(root))

        paths = WorkPaths(root)
        for directory in paths.scaffold_dirs():
            directory.mkdir(parents=True, exist_ok=True)

        meta = WorkMeta(title=title, author=author, genre=genre, word_goal=word_goal)
        atomic_write_text(paths.work_json, meta.to_json())

        first = self._new_chapter_files(paths, order=1, title="第一章")
        ctx = WorkContext(paths=paths, meta=meta, chapters=[first])
        with suppress(OSError):
            ctx.manuscript_mtime = paths.manuscript_dir.stat().st_mtime
        self._works[meta.id] = ctx
        self._recents.touch(root_path=str(root), title=title)
        logger.info("已新建作品", extra={"extra_fields": {"workId": meta.id, "root": str(root)}})
        return self._summary(ctx)

    async def open(self, root_path: str) -> dict[str, Any]:
        return await anyio.to_thread.run_sync(self._open_sync, root_path)

    def _open_sync(self, root_path: str) -> dict[str, Any]:
        root = Path(root_path).expanduser()
        work_json = root / WORK_JSON
        if not work_json.is_file():
            raise WorkNotFound(root_path)

        try:
            raw = json.loads(work_json.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise InvalidParam(f"work.json 不是合法的 JSON：{exc.msg}") from exc
        except OSError as exc:
            raise InvalidParam(f"work.json 读取失败：{exc}") from exc

        meta = parse_work_meta(raw)
        if needs_rewrite(raw, meta):
            # 缺失字段补齐后写回：用户下次用别的工具看这个文件时，字段是齐的。
            with suppress(WriteFailed):
                atomic_write_text(work_json, meta.to_json())

        paths = WorkPaths(root)
        removed = cleanup_stale_tmp([paths.manuscript_dir])
        if removed:
            logger.info("已清理残留临时文件", extra={"extra_fields": {"count": removed}})

        ctx = WorkContext(paths=paths, meta=meta)
        self._works[meta.id] = ctx
        self._ensure_chapters(ctx, force=True)
        self._recents.touch(root_path=str(root), title=meta.title or root.name)
        logger.info("已打开作品", extra={"extra_fields": {"workId": meta.id, "root": str(root)}})
        return self._summary(ctx)

    def recent(self) -> list[dict[str, Any]]:
        return self._recents.list()

    def remove_recent(self, root_path: str) -> bool:
        return self._recents.remove(root_path)

    def _summary(self, ctx: WorkContext) -> dict[str, Any]:
        chapters = ctx.chapters or []
        return {
            "id": ctx.meta.id,
            "title": ctx.meta.title or ctx.paths.root.name,
            "author": ctx.meta.author,
            "genre": ctx.meta.genre,
            "tags": list(ctx.meta.tags),
            "wordGoal": ctx.meta.word_goal,
            "dailyGoal": ctx.meta.daily_goal,
            "rootPath": str(ctx.paths.root),
            "createdAt": ctx.meta.created_at,
            "updatedAt": ctx.meta.updated_at,
            "chapterCount": len(chapters),
            "totalWords": sum(c.word_count for c in chapters),
        }

    # ------------------------------------------------------------------
    # 章节
    # ------------------------------------------------------------------

    async def list_chapters(self, work_id: str, *, refresh: bool = False) -> list[dict[str, Any]]:
        ctx = self._get(work_id)
        async with self._work_lock(work_id):
            records = await anyio.to_thread.run_sync(
                lambda: list(self._ensure_chapters(ctx, force=refresh))
            )
        return [r.to_api() for r in records]

    async def create_chapter(
        self, work_id: str, *, title: str, after_chapter_id: str | None = None
    ) -> dict[str, Any]:
        ctx = self._get(work_id)
        clean_title = _clean_title(title, field_name="章节标题")
        async with self._work_lock(work_id):
            record = await anyio.to_thread.run_sync(
                self._create_chapter_sync, ctx, clean_title, after_chapter_id
            )
        return record.to_api()

    def _create_chapter_sync(
        self, ctx: WorkContext, title: str, after_chapter_id: str | None
    ) -> ChapterRecord:
        chapters = self._ensure_chapters(ctx, force=True)

        if after_chapter_id is None:
            new_order = (max((c.order for c in chapters), default=0)) + 1
        else:
            target = self._find(ctx, after_chapter_id)
            new_order = target.order + 1

        # 插入点之后的章节全部 +1。**从高到低**改名：从低到高会在
        # "002 → 003 但 003 还在"时撞名；从高到低每一步的目标格都是空的。
        successors = sorted((c for c in chapters if c.order >= new_order), key=lambda c: -c.order)
        renamed: list[tuple[ChapterRecord, Path, Path]] = []
        try:
            for record in successors:
                src = ctx.paths.chapter_dir(record.order, record.slug)
                dst = ctx.paths.chapter_dir(record.order + 1, record.slug)
                src.rename(dst)
                renamed.append((record, src, dst))
        except OSError as exc:
            # 回滚已改的部分，让磁盘回到调用前的样子 —— 半成品状态比失败更难查。
            for record, src, dst in reversed(renamed):
                with suppress(OSError):
                    dst.rename(src)
            raise DomainError(
                "INTERNAL",
                "章节插入失败：重排目录时出错，已回滚。请检查 manuscript 目录是否有同名目录被占用。",
                detail={"reason": str(exc)},
            ) from exc

        # 目录名是 order 的真源，meta 里的 order 只是副本；这里同步一下。
        for record, _src, dst in renamed:
            record.order += 1
            meta_path = dst / CHAPTER_META
            with suppress(OSError):
                meta = parse_chapter_meta(json.loads(meta_path.read_text(encoding="utf-8")))
                meta.order = record.order
                self._try_write_meta(meta_path, meta)

        created = self._new_chapter_files(ctx.paths, order=new_order, title=title)
        # 目录被改名过，缓存整体重建最省事也最不容易漏。
        self._ensure_chapters(ctx, force=True)
        logger.info(
            "已新建章节",
            extra={"extra_fields": {"chapterId": created.id, "order": created.order}},
        )
        return created

    def _new_chapter_files(self, paths: WorkPaths, *, order: int, title: str) -> ChapterRecord:
        slug = slugify(title)
        chapter_dir, slug = _unique_chapter_dir(paths, order, slug)
        chapter_dir.mkdir(parents=True, exist_ok=True)

        # 正文首行就是标题 —— md 是标题的唯一真源，meta.json 里不复制它。
        content = f"# {title}\n\n"
        atomic_write_text(chapter_dir / CHAPTER_MD, content)

        # 如实算一遍而不是填 0：缓存与文件内容不一致，是"字数对不上"这类
        # 用户报告的根源。宁可多算一次。
        word_count = count_words_default(content)
        meta = ChapterMeta(order=order, status="draft", word_count_cache=word_count)
        atomic_write_text(chapter_dir / CHAPTER_META, meta.to_json())

        return ChapterRecord(
            id=meta.id,
            order=order,
            slug=slug,
            dir_name=chapter_dir.name,
            title=title,
            status=meta.status,
            word_count=word_count,
        )

    async def read_chapter(self, work_id: str, chapter_id: str) -> dict[str, Any]:
        ctx = self._get(work_id)
        async with self._work_lock(work_id):
            return await anyio.to_thread.run_sync(self._read_chapter_sync, ctx, chapter_id)

    def _read_chapter_sync(self, ctx: WorkContext, chapter_id: str) -> dict[str, Any]:
        record = self._find(ctx, chapter_id)
        md_path = ctx.paths.chapter_md(record.order, record.slug)
        try:
            raw = read_bytes(md_path)
        except FileNotFoundError:
            # 目录还在但正文被删了。当成空内容继续，保存时会把它写回来。
            raw = b""

        markdown = raw.decode("utf-8", errors="replace")
        word_count = count_words_default(markdown)
        if record.word_count != word_count:
            self._cache_word_count(ctx, record, word_count)
        return {
            "id": record.id,
            "order": record.order,
            "title": record.title,
            "status": record.status,
            "markdown": markdown,
            "hash": content_hash(raw),
            "wordCount": word_count,
            "savedAt": _mtime_iso(md_path),
        }

    async def write_chapter(
        self,
        work_id: str,
        chapter_id: str,
        *,
        markdown: str,
        base_hash: str,
        backup: bool = False,
    ) -> dict[str, Any]:
        ctx = self._get(work_id)
        # 同一章节的写入必须串行：两个并发 PUT 可能乱序落盘，旧内容盖掉新内容。
        async with self._chapter_lock(chapter_id):
            return await anyio.to_thread.run_sync(
                self._write_chapter_sync, ctx, chapter_id, markdown, base_hash, backup
            )

    def _write_chapter_sync(
        self,
        ctx: WorkContext,
        chapter_id: str,
        markdown: str,
        base_hash: str,
        backup: bool = False,
    ) -> dict[str, Any]:
        record = self._find(ctx, chapter_id)
        md_path = ctx.paths.chapter_md(record.order, record.slug)

        try:
            disk = read_bytes(md_path)
            disk_exists = True
        except FileNotFoundError:
            disk = b""
            disk_exists = False

        disk_hash = content_hash(disk)
        if disk_hash != base_hash:
            # 不静默覆盖 —— 用户可能在 VS Code 里改过这个文件。
            raise DomainError(
                "EXTERNAL_MODIFIED",
                "这个章节的文件已被外部修改，你的改动没有保存。",
                detail={
                    "diskHash": disk_hash,
                    "diskMarkdown": disk.decode("utf-8", errors="replace"),
                    "diskSavedAt": _mtime_iso(md_path) if disk_exists else None,
                },
            )

        # 用户在冲突对话框里选了"保留我的并覆盖"：先把磁盘版本存一份再写。
        # 这是"不静默丢用户内容"的底线（03 文档 §6.6）—— 覆盖是用户明确选的，
        # 但"选错了想反悔"必须还有退路。
        backup_path = self._backup_before_overwrite(ctx, chapter_id, disk) if backup else None

        payload = markdown.encode("utf-8")
        atomic_write_bytes(md_path, payload)

        word_count = count_words_default(markdown)
        title = title_from_first_line(markdown.split("\n", 1)[0]) or TITLE_FALLBACK
        self._cache_word_count(ctx, record, word_count, title=title)

        return {
            "hash": content_hash(payload),
            "wordCount": word_count,
            "savedAt": _mtime_iso(md_path),
            "backupPath": backup_path,
        }

    def _backup_before_overwrite(
        self, ctx: WorkContext, chapter_id: str, disk: bytes
    ) -> str | None:
        """把即将被覆盖的磁盘内容备份到 ``.inkstone/backups/``。

        空内容不备份：那不是"用户的心血"，只是从未写过的空文件，
        存下来只会让备份目录里堆一堆 0 字节文件。

        备份失败**不阻断写入**，只记日志。判断依据是"哪种损失更重"：
        备份写不进去（比如磁盘满）时，拒绝保存会让用户的手稿连新版都存不下，
        而继续保存最多丢掉一份旧版 —— 后者轻得多，且日志里有痕迹。
        """
        if not disk:
            return None
        target = ctx.paths.backups_dir / f"{chapter_id}-{compact_stamp()}.md"
        try:
            atomic_write_bytes(target, disk)
        except (OSError, WriteFailed) as exc:
            logger.warning(
                "冲突覆盖前的备份失败，仍继续写入",
                extra={"extra_fields": {"chapterId": chapter_id, "error": str(exc)}},
            )
            return None
        logger.info(
            "覆盖前已备份磁盘版本",
            extra={"extra_fields": {"chapterId": chapter_id, "path": str(target)}},
        )
        return str(target)

    def _cache_word_count(
        self, ctx: WorkContext, record: ChapterRecord, word_count: int, *, title: str | None = None
    ) -> None:
        record.word_count = word_count
        if title is not None:
            record.title = title
        meta_path = ctx.paths.chapter_meta(record.order, record.slug)
        try:
            meta = parse_chapter_meta(json.loads(meta_path.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError, InvalidParam):
            meta = ChapterMeta(id=record.id, order=record.order, status=record.status)
        meta.word_count_cache = word_count
        meta.updated_at = now_iso()
        self._try_write_meta(meta_path, meta)


# ----------------------------------------------------------------------
# 模块级小工具
# ----------------------------------------------------------------------


def _clean_title(title: str, *, field_name: str = "标题") -> str:
    clean = (title or "").strip().replace("\n", " ").replace("\r", " ")
    if not clean:
        raise InvalidParam(f"{field_name}不能为空。")
    if len(clean) > MAX_TITLE_LEN:
        raise InvalidParam(f"{field_name}过长（上限 {MAX_TITLE_LEN} 字）。")
    return clean


def _unique_chapter_dir(paths: WorkPaths, order: int, slug: str) -> tuple[Path, str]:
    """避开同名目录。

    order 唯一时几乎不会撞；但用户的目录可能被手工改成重复序号，
    这时宁可加后缀也不能写到别人的目录里去。
    """
    candidate = paths.chapter_dir(order, slug)
    if not candidate.exists():
        return candidate, slug
    for suffix in range(2, 100):
        alt = f"{slug}-{suffix}"
        candidate = paths.chapter_dir(order, alt)
        if not candidate.exists():
            return candidate, alt
    raise DomainError("INTERNAL", "无法为该章节分配目录名，请检查 manuscript 目录。")


def _mtime_iso(path: Path) -> str | None:
    try:
        return iso_from_timestamp(path.stat().st_mtime)
    except OSError:
        return None


__all__ = ["ChapterRecord", "WorkContext", "WorkRegistry", "format_chapter_dirname"]
