"""仓储的加锁覆盖面（`docs/13` M6）。

刻意不走 HTTP：**锁的获取顺序在路由层看不见**，只能直接对 `WorkRegistry` 断言。

## 为什么断言"锁拿了没、按什么顺序拿"，而不是断言"没出重复章节"

竞态本身（写入落进已被改名的旧目录 → 老目录复活成重复章节）在单测里**无法稳定复现** ——
它依赖两个线程的交错时机。但**锁覆盖面是确定性的**，而修复的全部内容恰好就是
"多拿一把伞 + 固定顺序"。所以这里钉的是：

1. `write_chapter` 必须**同时**拿到 work 锁与 chapter 锁（修复前只拿后者）；
2. 获取顺序必须固定为 **work → chapter**（`create_chapter` 只拿 work 锁、从不拿 chapter 锁，
   所以只要顺序一致就不存在死锁）；
3. 端到端行为：一次慢写进行中，`create_chapter` 必须**卡在锁上**，不能进去重排目录。
"""

from __future__ import annotations

import asyncio
import threading
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import anyio
import pytest

import inkstone.storage.repo as repo_module
from inkstone.config import Settings
from inkstone.storage.atomic import atomic_write_bytes as real_atomic_write_bytes
from inkstone.storage.repo import WorkRegistry

_NEW_BODY = "# 第一章\n\n改过了。\n"
_SECOND_BODY = "# 第二章\n\n也改过了。\n"


async def _make_work(registry: WorkRegistry, parent_dir: Path) -> tuple[str, str, str]:
    """建一部作品，返回 (work_id, chapter_id, chapter_hash)。"""
    created = await registry.create(parent_dir=str(parent_dir), title="云京锁测试")
    work_id = str(created["id"])
    chapters = await registry.list_chapters(work_id)
    chapter_id = str(chapters[0]["id"])
    chapter = await registry.read_chapter(work_id, chapter_id)
    return work_id, chapter_id, str(chapter["hash"])


def _install_order_recorder(
    monkeypatch: pytest.MonkeyPatch, registry: WorkRegistry
) -> list[str]:
    """把两个锁工厂换成"记录版"，返回按**获取顺序**填充的列表。"""
    order: list[str] = []
    real_work = registry._work_lock
    real_chapter = registry._chapter_lock

    @asynccontextmanager
    async def record(name: str, lock: asyncio.Lock) -> AsyncIterator[None]:
        async with lock:
            # 拿到之后才记 —— 这样列表反映的是"谁先真正进入临界区"。
            order.append(name)
            yield

    def work_lock(work_id: str) -> Any:
        return record("work", real_work(work_id))

    def chapter_lock(chapter_id: str) -> Any:
        return record("chapter", real_chapter(chapter_id))

    monkeypatch.setattr(registry, "_work_lock", work_lock)
    monkeypatch.setattr(registry, "_chapter_lock", chapter_lock)
    return order


def test_write_chapter_takes_the_work_lock_before_the_chapter_lock(
    settings: Settings, parent_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """M6 的确定性钉子：写入必须**两层锁都拿**，且顺序固定为 work → chapter。"""

    async def scenario() -> list[str]:
        registry = WorkRegistry(settings)
        work_id, chapter_id, base_hash = await _make_work(registry, parent_dir)
        order = _install_order_recorder(monkeypatch, registry)
        await registry.write_chapter(
            work_id, chapter_id, markdown=_NEW_BODY, base_hash=base_hash
        )
        return order

    assert asyncio.run(scenario()) == ["work", "chapter"]


def test_create_chapter_does_not_resurrect_a_directory_being_written(
    settings: Settings, parent_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """慢写进行中插入一章 → 不许出现**重复 order**。

    这是一个**真实复现**（不是结构断言）：

    - 作品有第 1、2 章；写入对象是**第 2 章**；
    - 在第 1 章后插入新章 → 第 2 章会被改名成 `003-第二章`；
    - 若写入不占 work 锁，它会按**已经失效的 order=2** 落盘，而
      `atomic_write_bytes` 会把父目录建出来 → `002-第二章` **原地复活**。
      于是 `manuscript/` 里出现两个 order=2 的目录，扫出来是 `[1, 2, 2, 3]`。

    卡点选在 `atomic_write_bytes`（真正落盘那一步），而不是整个
    `_write_chapter_sync`：路径是在 `_write_chapter_sync` **内部**按当时的 order 算出来的
    （`_find` 会重扫），所以必须让"算路径"早于"插入"，才能踩到那个窗口。
    """

    async def scenario() -> list[int]:
        registry = WorkRegistry(settings)
        created = await registry.create(parent_dir=str(parent_dir), title="云京锁测试")
        work_id = str(created["id"])
        await registry.create_chapter(work_id, title="第二章")

        chapters = await registry.list_chapters(work_id, refresh=True)
        first = next(c for c in chapters if c["order"] == 1)
        second = next(c for c in chapters if c["order"] == 2)
        chapter = await registry.read_chapter(work_id, str(second["id"]))

        inside = threading.Event()
        release = threading.Event()

        def paused_write(path: Path, payload: bytes) -> None:
            inside.set()
            assert release.wait(5), "测试自身超时：写入没被放行"
            real_atomic_write_bytes(path, payload)

        # 打的是 `repo.py` 命名空间里的那个名字（它是在模块顶部 import 进来的）——
        # 换掉 `atomic` 模块自己的属性起不到作用。
        monkeypatch.setattr(repo_module, "atomic_write_bytes", paused_write)

        writer = asyncio.create_task(
            registry.write_chapter(
                work_id,
                str(second["id"]),
                markdown=_SECOND_BODY,
                base_hash=str(chapter["hash"]),
            )
        )
        await anyio.to_thread.run_sync(inside.wait, 5)

        creator = asyncio.create_task(
            registry.create_chapter(work_id, title="插入的章", after_chapter_id=str(first["id"]))
        )
        for _ in range(50):
            await asyncio.sleep(0)
        assert not creator.done(), "插入章节不该在章节写入落盘期间进入目录重排"

        release.set()
        await writer
        await creator
        return [c["order"] for c in await registry.list_chapters(work_id, refresh=True)]

    assert asyncio.run(scenario()) == [1, 2, 3]
