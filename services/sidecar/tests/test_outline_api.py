"""大纲三层与伏笔聚合的 API 契约测试（``docs/15`` §5 B2）。

夹具风格照 ``test_chapters_api.py`` / ``test_codex_api.py``：TestClient 全链路、
断状态码 + 统一错误信封的 code。
"""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

GENERAL = "/api/v1/works/{work_id}/outline/general"
VOLUMES = "/api/v1/works/{work_id}/outline/volumes"
VOLUME = "/api/v1/works/{work_id}/outline/volumes/{order}"
REORDER = "/api/v1/works/{work_id}/outline/volumes/{order}/reorder"
CH_OUTLINE = "/api/v1/works/{work_id}/outline/chapters/{chapter_id}"
FORESHADOWS = "/api/v1/works/{work_id}/foreshadows"


def _chapter_id(client: TestClient, headers: dict[str, str], work: dict) -> str:
    """作品自带第一章；拿它的 id。"""
    res = client.get(
        f"/api/v1/works/{work['id']}/chapters", headers=headers
    )
    assert res.status_code == 200, res.text
    return res.json()["items"][0]["id"]


def _put_chapter_outline(
    client: TestClient,
    headers: dict[str, str],
    work: dict,
    chapter_id: str,
    body: str,
    if_match: str,
    foreshadow: list[dict] | None = None,
):
    payload: dict = {"body": body, "ifMatch": if_match}
    if foreshadow is not None:
        payload["foreshadow"] = foreshadow
    return client.put(
        CH_OUTLINE.format(work_id=work["id"], chapter_id=chapter_id),
        headers=headers,
        json=payload,
    )


# ---- 总纲 ----


def test_general_missing_returns_empty_shell(
    client: TestClient, auth_headers: dict, work: dict
) -> None:
    res = client.get(GENERAL.format(work_id=work["id"]), headers=auth_headers)
    assert res.status_code == 200
    # "还没写总纲"是常态不是错误：空壳 + hash=""（upsert 的创建标记）。
    assert res.json() == {"body": "", "hash": ""}


def test_general_put_creates_then_updates(
    client: TestClient, auth_headers: dict, work: dict, work_root: Path
) -> None:
    wid = work["id"]
    res = client.put(
        GENERAL.format(work_id=wid),
        headers=auth_headers,
        json={"body": "主线：复仇。", "ifMatch": ""},
    )
    assert res.status_code == 200, res.text
    first_hash = res.json()["hash"]
    assert first_hash != ""

    res = client.get(GENERAL.format(work_id=wid), headers=auth_headers)
    assert res.json()["body"] == "主线：复仇。"

    res = client.put(
        GENERAL.format(work_id=wid),
        headers=auth_headers,
        json={"body": "主线：复仇，并找回自己。", "ifMatch": first_hash},
    )
    assert res.status_code == 200
    assert res.json()["hash"] != first_hash
    # 文件即真源：磁盘上就是这份。
    text = (work_root / "outline" / "总纲.md").read_text(encoding="utf-8")
    assert text == "主线：复仇，并找回自己。"


def test_general_put_with_stale_hash_is_409(
    client: TestClient, auth_headers: dict, work: dict, work_root: Path
) -> None:
    wid = work["id"]
    client.put(
        GENERAL.format(work_id=wid), headers=auth_headers, json={"body": "初稿", "ifMatch": ""}
    )
    # 外部编辑器改文件。
    path = work_root / "outline" / "总纲.md"
    path.write_text(path.read_text(encoding="utf-8") + "外部追加", encoding="utf-8")
    res = client.put(
        GENERAL.format(work_id=wid),
        headers=auth_headers,
        json={"body": "我的修改", "ifMatch": "deadbeefdeadbeef"},
    )
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "EXTERNAL_MODIFIED"


# ---- 卷纲 ----


def _create_volume(
    client: TestClient, headers: dict[str, str], work: dict, title: str, body: str = ""
) -> dict:
    res = client.post(
        VOLUMES.format(work_id=work["id"]),
        headers=headers,
        json={"title": title, "body": body},
    )
    assert res.status_code == 201, res.text
    return res.json()["volume"]


def test_volume_create_assigns_order_and_filename(
    client: TestClient, auth_headers: dict, work: dict, work_root: Path
) -> None:
    vol = _create_volume(client, auth_headers, work, "云京篇", body="第一卷：入城。")
    assert vol["order"] == 1
    assert vol["slug"] == "云京篇"
    # NNN 双写：文件名前缀 = frontmatter order。
    path = work_root / "outline" / "卷纲" / "001-云京篇.md"
    assert path.is_file()
    vol2 = _create_volume(client, auth_headers, work, "北境篇")
    assert vol2["order"] == 2


