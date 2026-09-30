"""大纲三层端点 —— ``docs/15`` §2.3 B2。

路由形状：

- 总纲单例 → ``/outline/general``；
- 卷纲按 order 寻址（NNN 与 frontmatter 双写，order 是人可感知的键）；
- 章纲按 chapterId 寻址（**upsert**：GET 空壳 / PUT ``ifMatch=""`` 创建）；
- 伏笔聚合是独立只读端点 ``/foreshadows``（扫描章纲 frontmatter 现算，D-5）。
"""

from __future__ import annotations

from typing import cast

from fastapi import APIRouter, Request

from ...domain.ids import new_foreshadow_id
from ...domain.outline import Foreshadow
from ...errors import InvalidParam
from ...storage.outline_store import OutlineStore
from .schemas import (
    CreateVolumeRequest,
    ForeshadowIn,
    ReorderVolumeRequest,
    UpdateChapterOutlineRequest,
    UpdateGeneralOutlineRequest,
    UpdateVolumeRequest,
)

router = APIRouter()


def _store(request: Request) -> OutlineStore:
    return cast(OutlineStore, request.app.state.outline)


def _to_foreshadow(items: list[ForeshadowIn] | None) -> list[Foreshadow] | None:
    """入参 → 领域模型。空 id 在这里补齐（服务端生成，见 ForeshadowIn 注释）。"""
    if items is None:
        return None
    converted = [
        Foreshadow(
            id=item.id.strip() or new_foreshadow_id(),
            title=item.title,
            expectResolveBy=item.expectResolveBy,
            status=item.status,
            resolvedIn=item.resolvedIn,
        )
        for item in items
    ]
    ids = [item.id for item in converted]
    if len(ids) != len(set(ids)):
        # 重复 id 多半是"同一伏笔被两个窗口各自登记"——静默接受会让
        # 回收标记只命中其一，另一条永远挂着提醒。
        raise InvalidParam("伏笔 id 有重复，请刷新章纲后重试。")
    return converted


# ---- 总纲 ----


@router.get("/works/{work_id}/outline/general")
async def read_general(work_id: str, request: Request) -> dict[str, object]:
    return await _store(request).read_general(work_id)


@router.put("/works/{work_id}/outline/general")
async def write_general(
    work_id: str, body: UpdateGeneralOutlineRequest, request: Request
) -> dict[str, object]:
    return await _store(request).write_general(work_id, body.body, body.ifMatch)


# ---- 卷纲 ----


@router.get("/works/{work_id}/outline/volumes")
async def list_volumes(work_id: str, request: Request) -> dict[str, object]:
    items = await _store(request).list_volumes(work_id)
    return {"items": items}


@router.post("/works/{work_id}/outline/volumes", status_code=201)
async def create_volume(
    work_id: str, body: CreateVolumeRequest, request: Request
) -> dict[str, object]:
    volume = await _store(request).create_volume(work_id, body.title, body.body)
    return {"volume": volume}


@router.get("/works/{work_id}/outline/volumes/{order}")
async def read_volume(work_id: str, order: int, request: Request) -> dict[str, object]:
    volume = await _store(request).read_volume(work_id, order)
    return {"volume": volume}


@router.put("/works/{work_id}/outline/volumes/{order}")
async def write_volume(
    work_id: str, order: int, body: UpdateVolumeRequest, request: Request
) -> dict[str, object]:
    volume = await _store(request).write_volume(
        work_id,
        order,
        title=body.title,
        body=body.body,
        new_order=body.order if body.order is not None else order,
        if_match=body.ifMatch,
    )
    return {"volume": volume}


@router.delete("/works/{work_id}/outline/volumes/{order}")
async def delete_volume(work_id: str, order: int, request: Request) -> dict[str, object]:
    return await _store(request).delete_volume(work_id, order)


@router.post("/works/{work_id}/outline/volumes/{order}/reorder")
async def reorder_volume(
    work_id: str, order: int, body: ReorderVolumeRequest, request: Request
) -> dict[str, object]:
    """上移/下移。与相邻卷原子交换 —— 详见 OutlineStore.reorder_volume。"""
    return await _store(request).reorder_volume(work_id, order, body.direction)


# ---- 章纲 ----


@router.get("/works/{work_id}/outline/chapters/{chapter_id}")
async def read_chapter_outline(
    work_id: str, chapter_id: str, request: Request
) -> dict[str, object]:
    outline = await _store(request).read_chapter_outline(work_id, chapter_id)
    return {"outline": outline}


@router.put("/works/{work_id}/outline/chapters/{chapter_id}")
async def write_chapter_outline(
    work_id: str, chapter_id: str, body: UpdateChapterOutlineRequest, request: Request
) -> dict[str, object]:
    outline = await _store(request).write_chapter_outline(
        work_id,
        chapter_id,
        foreshadow=_to_foreshadow(body.foreshadow),
        body=body.body,
        if_match=body.ifMatch,
    )
    return {"outline": outline}


# ---- 伏笔聚合 ----


@router.get("/works/{work_id}/foreshadows")
async def foreshadows(work_id: str, request: Request) -> dict[str, object]:
    return await _store(request).foreshadows(work_id)
