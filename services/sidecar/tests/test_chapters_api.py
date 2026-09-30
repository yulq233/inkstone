"""章节接口契约（03 文档 §7.2）。

A3「切换章节不丢内容」与 A5「外部改动被拦下」的核心逻辑都在这里。
"""

from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient

CHAPTERS = "/api/v1/works/{work_id}/chapters"
CHAPTER = "/api/v1/works/{work_id}/chapters/{chapter_id}"


def _list(
    client: TestClient, headers: dict[str, str], work: dict, *, refresh: bool = False
) -> list[dict]:
    res = client.get(
        CHAPTERS.format(work_id=work["id"]),
        headers=headers,
        params={"refresh": "true"} if refresh else None,
    )
    assert res.status_code == 200, res.text
    return res.json()["items"]


def _read(client: TestClient, headers: dict[str, str], work: dict, chapter_id: str) -> dict:
    res = client.get(
        CHAPTER.format(work_id=work["id"], chapter_id=chapter_id), headers=headers
    )
    assert res.status_code == 200, res.text
    return res.json()["chapter"]


def _put(
    client: TestClient,
    headers: dict[str, str],
    work: dict,
    chapter_id: str,
    markdown: str,
    base: str,
    *,
    backup: bool = False,
):
    body: dict = {"markdown": markdown, "baseHash": base}
    if backup:
        body["backup"] = True
    return client.put(
        CHAPTER.format(work_id=work["id"], chapter_id=chapter_id),
        headers=headers,
        json=body,
    )


# ---- 列表 ----


def test_list_returns_seeded_first_chapter(
    client: TestClient, auth_headers: dict, work: dict
) -> None:
    items = _list(client, auth_headers, work)
    assert len(items) == 1
    first = items[0]
    assert first["order"] == 1
    assert first["title"] == "第一章"
    assert first["dirName"] == "001-第一章"
    assert first["status"] == "draft"
    assert first["id"].startswith("ch_")


def test_list_requires_token(client: TestClient) -> None:
    assert client.get(CHAPTERS.format(work_id="w_x")).status_code == 401


def test_list_of_unknown_work_is_404(client: TestClient, auth_headers: dict) -> None:
    res = client.get(CHAPTERS.format(work_id="w_不存在"), headers=auth_headers)
    assert res.status_code == 404
    assert res.json()["error"]["code"] == "WORK_NOT_FOUND"


# ---- 新建 ----


def test_create_chapter_appends_at_the_end(
    client: TestClient, auth_headers: dict, work: dict, work_root: Path
) -> None:
    res = client.post(
        CHAPTERS.format(work_id=work["id"]),
        headers=auth_headers,
        json={"title": "第二章", "afterChapterId": None},
    )
    assert res.status_code == 201, res.text
    chapter = res.json()["chapter"]

    assert chapter["order"] == 2
    assert chapter["dirName"] == "002-第二章"
    assert (work_root / "manuscript" / "002-第二章" / "chapter.md").read_text(
        encoding="utf-8"
    ) == "# 第二章\n\n"


def test_create_chapter_rejects_blank_title(
    client: TestClient, auth_headers: dict, work: dict
) -> None:
    res = client.post(
        CHAPTERS.format(work_id=work["id"]), headers=auth_headers, json={"title": "  "}
    )
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "INVALID_PARAM"


def test_insert_middle_renumbers_but_keeps_ids(
    client: TestClient, auth_headers: dict, work: dict, work_root: Path
) -> None:
    """插入章节会批量重命名目录，但 **id 不变**。

    这是"批注锚点不因重排失效"这条设计的落地验证。若这里 id 变了，
    将来所有引用章节的东西（批注、快照、AI 记录）都会在用户插入一章之后集体失效。
    """
    second = client.post(
        CHAPTERS.format(work_id=work["id"]),
        headers=auth_headers,
        json={"title": "第二章", "afterChapterId": None},
    ).json()["chapter"]

    first_id = _list(client, auth_headers, work)[0]["id"]
    inserted = client.post(
        CHAPTERS.format(work_id=work["id"]),
        headers=auth_headers,
        json={"title": "插入章", "afterChapterId": first_id},
    )
    assert inserted.status_code == 201, inserted.text
    new_chapter = inserted.json()["chapter"]

    assert new_chapter["order"] == 2
    assert new_chapter["dirName"] == "002-插入章"

    items = _list(client, auth_headers, work)
    assert [(i["order"], i["title"]) for i in items] == [
        (1, "第一章"),
        (2, "插入章"),
        (3, "第二章"),
    ]
    # 原来的"第二章"往后挪了一格，但 id 必须原封不动。
    moved = next(i for i in items if i["title"] == "第二章")
    assert moved["id"] == second["id"]
    assert moved["dirName"] == "003-第二章"

    # 磁盘上也要真的改过名，而且旧目录不能残留。
    manuscript = work_root / "manuscript"
    assert (manuscript / "003-第二章" / "chapter.md").is_file()
    assert (manuscript / "002-插入章" / "chapter.md").is_file()
    assert not (manuscript / "002-第二章").exists()


