"""Codex（设定条目）端点 —— ``docs/15`` §2.3 B1。

与章节端点同一立场：读写直连 sidecar，不过 IPC。鉴权由全局中间件统一兜，
路由层只表达"发生了什么"，错误翻译全在 ``errors.py`` / ``app.py``。

路由形状为什么是 ``/codex/{type}/{slug}`` 两段而不是单段 id：
codex 没有"机器 id"——slug（文件名）**就是**稳定键（D-2），type 决定目录。
给条目再造一套 ``cx_xxx`` id 等于在文件系统之上养第二套身份体系，
两边必然漂移（章节有 id 是因为目录名前缀会随重排变化，codex 没有这个问题）。
"""

from __future__ import annotations

from typing import cast

from fastapi import APIRouter, Request

from ...domain.codex import CodexEntry
from ...storage.codex_store import CodexStore
from .schemas import CreateCodexRequest, UpdateCodexRequest

router = APIRouter()


def _store(request: Request) -> CodexStore:
    # 与 chapters.py 的 _registry 同理：app.state 是 Any，cast 是声明式收敛。
    return cast(CodexStore, request.app.state.codex)


@router.get("/works/{work_id}/codex")
async def list_codex(work_id: str, request: Request) -> dict[str, object]:
    items = await _store(request).list_entries(work_id)
    return {"items": items}


@router.post("/works/{work_id}/codex", status_code=201)
async def create_codex(
    work_id: str, body: CreateCodexRequest, request: Request
) -> dict[str, object]:
    entry = await _store(request).create_entry(work_id, CodexEntry.model_validate(body))
    return {"entry": entry}


@router.get("/works/{work_id}/codex/broken-relations")
async def broken_relations(work_id: str, request: Request) -> dict[str, object]:
    """断链清单（D-2）：relations 指向的 slug 已不存在的条目。

    路径段数比 ``/{type}/{slug}`` 少一段，与它不冲突；
    但仍声明在它前面，让"字面量路径优先于参数路径"成为可见的约定。
    """
    items = await _store(request).broken_relations(work_id)
    return {"items": items}


@router.get("/works/{work_id}/codex/{entry_type}/{slug}")
async def read_codex(
    work_id: str, entry_type: str, slug: str, request: Request
) -> dict[str, object]:
    entry = await _store(request).read_entry(work_id, entry_type, slug)
    return {"entry": entry}


@router.put("/works/{work_id}/codex/{entry_type}/{slug}")
async def write_codex(
    work_id: str, entry_type: str, slug: str, body: UpdateCodexRequest, request: Request
) -> dict[str, object]:
    entry = await _store(request).write_entry(
        work_id, entry_type, slug, CodexEntry.model_validate(body), body.ifMatch
    )
    return {"entry": entry}


@router.delete("/works/{work_id}/codex/{entry_type}/{slug}")
async def delete_codex(
    work_id: str, entry_type: str, slug: str, request: Request
) -> dict[str, object]:
    return await _store(request).delete_entry(work_id, entry_type, slug)
