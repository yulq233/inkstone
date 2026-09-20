"""GET /api/v1/healthz —— 探活端点。

- **免鉴权**：主进程要在挂载 token 前就能确认进程活着。
- **不计入日志**：探活每 5s 一次，写日志会把有用信息刷掉。
- 只返回 ``{ok, version, uptimeMs}``，不含任何作品数据。
"""

from __future__ import annotations

import time

from fastapi import APIRouter, Request

router = APIRouter()


@router.get("/healthz")
async def healthz(request: Request) -> dict[str, object]:
    started_at: float = request.app.state.started_at
    settings = request.app.state.settings
    return {
        "ok": True,
        "version": settings.version,
        "uptimeMs": int((time.monotonic() - started_at) * 1000),
    }