def test_insert_reports_unknown_anchor(
    client: TestClient, auth_headers: dict, work: dict
) -> None:
    res = client.post(
        CHAPTERS.format(work_id=work["id"]),
        headers=auth_headers,
        json={"title": "新章", "afterChapterId": "ch_不存在"},
    )
    assert res.status_code == 404
    assert res.json()["error"]["code"] == "CHAPTER_NOT_FOUND"


def test_renumbered_chapter_meta_follows_its_directory(
    client: TestClient, auth_headers: dict, work: dict, work_root: Path
) -> None:
    """重排后 meta.json 的 order 必须跟目录名前缀一致。

    两个"真相"不一致时，调试一个错位的章节会让人怀疑人生。
    """
    second = client.post(
        CHAPTERS.format(work_id=work["id"]),
        headers=auth_headers,
        json={"title": "第二章", "afterChapterId": None},
    ).json()["chapter"]
    first_id = _list(client, auth_headers, work)[0]["id"]
    client.post(
        CHAPTERS.format(work_id=work["id"]),
        headers=auth_headers,
        json={"title": "插入章", "afterChapterId": first_id},
    )

    manuscript = work_root / "manuscript"
    for order, dirname in ((2, "002-插入章"), (3, "003-第二章")):
        meta = json.loads((manuscript / dirname / "meta.json").read_text(encoding="utf-8"))
        assert meta["order"] == order

    # 被挪动的章节是"原地改名 + 更新 meta"，不是"删掉重建" —— 所以 id 必须还是原来那个。
    moved = json.loads((manuscript / "003-第二章" / "meta.json").read_text(encoding="utf-8"))
    assert moved["id"] == second["id"]


# ---- 读取 ----


def test_read_chapter_returns_markdown_and_hash(
    client: TestClient, auth_headers: dict, work: dict
) -> None:
    chapter_id = _list(client, auth_headers, work)[0]["id"]
    chapter = _read(client, auth_headers, work, chapter_id)

    assert chapter["markdown"] == "# 第一章\n\n"
    assert len(chapter["hash"]) == 16
    assert chapter["wordCount"] == 3  # 「第一章」三个字；# 与空格分别算标点与空白
    assert chapter["savedAt"] is None or chapter["savedAt"].startswith("20")


def test_read_unknown_chapter_is_404(client: TestClient, auth_headers: dict, work: dict) -> None:
    res = client.get(
        CHAPTER.format(work_id=work["id"], chapter_id="ch_不存在"), headers=auth_headers
    )
    assert res.status_code == 404
    assert res.json()["error"]["code"] == "CHAPTER_NOT_FOUND"


def test_chapter_id_from_another_work_is_not_found(
    client: TestClient, auth_headers: dict, work: dict, parent_dir: Path
) -> None:
    """带上 workId 之后不会"串作品" —— 拿 A 作品的章节 id 问 B 作品必须 404。"""
    other = client.post(
        "/api/v1/works",
        headers=auth_headers,
        json={"parentDir": str(parent_dir), "title": "另一本"},
    ).json()["work"]
    foreign_id = _list(client, auth_headers, other)[0]["id"]

    res = client.get(
        CHAPTER.format(work_id=work["id"], chapter_id=foreign_id), headers=auth_headers
    )
    assert res.status_code == 404


