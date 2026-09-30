"""Codex（设定条目）的领域模型与 frontmatter 序列化 —— ``docs/15`` B1 / D-1 / D-2。

## 为什么人物卡是"单文件 frontmatter + 正文"

``docs/14`` §4.1 的核心卖点：一张卡一个 ``.md``，用任何编辑器打开都在。
拆成 ``meta.json + body.md`` 会把"在 VS Code 里看一眼人物"变成开两个文件，
也让 git diff 失去上下文。代价是要在这里做 YAML 解析（D-1），收益是
"文件即真源"这条约定在 codex 上不打折扣。

## 解析的宽容边界（手写文件的生存空间）

frontmatter 是**我们的**格式，但文件在用户磁盘上，用户随时可能用记事本改：

- frontmatter 里出现未知键 → **忽略**（向前兼容，别让加个字段变 500）；
- 别名/标签里的空串 → 静默丢弃、首尾空白剥掉（手写最容易多打个逗号）；
- 整个文件没有 frontmatter / YAML 语法错误 / 结构不合法 → ``parse_entry`` 返回
  ``None`` 或抛 ``ValueError``，由存储层决定"清单里跳过并留 warn 日志"还是
  "读单条时报错" —— 与 ``repo._scan_chapters`` 对"解析不了的章节目录"的
  容忍策略同构：**一条坏数据不能炸掉整个列表**。

## 序列化的钉死项

``yaml.safe_dump(..., sort_keys=False, allow_unicode=True, width=巨大)``：

- ``sort_keys=False``：字段顺序保持写入顺序 —— 人读的文件不该被字典序搅乱；
- ``allow_unicode=True``：中文原样输出，不转 ``\\uXXXX`` 转义；
- ``width`` 拉满：YAML 默认 80 列折行，长 summary 会被折成多行，
  往返后 body/summary 仍相等但**字节**变了 —— hash 跟着变，无端多出一次
  "外部修改"提示。

往返不变性（dump → parse → 等价）由 ``tests/test_codex_model.py`` 的
property 测试钉住；改动 dump 参数前先想清楚它对用户磁盘上旧文件的影响。
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .frontmatter import join_frontmatter, split_frontmatter

# 条目类型。目录名直接用它（``codex/character/<slug>.md``）——
# 代码里的键与磁盘上的目录一一对应，不做"英文键 → 中文目录名"的翻译表：
# 每多一层翻译就多一处"改名要改三个地方"的漂移点（``docs/14`` §4.1 原形）。
CodexType = Literal["character", "location", "faction", "item", "concept"]
CODEX_TYPES: tuple[str, ...] = ("character", "location", "faction", "item", "concept")

# relation.to 会被解析成对方的 slug（= 文件名），所以这里按"能不能当文件名"卡：
# 路径分隔符与 Windows 非法字符一律拒绝 —— 否则 ``../xxx`` 会顺着 relation 逃出
# codex 目录（D-2 的安全面）。charset 校验放在这里而不是端点，因为
# "从 frontmatter 手写进来"的 relation 同样要过这道闸。
_BAD_RELATION_CHARS = frozenset('<>:"/\\|?*')


# 标量与两层容器。用显式 Union 而不是递归别名：递归类型在 pydantic 里要
# ForwardRef + model_rebuild，报错信息难读；而 2 层深度对"人物属性"够用
# （``年龄: 27`` / ``性格标签: [...]`` / ``外貌: {身高: ..., 瞳色: ...}``），
# 真要嵌套三层的那天，先回答"这一层给人读还是给 AI 读"。
#
# ⚠️ 必须定义在 ``CodexEntry`` 之前：pydantic 建模型时要**立刻**解析注解，
# 放到后面就是 ``NameError: FieldValue`` —— 症状是 import 就炸，不是慢半拍。
Scalar = str | int | float | bool
FieldValue = Scalar | list[Scalar] | dict[str, Scalar]


class Relation(BaseModel):
    """人物/条目之间的有向关系。``to`` 是**对方条目的 slug**（不是 name）——
    name 会改，slug（文件名）一旦建出来就不动，引用稳定键才不会断。"""

    model_config = ConfigDict(extra="forbid")

    to: str = Field(min_length=1, max_length=200)
    kind: str = Field(min_length=1, max_length=100)
    note: str = Field(default="", max_length=2000)

    @field_validator("to")
    @classmethod
    def _to_must_be_slug_safe(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("relation.to 不能为空")
        if _BAD_RELATION_CHARS & set(value):
            raise ValueError("relation.to 含有不能作为文件名的字符")
        return value

    @field_validator("kind")
    @classmethod
    def _kind_not_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("relation.kind 不能为空")
        return value


class CodexEntry(BaseModel):
    """一条设定条目的全量数据。

    ``extra`` 不 forbid：**frontmatter 手写路径**要求向前兼容（见模块 docstring）。
    API 层的请求模型单独子类化并开 ``extra="forbid"``（契约漂移要 400），
    两处策略不同是刻意的，别"统一"掉。
    """

    model_config = ConfigDict(populate_by_name=True)

    type: CodexType
    name: str = Field(min_length=1, max_length=200)
    aliases: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    #: 开放键值（``docs/14`` §4.1：起点式数据化人设，键随书不同）。
    #: 形状 = 标量 / 标量列表 / 标量字典（深度 ≤2 由类型本身保证）。
    fields: dict[str, FieldValue] = Field(default_factory=dict)
    #: 50~100 字核心梗概。P1 起进记忆金字塔 L0 的原料；P0 只是普通字段。
    summary: str = ""
    relations: list[Relation] = Field(default_factory=list)
    #: frontmatter 之后的自由描述，原样存取，不参与任何结构化校验。
    body: str = ""

    @field_validator("name")
    @classmethod
    def _name_not_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("name 不能为空")
        return value

    @field_validator("aliases", "tags")
    @classmethod
    def _strip_and_drop_empty(cls, value: list[str]) -> list[str]:
        cleaned = [item.strip() for item in value]
        if any(not item for item in cleaned):
            raise ValueError("别名/标签不能是空串")
        if any(len(item) > 100 for item in cleaned):
            raise ValueError("别名/标签单条不能超过 100 字")
        return cleaned


# ---------------------------------------------------------------------------
# frontmatter 序列化
#
# 拆装机制（``---`` 切分、BOM/缺尾换行宽容、safe_dump 钉死参数）抽在
# ``frontmatter.py`` 一份实现里 —— B2 的 outline 文件与 codex 共用同一套
# 机制，两份各自手写必然漂移（见那个模块的 docstring）。
# ---------------------------------------------------------------------------


def dump_entry(entry: CodexEntry) -> str:
    """把条目序列化成完整文件文本（frontmatter + 正文）。

    正文原样拼接、**不补尾随换行**：body 的每个字节都是用户写的，
    序列化层无权添加 —— 否则"打开即改动"，hash 无端变化。
    """
    data: dict[str, Any] = {
        "type": entry.type,
        "name": entry.name,
        "aliases": entry.aliases,
        "tags": entry.tags,
        "fields": entry.fields,
        "summary": entry.summary,
        "relations": [relation.model_dump() for relation in entry.relations],
    }
    return join_frontmatter(data, entry.body)


def parse_entry(text: str) -> CodexEntry | None:
    """从文件文本解析条目。

    返回 ``None`` = "这不是 codex 文件格式"（没有 frontmatter），由调用方决定
    跳过还是报错；YAML 语法错误 / 结构不合法抛 ``ValueError``（同样是调用方裁决）。
    """
    split = split_frontmatter(text)
    if split is None:
        return None
    data, body = split

    return CodexEntry(
        type=data.get("type", "character"),
        name=str(data.get("name", "")).strip() or "（未命名）",
        aliases=[str(item) for item in data.get("aliases", []) or []],
        tags=[str(item) for item in data.get("tags", []) or []],
        fields=data.get("fields", {}) or {},
        summary=str(data.get("summary", "") or ""),
        relations=[Relation.model_validate(item) for item in data.get("relations", []) or []],
        body=body,
    )
