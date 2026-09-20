"""作品接口契约（03 文档 §7.2）。

A2 验收「新建作品生成完整目录骨架」就跑在这里 —— 逐项比对 §4.1 的结构，不留缺项。
"""

from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient

# 新建作品时必须一次建全的目录，顺序与 02 文档 §4.1 一致。
EXPECTED_DIRS = (
    "outline",
    "outline/卷纲",
    "manuscript",
    "codex",
    "snippets",
    "styles",
    ".inkstone",
    ".inkstone/logs",
    ".inkstone/backups",
)


def test_all_work_endpoints_require_token(client: TestClient) -> None:
    assert client.get("/api/v1/works/recent").status_code == 401
    assert client.post("/api/v1/works", json={"parentDir": "x", "title": "y"}).status_code == 401
    assert client.post("/api/v1/works/open", json={"rootPath": "x"}).status_code == 401


def test_create_work_builds_full_directory_skeleton(work: dict, work_root: Path) -> None:
    assert work["id"].startswith("w_")
    assert work["title"] == "我的小说"
    assert work["author"] == "小方同学"
    assert work["chapterCount"] == 1

    assert (work_root / "work.json").is_file()
    missing = [rel for rel in EXPECTED_DIRS if not (work_root / rel).is_dir()]
    assert missing == []


def test_create_work_seeds_first_chapter(work: dict, work_root: Path) -> None:
    """第一章自动创建：空空的作品页体验太差（03 文档 §11 第 5 条）。"""
    chapter_dir = work_root / "manuscript" / "001-第一章"
    assert chapter_dir.is_dir()
    assert (chapter_dir / "chapter.md").read_text(encoding="utf-8") == "# 第一章\n\n"

    meta = json.loads((chapter_dir / "meta.json").read_text(encoding="utf-8"))
    assert meta["schemaVersion"] == 1
    assert meta["order"] == 1
    assert meta["status"] == "draft"
    assert meta["id"].startswith("ch_")


def test_work_json_holds_the_documented_fields(work: dict, work_root: Path) -> None:
    raw = json.loads((work_root / "work.json").read_text(encoding="utf-8"))
    assert raw["schemaVersion"] == 1
    assert raw["id"] == work["id"]
    assert raw["title"] == "我的小说"
    assert raw["author"] == "小方同学"
    assert raw["genre"] == "玄幻"
    assert raw["wordGoal"] == 1000000
    # 未显式传入的字段也要有落盘默认值，用户用别的工具看这个文件时字段是齐的。
    assert raw["dailyGoal"] == 4000
    assert raw["tags"] == []
    assert raw["createdAt"].startswith("20")


def test_work_directory_name_is_slugified(
    client: TestClient, auth_headers: dict[str, str], parent_dir: Path
) -> None:
    res = client.post(
        "/api/v1/works",
        headers=auth_headers,
        json={"parentDir": str(parent_dir), "title": "我的小说: 第一部/序"},
    )
    assert res.status_code == 201, res.text
    # 标题里的 `:` 与 `/` 直接做目录名会创建失败，必须被清掉；标题本身保持原样。
    assert res.json()["work"]["title"] == "我的小说: 第一部/序"
    assert (parent_dir / "我的小说-第一部序").is_dir()


def test_create_work_rejects_non_empty_existing_directory(
    client: TestClient, auth_headers: dict[str, str], parent_dir: Path, work: dict
) -> None:
    """绝不覆盖已有目录 —— 宁可让用户换个名字。"""
    res = client.post(
        "/api/v1/works",
        headers=auth_headers,
        json={"parentDir": str(parent_dir), "title": "我的小说"},
    )
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "WORK_EXISTS"
    assert res.json()["error"]["detail"]["rootPath"].endswith("我的小说")


def test_create_work_rejects_missing_parent(
    client: TestClient, auth_headers: dict[str, str], parent_dir: Path
) -> None:
    res = client.post(
        "/api/v1/works",
        headers=auth_headers,
        json={"parentDir": str(parent_dir / "不存在"), "title": "新书"},
    )
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "INVALID_PARAM"