def test_title_falls_back_when_first_line_is_not_a_heading(
    client: TestClient, auth_headers: dict, work: dict, work_root: Path
) -> None:
    """首行不是 ATX 标题时回退为「未命名」，而不是抓一行正文当标题。

    这里必须 refresh：外部只改章节正文并不会改动 ``manuscript`` 目录的 mtime，
    所以按设计（03 文档 §4.6）缓存不会自动失效 —— 只有显式 refresh 才重扫。
    """
    chapter_dir = work_root / "manuscript" / "001-第一章"
    (chapter_dir / "chapter.md").write_text("他推开门。\n", encoding="utf-8")

    items = _list(client, auth_headers, work, refresh=True)
    assert items[0]["title"] == "未命名"


def test_read_refuses_non_utf8_chapter(
    client: TestClient, auth_headers: dict, work: dict, work_root: Path
) -> None:
    """非 UTF-8 正文必须**拒绝打开**，而不是 ``errors="replace"`` 之后照常回存。

    ``replace`` 会把解不出来的字节换成 U+FFFD，而保存时按 UTF-8 回写 —— 原稿字节被
    **不可逆地**破坏。更隐蔽的是 read 返回的 hash 算的是**原始字节**，那份替换后的文本
    回存时哈希对得上，冲突检测拦不住。所以这里要 400 + NOT_UTF8，让用户先转码。
    """
    chapter_dir = work_root / "manuscript" / "001-第一章"
    # 「第」的 GBK 字节是 \xb5\xda，其中 \xb5 落在 UTF-8 的"续接字节"区间 ——
    # 整段字节流不是合法 UTF-8（换成「章」就测不出来：\xd5\xc2 恰好能被 UTF-8 解成别的字）。
    (chapter_dir / "chapter.md").write_bytes("# 第一章\n\n他推开门。\n".encode("gbk"))

    chapter_id = _list(client, auth_headers, work)[0]["id"]
    res = client.get(
        CHAPTER.format(work_id=work["id"], chapter_id=chapter_id), headers=auth_headers
    )

    assert res.status_code == 400, res.text
    assert res.json()["error"]["code"] == "NOT_UTF8"


def test_read_tolerates_a_utf8_bom(
    client: TestClient, auth_headers: dict, work: dict, work_root: Path
) -> None:
    """带 BOM 的 UTF-8 要能正常读。

    Windows 记事本「另存为 UTF-8」默认加 BOM；而 BOM 不会被 ``str.strip()`` 去掉
    （U+FEFF 的 ``isspace()`` 是 False），不处理的话首行标题匹配失败、章节显示成「未命名」。
    """
    chapter_dir = work_root / "manuscript" / "001-第一章"
    (chapter_dir / "chapter.md").write_bytes("# 第一章 雪夜\n\n他推开门。\n".encode("utf-8-sig"))

    chapter_id = _list(client, auth_headers, work)[0]["id"]
    chapter = _read(client, auth_headers, work, chapter_id)

    assert chapter["markdown"].startswith("# 第一章")
    assert "\ufeff" not in chapter["markdown"]
    # 列表路径也要一起去 BOM，否则标题会退回「未命名」
    assert _list(client, auth_headers, work, refresh=True)[0]["title"] == "第一章 雪夜"


# ---- 写入与乐观并发 ----


def test_write_updates_content_and_hash(
    client: TestClient, auth_headers: dict, work: dict, work_root: Path
) -> None:
    chapter_id = _list(client, auth_headers, work)[0]["id"]
    before = _read(client, auth_headers, work, chapter_id)

    body = "# 第一章 初入宗门\n\n他推开门，风雪灌了进来。\n"
    res = _put(client, auth_headers, work, chapter_id, body, before["hash"])
    assert res.status_code == 200, res.text
    saved = res.json()

    assert saved["hash"] != before["hash"]
    # 「第一章」3 + 「初入宗门」4 + 「他推开门」4 + 「风雪灌了进来」6 = 17（标点不计）
    assert saved["wordCount"] == 17
    assert (work_root / "manuscript" / "001-第一章" / "chapter.md").read_text(
        encoding="utf-8"
    ) == body

    after = _read(client, auth_headers, work, chapter_id)
    assert after["markdown"] == body
    assert after["hash"] == saved["hash"]


