"""章节 ``meta.json`` 的 schema。

**核心规则：meta.json 不存任何可从正文推导的信息**（03 文档 §4.3）。

| 存 | 不存 |
|---|---|
| id、order、status、pov、字数缓存 | 标题、正文 |

标题在正文首行（``# 第一章 xxx``），md 是唯一真源。一旦把标题也存进 meta.json，
就出现了两个真相，外部改 md 后必然不一致 —— 这是"文件即真源"最先烂掉的地方。

带 ``Cache`` 后缀的字段语义 = "可随时重建，读不到就现场算"。
"""

from __future__ import annotations

import json
import re
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from ..errors import InvalidParam
from .clock import now_iso
from .ids import new_chapter_id

SUPPORTED_SCHEMA_VERSION = 1

CHAPTER_STATUSES: frozenset[str] = frozenset({"draft", "revising", "done"})

# 只认 ATX 标题（# 开头），不支持 setext —— setext 会让正文里的 `---` 变成标题下划线。
_ATX_RE = re.compile(r"^#{1,6}\s+(.*)$")

TITLE_FALLBACK = "未命名"


class ChapterMeta(BaseModel):
    model_config = ConfigDict(extra="allow", populate_by_name=True)

    schema_version: int = Field(default=SUPPORTED_SCHEMA_VERSION, alias="schemaVersion")
    id: str = Field(default_factory=new_chapter_id)
    order: int = 0
    status: str = "draft"
    pov: str | None = None
    # None 表示"没有缓存"，读取方必须现场重算，而不是当成 0。
    word_count_cache: int | None = Field(default=None, alias="wordCountCache")
    created_at: str = Field(default_factory=now_iso, alias="createdAt")
    updated_at: str = Field(default_factory=now_iso, alias="updatedAt")

    @field_validator("schema_version")
    @classmethod
    def _check_version(cls, value: int) -> int:
        if value != SUPPORTED_SCHEMA_VERSION:
            raise ValueError(f"不支持的 meta.json 版本 {value}，当前只认 {SUPPORTED_SCHEMA_VERSION}。")
        return value

    @field_validator("status")
    @classmethod
    def _check_status(cls, value: str) -> str:
        if value not in CHAPTER_STATUSES:
            raise ValueError(f"未知的章节状态 {value!r}，可选：{'/'.join(sorted(CHAPTER_STATUSES))}。")
        return value

    def to_json(self) -> str:
        return json.dumps(self.model_dump(by_alias=True), ensure_ascii=False, indent=2) + "\n"


def parse_chapter_meta(raw: Any) -> ChapterMeta:
    if not isinstance(raw, dict):
        raise InvalidParam("meta.json 的内容不是一个 JSON 对象。")
    try:
        return ChapterMeta.model_validate(raw)
    except ValidationError as exc:
        first = exc.errors()[0]
        raise InvalidParam(f"meta.json 校验失败：{first.get('msg', '未知错误')}") from exc


def title_from_first_line(line: str) -> str | None:
    """从正文首行取标题。

    **只看首行**：章节列表要读几十上百个文件，整文件读入会让大作品列表明显变慢。
    首行不是 ATX 标题时返回 ``None``，由调用方回退为「未命名」。
    """
    m = _ATX_RE.match(line.strip())
    if m is None:
        return None
    text = m.group(1).strip()
    return text or None
