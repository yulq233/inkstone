"""大纲三层的仓储 —— ``docs/15`` B2 / D-3 / D-5。

与 ``codex_store.py`` 同一套生存法则（锁模型、to_thread、坏文件策略），差异点：

- **总纲与章纲是 upsert 语义**：GET 不存在返回空壳（``hash=""``）、PUT 带
  ``ifMatch=""`` 直接创建。它们没有独立的 POST —— "还没写总纲"是**常态**
  而不是异常，不该用 404 逼前端先建再写。
- **卷纲有独立 POST**：order 由服务端分配（清单末位 +1），因为 NNN 前缀
  与 frontmatter 双写、还要处理重名后缀 —— 让客户端分配就是让两份真源
  各自为政。
- **文件缺失的 hash 记为空串**：外部把文件删了也算"外部修改"，用户拿着
  旧 hash 来 PUT 要撞 409，而不是静默把文件"复活"成自己的版本。

并发：per-work 一把锁（与 codex_store 各自一把 —— 两者文件集不相交，
不存在需要跨店原子性的写；真要合锁的那天先给出一个跨店写的事例）。
"""

from __future__ import annotations

import asyncio
import logging
import re
from pathlib import Path
from typing import Any

import anyio

from ..domain.ids import new_foreshadow_id
from ..domain.outline import (
    ChapterOutline,
    Foreshadow,
    VolumeOutline,
    dump_chapter_outline,
    dump_volume,
    parse_chapter_outline,
    parse_volume,
)
from ..domain.paths import WorkPaths, slugify
from ..errors import (
    ChapterNotFound,
    DomainError,
    InvalidParam,
    NotUtf8,
    OutlineNotFound,
    WorkNotFound,
)
from .atomic import atomic_write_text, content_hash, read_bytes
from .repo import WorkRegistry

logger = logging.getLogger("inkstone.outline")

#: 卷纲文件名：``NNN-<slug>.md``（与章节目录同款前缀格式）。
_VOLUME_NAME_RE = re.compile(r"^(\d{3,})-(.+)\.md$")


def _decode(raw: bytes, path: Path) -> str:
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise NotUtf8(str(path)) from exc


def _load(path: Path) -> tuple[str, bytes] | None:
    """读文件文本与原始字节。返回 ``None`` = 文件不存在。"""
    try:
        raw = read_bytes(path)
    except FileNotFoundError:
        return None
    return _decode(raw, path), raw


