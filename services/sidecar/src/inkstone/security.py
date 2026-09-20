"""令牌鉴权中间件。

设计要点（03 文档 §3.2）：

- 用 ``secrets.compare_digest`` 做常量时间比较，避免时序侧信道。
- "缺失"与"错误"返回**同一个**响应体，不区分 —— 不给探测者额外信息。
- ``/api/v1/healthz`` 免鉴权：主进程需要在拿到连接后立刻探活，
  且它只返回 ``{ok, version, uptimeMs}``，不泄露任何作品数据。
"""

from __future__ import annotations

import secrets
from collections.abc import Awaitable, Callable

from fastapi import Request, Response, status
from fastapi.responses import JSONResponse

TOKEN_HEADER = "x-inkstone-token"

# 免鉴权路径。只放探活，不放其他。
EXEMPT_PATHS: frozenset[str] = frozenset({"/api/v1/healthz"})

_UNAUTHORIZED_BODY = {
    "error": {
        "code": "UNAUTHORIZED",
        "message": "本地服务令牌校验失败。请重启砚台；若持续出现，请附上日志反馈。",
    }
}


def new_trace_id() -> str:
    """每个已鉴权请求一个 traceId，便于把 UI 上的报错对到日志行。"""
    return secrets.token_hex(16)


async def auth_middleware(
    request: Request,
    call_next: Callable[[Request], Awaitable[Response]],
) -> Response:
    if request.url.path in EXEMPT_PATHS:
        request.state.trace_id = new_trace_id()
        return await call_next(request)

    provided = request.headers.get(TOKEN_HEADER, "")
    # compare_digest 只接受 ASCII str；非 ASCII 会抛 TypeError，所以统一按字节比。
    authorized = bool(provided) and secrets.compare_digest(
        provided.encode("utf-8"), request.app.state.settings.token.encode("utf-8")
    )
    if not authorized:
        return JSONResponse(status_code=status.HTTP_401_UNAUTHORIZED, content=_UNAUTHORIZED_BODY)

    request.state.trace_id = new_trace_id()
    return await call_next(request)
