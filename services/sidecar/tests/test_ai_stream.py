"""流式生成链路（``ai/gateway.py`` 的 stream / ``ai/service.py`` / 三个新端点）。

## 这一份在防什么

P1 有五处**只在真实模型上偶发**的失败，测试是唯一的防线：

1. 把流式的超时接成了 `read_timeout` → 长回答中途被掐（像网络故障）；
2. 上游的方言差异（`data:` / `[DONE]` / 注释行 / `reasoning_content`）没抹平；
3. 用户中间按了停止 → 那条外发记录丢了；
4. 两路生成同时改同一章（`docs/11` §8.3 说这是**最坏的数据事故**）；
5. 超预算只弹提示、没真拦 —— 或者反过来，硬拦到用户没法"确认后继续"。
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Callable, Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from inkstone.ai.gateway import (
    ChatRequest,
    ModelGateway,
    StreamDelta,
    StreamDone,
    StreamUsage,
    stream_timeout,
)
from inkstone.ai.runs import RunStore
from inkstone.ai.service import GenerationRequest, GenerationService
from inkstone.ai.state import AiState, ProviderConfig
from inkstone.ai.usage import UsageLedger
from inkstone.app import create_app
from inkstone.config import Settings
from inkstone.domain.clock import now_iso
from inkstone.errors import (
    AiAuthFailed,
    AiBusy,
    AiOfflineOnly,
    AiTimedOut,
    AiUpstreamError,
    DomainError,
)
from inkstone.storage.repo import WorkRegistry

Handler = Callable[[httpx.Request], httpx.Response]

CLOUD = ProviderConfig(
    id="deepseek",
    kind="openai-compatible",
    label="DeepSeek",
    base_url="https://api.deepseek.com/v1",
    local=False,
    needs_key=True,
)
LOCAL = ProviderConfig(
    id="ollama",
    kind="ollama",
    label="Ollama（本机）",
    base_url="http://127.0.0.1:11434",
    local=True,
    needs_key=False,
)

CLOUD_BODY = {
    "id": "deepseek",
    "kind": "openai-compatible",
    "label": "DeepSeek",
    "baseUrl": "https://api.deepseek.com/v1",
    "local": False,
    "needsKey": True,
}

CHAT = ChatRequest(
    model="deepseek-chat",
    system="你是写作助手。",
    user="【前文】他推开门。",
    temperature=0.75,
    max_tokens=256,
)


def _state(*providers: ProviderConfig, offline_only: bool = False) -> AiState:
    state = AiState()
    state.apply(
        providers=providers,
        credentials={"deepseek": "sk-testsecret"} if any(not p.local for p in providers) else {},
        offline_only=offline_only,
        routing={},
        default_provider_id=providers[0].id if providers else None,
        default_model="deepseek-chat" if providers else "",
        style_card="",
        daily_budget_cny=0.0,
    )
    return state


# ---------------------------------------------------------------------------
# 上游假流
# ---------------------------------------------------------------------------


class FakeStream(httpx.AsyncByteStream):
    """一段可控节奏的响应体。

    `gaps` 是**每个分片之前**的等待秒数，用来构造"静默"与"慢但在写"两种情形。
    """

    def __init__(self, chunks: list[bytes], gaps: list[float] | None = None) -> None:
        self._chunks = chunks
        # 补齐而不是要求等长：绝大多数用例只关心"某几个分片之前要等"，
        # 逼调用方数清 `data: [DONE]` 之类的尾巴只会让用例更难写。
        given = list(gaps or [])
        self._gaps = given + [0.0] * max(0, len(chunks) - len(given))

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for chunk, gap in zip(self._chunks, self._gaps, strict=True):
            if gap:
                await asyncio.sleep(gap)
            yield chunk


def _frames(*payloads: object, end: bool = True) -> list[bytes]:
    lines = [f"data: {json.dumps(p)}".encode() + b"\n\n" for p in payloads]
    if end:
        lines.append(b"data: [DONE]\n\n")
    return lines


def _delta(text: str) -> dict[str, object]:
    return {"choices": [{"delta": {"content": text}}]}


def _gateway_with(
    state: AiState,
    chunks: list[bytes] | None = None,
    *,
    status: int = 200,
    body: object = None,
    gaps: list[float] | None = None,
    first_chunk_timeout: float = 5.0,
) -> tuple[ModelGateway, list[httpx.Request]]:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if chunks is None:
            return httpx.Response(status, json=body)
        return httpx.Response(
            status,
            stream=FakeStream(chunks, gaps),
            headers={"content-type": "text/event-stream"},
        )

    gateway = ModelGateway(
        state,
        first_chunk_timeout=first_chunk_timeout,
        transport=httpx.MockTransport(handler),
    )
    return gateway, seen


async def _drain(gateway: ModelGateway, provider: ProviderConfig = CLOUD) -> list[object]:
    return [chunk async for chunk in gateway.stream(provider, CHAT)]


# ---------------------------------------------------------------------------
# SSE 行解析（纯函数，用真报文穷举）
# ---------------------------------------------------------------------------


class TestSseLine:
    def _parse(self, line: str) -> Any:
        # 直接测那个私有纯函数：它是"上游方言差异"的唯一收敛点，
        # 而这里要喂的报文（keep-alive 注释、空 delta、内联 error、半截 JSON）
        # 用假流去构造会绕一大圈。
        from inkstone.ai.gateway import _parse_sse_line

        return _parse_sse_line(CLOUD, line)

    def test_noise_is_ignored(self) -> None:
        for line in ("", ": keep-alive", "event: message", "id: 3", "retry: 1000", "乱写"):
            assert self._parse(line) == [], line

    def test_delta_is_extracted(self) -> None:
        chunks = self._parse('data: {"choices":[{"delta":{"content":"他"}}]}')
        assert chunks == [(StreamDelta("他"), True)]

    def test_empty_delta_is_not_a_chunk(self) -> None:
        # 很多供应商会发一个 `delta: {}` 的空帧作为心跳。当成空 delta 上报会让
        # 渲染进程多走一次"有数据了"的分支。
        assert self._parse('data: {"choices":[{"delta":{}}]}') == []
        assert self._parse('data: {"choices":[{"delta":{"content":""}}]}') == []

    def test_finish_reason_is_reported(self) -> None:
        chunks = self._parse('data: {"choices":[{"delta":{},"finish_reason":"length"}]}')
        assert chunks == [(StreamDone("length"), True)]

    def test_upstream_dialects_are_normalized(self) -> None:
        """上游 `finish_reason` 是**开放集合**，必须在这里收敛成契约二值。

        不收敛的症状是 H3：`content_filter` / `end_turn` 原样透传 → 渲染进程的
        严格校验把**最后一帧**判成"不认识的事件" → 用户看着正文生成完，
        却整段不可采纳，且重试必复现。
        """
        for raw in ("stop", "end_turn", "stop_sequence", "tool_calls", "whatever"):
            chunks = self._parse(f'data: {{"choices":[{{"finish_reason":"{raw}"}}]}}')
            assert chunks == [(StreamDone("stop"), True)], raw

    def test_max_tokens_is_folded_into_length(self) -> None:
        # 有些中转把"撞到 max_tokens"叫成 max_tokens。若落成 stop，
        # 界面就不会提示"可继续写"，用户以为模型自己写完了。
        chunks = self._parse('data: {"choices":[{"finish_reason":"max_tokens"}]}')
        assert chunks == [(StreamDone("length"), True)]

    def test_content_filter_is_an_error_not_a_silent_stop(self) -> None:
        """内容被上游拦下**必须报错**，不能落成 stop。

        落成 stop 会让用户看到"生成成功"，而正文其实被截断/拒绝 ——
        静默的错误比报错更危险。
        """
        with pytest.raises(AiUpstreamError):
            self._parse('data: {"choices":[{"finish_reason":"content_filter"}]}')

    def test_done_sentinel(self) -> None:
        assert self._parse("data: [DONE]") == [(StreamDone("stop"), True)]

    def test_usage_chunk(self) -> None:
        chunks = self._parse('data: {"usage":{"prompt_tokens":12,"completion_tokens":3}}')
        assert chunks == [(StreamUsage(prompt_tokens=12, completion_tokens=3), True)]

    def test_reasoning_content_is_not_forwarded_as_text(self) -> None:
        """推理型的思考过程**绝不能**被拼进小说正文。

        `test` 端点会把 `reasoning_content` 当回显（那里只想知道"模型答没答"），
        两处口径不同是刻意的 —— 所以这条要单独钉住。
        """
        line = 'data: {"choices":[{"delta":{"reasoning_content":"嗯，应该先写他推门"}}]}'
        assert self._parse(line) == []

    def test_inline_error_object_raises(self) -> None:
        # 有的供应商在 200 的流里塞 error。不认它 = 生成到一半静默停住。
        with pytest.raises(AiUpstreamError):
            self._parse('data: {"error":{"message":"quota exceeded"}}')

    def test_broken_json_is_ignored(self) -> None:
        assert self._parse("data: {不是 json") == []


# ---------------------------------------------------------------------------
# 网关
# ---------------------------------------------------------------------------


class TestGatewayStream:
    @pytest.mark.asyncio
    async def test_normalizes_a_stream(self) -> None:
        gateway, _ = _gateway_with(
            _state(CLOUD),
            _frames(
                _delta("他推开门，"),
                _delta("屋里没人。"),
                {"choices": [{"delta": {}, "finish_reason": "stop"}]},
                {"usage": {"prompt_tokens": 120, "completion_tokens": 8}},
            ),
        )
        chunks = await _drain(gateway)
        assert chunks == [
            StreamDelta("他推开门，"),
            StreamDelta("屋里没人。"),
            StreamUsage(prompt_tokens=120, completion_tokens=8),
            StreamDone("stop"),
        ]

    @pytest.mark.asyncio
    async def test_stream_without_finish_reason_still_ends_with_done(self) -> None:
        gateway, _ = _gateway_with(_state(CLOUD), _frames(_delta("一")))
        chunks = await _drain(gateway)
        assert chunks[-1] == StreamDone("stop")

    @pytest.mark.asyncio
    async def test_done_sentinel_stops_reading(self) -> None:
        """`[DONE]` 之后的垃圾不能再被解析（有些中转会在后面补一个空行）。"""
        gateway, _ = _gateway_with(
            _state(CLOUD),
            [*_frames(_delta("一")), b"data: {not json\n\n"],
        )
        chunks = await _drain(gateway)
        assert chunks == [StreamDelta("一"), StreamDone("stop")]

    @pytest.mark.asyncio
    async def test_request_body_asks_for_streaming_usage(self) -> None:
        gateway, seen = _gateway_with(_state(CLOUD), _frames(_delta("一")))
        await _drain(gateway)
        sent = json.loads(seen[0].content)
        assert sent["stream"] is True
        assert sent["stream_options"] == {"include_usage": True}
        assert sent["messages"][0] == {"role": "system", "content": CHAT.system}
        assert sent["messages"][1] == {"role": "user", "content": CHAT.user}

    @pytest.mark.asyncio
    async def test_status_error_is_raised_before_any_chunk(self) -> None:
        """上游在流开始前就报错 → 抛异常，而不是发一个空流。

        这条保证"建响应之前失败"那批能变成正常的 HTTP 4xx（见 `ai/service.py`），
        路由还没往渲染进程写过任何字节。
        """
        gateway, _ = _gateway_with(
            _state(CLOUD), status=401, body={"error": {"message": "invalid key"}}
        )
        with pytest.raises(AiAuthFailed):
            await _drain(gateway)

    @pytest.mark.asyncio
    async def test_429_maps_to_rate_limited(self) -> None:
        gateway, _ = _gateway_with(_state(CLOUD), status=429, body={"error": {"message": "slow"}})
        with pytest.raises(DomainError) as excinfo:
            await _drain(gateway)
        assert excinfo.value.code == "AI_RATE_LIMITED"

    @pytest.mark.asyncio
    async def test_silence_before_first_chunk_times_out(self) -> None:
        gateway, _ = _gateway_with(
            _state(CLOUD),
            _frames(_delta("一")),
            gaps=[5.0],  # 远大于 first_chunk_timeout
            first_chunk_timeout=0.05,
        )
        with pytest.raises(AiTimedOut):
            await _drain(gateway)

    @pytest.mark.asyncio
    async def test_keepalive_comments_do_not_count_as_liveness(self) -> None:
        """SSE 注释行只证明连接活着，**不证明模型在写**。

        不区分的话，一个挂着不动的上游会被自己的 keep-alive 永远瞒过去 ——
        用户看到的是"一直在转圈"，而超时永远不触发。
        """
        gateway, _ = _gateway_with(
            _state(CLOUD),
            [b": ping\n\n"] * 3 + _frames(_delta("一")),
            gaps=[0.05, 0.05, 0.05, 5.0],
            first_chunk_timeout=0.1,
        )
        with pytest.raises(AiTimedOut):
            await _drain(gateway)

    @pytest.mark.asyncio
    async def test_slow_but_steady_stream_survives(self) -> None:
        """首 chunk 之后的慢不改超时 —— 那正是"模型在写"的常态。"""
        gateway, _ = _gateway_with(
            _state(CLOUD),
            _frames(_delta("一"), _delta("二"), _delta("三")),
            gaps=[0.0, 0.12, 0.12],
            first_chunk_timeout=0.05,  # 首 chunk 立刻到，不受影响
        )
        chunks = await _drain(gateway)
        assert chunks == [
            StreamDelta("一"),
            StreamDelta("二"),
            StreamDelta("三"),
            StreamDone("stop"),
        ]

    @pytest.mark.asyncio
    async def test_offline_only_blocks_streaming_too(self) -> None:
        """纯本地模式的拦截在**网关**，所以流式这条路也自动被拦（docs/11 §9）。"""
        gateway, seen = _gateway_with(_state(CLOUD, offline_only=True), _frames(_delta("一")))
        with pytest.raises(AiOfflineOnly):
            await _drain(gateway)
        assert seen == []  # 一个字节都没出门

    @pytest.mark.asyncio
    async def test_local_provider_is_allowed_in_offline_mode(self) -> None:
        gateway, _ = _gateway_with(_state(LOCAL, offline_only=True), _frames(_delta("一")))
        chunks = await _drain(gateway, LOCAL)
        assert chunks[0] == StreamDelta("一")


class TestStreamTimeoutPolicy:
    def test_read_timeout_is_disabled_for_streams(self) -> None:
        """**绝不能让流式复用 `read_timeout`。**

        httpx 的 `read` 是"两次读到数据之间的最大间隔"。接上 30 秒之后，
        一个想得久但正常的模型会在中途被掐，而报出来的是一个超时错误 ——
        用户会去查网络。这条断言是那条决策的守卫（`stream_timeout` 的 docstring）。
        """
        timeout = stream_timeout(8.0)
        assert timeout.read is None
        assert timeout.connect == 8.0


# ---------------------------------------------------------------------------
# 端点
# ---------------------------------------------------------------------------


@pytest.fixture()
def make_client(
    settings: Settings, work: dict, auth_headers: dict[str, str]
) -> Iterator[Callable[[Handler], TestClient]]:
    """按需构造注入了 MockTransport 的客户端，并**把已有的作品打开**。

    每个用例的上游响应都不一样（正常流 / 401 / 429），共享夹具会长出一堆
    "按 URL 分派"的分支。所以新 app 每个用例现建一个 —— 代价是它的仓储是空的，
    必须用 `POST /works/open` 按路径把 `work` 夹具建好的作品登记进来。
    少了这一步，所有用例都会以 `WORK_NOT_FOUND` 失败（第一版就是这么错的）。
    """

    def build(handler: Handler) -> TestClient:
        client = TestClient(create_app(settings, ai_transport=httpx.MockTransport(handler)))
        opened = client.post(
            "/api/v1/works/open",
            headers=auth_headers,
            json={"rootPath": work["rootPath"]},
        )
        assert opened.status_code == 200, opened.text
        return client

    yield build


def _push(
    client: TestClient,
    headers: dict[str, str],
    *,
    routing: dict[str, Any] | None = None,
    default_model: str = "deepseek-chat",
    daily_budget_cny: float = 0.0,
    style_card: str = "",
    acknowledged_egress_providers: list[str] | None = None,
) -> None:
    res = client.put(
        "/api/v1/ai/config",
        headers=headers,
        json={
            "providers": [CLOUD_BODY],
            "credentials": {"deepseek": "sk-testsecret"},
            "offlineOnly": False,
            "routing": routing or {},
            "defaultProviderId": "deepseek",
            "defaultModel": default_model,
            "styleCard": style_card,
            "dailyBudgetCny": daily_budget_cny,
            "acknowledgedEgressProviders": acknowledged_egress_providers or [],
        },
    )
    assert res.status_code == 200, res.text


def _chapter_id(client: TestClient, headers: dict[str, str], work: dict) -> str:
    res = client.get(f"/api/v1/works/{work['id']}/chapters", headers=headers)
    assert res.status_code == 200, res.text
    return str(res.json()["items"][0]["id"])


def _gen_body(work: dict, chapter_id: str, **overrides: object) -> dict[str, object]:
    body: dict[str, object] = {
        "workId": work["id"],
        "chapterId": chapter_id,
        "prefix": "他推开门。",
        "suffix": "",
        "intent": "",
    }
    body.update(overrides)
    return body


def _parse_frames(frames: list[bytes]) -> list[dict[str, Any]]:
    """把 `events()` 直接产出的字节帧解析成字典。

    与走 HTTP 的 `_read_events` 共用这一条解析路径，两处口径不会漂。
    """
    events: list[dict[str, Any]] = []
    for line in b"".join(frames).decode("utf-8").splitlines():
        if line.startswith("data: "):
            events.append(json.loads(line[len("data: ") :]))
    return events


def _read_events(res: httpx.Response) -> list[dict[str, Any]]:
    return _parse_frames([b"".join(res.iter_bytes())])


def _ok_stream(text: str = "屋里没人。") -> list[bytes]:
    head = text[: len(text) // 2] or text
    tail = text[len(text) // 2 :]
    return _frames(
        _delta(head),
        _delta(tail),
        {"choices": [{"delta": {}, "finish_reason": "stop"}]},
        {"usage": {"prompt_tokens": 100, "completion_tokens": 6}},
    )


class TestContinueEndpoint:
    def test_streams_meta_deltas_usage_and_done(
        self,
        make_client: Callable[[Handler], TestClient],
        auth_headers: dict[str, str],
        work: dict,
    ) -> None:
        client = make_client(lambda request: httpx.Response(200, stream=FakeStream(_ok_stream())))
        _push(client, auth_headers)
        chapter_id = _chapter_id(client, auth_headers, work)

        with client.stream(
            "POST",
            "/api/v1/ai/continue",
            headers=auth_headers,
            json=_gen_body(work, chapter_id),
        ) as res:
            assert res.status_code == 200
            assert res.headers["content-type"].startswith("text/event-stream")
            events = _read_events(res)

        assert [event["type"] for event in events] == ["meta", "delta", "delta", "usage", "done"]
        assert "".join(e["text"] for e in events if e["type"] == "delta") == "屋里没人。"
        assert events[-1]["finishReason"] == "stop"

        meta = events[0]
        assert meta["runId"].startswith("r_")
        assert meta["providerId"] == "deepseek"
        assert meta["model"] == "deepseek-chat"
        assert meta["templateId"] == "continue"
        assert meta["dropped"] == []
        # 外发字符量在 meta 里就给出来 —— 隐私预览面板要用它，而不是等生成完
        assert meta["egressChars"] > 0
        assert meta["budget"]["used"] <= meta["budget"]["budget"]

        assert events[-2]["promptTokens"] == 100
        assert events[-2]["completionTokens"] == 6

    def test_writes_a_run_record_with_egress_and_cost(
        self,
        make_client: Callable[[Handler], TestClient],
        auth_headers: dict[str, str],
        work: dict,
        work_root: Path,
    ) -> None:
        client = make_client(lambda request: httpx.Response(200, stream=FakeStream(_ok_stream())))
        _push(client, auth_headers)
        chapter_id = _chapter_id(client, auth_headers, work)

        with client.stream(
            "POST",
            "/api/v1/ai/continue",
            headers=auth_headers,
            json=_gen_body(work, chapter_id),
        ) as res:
            _read_events(res)

        runs_path = work_root / ".inkstone" / "ai" / "runs.jsonl"
        lines = [json.loads(line) for line in runs_path.read_text(encoding="utf-8").splitlines()]
        assert len(lines) == 1
        record = lines[0]
        assert record["taskType"] == "continue"
        assert record["targetRef"] == f"chapter:{chapter_id}"
        assert record["providerId"] == "deepseek"
        assert record["promptDigest"].startswith("sha256:")
        assert record["contextTokens"] == 100
        assert record["outputTokens"] == 6
        assert record["egressChars"] > 0
        # deepseek-chat 在价格表里 → 必须给出估算值，而不是 null
        assert record["costCny"] is not None
        assert record["stopped"] is False
        assert record["error"] is None
        assert record["accepted"] is None

    def test_prompt_body_is_never_written_to_disk(
        self,
        make_client: Callable[[Handler], TestClient],
        auth_headers: dict[str, str],
        work: dict,
        work_root: Path,
    ) -> None:
        """`docs/11` §3.6 的 D5：只存摘要，**不存 prompt 正文**。"""
        client = make_client(lambda request: httpx.Response(200, stream=FakeStream(_ok_stream())))
        _push(client, auth_headers, style_card="风格：冷硬，短句。")
        chapter_id = _chapter_id(client, auth_headers, work)

        with client.stream(
            "POST",
            "/api/v1/ai/continue",
            headers=auth_headers,
            json=_gen_body(work, chapter_id),
        ) as res:
            _read_events(res)

        raw = (work_root / ".inkstone" / "ai" / "runs.jsonl").read_text(encoding="utf-8")
        assert "他推开门。" not in raw
        assert "冷硬，短句" not in raw
        assert "你是一位中文小说写作助手" not in raw

    def test_style_card_reaches_the_prompt(
        self,
        make_client: Callable[[Handler], TestClient],
        auth_headers: dict[str, str],
        work: dict,
    ) -> None:
        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(200, stream=FakeStream(_ok_stream()))

        client = make_client(handler)
        _push(client, auth_headers, style_card="风格：冷硬，短句。")
        chapter_id = _chapter_id(client, auth_headers, work)
        with client.stream(
            "POST",
            "/api/v1/ai/continue",
            headers=auth_headers,
            json=_gen_body(work, chapter_id),
        ) as res:
            _read_events(res)

        sent = json.loads(seen[0].content)
        assert "风格：冷硬，短句。" in sent["messages"][0]["content"]
        assert "他推开门。" in sent["messages"][1]["content"]

    def test_upstream_error_mid_stream_becomes_an_error_event(
        self,
        make_client: Callable[[Handler], TestClient],
        auth_headers: dict[str, str],
        work: dict,
        work_root: Path,
    ) -> None:
        """流开始之后的失败只能是 SSE 事件（响应头已经发出去了）。

        而且**必须留下记录**：prompt 确实发出去了，只是被拒了。
        """
        client = make_client(lambda request: httpx.Response(429, json={"error": {"message": "慢"}}))
        _push(client, auth_headers)
        chapter_id = _chapter_id(client, auth_headers, work)

        with client.stream(
            "POST",
            "/api/v1/ai/continue",
            headers=auth_headers,
            json=_gen_body(work, chapter_id),
        ) as res:
            # 429 是在 prepare 之后的第一次上游调用里发生的 —— 响应体已经是 SSE 了
            events = _read_events(res)

        assert events[0]["type"] == "meta"
        assert events[-1]["type"] == "error"
        assert events[-1]["code"] == "AI_RATE_LIMITED"

        record = json.loads(
            (work_root / ".inkstone" / "ai" / "runs.jsonl").read_text(encoding="utf-8").strip()
        )
        assert record["error"] == "AI_RATE_LIMITED"
        assert record["stopped"] is True
        assert record["egressChars"] > 0

    def test_not_configured_is_a_plain_http_error(
        self, make_client: Callable[[Handler], TestClient], auth_headers: dict[str, str], work: dict
    ) -> None:
        """没配模型时**一个字节都没出网**，所以它该是正常的 HTTP 错误、也不留记录。"""
        client = make_client(lambda request: httpx.Response(200, stream=FakeStream([])))
        chapter_id = _chapter_id(client, auth_headers, work)
        res = client.post(
            "/api/v1/ai/continue", headers=auth_headers, json=_gen_body(work, chapter_id)
        )
        assert res.status_code == 400
        assert res.json()["error"]["code"] == "AI_NOT_CONFIGURED"

    def test_unknown_work_is_404(
        self, make_client: Callable[[Handler], TestClient], auth_headers: dict[str, str]
    ) -> None:
        client = make_client(lambda request: httpx.Response(200, stream=FakeStream([])))
        _push(client, auth_headers)
        res = client.post(
            "/api/v1/ai/continue",
            headers=auth_headers,
            json={"workId": "w_nope", "chapterId": "ch_nope", "prefix": "前文。"},
        )
        assert res.status_code == 404


class TestBudgetGuard:
    def test_exceeded_is_blocked_before_any_upstream_call(
        self,
        make_client: Callable[[Handler], TestClient],
        auth_headers: dict[str, str],
        work: dict,
        work_root: Path,
    ) -> None:
        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(200, stream=FakeStream(_ok_stream()))

        client = make_client(handler)
        _push(client, auth_headers, daily_budget_cny=0.001)
        chapter_id = _chapter_id(client, auth_headers, work)

        # 先造一条今日记录，把余额用掉
        ai_dir = work_root / ".inkstone" / "ai"
        ai_dir.mkdir(parents=True, exist_ok=True)
        (ai_dir / "runs.jsonl").write_text(
            json.dumps(
                {
                    "id": "r_old",
                    "workId": work["id"],
                    "at": now_iso(),
                    "taskType": "continue",
                    "costCny": 0.5,
                    "egressChars": 10,
                }
            )
            + "\n",
            encoding="utf-8",
        )

        res = client.post(
            "/api/v1/ai/continue", headers=auth_headers, json=_gen_body(work, chapter_id)
        )
        assert res.status_code == 429
        assert res.json()["error"]["code"] == "AI_BUDGET_EXCEEDED"
        assert res.json()["error"]["detail"]["limitCny"] == 0.001
        assert seen == []  # **一次上游请求都没发**

    def test_force_bypasses_the_guard(
        self,
        make_client: Callable[[Handler], TestClient],
        auth_headers: dict[str, str],
        work: dict,
        work_root: Path,
    ) -> None:
        """超预算时界面要能"告警 + 确认"，所以确认之后重发的那一次必须过得去。

        没有这条，护栏只能二选一：硬阻断（体验差）或形同虚设（等于没做）。
        """
        client = make_client(lambda request: httpx.Response(200, stream=FakeStream(_ok_stream())))
        _push(client, auth_headers, daily_budget_cny=0.001)
        chapter_id = _chapter_id(client, auth_headers, work)
        ai_dir = work_root / ".inkstone" / "ai"
        ai_dir.mkdir(parents=True, exist_ok=True)
        (ai_dir / "runs.jsonl").write_text(
            json.dumps({"id": "r_old", "at": now_iso(), "costCny": 9.0}) + "\n", encoding="utf-8"
        )

        with client.stream(
            "POST",
            "/api/v1/ai/continue",
            headers=auth_headers,
            json=_gen_body(work, chapter_id, force=True),
        ) as res:
            assert res.status_code == 200
            events = _read_events(res)
        assert events[-1]["type"] == "done"


class TestQuickEndpoint:
    def test_kind_selects_the_instruction(
        self,
        make_client: Callable[[Handler], TestClient],
        auth_headers: dict[str, str],
        work: dict,
    ) -> None:
        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(200, stream=FakeStream(_frames(_delta("沈砚"))))

        client = make_client(handler)
        _push(client, auth_headers)
        chapter_id = _chapter_id(client, auth_headers, work)

        with client.stream(
            "POST",
            "/api/v1/ai/quick",
            headers=auth_headers,
            json=_gen_body(work, chapter_id, kind="naming"),
        ) as res:
            events = _read_events(res)

        assert events[0]["templateId"] == "quick"
        sent = json.loads(seen[0].content)
        assert "为下面这个用途起 10 个候选名" in sent["messages"][1]["content"]


class TestRunsEndpoint:
    def test_lists_records_and_usage(
        self,
        make_client: Callable[[Handler], TestClient],
        auth_headers: dict[str, str],
        work: dict,
    ) -> None:
        client = make_client(lambda request: httpx.Response(200, stream=FakeStream(_ok_stream())))
        _push(client, auth_headers, daily_budget_cny=5.0)
        chapter_id = _chapter_id(client, auth_headers, work)
        with client.stream(
            "POST",
            "/api/v1/ai/continue",
            headers=auth_headers,
            json=_gen_body(work, chapter_id),
        ) as res:
            _read_events(res)

        res = client.get(f"/api/v1/ai/runs?workId={work['id']}", headers=auth_headers)
        assert res.status_code == 200, res.text
        payload = res.json()
        assert len(payload["items"]) == 1
        assert payload["items"][0]["workId"] == work["id"]
        usage = payload["usage"]
        assert usage["runs"] == 1
        assert usage["limitCny"] == 5.0
        assert usage["exceeded"] is False
        assert usage["egressChars"] > 0
        # 认得出的模型必须给出价格，否则 unpricedRuns 会是 1
        assert usage["unpricedRuns"] == 0

    def test_feedback_round_trip(
        self,
        make_client: Callable[[Handler], TestClient],
        auth_headers: dict[str, str],
        work: dict,
        work_root: Path,
    ) -> None:
        client = make_client(lambda request: httpx.Response(200, stream=FakeStream(_ok_stream())))
        _push(client, auth_headers)
        chapter_id = _chapter_id(client, auth_headers, work)
        with client.stream(
            "POST",
            "/api/v1/ai/continue",
            headers=auth_headers,
            json=_gen_body(work, chapter_id),
        ) as res:
            _read_events(res)
        run_id = json.loads(
            (work_root / ".inkstone" / "ai" / "runs.jsonl").read_text(encoding="utf-8").strip()
        )["id"]

        res = client.post(
            f"/api/v1/ai/runs/{run_id}/feedback",
            headers=auth_headers,
            json={"workId": work["id"], "accepted": "partial", "acceptedChars": 5},
        )
        assert res.status_code == 200, res.text

        listed = client.get(f"/api/v1/ai/runs?workId={work['id']}", headers=auth_headers).json()
        assert listed["items"][0]["accepted"] == "partial"
        assert listed["items"][0]["acceptedChars"] == 5
        # 采纳结果落在**另一个文件**：审计流本身一个字节都不改
        assert (work_root / ".inkstone" / "ai" / "feedback.jsonl").is_file()

    def test_feedback_for_an_unknown_run_is_400(
        self,
        make_client: Callable[[Handler], TestClient],
        auth_headers: dict[str, str],
        work: dict,
    ) -> None:
        client = make_client(lambda request: httpx.Response(200, stream=FakeStream([])))
        res = client.post(
            "/api/v1/ai/runs/r_nope/feedback",
            headers=auth_headers,
            json={"workId": work["id"], "accepted": "full", "acceptedChars": 1},
        )
        assert res.status_code == 400
        assert res.json()["error"]["code"] == "INVALID_PARAM"

    def test_bogus_accepted_value_is_rejected(
        self,
        make_client: Callable[[Handler], TestClient],
        auth_headers: dict[str, str],
        work: dict,
    ) -> None:
        client = make_client(lambda request: httpx.Response(200, stream=FakeStream([])))
        res = client.post(
            "/api/v1/ai/runs/r_x/feedback",
            headers=auth_headers,
            json={"workId": work["id"], "accepted": "Full", "acceptedChars": 1},
        )
        assert res.status_code == 400
        assert res.json()["error"]["code"] == "INVALID_PARAM"


# ---------------------------------------------------------------------------
# 取消（服务层，不经 HTTP）
# ---------------------------------------------------------------------------


@pytest.fixture()
def stack(settings: Settings) -> Iterator[Callable[..., Any]]:
    """手工搭一套"引擎"，全程在**同一个事件循环**里。

    有两件事只能在服务层做，走 HTTP 做不到：

    - **取消**要打在"正在读上游"的那个 await 上，而 `TestClient` 把应用跑在另一个
      线程的事件循环里，取消传不进去；
    - **并发**要制造"第一路还挂着"的窗口，而 `TestClient` 会把整个响应体缓冲完
      才返回（`_TestClientTransport` 用 `io.BytesIO` 收流），根本进不去那个窗口。

    这两条都是**测试工具的边界**，不是产品行为 —— 而它们恰好是 P1 最需要盯住的两件事。

    `handler` 用来替换整条 transport（`docs/13` M4 的用例靠它让连接在建立时
    就抛一个**非** `httpx.HTTPError` 的异常）。给了它就忽略 `chunks` / `gaps`。
    """

    def build(
        chunks: list[bytes] | None = None,
        gaps: list[float] | None = None,
        *,
        handler: Handler | None = None,
    ) -> Any:
        provider = ProviderConfig(
            id="deepseek",
            kind="openai-compatible",
            label="DeepSeek",
            base_url="https://api.deepseek.com/v1",
            local=False,
            needs_key=True,
        )
        state = _state(provider)
        body = FakeStream(chunks or [], gaps)

        def default_handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, stream=body)

        transport_handler: Handler = default_handler if handler is None else handler
        gateway = ModelGateway(state, transport=httpx.MockTransport(transport_handler))
        registry = WorkRegistry(settings)
        # 用量账本给的目录是空的 —— 这些用例都在 0 预算下跑，不走预算分支。
        service = GenerationService(registry, state, gateway, UsageLedger(lambda: []))
        return registry, service

    yield build


async def _new_work(registry: WorkRegistry, parent_dir: Path, title: str) -> tuple[str, str]:
    """建一部作品，返回（workId, 第一章 id）。"""
    work = await registry.create(parent_dir=str(parent_dir), title=title)
    chapters = await registry.list_chapters(work["id"])
    return str(work["id"]), str(chapters[0]["id"])


class TestServiceGuards:
    @pytest.mark.asyncio
    async def test_same_chapter_is_rejected_while_busy(
        self, stack: Callable[..., Any], parent_dir: Path
    ) -> None:
        """**两路 AI 同时改同一章是最坏的数据事故**（`docs/11` §8.3）。

        拒绝而不是排队：排队会让用户按了 Ctrl+Enter 之后要等前一次跑完才开始，
        而界面上什么都不发生 —— 那看起来就是卡住了。
        """
        registry, service = stack(_frames(_delta("一")))
        work_id, chapter_id = await _new_work(registry, parent_dir, "并发测试")
        req = GenerationRequest(
            task="continue", work_id=work_id, chapter_id=chapter_id, prefix="前文。"
        )

        first = await service.prepare(req)
        with pytest.raises(AiBusy) as excinfo:
            await service.prepare(req)
        assert excinfo.value.code == "AI_BUSY"
        assert excinfo.value.status_code == 409

        # 跑完第一路之后占位必须释放，否则这一章会被**永久**锁死
        async for _ in service.events(first):
            pass
        second = await service.prepare(req)
        assert second.run_id != first.run_id

    @pytest.mark.asyncio
    async def test_a_sibling_chapter_is_not_blocked(
        self, stack: Callable[..., Any], parent_dir: Path
    ) -> None:
        """占位是**按章**的。做成全局的会让"另一章也不能生成"，而那是没有理由的限制。"""
        registry, service = stack(_frames(_delta("一")))
        work = await registry.create(parent_dir=str(parent_dir), title="跨章测试")
        chapters = await registry.list_chapters(work["id"])
        other = await registry.create_chapter(work["id"], title="第二章")

        await service.prepare(
            GenerationRequest(
                task="continue",
                work_id=work["id"],
                chapter_id=chapters[0]["id"],
                prefix="前文。",
            )
        )
        sibling = await service.prepare(
            GenerationRequest(
                task="continue",
                work_id=work["id"],
                chapter_id=other["id"],
                prefix="前文。",
            )
        )
        assert sibling.busy_key.endswith(other["id"])

    @pytest.mark.asyncio
    async def test_cancel_keeps_the_audit_record(
        self, stack: Callable[..., Any], parent_dir: Path
    ) -> None:
        """用户按停止 → 记录必须落盘且 `stopped: true`。

        "我按了停止，到底发出去多少字"正是外发审计要回答的那个问题，
        所以这条记录恰恰是最不能丢的一条（`RunStore.append` 用 `asyncio.shield`）。
        """
        # 第二个分片要等 30 秒才来 —— 这样"取消"必然打在**正在等上游**的那个 await 上。
        # 不加这个间隔的话，假流会在同一个事件循环切片里跑完，
        # 取消打的是一具已经结束的生成（第一版就是这么假绿的）。
        registry, service = stack(
            _frames(_delta("他推开门，"), _delta("屋里")), gaps=[0.0, 30.0, 0.0]
        )
        work = await registry.create(parent_dir=str(parent_dir), title="取消测试")
        chapters = await registry.list_chapters(work["id"])
        chapter_id = chapters[0]["id"]

        gen = await service.prepare(
            GenerationRequest(
                task="continue",
                work_id=work["id"],
                chapter_id=chapter_id,
                prefix="他推开门。",
            )
        )

        seen: list[dict[str, Any]] = []

        async def consume() -> None:
            async for frame in service.events(gen):
                seen.append(json.loads(frame.decode().removeprefix("data: ").strip()))

        task = asyncio.create_task(consume())
        # 等到拿上第一个 delta —— 那之后取消才代表"生成到一半被停"
        for _ in range(200):
            if any(event["type"] == "delta" for event in seen):
                break
            await asyncio.sleep(0.005)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

        runs_path = Path(work["rootPath"]) / ".inkstone" / "ai" / "runs.jsonl"
        for _ in range(200):
            if runs_path.is_file():
                break
            await asyncio.sleep(0.005)

        record = json.loads(runs_path.read_text(encoding="utf-8").strip())
        assert record["stopped"] is True
        assert record["error"] is None
        assert record["egressChars"] > 0
        assert record["outputTokens"] > 0

    @pytest.mark.asyncio
    async def test_busy_slot_is_released_even_when_generation_is_cancelled(
        self, stack: Callable[..., Any], parent_dir: Path
    ) -> None:
        """一次被取消的生成不能把这一章**永久**锁死。"""
        registry, service = stack(_frames(_delta("一"), _delta("二")), gaps=[0.0, 30.0, 0.0])
        work = await registry.create(parent_dir=str(parent_dir), title="锁释放测试")
        chapters = await registry.list_chapters(work["id"])
        chapter_id = chapters[0]["id"]
        req = GenerationRequest(
            task="continue", work_id=work["id"], chapter_id=chapter_id, prefix="前文。"
        )

        gen = await service.prepare(req)

        async def consume() -> None:
            async for _ in service.events(gen):
                pass

        task = asyncio.create_task(consume())
        await asyncio.sleep(0.02)  # 让它跑到"等第二个分片"那里
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

        # 占位必须已经释放
        again = await service.prepare(req)
        assert again.run_id != gen.run_id


# ---------------------------------------------------------------------------
# 未预期的失败（`docs/13` M4）
# ---------------------------------------------------------------------------


class TestUnexpectedFailures:
    """**响应体里的任何异常都必须变成一帧 error。**

    这一族失败原先完全不可见：只有 `except DomainError` 一条分支，其它异常直接
    逃出生成器 —— 表现是"SSE 流突然断掉"，渲染进程既收不到 `done` 也收不到 `error`，
    只能报一句"协议错误"，与真正的原因毫无关联。更糟的是记录：`error_code` 保持
    `None`，于是这次"用户什么都没拿到"的生成在 `runs.jsonl` 里**看起来是成功的**。
    """

    @pytest.mark.asyncio
    async def test_unexpected_exception_still_produces_an_error_frame(
        self, stack: Callable[..., Any], parent_dir: Path
    ) -> None:
        """让 transport 在建立响应时就抛一个**非** `httpx.HTTPError` 的异常。

        `httpx.MockTransport` 不会把普通异常包成 `httpx.HTTPError`（它只映射
        socket 那一类），所以 `RuntimeError` 会原样穿出 `gateway.stream()` ——
        正是"没被归类"的那种失败。
        """

        def explode(_request: httpx.Request) -> httpx.Response:
            raise RuntimeError("模拟一个没被归类的实现 bug")

        registry, service = stack(handler=explode)
        work_id, chapter_id = await _new_work(registry, parent_dir, "兜底测试")
        req = GenerationRequest(
            task="continue", work_id=work_id, chapter_id=chapter_id, prefix="前文。"
        )
        prepared = await service.prepare(req)

        events = _parse_frames([frame async for frame in service.events(prepared)])

        # 修复点 ①：必须发一帧 error，而不是让流无声断掉
        assert events[-1]["type"] == "error"
        assert events[-1]["code"] == "INTERNAL"

        # 修复点 ②：记录里的 error 不能是 null。
        # 这是**审计**要求 —— `runs.jsonl` 说的"成功"必须真的成功。
        records = await RunStore(registry.work_paths(work_id)).read()
        assert records[-1].error == "INTERNAL"
        assert records[-1].stopped is True

    @pytest.mark.asyncio
    async def test_a_failing_record_write_does_not_replace_the_cancellation(
        self, stack: Callable[..., Any], parent_dir: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """`finally` 里写记录失败，**不能**替换掉正在传播的 `CancelledError`。

        Python 的语义：`finally` 块里抛出的异常会**替换**正在传播的那一个。
        而此刻在传播的可能是"用户点了停止"—— 被换成 `OSError` 之后，上游再也
        分不清"取消"与"磁盘故障"，取消链路断掉（`docs/13` M4）。

        构造：把 `_record` 换成一个必定失败的实现，再朝生成器 `athrow` 一个
        `CancelledError`，断言抛出来的**仍然是** `CancelledError`。
        """
        registry, service = stack(_frames(_delta("屋里")))
        work_id, chapter_id = await _new_work(registry, parent_dir, "记录失败测试")
        req = GenerationRequest(
            task="continue", work_id=work_id, chapter_id=chapter_id, prefix="前文。"
        )
        prepared = await service.prepare(req)

        async def boom(*_args: object, **_kwargs: object) -> None:
            raise OSError("模拟写记录时的磁盘故障")

        monkeypatch.setattr(service, "_record", boom)

        stream = service.events(prepared)
        await anext(stream)  # meta 帧：确认生成器确实跑起来了

        with pytest.raises(asyncio.CancelledError):
            await stream.athrow(asyncio.CancelledError())
