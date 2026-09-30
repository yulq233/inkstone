"""expand 装配器（``ai/context.py`` 的 `_collect_expand`，docs/16 D-5）。

复用 `test_ai_context.py` 的 `FakeWorkspace`：装配逻辑（哪些块、丢哪个、
渲染成什么）不依赖真实文件系统，用假只读视图穷举。真适配器
（`RegistryWorkspace` 的 codex/outline 读取）另有一组用例走 HTTP，
见 `test_ai_expand_api.py`。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from inkstone.ai.context import (
    EXPAND_GENERAL_HEAD_CHARS,
    EXPAND_RELATION_MAX_ITEMS,
    EXPAND_RELATION_SUMMARY_CHARS,
    Assembler,
    AssembleRequest,
)
from inkstone.ai.prompts import load_template
from inkstone.errors import AiContextTooLong

from .test_ai_context import WORK_ID, FakeWorkspace


def _make_expand(
    tmp_path: Path,
    *,
    codex_entries: dict[tuple[str, str], dict] | None = None,
    relation_summaries: list[str] | None = None,
    general_outline: str = "",
) -> FakeWorkspace:
    """一个只装 expand 装配源、没有章节的假工作区。

    expand 不读章节（`_collect_expand` 根本不调 `chapter_ids`），所以这里
    章节给空即可 —— 也顺带证明"没有章节也能扩充设定"。
    """
    return FakeWorkspace(
        tmp_path / "我的小说",
        {},
        codex_entries=codex_entries,
        relation_summaries=relation_summaries,
        general_outline=general_outline,
    )


def _req(**overrides: str) -> AssembleRequest:
    base: dict[str, str] = {
        "task": "expand",
        "work_id": WORK_ID,
        "chapter_id": "",
        "prefix": "",
        "entry_type": "character",
        "slug": "沈观澜",
        "target": "body",
    }
    base.update(overrides)
    return AssembleRequest(**base)


def _entry(**overrides: object) -> dict:
    base: dict[str, object] = {
        "type": "character",
        "slug": "沈观澜",
        "name": "沈观澜",
        "summary": "一个寡言的老剑客。",
        "fields": {"年龄": 47, "兵器": ["剑", "暗器"]},
        "body": "少年时被逐出师门。",
        "relations": [],
    }
    base.update(overrides)
    return base


# ---------------------------------------------------------------------------
# 装配源
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_expand_carries_entry_relations_and_general_outline(tmp_path: Path) -> None:
    ws = _make_expand(
        tmp_path,
        codex_entries={("character", "沈观澜"): _entry()},
        relation_summaries=["云京第一剑客，与沈观澜有旧怨。"],
        general_outline="天下大势，分久必合。",
    )
    bundle = await Assembler(ws).assemble(_req())

    assert [b.slot for b in bundle.blocks] == ["entry", "relations", "general_outline"]
    assert bundle.template_id == "expand"
    # v2：B 修复给 system 加了「条目自身名称是既定事实、不许改名」的硬约束（docs/16 §9.3）
    assert bundle.template_version == 2
    assert "沈观澜" in bundle.user
    assert "少年时被逐出师门" in bundle.user
    assert "云京第一剑客" in bundle.user
    assert "天下大势" in bundle.user
    assert bundle.dropped == ()


@pytest.mark.asyncio
async def test_entry_body_is_capped_keeping_the_tail(tmp_path: Path) -> None:
    """body 只取**尾** 600 字（docs/16 D-5）—— 用户最近补的描述最相关。"""
    body = "开头不该出现。" + "中" * 3000 + "最近的这一句。"
    ws = _make_expand(tmp_path, codex_entries={("character", "沈观澜"): _entry(body=body)})
    bundle = await Assembler(ws).assemble(_req())

    entry = next(b for b in bundle.blocks if b.slot == "entry")
    assert "最近的这一句。" in entry.text
    assert "开头不该出现。" not in entry.text
    # 尾截断只作用于 body 部分，不是整块条目文本；这里只断言"没把整个 body 原样带全"。
    assert len(entry.text) < len(body)


@pytest.mark.asyncio
async def test_relations_are_capped_to_max_items_and_length(tmp_path: Path) -> None:
    """关联条目最多 10 条、每条 summary 截到 120 字（docs/16 D-5）。"""
    summaries = [f"关联{i}。" * 60 for i in range(12)]  # 12 条、每条都很长
    ws = _make_expand(
        tmp_path,
        codex_entries={("character", "沈观澜"): _entry()},
        relation_summaries=summaries,
    )
    bundle = await Assembler(ws).assemble(_req())

    relations = next(b for b in bundle.blocks if b.slot == "relations")
    lines = [line for line in relations.text.split("\n") if line.strip()]
    assert len(lines) == EXPAND_RELATION_MAX_ITEMS
    assert all(len(line) <= EXPAND_RELATION_SUMMARY_CHARS for line in lines)


@pytest.mark.asyncio
async def test_general_outline_is_capped_keeping_the_head(tmp_path: Path) -> None:
    """总纲只取**头** 1500 字（世界观、主题、基调都在开头）。"""
    outline = "开头定基调。" + "中" * 3000 + "结尾不该出现。"
    ws = _make_expand(tmp_path, general_outline=outline)
    bundle = await Assembler(ws).assemble(_req())

    general = next(b for b in bundle.blocks if b.slot == "general_outline")
    assert "开头定基调。" in general.text
    assert "结尾不该出现。" not in general.text
    assert len(general.text) == EXPAND_GENERAL_HEAD_CHARS


@pytest.mark.asyncio
async def test_empty_relations_and_outline_are_omitted(tmp_path: Path) -> None:
    """关联条目与总纲都空时，只保留条目现值那一块 —— 空块不进 blocks。"""
    ws = _make_expand(
        tmp_path,
        codex_entries={("character", "沈观澜"): _entry()},
    )
    bundle = await Assembler(ws).assemble(_req())
    assert [b.slot for b in bundle.blocks] == ["entry"]


@pytest.mark.asyncio
async def test_expand_with_nothing_at_all_raises(tmp_path: Path) -> None:
    """条目现值 + 关联 + 总纲全空 = 没有可发内容，与续写同一条 `AI_CONTEXT_TOO_LONG`。

    这种情况实际很少见（条目至少有个 name），但装配器不能静默发空请求。
    """
    ws = _make_expand(tmp_path)
    with pytest.raises(AiContextTooLong):
        await Assembler(ws).assemble(_req())


# ---------------------------------------------------------------------------
# 模板渲染：target / type 换措辞（docs/16 D-6）
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_target_body_renders_描述_instruction(tmp_path: Path) -> None:
    ws = _make_expand(
        tmp_path, codex_entries={("character", "沈观澜"): _entry()}
    )
    bundle = await Assembler(ws).assemble(_req(target="body"))
    assert "生成一段描述" in bundle.user
    assert "人物" in bundle.user  # entry_type=character → 中文名"人物"


@pytest.mark.asyncio
async def test_target_summary_renders_梗概_instruction(tmp_path: Path) -> None:
    ws = _make_expand(
        tmp_path, codex_entries={("faction", "青云宗"): _entry(name="青云宗")}
    )
    bundle = await Assembler(ws).assemble(
        _req(entry_type="faction", slug="青云宗", target="summary")
    )
    assert "生成一段梗概" in bundle.user
    assert "势力" in bundle.user  # entry_type=faction → 中文名"势力"


def test_expand_template_renders_every_type_label() -> None:
    """`expand.toml` 的 `{entry_type}` 变量要能被五种 type 的中文名替换。

    这条钉的是 `ENTRY_TYPE_LABELS` 与 `CODEX_TYPES` 的**覆盖**：漏一个 type，
    模板里就残留一个 `{entry_type}` 字面量，用户拿到一段"没按要求"的输出。
    """
    template = load_template("expand")
    from inkstone.ai.context import ENTRY_TYPE_LABELS

    assert set(ENTRY_TYPE_LABELS) == {"character", "location", "faction", "item", "concept"}
    for label in ENTRY_TYPE_LABELS.values():
        # 模板本身不含任何字面量中文 type 名（否则等于把措辞写死、绕开变量）
        assert label not in template.user


def test_expand_system_pins_entry_name_as_ground_truth() -> None:
    """v2 的硬约束：**要扩充的条目自身名称是既定事实，不许改名/另起别名**。

    这条是首轮真机缺陷（`docs/16` §9）的 B 修复 —— 模型把"给『女主』这种职能代称
    起个具体名字"当成"补全细节"，写出了第三个人名。system 里必须有这段约束；
    一旦被删掉，模型就会退回"自由发挥起名"，所以用测试钉住，不靠人的记忆。

    同时钉住 `_render_system` **不做变量替换**这一约束（`docs/16` §9.3）：`{entry}` 只能
    出现在 user 段，写进 system 不会被替换、会原样发给模型。
    """
    template = load_template("expand")

    assert template.version == 2
    assert "既定事实" in template.system  # 名称是既定事实
    assert "不要给它改名" in template.system  # 硬约束本体
    assert "照原样沿用" in template.system  # 职能代称也要沿用的边界情况

    # system 段不做变量替换 → 里面不能出现只有 user 段才会被替换的占位符
    assert "{entry}" not in template.system
    assert "{entry}" in template.user
