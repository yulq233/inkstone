"""AI 配置与连通性端点（`docs/11` §4.2 的 P0 四项）。

## 这一层刻意很薄

路由里只有"取状态 → 调网关 → 组响应"，没有任何 try/except：所有失败
（Key 无效、连不上、被纯本地模式拦下）都由 `errors.py` 的 `DomainError` 子类
表达，再由 `app.py` 的统一错误处理器翻译成信封。想在路由里补一层
"如果失败就返回 xxx"的诱惑要忍住 —— 那会让同一件事的文案在两处漂移。

## 鉴权

四个端点全部走和作品接口同一条中间件（`security.py` 的 `auth_middleware`），
**没有例外**。`/ai/config` 里带明文 Key，尤其不能开豁免口子。

## 为什么 `/ai/providers/{id}/models` 与 `/ai/test` 是服务端发起请求

它们是用户的"测试连接"按钮，发起的地址来自服务端内存里的配置快照。
不让渲染进程自己 `fetch`：那样 Key 就得下发到渲染进程，而渲染进程是
页面代码运行的地方（`docs/01` §9.3 的要求是 Key 只在主进程与 sidecar 之间流转）。
"""

from __future__ import annotations

import logging
from typing import cast

from fastapi import APIRouter, Query, Request
from fastapi.responses import StreamingResponse

from ...ai.gateway import ModelGateway
from ...ai.runs import DEFAULT_LIMIT, RunFeedback, RunStore
from ...ai.service import GenerationRequest, GenerationService, egress_chars
from ...ai.state import AiState, ProviderConfig, RouteTarget
from ...ai.usage import UsageLedger
from ...storage.repo import WorkRegistry
from .schemas import (
    AiConfigRequestIn,
    AiGenRequestIn,
    AiPreviewRequestIn,
    AiQuickRequestIn,
    AiRunFeedbackIn,
    AiTestRequestIn,
)

logger = logging.getLogger("inkstone.ai")

router = APIRouter()

#: SSE 的那几个头。
#:
#: - `no-transform`：有些代理会为了"优化"压缩或缓冲流，那会让流式退化成一次性返回；
#: - `X-Accel-Buffering: no`：nginx 的开关，同理。
#:
#: 本地回环上这些大多用不着，但用户完全可能挂一个本地反代来抓包 —— 写上是零成本的保险。
_SSE_HEADERS = {
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}


def _state(request: Request) -> AiState:
    # app.state 在类型上就是 Any；显式 cast 是为了满足 --strict 的 warn_return_any，
    # 值确实由 app.py 放进去（与 works.py 的 _registry 同一写法）。
    return cast(AiState, request.app.state.ai)


def _gateway(request: Request) -> ModelGateway:
    return cast(ModelGateway, request.app.state.gateway)


def _registry(request: Request) -> WorkRegistry:
    return cast(WorkRegistry, request.app.state.registry)


def _service(request: Request) -> GenerationService:
    return cast(GenerationService, request.app.state.ai_service)


def _ledger(request: Request) -> UsageLedger:
    return cast(UsageLedger, request.app.state.ai_ledger)


@router.get("/ai/providers")
async def list_providers(request: Request) -> dict[str, object]:
    """回当前生效的供应商配置。**不含凭据信息**（`ai-types.ts` 文件头有理由）。

    渲染进程不靠它画"已配置密钥"的徽标 —— 那个真源在主进程，走 IPC。
    """
    return {"items": _state(request).provider_list()}


