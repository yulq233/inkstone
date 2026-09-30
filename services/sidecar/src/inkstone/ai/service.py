"""一次生成的编排（``docs/11`` §3.1 的 sidecar 那一段）。

## 为什么编排单独一个模块，不塞进路由

路由要薄（`api/v1/ai.py` 的文件头有理由）。生成这件事有六步 ——
选模型 → 预算 → 并发 → 装配 → 上游流式 → 落记录 —— 而其中**四步会在
不同时机失败**，失败时机决定了它该变成 HTTP 错误还是 SSE 里的 error 事件：

- **建响应之前**（未配置模型、超预算、同章已有一路生成）→ 正常的 HTTP 4xx，
  渲染进程按状态码走它既有的分支；
- **建响应之后**（上游 401/429/5xx、首 chunk 超时、用户停止）→ SSE 的
  `error` 事件或 `done:aborted`。

所以 `prepare()` 与 `events()` 必须分开：前者在 `StreamingResponse` 之前跑完，
后者才是响应体。

> ⚠️ **给渲染进程的提醒**（写在 Python 侧是因为这里才是契约的源头）：
> SSE 的每一帧都是 UTF-8 字节流，而一个汉字占 3 字节、可能被切在两个网络分片之间。
> 客户端必须用 `TextDecoder` 的 `{stream: true}` 模式解码，不能对每个分片单独 `decode()`
> —— 那样偶尔会出现半个汉字（表现为乱码），而且只在流式时长句子上复现。

## `runs.jsonl` 记的是"外发"，不是"成功"

上游 401 的那次请求**确实把 prompt 发出去了**，只是被拒了。所以它必须有记录
（`egressChars` 不为 0），否则审计会出现一个"发出去但没记"的缺口。
反过来，`prepare()` 阶段失败的那几类（没配模型、超预算、同章并发）一个字节都没出网，
**不记**才是对的。
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass

from ..domain.clock import now_iso
from ..domain.ids import new_run_id
from ..errors import AiBudgetExceeded, AiBusy, DomainError
from ..storage.repo import WorkRegistry
from .context import Assembler, AssembleRequest, ContextBundle
from .gateway import ChatRequest, ModelGateway, StreamDelta, StreamDone, StreamUsage
from .pricing import estimate_cost
from .runs import AiRunRecord, RunStore
from .state import AiState, ProviderConfig
from .tokens import estimate_tokens
from .usage import UsageLedger
from .workspace import RegistryWorkspace

logger = logging.getLogger("inkstone.ai.service")

#: 没指定时的输出上限。一次续写是"一到三段"，1024 足够，也避免模型长篇大论。
DEFAULT_MAX_TOKENS = 1024


@dataclass(frozen=True, slots=True)
class GenerationRequest:
    """生成请求的**内部**形态。

    刻意不直接用 `api/v1/schemas.py` 的 pydantic 模型：`ai/` 这一层
    不该依赖 HTTP 层，否则"装配与编排"就没法脱开 FastAPI 单独测。
    """

    task: str
    work_id: str
    chapter_id: str
    prefix: str
    suffix: str = ""
    intent: str = ""
    #: `None` = 用主进程推来的全局风格卡；空串 = 明确不要风格卡。
    style_card: str | None = None
    temperature: float | None = None
    max_tokens: int | None = None
    force: bool = False
    kind: str = ""


@dataclass(slots=True)
class PreparedGeneration:
    """已经过了所有"提前失败"检查的一次生成。`events()` 拿它跑流。"""

    run_id: str
    task: str
    work_id: str
    #: 并发占位键（`<workId>:<chapterId>`）。**无论成功失败都要释放**。
    busy_key: str
    provider: ProviderConfig
    model: str
    bundle: ContextBundle
    temperature: float
    max_tokens: int
    target_ref: str
    store: RunStore
    trace_id: str = ""


@dataclass(frozen=True, slots=True)
class PreviewOutcome:
    """一次「将发送什么」的结论（`docs/11` §6.4 / §6.7）。

    刻意**不复用** `PreparedGeneration`：那个类型带着 `run_id` / `busy_key` / `store`
    —— 它们是"这次真的要发出去"的凭据。预览没有 run_id（不落记录）、不占并发位、
    也不该有 `store`（不该写下任何东西）。让一个类型同时表示这两件事，
    第一个 bug 就会是"预览泄漏进来的 run_id 被当成真的一次生成"。
    """

    provider: ProviderConfig
    model: str
    bundle: ContextBundle
    #: 要不要弹「将发送什么」确认卡（= 非本机 且 未确认 且 未被纯本地模式拦下）
    needs_confirm: bool
    #: 这条路由会被纯本地模式拦下 —— 界面据此**不弹卡**、直接放行，
    #: 让真正的生成去报 `AI_OFFLINE_ONLY`（理由见 `AiState.egress_confirm_needed`）。
    offline_blocked: bool


class GenerationService:
    """进程内单例（并发占位挂在实例上）。"""

    def __init__(
        self,
        registry: WorkRegistry,
        state: AiState,
        gateway: ModelGateway,
        ledger: UsageLedger,
    ) -> None:
        self._registry = registry
        self._state = state
        self._gateway = gateway
        self._ledger = ledger
        self._assembler = Assembler(RegistryWorkspace(registry))
        # 用**集合**而不是 `asyncio.Lock`：这里要的是"同一章不能有两路生成"，
        # 而不是"串行执行"。集合的判重与加入之间没有 await，所以在事件循环里是原子的；
        # 换成 Lock 反而要处理"非阻塞获取"（`wait_for(acquire(), 0)` 是个坑）。
        self._busy: set[str] = set()

    # ------------------------------------------------------------------
    # 建响应之前
    # ------------------------------------------------------------------

    async def prepare(self, req: GenerationRequest, *, trace_id: str = "") -> PreparedGeneration:
        busy_key = f"{req.work_id}:{req.chapter_id}"
        if busy_key in self._busy:
            raise AiBusy()
        self._busy.add(busy_key)
        try:
            return await self._prepare(req, busy_key, trace_id)
        except BaseException:
            # `BaseException` 而不是 `Exception`：取消也要释放占位，
            # 否则一次被取消的生成会把这一章**永久**锁死。
            self._busy.discard(busy_key)
            raise

    async def _prepare(
        self, req: GenerationRequest, busy_key: str, trace_id: str
    ) -> PreparedGeneration:
        # 顺序有讲究：先查"能不能发"（免费、立刻），再花力气装配上下文。
        # 反过来会让一个超预算的请求先白读一遍磁盘。
        route = self._state.resolve_route(req.task)
        provider = self._state.provider(route.provider_id)
        await self._guard_budget(req.force)

        bundle = await self._assemble(req)
        return PreparedGeneration(
            run_id=new_run_id(),
            task=req.task,
            work_id=req.work_id,
            busy_key=busy_key,
            provider=provider,
            model=route.model,
            bundle=bundle,
            temperature=bundle.temperature if req.temperature is None else req.temperature,
            max_tokens=DEFAULT_MAX_TOKENS if req.max_tokens is None else req.max_tokens,
            target_ref=f"chapter:{req.chapter_id}",
            store=RunStore(self._registry.work_paths(req.work_id)),
            trace_id=trace_id,
        )

    async def _assemble(self, req: GenerationRequest) -> ContextBundle:
        """把请求装配成一份 `ContextBundle`。

        **抽出来只有一个目的**：预览与真正的生成必须走**同一份装配**。
        各写一遍的后果不是"差几个 token"，而是预览里显示的内容与实际发出去的
        不是同一份 —— 而用户正是据此决定要不要让它出门。
        `style_card` 的回落（`None` = 用全局风格卡 / 空串 = 明确不要）尤其容易漏。
        """
        return await self._assembler.assemble(
            AssembleRequest(
                task=req.task,
                work_id=req.work_id,
                chapter_id=req.chapter_id,
                prefix=req.prefix,
                suffix=req.suffix,
                intent=req.intent,
                style_card=(
                    self._state.style_card if req.style_card is None else req.style_card
                ),
                kind=req.kind,
            )
        )

    # ------------------------------------------------------------------
    # 预览（**不发出任何请求**）
    # ------------------------------------------------------------------

    async def preview(self, req: GenerationRequest) -> PreviewOutcome:
        """算出"这一次会发什么"，但**一个字节都不发**。

        ## 三件刻意不做的事

        - **不占并发位**（`_busy`）：预览是只读的，与"同一章不能有两路生成"无关。
          占位反而会让"边写边看"变成互相干扰。
        - **不查预算**（`_guard_budget`）：预算的处置是"告警 + 确认"，
          而预览本身就是那个确认动作的前置 —— 在这里抛 `AiBudgetExceeded`
          会让用户在"看一眼要发什么"这一步就被挡住。真正的那次生成照样会拦。
        - **不落 `runs.jsonl`**：`runs.jsonl` 记的是**外发**（模块头有理由），
          预览没有外发。

        ## 失败照常抛

        `resolve_route` 的 `AiNotConfigured`、装配器的 `AiContextTooLong` 都会照原样
        抛出去，由统一处理器翻译。**刻意不为预览另造一套文案** ——
        用户在预览里看到的那句话，与点下生成之后会看到的是同一句。
        """
        route = self._state.resolve_route(req.task)
        provider = self._state.provider(route.provider_id)
        bundle = await self._assemble(req)
        return PreviewOutcome(
            provider=provider,
            model=route.model,
            bundle=bundle,
            needs_confirm=self._state.egress_confirm_needed(provider),
            offline_blocked=self._state.offline_blocks(provider),
        )

    async def _guard_budget(self, force: bool) -> None:
        """生成**之前**拦一次（`docs/11` §8.3）。

        `force` 存在的理由见 `ai-types.ts` 的 `AiGenRequest.force`：
        超预算要能"告警 + 确认"，所以确认之后重发的那一次必须过得去。
        """
        limit = self._state.daily_budget_cny
        if force or limit <= 0:
            return
        usage = await self._ledger.today()
        if usage.spent_cny >= limit:
            raise AiBudgetExceeded(usage.spent_cny, limit)
        if usage.unpriced_runs > 0:
            # 认不出模型的那些记录成本按 0 计，所以判断是偏松的**向上**偏。
            # 不把这件事说出来，用户会以为"预算还早着呢"，而这个偏差没有上限。
            logger.warning(
                "当日用量里有无法估价的记录，预算判断可能偏低",
                extra={
                    "extra_fields": {
                        "unpricedRuns": usage.unpriced_runs,
                        "spentCny": usage.spent_cny,
                        "limitCny": limit,
                    }
                },
            )

    # ------------------------------------------------------------------
    # 响应体
    # ------------------------------------------------------------------

    async def events(self, gen: PreparedGeneration) -> AsyncIterator[bytes]:
        """产出 SSE 帧。**这是响应体**，所以从这里开始的失败只能是 SSE 事件。"""
        started = time.perf_counter()
        first_token_ms = 0
        parts: list[str] = []
        finish = "stop"
        usage: StreamUsage | None = None
        completed = False
        error_code: str | None = None

        try:
            yield _sse(
                {
                    "type": "meta",
                    "runId": gen.run_id,
                    "providerId": gen.provider.id,
                    "model": gen.model,
                    "templateId": gen.bundle.template_id,
                    "templateVersion": gen.bundle.template_version,
                    "dropped": [
                        {
                            "source": drop.source,
                            "title": drop.title,
                            "tokens": drop.tokens,
                            "reason": drop.reason,
                        }
                        for drop in gen.bundle.dropped
                    ],
                    "budget": {
                        "budget": gen.bundle.budget.budget,
                        "used": gen.bundle.budget.used,
                        "remaining": gen.bundle.budget.remaining,
                    },
                    "egressChars": egress_chars(gen.bundle),
                }
            )

            chat = ChatRequest(
                model=gen.model,
                system=gen.bundle.system,
                user=gen.bundle.user,
                temperature=gen.temperature,
                max_tokens=gen.max_tokens,
            )
            async for chunk in self._gateway.stream(gen.provider, chat):
                if isinstance(chunk, StreamDelta):
                    if first_token_ms == 0:
                        first_token_ms = _ms(started)
                    parts.append(chunk.text)
                    yield _sse({"type": "delta", "text": chunk.text})
                elif isinstance(chunk, StreamUsage):
                    usage = chunk
                elif isinstance(chunk, StreamDone):
                    finish = chunk.finish_reason

            completed = True
            prompt_tokens, completion_tokens = _tokens(gen.bundle, usage, "".join(parts))
            cost = estimate_cost(
                gen.provider,
                gen.model,
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
            )
            yield _sse(
                {
                    "type": "usage",
                    "promptTokens": prompt_tokens,
                    "completionTokens": completion_tokens,
                    "costCny": cost,
                }
            )
            yield _sse({"type": "done", "finishReason": finish})
        except asyncio.CancelledError:
            # 用户点了停止（或连接断了）。**不是错误**，界面上不报警；
            # 但一定要落记录 —— "我按了停止，到底发出去多少字"正是审计要回答的。
            finish = "aborted"
            raise
        except DomainError as exc:
            error_code = exc.code
            logger.info(
                "生成失败",
                extra={
                    "extra_fields": {
                        "task": gen.task,
                        "providerId": gen.provider.id,
                        "code": exc.code,
                    }
                },
            )
            yield _sse(
                {
                    "type": "error",
                    "code": exc.code,
                    "message": exc.message,
                    **({"traceId": gen.trace_id} if gen.trace_id else {}),
                }
            )
        except Exception:
            # 兜底（`docs/13` M4）。**必须自己发一帧 error**，不能让异常逃出去：
            # 这里是响应体，异常逃逸的表现是"SSE 流突然断掉"—— 渲染进程既收不到
            # `done` 也收不到 `error`，只能报一句"协议错误"，与真正的原因毫无关联。
            #
            # 更糟的是**记录**：原先只有 `DomainError` 分支会设 `error_code`，
            # 于是这类失败在 `runs.jsonl` 里是 `error: null` —— 看起来是成功的一次生成，
            # 而用户一个字都没拿到。审计记录里出现这种偏差是最不能接受的。
            #
            # `CancelledError` 不会被这里接住（它是 `BaseException`），走的是上面那条分支。
            error_code = "INTERNAL"
            logger.exception(
                "生成过程出现未预期的异常",
                extra={"extra_fields": {"task": gen.task, "runId": gen.run_id}},
            )
            yield _sse(
                {
                    "type": "error",
                    "code": error_code,
                    "message": (
                        "生成过程中出现了未预期的错误。请重试；"
                        "若反复出现，请把日志一并反馈。"
                    ),
                    **({"traceId": gen.trace_id} if gen.trace_id else {}),
                }
            )
        finally:
            self._busy.discard(gen.busy_key)
            try:
                await self._record(
                    gen,
                    started=started,
                    parts="".join(parts),
                    first_token_ms=first_token_ms,
                    usage=usage,
                    completed=completed,
                    error_code=error_code,
                    finish=finish,
                )
            except Exception:
                # ⚠️ 这里**不能**让异常逃出去（`docs/13` M4）：`finally` 里抛出的异常会
                # **替换**正在传播的那一个，而此刻在传播的可能是 `CancelledError`
                # （用户点了停止）—— 被替换成 `WriteFailed` 之后，上层再也分不清
                # "用户取消"与"写盘失败"，取消链路直接断掉。
                #
                # 但也不能静默吞掉：写日志时带上 runId，用户反馈时能据此定位。
                logger.exception(
                    "生成记录写入失败",
                    extra={
                        "extra_fields": {
                            "runId": gen.run_id,
                            "task": gen.task,
                            "finished": completed,
                        }
                    },
                )

    # ------------------------------------------------------------------
    # 落记录
    # ------------------------------------------------------------------

    async def _record(
        self,
        gen: PreparedGeneration,
        *,
        started: float,
        parts: str,
        first_token_ms: int,
        usage: StreamUsage | None,
        completed: bool,
        error_code: str | None,
        finish: str,
    ) -> None:
        prompt_tokens, completion_tokens = _tokens(gen.bundle, usage, parts)
        record = AiRunRecord(
            id=gen.run_id,
            work_id=gen.work_id,
            at=now_iso(),
            task_type=gen.task,
            target_ref=gen.target_ref,
            provider_id=gen.provider.id,
            model=gen.model,
            prompt_digest=prompt_digest(gen.bundle),
            context_tokens=prompt_tokens,
            output_tokens=completion_tokens,
            egress_chars=egress_chars(gen.bundle),
            latency_ms=_ms(started),
            first_token_ms=first_token_ms,
            stopped=not completed,
            cost_cny=estimate_cost(
                gen.provider,
                gen.model,
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
            ),
            error=error_code,
        )
        # `RunStore.append` 内部用 `asyncio.shield`：取消正在往上抛时，
        # 这次 await 会立刻抛 CancelledError，但写盘会继续跑完（见 runs.py 的说明）。
        await gen.store.append(record)
        logger.info(
            "生成结束",
            extra={
                "extra_fields": {
                    "runId": gen.run_id,
                    "task": gen.task,
                    "model": gen.model,
                    "stopped": record.stopped,
                    "finishReason": finish,
                    "outputTokens": completion_tokens,
                    "egressChars": record.egress_chars,
                    "latencyMs": record.latency_ms,
                }
            },
        )


# ---------------------------------------------------------------------------
# 工具
# ---------------------------------------------------------------------------


def egress_chars(bundle: ContextBundle) -> int:
    """本次**发出去**的字符数。

    口径是 system + user 的字符数：这两段是真正离开本机的内容。
    模型返回的东西是**入站**，不计入外发审计（`docs/01` §9.3 要求的是
    "告诉用户有什么离开了这台机器"）。
    """
    return len(bundle.system) + len(bundle.user)


def prompt_digest(bundle: ContextBundle) -> str:
    """提示的摘要。**只存摘要不存正文**（`docs/11` §3.6 的 D5）。

    用途是"同一段文字、换了模板/模型"的回归对比与去重，不是复现 ——
    想复现 prompt 的话要用户手动导出诊断包，那时完整内容才落盘。
    """
    digest = hashlib.sha256(f"{bundle.system}\n{bundle.user}".encode())
    return f"sha256:{digest.hexdigest()}"


def _tokens(
    bundle: ContextBundle, usage: StreamUsage | None, output: str
) -> tuple[int, int]:
    """（上下文 token, 输出 token）。**优先用上游报的真实值**。

    上游不报时退回 `estimate_tokens` —— 它是偏高的估算（`tokens.py` 有口径说明），
    而"估高"在这里是安全方向：用量统计宁可显示多一点。

    `context_tokens` 不用 `bundle.budget.used`：那个值是"装配时的预算口径"，
    与"上游实际计费口径"不是一回事，混用会让账单对不上。
    """
    system_tokens = estimate_tokens(bundle.system)
    user_tokens = estimate_tokens(bundle.user)
    prompt = usage.prompt_tokens if usage and usage.prompt_tokens is not None else None
    completion = usage.completion_tokens if usage and usage.completion_tokens is not None else None
    return (
        system_tokens + user_tokens if prompt is None else prompt,
        estimate_tokens(output) if completion is None else completion,
    )


def _ms(started: float) -> int:
    return int((time.perf_counter() - started) * 1000)


def _sse(payload: Mapping[str, object]) -> bytes:
    """一帧 SSE。

    `ensure_ascii=False`：中文按原样出去，抓包/看日志时能直接读懂 ——
    这是排查"模型看到了什么"时最常用的现场。SSE 规范本来就要求 UTF-8。
    """
    return f"data: {json.dumps(payload, ensure_ascii=False, separators=(',', ':'))}\n\n".encode()
