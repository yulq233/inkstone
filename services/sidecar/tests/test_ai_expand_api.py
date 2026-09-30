"""`POST /ai/expand` 端点契约（docs/16 D-1）。

expand 复用 `GenerationService.prepare/events`，所以这一份只钉 expand **特有**
的东西，续写/快捷已覆盖的（meta/delta/usage/done 帧结构、外发记录、预算拦截）
不重复 —— 只补：

1. 请求体形状（type/slug/target，不继承 AiGenRequestIn 的 chapterId/prefix）；
2. 装配源真的进 prompt（条目现值 / 关联 summary / 总纲）；
3. 并发占位键是 `<workId>:expand:<type>:<slug>`（不是 `<workId>:<chapterId>`）；
4. preview 复用不出网（E35 那三条对 expand 同样成立）。
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Callable, Iterator
from pathlib import Path
from typing import Any, cast

import httpx
import pytest
from fastapi.testclient import TestClient

from inkstone.app import create_app
from inkstone.config import Settings

Handler = Callable[[httpx.Request], httpx.Response]


class FakeStream(httpx.AsyncByteStream):
    """一段响应体（照 `test_ai_stream.py` 的同名夹具）。"""

    def __init__(self, chunks: list[bytes]) -> None:
        self._chunks = chunks

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for chunk in self._chunks:
            yield chunk


CLOUD_BODY = {
    "id": "deepseek",
    "kind": "openai-compatible",
    "label": "DeepSeek",
    "baseUrl": "https://api.deepseek.com/v1",
    "local": False,
    "needsKey": True,
}

CODEX = "/api/v1/works/{work_id}/codex"


@pytest.fixture()
def make_client(
    settings: Settings, work: dict, auth_headers: dict[str, str]
) -> Iterator[Callable[[Handler], TestClient]]:
    """按需构造注入了 MockTransport 的客户端，并打开已有作品 + 建好一张人物卡。

    与 `test_ai_stream.py` 同款：每个用例的上游响应不同，共享客户端会长出
    一堆"按 URL 分派"的分支。这里多一步 —— 预建一条 character 条目，
    否则每个用例都要重复"建卡 → 拿 slug"。
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


def _push(client: TestClient, headers: dict[str, str], **overrides: object) -> None:
    body: dict[str, object] = {
        "providers": [CLOUD_BODY],
        "credentials": {"deepseek": "sk-testsecret"},
        "offlineOnly": False,
        "routing": {},
        "defaultProviderId": "deepseek",
        "defaultModel": "deepseek-chat",
        "styleCard": "",
        "dailyBudgetCny": 0,
        "acknowledgedEgressProviders": [],
    }
    body.update(overrides)
    res = client.put("/api/v1/ai/config", headers=headers, json=body)
    assert res.status_code == 200, res.text


def _create_character(
    client: TestClient, headers: dict[str, str], work: dict, **overrides: object
) -> dict:
    body: dict[str, object] = {
        "type": "character",
        "name": "沈观澜",
        "summary": "一个寡言的老剑客。",
        "body": "少年时被逐出师门。",
    }
    body.update(overrides)
    res = client.post(CODEX.format(work_id=work["id"]), headers=headers, json=body)
    assert res.status_code == 201, res.text
    return res.json()["entry"]


def _expand_body(work: dict, slug: str, **overrides: object) -> dict[str, object]:
    body: dict[str, object] = {
        "workId": work["id"],
        "type": "character",
        "slug": slug,
        "target": "body",
        "intent": "",
    }
    body.update(overrides)
    return body


def _frames(*payloads: object) -> list[bytes]:
    return [f"data: {json.dumps(p)}".encode() + b"\n\n" for p in payloads]


def _delta(text: str) -> dict[str, object]:
    return {"choices": [{"delta": {"content": text}}]}


