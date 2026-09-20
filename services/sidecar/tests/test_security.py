"""鉴权中间件（对应 03 文档 §9.1 的 `security` 行）。"""

from __future__ import annotations

import secrets

from fastapi.testclient import TestClient

PROTECTED = "/api/v1/shutdown"
HEALTHY = "/api/v1/healthz"


def test_healthz_is_exempt(client: TestClient) -> None:
    res = client.get(HEALTHY)
    assert res.status_code == 200
    assert res.json()["ok"] is True


def test_missing_token_is_rejected(client: TestClient) -> None:
    res = client.post(PROTECTED)
    assert res.status_code == 401
    assert res.json()["error"]["code"] == "UNAUTHORIZED"


def test_wrong_token_is_rejected(client: TestClient) -> None:
    res = client.post(PROTECTED, headers={"X-Inkstone-Token": secrets.token_hex(32)})
    assert res.status_code == 401
    assert res.json()["error"]["code"] == "UNAUTHORIZED"


def test_missing_and_wrong_are_indistinguishable(client: TestClient) -> None:
    """不区分"没带"和"带错了"，避免给探测者额外信息。"""
    missing = client.post(PROTECTED)
    wrong = client.post(PROTECTED, headers={"X-Inkstone-Token": "x" * 64})
    assert missing.status_code == wrong.status_code
    assert missing.json() == wrong.json()


def test_correct_token_passes(client: TestClient, auth_headers: dict[str, str]) -> None:
    res = client.post(PROTECTED, headers=auth_headers)
    assert res.status_code == 200
    assert res.json() == {"ok": True}


def test_token_comparison_handles_non_ascii_header(client: TestClient) -> None:
    """非 ASCII 头不能让 compare_digest 抛 TypeError（那会变成 500 而不是 401）。"""
    res = client.post(PROTECTED, headers={"X-Inkstone-Token": "not-a-real-token"})
    assert res.status_code == 401


def test_token_must_be_exact(client: TestClient, token: str) -> None:
    """前缀正确但长度不对，也必须拒绝。"""
    res = client.post(PROTECTED, headers={"X-Inkstone-Token": token[:-1]})
    assert res.status_code == 401