def test_volume_duplicate_title_gets_suffix(
    client: TestClient, auth_headers: dict, work: dict
) -> None:
    _create_volume(client, auth_headers, work, "云京篇")
    second = _create_volume(client, auth_headers, work, "云京篇")
    assert second["order"] == 2
    assert second["slug"] == "云京篇-2"


def test_volume_list_and_read(
    client: TestClient, auth_headers: dict, work: dict
) -> None:
    _create_volume(client, auth_headers, work, "云京篇", body="正文")
    res = client.get(VOLUMES.format(work_id=work["id"]), headers=auth_headers)
    items = res.json()["items"]
    assert len(items) == 1
    assert "body" not in items[0]  # 清单不放大字段

    res = client.get(VOLUME.format(work_id=work["id"], order=1), headers=auth_headers)
    assert res.status_code == 200
    assert res.json()["volume"]["body"] == "正文"


def test_volume_read_unknown_order_is_404(
    client: TestClient, auth_headers: dict, work: dict
) -> None:
    res = client.get(VOLUME.format(work_id=work["id"], order=9), headers=auth_headers)
    assert res.status_code == 404
    assert res.json()["error"]["code"] == "OUTLINE_NOT_FOUND"


def test_volume_put_renames_on_title_change(
    client: TestClient, auth_headers: dict, work: dict, work_root: Path
) -> None:
    vol = _create_volume(client, auth_headers, work, "云京篇")
    res = client.put(
        VOLUME.format(work_id=work["id"], order=1),
        headers=auth_headers,
        json={"title": "入城篇", "body": vol.get("body", ""), "ifMatch": vol["hash"]},
    )
    assert res.status_code == 200, res.text
    assert res.json()["volume"]["slug"] == "入城篇"
    # 旧文件名消失：改名 = 新文件 + 删旧文件（D-2 同款）。
    assert not (work_root / "outline" / "卷纲" / "001-云京篇.md").exists()
    assert (work_root / "outline" / "卷纲" / "001-入城篇.md").is_file()


def test_volume_put_to_occupied_order_is_400(
    client: TestClient, auth_headers: dict, work: dict
) -> None:
    vol1 = _create_volume(client, auth_headers, work, "云京篇")
    vol2 = _create_volume(client, auth_headers, work, "北境篇")
    res = client.put(
        VOLUME.format(work_id=work["id"], order=2),
        headers=auth_headers,
        json={"title": vol2["title"], "body": "", "order": 1, "ifMatch": vol2["hash"]},
    )
    assert res.status_code == 400
    assert vol1 is not None


def test_volume_reorder_swaps_atomically(
    client: TestClient, auth_headers: dict, work: dict, work_root: Path
) -> None:
    _create_volume(client, auth_headers, work, "云京篇", body="甲")
    _create_volume(client, auth_headers, work, "北境篇", body="乙")

    res = client.post(
        REORDER.format(work_id=work["id"], order=2),
        headers=auth_headers,
        json={"direction": "up"},
    )
    assert res.status_code == 200, res.text

    # 交换后：北境篇变成第 1 卷、正文跟着走。
    res = client.get(VOLUME.format(work_id=work["id"], order=1), headers=auth_headers)
    volume = res.json()["volume"]
    assert volume["title"] == "北境篇"
    assert volume["body"] == "乙"
    # 文件名前缀与 frontmatter 双写一致。
    assert (work_root / "outline" / "卷纲" / "001-北境篇.md").is_file()
    assert (work_root / "outline" / "卷纲" / "002-云京篇.md").is_file()


def test_volume_reorder_up_at_top_is_400(
    client: TestClient, auth_headers: dict, work: dict
) -> None:
    _create_volume(client, auth_headers, work, "云京篇")
    res = client.post(
        REORDER.format(work_id=work["id"], order=1),
        headers=auth_headers,
        json={"direction": "up"},
    )
    assert res.status_code == 400


def test_volume_delete_then_read_is_404(
    client: TestClient, auth_headers: dict, work: dict
) -> None:
    _create_volume(client, auth_headers, work, "云京篇")
    res = client.delete(VOLUME.format(work_id=work["id"], order=1), headers=auth_headers)
    assert res.status_code == 200
    res = client.get(VOLUME.format(work_id=work["id"], order=1), headers=auth_headers)
    assert res.status_code == 404


