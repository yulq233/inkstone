"""仓储的容错不变量（`docs/13` M2）。

## 为什么这条不能在 HTTP 层测

`_load_or_heal_meta` 会把坏掉的 `meta.json` **重建**，所以单线程走一遍那条路径
根本碰不到要测的异常 —— 只有"重建又写不进去"（磁盘满、文件被占、权限不足）时，
坏文件才会留在原地，然后"插入章节后顺手对齐各章 order"那一步才读得到它。
那个组合只能靠"把 `_try_write_meta` 打成空操作"来构造。

## 为什么断言的是"异常被吞掉"而不是"接口没崩"

M2 的修法就是给 `suppress` 补两个异常类型（`JSONDecodeError` / `InvalidParam`）。
少补一个的后果：此刻**目录已经重排完、新章节还没建**，异常却一路逃逸成 500 ——
后续请求看到的是一个"章节序号跳号、新章不存在"的半成品作品，比直接失败更难查。
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from inkstone.config import Settings
from inkstone.storage.repo import WorkRegistry


def test_broken_meta_does_not_escape_when_healing_cannot_write(
    settings: Settings, parent_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def scenario() -> list[int]:
        registry = WorkRegistry(settings)
        created = await registry.create(parent_dir=str(parent_dir), title="云京容错测试")
        work_id = str(created["id"])
        await registry.create_chapter(work_id, title="第二章")

        chapters = await registry.list_chapters(work_id, refresh=True)
        first = next(c for c in chapters if c["order"] == 1)

        paths = registry.work_paths(work_id)
        second_dir = next(
            entry for entry in paths.manuscript_dir.iterdir() if entry.name.startswith("002-")
        )
        meta_path = second_dir / "meta.json"
        meta_path.write_text("{ 这不是 JSON", encoding="utf-8")

        # 让"自愈写回"变成空操作：坏文件留在磁盘上，下游那一步才读得到它。
        monkeypatch.setattr(registry, "_try_write_meta", lambda *args, **kwargs: None)

        # 在第一章后插入 → 第二章会被重排成 003，期间要读它的 meta 对齐 order。
        await registry.create_chapter(
            work_id, title="插在第一章后", after_chapter_id=str(first["id"])
        )
        return [c["order"] for c in await registry.list_chapters(work_id, refresh=True)]

    assert asyncio.run(scenario()) == [1, 2, 3]
