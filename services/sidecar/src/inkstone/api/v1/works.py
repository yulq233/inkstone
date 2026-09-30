"""作品相关端点（03 文档 §7.2）。

路径里带 ``workId`` 不是冗余：``chapterId`` 虽然全局唯一，但要"从 id 反查目录"
就得把每个作品都扫一遍。带上 workId 后可以直接命中已缓存的章节清单。
"""

from __future__ import annotations

from typing import cast

from fastapi import APIRouter, Query, Request, status

from ...storage.repo import WorkRegistry
from .schemas import CreateChapterRequest, CreateWorkRequest, OpenWorkRequest

router = APIRouter()


def _registry(request: Request) -> WorkRegistry:
    # Starlette 的 ``app.state`` 是动态属性，类型上就是 ``Any``；
    # 不 cast 的话 ``--strict`` 会用 ``warn_return_any`` 报 no-any-return。
    # 这里是**声明式**的收敛，不是"绕过类型" —— 值确实是在 app.py 里放进去的。
    return cast(WorkRegistry, request.app.state.registry)


@router.post("/works", status_code=status.HTTP_201_CREATED)
async def create_work(body: CreateWorkRequest, request: Request) -> dict[str, object]:
    work = await _registry(request).create(
        parent_dir=body.parentDir,
        title=body.title,
        author=body.author,
        genre=body.genre,
        word_goal=body.wordGoal,
    )
    return {"work": work}


@router.post("/works/open")
async def open_work(body: OpenWorkRequest, request: Request) -> dict[str, object]:
    return {"work": await _registry(request).open(body.rootPath)}


@router.get("/works/recent")
async def recent_works(request: Request) -> dict[str, object]:
    # `await` 是必需的：`recent()` 内部把磁盘读丢进线程池（`docs/13` M7）。
    # 漏掉 `await` 不会报错，只会让 FastAPI 拿到一个 coroutine 对象 ——
    # 症状是 500「Object of type coroutine is not JSON serializable」。
    return {"items": await _registry(request).recent()}


@router.delete("/works/recent")
async def forget_recent(
    request: Request, root_path: str = Query(alias="rootPath", min_length=1)
) -> dict[str, object]:
    """从最近列表移除一条。

    只动"应用状态"，**不碰作品目录**。目录已被移动/删除时，"移除"是唯一能做的清理。
    """
    return {"removed": await _registry(request).remove_recent(root_path)}


@router.get("/works/{work_id}/chapters")
async def list_chapters(
    work_id: str, request: Request, refresh: bool = Query(default=False)
) -> dict[str, object]:
    return {"items": await _registry(request).list_chapters(work_id, refresh=refresh)}


@router.post("/works/{work_id}/chapters", status_code=status.HTTP_201_CREATED)
async def create_chapter(
    work_id: str, body: CreateChapterRequest, request: Request
) -> dict[str, object]:
    chapter = await _registry(request).create_chapter(
        work_id, title=body.title, after_chapter_id=body.afterChapterId
    )
    return {"chapter": chapter}
