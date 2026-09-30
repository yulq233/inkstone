"""AI 端点的契约（`docs/11` §4.2）。

四条端点的鉴权、错误信封与状态码都在这里钉住 —— 渲染进程的 ApiError
就是按这几个字段做分支的，改一处就会让它在另一处静默走错分支。

P0 的两条硬验收也在这里（`docs/11` §7.2）：
- 密钥错误必须是 `AI_AUTH_FAILED` 而**不是** `UNAUTHORIZED`；
- 纯本地模式开着时，即使**直接打这条 HTTP 端点**（绕过界面）也要被拒。
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable, Iterator
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

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

SECRET = "sk-endtoendsecretvalue"


@pytest.fixture()
def make_client(settings: Settings) -> Iterator[Callable[[Handler], TestClient]]:
    """按需构造注入了 MockTransport 的客户端。

    不用一个共享的 client：每个用例关心的上游响应完全不同（401 / 超时 / 正常），
    共享夹具会长出一堆"按 URL 分派"的分支，读起来比被测代码还复杂。
    """

    def build(handler: Handler) -> TestClient:
        return TestClient(create_app(settings, ai_transport=httpx.MockTransport(handler)))

    yield build


def _chat_ok(content: str = "你好") -> httpx.Response:
    return httpx.Response(200, json={"choices": [{"message": {"content": content}}]})


def _no_network(request: httpx.Request) -> httpx.Response:  # pragma: no cover - 兜底
    raise AssertionError(f"不该发出请求：{request.method} {request.url}")


def _push(
    client: TestClient,
    headers: dict[str, str],
    *,
    providers: list[dict[str, Any]] | None = None,
    credentials: dict[str, str] | None = None,
    offline_only: bool = False,
    routing: dict[str, Any] | None = None,
    default_provider_id: str | None = None,
    default_model: str = "",
    style_card: str = "",
    daily_budget_cny: float = 0.0,
    acknowledged_egress_providers: list[str] | None = None,
) -> httpx.Response:
    return client.put(
        "/api/v1/ai/config",
        headers=headers,
        json={
            "providers": providers if providers is not None else [CLOUD_PROVIDER],
            "credentials": credentials if credentials is not None else {},
            "offlineOnly": offline_only,
            "routing": routing if routing is not None else {},
            "defaultProviderId": default_provider_id,
            "defaultModel": default_model,
            "styleCard": style_card,
            "dailyBudgetCny": daily_budget_cny,
            "acknowledgedEgressProviders": (
                acknowledged_egress_providers
                if acknowledged_egress_providers is not None
                else []
            ),
        },
    )


# ---------------------------------------------------------------------------
# 鉴权
# ---------------------------------------------------------------------------


def test_all_ai_endpoints_require_token(make_client: Callable[[Handler], TestClient]) -> None:
    """`/ai/config` 带明文 Key，**不能有任何豁免口子**。"""
    with make_client(_no_network) as client:
        assert client.get("/api/v1/ai/providers").status_code == 401
        assert client.put("/api/v1/ai/config", json={}).status_code == 401
        assert client.get("/api/v1/ai/providers/ollama/models").status_code == 401
        assert client.post(
            "/api/v1/ai/test", json={"providerId": "ollama", "model": "qwen3:8b"}
        ).status_code == 401


# ---------------------------------------------------------------------------
# GET /ai/providers
# ---------------------------------------------------------------------------


def test_providers_is_empty_before_the_main_process_pushes(
    make_client: Callable[[Handler], TestClient], auth_headers: dict[str, str]
) -> None:
    """启动时不读任何文件 —— 真源在主进程 settings.json。
    空列表要和"推送失败"长得不一样：渲染进程据此提示"请重启砚台"。"""
    with make_client(_no_network) as client:
        res = client.get("/api/v1/ai/providers", headers=auth_headers)

    assert res.status_code == 200
    assert res.json() == {"items": []}


def test_providers_lists_configuration_without_any_credential_information(
    make_client: Callable[[Handler], TestClient], auth_headers: dict[str, str]
) -> None:
    with make_client(_no_network) as client:
        _push(client, auth_headers, credentials={"deepseek": SECRET})
        res = client.get("/api/v1/ai/providers", headers=auth_headers)

    assert res.status_code == 200
    items = res.json()["items"]
    assert items == [
        {
            "id": "deepseek",
            "kind": "openai-compatible",
            "label": "DeepSeek",
            "baseUrl": "https://api.deepseek.com/v1",
            "local": False,
            "needsKey": True,
        }
    ]
    # 明文 Key 绝不能从这条端点回显出去（它会被渲染进程缓存、被 devtools 抓到）
    assert SECRET not in res.text


# ---------------------------------------------------------------------------
# PUT /ai/config
# ---------------------------------------------------------------------------


def test_put_config_reports_how_many_entries_took_effect(
    make_client: Callable[[Handler], TestClient], auth_headers: dict[str, str]
) -> None:
    """推送侧据此确认"推到了"：对不上就是契约漂移（比如某条被静默丢弃）。"""
    with make_client(_no_network) as client:
        res = _push(
            client,
            auth_headers,
            providers=[CLOUD_PROVIDER, LOCAL_PROVIDER],
            credentials={"deepseek": SECRET},
        )

    assert res.status_code == 200
    assert res.json() == {"applied": {"providers": 2, "credentials": 1}}


def test_put_config_never_echoes_credentials(
    make_client: Callable[[Handler], TestClient], auth_headers: dict[str, str]
) -> None:
    """响应体会进日志。虽然日志侧有按值擦除，但"根本不回显"比"回显了再擦"少一层依赖。"""
    with make_client(_no_network) as client:
        res = _push(client, auth_headers, credentials={"deepseek": SECRET})

    assert SECRET not in res.text


def test_put_config_rejects_unknown_fields(
    make_client: Callable[[Handler], TestClient], auth_headers: dict[str, str]
) -> None:
    """多传字段说明契约漂移了，宁可 400 也不要静默忽略。

    ⚠️ 这个 body 必须**先满足"字段齐全"**（含 P1 补的三个），否则 400 的成因
    会是"缺字段"而不是"多字段"，用例就从"拦住契约漂移"变成了一句废话。
    """
    with make_client(_no_network) as client:
        res = client.put(
            "/api/v1/ai/config",
            headers=auth_headers,
            json={
                "providers": [],
                "credentials": {},
                "offlineOnly": False,
                "routing": {},
                "defaultProviderId": None,
                "defaultModel": "",
                "styleCard": "",
                "dailyBudgetCny": 0,
                "acknowledgedEgressProviders": [],
                "apiKey": SECRET,  # 前端把 Key 塞进了 config —— 正是要拦的那件事
            },
        )

    assert res.status_code == 400
    assert res.json()["error"]["code"] == "INVALID_PARAM"
    assert SECRET not in res.text


@pytest.mark.parametrize(
    "missing",
    ["defaultModel", "styleCard", "dailyBudgetCny", "acknowledgedEgressProviders"],
)
def test_put_config_requires_the_p1_fields(
    make_client: Callable[[Handler], TestClient],
    auth_headers: dict[str, str],
    missing: str,
) -> None:
    """P1 补的三个字段与 P1-b 的 `acknowledgedEgressProviders` 同样是**必填**。

    P1 那三个（`docs/11` §7.3.1 的 D-5）的失效方式都是**静默**的
    （生成报未配置 / 风格卡不生效 / 预算永不拦截）；
    `acknowledgedEgressProviders` 漏推会退化成空数组，方向是安全的（多弹一次确认卡），
    但它同样是一次契约漂移 —— 宁可让"漏推"在这里变成一次响亮的 400。
    """
    body: dict[str, Any] = {
        "providers": [CLOUD_PROVIDER],
        "credentials": {},
        "offlineOnly": False,
        "routing": {},
        "defaultProviderId": None,
        "defaultModel": "",
        "styleCard": "",
        "dailyBudgetCny": 0,
        "acknowledgedEgressProviders": [],
    }
    body.pop(missing)

    with make_client(_no_network) as client:
        res = client.put("/api/v1/ai/config", headers=auth_headers, json=body)

    assert res.status_code == 400
    assert res.json()["error"]["code"] == "INVALID_PARAM"
    assert missing in res.text


def test_disabling_offline_only_leaves_a_warning_in_the_log(
    client: TestClient,
    auth_headers: dict[str, str],
    caplog: pytest.LogCaptureFixture,
) -> None:
    """`docs/13` M9：隐私开关**由开转关**必须留一条 warning。

    token 在设计上就下发到渲染进程（渲染进程直连 sidecar，`docs/11` §4.2），
    所以 sidecar **分不清**"用户自己关的"与"被 XSS 推着关的"。它能做的是**不静默** ——
    这条 warning 就是事后唯一能从日志里看出来的痕迹。反过来说：**没有方向变化就不该刷屏**，
    否则"每次推配置都有一条"等于把这条日志淹掉。
    """

    def warnings() -> list[logging.LogRecord]:
        return [r for r in caplog.records if r.levelno == logging.WARNING]

    with caplog.at_level(logging.WARNING, logger="inkstone.ai"):
        # 先显式打开（默认是关）—— 这一步不该有 warning
        assert _push(client, auth_headers, offline_only=True).status_code == 200
        assert warnings() == []

        # 由开转关 → 恰好一条
        assert _push(client, auth_headers, offline_only=False).status_code == 200
        assert len(warnings()) == 1
        assert "纯本地模式已被关闭" in warnings()[0].getMessage()

        # 再推一次 false：没有方向变化，不该再多一条
        assert _push(client, auth_headers, offline_only=False).status_code == 200
        assert len(warnings()) == 1


def test_put_config_tolerates_unknown_routing_task_names(
    make_client: Callable[[Handler], TestClient], auth_headers: dict[str, str]
) -> None:
    """**刻意宽松**：未知任务名无害（取不到就报未配置），
    而在这里拒绝未知键会让"前端给某个任务改名"升级成"整份配置推送失败" ——
    失败方式是凭据永远到不了，比漏配一个任务严重得多。"""
    with make_client(_no_network) as client:
        res = _push(
            client,
            auth_headers,
            routing={"continue": {"providerId": "deepseek", "model": "deepseek-chat"}},
        )

    assert res.status_code == 200
    assert res.json()["applied"]["providers"] == 1


def test_put_config_accepts_null_routing_entries(
    make_client: Callable[[Handler], TestClient], auth_headers: dict[str, str]
) -> None:
    """routing 的值可以为 null（表示"这个任务还没选模型"），不是缺字段。"""
    with make_client(_no_network) as client:
        res = _push(client, auth_headers, routing={"continue": None, "rewrite": None})

    assert res.status_code == 200


def test_put_config_is_a_full_replacement(
    make_client: Callable[[Handler], TestClient], auth_headers: dict[str, str]
) -> None:
    """第二次推送删掉一个供应商后，它不该还能被列举出来。"""
    with make_client(_no_network) as client:
        _push(client, auth_headers, providers=[CLOUD_PROVIDER, LOCAL_PROVIDER])
        _push(client, auth_headers, providers=[LOCAL_PROVIDER])
        res = client.get("/api/v1/ai/providers", headers=auth_headers)

    assert [item["id"] for item in res.json()["items"]] == ["ollama"]


def test_put_config_rejects_missing_required_sections(
    make_client: Callable[[Handler], TestClient], auth_headers: dict[str, str]
) -> None:
    with make_client(_no_network) as client:
        res = client.put("/api/v1/ai/config", headers=auth_headers, json={"providers": []})

    assert res.status_code == 400
    assert res.json()["error"]["code"] == "INVALID_PARAM"


# ---------------------------------------------------------------------------
# GET /ai/providers/{id}/models
# ---------------------------------------------------------------------------


def test_models_endpoint_returns_a_stable_sorted_list(
    make_client: Callable[[Handler], TestClient], auth_headers: dict[str, str]
) -> None:
    body = {"data": [{"id": "deepseek-reasoner"}, {"id": "deepseek-chat"}]}
    with make_client(lambda request: httpx.Response(200, json=body)) as client:
        _push(client, auth_headers, credentials={"deepseek": SECRET})
        res = client.get("/api/v1/ai/providers/deepseek/models", headers=auth_headers)

    assert res.status_code == 200
    # 排序只为了让下拉框稳定 —— 上游给的顺序可能每次都不一样
    assert [item["id"] for item in res.json()["items"]] == [
        "deepseek-chat",
        "deepseek-reasoner",
    ]


def test_models_endpoint_for_an_unknown_provider_is_a_configuration_error(
    make_client: Callable[[Handler], TestClient], auth_headers: dict[str, str]
) -> None:
    """不是 404：这不是"资源找不到"，而是"本地服务还没拿到这份配置"。"""
    with make_client(_no_network) as client:
        res = client.get("/api/v1/ai/providers/ollama/models", headers=auth_headers)

    assert res.status_code == 400
    error = res.json()["error"]
    assert error["code"] == "AI_NOT_CONFIGURED"
    assert "保存一次" in error["message"]


def test_models_endpoint_does_not_touch_the_network_when_offline_only(
    make_client: Callable[[Handler], TestClient], auth_headers: dict[str, str]
) -> None:
    """列模型也要被拦：请求地址本身就会暴露"你用了哪家"。"""
    with make_client(_no_network) as client:  # 任何请求都会让用例失败
        _push(client, auth_headers, credentials={"deepseek": SECRET}, offline_only=True)
        res = client.get("/api/v1/ai/providers/deepseek/models", headers=auth_headers)

    assert res.status_code == 403
    assert res.json()["error"]["code"] == "AI_OFFLINE_ONLY"


# ---------------------------------------------------------------------------
# POST /ai/test
# ---------------------------------------------------------------------------


def test_test_endpoint_returns_latency_and_echo(
    make_client: Callable[[Handler], TestClient], auth_headers: dict[str, str]
) -> None:
    with make_client(lambda request: _chat_ok("我在")) as client:
        _push(client, auth_headers, credentials={"deepseek": SECRET})
        res = client.post(
            "/api/v1/ai/test",
            headers=auth_headers,
            json={"providerId": "deepseek", "model": "deepseek-chat"},
        )

    assert res.status_code == 200
    payload = res.json()
    assert payload["ok"] is True
    assert payload["model"] == "deepseek-chat"
    assert payload["echo"] == "我在"
    assert payload["latencyMs"] >= 0


def test_test_endpoint_with_a_wrong_key_is_ai_auth_failed_not_unauthorized(
    make_client: Callable[[Handler], TestClient], auth_headers: dict[str, str]
) -> None:
    """**P0 验收**。

    若这里回 `UNAUTHORIZED`，渲染进程的 `ApiError.isUnauthorized` 会把整个界面
    推进 FAILED —— 用户只是 Key 填错了，却看到"本地服务连接失败，请重启"。
    """
    with make_client(lambda request: httpx.Response(401, text="invalid api key")) as client:
        _push(client, auth_headers, credentials={"deepseek": SECRET})
        res = client.post(
            "/api/v1/ai/test",
            headers=auth_headers,
            json={"providerId": "deepseek", "model": "deepseek-chat"},
        )

    assert res.status_code == 401
    error = res.json()["error"]
    assert error["code"] == "AI_AUTH_FAILED"
    assert error["code"] != "UNAUTHORIZED"
    assert error["detail"]["providerId"] == "deepseek"
    assert SECRET not in res.text


def test_test_endpoint_is_blocked_by_offline_only_even_when_called_directly(
    make_client: Callable[[Handler], TestClient], auth_headers: dict[str, str]
) -> None:
    """**P0 验收**：绕过界面直接打端点也要被拒。

    这条用例同时锁住了"拦截点在网关、不在界面"这个设计 ——
    以后 P1/P2 新增的每条调用路径都会经过同一处，不需要各自补判断。
    """
    with make_client(_no_network) as client:
        # 密钥是齐的（否则报的会是凭据缺失），地址也是通的（否则会超时）。
        # 换句话说：**只有纯本地模式这一条理由**能让它失败。
        _push(client, auth_headers, credentials={"deepseek": SECRET}, offline_only=True)
        res = client.post(
            "/api/v1/ai/test",
            headers=auth_headers,
            json={"providerId": "deepseek", "model": "deepseek-chat"},
        )

    assert res.status_code == 403
    assert res.json()["error"]["code"] == "AI_OFFLINE_ONLY"


def test_test_endpoint_still_works_for_local_provider_when_offline_only(
    make_client: Callable[[Handler], TestClient], auth_headers: dict[str, str]
) -> None:
    with make_client(lambda request: _chat_ok("本机在答")) as client:
        _push(client, auth_headers, providers=[LOCAL_PROVIDER], offline_only=True)
        res = client.post(
            "/api/v1/ai/test",
            headers=auth_headers,
            json={"providerId": "ollama", "model": "qwen3:8b"},
        )

    assert res.status_code == 200
    assert res.json()["echo"] == "本机在答"


def test_test_endpoint_without_a_pushed_credential_says_resave_it(
    make_client: Callable[[Handler], TestClient], auth_headers: dict[str, str]
) -> None:
    """推送失败的症状就是这个 —— 文案必须指向"再保存一次"，而不是"你还没填"。"""
    with make_client(_no_network) as client:
        _push(client, auth_headers, providers=[CLOUD_PROVIDER])  # 没有 credentials
        res = client.post(
            "/api/v1/ai/test",
            headers=auth_headers,
            json={"providerId": "deepseek", "model": "deepseek-chat"},
        )

    assert res.status_code == 400
    assert res.json()["error"]["code"] == "AI_CREDENTIAL_MISSING"


def test_test_endpoint_reports_rate_limit_and_timeout_distinctly(
    make_client: Callable[[Handler], TestClient], auth_headers: dict[str, str]
) -> None:
    with make_client(lambda request: httpx.Response(429, text="slow down")) as client:
        _push(client, auth_headers, credentials={"deepseek": SECRET})
        limited = client.post(
            "/api/v1/ai/test",
            headers=auth_headers,
            json={"providerId": "deepseek", "model": "deepseek-chat"},
        )

    def timed_out(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("read timed out", request=request)

    with make_client(timed_out) as client:
        _push(client, auth_headers, credentials={"deepseek": SECRET})
        timeout = client.post(
            "/api/v1/ai/test",
            headers=auth_headers,
            json={"providerId": "deepseek", "model": "deepseek-chat"},
        )

    assert limited.status_code == 429
    assert limited.json()["error"]["code"] == "AI_RATE_LIMITED"
    assert timeout.status_code == 504
    assert timeout.json()["error"]["code"] == "AI_TIMEOUT"


def test_test_endpoint_validates_the_request_body(
    make_client: Callable[[Handler], TestClient], auth_headers: dict[str, str]
) -> None:
    with make_client(_no_network) as client:
        _push(client, auth_headers, credentials={"deepseek": SECRET})
        res = client.post(
            "/api/v1/ai/test",
            headers=auth_headers,
            json={"providerId": "deepseek", "model": ""},  # 空模型名
        )

    assert res.status_code == 400
    assert res.json()["error"]["code"] == "INVALID_PARAM"


# ---------------------------------------------------------------------------
# 密钥轮换
# ---------------------------------------------------------------------------


def test_rotating_a_key_replaces_the_one_actually_sent_upstream(
    make_client: Callable[[Handler], TestClient], auth_headers: dict[str, str]
) -> None:
    """轮换后必须发新的：仍发旧 Key 的症状是 401，而用户刚在界面里确认过"我改了"。"""
    seen: list[str] = []

    def record(request: httpx.Request) -> httpx.Response:
        seen.append(request.headers.get("authorization", ""))
        return _chat_ok()

    with make_client(record) as client:
        _push(client, auth_headers, credentials={"deepseek": SECRET})
        client.post(
            "/api/v1/ai/test",
            headers=auth_headers,
            json={"providerId": "deepseek", "model": "deepseek-chat"},
        )
        _push(client, auth_headers, credentials={"deepseek": "sk-rotatedsecretvalue"})
        client.post(
            "/api/v1/ai/test",
            headers=auth_headers,
            json={"providerId": "deepseek", "model": "deepseek-chat"},
        )

    assert seen == [f"Bearer {SECRET}", "Bearer sk-rotatedsecretvalue"]


def test_removing_a_provider_drops_its_key_from_memory(
    make_client: Callable[[Handler], TestClient], auth_headers: dict[str, str]
) -> None:
    with make_client(_no_network) as client:
        _push(client, auth_headers, providers=[CLOUD_PROVIDER], credentials={"deepseek": SECRET})
        _push(client, auth_headers, providers=[LOCAL_PROVIDER])  # 删掉 deepseek
        # 删掉之后连"未配置"都要报出来（而不是拿着残留的 Key 再去请求）
        res = client.post(
            "/api/v1/ai/test",
            headers=auth_headers,
            json={"providerId": "deepseek", "model": "deepseek-chat"},
        )

    assert res.status_code == 400
    assert res.json()["error"]["code"] == "AI_NOT_CONFIGURED"


def test_error_envelope_shape_matches_the_renderer_contract(
    make_client: Callable[[Handler], TestClient], auth_headers: dict[str, str]
) -> None:
    """渲染进程按 `error.code` / `error.message` 两个字段分支，多一个少一个都会让它走错路。"""
    with make_client(lambda request: httpx.Response(401, text="nope")) as client:
        _push(client, auth_headers, credentials={"deepseek": SECRET})
        res = client.post(
            "/api/v1/ai/test",
            headers=auth_headers,
            json={"providerId": "deepseek", "model": "deepseek-chat"},
        )

    body = json.loads(res.text)
    assert set(body) == {"error"}
    assert {"code", "message", "detail", "traceId"} <= set(body["error"])
    assert isinstance(body["error"]["message"], str)