# ---- 章纲 ----


def test_chapter_outline_missing_returns_shell(
    client: TestClient, auth_headers: dict, work: dict
) -> None:
    cid = _chapter_id(client, auth_headers, work)
    res = client.get(CH_OUTLINE.format(work_id=work["id"], chapter_id=cid), headers=auth_headers)
    assert res.status_code == 200
    outline = res.json()["outline"]
    assert outline == {"chapterId": cid, "foreshadow": [], "body": "", "hash": ""}


def test_chapter_outline_put_validates_chapter_exists(
    client: TestClient, auth_headers: dict, work: dict
) -> None:
    res = client.put(
        CH_OUTLINE.format(work_id=work["id"], chapter_id="ch_不存在"),
        headers=auth_headers,
        json={"body": "x", "ifMatch": ""},
    )
    assert res.status_code == 404
    assert res.json()["error"]["code"] == "CHAPTER_NOT_FOUND"


def test_chapter_outline_round_trip_with_foreshadow_ids_filled(
    client: TestClient, auth_headers: dict, work: dict, work_root: Path
) -> None:
    cid = _chapter_id(client, auth_headers, work)
    res = _put_chapter_outline(
        client,
        auth_headers,
        work,
        cid,
        body="本章目标：主角入城。",
        if_match="",
        foreshadow=[{"title": "袖中铜符", "expectResolveBy": 1}],
    )
    assert res.status_code == 200, res.text
    outline = res.json()["outline"]
    # 客户端没带 id → 服务端补 fs_ 前缀。
    assert outline["foreshadow"][0]["id"].startswith("fs_")
    assert outline["foreshadow"][0]["status"] == "open"

    # 重读一致（含 id）。
    res = client.get(CH_OUTLINE.format(work_id=work["id"], chapter_id=cid), headers=auth_headers)
    assert res.json()["outline"] == outline


def test_chapter_outline_put_foreshadow_omitted_preserves_existing(
    client: TestClient, auth_headers: dict, work: dict
) -> None:
    cid = _chapter_id(client, auth_headers, work)
    res = _put_chapter_outline(
        client, auth_headers, work, cid, body="第一版", if_match="",
        foreshadow=[{"title": "袖中铜符"}],
    )
    first = res.json()["outline"]

    # 第二次 PUT 只改 body、不回声 foreshadow → 伏笔保留。
    res = _put_chapter_outline(
        client, auth_headers, work, cid, body="第二版", if_match=first["hash"]
    )
    second = res.json()["outline"]
    assert second["body"] == "第二版"
    assert second["foreshadow"] == first["foreshadow"]

    # 显式传 [] 才是清空。
    res = _put_chapter_outline(
        client, auth_headers, work, cid, body="第三版", if_match=second["hash"], foreshadow=[]
    )
    assert res.json()["outline"]["foreshadow"] == []


def test_chapter_outline_put_stale_hash_is_409(
    client: TestClient, auth_headers: dict, work: dict, work_root: Path
) -> None:
    cid = _chapter_id(client, auth_headers, work)
    _put_chapter_outline(client, auth_headers, work, cid, body="第一版", if_match="")
    # 外部删除文件 = 外部修改（不能静默复活成自己的版本）。
    (work_root / "outline" / "章纲" / f"{cid}.md").unlink()
    res = _put_chapter_outline(
        client, auth_headers, work, cid, body="我的版本", if_match="0" * 16
    )
    assert res.status_code == 409


def test_chapter_outline_handwritten_file_without_chapter_id(
    client: TestClient, auth_headers: dict, work: dict, work_root: Path
) -> None:
    """手写章纲忘了 frontmatter 的 chapterId：文件名是真源（D-3），照样能读。"""
    cid = _chapter_id(client, auth_headers, work)
    path = work_root / "outline" / "章纲" / f"{cid}.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "---\nforeshadow:\n  - id: fs_manual_0\n    title: 手补的伏笔\n"
        "    status: open\n---\n手写正文\n",
        encoding="utf-8",
    )
    res = client.get(CH_OUTLINE.format(work_id=work["id"], chapter_id=cid), headers=auth_headers)
    outline = res.json()["outline"]
    assert outline["chapterId"] == cid
    assert outline["foreshadow"][0]["title"] == "手补的伏笔"

    # 写回时占位 id 被换成正式 id（不留 manual 名字）。
    res = _put_chapter_outline(
        client, auth_headers, work, cid, body="手写正文", if_match=outline["hash"],
        foreshadow=outline["foreshadow"],
    )
    new_id = res.json()["outline"]["foreshadow"][0]["id"]
    assert new_id.startswith("fs_")
    assert not new_id.startswith("fs_manual")


