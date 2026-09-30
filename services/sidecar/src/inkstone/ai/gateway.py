"""模型网关：把"发一次请求"这件事收敛到一处（`docs/11` §3.4）。

## 为什么 v1 不引入 LiteLLM

`docs/01` §4.2 选了 LiteLLM（覆盖更广）。这里**刻意先不引入**，判据写在下面，
免得以后有人凭印象推翻它：

- 国产主流（DeepSeek / 百炼 / Kimi / GLM / 硅基流动）与 Ollama **都提供 OpenAI 兼容端点**，
  一套 `chat/completions` 客户端就够；
- LiteLLM 的依赖树会明显抬高 PyInstaller 的产物体积与构建时间，而它的收益
  （Anthropic 原生、Bedrock、跨供应商 fallback）在 v1 用不到。

**引入判据**（满足任一）：① 需要 ≥2 个非 OpenAI 兼容协议；② 需要跨供应商自动 fallback；
③ 需要它的成本报表。写在这里是为了让"不引入"是一个**有依据的决定**，而不是遗漏。

## 关于超时与客户端生命周期

调用频率是"人手点一次"级别，所以每次新建 `AsyncClient`：
省掉连接池的失效处理（用户改了 base_url 之后旧池还在按旧地址连），
代价是每次一个 TLS 握手 —— 而这个代价在"测试连接"里恰好是**有用的**：
它把首包延迟算进去了，与真实首次请求更接近。

P1 的 `stream()` 沿用同一策略。曾经考虑过复用一个长驻客户端，但它要处理
"用户在设置里改了地址之后，旧连接池还在按旧地址连"这件事，而收益只是
省一次握手 —— 生成一次要几十秒，握手在里面看不见。
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass

import httpx

from ..errors import (
    AiAuthFailed,
    AiContextTooLong,
    AiCredentialMissing,
    AiOfflineOnly,
    AiRateLimited,
    AiTimedOut,
    AiUpstreamError,
    DomainError,
)
from .state import AiState, ProviderConfig

#: 上游响应体被截断后进错误信息的长度。太短看不出原因，太长会把界面撑爆。
_ERROR_SNIPPET_LEN = 200

#: `test` 回显给界面的字符数。只为确认"确实是这个模型在答"，不需要整段。
_ECHO_LEN = 40

#: 需要被映射成我们自己错误码的 httpx 异常。**`InvalidURL` 必须单独列出。**
#:
#: 它直接继承 `Exception`（MRO 是 `InvalidURL → Exception → BaseException`），
#: 而**不是** `httpx.HTTPError` 的子类 —— 这是 httpx 的一个怪点，0.28.1 实测：
#: `issubclass(httpx.InvalidURL, httpx.HTTPError) is False`。
#: 所以三处 `except httpx.HTTPError` 都接不住它：用户把 base_url 填成 `not a url`
#: 时，异常会一路逃到 FastAPI，变成一个 500 —— 而它其实是**用户能自己修**的配置错误。
#: 流式路径下更糟：抛点已经在 SSE 响应开始之后，表现为"流被硬生生截断"，
#: 渲染进程只会报一句"协议错误"，与"地址填错了"毫无关联。
_HTTPX_ERRORS = (httpx.HTTPError, httpx.InvalidURL)

#: **首个 token** 的等待上限（秒）。
#:
#: 刻意不复用 `read_timeout`（30s）与 `AI_TIMEOUT_MS`（45s）：那是个"总时长"量级的值，
#: 而流式生成 30~120 秒是常态 —— 用总时长当超时，会把"模型正在写"掐成一次
#: 看起来像网络故障的错误（`docs/11` §3.2 的坑）。
#:
#: 这里管的是**静默**：从发出请求到第一个实质 chunk（正文 delta / usage / 结束标记）。
#: SSE 的注释行（`: keep-alive`）不算，它只证明连接活着，不证明模型在写。
FIRST_CHUNK_TIMEOUT = 60.0


def stream_timeout(connect_timeout: float) -> httpx.Timeout:
    """流式请求的超时策略。**抽成模块级函数是为了能被断言**。

    `read=None` 是这个函数存在的全部理由。httpx 的 `read` 是"两次读到数据之间的
    最大间隔"，把它接上 `read_timeout`（30 秒）会把一个"想得久但正常"的模型
    掐成一次超时错误 —— 而它报出来的样子像网络故障，用户会去查网络。
    流开始之后的静默该由用户按停止来结束，而不是由一个总时长。

    留一个可断言的函数，是因为这条决策一旦被"顺手统一一下超时"改掉，
    症状（长回答被截断）只在真实模型上偶发，测试里看不出来。
    """
    return httpx.Timeout(connect=connect_timeout, read=None, write=10.0, pool=5.0)


@dataclass(frozen=True, slots=True)
class ModelSpec:
    id: str
    label: str


@dataclass(frozen=True, slots=True)
class TestResult:
    latency_ms: int
    model: str
    echo: str


@dataclass(frozen=True, slots=True)
class ChatRequest:
    """一次生成要发给上游的东西。**不含供应商信息**（那是 `ProviderConfig` 的事）。"""

    model: str
    system: str
    user: str
    temperature: float
    max_tokens: int


@dataclass(frozen=True, slots=True)
class StreamDelta:
    text: str


@dataclass(frozen=True, slots=True)
class StreamUsage:
    """上游报的用量。字段可缺（不是所有供应商都在流里回 usage）。"""

    prompt_tokens: int | None
    completion_tokens: int | None


@dataclass(frozen=True, slots=True)
class StreamDone:
    """流结束。`finish_reason` 已被 `_normalize_finish_reason` 收进契约二值
    （`"stop"` / `"length"`）；第三值 `"aborted"` 是本地产生的（用户点停止），不由网关产出。"""

    finish_reason: str


#: 归一化后的流式分片。**上游的三种方言（OpenAI / Ollama / 各类中转）在这一层被抹平**，
#: 上层只认这三种 —— 这是"薄网关"最有价值的一处抽象。
StreamChunk = StreamDelta | StreamUsage | StreamDone

#: 上游 `finish_reason` 的**开放集合** → 契约的 `"stop"` / `"length"` 二值。
#:
#: 归一化**必须放在网关**（契约的源头），不能留给渲染进程：
#: shared 的 `AiStreamEvent` 把 `finishReason` 定义成闭合联合
#: `'stop' | 'length' | 'aborted'`，渲染进程对不认识的值直接报"协议错误"。
#: 而带 `finish_reason` 的那一帧恰恰是**最后一帧** —— 用户已经看着正文生成完，
#: 却拿到"不认识的事件"、整段内容不可采纳（可采纳要求 `phase === 'ready'`），
#: 且重试必复现。渲染进程也没有信息去区分"这是上游方言"还是"这是实现 bug"。
#:
#: 未列出的值（`tool_calls` / `end_turn` / `stop_sequence` …）一律落 `"stop"`：
#: 它们都表示"模型正常收尾了"，只是用词不同。
_FINISH_REASON_ALIASES = {
    "stop": "stop",
    "length": "length",
    # 有些中转把"撞到 max_tokens"叫成 max_tokens。语义与 length 完全一致，
    # 不认它会让"该提示用户可续写"的场景被当成正常结束。
    "max_tokens": "length",
}

#: 这几个值表示"内容被上游**拦下/丢弃**了"，不是正常结束。
#: 落成 `"stop"` 会让用户看到"生成成功"，而正文其实被截断或拒绝 ——
#: **静默的错误比报错更危险**。所以转成 error 事件
#: （与流内 `error` 对象走同一条 `AiUpstreamError` 通路）。
_FINISH_REASON_BLOCKING = frozenset({"content_filter", "content_filtered", "safety"})


def _normalize_finish_reason(provider: ProviderConfig, raw: str) -> str:
    """把上游开放的 `finish_reason` 收进契约的 `"stop"` / `"length"`。

    只产出这两个值 —— `"aborted"` 由 `service.py` 在取消分支补上，上游不会发。
    见 `_FINISH_REASON_ALIASES` 上方的模块注释：为什么这一步不能后置到渲染进程。
    """
    if raw in _FINISH_REASON_BLOCKING:
        raise AiUpstreamError(provider.id, f"上游以 {raw} 中止了生成（内容被拦下）")
    return _FINISH_REASON_ALIASES.get(raw, "stop")


class ModelGateway:
    def __init__(
        self,
        state: AiState,
        *,
        connect_timeout: float = 8.0,
        read_timeout: float = 30.0,
        first_chunk_timeout: float = FIRST_CHUNK_TIMEOUT,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._state = state
        self._connect_timeout = connect_timeout
        self._read_timeout = read_timeout
        self._first_chunk_timeout = first_chunk_timeout
        # 测试注入 `httpx.MockTransport` 的入口。生产传 None（用默认传输）。
        self._transport = transport

    # ---- 对外能力 ----

    async def list_models(self, provider: ProviderConfig) -> list[ModelSpec]:
        """列出一个供应商可用的模型。

        用途是让用户**从列表里选**而不是手打模型名 —— 打错一个字符的症状是
        `AI_UPSTREAM_ERROR`，而错误信息里往往只有 "model not found"，很难联想到是拼写。
        """
        self._ensure_allowed(provider)
        payload = await self._get_json(provider, self._models_url(provider))
        return self._parse_models(provider, payload)

    async def test(self, provider: ProviderConfig, model: str) -> TestResult:
        """发一次最小请求。

        刻意**不只是探连通性**（那用 `GET /models` 就够了）：用户真正想知道的是
        "用这个 Key、这个模型，能不能出字"。所以发一次真实的 chat 请求。
        `max_tokens` 给 16：够拿到一点回显，又不至于让推理型模型思考很久。
        """
        self._ensure_allowed(provider)
        started = time.perf_counter()
        payload = await self._post_json(
            provider,
            self._chat_url(provider),
            {
                "model": model,
                "messages": [{"role": "user", "content": "你好"}],
                "max_tokens": 16,
                "temperature": 0,
                "stream": False,
            },
        )
        latency_ms = int((time.perf_counter() - started) * 1000)

        echo = self._extract_text(payload)
        if echo is None:
            # 200 但结构不对：最常见的原因是 base_url 指向了不是聊天接口的服务
            # （比如把首页地址填了进来）。这条提示能省掉一轮来回。
            raise AiUpstreamError(
                provider.id,
                "返回里没有 choices/message 字段，这个地址可能不是 OpenAI 兼容的聊天接口。",
            )
        return TestResult(latency_ms=latency_ms, model=model, echo=echo[:_ECHO_LEN])

    # ---- 流式生成 ----

    async def stream(
        self,
        provider: ProviderConfig,
        req: ChatRequest,
        *,
        first_chunk_timeout: float | None = None,
    ) -> AsyncIterator[StreamChunk]:
        """流式生成。产出归一化后的分片；失败一律抛 `DomainError`。

        ## 超时策略（**这是最容易写错的一处**）

        `httpx.Timeout(read=...)` 是"两次读到数据之间的最大间隔"，把它设成
        `read_timeout`（30s）会让一个**正常但话痨得慢**的模型在中途被掐断，
        而报出来的是一个超时错误 —— 用户会以为是网络问题。
        所以这里的 `read` 显式设为 `None`（不限），静默由
        `first_chunk_timeout` 单独管，且只作用于开始阶段。

        ## 为什么在本地自己解析 SSE 而不引库

        SSE 的语法只有四件事（空行、`:` 注释、`field: value`、`data:` 累积），
        而各家中转的差异恰恰在"它们不完全守规范"这一点上。自己解析意味着
        遇到不认识的字段可以**忽略并继续**，而不是让一个库的严格模式抛错。

        ## 上游在流开始前就报错

        401/429/5xx 会在 `__aenter__` 之后、读到第一个 body 之前就能看到状态码。
        这时抛出的 `DomainError` 发生在**路由还没往渲染进程写任何字节之前**，
        所以它能变成一个正常的 HTTP 错误响应（而不是 SSE 里的 error 事件）。

        **3xx 同样走这条路**（`>= 300` 而不是 `>= 400`）：httpx 默认不跟随重定向，
        我们刻意不改这个默认值（跟随会把 `Authorization: Bearer <key>` 发到重定向目标）。
        但不跟随就必须自己判错 —— 否则拿到的是重定向页的 body，它一行 `data:` 都没有，
        于是走完空循环、发出 `StreamDone("stop")`，也就是**静默的空成功**。
        详见 `_error_for_status` 的注释。
        """
        self._ensure_allowed(provider)
        headers = self._headers(provider, json_body=True)
        body: dict[str, object] = {
            "model": req.model,
            "messages": [
                {"role": "system", "content": req.system},
                {"role": "user", "content": req.user},
            ],
            "temperature": req.temperature,
            "max_tokens": req.max_tokens,
            "stream": True,
            # 让上游在最后一个 chunk 里带回真实用量。不支持的供应商会忽略它，
            # 那时我们退回用 estimate_tokens 估算（见 ai/service.py）。
            "stream_options": {"include_usage": True},
        }
        timeout = stream_timeout(self._connect_timeout)
        budget = self._first_chunk_timeout if first_chunk_timeout is None else first_chunk_timeout

        try:
            async with (
                httpx.AsyncClient(timeout=timeout, transport=self._transport) as client,
                client.stream("POST", self._chat_url(provider), headers=headers, json=body)
                as response,
            ):
                if response.status_code >= 300:
                    # 必须先把 body 读出来才能拿到错误详情（流式响应默认不读 body）。
                    await response.aread()
                    error = self._error_for_status(provider, response)
                    if error is not None:
                        raise error
                async for chunk in self._iter_chunks(provider, response, budget):
                    yield chunk
        except httpx.TimeoutException as exc:
            # 连接阶段超时走这里；读阶段的静默由 _iter_chunks 自己报（它知道是首 chunk）。
            raise AiTimedOut(provider.id, budget) from exc
        except _HTTPX_ERRORS as exc:
            raise self._map_transport_error(provider, exc) from exc

    async def _iter_chunks(
        self, provider: ProviderConfig, response: httpx.Response, first_chunk_timeout: float
    ) -> AsyncIterator[StreamChunk]:
        """把上游的 SSE 行流转成归一化分片。

        `finishReason` 单独记着、在流结束时才发 `StreamDone`：供应商可能把它放在
        最后一个 chunk（那时 delta 已空），也可能在它之后再补一个纯 usage 的 chunk。
        边收到边发 done 会让调用方以为可以收尾，而后面还有数据在来。
        """
        lines = response.aiter_lines()
        alive = False  # 是否已经有过"模型确实在写"的证据
        finish_reason = ""
        while True:
            try:
                if alive:
                    line = await lines.__anext__()
                else:
                    line = await asyncio.wait_for(lines.__anext__(), first_chunk_timeout)
            except StopAsyncIteration:
                break
            except TimeoutError as exc:
                # 首 chunk 超时：区分"模型挂了"与"模型在思考"。
                raise AiTimedOut(provider.id, first_chunk_timeout) from exc

            for chunk, is_liveness in _parse_sse_line(provider, line):
                if is_liveness:
                    alive = True
                if isinstance(chunk, StreamDone):
                    finish_reason = chunk.finish_reason
                    continue
                yield chunk

        yield StreamDone(finish_reason or "stop")

    # ---- 拦截点 ----

    def _ensure_allowed(self, provider: ProviderConfig) -> None:
        """「纯本地模式」的**唯一**拦截点（`docs/01` §9.3 / `docs/11` §9）。

        放在网关而不是路由层：路由会越来越多（P1 续写、P2 改写…），
        每加一条都在各处补一次判断，漏一处就等于这个开关没做 ——
        而它的失效方式是"用户以为不出门，其实出门了"，事后无法补救。
        """
        if self._state.offline_only and not provider.local:
            raise AiOfflineOnly(provider.id)

    # ---- URL 与请求头 ----

    @staticmethod
    def _join(base_url: str, path: str) -> str:
        return f"{base_url.rstrip('/')}{path}"

    def _chat_url(self, provider: ProviderConfig) -> str:
        # Ollama 同时提供原生接口与 OpenAI 兼容接口；聊天一律走兼容接口 ——
        # 少一套请求体与响应体的解析，出错面小一半。
        if provider.kind == "ollama":
            return self._join(provider.base_url, "/v1/chat/completions")
        return self._join(provider.base_url, "/chat/completions")

    def _models_url(self, provider: ProviderConfig) -> str:
        # 列模型**必须**用原生接口：Ollama 的 `/v1/models` 在旧版本上不存在，
        # 而 `/api/tags` 多年来一直稳定。
        if provider.kind == "ollama":
            return self._join(provider.base_url, "/api/tags")
        return self._join(provider.base_url, "/models")

    def _headers(self, provider: ProviderConfig, *, json_body: bool) -> dict[str, str]:
        headers: dict[str, str] = {"Accept": "application/json"}
        if json_body:
            headers["Content-Type"] = "application/json"

        secret = self._state.credential(provider.id)
        # 需要 Key 却没有 → 直接说"重新保存一次"（真源在主进程，多半是推送没到）
        if provider.needs_key and not secret:
            raise AiCredentialMissing(provider.id)
        if secret is not None:
            headers["Authorization"] = f"Bearer {secret}"
        return headers

    # ---- HTTP ----

    async def _get_json(self, provider: ProviderConfig, url: str) -> dict[str, object]:
        headers = self._headers(provider, json_body=False)
        async with httpx.AsyncClient(timeout=self._timeout(), transport=self._transport) as client:
            try:
                response = await client.get(url, headers=headers)
            except _HTTPX_ERRORS as exc:
                raise self._map_transport_error(provider, exc) from exc
        return self._parse_response(provider, response)

    async def _post_json(
        self, provider: ProviderConfig, url: str, body: dict[str, object]
    ) -> dict[str, object]:
        headers = self._headers(provider, json_body=True)
        async with httpx.AsyncClient(timeout=self._timeout(), transport=self._transport) as client:
            try:
                response = await client.post(url, headers=headers, json=body)
            except _HTTPX_ERRORS as exc:
                raise self._map_transport_error(provider, exc) from exc
        return self._parse_response(provider, response)

    def _timeout(self) -> httpx.Timeout:
        return httpx.Timeout(
            connect=self._connect_timeout,
            read=self._read_timeout,
            write=10.0,
            pool=5.0,
        )

    def _map_transport_error(
        self, provider: ProviderConfig, exc: httpx.HTTPError | httpx.InvalidURL
    ) -> DomainError:
        """传输层异常 → 我们的错误码。**三类分开，因为用户的下一步动作不同。**

        - 地址不合法 → 去改设置里的 base_url（纯配置问题，不是网络问题）；
        - 超时 → 换模型或重试；
        - 连不上 → 查网络。

        混成一个码的话，界面只能给一句"失败了"，用户无从下手。
        """
        if isinstance(exc, httpx.InvalidURL):
            # `InvalidURL` 的 `str()` 很有信息量（`Invalid port: 'abc'` /
            # `Invalid IDNA hostname`），直接给用户看比笼统的"地址无效"有用得多。
            return AiUpstreamError(
                provider.id,
                f"供应商地址不是合法的 URL（{exc}）。请检查设置里的地址。",
            )
        if isinstance(exc, httpx.TimeoutException):
            return AiTimedOut(provider.id, self._read_timeout)
        return AiUpstreamError(
            provider.id,
            f"连不上模型服务（{type(exc).__name__}）。请检查网络与供应商地址。",
        )

    def _error_for_status(
        self, provider: ProviderConfig, response: httpx.Response
    ) -> DomainError | None:
        """响应 → 我们的错误码。`None` 表示"这不是错误"。

        抽出来是因为**流式与非流式都要用**：非流式在 `_parse_response` 里用，
        流式在读到响应头之后、开始读 body 之前用（`stream()` 的 docstring 说明了
        "这时抛出的错还能变成正常的 HTTP 响应"）。

        收 `httpx.Response` 而不是 `(status_code, text)`：3xx 的提示要带上 `Location`，
        而那是响应头里的东西。流式调用点已经 `aread()` 过，所以 `response.text` 可读。

        ## 为什么 3xx 也算错误

        httpx 默认 `follow_redirects=False`，而我们**刻意不改**这个默认值 ——
        跟随重定向会把 `Authorization: Bearer <key>` 发到重定向的目标去，
        一旦 base_url 被填错或被中间件劫持，那等于把 Key 交给对方。

        但"不跟随"就必须"自己判错"，否则后果是**静默的空成功**：
        流式路径拿到的是重定向页的 body，它一行 `data:` 都没有 → 空循环 →
        发出 `StreamDone("stop")` → 界面显示"生成完成"而一个字都没有，
        连记录里都是成功（`service.py` 的 `completed=True`）。
        非流式路径稍好（`_as_object` 会失败并报"不是 JSON"），但提示指向的是
        "这个地址可能不是模型服务"，不如直接说"被重定向了"精确。
        """
        status_code = response.status_code
        if status_code in (401, 403):
            return AiAuthFailed(provider.id, status_code)
        if status_code == 429:
            return AiRateLimited(provider.id)
        if status_code == 413:
            return AiContextTooLong(provider.id)
        if 300 <= status_code < 400:
            location = _snippet(response.headers.get("location", ""))
            where = f"（→ {location}）" if location else ""
            return AiUpstreamError(
                provider.id,
                f"上游把请求重定向到了别处{where}（HTTP {status_code}）。"
                "这个地址多半不是模型接口，请检查设置里的供应商地址。",
                status_code,
            )
        if status_code < 400:
            return None

        snippet = _snippet(response.text)
        # 上下文超长在上游常常是 400 而不是 413，只能靠报文认。
        # 单独成码的价值：界面能直接提示"缩短选区"，而不是让用户去猜 400 是什么。
        lowered = snippet.lower()
        # 上游的原文五花八门（"maximum context length" / "too many tokens" /
        # "exceeds max_tokens"），所以按关键词组合认，不按整句匹配。
        too_long = "context" in lowered and (
            "length" in lowered or "token" in lowered or "max" in lowered
        )
        if too_long:
            return AiContextTooLong(provider.id)
        return AiUpstreamError(
            provider.id,
            f"HTTP {status_code}：{snippet}",
            status_code,
        )

    def _parse_response(
        self, provider: ProviderConfig, response: httpx.Response
    ) -> dict[str, object]:
        error = self._error_for_status(provider, response)
        if error is not None:
            raise error

        payload = _as_object(response.text)
        if payload is None:
            raise AiUpstreamError(
                provider.id, "返回的内容不是 JSON 对象，这个地址可能不是模型服务。"
            )
        return payload

    # ---- 解析 ----

    @staticmethod
    def _parse_models(provider: ProviderConfig, payload: dict[str, object]) -> list[ModelSpec]:
        if provider.kind == "ollama":
            raw_items = payload.get("models")
            name_key = "name"
        else:
            raw_items = payload.get("data")
            name_key = "id"
        if not isinstance(raw_items, list):
            raise AiUpstreamError(
                provider.id,
                f"模型列表的结构不认识（没找到含 {name_key} 的数组），"
                "这个地址可能不是模型服务。",
            )

        specs: list[ModelSpec] = []
        for item in raw_items:
            name = item.get(name_key) if isinstance(item, dict) else None
            if isinstance(name, str) and name != "":
                specs.append(ModelSpec(id=name, label=name))
        # 排序只为了让界面的下拉框稳定 —— 上游给的顺序可能每次都不一样
        specs.sort(key=lambda spec: spec.id)
        return specs

    @staticmethod
    def _extract_text(payload: dict[str, object]) -> str | None:
        """取回显文本。`None` 表示**结构不认识**（与"内容为空"是两件事）。"""
        choices = payload.get("choices")
        if not isinstance(choices, list) or len(choices) == 0:
            return None
        first = choices[0]
        if not isinstance(first, dict):
            return None
        message = first.get("message")
        if not isinstance(message, dict):
            return None
        for field in ("content", "reasoning_content"):
            value = message.get(field)
            if isinstance(value, str) and value.strip() != "":
                return value.strip()
        # 有正确结构但内容为空：推理型模型把预算花在思考上是正常的，不算失败
        return ""


def _parse_sse_line(
    provider: ProviderConfig, line: str
) -> list[tuple[StreamChunk, bool]]:
    """一行 SSE →（分片, 是否证明"模型在写"）。**纯函数**，可以拿真报文穷举。

    返回列表而不是单值：一行里理论上可以既带 delta 又带 finish_reason
    （不少中转就是这么发的），那两个都要往上报。

    认不出来的一律**忽略并继续** —— 见 `stream()` 的 docstring：
    各家中转都不完全守规范，遇到不认识的字段就断流是最差的选择。

    两个例外，都**必须**抛而不能"忽略并继续"，因为忽略的后果是"静默的空成功"：
    200 的流里塞 `error` 对象；以及表示"内容被上游拦下"的 `finish_reason`
    （`_FINISH_REASON_BLOCKING`，见 `_normalize_finish_reason`）。

    ## 为什么不上报 `reasoning_content`

    `test` 端点会把 `reasoning_content` 当回显（那里只想知道"模型答没答"），
    但**生成正文时绝不能把它拼进正文** —— 推理型的思考过程会变成小说里的一段胡话。
    两处口径不同是刻意的。
    """
    if line == "" or line.startswith(":"):
        # 空行是事件分隔符，`:` 开头是注释（keep-alive）。两者都不算"模型在写"。
        return []
    if not line.startswith("data:"):
        return []

    payload = line[len("data:") :].strip()
    if payload == "[DONE]":
        return [(StreamDone("stop"), True)]

    raw = _as_object(payload)
    if raw is None:
        return []

    # 有的供应商在 200 的流里塞一个 error 对象。不认它就等于"生成到一半静默停住"。
    error = raw.get("error")
    if isinstance(error, dict):
        raise AiUpstreamError(provider.id, f"上游在流中报错：{_snippet(json.dumps(error))}")

    chunks: list[tuple[StreamChunk, bool]] = []

    usage = raw.get("usage")
    if isinstance(usage, dict):
        prompt = usage.get("prompt_tokens")
        completion = usage.get("completion_tokens")
        chunks.append(
            (
                StreamUsage(
                    prompt_tokens=prompt if isinstance(prompt, int) else None,
                    completion_tokens=completion if isinstance(completion, int) else None,
                ),
                True,
            )
        )

    choices = raw.get("choices")
    first = choices[0] if isinstance(choices, list) and choices else None
    if isinstance(first, dict):
        delta = first.get("delta")
        if isinstance(delta, dict):
            text = delta.get("content")
            if isinstance(text, str) and text != "":
                chunks.append((StreamDelta(text), True))
        finish = first.get("finish_reason")
        if isinstance(finish, str) and finish != "":
            chunks.append((StreamDone(_normalize_finish_reason(provider, finish)), True))

    return chunks


def _as_object(text: str) -> dict[str, object] | None:
    try:
        parsed: object = json.loads(text)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _snippet(text: str) -> str:
    """把上游报文压成一行短文本，放进用户可见的错误里。"""
    collapsed = " ".join(text.split())
    return collapsed[:_ERROR_SNIPPET_LEN]
