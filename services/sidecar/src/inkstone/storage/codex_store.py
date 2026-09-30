"""Codex 条目的仓储 —— ``docs/15`` B1 / D-2 / D-4。

与 ``repo.py`` 同一套生存法则（读那个模块的注释再回来）：

- **文件即真源**，无数据库；这里没有任何缓存 —— codex 的单条读就是一次
  文件读，量级撑不起缓存，缓存反而要回答"外部改动怎么失效"的问题（D-4
  的 hash 预条件已经承担外部改动检测，别再造第二套）。
- 阻塞 IO 全部 ``anyio.to_thread``，不占事件循环。
- 并发：per-work 一把 ``asyncio.Lock`` 管全部写（``docs/15`` §2.4）——
  codex/outline 都是低频轻量写，不细分子资源锁；两把锁的**获取顺序**
  是并发 bug 的温床，一把锁就没有顺序问题。
- 一条坏文件**不能炸掉整个清单**（跳过 + warn），与章节扫描同构。
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any

import anyio

from ..domain.codex import CODEX_TYPES, CodexEntry, dump_entry, parse_entry
from ..domain.paths import WorkPaths, slugify
from ..errors import CodexNotFound, DomainError, InvalidParam, NotUtf8, WorkNotFound
from .atomic import atomic_write_text, content_hash, read_bytes
from .repo import WorkRegistry

logger = logging.getLogger("inkstone.codex")


def entry_path(paths: WorkPaths, entry_type: str, slug: str) -> Path:
    """条目文件的唯一路径。**路径规则只活在这里**（与 ``WorkPaths`` 同一条纪律）：
    type 目录用字面量、文件名是 slug，调用方一律通过本函数取路径。"""
    return paths.codex_dir / entry_type / f"{slug}.md"


def _decode(raw: bytes, path: Path) -> str:
    try:
        # utf-8-sig：容忍记事本"UTF-8 带 BOM"。BOM 只该出现在文件头且无害，
        # 为它拒绝打开是让用户替我们的解析器擦屁股。
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise NotUtf8(str(path)) from exc


class CodexStore:
    """Codex 条目的读写入口。进程内单例（挂在 ``app.state``）。"""

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
        # work_paths 对未打开的作品抛 WorkNotFound —— codex 不自己判存在性，
        # "作品打开没有"的真相只在 registry 一处。
        try:
            return self._registry.work_paths(work_id)
        except WorkNotFound:
            raise
        # 其余异常原样穿透：这里不做"顺手包一层"的错误翻译。

    # ------------------------------------------------------------------
    # 读
    # ------------------------------------------------------------------

    async def list_entries(self, work_id: str) -> list[dict[str, Any]]:
        paths = self._paths(work_id)
        return await anyio.to_thread.run_sync(self._list_sync, paths)

    def _list_sync(self, paths: WorkPaths) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        codex_root = paths.codex_dir
        if not codex_root.is_dir():
            return []
        for type_dir in sorted(codex_root.iterdir(), key=lambda p: p.name):
            if not type_dir.is_dir():
                continue
            if type_dir.name not in CODEX_TYPES:
                # 用户在 codex/ 下放了自己的目录。跳过并留痕 —— 与章节扫描
                # 对"解析不了的目录"同一策略：忽略但不报错中断。
                logger.warning(
                    "忽略不认识的 codex 类型目录",
                    extra={"extra_fields": {"name": type_dir.name}},
                )
                continue
            for md in sorted(type_dir.glob("*.md"), key=lambda p: p.name):
                try:
                    entry, raw = self._load_file(md)
                except (ValueError, OSError) as exc:
                    logger.warning(
                        "codex 条目解析失败，已在清单中跳过",
                        extra={"extra_fields": {"path": str(md), "error": str(exc)}},
                    )
                    continue
                if entry is None:
                    logger.warning(
                        "codex 条目缺少 frontmatter，已在清单中跳过",
                        extra={"extra_fields": {"path": str(md)}},
                    )
                    continue
                items.append(_summary_item(type_dir.name, md.stem, entry, content_hash(raw)))
        return items

    async def read_entry(self, work_id: str, entry_type: str, slug: str) -> dict[str, Any]:
        paths = self._paths(work_id)
        _ensure_type(entry_type)
        return await anyio.to_thread.run_sync(self._read_sync, paths, entry_type, slug)

    def _read_sync(self, paths: WorkPaths, entry_type: str, slug: str) -> dict[str, Any]:
        path = entry_path(paths, entry_type, slug)
        try:
            entry, raw = self._load_file(path)
        except FileNotFoundError as exc:
            raise CodexNotFound(entry_type, slug) from exc
        except ValueError as exc:
            # 单条读遇到坏文件必须**响亮地失败**：清单跳过是"不炸全局"，
            # 这里再吞掉就成了"点开没反应"。
            raise DomainError(
                "READ_FAILED",
                "这条设定的文件无法解析（frontmatter 不是合法 YAML 或结构不对）。",
                detail={"path": str(path), "reason": str(exc)},
            ) from exc
        if entry is None:
            raise DomainError(
                "READ_FAILED",
                "这条设定的文件缺少 frontmatter，不是砚台创建的设定文件格式。",
                detail={"path": str(path)},
            )
        return _full_item(entry_type, slug, entry, content_hash(raw))

    def _load_file(self, path: Path) -> tuple[CodexEntry | None, bytes]:
        raw = read_bytes(path)
        return parse_entry(_decode(raw, path)), raw

    # ------------------------------------------------------------------
    # 写
    # ------------------------------------------------------------------

    async def create_entry(self, work_id: str, entry: CodexEntry) -> dict[str, Any]:
        async with self._lock(work_id):
            paths = self._paths(work_id)
            return await anyio.to_thread.run_sync(self._create_sync, paths, entry)

    def _create_sync(self, paths: WorkPaths, entry: CodexEntry) -> dict[str, Any]:
        type_dir = paths.codex_dir / entry.type
        type_dir.mkdir(parents=True, exist_ok=True)

        # D-2：slug 来自 name；重名加 "-2"、"-3" —— 不用随机后缀，
        # 人读的目录名要能猜。唯一性只在**本类型目录**内保证：
        # 不同类型各住各的目录，"人物与地点同名"是合法的。
        base_slug = slugify(entry.name)
        slug = base_slug
        suffix = 2
        while entry_path(paths, entry.type, slug).exists():
            slug = f"{base_slug}-{suffix}"
            suffix += 1

        path = entry_path(paths, entry.type, slug)
        payload = dump_entry_text(entry)
        atomic_write_text(path, payload)
        return _full_item(entry.type, slug, entry, content_hash(payload.encode("utf-8")))

    async def write_entry(
        self, work_id: str, entry_type: str, slug: str, entry: CodexEntry, if_match: str
    ) -> dict[str, Any]:
        if entry.type != entry_type:
            # URL 与请求体各带一份 type，两边不一致说明调用方拼错了 ——
            # 400 而不是按 URL 的来：静默改成"另一个类型的文件"太危险。
            raise InvalidParam(
                "请求体的 type 与 URL 不一致。",
                detail={"urlType": entry_type, "bodyType": entry.type},
            )
        async with self._lock(work_id):
            paths = self._paths(work_id)
            return await anyio.to_thread.run_sync(
                self._write_sync, paths, entry_type, slug, entry, if_match
            )

    def _write_sync(
        self, paths: WorkPaths, entry_type: str, slug: str, entry: CodexEntry, if_match: str
    ) -> dict[str, Any]:
        path = entry_path(paths, entry_type, slug)
        try:
            raw = read_bytes(path)
        except FileNotFoundError as exc:
            raise CodexNotFound(entry_type, slug) from exc

        # D-4：乐观并发。hash 基于**原始字节**（含行尾、BOM），外部编辑器
        # 哪怕只动了一个空格也要被认出来 —— 与章节同一份哲学。
        disk_hash = content_hash(raw)
        if disk_hash != if_match:
            raise DomainError(
                "EXTERNAL_MODIFIED",
                "这条设定的文件已被外部修改，你的改动没有保存。",
                detail={
                    "diskHash": disk_hash,
                    "diskMarkdown": _decode(raw, path),
                },
            )

        payload = dump_entry_text(entry)
        atomic_write_text(path, payload)
        return _full_item(entry_type, slug, entry, content_hash(payload.encode("utf-8")))

    async def delete_entry(self, work_id: str, entry_type: str, slug: str) -> dict[str, Any]:
        async with self._lock(work_id):
            paths = self._paths(work_id)
            return await anyio.to_thread.run_sync(self._delete_sync, paths, entry_type, slug)

    def _delete_sync(self, paths: WorkPaths, entry_type: str, slug: str) -> dict[str, Any]:
        path = entry_path(paths, entry_type, slug)
        try:
            path.unlink()
        except FileNotFoundError as exc:
            raise CodexNotFound(entry_type, slug) from exc
        # 清掉可能已空的手动分类目录会让用户失去自己建的目录结构 —— 不清。
        return {"ok": True}

    async def broken_relations(self, work_id: str) -> list[dict[str, Any]]:
        paths = self._paths(work_id)
        return await anyio.to_thread.run_sync(self._broken_sync, paths)

    def _broken_sync(self, paths: WorkPaths) -> list[dict[str, Any]]:
        """断链清单（D-2）：relations 指向的 slug 已不存在。

        扫描现算，不落派生文件 —— P0 数据量小，缓存省下的时间远抵不过
        "缓存失效"要回答的问题。改名是"新文件 + 删旧文件"的组合，
        中间态天然存在，断链由**下一次扫描**收敛，不阻塞任何写入。
        """
        existing: set[str] = set()
        entries: list[tuple[str, str, CodexEntry]] = []
        codex_root = paths.codex_dir
        if not codex_root.is_dir():
            return []
        for type_dir in sorted(codex_root.iterdir(), key=lambda p: p.name):
            if not type_dir.is_dir() or type_dir.name not in CODEX_TYPES:
                continue
            for md in sorted(type_dir.glob("*.md"), key=lambda p: p.name):
                try:
                    entry, _raw = self._load_file(md)
                except (ValueError, OSError) as exc:
                    logger.warning(
                        "codex 条目解析失败，断链检查已跳过",
                        extra={"extra_fields": {"path": str(md), "error": str(exc)}},
                    )
                    continue
                if entry is None:
                    continue
                existing.add(md.stem)
                entries.append((type_dir.name, md.stem, entry))

        broken: list[dict[str, Any]] = []
        for entry_type, slug, entry in entries:
            for relation in entry.relations:
                if relation.to not in existing:
                    broken.append(
                        {
                            "type": entry_type,
                            "slug": slug,
                            "name": entry.name,
                            "to": relation.to,
                            "kind": relation.kind,
                        }
                    )
        return broken


# ---------------------------------------------------------------------------
# 纯函数：响应形状
# ---------------------------------------------------------------------------


def dump_entry_text(entry: CodexEntry) -> str:
    """落盘前统一从这里拿文件文本：将来若要在序列化处统一加东西（不会），
    只有这一处要改。"""
    return dump_entry(entry)


def _summary_item(
    entry_type: str, slug: str, entry: CodexEntry, hash_value: str
) -> dict[str, Any]:
    """清单项 —— **不含 body/fields/relations**：清单要一次扫全部文件，
    把大字段拉出来会让"打开侧栏"变成一次全量读盘的放大器。"""
    return {
        "type": entry_type,
        "slug": slug,
        "name": entry.name,
        "aliases": entry.aliases,
        "tags": entry.tags,
        "summary": entry.summary,
        "hash": hash_value,
    }


def _full_item(
    entry_type: str, slug: str, entry: CodexEntry, hash_value: str
) -> dict[str, Any]:
    return {
        **_summary_item(entry_type, slug, entry, hash_value),
        "fields": entry.fields,
        "relations": [relation.model_dump() for relation in entry.relations],
        "body": entry.body,
    }


def _ensure_type(entry_type: str) -> None:
    if entry_type not in CODEX_TYPES:
        raise InvalidParam(
            "未知的设定类型。", detail={"type": entry_type, "known": list(CODEX_TYPES)}
        )
