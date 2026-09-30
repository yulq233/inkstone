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
from typing import Any, Protocol

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
# expand（docs/16 D-5）专用：目标条目 body 只取**尾**若干字（用户最近补的描述最相关）。
EXPAND_BODY_TAIL_CHARS = 600
#: 关联条目 summary 单条上限与总条数上限（docs/16 D-5）。
EXPAND_RELATION_SUMMARY_CHARS = 120
EXPAND_RELATION_MAX_ITEMS = 10
#: 总纲只取**头**若干字（世界观、主题、整体基调都在开头）。
EXPAND_GENERAL_HEAD_CHARS = 1_500

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
    # expand 的三块来源（docs/16 D-5）：条目现值 / 关联条目 / 总纲。
    "entry": "L0",
    "relations": "L0",
    "general_outline": "manual",
}

#: expand 的 `type` → 中文名（docs/16 D-6：模板里用 `{entry_type}` 变量换措辞）。
#: 键与 `domain/codex.py` 的 `CODEX_TYPES` 一一对应；未知值回落成"设定"，
#: 装配不因为一个拼错的 type 就失败 —— 它本来就在模板里只是个措辞变量。
ENTRY_TYPE_LABELS: dict[str, str] = {
    "character": "人物",
    "location": "地点",
    "faction": "势力",
    "item": "物品",
    "concept": "概念",
}