def test_write_updates_title_from_first_line(
    client: TestClient, auth_headers: dict, work: dict
) -> None:
    """标题的真源是正文首行 —— 改标题就是改正文，列表要跟着变。"""
    chapter_id = _list(client, auth_headers, work)[0]["id"]
    base = _read(client, auth_headers, work, chapter_id)["hash"]
    _put(client, auth_headers, work, chapter_id, "# 改名了\n\n正文\n", base)

    assert _list(client, auth_headers, work)[0]["title"] == "改名了"


def test_write_does_not_leak_crlf_to_disk(
    client: TestClient, auth_headers: dict, work: dict, work_root: Path
) -> None:
    chapter_id = _list(client, auth_headers, work)[0]["id"]
    base = _read(client, auth_headers, work, chapter_id)["hash"]
    _put(client, auth_headers, work, chapter_id, "# 第一章\n\n甲\n乙\n", base)

    assert b"\r\n" not in (work_root / "manuscript" / "001-第一章" / "chapter.md").read_bytes()


def test_write_is_refused_when_file_changed_externally(
    client: TestClient, auth_headers: dict, work: dict, work_root: Path
) -> None:
    """A5 的核心：用户在 VS Code 里改过文件，应用的保存必须被拦下。"""
    chapter_id = _list(client, auth_headers, work)[0]["id"]
    stale_hash = _read(client, auth_headers, work, chapter_id)["hash"]

    # 模拟外部编辑器改写
    md = work_root / "manuscript" / "001-第一章" / "chapter.md"
    md.write_text("# 第一章\n\n（这段是外部写的）\n", encoding="utf-8")

    res = _put(client, auth_headers, work, chapter_id, "# 第一章\n\n（应用里的稿子）\n", stale_hash)

    assert res.status_code == 409
    error = res.json()["error"]
    assert error["code"] == "EXTERNAL_MODIFIED"
    # 冲突必须把磁盘版本一起带回来，否则用户没法决定保留哪一份。
    assert "（这段是外部写的）" in error["detail"]["diskMarkdown"]
    assert error["detail"]["diskHash"] != stale_hash
    assert error["detail"]["diskSavedAt"].startswith("20")

    # 而且**绝不能**把用户的稿子写进去。
    assert "（应用里的稿子）" not in md.read_text(encoding="utf-8")


def test_write_detects_a_single_trailing_space(
    client: TestClient, auth_headers: dict, work: dict, work_root: Path
) -> None:
    """哈希基于原始字节：外部只多了一个行尾空格也算改动。"""
    chapter_id = _list(client, auth_headers, work)[0]["id"]
    base = _read(client, auth_headers, work, chapter_id)["hash"]

    md = work_root / "manuscript" / "001-第一章" / "chapter.md"
    md.write_text("# 第一章 \n\n", encoding="utf-8")

    assert _put(client, auth_headers, work, chapter_id, "# 第一章\n\n", base).status_code == 409


def test_second_write_with_stale_hash_is_refused(
    client: TestClient, auth_headers: dict, work: dict
) -> None:
    """保存不能"后写者通吃"。

    若两次并发 PUT 都放行，先到的旧内容可能覆盖后到的新内容 —— 用户看到的是
    "我刚打的字没了"。所以第一次成功后，用旧的 baseHash 再写必须被拒。
    """
    chapter_id = _list(client, auth_headers, work)[0]["id"]
    base = _read(client, auth_headers, work, chapter_id)["hash"]

    ok = _put(client, auth_headers, work, chapter_id, "# 第一章\n\n第一次\n", base)
    assert ok.status_code == 200
    stale = _put(client, auth_headers, work, chapter_id, "# 第一章\n\n第二次\n", base)
    assert stale.status_code == 409


def test_write_with_fresh_hash_after_conflict_succeeds(
    client: TestClient, auth_headers: dict, work: dict
) -> None:
    """冲突解决后要能继续保存（前端"重载"路径就是先取新 hash 再写）。"""
    chapter_id = _list(client, auth_headers, work)[0]["id"]
    base = _read(client, auth_headers, work, chapter_id)["hash"]
    _put(client, auth_headers, work, chapter_id, "# 第一章\n\n甲\n", base)

    fresh = _read(client, auth_headers, work, chapter_id)["hash"]
    again = _put(client, auth_headers, work, chapter_id, "# 第一章\n\n乙\n", fresh)
    assert again.status_code == 200


