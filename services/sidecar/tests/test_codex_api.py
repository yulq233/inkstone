"""Codex API 契约测试（``docs/15`` §5 B1 / §2.3 端点表）。

夹具与断言风格照 ``test_chapters_api.py``：走 TestClient 全链路，
断言 HTTP 状态码与统一错误信封的 ``code`` —— 渲染层就是按这两个东西分支的。
"""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

CODEX = "/api/v1/works/{work_id}/codex"
ENTRY = "/api/v1/works/{work_id}/codex/{entry_type}/{slug}"
BROKEN = "/api/v1/works/{work_id}/codex/broken-relations"


def _create(
    client: TestClient,
    headers: dict[str, str],
    work: dict,
    name: str = "沈观澜",
    **overrides: object,
) -> dict:
    body: dict[str, object] = {"type": "character", "name": name}
    body.update(overrides)
    res = client.post(CODEX.format(work_id=work["id"]), headers=headers, json=body)
    assert res.status_code == 201, res.text
    return res.json()["entry"]


def _read(client: TestClient, headers: dict[str, str], work: dict, slug: str) -> dict:
    res = client.get(
        ENTRY.format(work_id=work["id"], entry_type="character", slug=slug), headers=headers
    )
    assert res.status_code == 200, res.text
    return res.json()["entry"]


# ---- 新建 ----


def test_create_derives_slug_from_chinese_name(
    client: TestClient, auth_headers: dict[str, str], work: dict, work_root: Path
) -> None:
    entry = _create(client, auth_headers, work)
    assert entry["slug"] == "沈观澜"
    assert entry["hash"]
    # 文件即真源：路径必须是 codex/character/<slug>.md（D-2）。
    assert (work_root / "codex" / "character" / "沈观澜.md").is_file()


def test_create_duplicate_name_gets_numbered_suffix(
    client: TestClient, auth_headers: dict[str, str], work: dict
) -> None:
    first = _create(client, auth_headers, work)
    second = _create(client, auth_headers, work)
    assert first["slug"] == "沈观澜"
    assert second["slug"] == "沈观澜-2"
    # 两张卡同名但互不覆盖：第二张有自己的文件与自己的 hash。
    assert second["hash"]
    _read(client, auth_headers, work, second["slug"])


