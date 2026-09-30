"""`POST /ai/preview` —— 「**将发送什么**」（`docs/11` §6.4 / §6.7）。

## 这一份在防什么

预览端点是 §2.3 那条知情要求的落点，而它有三类**只会静默出错**的地方：

1. **它偷偷发了请求**。预览一旦真的调了上游，用户点开"看一眼"就产生了一次计费
   与一次真实外发 —— 而这与"看一眼再决定"的承诺正好相反。
2. **它落了记录**。`runs.jsonl` 记的是**外发**（`ai/service.py` 模块头有理由）。
   写进去的话，外发审计会多出用户从未发送过的条目，审计本身就不可信了。
3. **`needsConfirm` 判错**。漏判"本机"会让 Ollama 用户每次都看到一张不必要的确认卡；
   漏判"已确认"是**每次生成都弹**；漏判"纯本地模式"是让用户先确认再被拒一次。
   三个方向都不能靠肉眼回归 —— 它们只在特定的配置组合下出现。

## 断言口径

- "没发请求"用 `MockTransport` 的 handler 里记数，而不是"没有报错"：
  上游失败会被网关照常翻译成 `DomainError`，静默地发出去也能通过"没报错"。
- "没落记录"走 `GET /ai/runs`，不直接读文件 —— 路径拼接是另一件事，
  混进来会让这条用例在文件布局变化时假红。
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from typing import cast

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from inkstone.ai.service import GenerationService
from inkstone.ai.state import AiState, ProviderConfig
from inkstone.app import create_app
from inkstone.config import Settings

Handler = Callable[[httpx.Request], httpx.Response]

CLOUD_PROVIDER = {
    "id": "deepseek",
    "kind": "openai-compatible",
    "label": "DeepSeek",
    "baseUrl": "https://api.deepseek.com/v1",
    "local": False,
    "needsKey": True,
}

LOCAL_PROVIDER = {
    "id": "ollama",
    "kind": "ollama",
    "label": "Ollama（本机）",
    "baseUrl": "http://127.0.0.1:11434",
    "local": True,
    "needsKey": False,
}

SECRET = "sk-previewtestsecret"


def _chat_ok(content: str = "你好") -> httpx.Response:
    return httpx.Response(200, json={"choices": [{"message": {"content": content}}]})


@pytest.fixture()
def calls() -> list[httpx.Request]:
    """所有真正到达 transport 的请求。**空列表 = 一个字节都没出网。**"""
    return []


@pytest.fixture()
def make_client(
    settings: Settings, work: dict, auth_headers: dict[str, str], calls: list[httpx.Request]
) -> Iterator[Callable[..., TestClient]]:
    """按需构造客户端，并**把已有作品打开**。

    预览要真实装配，就需要仓储里真的登记着这个作品 ——
    少了 `POST /works/open` 这一步，所有用例都会以 `WORK_NOT_FOUND` 失败。
    """

    def build(handler: Handler | None = None) -> TestClient:
        def record(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            if handler is None:  # pragma: no cover - 兜底：预览本就该一个请求都不发
                raise AssertionError(f"预览不该发出请求：{request.method} {request.url}")
            return handler(request)

        client = TestClient(create_app(settings, ai_transport=httpx.MockTransport(record)))
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
    providers: list[dict[str, object]] | None = None,
    offline_only: bool = False,
    default_provider_id: str | None = "deepseek",
    default_model: str = "deepseek-chat",
    style_card: str = "",
    acknowledged_egress_providers: list[str] | None = None,
) -> None:
    res = client.put(
        "/api/v1/ai/config",
        headers=headers,
        json={
            "providers": providers if providers is not None else [CLOUD_PROVIDER],
            "credentials": {"deepseek": SECRET},
            "offlineOnly": offline_only,
            "routing": {},
            "defaultProviderId": default_provider_id,
            "defaultModel": default_model,
            "styleCard": style_card,
            "dailyBudgetCny": 0,
            "acknowledgedEgressProviders": acknowledged_egress_providers or [],
        },
    )
    assert res.status_code == 200, res.text


def _chapter_id(client: TestClient, headers: dict[str, str], work: dict) -> str:
    res = client.get(f"/api/v1/works/{work['id']}/chapters", headers=headers)
    assert res.status_code == 200, res.text
    return str(res.json()["items"][0]["id"])


def _preview_body(work: dict, chapter_id: str, **overrides: object) -> dict[str, object]:
    body: dict[str, object] = {
        "workId": work["id"],
        "chapterId": chapter_id,
        "prefix": "他推开门。",
        "suffix": "",
        "intent": "",
    }
    body.update(overrides)
    return body


# ---------------------------------------------------------------------------
# 鉴权
# ---------------------------------------------------------------------------


def test_preview_requires_token(make_client: Callable[..., TestClient], work: dict) -> None:
    """与另外几条 AI 端点同一条中间件，**没有豁免口子**。"""
    with make_client() as client:
        res = client.post("/api/v1/ai/preview", json={"workId": work["id"], "chapterId": "x",
                                                       "prefix": ""})

    assert res.status_code == 401


# ---------------------------------------------------------------------------
# 三件"不做"的事
# ---------------------------------------------------------------------------


def test_preview_sends_nothing_to_the_upstream(
    make_client: Callable[..., TestClient],
    auth_headers: dict[str, str],
    work: dict,
    calls: list[httpx.Request],
) -> None:
    """**一个字节都不出网**。真的发出去的话，"先看一眼再决定"这个承诺就不成立了 ——
    而且用户点开预览的每一次都会产生计费。"""
    with make_client() as client:
        _push(client, auth_headers)
        chapter_id = _chapter_id(client, auth_headers, work)
        res = client.post(
            "/api/v1/ai/preview", headers=auth_headers, json=_preview_body(work, chapter_id)
        )

    assert res.status_code == 200, res.text
    assert calls == []


def test_preview_writes_no_run_record(
    make_client: Callable[..., TestClient], auth_headers: dict[str, str], work: dict
) -> None:
    """`runs.jsonl` 同时是**外发审计**。预览没外发，就不该在里面留下一条 ——
    否则审计数据里会混进用户从未发送过的条目，整份记录的可信度就没了。"""
    with make_client() as client:
        _push(client, auth_headers)
        chapter_id = _chapter_id(client, auth_headers, work)
        previewed = client.post(
            "/api/v1/ai/preview", headers=auth_headers, json=_preview_body(work, chapter_id)
        )
        runs = client.get(f"/api/v1/ai/runs?workId={work['id']}", headers=auth_headers)

    assert previewed.status_code == 200, previewed.text
    assert runs.status_code == 200, runs.text
    assert runs.json()["items"] == []


def test_preview_is_not_blocked_by_a_generation_in_flight(
    make_client: Callable[..., TestClient], auth_headers: dict[str, str], work: dict
) -> None:
    """预览**不占并发位**，也不被并发位挡住。

    这一条只能靠"手工把那把占位键塞进去"来测：`TestClient` 会把响应体缓冲完才返回，
    进不去"第一路还挂着"的那个窗口（`test_ai_stream.py` 的 `stack` 夹具注释有说明）。
    于是两半都断言 —— 同一次占位下 `/ai/continue` 必须是 409（证明塞的是对的那把键），
    而 `/ai/preview` 必须是 200。
    """
    with make_client(_chat_ok) as client:
        _push(client, auth_headers)
        chapter_id = _chapter_id(client, auth_headers, work)
        body = _preview_body(work, chapter_id)

        # 造一个"这一章正在生成"的状态：键与 `GenerationService.prepare()` 用的那个一致。
        # `TestClient.app` 在 starlette 里只声明成 ASGI 应用，拿 `state` 要 cast 一次。
        app = cast(FastAPI, client.app)
        service = cast(GenerationService, app.state.ai_service)
        service._busy.add(f"{work['id']}:{chapter_id}")

        busy = client.post("/api/v1/ai/continue", headers=auth_headers, json=body)
        previewed = client.post("/api/v1/ai/preview", headers=auth_headers, json=body)

    assert busy.status_code == 409, busy.text
    assert previewed.status_code == 200, previewed.text


# ---------------------------------------------------------------------------
# needsConfirm 的四种组合
# ---------------------------------------------------------------------------


def test_preview_asks_before_the_first_egress_to_a_cloud_provider(
    make_client: Callable[..., TestClient], auth_headers: dict[str, str], work: dict
) -> None:
    """`docs/11` §2.3：首次启用某个**非本机**供应商时必须弹一次。"""
    with make_client() as client:
        _push(client, auth_headers)
        chapter_id = _chapter_id(client, auth_headers, work)
        res = client.post(
            "/api/v1/ai/preview", headers=auth_headers, json=_preview_body(work, chapter_id)
        )

    payload = res.json()
    assert payload["needsConfirm"] is True
    assert payload["local"] is False
    assert payload["offlineBlocked"] is False
    assert payload["providerId"] == "deepseek"
    assert payload["providerLabel"] == "DeepSeek"


def test_preview_does_not_ask_again_once_the_provider_was_acknowledged(
    make_client: Callable[..., TestClient], auth_headers: dict[str, str], work: dict
) -> None:
    """确认过就不该再弹 —— 否则这条安全提示会退化成每次都拦一下的噪声。"""
    with make_client() as client:
        _push(client, auth_headers, acknowledged_egress_providers=["deepseek"])
        chapter_id = _chapter_id(client, auth_headers, work)
        res = client.post(
            "/api/v1/ai/preview", headers=auth_headers, json=_preview_body(work, chapter_id)
        )

    assert res.json()["needsConfirm"] is False
    assert res.json()["local"] is False


def test_preview_never_asks_for_a_local_provider(
    make_client: Callable[..., TestClient], auth_headers: dict[str, str], work: dict
) -> None:
    """Ollama 这类 `local: true` 的项**不弹**（§2.3），并且要能被界面标成
    「本机模型·不外传」—— 所以 `local` 这个字段本身也要对。"""
    with make_client() as client:
        _push(
            client,
            auth_headers,
            providers=[LOCAL_PROVIDER],
            default_provider_id="ollama",
            default_model="qwen3:8b",
            acknowledged_egress_providers=[],
        )
        chapter_id = _chapter_id(client, auth_headers, work)
        res = client.post(
            "/api/v1/ai/preview", headers=auth_headers, json=_preview_body(work, chapter_id)
        )

    payload = res.json()
    assert payload["local"] is True
    assert payload["needsConfirm"] is False
    assert payload["providerId"] == "ollama"


def test_preview_skips_the_confirm_card_when_offline_only_would_reject_anyway(
    make_client: Callable[..., TestClient], auth_headers: dict[str, str], work: dict
) -> None:
    """纯本地模式开着时**不要弹卡**：用户确认完仍会被网关拒掉，
    那时才看到"已开启纯本地模式"—— 那次确认是纯浪费。
    `offlineBlocked` 单独回给界面，正是为了让它放行、交给真正的生成去报错。"""
    with make_client() as client:
        _push(client, auth_headers, offline_only=True)
        chapter_id = _chapter_id(client, auth_headers, work)
        res = client.post(
            "/api/v1/ai/preview", headers=auth_headers, json=_preview_body(work, chapter_id)
        )

    payload = res.json()
    assert payload["offlineBlocked"] is True
    assert payload["needsConfirm"] is False


# ---------------------------------------------------------------------------
# 内容是不是"真的那一份"
# ---------------------------------------------------------------------------


def test_preview_returns_the_real_payload(
    make_client: Callable[..., TestClient], auth_headers: dict[str, str], work: dict
) -> None:
    """预览的全部价值在于"这就是要发出去的那一份"。

    所以逐项对齐到装配器的产出：风格卡进了系统指令、分块带着槽位与层级、
    外发字符数与 `AiRun.egressChars` **同口径**（`len(system) + len(user)`）。
    口径一旦漂移，用户会看到"预览说 320 字、外发记录说 480 字"——
    而那时没法判断哪个是真的。
    """
    with make_client() as client:
        _push(client, auth_headers, style_card="冷峻克制，短句为主。")
        chapter_id = _chapter_id(client, auth_headers, work)
        res = client.post(
            "/api/v1/ai/preview", headers=auth_headers, json=_preview_body(work, chapter_id)
        )

    payload = res.json()
    assert res.status_code == 200, res.text
    # 路由解析的结果（预览与生成用的是同一次 resolve_route）
    assert payload["model"] == "deepseek-chat"
    assert payload["templateId"] == "continue"
    assert payload["templateVersion"] == 1
    # 系统指令含风格卡
    assert "冷峻克制" in payload["system"]
    # "内容去了哪里"是这张卡要回答的核心问题，所以地址要真的对
    assert payload["providerBaseUrl"] == "https://api.deepseek.com/v1"
    # 前文那块：槽位 / 标题 / 层级 / 正文
    first = payload["blocks"][0]
    assert first["slot"] == "prefix"
    assert first["title"] == "本章前文"
    assert first["source"] == "L4"
    assert first["text"] == "他推开门。"
    assert first["tokens"] > 0
    # 上游真正收到的那一段里有前文
    assert "他推开门。" in payload["user"]
    # 外发口径：与 egress_chars() 逐字一致
    assert payload["egressChars"] == len(payload["system"]) + len(payload["user"])
    assert payload["budget"]["used"] > 0
    assert payload["dropped"] == []


def test_preview_uses_the_quick_template_when_a_kind_is_given(
    make_client: Callable[..., TestClient], auth_headers: dict[str, str], work: dict
) -> None:
    """带 `kind` 就是快捷生成 —— 与 `/ai/quick` 的分流判据一致。

    这一条防的是"预览按续写模板装、生成却按快捷模板发"：
    那样用户看到的是一份**不是**即将发出的东西，比他没看还糟。
    """
    with make_client() as client:
        _push(client, auth_headers)
        chapter_id = _chapter_id(client, auth_headers, work)
        res = client.post(
            "/api/v1/ai/preview",
            headers=auth_headers,
            json=_preview_body(work, chapter_id, kind="naming"),
        )

    payload = res.json()
    assert res.status_code == 200, res.text
    assert payload["templateId"] == "quick"
    # `quick.toml` 的 `[kinds].naming` 那句指令 —— 它出现在 user 里才说明
    # `kind` 真的传到了装配器（模板 id 相同、但 kind 丢了的话这句会是空的）
    assert "候选名" in payload["user"]


# ---------------------------------------------------------------------------
# 失败：与生成同一条错误来源
# ---------------------------------------------------------------------------


def test_preview_reports_the_same_error_as_generation_when_not_configured(
    make_client: Callable[..., TestClient], auth_headers: dict[str, str], work: dict
) -> None:
    """没配模型时，预览与生成必须是**同一句** `AI_NOT_CONFIGURED`。

    预览自己造一套文案的代价是两处漂移：用户先在预览里看到一种说法、
    点下生成又看到另一种，然后不知道哪个才是要修的问题。
    """
    with make_client() as client:
        _push(client, auth_headers, default_provider_id=None, default_model="")
        chapter_id = _chapter_id(client, auth_headers, work)
        body = _preview_body(work, chapter_id)
        previewed = client.post("/api/v1/ai/preview", headers=auth_headers, json=body)
        generated = client.post("/api/v1/ai/continue", headers=auth_headers, json=body)

    assert previewed.status_code == generated.status_code == 400
    assert previewed.json()["error"]["code"] == "AI_NOT_CONFIGURED"
    assert previewed.json()["error"]["message"] == generated.json()["error"]["message"]


def test_preview_reports_nothing_to_send_as_context_too_long(
    make_client: Callable[..., TestClient], auth_headers: dict[str, str], work: dict
) -> None:
    """空上下文（本章没正文、也没有相邻章与设定）→ 装配器的 `AI_CONTEXT_TOO_LONG`
    （413，与生成时同一个状态码）。

    这一条同时钉住"预览**不**在装配失败时静默回一个空 payload" ——
    那样界面会显示一张"要发送 0 字"的卡，而用户以为自己看过了。
    """
    with make_client() as client:
        _push(client, auth_headers)
        chapter_id = _chapter_id(client, auth_headers, work)
        res = client.post(
            "/api/v1/ai/preview",
            headers=auth_headers,
            json=_preview_body(work, chapter_id, prefix="", suffix=""),
        )

    assert res.status_code == 413
    assert res.json()["error"]["code"] == "AI_CONTEXT_TOO_LONG"


# ---------------------------------------------------------------------------
# 状态层：确认名单的过滤
# ---------------------------------------------------------------------------


def test_acked_ids_of_missing_providers_are_dropped() -> None:
    """`apply()` 只保留**当前存在**的供应商的确认记录。

    留着已删除的那条是危险的：用户之后重建一个同名 id（比如把自定义端点
    改回 `deepseek` 这个名字），那个新端点会**静默继承**旧的"已确认"——
    也就是一段用户从没看过的新地址被当成看过了。
    """
    state = AiState()
    state.apply(
        providers=[
            ProviderConfig(
                id="deepseek",
                kind="openai-compatible",
                label="DeepSeek",
                base_url="https://api.deepseek.com/v1",
                local=False,
                needs_key=True,
            )
        ],
        credentials={},
        offline_only=False,
        routing={},
        default_provider_id="deepseek",
        default_model="deepseek-chat",
        style_card="",
        daily_budget_cny=0.0,
        acknowledged_egress_providers=["deepseek", "已删除的那家"],
    )

    assert state.acked_egress_providers == {"deepseek"}
