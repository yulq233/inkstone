"""作品相关端点（03 文档 §7.2）。

路径里带 ``workId`` 不是冗余：``chapterId`` 虽然全局唯一，但要"从 id 反查目录"
就得把每个作品都扫一遍。带上 workId 后可以直接命中已缓存的章节清单。
"""

from __future__ import annotations

from fastapi import APIRouter, Query, Request, status

from ...storage.repo import WorkRegistry
from .schemas import CreateChapterRequest, CreateWorkRequest, OpenWorkRequest

router = APIRouter()


def _registry(request: Request) -> WorkRegistry:
    return request.app.state.registry


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
    return {"items": _registry(request).recent()}


@router.delete("/works/recent")
async def forget_recent(
    request: Request, root_path: str = Query(alias="rootPath", min_length=1)
) -> dict[str, object]:
    """从最近列表移除一条。

    只动"应用状态"，**不碰作品目录**。目录已被移动/删除时，"移除"是唯一能做的清理。
    """
    return {"removed": _registry(request).remove_recent(root_path)}


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
