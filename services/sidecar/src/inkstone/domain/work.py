"""``work.json`` 的 schema。

三条规则（03 文档 §4.2）：

1. **未知字段保留** —— 读取时原样留住，写回不丢。这样将来版本加了字段，
   用户被降级回旧版打开一次，新字段也不会被抹掉。
2. **缺失字段补默认并写回** —— 手写/半损坏的 work.json 能被自愈。
3. **``schemaVersion`` 只认 1** —— 未知版本宁可报错也不猜，避免按错误假设解析后写坏文件。
"""

from __future__ import annotations

import json
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from ..errors import InvalidParam
from .clock import now_iso
from .ids import new_work_id

SUPPORTED_SCHEMA_VERSION = 1


class WorkMeta(BaseModel):
    """``work.json`` 的内存表示。字段名用 snake_case，落盘走 alias 的 camelCase。"""

    # extra="allow" 是"未知字段保留"的落点：多余字段进 model_extra，dump 时原样带回。
    model_config = ConfigDict(extra="allow", populate_by_name=True)

    schema_version: int = Field(default=SUPPORTED_SCHEMA_VERSION, alias="schemaVersion")
    # 缺 id 时补一个新的而不是报错：id 缺失不影响正文，自愈比拒绝打开更友好。
    id: str = Field(default_factory=new_work_id)
    title: str = ""
    author: str = ""
    genre: str = ""
    tags: list[str] = Field(default_factory=list)
    word_goal: int = Field(default=0, alias="wordGoal")
    daily_goal: int = Field(default=4000, alias="dailyGoal")
    created_at: str = Field(default_factory=now_iso, alias="createdAt")
    updated_at: str = Field(default_factory=now_iso, alias="updatedAt")

    @field_validator("schema_version")
    @classmethod
    def _check_version(cls, value: int) -> int:
        if value != SUPPORTED_SCHEMA_VERSION:
            raise ValueError(
                f"不支持的 work.json 版本 {value}，当前只认 {SUPPORTED_SCHEMA_VERSION}。"
                f"请用更新版本的砚台打开这部作品。"
            )
        return value

    def to_json(self) -> str:
        return json.dumps(self.model_dump(by_alias=True), ensure_ascii=False, indent=2) + "\n"


def parse_work_meta(raw: Any) -> WorkMeta:
    if not isinstance(raw, dict):
        raise InvalidParam("work.json 的内容不是一个 JSON 对象。")
    try:
        return WorkMeta.model_validate(raw)
    except ValidationError as exc:
        # 把 pydantic 的一长串结构拍平成人能读的一句话。
        first = exc.errors()[0]
        raise InvalidParam(f"work.json 校验失败：{first.get('msg', '未知错误')}") from exc


def needs_rewrite(raw: dict[str, Any], meta: WorkMeta) -> bool:
    """判断读到的原始 JSON 与补齐后的模型是否语义一致，不一致才回写。

    避免每次打开都无谓重写文件 —— 那会让"最后修改时间"失去参考价值。
    """
    return raw != meta.model_dump(by_alias=True)