def test_write_persists_word_count_cache(
    client: TestClient, auth_headers: dict, work: dict, work_root: Path
) -> None:
    chapter_id = _list(client, auth_headers, work)[0]["id"]
    base = _read(client, auth_headers, work, chapter_id)["hash"]
    _put(client, auth_headers, work, chapter_id, "# 第一章\n\n他推开门。\n", base)

    meta = json.loads(
        (work_root / "manuscript" / "001-第一章" / "meta.json").read_text(encoding="utf-8")
    )
    assert meta["wordCountCache"] == 7  # 「第一章」3 + 「他推开门」4


def test_write_requires_token(client: TestClient, auth_headers: dict, work: dict) -> None:
    chapter_id = _list(client, auth_headers, work)[0]["id"]
    res = client.put(
        CHAPTER.format(work_id=work["id"], chapter_id=chapter_id),
        json={"markdown": "x", "baseHash": "0" * 16},
    )
    assert res.status_code == 401


# ---- 冲突覆盖前的备份（03 文档 §6.6 的底线）----


def test_plain_save_creates_no_backup(
    client: TestClient, auth_headers: dict, work: dict, work_root: Path
) -> None:
    """普通保存不留备份 —— 否则备份目录会被日常输入的每一版撑爆。"""
    chapter_id = _list(client, auth_headers, work)[0]["id"]
    base = _read(client, auth_headers, work, chapter_id)["hash"]
    saved = _put(client, auth_headers, work, chapter_id, "# 第一章\n\n甲\n", base).json()

    assert saved["backupPath"] is None
    assert list((work_root / ".inkstone" / "backups").iterdir()) == []


def test_forced_overwrite_backs_up_disk_version_first(
    client: TestClient, auth_headers: dict, work: dict, work_root: Path
) -> None:
    """A5 的后半段：用户在冲突里选"保留我的并覆盖"，磁盘版本必须先落备份。

    这是"不静默丢用户内容"的最后一道防线 —— 覆盖是用户自己选的，但选错了
    得能反悔。没有这一步，被覆盖的那一版就真的没了。
    """
    chapter_id = _list(client, auth_headers, work)[0]["id"]
    stale_hash = _read(client, auth_headers, work, chapter_id)["hash"]

    md = work_root / "manuscript" / "001-第一章" / "chapter.md"
    external_body = "# 第一章\n\n（这段是外部写的）\n"
    md.write_text(external_body, encoding="utf-8")

    # 第一次：冲突，应用不许覆盖。
    conflict = _put(
        client, auth_headers, work, chapter_id, "# 第一章\n\n（应用里的稿子）\n", stale_hash
    )
    assert conflict.status_code == 409
    disk_hash = conflict.json()["error"]["detail"]["diskHash"]

    # 第二次：用户明确选择覆盖 —— 用 diskHash 作 baseHash，并声明要备份。
    res = _put(
        client,
        auth_headers,
        work,
        chapter_id,
        "# 第一章\n\n（应用里的稿子）\n",
        disk_hash,
        backup=True,
    )
    assert res.status_code == 200, res.text
    backup_path = res.json()["backupPath"]
    assert backup_path is not None

    backup = Path(backup_path)
    assert backup.is_file()
    assert backup.parent == work_root / ".inkstone" / "backups"
    # 备份里必须是**被覆盖掉的**那一版，不是刚写进去的新版。
    assert backup.read_text(encoding="utf-8") == external_body
    # 正文已换成应用里的版本。
    assert "（应用里的稿子）" in md.read_text(encoding="utf-8")


def test_backup_filename_is_filesystem_safe(
    client: TestClient, auth_headers: dict, work: dict, work_root: Path
) -> None:
    """备份文件名不能含 ``:`` —— 那在 Windows 上直接创建失败。

    也不能直接用 ``now_iso()``，它长这样：``2026-09-20T10:15:30+08:00``。
    """
    chapter_id = _list(client, auth_headers, work)[0]["id"]
    base = _read(client, auth_headers, work, chapter_id)["hash"]
    _put(client, auth_headers, work, chapter_id, "# 第一章\n\n甲\n", base, backup=True)

    backups = list((work_root / ".inkstone" / "backups").iterdir())
    assert len(backups) == 1
    name = backups[0].name
    assert ":" not in name
    assert name.startswith(f"{chapter_id}-")
    assert name.endswith(".md")


