"""最近作品列表（03 文档 §7.2）。

存的是"应用状态"而不是"作品数据"：作品目录被拷到别的机器时，
不该带走别人的打开记录。所以它落在 ``<userData>/recent-works.json``。
"""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from inkstone.storage.recent import MAX_ENTRIES, RecentStore

RECENT = "/api/v1/works/recent"


def _recent(client: TestClient, headers: dict[str, str]) -> list[dict]:
    res = client.get(RECENT, headers=headers)
    assert res.status_code == 200, res.text
    return res.json()["items"]


def test_creating_a_work_adds_it_to_recent(
    client: TestClient, auth_headers: dict, work: dict
) -> None:
    items = _recent(client, auth_headers)
    assert len(items) == 1
    assert items[0]["rootPath"] == work["rootPath"]
    assert items[0]["title"] == "我的小说"
    assert items[0]["exists"] is True
    assert items[0]["lastOpenedAt"].startswith("20")


def test_reopening_does_not_duplicate(
    client: TestClient, auth_headers: dict, work: dict
) -> None:
    for _ in range(3):
        client.post("/api/v1/works/open", headers=auth_headers, json={"rootPath": work["rootPath"]})
    assert len(_recent(client, auth_headers)) == 1


def test_most_recently_opened_comes_first(
    client: TestClient, auth_headers: dict, parent_dir: Path
) -> None:
    first = client.post(
        "/api/v1/works", headers=auth_headers, json={"parentDir": str(parent_dir), "title": "甲书"}
    ).json()["work"]
    second = client.post(
        "/api/v1/works", headers=auth_headers, json={"parentDir": str(parent_dir), "title": "乙书"}
    ).json()["work"]

    # 再回去开一次"甲书"，它应该排到最前面
    client.post("/api/v1/works/open", headers=auth_headers, json={"rootPath": first["rootPath"]})

    items = _recent(client, auth_headers)
    assert [i["title"] for i in items] == ["甲书", "乙书"]
    assert items[0]["rootPath"] == first["rootPath"]
    assert items[1]["rootPath"] == second["rootPath"]


def test_moved_or_deleted_work_is_flagged_not_dropped(
    client: TestClient, auth_headers: dict, work: dict
) -> None:
    """目录没了也要留在列表里并标 exists=false，让用户能自己决定移除它。"""
    shutil.rmtree(work["rootPath"])

    items = _recent(client, auth_headers)
    assert len(items) == 1
    assert items[0]["exists"] is False


def test_remove_only_touches_the_list(
    client: TestClient, auth_headers: dict, work: dict, work_root: Path
) -> None:
    res = client.delete(RECENT, headers=auth_headers, params={"rootPath": work["rootPath"]})
    assert res.status_code == 200
    assert res.json()["removed"] is True

    assert _recent(client, auth_headers) == []
    # 只动应用状态，绝不碰作品目录本身。
    assert (work_root / "work.json").is_file()


def test_remove_unknown_entry_reports_false(
    client: TestClient, auth_headers: dict
) -> None:
    res = client.delete(RECENT, headers=auth_headers, params={"rootPath": "D:/没有这本"})
    assert res.status_code == 200
    assert res.json()["removed"] is False


def test_recent_requires_token(client: TestClient) -> None:
    assert client.get(RECENT).status_code == 401


@pytest.mark.skipif(sys.platform != "win32", reason="大小写不敏感是 Windows 文件系统的特性")
def test_case_insensitive_dedupe_on_windows(tmp_path: Path) -> None:
    """Windows 上同一个目录可以用不同大小写拼出来，不能算成两条记录。"""
    store = RecentStore(tmp_path)
    store.touch(root_path=str(tmp_path / "novel"), title="Novel")
    store.touch(root_path=str(tmp_path / "NOVEL"), title="Novel")
    assert len(store.list()) == 1


def test_store_caps_growth(tmp_path: Path) -> None:
    store = RecentStore(tmp_path)
    for index in range(MAX_ENTRIES + 5):
        store.touch(root_path=str(tmp_path / f"book-{index}"), title=f"book-{index}")
    assert len(store.list()) == MAX_ENTRIES


def test_corrupted_store_degrades_to_empty(tmp_path: Path) -> None:
    (tmp_path / "recent-works.json").write_text("{ 这不是 JSON", encoding="utf-8")
    store = RecentStore(tmp_path)
    assert store.list() == []
    # 而且要能继续正常写入，不能因为坏文件就永久瘫痪。
    store.touch(root_path=str(tmp_path / "新书"), title="新书")
    assert len(store.list()) == 1


def test_entries_without_root_path_are_skipped(tmp_path: Path) -> None:
    (tmp_path / "recent-works.json").write_text(
        json.dumps({"schemaVersion": 1, "items": [{"title": "没有路径"}, "字符串"]}),
        encoding="utf-8",
    )
    assert RecentStore(tmp_path).list() == []
