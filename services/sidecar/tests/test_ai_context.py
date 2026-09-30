"""v1 上下文装配器（``ai/context.py``）。

## 为什么能不用真仓储

装配器依赖的是一个只有三个方法的 ``Workspace`` 协议。用假实现之后，
"哪些块进了候选、按什么顺序、丢哪个、渲染成什么"全都可穷举 ——
而这正是本步骤最容易出错的部分（真错了的表现是"模型接不上前文"，
而它不会报任何错，只是写得不对）。

真适配器（``ai/workspace.py`` 的 ``RegistryWorkspace``）另有一组用例走 HTTP，
见 ``test_ai_api.py`` 的续写端点。
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from inkstone.ai.context import (
    DEFAULT_CONTEXT_BUDGET,
    MIN_KEEP_TOKENS,
    STYLE_CARD_CHARS,
    Assembler,
    AssembleRequest,
    Block,
    plan_blocks,
)
from inkstone.ai.prompts import load_template
from inkstone.domain.paths import WorkPaths
from inkstone.errors import AiContextTooLong

WORK_ID = "w_test"

#: 仓库根。`test_ai_context.py` → tests → sidecar → services → 仓库根。
_REPO_ROOT = Path(__file__).resolve().parents[3]


class FakeWorkspace:
    """装配器要的最小只读视图。章节按插入顺序 = 正文顺序。"""

    def __init__(
        self,
        root: Path,
        chapters: dict[str, str],
        *,
        settings_md: str | None = None,
        codex_entries: dict[tuple[str, str], dict] | None = None,
        relation_summaries: list[str] | None = None,
        general_outline: str = "",
    ) -> None:
        self._paths = WorkPaths(root)
        self._chapters = dict(chapters)
        self._codex = dict(codex_entries or {})
        self._relation_summaries = list(relation_summaries or [])
        self._general_outline = general_outline
        root.mkdir(parents=True, exist_ok=True)
        if settings_md is not None:
            self._paths.settings_md.write_text(settings_md, encoding="utf-8")

    def paths(self, work_id: str) -> WorkPaths:
        assert work_id == WORK_ID, "装配器不该带上别的作品 id"
        return self._paths

    async def chapter_ids(self, work_id: str) -> list[str]:
        return list(self._chapters)

    async def read_chapter(self, work_id: str, chapter_id: str) -> str:
        return self._chapters[chapter_id]

    # ---- expand 专用（docs/16 D-5）----

    async def read_codex_entry(self, work_id: str, entry_type: str, slug: str) -> dict:
        return self._codex.get((entry_type, slug), {})

    async def codex_relation_summaries(self, work_id: str, entry: dict) -> list[str]:
        # 假实现：直接回预置的关联 summary（由用例配置），
        # 不模拟"按 relation.to 去 codex 里查"——那属于 RegistryWorkspace 的职责，
        # 在 test 里由 HTTP 用例覆盖。
        return list(self._relation_summaries)

    async def read_general_outline(self, work_id: str) -> str:
        return self._general_outline


def _make(
    tmp_path: Path, chapters: dict[str, str], *, settings_md: str | None = None
) -> FakeWorkspace:
    return FakeWorkspace(tmp_path / "我的小说", chapters, settings_md=settings_md)


# ---------------------------------------------------------------------------
# plan_blocks：纯函数，能穷举
# ---------------------------------------------------------------------------


class TestPlanBlocks:
    def test_all_fit(self) -> None:
        blocks = [Block("prefix", "前文", "你好"), Block("settings", "设定", "世界")]
        kept, dropped = plan_blocks(100, blocks)
        assert [b.slot for b in kept] == ["prefix", "settings"]
        assert dropped == []

    def test_empty_text_is_not_a_block(self) -> None:
        """空块既不留也不报 —— 否则 dropped 里会出现一堆"丢了 0 token 的东西"。"""
        blocks = [Block("prefix", "前文", ""), Block("settings", "设定", "世界")]
        kept, dropped = plan_blocks(100, blocks)
        assert [b.slot for b in kept] == ["settings"]
        assert dropped == []

    def test_over_budget_without_trim_is_dropped(self) -> None:
        blocks = [Block("prefix", "前文", "字" * 50, trim=None)]
        kept, dropped = plan_blocks(10, blocks)
        assert kept == []
        assert len(dropped) == 1
        assert dropped[0].reason == "budget"
        # tokens 报的是**原本**的大小：用户想知道"这块有多大"，
        # 而不是"丢的时候它多小"。
        assert dropped[0].tokens == 50
        assert dropped[0].source == "L4"

    def test_over_budget_with_trim_is_kept_truncated(self) -> None:
        blocks = [Block("prefix", "前文", "字" * 500, trim="tail")]
        kept, dropped = plan_blocks(100, blocks)
        assert dropped == []
        assert kept[0].truncated is True
        assert kept[0].tokens <= 100

    def test_dropped_before_the_remaining_is_too_small_to_trim(self) -> None:
        """剩下的空间连 MIN_KEEP_TOKENS 都不到时，宁可整块丢 —— 不给半句话。"""
        blocks = [Block("prefix", "前文", "字" * 500, trim="tail")]
        kept, dropped = plan_blocks(MIN_KEEP_TOKENS - 1, blocks)
        assert kept == []
        assert len(dropped) == 1

    def test_priority_order_is_kept(self) -> None:
        blocks = [
            Block("prefix", "前文", "甲" * 40, trim="tail"),
            Block("adjacent", "相邻章", "乙" * 40, trim="head"),
        ]
        kept, dropped = plan_blocks(50, blocks)
        assert [b.slot for b in kept] == ["prefix"]
        assert [d.source for d in dropped] == ["L3"]


# ---------------------------------------------------------------------------
# 装配
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_assembly_carries_every_source(tmp_path: Path) -> None:
    ws = _make(
        tmp_path,
        {"c1": "第一章的结尾。", "c2": "第二章的正文。", "c3": "第三章的开头。"},
        settings_md="云京，冬天。主角叫沈砚。",
    )
    bundle = await Assembler(ws).assemble(
        AssembleRequest(
            task="continue",
            work_id=WORK_ID,
            chapter_id="c2",
            prefix="他推开门。",
            suffix="灯还亮着。",
        )
    )

    assert [b.slot for b in bundle.blocks] == ["prefix", "settings", "suffix", "adjacent"]
    assert bundle.user.count("沈砚") == 1
    assert "他推开门。" in bundle.user
    assert "第一章的结尾。" in bundle.user
    assert "第三章的开头。" in bundle.user
    assert bundle.dropped == ()
    assert bundle.template_id == "continue"
    assert bundle.template_version == 1
    assert bundle.temperature == 0.75


@pytest.mark.asyncio
async def test_missing_settings_file_is_normal(tmp_path: Path) -> None:
    """新建的作品本来就没有「设定.md」。它缺失不是错误。"""
    ws = _make(tmp_path, {"c1": "正文。"})
    bundle = await Assembler(ws).assemble(
        AssembleRequest(task="continue", work_id=WORK_ID, chapter_id="c1", prefix="前文。")
    )
    assert "settings" not in [b.slot for b in bundle.blocks]
    assert "【已知设定】\n（无）" in bundle.user


@pytest.mark.asyncio
async def test_settings_capped_keeping_the_head(tmp_path: Path) -> None:
    ws = _make(tmp_path, {"c1": "正文。"}, settings_md="开" * 3000)
    bundle = await Assembler(ws).assemble(
        AssembleRequest(task="continue", work_id=WORK_ID, chapter_id="c1", prefix="前文。")
    )
    settings = next(b for b in bundle.blocks if b.slot == "settings")
    assert len(settings.text) == 2000


@pytest.mark.asyncio
async def test_adjacent_is_previous_tail_plus_next_head(tmp_path: Path) -> None:
    ws = _make(
        tmp_path,
        {
            "c1": "开头不该出现。" + "中" * 400 + "上一章最后的字。",
            "c2": "本章。",
            "c3": "下一章最前的字。" + "后" * 400 + "结尾不该出现。",
        },
    )
    bundle = await Assembler(ws).assemble(
        AssembleRequest(task="continue", work_id=WORK_ID, chapter_id="c2", prefix="前文。")
    )
    adjacent = next(b for b in bundle.blocks if b.slot == "adjacent")

    assert adjacent.text.startswith("（上一章结尾）")
    assert "上一章最后的字。" in adjacent.text
    assert "开头不该出现。" not in adjacent.text
    assert "（下一章开头）" in adjacent.text
    assert "下一章最前的字。" in adjacent.text
    assert "结尾不该出现。" not in adjacent.text


@pytest.mark.asyncio
async def test_single_chapter_has_no_adjacent(tmp_path: Path) -> None:
    ws = _make(tmp_path, {"c1": "只有一章。"})
    bundle = await Assembler(ws).assemble(
        AssembleRequest(task="continue", work_id=WORK_ID, chapter_id="c1", prefix="前文。")
    )
    assert "adjacent" not in [b.slot for b in bundle.blocks]


@pytest.mark.asyncio
async def test_unknown_chapter_id_yields_no_adjacent_but_still_writes(
    tmp_path: Path,
) -> None:
    """渲染进程传来的 chapterId 可能已经过期（这一章刚被删掉）。

    这时仍应能续写 —— 前文是渲染进程给的，它才是真正的输入。
    """
    ws = _make(tmp_path, {"c1": "第一章。", "c2": "第二章。"})
    bundle = await Assembler(ws).assemble(
        AssembleRequest(task="continue", work_id=WORK_ID, chapter_id="c9", prefix="前文。")
    )
    assert "adjacent" not in [b.slot for b in bundle.blocks]
    assert "前文。" in bundle.user


@pytest.mark.asyncio
async def test_prefix_capped_keeping_the_tail(tmp_path: Path) -> None:
    ws = _make(tmp_path, {"c1": "本章。"})
    prefix = "开头不该出现。" + "中" * 3000 + "最近的这一句。"
    bundle = await Assembler(ws).assemble(
        AssembleRequest(task="continue", work_id=WORK_ID, chapter_id="c1", prefix=prefix)
    )
    block = next(b for b in bundle.blocks if b.slot == "prefix")
    assert len(block.text) == 2000
    assert block.text.endswith("最近的这一句。")
    assert "开头不该出现。" not in block.text


@pytest.mark.asyncio
async def test_suffix_capped_keeping_the_head(tmp_path: Path) -> None:
    ws = _make(tmp_path, {"c1": "本章。"})
    bundle = await Assembler(ws).assemble(
        AssembleRequest(
            task="continue",
            work_id=WORK_ID,
            chapter_id="c1",
            prefix="前文。",
            suffix="光标后第一句。" + "后" * 3000,
        )
    )
    block = next(b for b in bundle.blocks if b.slot == "suffix")
    assert len(block.text) == 600
    assert block.text.startswith("光标后第一句。")


@pytest.mark.asyncio
async def test_style_card_goes_into_system_and_is_capped(tmp_path: Path) -> None:
    ws = _make(tmp_path, {"c1": "本章。"})
    bundle = await Assembler(ws).assemble(
        AssembleRequest(
            task="continue",
            work_id=WORK_ID,
            chapter_id="c1",
            prefix="前文。",
            style_card="风" * (STYLE_CARD_CHARS + 500),
        )
    )
    assert "【风格要求】" in bundle.system
    assert "风" * STYLE_CARD_CHARS in bundle.system
    assert "风" * (STYLE_CARD_CHARS + 1) not in bundle.system
    # 风格卡只进 system。进 user 会白占一次预算，也让"同一份要求出现两遍"。
    assert "【风格要求】" not in bundle.user


@pytest.mark.asyncio
async def test_intent_is_appended_only_for_continue(tmp_path: Path) -> None:
    ws = _make(tmp_path, {"c1": "本章。"})
    req = AssembleRequest(
        task="continue",
        work_id=WORK_ID,
        chapter_id="c1",
        prefix="前文。",
        intent="节奏慢一点。",
    )
    bundle = await Assembler(ws).assemble(req)
    assert "【本次的额外约束】\n节奏慢一点。" in bundle.system
    assert "节奏慢一点。" in bundle.user

    # quick 的补充说明走模板里的 {intent}，不该再往系统指令里塞一份。
    quick = await Assembler(ws).assemble(
        AssembleRequest(
            task="quick",
            work_id=WORK_ID,
            chapter_id="c1",
            prefix="前文。",
            kind="naming",
            intent="要偏冷一点。",
        )
    )
    assert "【本次的额外约束】" not in quick.system
    assert "要偏冷一点。" in quick.user


@pytest.mark.asyncio
async def test_quick_kind_selects_the_instruction(tmp_path: Path) -> None:
    ws = _make(tmp_path, {"c1": "本章。"})
    bundle = await Assembler(ws).assemble(
        AssembleRequest(
            task="quick", work_id=WORK_ID, chapter_id="c1", prefix="前文。", kind="title"
        )
    )
    assert "为这一章起 5 个标题" in bundle.user
    assert bundle.temperature == 1.0


@pytest.mark.asyncio
async def test_unknown_quick_kind_renders_empty_not_a_stale_one(tmp_path: Path) -> None:
    """未知 kind 不能回落成别的指令 —— 那会让用户拿到"没按要求来的"输出。"""
    ws = _make(tmp_path, {"c1": "本章。"})
    bundle = await Assembler(ws).assemble(
        AssembleRequest(task="quick", work_id=WORK_ID, chapter_id="c1", prefix="前文。", kind="??")
    )
    assert "（无）" in bundle.user
    assert "为这一章起 5 个标题" not in bundle.user
    assert "为下面这个用途起 10 个候选名" not in bundle.user


def test_quick_kinds_match_the_shared_contract() -> None:
    """`quick.toml` 的 kind 清单必须与 `ai-types.ts` 的 `AI_QUICK_KINDS` 逐字一致。

    两边不一致时**不会报任何错**：sidecar 认不出一个 kind，只会渲染出一条空指令，
    于是用户拿到的是一段"没按要求来的"输出，而日志与报错里一个字都不提。
    这条漂移只能靠测试钉住 —— 它是本步骤里唯一一处需要跨语言核对的契约。
    """
    source_path = _REPO_ROOT / "packages/shared/src/ai-types.ts"
    if not source_path.is_file():
        pytest.skip("不在仓库里跑（拿不到 shared 契约文件）")

    block = re.search(r"AI_QUICK_KINDS = \[(.*?)\] as const;", source_path.read_text("utf-8"), re.S)
    assert block is not None, "ai-types.ts 里找不到 AI_QUICK_KINDS 的声明"
    declared = set(re.findall(r"'([a-z0-9-]+)'", block.group(1)))

    assert declared == set(load_template("quick").kinds)
    assert declared != set()  # 正则写坏了不该变成一条永远通过的用例


@pytest.mark.asyncio
async def test_nothing_to_send_raises_with_actionable_message(tmp_path: Path) -> None:
    """一个字都没有时**不静默发空请求**（模型会自由发挥，用户以为在续写）。"""
    ws = _make(tmp_path, {"c1": ""})
    with pytest.raises(AiContextTooLong) as excinfo:
        await Assembler(ws).assemble(
            AssembleRequest(task="continue", work_id=WORK_ID, chapter_id="c1", prefix="   ")
        )
    assert excinfo.value.code == "AI_CONTEXT_TOO_LONG"
    # 指引必须是"补内容"，而不是"缩短选区"—— 那会让用户去改一个没问题的东西。
    assert "设定.md" in excinfo.value.message


@pytest.mark.asyncio
async def test_tight_budget_sacrifices_the_lowest_priority_block(tmp_path: Path) -> None:
    """预算不够时，先牺牲**相邻章**，前文与设定要保住。

    预算值刻意由"完整装配的实占"推出来，而不是写一个魔数：
    系统指令的长度会随模板文案变，写死的数字会在某人改一句 prompt 之后
    变成一条时红时绿的测试。
    """
    ws = _make(
        tmp_path,
        {
            "c1": "中" * 300 + "上一章最后的字。",
            "c2": "本章。",
            "c3": "下一章最前的字。" + "后" * 300,
        },
        settings_md="云京，冬天。",
    )
    req = AssembleRequest(task="continue", work_id=WORK_ID, chapter_id="c2", prefix="他推开门。")

    full = await Assembler(ws).assemble(req)
    assert full.dropped == ()

    tight_budget = full.budget.used - 5
    bundle = await Assembler(ws, budget=tight_budget).assemble(req)

    assert bundle.budget.budget == tight_budget
    # 前文是最高优先级：它必须**完整**留着，被截断就意味着排序被写反了。
    prefix = next(b for b in bundle.blocks if b.slot == "prefix")
    assert prefix.truncated is False
    # 最低优先级的那块被牺牲：要么截断，要么整块丢。
    adjacent = [b for b in bundle.blocks if b.slot == "adjacent"]
    assert adjacent == [] or adjacent[0].truncated is True
    assert bundle.budget.used < full.budget.used


@pytest.mark.asyncio
async def test_default_budget_does_not_cut_a_normal_chapter(tmp_path: Path) -> None:
    """正常的"一章配一次续写"不该触发兜底 —— 该管住它的是各来源的字符上限。"""
    ws = _make(
        tmp_path,
        {"c1": "中" * 300, "c2": "本章。", "c3": "后" * 300},
        settings_md="设" * 2000,
    )
    bundle = await Assembler(ws).assemble(
        AssembleRequest(
            task="continue",
            work_id=WORK_ID,
            chapter_id="c2",
            prefix="前" * 2000,
            suffix="后" * 600,
        )
    )
    assert bundle.dropped == ()
    assert all(not b.truncated for b in bundle.blocks)
    assert bundle.budget.used <= DEFAULT_CONTEXT_BUDGET