@router.put("/ai/config")
async def put_config(body: AiConfigRequestIn, request: Request) -> dict[str, object]:
    """主进程推全量配置。**整体替换**，不是增量合并（`ai/state.py` 有理由）。

    只回条目数，不回配置原文：响应体会进日志，而 `credentials` 是明文 Key。
    虽然 `logging.scrub()` 会按值擦除，但"根本不回显"比"回显了再擦"少一层依赖。
    """
    state = _state(request)
    # 先记下旧值：`apply()` 之后就只剩新值了，而"由开转关"这个**方向**才是要留痕的东西。
    was_offline_only = state.offline_only
    counts = state.apply(
        providers=[
            ProviderConfig(
                id=item.id,
                kind=item.kind,
                label=item.label,
                base_url=item.baseUrl,
                local=item.local,
                needs_key=item.needsKey,
            )
            for item in body.providers
        ],
        credentials=body.credentials,
        offline_only=body.offlineOnly,
        routing={
            task: (
                None
                if target is None
                else RouteTarget(provider_id=target.providerId, model=target.model)
            )
            for task, target in body.routing.items()
        },
        default_provider_id=body.defaultProviderId,
        default_model=body.defaultModel,
        style_card=body.styleCard,
        daily_budget_cny=body.dailyBudgetCny,
        acknowledged_egress_providers=body.acknowledgedEgressProviders,
    )
    # revision 只进日志不进契约：排查"推送到底有没有到"时，有它就不用靠猜。
    # 风格卡只记长度不记原文：它是用户自己的设定文本，日志里没必要有第二份副本。
    if was_offline_only and not state.offline_only:
        # **由开转关**是一次方向性变化（从"内容只在本机"变成"可以出门"），
        # 值得单独一条 warning，而不是被淹在下面那条 info 里。
        #
        # 这条日志是 `docs/13` M9 残留风险的**唯一事后痕迹**：token 在设计上就下发给
        # 渲染进程（渲染进程直连 sidecar，`docs/11` §4.2），所以一个被 XSS 的渲染进程
        # 能推一份 `offlineOnly=false` 的配置。sidecar 无法区分"用户关的"与"被推着关的"，
        # 能做的是**不静默** —— 让它至少在 `logs/sidecar.log` 里留下一条 warning。
        logger.warning(
            "纯本地模式已被关闭：此后生成可能把正文发往云端供应商",
            extra={"extra_fields": {"revision": state.revision}},
        )
    logger.info(
        "AI 配置已更新",
        extra={
            "extra_fields": {
                "revision": state.revision,
                "providers": counts.providers,
                "credentials": counts.credentials,
                "offlineOnly": state.offline_only,
                "defaultModel": state.default_model,
                "styleCardChars": len(state.style_card),
                "dailyBudgetCny": state.daily_budget_cny,
            }
        },
    )
    return {"applied": {"providers": counts.providers, "credentials": counts.credentials}}


@router.get("/ai/providers/{provider_id}/models")
async def list_models(provider_id: str, request: Request) -> dict[str, object]:
    """列出可选模型。拉不到（网络、Key、地址错）会抛 DomainError，由统一处理器翻译。"""
    provider = _state(request).provider(provider_id)
    specs = await _gateway(request).list_models(provider)
    return {"items": [{"id": spec.id, "label": spec.label} for spec in specs]}


@router.post("/ai/test")
async def test_connection(body: AiTestRequestIn, request: Request) -> dict[str, object]:
    """真发一次最小对话请求。

    **不做"先判断再发"**：判断与请求之间隔着一次网络往返，中间状态会变
    （用户可能正好在这一刻改了设置）。让它真发、真失败、真报错，
    用户看到的就是下次生成时会遇到的同一件事。
    """
    provider = _state(request).provider(body.providerId)
    result = await _gateway(request).test(provider, body.model)
    logger.info(
        "AI 连接测试成功",
        extra={
            "extra_fields": {
                "providerId": provider.id,
                "model": result.model,
                "latencyMs": result.latency_ms,
            }
        },
    )
    return {
        "ok": True,
        "latencyMs": result.latency_ms,
        "model": result.model,
        "echo": result.echo,
    }


# ---------------------------------------------------------------------------
# 生成（P1）
# ---------------------------------------------------------------------------


def _generation_request(body: AiGenRequestIn, *, task: str, kind: str = "") -> GenerationRequest:
    return GenerationRequest(
        task=task,
        work_id=body.workId,
        chapter_id=body.chapterId,
        prefix=body.prefix,
        suffix=body.suffix,
        intent=body.intent,
        style_card=body.styleCard,
        temperature=body.temperature,
        max_tokens=body.maxTokens,
        force=body.force,
        kind=kind,
    )


async def _sse_response(request: Request, gen: GenerationRequest) -> StreamingResponse:
    """先跑完 `prepare()`（失败 → 正常的 HTTP 错误），再交出响应体。

    这个顺序是刻意的，理由写在 `ai/service.py` 的模块头：**失败发生的时机
    决定了它该长什么样**。让 `prepare()` 在 `StreamingResponse` 构造之前跑完，
    "没配模型""超预算""同章已在生成"这三类就能是 400/429/409 ——
    渲染进程按状态码走它既有的分支即可，不必在 SSE 里再认一遍。
    """
    prepared = await _service(request).prepare(
        gen, trace_id=getattr(request.state, "trace_id", "")
    )
    return StreamingResponse(
        _service(request).events(prepared),
        media_type="text/event-stream; charset=utf-8",
        headers=_SSE_HEADERS,
    )


@router.post("/ai/continue")
async def continue_writing(body: AiGenRequestIn, request: Request) -> StreamingResponse:
    """续写。光标**之后**若已有内容（`suffix`），要求接得上它但不改写它。"""
    return await _sse_response(request, _generation_request(body, task="continue"))