#: expand 的 `target` → 中文名。``summary`` = 核心梗概（进 L0 精选），
#: ``body`` = 完整描述（进正文草稿区）。未知值回落成"描述"，理由同上。
TARGET_LABELS: dict[str, str] = {
    "summary": "梗概",
    "body": "描述",
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
    #: expand 专用（docs/16 D-5）：目标条目类型与 slug，以及产物目标。
    #: ``target`` 只可能是 ``summary`` / ``body``，其余任务用不到、保持默认空串。
    entry_type: str = ""
    slug: str = ""
    target: str = ""


class Workspace(Protocol):
    """装配器需要的**只读**作品视图。

    抽成协议是为了能用假实现测：装配逻辑（哪些块、丢哪个、渲染成什么）
    是这一步最容易出错的部分，而它不该依赖真实文件系统。
    """

    def paths(self, work_id: str) -> WorkPaths: ...

    async def chapter_ids(self, work_id: str) -> list[str]: ...

    async def read_chapter(self, work_id: str, chapter_id: str) -> str: ...

    # ---- expand 专用（docs/16 D-5）。续写路径不用，但放在同一协议里以便
    # ---- 测试用一个假 Workspace 把"哪些块、丢哪个"穷举干净。
    async def read_codex_entry(
        self, work_id: str, entry_type: str, slug: str
    ) -> dict[str, Any]: ...

    async def codex_relation_summaries(
        self, work_id: str, entry: dict[str, Any]
    ) -> list[str]: ...

    async def read_general_outline(self, work_id: str) -> str: ...


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
        if req.task == "expand":
            # expand 的装配源与续写完全不同（docs/16 D-1/D-2）：读 codex 条目 +
            # 关联条目 + 总纲，不碰光标前后文与相邻章。形状仍是同一批 Block。
            return await self._collect_expand(req)

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

    # ------------------------------------------------------------------
    # expand 装配（docs/16 D-5）
    # ------------------------------------------------------------------

    async def _collect_expand(self, req: AssembleRequest) -> list[Block]:
        """expand 的装配源。**不碰**光标前后文、相邻章与「设定.md」——
        那几样对"扩充一条设定"没有用，塞进去只会白占预算（docs/16 D-1）。

        三块来源（先限源、再兜底，与续写同一条纪律）：
        1. 目标条目现值（summary + fields + body 尾若干字）—— 这是"给 AI 看的草稿"；
        2. 关联条目 summary（`relations` 指到的那些卡，各取一行）；
        3. 总纲开头（世界观描述尤其要用整体基调）。

        ``target=summary`` 与 ``target=body`` 的装配**源完全一样**，差别只在
        prompt 指令（`expand.toml` 按 target 换措辞）—— 两者都要看"这条卡
        现在写了什么"才能扩出对味的东西。
        """
        entry = await self._workspace.read_codex_entry(req.work_id, req.entry_type, req.slug)

        entry_text = _render_entry(entry)
        relations_text = await self._relations_text(req, entry)
        general_text = _cap(
            (await self._workspace.read_general_outline(req.work_id)).strip(),
            EXPAND_GENERAL_HEAD_CHARS,
        )

        # 优先级：条目现值最该保住（丢了就等于让 AI 瞎编），关联条目其次，总纲最次。
        blocks: list[Block] = []
        if entry_text.strip():
            blocks.append(
                Block(
                    slot="entry",
                    title="当前设定条目",
                    text=entry_text,
                    trim="head",
                )
            )
        if relations_text.strip():
            blocks.append(
                Block(
                    slot="relations",
                    title="关联条目",
                    text=relations_text,
                    trim="head",
                )
            )
        if general_text.strip():
            blocks.append(
                Block(
                    slot="general_outline",
                    title="作品总纲",
                    text=general_text,
                    trim="head",
                )
            )
        return blocks

    async def _relations_text(self, req: AssembleRequest, entry: dict[str, Any]) -> str:
        """把目标条目的 `relations` 翻译成"一行一个关联条目 summary"。

        每条 summary 截到 120 字、最多 10 条（docs/16 D-5）。断链（指向的 slug
        已不存在）由适配层静默跳过 —— 装配不该因为一条断链就失败。
        """
        summaries = await self._workspace.codex_relation_summaries(req.work_id, entry)
        lines: list[str] = []
        for summary in summaries[:EXPAND_RELATION_MAX_ITEMS]:
            text = _cap(summary.strip(), EXPAND_RELATION_SUMMARY_CHARS)
            if text:
                lines.append(text)
        return "\n".join(lines)


# ---------------------------------------------------------------------------
# 渲染
# ---------------------------------------------------------------------------


def _render_entry(entry: dict[str, Any]) -> str:
    """把一条 codex 条目渲染成给模型看的一段文本（expand 装配源第 1 块）。

    刻意只取"人设最该被 AI 看见"的字段：name + summary + fields（键值逐行）+
    body 尾若干字。aliases/tags/relations 不进 —— aliases 是别称列表、tags 是
    标签，对"扩出对味的小传"帮助不大，塞进去只会占预算；relations 单独一块。
    """
    parts: list[str] = []
    name = str(entry.get("name", "")).strip()
    if name:
        parts.append(f"【{name}】")

    summary = str(entry.get("summary", "")).strip()
    if summary:
        parts.append(f"梗概：{summary}")

    fields = entry.get("fields") or {}
    if isinstance(fields, dict) and fields:
        for key, value in fields.items():
            parts.append(f"{key}：{_format_field_value(value)}")

    body = str(entry.get("body", "")).strip()
    if body:
        parts.append(f"描述：{_cap_tail(body, EXPAND_BODY_TAIL_CHARS)}")

    return "\n".join(parts)


def _format_field_value(value: object) -> str:
    """把 fields 的一个标量 / 列表 / 字典值压成一行字。

    值在领域层已被约束为 `标量 | 标量列表 | 标量字典`（`domain/codex.py`），
    这里只是把它变成可读文本；列表用顿号连接、字典用 `key=value` 连接。
    """
    if isinstance(value, list):
        return "、".join(str(item) for item in value)
    if isinstance(value, dict):
        return "，".join(f"{k}={v}" for k, v in value.items())
    return str(value)


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
    elif req.task == "expand":
        # expand 的"这次要扩什么"写进模板里的 {target} / {entry_type} 变量，
        # 不是 kinds 表 —— 它与 quick 不同：只有一种动作，措辞随 target/type 换。
        # 这里为未知值兜底一个可读中文，避免模板里残留一个 {target} 字面量。
        entry_type = ENTRY_TYPE_LABELS.get(req.entry_type, "设定")
        target = TARGET_LABELS.get(req.target, "描述")
        # 这两个变量直接交给 render，模板里写 {entry_type} / {target}。
        return _render_expand_user(template, by_slot, req, entry_type, target)

    values = {
        "settings": slot("settings"),
        "prefix": slot("prefix"),
        "suffix": slot("suffix"),
        "adjacent": slot("adjacent"),
        "intent": req.intent.strip() or "（无）",
        "instruction": instruction,
    }
    return render(template.user, values).strip()


def _render_expand_user(
    template: PromptTemplate,
    by_slot: dict[str, Block],
    req: AssembleRequest,
    entry_type_label: str,
    target_label: str,
) -> str:
    def slot(name: str, empty: str = "（无）") -> str:
        block = by_slot.get(name)
        if block is None or block.text.strip() == "":
            return empty
        return block.text

    values = {
        "entry": slot("entry"),
        "relations": slot("relations"),
        "general_outline": slot("general_outline"),
        "intent": req.intent.strip() or "（无）",
        "entry_type": entry_type_label,
        "target": target_label,
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
