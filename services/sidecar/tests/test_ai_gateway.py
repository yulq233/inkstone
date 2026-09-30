"""AI 状态快照与模型网关（`docs/11` §4.3 / §3.4）。

这两块都不需要起 HTTP 服务，所以直接断言异常类型与错误码 ——
比走接口再看 500 字符的报文精确得多，也不会因为 FastAPI 的序列化而失真。

**本文件最重要的两条用例**（P0 验收，`docs/11` §7.2）：

1. 上游 401 必须报 `AI_AUTH_FAILED` 而**不是** `UNAUTHORIZED`
   —— 后者会让渲染进程以为本地 token 失效，把整个界面推进 FAILED（`errors.py` 有理由）。
2. 纯本地模式必须在**网关**拦住云端供应商。这条用"直接调网关"来验，
   而不是"从界面点按钮走一遍" —— 那样只能证明界面灰掉了按钮，
   证明不了开关真的生效（以后新加的每条调用路径都会绕过界面）。
"""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping

import httpx
import pytest

from inkstone.ai.gateway import ChatRequest, ModelGateway
from inkstone.ai.state import AiState, ProviderConfig, RouteTarget
from inkstone.errors import DomainError
from inkstone.logging import REDACTED, scrub

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


def _state(
    *providers: ProviderConfig,
    credentials: Mapping[str, str] | None = None,
    offline_only: bool = False,
) -> AiState:
    state = AiState()
    # P1 起 `apply()` 要求八项齐全：漏给默认模型 / 风格卡 / 日预算的话，
    # 症状分别是"生成报未配置""风格卡不生效""预算永不拦截"，全是静默失效 ——
    # 所以这三个参数没有默认值，这里显式给出来。
    state.apply(
        providers=providers,
        credentials=credentials if credentials is not None else {},
        offline_only=offline_only,
        routing={},
        default_provider_id=None,
        default_model="",
        style_card="",
        daily_budget_cny=0.0,
    )
    return state


def _ok_chat(content: str = "你好，我是模型。") -> httpx.Response:
    return httpx.Response(
        200,
        json={"choices": [{"message": {"role": "assistant", "content": content}}]},
    )


