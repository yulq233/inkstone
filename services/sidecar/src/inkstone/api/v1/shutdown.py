"""POST /api/v1/shutdown —— 优雅退出。

为什么走 HTTP 而不是发信号（03 文档 §2.5）：

Windows 上对非 GUI 子进程发信号不可靠，而 ``taskkill /F`` 是硬杀、
不给 Python 任何清理机会（SQLite 索引、临时文件）。所以主进程的退出
顺序是：先 POST 到这里 → 等最多 3s → 还没退出才强杀。

**先回响应再退出**：用 BackgroundTasks，保证 200 已经发出去之后
才把 ``uvicorn.Server.should_exit`` 置位。
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, BackgroundTasks, Request

router = APIRouter()

logger = logging.getLogger("inkstone.shutdown")


def _request_exit(request: Request) -> None:
    server = getattr(request.app.state, "server", None)
    if server is None:
        logger.warning("收到退出请求，但 server 引用缺失，只能依赖主进程强杀")
        return
    logger.info("收到主进程退出请求，开始优雅关闭")
    server.should_exit = True


@router.post("/shutdown")
async def shutdown(request: Request, background: BackgroundTasks) -> dict[str, bool]:
    background.add_task(_request_exit, request)
    return {"ok": True}
