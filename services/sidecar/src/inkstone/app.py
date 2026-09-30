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
from typing import Any

import httpx
from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .ai.gateway import ModelGateway
from .ai.service import GenerationService
from .ai.state import AiState
from .ai.usage import UsageLedger
from .api.v1 import ai, chapters, codex, health, outline, shutdown, works
from .config import Settings
from .errors import DomainError
from .security import auth_middleware, new_trace_id
from .storage.codex_store import CodexStore
from .storage.outline_store import OutlineStore
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


def _error_body(
    code: str, message: str, *, detail: object = None, trace_id: str | None
) -> dict[str, Any]:
    body: dict[str, Any] = {"error": {"code": code, "message": message}}
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


def _validation_detail(exc: RequestValidationError) -> list[dict[str, object]]:
    """把 Pydantic 的报错列表压成"够定位字段"的最小集合。

    刻意**丢掉 `input` 与 `ctx`**：`input` 是调用方**原样提交的那个值**，而它可能是
    `/ai/config` 里的明文 API Key，也可能是 `PUT chapters` 里的**整章正文**。
    400 的响应体会被调用方记进自己的日志 —— 主进程的日志**没有按值擦除**
    （`scrub()` 只存在于 sidecar 侧）。所以"回显提交内容"等于把明文 Key 与整章正文
    复制进另一个日志文件，这两条都不可接受。

    `loc` + `msg` + `type` 已经够定位"哪个字段、为什么不行"，且都不含提交内容。
    """
    detail: list[dict[str, object]] = []
    for item in exc.errors():
        detail.append(
            {
                "loc": [str(part) for part in item.get("loc", ())],
                "msg": str(item.get("msg", "")),
                "type": str(item.get("type", "")),
            }
        )
    return detail


def create_app(
    settings: Settings, *, ai_transport: httpx.AsyncBaseTransport | None = None
) -> FastAPI:
    """装配应用。

    ``ai_transport`` 是**测试专用**的注入口（生产一路传 ``None``）：
    测试环境与 CI 都连不上真实模型服务，不注入就一条 AI 用例都跑不了。
    它挂在网关而不是 Settings 上 —— Settings 是"启动参数"，
    而传输层是运行期依赖，混在一起会让 `config.py` 长出一批只在测试里有意义的字段。
    """
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
    # Codex（设定条目）仓储：借 registry 解析作品路径，自带 per-work 写锁。
    app.state.codex = CodexStore(app.state.registry)
    # 大纲三层仓储：同款结构，文件集与 codex 不相交。
    app.state.outline = OutlineStore(app.state.registry)

    def _recent_roots() -> list[str]:
        """当日用量要扫的作品目录。

        过滤掉 `exists: false` 的条目（目录被移走/删掉）：不滤的话每次生成都会
        对一串已经不在的路径做 stat，纯浪费；而它们的统计贡献本来就是 0。

        这里用**同步**的 `recent_entries()`：本函数由 `UsageLedger.today()` 丢进
        线程池执行（`docs/13` M7），在线程里没法 `await` 路由层那个 `async recent()`。
        """
        return [
            str(entry["rootPath"])
            for entry in app.state.registry.recent_entries()
            if entry.get("exists") is True
        ]

    # AI 配置快照 + 网关。启动时是**空配置**：真源在主进程 settings.json，
    # 由主进程在握手完成后推一次（见 main/ai-config.ts）。所以这里不读任何文件。
    app.state.ai = AiState()
    app.state.gateway = ModelGateway(app.state.ai, transport=ai_transport)
    # 当日用量：跨作品聚合，数据来自各作品 `.inkstone/ai/runs.jsonl`。
    # 只扫**最近打开过**的作品（最多 20 个，见 usage.py 的模块说明），不递归扫磁盘。
    app.state.ai_ledger = UsageLedger(_recent_roots)
    # 生成编排：进程内单例，并发占位挂在它身上（同一章不能有两路生成）。
    app.state.ai_service = GenerationService(
        app.state.registry, app.state.ai, app.state.gateway, app.state.ai_ledger
    )

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
        # detail 走 _validation_detail()：绝不回显提交内容（见该函数说明）。
        return JSONResponse(
            status_code=status.HTTP_400_BAD_REQUEST,
            content=_error_body(
                "INVALID_PARAM",
                "请求参数不合法。",
                detail=_validation_detail(exc),
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
    app.include_router(codex.router, prefix=API_PREFIX, tags=["codex"])
    app.include_router(outline.router, prefix=API_PREFIX, tags=["outline"])
    # AI 路由与作品路由共用同一条鉴权中间件，**没有豁免**：`/ai/config` 带明文 Key。
    app.include_router(ai.router, prefix=API_PREFIX, tags=["ai"])

    return app