def test_create_of_unknown_work_is_404(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    res = client.post(
        CODEX.format(work_id="w_不存在"),
        headers=auth_headers,
        json={"type": "character", "name": "x"},
    )
    assert res.status_code == 404
    assert res.json()["error"]["code"] == "WORK_NOT_FOUND"


def test_create_rejects_unknown_type(
    client: TestClient, auth_headers: dict[str, str], work: dict
) -> None:
    res = client.post(
        CODEX.format(work_id=work["id"]),
        headers=auth_headers,
        json={"type": "spell", "name": "火球术"},
    )
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "INVALID_PARAM"


def test_create_rejects_extra_fields(
    client: TestClient, auth_headers: dict[str, str], work: dict
) -> None:
    # API 路径 extra="forbid"：契约漂移要 400，不许静默忽略。
    res = client.post(
        CODEX.format(work_id=work["id"]),
        headers=auth_headers,
        json={"type": "character", "name": "沈观澜", "typoField": 1},
    )
    assert res.status_code == 400


# ---- 清单与读取 ----


def test_list_contains_no_body(
    client: TestClient, auth_headers: dict[str, str], work: dict
) -> None:
    _create(client, auth_headers, work, body="很长的正文" * 100)
    res = client.get(CODEX.format(work_id=work["id"]), headers=auth_headers)
    assert res.status_code == 200
    items = res.json()["items"]
    assert len(items) == 1
    # 清单放大器问题：body/fields/relations 不进清单（docs/15 _summary_item）。
    assert "body" not in items[0]
    assert "fields" not in items[0]
    assert items[0]["name"] == "沈观澜"


def test_read_returns_full_entry(
    client: TestClient, auth_headers: dict[str, str], work: dict
) -> None:
    created = _create(
        client,
        auth_headers,
        work,
        aliases=["观澜"],
        fields={"年龄": 27},
        body="自由描述。",
    )
    read = _read(client, auth_headers, work, created["slug"])
    assert read["body"] == "自由描述。"
    assert read["fields"] == {"年龄": 27}
    assert read["aliases"] == ["观澜"]
    assert read["hash"] == created["hash"]


def test_read_unknown_slug_is_404(
    client: TestClient, auth_headers: dict[str, str], work: dict
) -> None:
    res = client.get(
        ENTRY.format(work_id=work["id"], entry_type="character", slug="不存在"),
        headers=auth_headers,
    )
    assert res.status_code == 404
    assert res.json()["error"]["code"] == "CODEX_NOT_FOUND"


def test_read_of_unknown_type_is_400(
    client: TestClient, auth_headers: dict[str, str], work: dict
) -> None:
    res = client.get(
        ENTRY.format(work_id=work["id"], entry_type="spell", slug="x"), headers=auth_headers
    )
    assert res.status_code == 400


def test_list_skips_unparseable_file_with_warning(
    client: TestClient, auth_headers: dict[str, str], work: dict, work_root: Path
) -> None:
    _create(client, auth_headers, work, name="正常人物")
    # 手写坏的文件：YAML 语法错误。清单必须跳过它而不是 500。
    bad = work_root / "codex" / "character" / "坏文件.md"
    bad.write_text("---\nname: [未闭合\n---\n", encoding="utf-8")
    # 无 frontmatter 的普通 md：同样跳过。
    plain = work_root / "codex" / "character" / "随手记.md"
    plain.write_text("# 只是笔记\n", encoding="utf-8")

    res = client.get(CODEX.format(work_id=work["id"]), headers=auth_headers)
    assert res.status_code == 200
    names = [item["name"] for item in res.json()["items"]]
    assert names == ["正常人物"]


# ---- 更新（乐观并发 D-4）----


def test_put_with_matching_hash_round_trips(
    client: TestClient, auth_headers: dict[str, str], work: dict, work_root: Path
) -> None:
    created = _create(client, auth_headers, work)
    updated = {
        **created,
        "summary": "改过的梗概",
        "aliases": ["观澜", "老沈"],
        "ifMatch": created["hash"],
    }
    # slug / hash 是服务端的**派生字段**，不在 PUT 契约里（extra="forbid"）。
    del updated["slug"], updated["hash"]
    res = client.put(
        ENTRY.format(work_id=work["id"], entry_type="character", slug=created["slug"]),
        headers=auth_headers,
        json=updated,
    )
    assert res.status_code == 200, res.text
    new_entry = res.json()["entry"]
    assert new_entry["summary"] == "改过的梗概"
    assert new_entry["hash"] != created["hash"]

    # 磁盘上的文件就是最终真相：重开（重读）必须拿到同一份。
    assert (work_root / "codex" / "character" / "沈观澜.md").read_text(encoding="utf-8").count(
        "老沈"
    ) == 1


def test_put_with_stale_hash_is_409(
    client: TestClient, auth_headers: dict[str, str], work: dict, work_root: Path
) -> None:
    created = _create(client, auth_headers, work)
    # 模拟外部编辑器改文件。
    path = work_root / "codex" / "character" / "沈观澜.md"
    path.write_text(path.read_text(encoding="utf-8") + "外部追加\n", encoding="utf-8")

    body = {**created, "ifMatch": created["hash"]}
    del body["slug"], body["hash"]
    res = client.put(
        ENTRY.format(work_id=work["id"], entry_type="character", slug=created["slug"]),
        headers=auth_headers,
        json=body,
    )
    assert res.status_code == 409
    error = res.json()["error"]
    assert error["code"] == "EXTERNAL_MODIFIED"
    # 冲突响应带回磁盘版本，冲突对话框才有得展示（与章节同语义）。
    assert "外部追加" in error["detail"]["diskMarkdown"]


def test_put_missing_if_match_is_400(
    client: TestClient, auth_headers: dict[str, str], work: dict
) -> None:
    created = _create(client, auth_headers, work)
    res = client.put(
        ENTRY.format(work_id=work["id"], entry_type="character", slug=created["slug"]),
        headers=auth_headers,
        json={"type": "character", "name": "沈观澜"},
    )
    assert res.status_code == 400


def test_put_type_mismatch_between_url_and_body_is_400(
    client: TestClient, auth_headers: dict[str, str], work: dict
) -> None:
    created = _create(client, auth_headers, work)
    body = {**created, "type": "location", "ifMatch": created["hash"]}
    del body["slug"], body["hash"]
    res = client.put(
        ENTRY.format(work_id=work["id"], entry_type="character", slug=created["slug"]),
        headers=auth_headers,
        json=body,
    )
    assert res.status_code == 400
    # 必须是"type 不一致"那条 400，不是别的字段校验错误碰巧也 400。
    assert "URL 不一致" in res.json()["error"]["message"]


def test_put_to_missing_entry_is_404(
    client: TestClient, auth_headers: dict[str, str], work: dict
) -> None:
    res = client.put(
        ENTRY.format(work_id=work["id"], entry_type="character", slug="不存在"),
        headers=auth_headers,
        json={"type": "character", "name": "x", "ifMatch": "0" * 16},
    )
    assert res.status_code == 404


# ---- 删除 ----


def test_delete_then_read_is_404(
    client: TestClient, auth_headers: dict[str, str], work: dict
) -> None:
    created = _create(client, auth_headers, work)
    res = client.delete(
        ENTRY.format(work_id=work["id"], entry_type="character", slug=created["slug"]),
        headers=auth_headers,
    )
    assert res.status_code == 200
    res = client.get(
        ENTRY.format(work_id=work["id"], entry_type="character", slug=created["slug"]),
        headers=auth_headers,
    )
    assert res.status_code == 404


def test_delete_twice_is_404(client: TestClient, auth_headers: dict[str, str], work: dict) -> None:
    created = _create(client, auth_headers, work)
    url = ENTRY.format(work_id=work["id"], entry_type="character", slug=created["slug"])
    assert client.delete(url, headers=auth_headers).status_code == 200
    assert client.delete(url, headers=auth_headers).status_code == 404


# ---- 断链清单（D-2）----


def test_broken_relations_reports_and_clears(
    client: TestClient, auth_headers: dict[str, str], work: dict
) -> None:
    _create(
        client,
        auth_headers,
        work,
        name="沈观澜",
        relations=[{"to": "沈砚之", "kind": "父子"}],
    )
    res = client.get(BROKEN.format(work_id=work["id"]), headers=auth_headers)
    items = res.json()["items"]
    assert len(items) == 1
    assert items[0]["to"] == "沈砚之"

    # 补上对方（不同类型也算命中 —— 引用按 slug 全局解析），断链收敛。
    _create(client, auth_headers, work, name="沈砚之")
    res = client.get(BROKEN.format(work_id=work["id"]), headers=auth_headers)
    assert res.json()["items"] == []


def test_broken_relations_on_empty_work_is_empty_list(
    client: TestClient, auth_headers: dict[str, str], work: dict
) -> None:
    res = client.get(BROKEN.format(work_id=work["id"]), headers=auth_headers)
    assert res.status_code == 200
    assert res.json()["items"] == []