def test_no_backup_when_there_is_no_old_version(
    client: TestClient, auth_headers: dict, work: dict, work_root: Path
) -> None:
    """磁盘上没有正文时没有"旧版"可备份，不该留下 0 字节垃圾文件。

    （用户在资源管理器里删了 chapter.md，随后在应用里选择覆盖 —— 这是真实会发生的。）
    """
    chapter_id = _list(client, auth_headers, work)[0]["id"]
    stale_hash = _read(client, auth_headers, work, chapter_id)["hash"]
    (work_root / "manuscript" / "001-第一章" / "chapter.md").unlink()

    conflict = _put(client, auth_headers, work, chapter_id, "# 第一章\n\n甲\n", stale_hash)
    assert conflict.status_code == 409
    detail = conflict.json()["error"]["detail"]
    assert detail["diskMarkdown"] == ""
    assert detail["diskSavedAt"] is None

    res = _put(
        client,
        auth_headers,
        work,
        chapter_id,
        "# 第一章\n\n甲\n",
        detail["diskHash"],
        backup=True,
    )
    assert res.status_code == 200, res.text
    assert res.json()["backupPath"] is None
    assert list((work_root / ".inkstone" / "backups").iterdir()) == []


# ---- 外部增删的感知 ----


def test_chapter_created_outside_the_app_shows_up(
    client: TestClient, auth_headers: dict, work: dict, work_root: Path
) -> None:
    """M0 不做文件监听，但列表要能感知外部新增的章节。"""
    external = work_root / "manuscript" / "002-外部加的章"
    external.mkdir()
    (external / "chapter.md").write_text("# 外部加的章\n\n内容\n", encoding="utf-8")
    (external / "meta.json").write_text(
        json.dumps({"schemaVersion": 1, "id": "ch_external0001", "order": 2, "status": "draft"}),
        encoding="utf-8",
    )

    items = _list(client, auth_headers, work)
    assert [(i["order"], i["title"]) for i in items] == [(1, "第一章"), (2, "外部加的章")]


def test_chapter_without_meta_json_is_repaired(
    client: TestClient, auth_headers: dict, work: dict, work_root: Path
) -> None:
    """外部只放了 md 没放 meta.json —— 自愈而不是让整部作品打不开。"""
    external = work_root / "manuscript" / "002-只有正文"
    external.mkdir()
    (external / "chapter.md").write_text("# 只有正文\n\n内容\n", encoding="utf-8")

    items = _list(client, auth_headers, work)
    assert [i["title"] for i in items] == ["第一章", "只有正文"]
    assert (external / "meta.json").is_file()


def test_unparseable_directory_is_ignored_not_fatal(
    client: TestClient, auth_headers: dict, work: dict, work_root: Path
) -> None:
    """用户会在 manuscript 里塞别的东西，不能因此让章节列表整体失败。"""
    (work_root / "manuscript" / "随手记").mkdir()

    items = _list(client, auth_headers, work)
    assert len(items) == 1


def test_missing_word_count_cache_is_computed_and_written_back(
    client: TestClient, auth_headers: dict, work: dict, work_root: Path
) -> None:
    """`docs/13` M31：meta.json 缺 `wordCountCache` 时必须**现场算**，不能当 0 用。

    这条是 fixture 脚本"刻意不写这个字段"能成立的前提，也钉住了
    `_read_title_and_wordcount` 的分支语义：`None` = "没有缓存，请重算"，
    而不是"0 字"。反过来，**一旦写入就会被永久信任**（列表页只读首行）——
    所以性能基线绝不能塞一个口径不同的近似值进去。
    """
    meta_path = work_root / "manuscript" / "001-第一章" / "meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    meta.pop("wordCountCache")
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    items = _list(client, auth_headers, work, refresh=True)
    # 正文是 `# 第一章\n\n`：`#` 属 Po（标点，不计），"第一章"三个汉字才是字。
    assert items[0]["wordCount"] == 3

    restored = json.loads(meta_path.read_text(encoding="utf-8"))
    assert restored["wordCountCache"] == 3