class OutlineStore:
    def __init__(self, registry: WorkRegistry) -> None:
        self._registry = registry
        self._locks: dict[str, asyncio.Lock] = {}

    def _lock(self, work_id: str) -> asyncio.Lock:
        lock = self._locks.get(work_id)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[work_id] = lock
        return lock

    def _paths(self, work_id: str) -> WorkPaths:
        # 与 codex_store 同款：作品存在性的真源只在 registry 一处。
        try:
            return self._registry.work_paths(work_id)
        except WorkNotFound:
            raise

    # ------------------------------------------------------------------
    # 总纲（无 frontmatter 的纯正文，upsert 语义）
    # ------------------------------------------------------------------

    async def read_general(self, work_id: str) -> dict[str, Any]:
        paths = self._paths(work_id)
        return await anyio.to_thread.run_sync(self._read_general_sync, paths)

    def _read_general_sync(self, paths: WorkPaths) -> dict[str, Any]:
        loaded = _load(paths.general_outline_md)
        if loaded is None:
            return {"body": "", "hash": ""}
        text, raw = loaded
        return {"body": text, "hash": content_hash(raw)}

    async def write_general(self, work_id: str, body: str, if_match: str) -> dict[str, Any]:
        async with self._lock(work_id):
            paths = self._paths(work_id)
            return await anyio.to_thread.run_sync(self._write_general_sync, paths, body, if_match)

    def _write_general_sync(self, paths: WorkPaths, body: str, if_match: str) -> dict[str, Any]:
        disk_hash = self._disk_hash_or_empty(paths.general_outline_md)
        if disk_hash != if_match:
            raise _external_modified(paths.general_outline_md, disk_hash)
        payload_bytes = body.encode("utf-8")
        atomic_write_text(paths.general_outline_md, body)
        return {"hash": content_hash(payload_bytes)}

    # ------------------------------------------------------------------
    # 卷纲
    # ------------------------------------------------------------------

    async def list_volumes(self, work_id: str) -> list[dict[str, Any]]:
        paths = self._paths(work_id)
        return await anyio.to_thread.run_sync(self._list_volumes_sync, paths)

    def _list_volumes_sync(self, paths: WorkPaths) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        if not paths.volume_outline_dir.is_dir():
            return items
        for md in sorted(paths.volume_outline_dir.glob("*.md"), key=lambda p: p.name):
            try:
                item = self._load_volume_item(md)
            except (ValueError, OSError) as exc:
                logger.warning(
                    "卷纲解析失败，已在清单中跳过",
                    extra={"extra_fields": {"path": str(md), "error": str(exc)}},
                )
                continue
            if item is None:
                logger.warning(
                    "卷纲缺少 frontmatter，已在清单中跳过",
                    extra={"extra_fields": {"path": str(md)}},
                )
                continue
            items.append(item)
        return items

    def _load_volume_item(self, md: Path) -> dict[str, Any] | None:
        """读单个卷纲文件为**清单项**（含 hash，不含 body —— 清单不放大字段，
        与 codex 清单同一条纪律）。"""
        loaded = _load(md)
        if loaded is None:
            return None
        text, raw = loaded
        volume = parse_volume(text)
        if volume is None:
            return None
        return {
            "order": volume.order,
            "title": volume.title,
            "slug": _slug_of(md.name),
            "hash": content_hash(raw),
        }

    async def read_volume(self, work_id: str, order: int) -> dict[str, Any]:
        paths = self._paths(work_id)
        return await anyio.to_thread.run_sync(self._read_volume_sync, paths, order)

    def _read_volume_sync(self, paths: WorkPaths, order: int) -> dict[str, Any]:
        md = self._find_volume_file(paths, order)
        if md is None:
            raise OutlineNotFound(order)
        text, raw = _require_loaded(md, order)
        volume = parse_volume(text)
        if volume is None:
            raise DomainError(
                "READ_FAILED",
                "这一卷的大纲文件缺少 frontmatter，不是砚台创建的大纲格式。",
                detail={"path": str(md)},
            )
        return {
            "order": volume.order,
            "title": volume.title,
            "slug": _slug_of(md.name),
            "body": volume.body,
            "hash": content_hash(raw),
        }

    async def create_volume(self, work_id: str, title: str, body: str) -> dict[str, Any]:
        async with self._lock(work_id):
            paths = self._paths(work_id)
            return await anyio.to_thread.run_sync(self._create_volume_sync, paths, title, body)

    def _create_volume_sync(self, paths: WorkPaths, title: str, body: str) -> dict[str, Any]:
        existing = self._list_volumes_sync(paths)
        next_order = max((item["order"] for item in existing), default=0) + 1
        # 重名卷与 codex 同款 "-2" 后缀：人读的目录名要能猜（D-2 同理由）。
        base_slug = slugify(title)
        slug = base_slug
        suffix = 2
        taken = {item["slug"] for item in existing}
        while slug in taken:
            slug = f"{base_slug}-{suffix}"
            suffix += 1

        volume = VolumeOutline(order=next_order, title=title, body=body)
        payload = dump_volume(volume)
        atomic_write_text(paths.volume_outline_md(next_order, slug), payload)
        return {
            "order": next_order,
            "title": volume.title,
            "slug": slug,
            "hash": content_hash(payload.encode("utf-8")),
        }

    async def write_volume(
        self, work_id: str, order: int, *, title: str, body: str, new_order: int, if_match: str
    ) -> dict[str, Any]:
        async with self._lock(work_id):
            paths = self._paths(work_id)
            return await anyio.to_thread.run_sync(
                self._write_volume_sync, paths, order, title, body, new_order, if_match
            )

    def _write_volume_sync(
        self,
        paths: WorkPaths,
        order: int,
        title: str,
        body: str,
        new_order: int,
        if_match: str,
    ) -> dict[str, Any]:
        md = self._find_volume_file(paths, order)
        if md is None:
            raise OutlineNotFound(order)
        text, raw = _require_loaded(md, order)
        disk_hash = content_hash(raw)
        if disk_hash != if_match:
            raise _external_modified(md, disk_hash)

        old = parse_volume(text)
        if old is None:
            raise DomainError(
                "READ_FAILED",
                "这一卷的大纲文件缺少 frontmatter，不是砚台创建的大纲格式。",
                detail={"path": str(md)},
            )

        # 改 title 才重算 slug；只改 body 不动文件名 —— 少一次改名就少一次
        # 外部工具（备份/同步盘）的失配。
        new_slug = slugify(title) if title != old.title else _slug_of(md.name)
        target = paths.volume_outline_md(new_order, new_slug)

        # order 是卷的**唯一身份键**（URL 寻址、超期判断都靠它）。移动到
        # 已占用的 order 会造出两个同 order 的卷 —— `_find_volume_file` 只能
        # 返回其中一个，另一卷就"消失"了。所以先拦 order 占用，再看文件名。
        if new_order != order and self._find_volume_file(paths, new_order) is not None:
            raise InvalidParam(
                f"第 {new_order} 卷已存在，不能移动到这个位置。请使用「上移/下移」交换顺序。",
                detail={"targetOrder": new_order},
            )

        volume = VolumeOutline(order=new_order, title=title, body=body)
        payload = dump_volume(volume)
        if target != md and target.exists():
            # 目标文件名被占（order 没冲突但 slug 撞了 —— 例如改名成与另一卷
            # 同名）。拒绝并留 detail，别在看似普通的保存里做覆盖。
            raise InvalidParam(
                f"文件名 {target.name} 已被占用，请换一个卷名。",
                detail={"targetName": target.name},
            )
        atomic_write_text(target, payload)
        if target != md:
            md.unlink()
        return {
            "order": new_order,
            "title": volume.title,
            "slug": new_slug,
            "hash": content_hash(payload.encode("utf-8")),
        }

    async def delete_volume(self, work_id: str, order: int) -> dict[str, Any]:
        async with self._lock(work_id):
            paths = self._paths(work_id)
            return await anyio.to_thread.run_sync(self._delete_volume_sync, paths, order)

    def _delete_volume_sync(self, paths: WorkPaths, order: int) -> dict[str, Any]:
        md = self._find_volume_file(paths, order)
        if md is None:
            raise OutlineNotFound(order)
        try:
            md.unlink()
        except FileNotFoundError as exc:
            raise OutlineNotFound(order) from exc
        return {"ok": True}

    async def reorder_volume(self, work_id: str, order: int, direction: str) -> dict[str, Any]:
        """上移/下移：与相邻卷一次性交换。

        两次 PUT 换顺序的中间态 = 一个 order 上暂时没有文件，任何在中间态
        读清单的请求都会看到"少了一卷"。交换必须在一把锁里、按"先写新再删旧"
        一次完成两个卷的迁移。
        """
        async with self._lock(work_id):
            paths = self._paths(work_id)
            return await anyio.to_thread.run_sync(
                self._reorder_volume_sync, paths, order, direction
            )

    def _reorder_volume_sync(self, paths: WorkPaths, order: int, direction: str) -> dict[str, Any]:
        orders = sorted(item["order"] for item in self._list_volumes_sync(paths))
        if order not in orders:
            raise OutlineNotFound(order)
        index = orders.index(order)
        if direction == "up":
            if index == 0:
                raise InvalidParam("已经是第一卷，不能上移。")
            other_order = orders[index - 1]
        elif direction == "down":
            if index == len(orders) - 1:
                raise InvalidParam("已经是最后一卷，不能下移。")
            other_order = orders[index + 1]
        else:
            raise InvalidParam("direction 只能是 up 或 down。", detail={"direction": direction})

        me_file = self._find_volume_file(paths, order)
        other_file = self._find_volume_file(paths, other_order)
        if me_file is None or other_file is None:
            raise OutlineNotFound(order)
        me = self._read_volume_doc(me_file, order)
        other = self._read_volume_doc(other_file, other_order)

        # 交换后的目标名 = 对方的 order + 自己的 slug。卷纲目录内 slug 唯一
        # （建卷时已保证），所以两个目标名既互不相同、也不同于两个源名 ——
        # 没有 rename 撞名，不需要临时中转名。
        me_target = paths.volume_outline_md(other_order, _slug_of(me_file.name))
        other_target = paths.volume_outline_md(order, _slug_of(other_file.name))
        if me_target.exists() or other_target.exists():
            # 只有外部手改过文件名才会走到这（比如两卷 slug 撞了）。
            # 拒绝并留 detail，别在"看似普通的排序操作"里做覆盖。
            raise InvalidParam(
                "交换顺序需要的文件名被占用，请检查 outline/卷纲/ 目录里的文件。",
                detail={"me": me_target.name, "other": other_target.name},
            )

        me_moved = me.model_copy(update={"order": other_order})
        other_moved = other.model_copy(update={"order": order})
        atomic_write_text(me_target, dump_volume(me_moved))
        me_file.unlink()
        atomic_write_text(other_target, dump_volume(other_moved))
        other_file.unlink()
        return {"ok": True}

    def _read_volume_doc(self, md: Path, order: int) -> VolumeOutline:
        text, _raw = _require_loaded(md, order)
        volume = parse_volume(text)
        if volume is None:
            raise DomainError(
                "READ_FAILED",
                "卷纲文件缺少 frontmatter，无法参与交换顺序。",
                detail={"path": str(md)},
            )
        return volume

    def _find_volume_file(self, paths: WorkPaths, order: int) -> Path | None:
        """按 frontmatter 的 order 找卷纲文件（order 的真源，文件名前缀只是
        双写的另一半）。卷纲数量级是一打以内，全量核对 frontmatter 比按前缀
        猜更稳：手改过文件名的卷仍然找得到，不会"消失"。"""
        directory = paths.volume_outline_dir
        if not directory.is_dir():
            return None
        for md in sorted(directory.glob("*.md"), key=lambda p: p.name):
            loaded = _load(md)
            if loaded is None:
                continue
            text, _raw = loaded
            try:
                volume = parse_volume(text)
            except ValueError:
                continue
            if volume is not None and volume.order == order:
                return md
        return None

    # ------------------------------------------------------------------
    # 章纲（upsert 语义；chapterId 真源 = URL）
    # ------------------------------------------------------------------

    async def read_chapter_outline(self, work_id: str, chapter_id: str) -> dict[str, Any]:
        paths = self._paths(work_id)
        return await anyio.to_thread.run_sync(self._read_chapter_sync, paths, chapter_id)

    def _read_chapter_sync(self, paths: WorkPaths, chapter_id: str) -> dict[str, Any]:
        path = paths.chapter_outline_md(chapter_id)
        loaded = _load(path)
        if loaded is None:
            # 不存在不是错误：返回空壳（hash=""），前端直接进入"写章纲"态。
            return _chapter_shell(chapter_id)
        text, raw = loaded
        try:
            outline = parse_chapter_outline(text, chapter_id=chapter_id)
        except ValueError as exc:
            raise DomainError(
                "READ_FAILED",
                "这张章纲的文件无法解析（frontmatter 不是合法 YAML 或结构不对）。",
                detail={"path": str(path), "reason": str(exc)},
            ) from exc
        if outline is None:
            return _chapter_shell(chapter_id)
        return _chapter_item(chapter_id, outline, content_hash(raw))

    async def write_chapter_outline(
        self,
        work_id: str,
        chapter_id: str,
        *,
        foreshadow: list[Foreshadow] | None,
        body: str,
        if_match: str,
    ) -> dict[str, Any]:
        async with self._lock(work_id):
            paths = self._paths(work_id)
            # 章节存在性在锁内判：用户可能正删着章节清单的另一头。
            return await anyio.to_thread.run_sync(
                self._write_chapter_sync, paths, work_id, chapter_id, foreshadow, body, if_match
            )

    def _write_chapter_sync(
        self,
        paths: WorkPaths,
        work_id: str,
        chapter_id: str,
        foreshadow: list[Foreshadow] | None,
        body: str,
        if_match: str,
    ) -> dict[str, Any]:
        if chapter_id not in self._registry.chapter_ids_sync(work_id):
            # 给不存在的章节写章纲 = 引用一个悬空锚点，宁响不糊。
            raise ChapterNotFound(chapter_id)

        path = paths.chapter_outline_md(chapter_id)
        disk_hash = self._disk_hash_or_empty(path)
        if disk_hash != if_match:
            raise _external_modified(path, disk_hash)

        # foreshadow=None 保留原值：客户端"只改正文"时不必回声整个伏笔数组；
        # 显式传 [] 才是"清空伏笔"。PUT 语义里开这一个口子是刻意的宽容 ——
        # 强迫回声会让"手滑清空别人登记的伏笔"变得太容易。
        if foreshadow is None:
            foreshadow = self._existing_foreshadow(path, chapter_id)

        outline = ChapterOutline(
            chapterId=chapter_id,
            foreshadow=[self._ensure_foreshadow_id(item) for item in foreshadow],
            body=body,
        )
        payload = dump_chapter_outline(outline)
        payload_bytes = payload.encode("utf-8")
        atomic_write_text(path, payload)
        return _chapter_item(chapter_id, outline, content_hash(payload_bytes))

    def _existing_foreshadow(self, path: Path, chapter_id: str) -> list[Foreshadow]:
        loaded = _load(path)
        if loaded is None:
            return []
        text, _raw = loaded
        parsed = parse_chapter_outline(text, chapter_id=chapter_id)
        return parsed.foreshadow if parsed is not None else []

    @staticmethod
    def _ensure_foreshadow_id(item: Foreshadow) -> Foreshadow:
        """手写文件读出的占位 id（``fs_manual_*``）与客户端漏传的空 id 统一在
        这里换成正式 id —— 占位 id 落盘会永远占着 "manual" 名字，两个手动项
        还会在聚合里撞出重复 id。"""
        if item.id.startswith("fs_manual") or not item.id.strip():
            return item.model_copy(update={"id": new_foreshadow_id()})
        return item

    # ------------------------------------------------------------------
    # 伏笔聚合（D-5：扫描现算，不落派生文件）
    # ------------------------------------------------------------------

    async def foreshadows(self, work_id: str) -> dict[str, Any]:
        paths = self._paths(work_id)
        return await anyio.to_thread.run_sync(self._foreshadows_sync, paths, work_id)

    def _foreshadows_sync(self, paths: WorkPaths, work_id: str) -> dict[str, Any]:
        chapter_ids = self._registry.chapter_ids_sync(work_id)
        max_volume = max((item["order"] for item in self._list_volumes_sync(paths)), default=0)

        items: list[dict[str, Any]] = []
        if paths.chapter_outline_dir.is_dir():
            for md in sorted(paths.chapter_outline_dir.glob("*.md"), key=lambda p: p.name):
                cid = md.stem
                loaded = _load(md)
                if loaded is None:
                    continue
                text, _raw = loaded
                try:
                    outline = parse_chapter_outline(text, chapter_id=cid)
                except ValueError as exc:
                    logger.warning(
                        "章纲解析失败，伏笔聚合已跳过",
                        extra={"extra_fields": {"path": str(md), "error": str(exc)}},
                    )
                    continue
                if outline is None:
                    continue
                for entry in outline.foreshadow:
                    items.append(
                        {
                            "id": entry.id,
                            "title": entry.title,
                            "status": entry.status,
                            "expectResolveBy": entry.expectResolveBy,
                            "resolvedIn": entry.resolvedIn,
                            "chapterId": cid,
                            # 章节已删但章纲还在（D-3 的"孤儿"）：聚合层把事实
                            # 带回去，由前端决定怎么灰显 —— 服务端不替用户删。
                            "orphan": cid not in chapter_ids,
                            # 超期 = 还开着 + 说了期望卷 + 已经写到更后面的卷。
                            # expectResolveBy=None 是"无限期"，永不提醒；
                            # 用户还没建下一卷（max_volume 没超过）也不算超期
                            # —— 没有"进度"就没有"超期"。
                            "overdue": entry.status == "open"
                            and entry.expectResolveBy is not None
                            and max_volume > entry.expectResolveBy,
                        }
                    )
        # 目录名字典序 ≈ 建纲顺序；同章内保持登记顺序。前端拿到就是稳定序。
        return {"items": items}

    def _disk_hash_or_empty(self, path: Path) -> str:
        loaded = _load(path)
        if loaded is None:
            return ""
        _text, raw = loaded
        return content_hash(raw)