def _ok_stream(text: str = "他早年拜入云京剑派。") -> list[bytes]:
    head = text[: len(text) // 2] or text
    tail = text[len(text) // 2 :]
    return _frames(
        _delta(head),
        _delta(tail),
        {"choices": [{"delta": {}, "finish_reason": "stop"}]},
        {"usage": {"prompt_tokens": 100, "completion_tokens": 6}},
    )


def _ok_handler(_request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, stream=FakeStream(_ok_stream()))


def _read_events(res: httpx.Response) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for line in b"".join(res.iter_bytes()).decode("utf-8").splitlines():
        if line.startswith("data: "):
            events.append(json.loads(line[len("data: ") :]))
    return events


# ---------------------------------------------------------------------------
# 鉴权与请求体
# ---------------------------------------------------------------------------


def test_expand_requires_token(make_client: Callable[[Handler], TestClient], work: dict) -> None:
    with make_client(lambda request: httpx.Response(200, json={})) as client:
        res = client.post("/api/v1/ai/expand", json=_expand_body(work, "x"))
    assert res.status_code == 401


def test_expand_rejects_unknown_type(
    make_client: Callable[[Handler], TestClient], auth_headers: dict[str, str], work: dict
) -> None:
    """type 是 Literal —— 拼错就该 400，而不是落到装配时读不存在的目录。"""
    with make_client(lambda request: httpx.Response(200, json={})) as client:
        _push(client, auth_headers)
        res = client.post(
            "/api/v1/ai/expand",
            headers=auth_headers,
            json=_expand_body(work, "沈观澜", type="spell"),
        )
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "INVALID_PARAM"


def test_expand_rejects_extra_fields(
    make_client: Callable[[Handler], TestClient], auth_headers: dict[str, str], work: dict
) -> None:
    """`extra="forbid"`：渲染层把 chapterId 之类回灌进来就是契约漂移，宁可 400。"""
    with make_client(lambda request: httpx.Response(200, json={})) as client:
        _push(client, auth_headers)
        res = client.post(
            "/api/v1/ai/expand",
            headers=auth_headers,
            json=_expand_body(work, "沈观澜", chapterId="ch_x"),
        )
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "INVALID_PARAM"


# ---------------------------------------------------------------------------
# 正常生成
# ---------------------------------------------------------------------------


def test_expand_streams_meta_delta_done_with_expand_template(
    make_client: Callable[[Handler], TestClient],
    auth_headers: dict[str, str],
    work: dict,
) -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, stream=FakeStream(_ok_stream()))

    with make_client(handler) as client:
        _push(client, auth_headers)
        slug = _create_character(client, auth_headers, work)["slug"]
        with client.stream(
            "POST",
            "/api/v1/ai/expand",
            headers=auth_headers,
            json=_expand_body(work, slug),
        ) as res:
            assert res.status_code == 200
            assert res.headers["content-type"].startswith("text/event-stream")
            events = _read_events(res)

    assert [event["type"] for event in events] == ["meta", "delta", "delta", "usage", "done"]
    meta = events[0]
    assert meta["templateId"] == "expand"
    # v2：B 修复给 system 加了「条目自身名称是既定事实、不许改名」的硬约束（docs/16 §9.3）
    assert meta["templateVersion"] == 2
    assert meta["providerId"] == "deepseek"
    assert "".join(e["text"] for e in events if e["type"] == "delta") == "他早年拜入云京剑派。"

    # 装配源真的进 prompt：条目现值（summary/body）在 user 里
    sent = json.loads(seen[0].content)
    user_content = sent["messages"][1]["content"]
    assert "沈观澜" in user_content
    assert "寡言的老剑客" in user_content
    assert "少年时被逐出师门" in user_content
    # expand 的措辞随 target 换（body → 描述）
    assert "生成一段描述" in user_content


def test_expand_writes_a_run_record_with_codex_target_ref(
    make_client: Callable[[Handler], TestClient],
    auth_headers: dict[str, str],
    work: dict,
    work_root: Path,
) -> None:
    with make_client(_ok_handler) as client:
        _push(client, auth_headers)
        slug = _create_character(client, auth_headers, work)["slug"]
        with client.stream(
            "POST",
            "/api/v1/ai/expand",
            headers=auth_headers,
            json=_expand_body(work, slug),
        ) as res:
            _read_events(res)

    runs_path = work_root / ".inkstone" / "ai" / "runs.jsonl"
    record = json.loads(runs_path.read_text(encoding="utf-8").strip())
    assert record["taskType"] == "expand"
    assert record["targetRef"] == f"codex:character:{slug}"
    assert record["error"] is None


def test_expand_works_when_summary_is_empty_but_body_exists(
    make_client: Callable[[Handler], TestClient],
    auth_headers: dict[str, str],
    work: dict,
) -> None:
    """空 summary 不是错误：条目至少有 body（或 name），装配仍该有内容可发。"""
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, stream=FakeStream(_ok_stream()))

    with make_client(handler) as client:
        _push(client, auth_headers)
        slug = _create_character(client, auth_headers, work, summary="")["slug"]
        with client.stream(
            "POST",
            "/api/v1/ai/expand",
            headers=auth_headers,
            json=_expand_body(work, slug, target="summary"),
        ) as res:
            assert res.status_code == 200
            events = _read_events(res)

    assert events[-1]["type"] == "done"
    sent = json.loads(seen[0].content)
    # 即使 summary 空，body 里的内容仍进 prompt，且 target=summary 换措辞成"梗概"
    assert "少年时被逐出师门" in sent["messages"][1]["content"]
    assert "生成一段梗概" in sent["messages"][1]["content"]


