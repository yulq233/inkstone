"""最近打开的作品列表。

存在 ``<userData>/recent-works.json``（不是作品目录内）—— 这是"应用状态"，
不是"作品数据"。用户把作品目录拷走时，不该带走别人的打开记录。

``exists`` 字段是**读取时现算**的，不落盘：目录被移动或删除后，
存下来的"存在"就是错的。UI 据此灰显并提供「从列表移除」。
"""

from __future__ import annotations

import json
import os
from contextlib import suppress
from pathlib import Path
from typing import Any

from ..domain.clock import now_iso
from ..domain.paths import WORK_JSON
from .atomic import atomic_write_text

RECENT_FILENAME = "recent-works.json"
MAX_ENTRIES = 20
SCHEMA_VERSION = 1


def _key(root_path: str) -> str:
    """去重键。Windows 上 ``D:\\小说`` 与 ``d:\\小说`` 是同一个目录，必须归一。"""
    return os.path.normcase(os.path.abspath(root_path))


def _root_of(entry: Any) -> str:
    """从一条记录里取 rootPath；非对象条目一律当空处理（用户可能手改过文件）。"""
    if not isinstance(entry, dict):
        return ""
    value = entry.get("rootPath")
    return value if isinstance(value, str) else ""


class RecentStore:
    def __init__(self, home: Path) -> None:
        self._path = Path(home) / RECENT_FILENAME

    # ---- 读 ----

    def _load(self) -> list[dict[str, Any]]:
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            # 列表损坏不值得打断启动，直接当空列表重建。
            return []
        items = raw.get("items") if isinstance(raw, dict) else None
        return items if isinstance(items, list) else []

    def list_entries(self) -> list[dict[str, Any]]:
        """按 lastOpenedAt 倒序返回，附带现算的 ``exists``。

        方法名**不能叫 `list`**：那会把内置 `list` 遮蔽掉，于是同类内
        `_save(self, items: list[dict[str, Any]])` 的注解里，`list` 被解析成
        这个方法而不是内置类型 —— mypy 报 `[valid-type]: Function ... is not valid as a type`，
        而且只在 `--strict` 下才看得见。方法名遮蔽内置名是这种错误唯一的成因。
        """
        result: list[dict[str, Any]] = []
        for entry in self._load():
            root_path = _root_of(entry)
            if not root_path:
                # 用户可能手动编辑过这个文件。坏条目直接跳过，不要让整个
                # 最近列表因此炸掉 —— 它只是便利功能，不该有能力阻断启动。
                continue
            result.append(
                {
                    "rootPath": root_path,
                    "title": entry.get("title") or Path(root_path).name,
                    "lastOpenedAt": entry.get("lastOpenedAt", ""),
                    "exists": (Path(root_path) / WORK_JSON).is_file(),
                }
            )
        result.sort(key=lambda item: item["lastOpenedAt"], reverse=True)
        return result

    # ---- 写 ----

    def touch(self, *, root_path: str, title: str) -> None:
        key = _key(root_path)
        items = [e for e in self._load() if _key(_root_of(e)) != key]
        items.insert(0, {"rootPath": root_path, "title": title, "lastOpenedAt": now_iso()})
        self._save(items[:MAX_ENTRIES])

    def remove(self, root_path: str) -> bool:
        key = _key(root_path)
        items = self._load()
        kept = [e for e in items if _key(_root_of(e)) != key]
        if len(kept) == len(items):
            return False
        self._save(kept)
        return True

    def _save(self, items: list[dict[str, Any]]) -> None:
        payload = {"schemaVersion": SCHEMA_VERSION, "items": items}
        with suppress(OSError):
            self._path.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_text(
            self._path, json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
        )