# ---------------------------------------------------------------------------
# 纯函数
# ---------------------------------------------------------------------------


def _slug_of(filename: str) -> str:
    """``001-第一卷.md`` → ``第一卷``（剥 NNN 前缀与扩展名，供响应回带 slug）。"""
    match = _VOLUME_NAME_RE.match(filename)
    return match.group(2) if match else filename.removesuffix(".md")


def _require_loaded(md: Path, order: int) -> tuple[str, bytes]:
    loaded = _load(md)
    if loaded is None:
        # 清单里还在、文件刚被外部删了（竞态窗口）—— 对外表现与"不存在"一致。
        raise OutlineNotFound(order)
    return loaded


def _external_modified(path: Path, disk_hash: str) -> DomainError:
    return DomainError(
        "EXTERNAL_MODIFIED",
        "这份大纲文件已被外部修改，你的改动没有保存。",
        detail={"diskHash": disk_hash, "path": str(path)},
    )


def _chapter_shell(chapter_id: str) -> dict[str, Any]:
    return {"chapterId": chapter_id, "foreshadow": [], "body": "", "hash": ""}


def _chapter_item(chapter_id: str, outline: ChapterOutline, hash_value: str) -> dict[str, Any]:
    return {
        "chapterId": chapter_id,
        "foreshadow": [item.model_dump() for item in outline.foreshadow],
        "body": outline.body,
        "hash": hash_value,
    }
