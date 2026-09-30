"""章节正文端点（03 文档 §7.2）。

正文读写全走这里，**不经过 IPC**。少一层转发，DevTools 里能直接看到请求与响应；
M3 的流式生成也要用 SSE，直连是天然形态。
"""

from __future__ import annotations

from typing import cast

from fastapi import APIRouter, Request

from ...storage.repo import WorkRegistry
from .schemas import UpdateChapterRequest

router = APIRouter()


def _registry(request: Request) -> WorkRegistry:
    # 与 works.py 的 _registry 同理：``app.state`` 是 Any，cast 是声明式的收敛。
    return cast(WorkRegistry, request.app.state.registry)


@router.get("/works/{work_id}/chapters/{chapter_id}")
async def read_chapter(work_id: str, chapter_id: str, request: Request) -> dict[str, object]:
    chapter = await _registry(request).read_chapter(work_id, chapter_id)
    return {"chapter": chapter}


@router.put("/works/{work_id}/chapters/{chapter_id}")
async def write_chapter(
    work_id: str, chapter_id: str, body: UpdateChapterRequest, request: Request
) -> dict[str, object]:
    """写正文。

    带 ``baseHash`` 做乐观并发：不一致就 409 并把磁盘版本一起带回去，
    让用户看着两份内容决定 —— 绝不静默覆盖。

    ``backup=true`` 表示用户已选择"保留我的并覆盖"，服务端会先把磁盘版本
    备份到 ``.inkstone/backups/`` 再写，返回的 ``backupPath`` 指向那份备份。
    """
    return await _registry(request).write_chapter(
        work_id, chapter_id, markdown=body.markdown, base_hash=body.baseHash, backup=body.backup
    )