def test_create_work_rejects_blank_title(
    client: TestClient, auth_headers: dict[str, str], parent_dir: Path
) -> None:
    res = client.post(
        "/api/v1/works",
        headers=auth_headers,
        json={"parentDir": str(parent_dir), "title": "   "},
    )
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "INVALID_PARAM"


def test_open_work_returns_same_identity(
    client: TestClient, auth_headers: dict[str, str], work: dict
) -> None:
    res = client.post(
        "/api/v1/works/open", headers=auth_headers, json={"rootPath": work["rootPath"]}
    )
    assert res.status_code == 200
    reopened = res.json()["work"]
    assert reopened["id"] == work["id"]
    assert reopened["chapterCount"] == 1
    assert reopened["rootPath"] == work["rootPath"]


def test_open_missing_work_returns_404(
    client: TestClient, auth_headers: dict[str, str], parent_dir: Path
) -> None:
    res = client.post(
        "/api/v1/works/open", headers=auth_headers, json={"rootPath": str(parent_dir / "没这本书")}
    )
    assert res.status_code == 404
    assert res.json()["error"]["code"] == "WORK_NOT_FOUND"


def test_open_rejects_unsupported_schema_version(
    client: TestClient, auth_headers: dict[str, str], work: dict, work_root: Path
) -> None:
    """未知版本宁可报错也不猜 —— 按错误假设解析后写回会直接写坏用户的文件。"""
    raw = json.loads((work_root / "work.json").read_text(encoding="utf-8"))
    raw["schemaVersion"] = 99
    (work_root / "work.json").write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")

    res = client.post(
        "/api/v1/works/open", headers=auth_headers, json={"rootPath": str(work_root)}
    )
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "INVALID_PARAM"


def test_open_heals_missing_fields_and_writes_back(
    client: TestClient, auth_headers: dict[str, str], work: dict, work_root: Path
) -> None:
    """缺失字段补默认并写回：手写/半损坏的 work.json 能被自愈。"""
    work_json = work_root / "work.json"
    work_json.write_text(
        json.dumps({"schemaVersion": 1, "id": work["id"], "title": "我的小说"}, ensure_ascii=False),
        encoding="utf-8",
    )

    res = client.post(
        "/api/v1/works/open", headers=auth_headers, json={"rootPath": str(work_root)}
    )
    assert res.status_code == 200

    healed = json.loads(work_json.read_text(encoding="utf-8"))
    assert healed["dailyGoal"] == 4000
    assert healed["tags"] == []
    assert "createdAt" in healed


def test_open_preserves_unknown_fields(
    client: TestClient, auth_headers: dict[str, str], work: dict, work_root: Path
) -> None:
    """向前兼容：旧版本打开一次，不能把新版本写入的字段抹掉。"""
    work_json = work_root / "work.json"
    raw = json.loads(work_json.read_text(encoding="utf-8"))
    raw["futureField"] = {"nested": True}
    work_json.write_text(json.dumps(raw, ensure_ascii=False, indent=2), encoding="utf-8")

    client.post("/api/v1/works/open", headers=auth_headers, json={"rootPath": str(work_root)})

    after = json.loads(work_json.read_text(encoding="utf-8"))
    assert after["futureField"] == {"nested": True}


def test_open_does_not_rewrite_when_nothing_changed(
    client: TestClient, auth_headers: dict[str, str], work: dict, work_root: Path
) -> None:
    """不做无谓重写 —— 否则"最后修改时间"就失去参考价值了。"""
    work_json = work_root / "work.json"
    before = work_json.read_text(encoding="utf-8")

    client.post("/api/v1/works/open", headers=auth_headers, json={"rootPath": str(work_root)})

    assert work_json.read_text(encoding="utf-8") == before


def test_request_body_rejects_unknown_fields(
    client: TestClient, auth_headers: dict[str, str], parent_dir: Path
) -> None:
    res = client.post(
        "/api/v1/works",
        headers=auth_headers,
        json={"parentDir": str(parent_dir), "title": "新书", "typoField": 1},
    )
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "INVALID_PARAM"