@router.post("/ai/quick")
async def quick_generate(body: AiQuickRequestIn, request: Request) -> StreamingResponse:
    """快捷生成（起名 / 对白 / 场景 / 钩子 / 走向 / 简介 / 标题）。

    与续写共用同一条装配与统计链路，只是模板与 `kind` 不同 ——
    拆成七个端点只会让"加一种快捷生成"变成改三处（`docs/11` §4.3）。
    """
    return await _sse_response(request, _generation_request(body, task="quick", kind=body.kind))


@router.post("/ai/preview")
async def preview_context(body: AiPreviewRequestIn, request: Request) -> dict[str, object]:
    """「**将发送什么**」（`docs/11` §6.4 / §6.7）—— 装配一遍，**一个字节都不发**。

    ## 为什么不是一个"回预览数据"的 SSE 帧

    生成流的 `meta` 帧确实带 `dropped` / `budget` / `egressChars`，但两件事挡住了它：
    它**不含正文**（展开看不了），而且它在**生成已经发起之后**才到 ——
    而这里要回答的是"要不要发"。时机上就不可能。

    ## 为什么不返回 204 / 空体

    响应体就是这一份**真实**的 system + user + 分块。用户要判断的是
    "我的哪一段文字要出门了"，只回一个 token 数答不了这个问题
    （理由在 `api-types.ts` 的 `AiPreviewResponse`）。

    ## 响应体不进日志

    它含正文。`logging.scrub()` 只按**密钥值**擦除，对正文无效 ——
    所以这里刻意**不**打一条把 body 带上的日志（`size` 级别的只有 `len`）。

    超时与错误：装配失败照常抛 `DomainError`（`AiNotConfigured` / `AiContextTooLong`），
    与点下生成时的文案逐字相同 —— 预览**不是**另一条错误来源。
    """
    outcome = await _service(request).preview(
        _generation_request(
            body,
            # 与 `/ai/quick` 的分流保持同一判据：带 `kind` 就是快捷生成。
            task="quick" if body.kind else "continue",
            kind=body.kind,
        )
    )
    bundle = outcome.bundle
    return {
        "providerId": outcome.provider.id,
        "providerLabel": outcome.provider.label,
        "providerBaseUrl": outcome.provider.base_url,
        "local": outcome.provider.local,
        "model": outcome.model,
        "templateId": bundle.template_id,
        "templateVersion": bundle.template_version,
        "needsConfirm": outcome.needs_confirm,
        "offlineBlocked": outcome.offline_blocked,
        "system": bundle.system,
        "user": bundle.user,
        "blocks": [
            {
                "slot": block.slot,
                "title": block.title,
                "source": block.source,
                "tokens": block.tokens,
                "truncated": block.truncated,
                "text": block.text,
            }
            for block in bundle.blocks
        ],
        "dropped": [
            {
                "source": drop.source,
                "title": drop.title,
                "tokens": drop.tokens,
                "reason": drop.reason,
            }
            for drop in bundle.dropped
        ],
        "budget": {
            "budget": bundle.budget.budget,
            "used": bundle.budget.used,
            "remaining": bundle.budget.remaining,
        },
        "egressChars": egress_chars(bundle),
    }


@router.get("/ai/runs")
async def list_runs(
    request: Request,
    workId: str,
    since: str = "",
    limit: int = Query(default=DEFAULT_LIMIT, ge=1, le=1_000),
) -> dict[str, object]:
    """当前作品的生成记录 + **全局**当日用量。

    两者一起回是因为界面上它们一起出现（外发记录面板 / 用量条），
    分两次请求会让面板先显示一半。工作量也不大：用量那边有缓存。
    """
    state = _state(request)
    store = RunStore(_registry(request).work_paths(workId))
    runs = await store.read(limit=limit, since=since)
    usage = await _ledger(request).today()
    limit_cny = state.daily_budget_cny

    return {
        "items": [record.to_json() for record in runs],
        "usage": {
            "date": usage.date,
            "spentCny": usage.spent_cny,
            "runs": usage.runs,
            "unpricedRuns": usage.unpriced_runs,
            "egressChars": usage.egress_chars,
            "limitCny": limit_cny,
            "exceeded": limit_cny > 0 and usage.spent_cny >= limit_cny,
        },
    }


@router.post("/ai/runs/{run_id}/feedback")
async def submit_feedback(
    run_id: str, body: AiRunFeedbackIn, request: Request
) -> dict[str, object]:
    """回填采纳结果。

    落在**另一个文件**（`feedback.jsonl`）而不是回写 `runs.jsonl` 的那一行：
    后者是只追加的外发审计流，覆盖式写入会让"某次记录被改过"变成可能
    （`docs/11` §3.6 与 `ai/runs.py` 的模块说明）。
    """
    store = RunStore(_registry(request).work_paths(body.workId))
    await store.append_feedback(
        RunFeedback(id=run_id, accepted=body.accepted, accepted_chars=body.acceptedChars)
    )
    return {"ok": True}