def _gateway(
    state: AiState,
    handler: Callable[[httpx.Request], httpx.Response],
    *,
    connect_timeout: float = 8.0,
    read_timeout: float = 30.0,
) -> tuple[ModelGateway, list[httpx.Request]]:
    """返回网关与"收到过的请求"列表。

    断言"发去了哪个 URL / 带没带 Authorization"必须看**实际请求**，
    不能只看网关内部字段 —— 那是把实现抄一遍当断言。
    """
    seen: list[httpx.Request] = []

    def record(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    gateway = ModelGateway(
        state,
        connect_timeout=connect_timeout,
        read_timeout=read_timeout,
        transport=httpx.MockTransport(record),
    )
    return gateway, seen


# ---------------------------------------------------------------------------
# AiState
# ---------------------------------------------------------------------------


def test_apply_replaces_the_whole_snapshot_and_bumps_revision() -> None:
    state = _state(CLOUD)
    assert state.revision == 1

    state.apply(
        providers=[LOCAL],
        credentials={"ollama": "不需要但这个字段会被收下"},
        offline_only=True,
        routing={"continue": RouteTarget(provider_id="ollama", model="qwen3:8b")},
        default_provider_id="ollama",
        default_model="qwen3:8b",
        style_card="",
        daily_budget_cny=0.0,
    )

    assert state.revision == 2
    # 整体替换：旧的 provider 不该残留（残留会让"删掉的供应商"仍然可被选中）
    assert set(state.providers) == {"ollama"}
    assert state.offline_only is True
    assert state.default_provider_id == "ollama"


def test_apply_prunes_credentials_routing_and_default_of_removed_providers() -> None:
    """删掉一个供应商之后，它的 Key 不该继续留在内存里。"""
    state = _state(CLOUD, LOCAL)
    state.apply(
        providers=[CLOUD, LOCAL],
        credentials={"deepseek": "sk-abcdefghijklmn", "ollama": ""},
        offline_only=False,
        routing={
            "continue": RouteTarget(provider_id="deepseek", model="deepseek-chat"),
            "quick": RouteTarget(provider_id="ollama", model="qwen3:8b"),
            "rewrite": None,
        },
        default_provider_id="deepseek",
        default_model="deepseek-chat",
        style_card="",
        daily_budget_cny=0.0,
    )
    assert state.credentials == {"deepseek": "sk-abcdefghijklmn"}

    # 只留 ollama
    state.apply(
        providers=[LOCAL],
        credentials={"deepseek": "sk-abcdefghijklmn"},
        offline_only=False,
        routing={"continue": RouteTarget(provider_id="deepseek", model="deepseek-chat")},
        default_provider_id="deepseek",
        default_model="deepseek-chat",
        style_card="",
        daily_budget_cny=0.0,
    )

    assert state.credentials == {}  # Key 随 provider 一起走
    assert state.routing == {}  # 指向已删供应商的分模型项被清掉
    assert state.default_provider_id is None
    # 空的凭据值不收（Ollama 会被推成 ""，收下会让 credential() 返回假值）
    assert state.credential("ollama") is None


def test_apply_registers_credentials_for_value_based_scrubbing() -> None:
    """Key 被某个库拼进异常消息时，日志里也只能看到 ***。"""
    secret = "sk-verysecretvalue123"
    state = _state(CLOUD)
    assert scrub(f"Authorization: Bearer {secret}") == f"Authorization: Bearer {secret}"

    state.apply(
        providers=[CLOUD],
        credentials={"deepseek": secret},
        offline_only=False,
        routing={},
        default_provider_id=None,
        default_model="",
        style_card="",
        daily_budget_cny=0.0,
    )

    assert scrub(f"Authorization: Bearer {secret}") == f"Authorization: Bearer {REDACTED}"


def test_provider_lookup_error_points_at_resaving_not_at_never_filling() -> None:
    """走到这里最常见的原因是主进程还没推上来，文案必须指向"再保存一次"。"""
    state = _state(CLOUD)
    with pytest.raises(DomainError) as excinfo:
        state.provider("ollama")

    assert excinfo.value.code == "AI_NOT_CONFIGURED"
    assert "保存一次" in excinfo.value.message


def test_provider_list_never_exposes_credential_information() -> None:
    """凭据真源在主进程（`ai-types.ts` 文件头）。回一个 hasCredential 就会造出第二个真源。"""
    state = _state(CLOUD, LOCAL)

    items = state.provider_list()

    assert [item["id"] for item in items] == ["deepseek", "ollama"]
    for item in items:
        assert set(item) == {"id", "kind", "label", "baseUrl", "local", "needsKey"}
    assert "credential" not in json.dumps(items, ensure_ascii=False).lower()


# ---------------------------------------------------------------------------
# 拦截点：纯本地模式（docs/01 §9.3）
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_offline_only_blocks_cloud_provider_at_the_gateway() -> None:
    """**P0 验收**：直接调网关（不走界面）也必须被拦下。"""
    state = _state(CLOUD, offline_only=True)
    gateway, seen = _gateway(state, lambda request: _ok_chat())

    with pytest.raises(DomainError) as excinfo:
        await gateway.test(CLOUD, "deepseek-chat")

    assert excinfo.value.code == "AI_OFFLINE_ONLY"
    # 拦在发包之前 —— 否则"拦截"只是"发了之后把结果丢掉"
    assert seen == []


@pytest.mark.asyncio
async def test_offline_only_blocks_list_models_too() -> None:
    """列模型也是外发请求（地址会暴露你用了哪家）。不能只在生成路径上拦。"""
    state = _state(CLOUD, offline_only=True)
    gateway, seen = _gateway(state, lambda request: httpx.Response(200, json={"data": []}))

    with pytest.raises(DomainError) as excinfo:
        await gateway.list_models(CLOUD)

    assert excinfo.value.code == "AI_OFFLINE_ONLY"
    assert seen == []


@pytest.mark.asyncio
async def test_offline_only_still_allows_local_provider() -> None:
    state = _state(LOCAL, offline_only=True)
    gateway, seen = _gateway(state, lambda request: _ok_chat("好的"))

    result = await gateway.test(LOCAL, "qwen3:8b")

    assert result.echo == "好的"
    assert len(seen) == 1


@pytest.mark.asyncio
async def test_offline_only_is_checked_before_credential_missing() -> None:
    """顺序有意义：云端且没 Key 时报的是"被纯本地模式拦下"，
    因为关掉那个开关之前，填 Key 也解决不了问题。"""
    state = _state(CLOUD, offline_only=True)
    gateway, _ = _gateway(state, lambda request: _ok_chat())

    with pytest.raises(DomainError) as excinfo:
        await gateway.test(CLOUD, "deepseek-chat")

    assert excinfo.value.code == "AI_OFFLINE_ONLY"


# ---------------------------------------------------------------------------
# 凭据缺失
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_missing_credential_fails_without_sending_anything() -> None:
    state = _state(CLOUD)
    gateway, seen = _gateway(state, lambda request: _ok_chat())

    with pytest.raises(DomainError) as excinfo:
        await gateway.test(CLOUD, "deepseek-chat")

    assert excinfo.value.code == "AI_CREDENTIAL_MISSING"
    assert "重新保存" in excinfo.value.message
    assert seen == []


@pytest.mark.asyncio
async def test_local_provider_sends_no_authorization_header() -> None:
    """Ollama 的 needs_key 是 false：带上 `Bearer ` 会让它 400。"""
    state = _state(LOCAL)
    gateway, seen = _gateway(state, lambda request: _ok_chat())

    await gateway.test(LOCAL, "qwen3:8b")

    assert "Authorization" not in seen[0].headers


# ---------------------------------------------------------------------------
# 错误码映射
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_upstream_401_maps_to_ai_auth_failed_not_unauthorized() -> None:
    """**P0 验收**：必须是 AI_AUTH_FAILED。

    若复用 UNAUTHORIZED，渲染进程的 `ApiError.isUnauthorized` 会把整个界面
    推进 FAILED —— 用户只是 Key 填错了，却看到"本地服务连接失败"。
    """
    state = _state(CLOUD, credentials={"deepseek": "sk-wrongwrongwrong"})
    gateway, _ = _gateway(state, lambda request: httpx.Response(401, text="invalid api key"))

    with pytest.raises(DomainError) as excinfo:
        await gateway.test(CLOUD, "deepseek-chat")

    assert excinfo.value.code == "AI_AUTH_FAILED"
    assert excinfo.value.status_code == 401
    assert excinfo.value.detail["upstreamStatus"] == 401


@pytest.mark.asyncio
async def test_upstream_403_also_maps_to_ai_auth_failed() -> None:
    state = _state(CLOUD, credentials={"deepseek": "sk-whatevervalue"})
    gateway, _ = _gateway(state, lambda request: httpx.Response(403, text="forbidden"))

    with pytest.raises(DomainError) as excinfo:
        await gateway.test(CLOUD, "deepseek-chat")

    assert excinfo.value.code == "AI_AUTH_FAILED"


@pytest.mark.asyncio
async def test_upstream_429_maps_to_rate_limited() -> None:
    state = _state(CLOUD, credentials={"deepseek": "sk-whatevervalue"})
    gateway, _ = _gateway(state, lambda request: httpx.Response(429, text="too many requests"))

    with pytest.raises(DomainError) as excinfo:
        await gateway.test(CLOUD, "deepseek-chat")

    assert excinfo.value.code == "AI_RATE_LIMITED"


@pytest.mark.asyncio
async def test_upstream_413_maps_to_context_too_long() -> None:
    state = _state(CLOUD, credentials={"deepseek": "sk-whatevervalue"})
    gateway, _ = _gateway(state, lambda request: httpx.Response(413, text="payload too large"))

    with pytest.raises(DomainError) as excinfo:
        await gateway.test(CLOUD, "deepseek-chat")

    assert excinfo.value.code == "AI_CONTEXT_TOO_LONG"


@pytest.mark.asyncio
async def test_context_overflow_reported_as_400_is_still_recognised() -> None:
    """上游报上下文超长常常是 400 而不是 413，只能靠报文认。

    单独成码的价值：界面能直接提示"缩短选区"，而不是让用户去猜 400 是什么。
    """
    body = {"error": {"message": "This model's maximum context length is 8192 tokens."}}
    state = _state(CLOUD, credentials={"deepseek": "sk-whatevervalue"})
    gateway, _ = _gateway(state, lambda request: httpx.Response(400, json=body))

    with pytest.raises(DomainError) as excinfo:
        await gateway.test(CLOUD, "deepseek-chat")

    assert excinfo.value.code == "AI_CONTEXT_TOO_LONG"


@pytest.mark.asyncio
async def test_other_4xx_maps_to_upstream_error_with_status() -> None:
    state = _state(CLOUD, credentials={"deepseek": "sk-whatevervalue"})
    gateway, _ = _gateway(
        state, lambda request: httpx.Response(400, json={"error": {"message": "model not found"}})
    )

    with pytest.raises(DomainError) as excinfo:
        await gateway.test(CLOUD, "deepsek-chat")

    assert excinfo.value.code == "AI_UPSTREAM_ERROR"
    assert excinfo.value.detail["upstreamStatus"] == 400
    # 上游报文要进错误信息（截断后），否则"model not found"这种关键线索就丢了
    assert "model not found" in excinfo.value.detail["reason"]


@pytest.mark.asyncio
async def test_upstream_500_maps_to_upstream_error() -> None:
    state = _state(CLOUD, credentials={"deepseek": "sk-whatevervalue"})
    gateway, _ = _gateway(state, lambda request: httpx.Response(500, text="internal"))

    with pytest.raises(DomainError) as excinfo:
        await gateway.test(CLOUD, "deepseek-chat")

    assert excinfo.value.code == "AI_UPSTREAM_ERROR"
    assert excinfo.value.status_code == 502


@pytest.mark.asyncio
async def test_timeout_and_connection_failure_are_distinguished() -> None:
    """连不上与超时要分开：前者该查地址/网络，后者该换模型或重试。

    混成一个码的话，界面只能给一句"失败了"，用户无从下手。
    """
    state = _state(CLOUD, credentials={"deepseek": "sk-whatevervalue"})

    def boom(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("read timed out", request=request)

    gateway, _ = _gateway(state, boom)
    with pytest.raises(DomainError) as excinfo:
        await gateway.test(CLOUD, "deepseek-chat")
    assert excinfo.value.code == "AI_TIMEOUT"

    def unreachable(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    gateway, _ = _gateway(state, unreachable)
    with pytest.raises(DomainError) as excinfo:
        await gateway.test(CLOUD, "deepseek-chat")
    assert excinfo.value.code == "AI_UPSTREAM_ERROR"
    assert "网络" in excinfo.value.detail["reason"]


@pytest.mark.asyncio
async def test_non_json_body_maps_to_upstream_error_with_hint() -> None:
    """用户把首页地址填进 baseUrl 时就是这个症状 —— 提示要指向"地址不对"。"""
    state = _state(CLOUD, credentials={"deepseek": "sk-whatevervalue"})
    gateway, _ = _gateway(state, lambda request: httpx.Response(200, text="<html>首页</html>"))

    with pytest.raises(DomainError) as excinfo:
        await gateway.test(CLOUD, "deepseek-chat")

    assert excinfo.value.code == "AI_UPSTREAM_ERROR"
    assert "不是模型服务" in excinfo.value.detail["reason"]


@pytest.mark.asyncio
async def test_200_without_choices_says_the_address_is_not_openai_compatible() -> None:
    """200 但结构不认识：多半是把别的服务当成了聊天接口。"""
    state = _state(CLOUD, credentials={"deepseek": "sk-whatevervalue"})
    gateway, _ = _gateway(state, lambda request: httpx.Response(200, json={"result": "ok"}))

    with pytest.raises(DomainError) as excinfo:
        await gateway.test(CLOUD, "deepseek-chat")

    assert excinfo.value.code == "AI_UPSTREAM_ERROR"
    assert "OpenAI" in excinfo.value.detail["reason"]


# ---------------------------------------------------------------------------
# URL 与请求体
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_openai_compatible_urls_strip_trailing_slash() -> None:
    provider = ProviderConfig(
        id="custom",
        kind="openai-compatible",
        label="自建",
        base_url="https://llm.example.com/proxy/v1/",  # 用户手打的末尾斜杠
        local=False,
        needs_key=True,
    )
    state = _state(provider, credentials={"custom": "sk-whatevervalue"})
    gateway, seen = _gateway(state, lambda request: httpx.Response(200, json={"data": []}))

    await gateway.list_models(provider)

    assert str(seen[0].url) == "https://llm.example.com/proxy/v1/models"


@pytest.mark.asyncio
async def test_ollama_uses_native_tags_endpoint_for_listing() -> None:
    """`/v1/models` 在旧版 Ollama 上不存在，而 `/api/tags` 多年来一直稳定。"""
    state = _state(LOCAL)
    body = {"models": [{"name": "qwen3:8b"}, {"name": "llama3.1:8b"}]}
    gateway, seen = _gateway(state, lambda request: httpx.Response(200, json=body))

    specs = await gateway.list_models(LOCAL)

    assert str(seen[0].url) == "http://127.0.0.1:11434/api/tags"
    assert [spec.id for spec in specs] == ["llama3.1:8b", "qwen3:8b"]  # 排序保证下拉框稳定


@pytest.mark.asyncio
async def test_ollama_chat_uses_openai_compatible_endpoint() -> None:
    """聊天一律走兼容接口：少一套请求体与响应体的解析，出错面小一半。"""
    state = _state(LOCAL)
    gateway, seen = _gateway(state, lambda request: _ok_chat())

    await gateway.test(LOCAL, "qwen3:8b")

    assert str(seen[0].url) == "http://127.0.0.1:11434/v1/chat/completions"


@pytest.mark.asyncio
async def test_test_request_body_is_minimal_and_non_streaming() -> None:
    """`max_tokens: 16` 是为了不把预算花在推理上；`stream: false` 是 P0 还没做流式。"""
    state = _state(LOCAL)
    gateway, seen = _gateway(state, lambda request: _ok_chat())

    await gateway.test(LOCAL, "qwen3:8b")

    body = json.loads(seen[0].content)
    assert body["model"] == "qwen3:8b"
    assert body["max_tokens"] == 16
    assert body["stream"] is False
    assert body["temperature"] == 0
    assert body["messages"] == [{"role": "user", "content": "你好"}]


@pytest.mark.asyncio
async def test_test_result_truncates_echo_and_reports_latency() -> None:
    state = _state(LOCAL)
    gateway, _ = _gateway(state, lambda request: _ok_chat("一二三四五六七八九十" * 10))

    result = await gateway.test(LOCAL, "qwen3:8b")

    assert len(result.echo) == 40
    assert result.model == "qwen3:8b"
    assert result.latency_ms >= 0


@pytest.mark.asyncio
async def test_reasoning_content_is_used_when_content_is_empty() -> None:
    """推理型模型会把预算花在思考上，`content` 可能是空而 `reasoning_content` 有字。

    这时**不算失败**：用户要的正是"这个模型能连通"。
    """
    state = _state(LOCAL)
    payload = {"choices": [{"message": {"content": "", "reasoning_content": "让我想想……"}}]}
    gateway, _ = _gateway(state, lambda request: httpx.Response(200, json=payload))

    result = await gateway.test(LOCAL, "qwq:32b")

    assert result.echo == "让我想想……"


@pytest.mark.asyncio
async def test_empty_content_with_correct_shape_is_not_an_error() -> None:
    state = _state(LOCAL)
    payload = {"choices": [{"message": {"role": "assistant", "content": ""}}]}
    gateway, _ = _gateway(state, lambda request: httpx.Response(200, json=payload))

    result = await gateway.test(LOCAL, "qwen3:8b")

    assert result.echo == ""


@pytest.mark.asyncio
async def test_model_list_with_unexpected_shape_names_the_missing_field() -> None:
    state = _state(CLOUD, credentials={"deepseek": "sk-whatevervalue"})
    gateway, _ = _gateway(state, lambda request: httpx.Response(200, json={"models": []}))

    with pytest.raises(DomainError) as excinfo:
        await gateway.list_models(CLOUD)

    assert excinfo.value.code == "AI_UPSTREAM_ERROR"
    assert "id" in excinfo.value.detail["reason"]


@pytest.mark.asyncio
async def test_model_list_skips_entries_without_a_name() -> None:
    """上游偶发返回脏条目（缺 name / name 不是字符串）—— 整段失败不如跳过。"""
    state = _state(LOCAL)
    body = {"models": [{"name": "qwen3:8b"}, {"size": 1}, {"name": ""}, "raw-string"]}
    gateway, _ = _gateway(state, lambda request: httpx.Response(200, json=body))

    specs = await gateway.list_models(LOCAL)

    assert [spec.id for spec in specs] == ["qwen3:8b"]


@pytest.mark.asyncio
async def test_authorization_header_carries_the_bearer_prefix() -> None:
    secret = "sk-bearerprefixvalue"
    state = _state(CLOUD, credentials={"deepseek": secret})
    gateway, seen = _gateway(state, lambda request: _ok_chat())

    await gateway.test(CLOUD, "deepseek-chat")

    assert seen[0].headers["Authorization"] == f"Bearer {secret}"


# ---------------------------------------------------------------------------
# 3xx 与 InvalidURL（`docs/13` M3）
# ---------------------------------------------------------------------------


def _chat_request() -> ChatRequest:
    return ChatRequest(
        model="deepseek-chat",
        system="你是一位中文小说写作助手。",
        user="继续写下一段。",
        temperature=0.8,
        max_tokens=64,
    )


def test_invalid_url_is_not_an_httpx_httperror() -> None:
    """把 `_HTTPX_ERRORS` 里为什么必须**单独列出** `InvalidURL` 这个前提钉住。

    `InvalidURL` 直接继承 `Exception`，**不是** `httpx.HTTPError` 的子类，
    所以 `except httpx.HTTPError` 接不住它（`docs/13` M3）。

    这条断言的是**上游库的行为**，看起来不像产品测试。留着是因为整个修复就建立在
    它之上，而别处体现不出来：httpx 若改掉这个继承关系，这里会红 —— 那时
    `_HTTPX_ERRORS` 里的 `InvalidURL` 变成冗余（不是错误），可以顺手清掉。
    """
    assert not issubclass(httpx.InvalidURL, httpx.HTTPError)


@pytest.mark.asyncio
async def test_invalid_url_is_mapped_to_a_readable_config_error() -> None:
    """地址不合法要给"去改设置"，而不是一个 500（`docs/13` M3）。

    `http://[::1]:not-a-port/v1` 会在 httpx 解析端口时抛 `InvalidURL`。
    修复前它从三处 `except httpx.HTTPError` 漏出去 → 一路逃到 FastAPI → 500，
    而它其实是**用户能自己修**的配置错误。

    `test()` 走的是 `_post_json`（非流式），覆盖的是那一条 except；
    流式那条由下面 3xx 的两个用例连带覆盖（同一个 `_HTTPX_ERRORS`）。
    """
    provider = ProviderConfig(
        id="broken",
        kind="openai-compatible",
        label="填错的地址",
        base_url="http://[::1]:not-a-port/v1",
        local=False,
        needs_key=False,
    )
    gateway, _seen = _gateway(_state(provider), lambda _request: httpx.Response(200))

    with pytest.raises(DomainError) as info:
        await gateway.test(provider, "qwen3:8b")

    assert info.value.code == "AI_UPSTREAM_ERROR"
    assert "不是合法的 URL" in info.value.message
    # 上游给的细节要带上：`Invalid port: 'not-a-port'` 直接告诉用户错在哪一段
    assert "not-a-port" in info.value.message


@pytest.mark.asyncio
async def test_redirect_on_the_streaming_path_is_rejected_not_a_silent_empty_success() -> None:
    """3xx 在**流式**路径上必须报错 —— 否则是静默的空成功（`docs/13` M3）。

    httpx 默认 `follow_redirects=False`，我们刻意不改（跟随会把
    `Authorization: Bearer <key>` 发到重定向目标去）。但不跟随就必须自己判错：
    修复前的判断是 `>= 400`，3xx 被放过，于是拿到的是重定向页的 body ——
    它一行 `data:` 都没有 → `_iter_chunks` 走完空循环 → 发出 `StreamDone("stop")`。

    后果是：界面显示"生成完成"、正文一个字都没有，而 `runs.jsonl` 里也是一次成功。
    """
    gateway, _seen = _gateway(
        _state(CLOUD, credentials={"deepseek": "sk-redirect-case"}),
        lambda _request: httpx.Response(
            302,
            headers={"location": "https://example.com/login"},
            text="<html>moved</html>",
        ),
    )

    with pytest.raises(DomainError) as info:
        async for _chunk in gateway.stream(CLOUD, _chat_request()):
            pass

    assert info.value.code == "AI_UPSTREAM_ERROR"
    assert "重定向" in info.value.message
    # 带上 Location：用户才知道请求被送到哪儿去了
    assert "example.com" in info.value.message


@pytest.mark.asyncio
async def test_redirect_is_rejected_on_the_non_streaming_path_too() -> None:
    """非流式路径同样把 3xx 判错，且提示里带 `Location`。

    非流式在修复前也不会"空成功"（`_as_object` 解析重定向页会失败），
    但它给的提示是"这个地址可能不是模型服务" —— 不如直接说"被重定向了"精确。
    两条路径共用 `_error_for_status`，所以这里同时是那条共用逻辑的回归网。
    """
    gateway, _seen = _gateway(
        _state(CLOUD, credentials={"deepseek": "sk-redirect-case"}),
        lambda _request: httpx.Response(
            301, headers={"location": "https://example.com/v2"}, text=""
        ),
    )

    with pytest.raises(DomainError) as info:
        await gateway.test(CLOUD, "deepseek-chat")

    assert info.value.code == "AI_UPSTREAM_ERROR"
    assert "重定向" in info.value.message
    assert "https://example.com/v2" in info.value.message
