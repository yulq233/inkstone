"""v1 上下文装配器（``docs/11`` §3.5）。

## 为什么写成"两版"

`docs/01` §8.1 的记忆金字塔里，L0（Codex 精选）/L1/L2（分层摘要）/L5（混合检索）
**全部依赖 M2**，而 M2 一行代码都没有。如果坚持"装配器做齐了再开 AI"，
AI 就得等两个里程碑。所以接口在 v1 定死，实现分两版：

- **v1（本文件）**：系统指令（含风格卡）+ 本章光标前后文（L4）+ 相邻章节片段 + 手写「设定.md」。
  依赖只有 M0 的正文读写，**立刻可用**。
- **v2（P3）**：上面这些 + Codex 精选 + L1/L2 摘要 + 混合检索。依赖 M2。

v1 里"相邻章节片段"是 L3（近章摘要）的廉价替代：只取上一章**结尾**与下一章**开头**
各若干字。它不解释"发生了什么"，但对保持文气与称呼连贯已经够用。

**`ContextBundle` 的形状在 v1 定死后不再改** —— 换 v2 时只换 `_collect()`，
上层（端点、渲染进程的预览面板）一行不动。

## `dropped` 为什么是必需品而不是调试信息

模型写崩的时候，用户第一个问题永远是"它到底看到了什么"。只给一个总数等于不给。
所以被预算丢掉的块**必须回报**，UI 上要能展开看"本次实际发送的内容"。
它同时满足隐私要求（`docs/11` §6.4 的「将发送什么」预览）—— 一份数据两个用途。

## 预算为什么是"假设值 + 源上限"两层

v1 拿不到模型的上下文窗口（`ai-types.ts` 的 `ModelSpec` 只有 id/label，
原则是"拉不到就不编"），所以：

1. **先限源**：每个来源都有字符上限（前文 2000 字、设定 2000 字、相邻章各 300 字）。
   正常的一章配一次续写，这些加起来远达不到预算 —— **预算大多是兜底，不是常态**。
2. **再兜底**：`budget` 按"最小可用模型"的假设留量，超了才动刀，且动刀的结果进 `dropped`。

这样"预算"不会变成一个天天在砍上下文、用户却看不见的东西。
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from ..domain.paths import WorkPaths
from ..errors import AiContextTooLong
from .prompts import PromptTemplate, load_template, render
from .tokens import estimate_tokens, truncate_head, truncate_tail

logger = logging.getLogger("inkstone.ai.context")

# ---- 每个来源的字符上限（**先限源**，见模块说明）----
PREFIX_TAIL_CHARS = 2_000
SUFFIX_HEAD_CHARS = 600
ADJACENT_TAIL_CHARS = 300
ADJACENT_HEAD_CHARS = 300
SETTINGS_MD_CHARS = 2_000
STYLE_CARD_CHARS = 800

# ---- 预算（**兜底**）----
#: 假设的上下文窗口。取 8192 这个**下限**值：拉不到模型的真实窗口，就按最小的算。
WINDOW_ASSUMED = 8_192
#: 给模型输出留的量（一次续写最多几百 token，这里给足）。
RESERVED_FOR_OUTPUT = 2_048
#: 模板骨架（标题、说明文字）的预留。写死一个够用的值，避免为它做一次精确渲染。
INSTRUCTION_ALLOWANCE = 256
#: 装配预算。P3 拿到模型目录后改成按模型取值。
DEFAULT_CONTEXT_BUDGET = WINDOW_ASSUMED - RESERVED_FOR_OUTPUT

#: 截断之后如果剩不到这么多 token，就干脆整块丢掉 ——
#: 留一句没头没尾的片段比不留更糟（模型会顺着半句话瞎编）。
MIN_KEEP_TOKENS = 64

#: 渲染槽位 → `docs/01` 的层级名。只为了在 `dropped` 里让用户看懂"丢的是哪一层"。
SLOT_SOURCE: dict[str, str] = {
    "settings": "manual",
    "prefix": "L4",
    "suffix": "L4",
    "adjacent": "L3",
}


@dataclass(frozen=True, slots=True)
class Block:
    """一块要发给模型的内容。

    ``tokens`` 刻意做成**算出来的属性**而不是字段：字段可以与 `text` 漂移，
    而"声明的 token 数与实际不符"会让预算判断静默失准 —— 那正是最难查的一类问题。
    """

    slot: str
    title: str
    text: str
    #: 超预算时从哪边砍：``'head'``（留开头）/ ``'tail'``（留结尾）/ ``None``（整块丢）。
    #: 前文要留**结尾**（模型才接得上），参考资料要留**开头**。
    trim: str | None = None
    truncated: bool = False

    @property
    def source(self) -> str:
        return SLOT_SOURCE.get(self.slot, "manual")

    @property
    def tokens(self) -> int:
        return estimate_tokens(self.text)


@dataclass(frozen=True, slots=True)
class Drop:
    source: str
    title: str
    tokens: int
    #: ``'budget'``（预算不够）或 ``'offline'``（纯本地模式，保留给判据前移的情况）。
    reason: str


@dataclass(frozen=True, slots=True)
class BudgetReport:
    budget: int
    used: int
    remaining: int


@dataclass(frozen=True, slots=True)
class ContextBundle:
    """发给模型的一份完整上下文。**形状定死于 v1**（见模块说明）。"""

    system: str
    blocks: tuple[Block, ...]
    user: str
    dropped: tuple[Drop, ...]
    budget: BudgetReport
    #: 提示模板的 id 与版本，进 `ai_run` 便于"同一段文字、换了模板"的回归对比。
    template_id: str
    template_version: int
    temperature: float


@dataclass(frozen=True, slots=True)
class AssembleRequest:
    task: str
    work_id: str
    chapter_id: str
    #: 光标前文。**渲染进程给的** —— sidecar 读磁盘读到的是上次保存的版本，
    #: 用户敲完还没保存的那些字它看不见。
    prefix: str
    suffix: str = ""
    intent: str = ""
    style_card: str = ""
    #: ``quick`` 的子类型（naming / dialogue / …）。
    kind: str = ""


class Workspace(Protocol):
    """装配器需要的**只读**作品视图。

    抽成协议是为了能用假实现测：装配逻辑（哪些块、丢哪个、渲染成什么）
    是这一步最容易出错的部分，而它不该依赖真实文件系统。
    """

    def paths(self, work_id: str) -> WorkPaths: ...

    async def chapter_ids(self, work_id: str) -> list[str]: ...

    async def read_chapter(self, work_id: str, chapter_id: str) -> str: ...


def plan_blocks(budget: int, blocks: Sequence[Block]) -> tuple[list[Block], list[Drop]]:
    """按预算挑块。**纯函数**，不碰网络也不碰磁盘，可以穷举测试。

    按给定顺序（= 优先级）贪心放行；放不下的先尝试按 ``trim`` 截断，
    截到不足 `MIN_KEEP_TOKENS` 就整块丢掉并**记进 dropped**。
    """
    kept: list[Block] = []
    dropped: list[Drop] = []
    remaining = budget

    for block in blocks:
        if block.text == "":
            continue  # 空块不算块：它会让 dropped 里出现一堆"丢了 0 token 的东西"
        if block.tokens <= remaining:
            kept.append(block)
            remaining -= block.tokens
            continue
        if block.trim is None or remaining < MIN_KEEP_TOKENS:
            dropped.append(Drop(block.source, block.title, block.tokens, "budget"))
            continue
        # 截完不再复查大小：`truncate_*` 与 `estimate_tokens` 共用同一套逐字符成本走法
        # （`ai/tokens.py` 的 `_costs`），所以"截出来仍超预算"在数学上不会发生。
        # 再判一次只会把"那套走法真的坏了"掩盖成一次静默丢块。
        trimmed = _trim(block, remaining)
        kept.append(trimmed)
        remaining -= trimmed.tokens

    return kept, dropped


def _trim(block: Block, max_tokens: int) -> Block:
    text = (
        truncate_tail(block.text, max_tokens)
        if block.trim == "tail"
        else truncate_head(block.text, max_tokens)
    )
    return Block(slot=block.slot, title=block.title, text=text, trim=block.trim, truncated=True)


class Assembler:
    def __init__(self, workspace: Workspace, *, budget: int = DEFAULT_CONTEXT_BUDGET) -> None:
        self._workspace = workspace
        self._budget = budget

    async def assemble(self, req: AssembleRequest) -> ContextBundle:
        template = load_template(req.task)
        style_card = _cap(req.style_card.strip(), STYLE_CARD_CHARS)

        candidates = await self._collect(req)
        # 模板骨架与系统指令也占 token，必须先扣掉再分配块预算 ——
        # 不扣的话"预算内"的装配结果仍可能超窗口，而那会在上游以 400 的形式出现。
        system_preview = _render_system(template, style_card, req)
        overhead = estimate_tokens(system_preview) + INSTRUCTION_ALLOWANCE
        kept, dropped = plan_blocks(max(0, self._budget - overhead), candidates)

        by_slot = {block.slot: block for block in kept}
        user = _render_user(template, by_slot, req)
        used = estimate_tokens(system_preview) + estimate_tokens(user)

        if not kept:
            # 一个块都没有 = 没东西可写。**不静默发一个空请求**（模型会自由发挥，
            # 而用户以为自己是在续写），也不报成"上下文超长"那种让用户去缩短选区的指引
            # —— 这里的处置是"补内容"，所以带一句自己的 message（见 AiContextTooLong）。
            logger.warning(
                "装配结果为空，可能预算过小或前文为空",
                extra={"extra_fields": {"task": req.task, "budget": self._budget}},
            )
            raise AiContextTooLong(
                message="这次没有可以发送的内容：本章还没有正文，也没有找到作品设定。"
                "请先写几句，或在作品根目录新建「设定.md」后重试。"
            )

        bundle = ContextBundle(
            system=system_preview,
            blocks=tuple(kept),
            user=user,
            dropped=tuple(dropped),
            budget=BudgetReport(
                budget=self._budget, used=used, remaining=max(0, self._budget - used)
            ),
            template_id=template.id,
            template_version=template.version,
            temperature=template.temperature,
        )
        logger.info(
            "上下文已装配",
            extra={
                "extra_fields": {
                    "task": req.task,
                    "blocks": len(bundle.blocks),
                    "dropped": len(bundle.dropped),
                    "usedTokens": used,
                    "budget": self._budget,
                }
            },
        )
        return bundle

    # ------------------------------------------------------------------
    # 收集
    # ------------------------------------------------------------------

    async def _collect(self, req: AssembleRequest) -> list[Block]:
        """按**优先级**返回候选块（越靠前越先保住）。

        顺序刻意与模板里的呈现顺序不同：呈现顺序要顺着读（设定在前、前文在后），
        而**丢块顺序**要按重要性 —— 先丢相邻章，最后才动前文。
        """
        paths = self._workspace.paths(req.work_id)
        chapter_ids = await self._workspace.chapter_ids(req.work_id)

        blocks: list[Block] = [
            Block(
                slot="prefix",
                title="本章前文",
                text=_cap_tail(req.prefix.strip(), PREFIX_TAIL_CHARS),
                trim="tail",
            ),
            Block(
                slot="settings",
                title="作品设定",
                text=await self._read_settings(paths),
                trim="head",
            ),
            Block(
                slot="suffix",
                title="光标之后的已有内容",
                text=_cap(req.suffix.strip(), SUFFIX_HEAD_CHARS),
                trim="head",
            ),
            Block(
                slot="adjacent",
                title="相邻章节片段",
                text=await self._read_adjacent(req, chapter_ids),
                trim="head",
            ),
        ]
        return blocks

    async def _read_settings(self, paths: WorkPaths) -> str:
        """读作品根目录的「设定.md」。**没有就当空**（不是错误）。"""
        return await _read_text_capped(paths.settings_md, SETTINGS_MD_CHARS)

    async def _read_adjacent(self, req: AssembleRequest, chapter_ids: list[str]) -> str:
        """上一章的**结尾** + 下一章的**开头**。

        这是 L3（近章摘要）在 v1 的廉价替代：它不解释"发生了什么"，
        只提供"紧挨着的那些字"，对保持文气与称呼连贯已经够用。
        真正的近章摘要要等 M2。
        """
        if req.chapter_id not in chapter_ids:
            return ""
        index = chapter_ids.index(req.chapter_id)
        parts: list[str] = []

        previous = chapter_ids[index - 1] if index > 0 else None
        if previous is not None:
            text = (await self._workspace.read_chapter(req.work_id, previous)).strip()
            parts.append(f"（上一章结尾）{_cap_tail(text, ADJACENT_TAIL_CHARS)}")

        following = chapter_ids[index + 1] if index + 1 < len(chapter_ids) else None
        if following is not None:
            text = (await self._workspace.read_chapter(req.work_id, following)).strip()
            parts.append(f"（下一章开头）{_cap(text, ADJACENT_HEAD_CHARS)}")

        return "\n".join(part for part in parts if part.strip() != "")


# ---------------------------------------------------------------------------
# 渲染
# ---------------------------------------------------------------------------


def _render_system(template: PromptTemplate, style_card: str, req: AssembleRequest) -> str:
    parts = [template.system.strip()]
    if style_card != "":
        parts.append(f"【风格要求】\n{style_card}")
    if req.intent.strip() != "" and req.task == "continue":
        parts.append(f"【本次的额外约束】\n{req.intent.strip()}")
    return "\n\n".join(parts)


def _render_user(
    template: PromptTemplate, by_slot: dict[str, Block], req: AssembleRequest
) -> str:
    def slot(name: str, empty: str = "（无）") -> str:
        block = by_slot.get(name)
        if block is None or block.text.strip() == "":
            return empty
        return block.text

    instruction = ""
    if req.task == "quick":
        instruction = template.kinds.get(req.kind, "")
        if instruction == "":
            # 未知 kind 不静默：模板没写这句指令时模型会自由发挥，
            # 而用户看到的是一段"没按要求来的"输出，很难联想到是 kind 写错了。
            logger.warning(
                "快捷生成的 kind 没有对应的指令",
                extra={"extra_fields": {"kind": req.kind}},
            )

    values = {
        "settings": slot("settings"),
        "prefix": slot("prefix"),
        "suffix": slot("suffix"),
        "adjacent": slot("adjacent"),
        "intent": req.intent.strip() or "（无）",
        "instruction": instruction,
    }
    return render(template.user, values).strip()


async def _read_text_capped(path: Path, max_chars: int) -> str:
    """读一个可选文件并限长。文件不存在、读不动、或是个目录 → 都当空串。

    **刻意不抛**：设定文件缺失是**正常状态**（新建的作品本来就没有），
    而"因为少一个可选文件就不让用户续写"是明显更差的取舍。
    """
    try:
        text = await asyncio.to_thread(path.read_text, encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        # 记一条日志但不打扰用户：文件坏了（编码不对）时用户需要知道"设定没生效"。
        if isinstance(exc, UnicodeDecodeError):
            logger.warning(
                "设定文件不是 UTF-8，已忽略",
                extra={"extra_fields": {"path": str(path)}},
            )
        return ""
    return _cap(text.strip(), max_chars)


def _cap(text: str, max_chars: int) -> str:
    """按**字符**截断（不是按 token）。

    这里用字符而不是 token 是刻意的：源上限是"我不希望一次带超过这么多字"这种
    **直觉性的量**，用字符表达最直观；token 预算由 `plan_blocks` 兜底。
    两处都用 token 也不会更准 —— 估算本来就是估的。
    """
    return text if len(text) <= max_chars else text[:max_chars].rstrip()


def _cap_tail(text: str, max_chars: int) -> str:
    return text if len(text) <= max_chars else text[-max_chars:].lstrip()