# ---- 伏笔聚合 ----


def _register_foreshadow(
    client: TestClient, headers: dict[str, str], work: dict, chapter_id: str,
    title: str, *, expect: int | None = None, status: str = "open", current_hash: str = "",
    foreshadow: list[dict] | None = None,
) -> dict:
    if foreshadow is None:
        foreshadow = [{"title": title, "expectResolveBy": expect, "status": status}]
    res = _put_chapter_outline(
        client, headers, work, chapter_id, body="", if_match=current_hash,
        foreshadow=foreshadow,
    )
    assert res.status_code == 200, res.text
    return res.json()["outline"]


def test_foreshadows_lists_entries_with_source_chapter(
    client: TestClient, auth_headers: dict, work: dict
) -> None:
    cid = _chapter_id(client, auth_headers, work)
    _register_foreshadow(client, auth_headers, work, cid, "袖中铜符")
    res = client.get(FORESHADOWS.format(work_id=work["id"]), headers=auth_headers)
    items = res.json()["items"]
    assert len(items) == 1
    assert items[0]["chapterId"] == cid
    assert items[0]["title"] == "袖中铜符"
    assert items[0]["status"] == "open"
    # 没建卷 / 没定期限 → 不超期、不孤儿。
    assert items[0]["overdue"] is False
    assert items[0]["orphan"] is False


def test_foreshadows_overdue_boundary(
    client: TestClient, auth_headers: dict, work: dict
) -> None:
    """超期 = open + 有期望卷 + 已建更后面的卷。三个条件缺一不可。"""
    cid = _chapter_id(client, auth_headers, work)
    outline = _register_foreshadow(
        client, auth_headers, work, cid, "期望第一卷回收", expect=1
    )
    # 还没建任何卷 → 不超期（没有"进度"就没有"超期"）。
    res = client.get(FORESHADOWS.format(work_id=work["id"]), headers=auth_headers)
    assert res.json()["items"][0]["overdue"] is False

    # 建了第一卷：期望 1、进度 1 → 仍未超期（边界是"超过"，不是"到达"）。
    _create_volume(client, auth_headers, work, "云京篇")
    res = client.get(FORESHADOWS.format(work_id=work["id"]), headers=auth_headers)
    assert res.json()["items"][0]["overdue"] is False

    # 建了第二卷：进度 2 > 期望 1 → 超期。
    _create_volume(client, auth_headers, work, "北境篇")
    res = client.get(FORESHADOWS.format(work_id=work["id"]), headers=auth_headers)
    assert res.json()["items"][0]["overdue"] is True

    # 标记 resolved 后不再提醒（哪怕进度已越过）。
    _register_foreshadow(
        client, auth_headers, work, cid, "期望第一卷回收",
        foreshadow=[{**outline["foreshadow"][0], "status": "resolved"}],
        current_hash=outline["hash"],
    )
    res = client.get(FORESHADOWS.format(work_id=work["id"]), headers=auth_headers)
    assert res.json()["items"][0]["overdue"] is False
    assert res.json()["items"][0]["status"] == "resolved"


def test_foreshadows_marks_orphaned_chapter_outline(
    client: TestClient, auth_headers: dict, work: dict, work_root: Path
) -> None:
    """章节已删但章纲还在（D-3 的"孤儿"）：聚合带事实，不静默丢弃。"""
    # 直接在磁盘上造一个指向不存在章节的章纲。
    directory = work_root / "outline" / "章纲"
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "ch_deletedbeef.md").write_text(
        "---\nchapterId: ch_deletedbeef\nforeshadow:\n  - id: fs_1\n"
        "    title: 孤儿伏笔\n    status: open\n---\n\n",
        encoding="utf-8",
    )
    res = client.get(FORESHADOWS.format(work_id=work["id"]), headers=auth_headers)
    items = res.json()["items"]
    assert len(items) == 1
    assert items[0]["orphan"] is True


def test_foreshadows_duplicate_ids_rejected(
    client: TestClient, auth_headers: dict, work: dict
) -> None:
    cid = _chapter_id(client, auth_headers, work)
    res = _put_chapter_outline(
        client, auth_headers, work, cid, body="", if_match="",
        foreshadow=[
            {"id": "fs_same", "title": "甲"},
            {"id": "fs_same", "title": "乙"},
        ],
    )
    assert res.status_code == 400
