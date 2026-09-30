"""大纲三层的领域模型与序列化 —— ``docs/15`` B2 / D-3 / D-5。

三层文件形态（§2.2）：

- 总纲 ``outline/总纲.md``：纯正文，无 frontmatter —— 它没有可结构化的字段；
- 卷纲 ``outline/卷纲/NNN-<slug>.md``：frontmatter ``{order, title}``（NNN 双写）；
- 章纲 ``outline/章纲/<chapterId>.md``：frontmatter ``{chapterId, foreshadow}``。

## 伏笔住在章纲 frontmatter 里（D-5）

伏笔的**登记动作**发生在"写某章的纲"时，所以数据也住在那里；
跨章的清单与超期提醒是**扫描聚合**（存储层现算），不落派生文件。

``expectResolveBy`` 是**卷序号**（int），不是日期：写书的人不知道自己哪天
写到第二卷，但知道"这条线该在第二卷里收掉"。超期判定 = 已存在的最大卷序号
超过了它 —— 用户还没建下一卷时永不提醒（没有"进度"就没有"超期"）。
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .frontmatter import join_frontmatter, split_frontmatter


class Foreshadow(BaseModel):
    """一条伏笔登记（D-5）。id 由存储层在写入时补齐（客户端新增项可以不带 id）。"""

    # 与 w_/ch_/r_ 同款下划线前缀 —— `docs/15` 写的 "fs-" 是笔误，跟代码库惯例走。
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, max_length=64)
    title: str = Field(min_length=1, max_length=200)
    #: 期望在哪一卷之前回收（卷序号）。None = 无限期，永不提示。
    expectResolveBy: int | None = Field(default=None, ge=1)
    status: Literal["open", "resolved", "dropped"] = "open"
    #: 回收发生在哪一章（chapterId）。open 时为 None。
    resolvedIn: str | None = Field(default=None, max_length=64)

    @field_validator("title")
    @classmethod
    def _title_not_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("伏笔标题不能为空")
        return value


class VolumeOutline(BaseModel):
    """卷纲。``slug`` 是派生字段（title 的 slugify），不进 frontmatter ——
    文件名里有它，双写两份必然漂移。"""

    model_config = ConfigDict(extra="ignore")

    order: int = Field(ge=1)
    title: str = Field(min_length=1, max_length=200)
    body: str = ""

    @field_validator("title")
    @classmethod
    def _title_not_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("卷标题不能为空")
        return value


class ChapterOutline(BaseModel):
    """章纲。``chapterId`` 的真源是 **URL**（PUT 时存储层拿 URL 的 cid 落盘，
    不信请求体）—— 章节清单才是"id 是否存在"的裁判。"""

    model_config = ConfigDict(extra="ignore")

    chapterId: str = Field(min_length=1, max_length=64)
    foreshadow: list[Foreshadow] = Field(default_factory=list)
    body: str = ""


# ---------------------------------------------------------------------------
# 卷纲序列化
# ---------------------------------------------------------------------------


def dump_volume(volume: VolumeOutline) -> str:
    return join_frontmatter({"order": volume.order, "title": volume.title}, volume.body)


def parse_volume(text: str) -> VolumeOutline | None:
    split = split_frontmatter(text)
    if split is None:
        return None
    data, body = split
    return VolumeOutline(
        order=data.get("order", 1),
        title=str(data.get("title", "")).strip() or "（未命名卷）",
        body=body,
    )


# ---------------------------------------------------------------------------
# 章纲序列化
# ---------------------------------------------------------------------------


def dump_chapter_outline(outline: ChapterOutline) -> str:
    return join_frontmatter(
        {
            "chapterId": outline.chapterId,
            "foreshadow": [item.model_dump() for item in outline.foreshadow],
        },
        outline.body,
    )


def parse_chapter_outline(text: str, *, chapter_id: str = "") -> ChapterOutline | None:
    """解析章纲。``chapter_id`` 是**文件名回填的兜底**：手写文件常常忘了写
    frontmatter 的 chapterId，而文件名（``<chapterId>.md``）才是真源（D-3）。
    两者都缺才是真坏文件，由存储层按"读单条响亮报错、清单跳过"裁决。"""
    split = split_frontmatter(text)
    if split is None:
        return None
    data, body = split
    return ChapterOutline(
        chapterId=str(data.get("chapterId", "")).strip() or chapter_id,
        # 手写文件里 id 缺失的伏笔也要能读出来（id 由写回路径补齐），
        # 严格拒绝会让"用户手补一条伏笔"变成整张章纲打不开。
        # 占位 id 带下标，同一张纲手补多条也不会撞出重复 id。
        foreshadow=[
            Foreshadow.model_validate(
                {**item, "id": str(item.get("id", "")).strip() or f"fs_manual_{index}"}
            )
            for index, item in enumerate(data.get("foreshadow", []) or [])
        ],
        body=body,
    )