def test_expand_of_missing_entry_is_codex_not_found(
    make_client: Callable[[Handler], TestClient],
    auth_headers: dict[str, str],
    work: dict,
) -> None:
    """目标条目被删了 → CODEX_NOT_FOUND（404），而不是装配一份空上下文去瞎编。"""
    with make_client(_ok_handler) as client:
        _push(client, auth_headers)
        res = client.post(
            "/api/v1/ai/expand",
            headers=auth_headers,
            json=_expand_body(work, "不存在的slug"),
        )
    assert res.status_code == 404
    assert res.json()["error"]["code"] == "CODEX_NOT_FOUND"


# ---------------------------------------------------------------------------
# 并发占位键（docs/16 D-4）
# ---------------------------------------------------------------------------


def test_expand_busy_key_is_per_entry(
    make_client: Callable[[Handler], TestClient],
    auth_headers: dict[str, str],
    work: dict,
) -> None:
    """同一条目同时两路扩充 → 409；不同条目互不阻塞。"""
    from fastapi import FastAPI

    from inkstone.ai.service import GenerationService

    with make_client(_ok_handler) as client:
        _push(client, auth_headers)
        slug_a = _create_character(client, auth_headers, work)["slug"]
        slug_b = _create_character(client, auth_headers, work, name="顾青山")["slug"]

        # `TestClient.app` 在 starlette 里只声明成 ASGI 应用，拿 `state` 要 cast 一次
        # （与 `test_ai_preview.py` 的并发用例同一写法）。
        app = cast(FastAPI, client.app)
        service = cast(GenerationService, app.state.ai_service)
        service._busy.add(f"{work['id']}:expand:character:{slug_a}")

        blocked = client.post(
            "/api/v1/ai/expand",
            headers=auth_headers,
            json=_expand_body(work, slug_a),
        )
        # 不同条目：不阻塞
        with client.stream(
            "POST",
            "/api/v1/ai/expand",
            headers=auth_headers,
            json=_expand_body(work, slug_b),
        ) as res:
            assert res.status_code == 200

    assert blocked.status_code == 409
    assert blocked.json()["error"]["code"] == "AI_BUSY"


# ---------------------------------------------------------------------------
# preview 复用不出网（docs/16 §2.2 / E35）
# ---------------------------------------------------------------------------


def test_expand_preview_sends_nothing_and_uses_expand_template(
    make_client: Callable[[Handler], TestClient],
    auth_headers: dict[str, str],
    work: dict,
) -> None:
    """expand 的 preview 走 `preview()`：一个字节不出网、不落记录、不占并发位。"""
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        raise AssertionError(f"预览不该发出请求：{request.method} {request.url}")

    with make_client(handler) as client:
        _push(client, auth_headers)
        slug = _create_character(client, auth_headers, work)["slug"]
        res = client.post(
            "/api/v1/ai/preview",
            headers=auth_headers,
            json={
                "workId": work["id"],
                "chapterId": "",
                "prefix": "",
                "suffix": "",
                "intent": "",
                "type": "character",
                "slug": slug,
                "target": "body",
            },
        )

    assert res.status_code == 200, res.text
    assert calls == []
    payload = res.json()
    assert payload["templateId"] == "expand"
    assert "沈观澜" in payload["user"]
    # 预览也要真装配 —— 关联/总纲进了 user 才算数
    assert payload["egressChars"] == len(payload["system"]) + len(payload["user"])
