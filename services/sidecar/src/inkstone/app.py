"""FastAPI 应用装配。

中间件叠放顺序有讲究：Starlette 里**最后 add 的在最外层**。
所以先挂鉴权、再挂 CORS —— 这样浏览器的 OPTIONS 预检会被 CORS
中间件直接短路掉，不会因为"预检请求没带 token"而被 401。
（预检请求按规范就不能带自定义头，401 它会让整个请求失败。）
"""

from __future__ import annotations

import logging
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, status
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .api.v1 import chapters, health, shutdown, works
from .config import Settings
from .errors import DomainError
from .security import auth_middleware, new_trace_id
from .storage.repo import WorkRegistry

logger = logging.getLogger("inkstone.app")

API_PREFIX = "/api/v1"

# 开发态用 electron-vite 的渲染进程 dev server；
# 生产态渲染进程是 file://，浏览器发的 Origin 字面量是 "null"。
# （M4 会换成自定义协议 app:// 以便收紧 CORS 与 CSP，见 03 文档 §3.3）
ALLOWED_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "null",
]


def _error_body(code: str, message: str, *, detail: object = None, trace_id: str | None) -> dict:
    body: dict = {"error": {"code": code, "message": message}}
    if detail is not None:
        body["error"]["detail"] = detail
    if trace_id:
        body["error"]["traceId"] = trace_id
    return body


@asynccontextmanager
async def _lifespan(app: FastAPI) -> AsyncIterator[None]:
    logger.info("sidecar 启动完成，开始接收请求")
    try:
        yield
    finally:
        logger.info("sidecar 已停止接收请求，进程即将退出")


def create_app(settings: Settings) -> FastAPI:
    app = FastAPI(
        title="砚台本地服务",
        version=settings.version,
        docs_url=None,  # 本地服务不暴露 Swagger，减少面
        redoc_url=None,
        openapi_url=None,
        lifespan=_lifespan,
    )

    app.state.settings = settings
    app.state.started_at = time.monotonic()
    # uvicorn.Server 实例在 __main__ 里回填，退出端点据此触发优雅关闭。
    app.state.server = None
    # 作品仓储：进程内单例，持有章节清单缓存与各章节的写入锁。
    app.state.registry = WorkRegistry(settings)

    # ---- 中间件（顺序见模块 docstring）----
    app.middleware("http")(auth_middleware)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=ALLOWED_ORIGINS,
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # ---- 统一错误信封 ----
    @app.exception_handler(DomainError)
    async def _on_domain_error(request: Request, exc: DomainError) -> JSONResponse:
        """业务异常的**唯一**出口。

        路由层只表达"发生了什么"，错误码到 HTTP 状态码的映射只在 errors.py 里定义一处。
        """
        trace_id = getattr(request.state, "trace_id", None)
        # 4xx 是用户可预期的分支（比如外部改动），用 info；5xx 才是真出事了，用 error。
        log = logger.info if exc.status_code < 500 else logger.error
        log(
            "业务异常",
            extra={"extra_fields": {"code": exc.code, "path": request.url.path}},
        )
        return JSONResponse(
            status_code=exc.status_code,
            content=_error_body(exc.code, exc.message, detail=exc.detail, trace_id=trace_id),
        )

    @app.exception_handler(RequestValidationError)
    async def _on_validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        trace_id = getattr(request.state, "trace_id", None)
        # 按 03 文档 §1.2 的错误码表，INVALID_PARAM 对应 **400**。
        # （FastAPI 默认会给 422，但那跟我们的契约表对不上，前端要判两个码。）
        return JSONResponse(
            status_code=status.HTTP_400_BAD_REQUEST,
            content=_error_body(
                "INVALID_PARAM",
                "请求参数不合法。",
                detail=jsonable_encoder(exc.errors()),
                trace_id=trace_id,
            ),
        )

    @app.exception_handler(Exception)
    async def _on_unhandled(request: Request, exc: Exception) -> JSONResponse:
        # trace_id 可能还没生成（未鉴权路径直接抛错），补一个以便对上日志。
        trace_id = getattr(request.state, "trace_id", None) or new_trace_id()
        logger.exception(
            "未捕获异常",
            extra={"extra_fields": {"traceId": trace_id, "path": request.url.path}},
        )
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content=_error_body("INTERNAL", "本地服务内部错误，详情见日志。", trace_id=trace_id),
        )

    # ---- 路由 ----
    app.include_router(health.router, prefix=API_PREFIX, tags=["health"])
    app.include_router(shutdown.router, prefix=API_PREFIX, tags=["lifecycle"])
    app.include_router(works.router, prefix=API_PREFIX, tags=["works"])
    app.include_router(chapters.router, prefix=API_PREFIX, tags=["chapters"])

    return app
