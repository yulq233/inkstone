"""请求体模型。

字段名直接用 camelCase，与 ``packages/shared/src/api-types.ts`` 的契约一致，
少一层 alias 映射就少一个对不上的地方。
``extra="forbid"``：前端多传了字段说明契约漂移了，宁可 400 也不要静默忽略。
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class _Request(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CreateWorkRequest(_Request):
    parentDir: str = Field(min_length=1)
    title: str = Field(min_length=1)
    author: str = ""
    genre: str = ""
    wordGoal: int = Field(default=0, ge=0)


class OpenWorkRequest(_Request):
    rootPath: str = Field(min_length=1)


class CreateChapterRequest(_Request):
    title: str = Field(min_length=1)
    afterChapterId: str | None = None


class UpdateChapterRequest(_Request):
    markdown: str
    baseHash: str
    # 冲突后"保留我的并覆盖"时置 true：服务端会先把磁盘版本备份到
    # .inkstone/backups/ 再写。默认 False，普通保存不产生备份文件。
    backup: bool = False
