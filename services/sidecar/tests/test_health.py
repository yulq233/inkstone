"""探活端点契约（对应 03 文档 §7.2）。"""

from __future__ import annotations

from fastapi.testclient import TestClient

from inkstone.config import Settings


def test_healthz_shape(client: TestClient, settings: Settings) -> None:
    body = client.get("/api/v1/healthz").json()
    assert set(body) == {"ok", "version", "uptimeMs"}
    assert body["ok"] is True
    assert body["version"] == settings.version
    assert isinstance(body["uptimeMs"], int)
    assert body["uptimeMs"] >= 0


def test_uptime_is_monotonic(client: TestClient) -> None:
    first = client.get("/api/v1/healthz").json()["uptimeMs"]
    second = client.get("/api/v1/healthz").json()["uptimeMs"]
    assert second >= first


def test_healthz_leaks_nothing_about_the_workspace(client: TestClient) -> None:
    """探活是免鉴权的，所以它不能透出任何路径 / 作品信息。"""
    body = client.get("/api/v1/healthz").json()
    serialized = str(body)
    assert "token" not in serialized.lower()
    assert "\\" not in serialized and "/" not in serialized


def test_unknown_route_requires_token(client: TestClient) -> None:
    # 鉴权中间件在路由匹配**之前**跑，所以未鉴权的未知路径也必须是 401，
    # 而不是 404 —— 404 会泄露"这条路由存不存在"。
    assert client.get("/api/v1/no-such-route").status_code == 401


def test_unknown_route_with_token_is_404(client: TestClient, auth_headers: dict[str, str]) -> None:
    res = client.get("/api/v1/no-such-route", headers=auth_headers)
    assert res.status_code == 404
