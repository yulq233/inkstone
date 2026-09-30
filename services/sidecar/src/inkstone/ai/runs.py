"""`ai_run` 记录（JSONL 追加写，``docs/11`` §3.6）。

## 为什么是"两个文件"而不是一个可改的记录

``runs.jsonl`` 同时承担两件事：运行统计，以及**外发审计**（``egressChars``，
``docs/01`` §9.3 的知情要求）。审计的全部价值在于**它没被改过** —— 所以这个文件
只追加，永不复写。用户点了"采纳"要回填的结果因此写到 ``feedback.jsonl``，
读取时按 ``id`` 合并。

代价是"读"要多一次合并。值得：另一种做法（采纳时回写 runs.jsonl 那一行）
让"某次外发记录被改过"从**不可能**变成**可能**，而事后没人能区分
"这行本来就这样"和"它被改过"。

## 为什么写盘要 `asyncio.shield`

用户点停止 → 渲染进程关掉连接 → sidecar 收到 `CancelledError`。
而这条记录恰恰是**最需要留下来**的那一条（"我按了停止，到底发出去多少字"）。
若在 `finally` 里直接 `await` 写盘，取消会立刻再把写盘打断，审计证据就没了。
``asyncio.shield`` 让内层写盘任务不被取消，外层的 `CancelledError` 照常往上抛。

## 时间戳用本地时区

``domain/clock.py`` 的既有约定（本地时间带偏移）。这不只是风格问题：
"今日用量"是**用户本地的今天**，而 `at[:10]` 与本地日期前缀比较即可，
不需要任何时区换算 —— 换成 UTC 的话，"今天"的边界会莫名其妙地落在早上 8 点。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from collections.abc import Mapping
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

from ..domain.paths import WorkPaths
from ..errors import InvalidParam

logger = logging.getLogger("inkstone.ai.runs")

#: 读记录时的默认上限。一份 JSONL 里可能攒了很久，而接口一次给不了那么多。
DEFAULT_LIMIT = 200

#: 采纳结果的三态。``None`` 表示用户还没有表态（生成完就关了窗口也算）。
ACCEPTED_VALUES: frozenset[str] = frozenset({"full", "partial", "none"})


@dataclass(frozen=True, slots=True)
class AiRunRecord:
    """一次生成的完整记录。字段名与 `docs/01` §5.1 的 `ai_run` 表逐列对齐。

    ``accepted`` / ``accepted_chars`` **不写进 runs.jsonl**（那时还不知道），
    读的时候从 ``feedback.jsonl`` 合并进来。写成"有默认值"而不是"分成两个类"，
    是因为上层只想要一条记录，不想知道它来自哪个文件。
    """

    id: str
    work_id: str
    at: str
    task_type: str
    target_ref: str
    provider_id: str
    model: str
    prompt_digest: str
    context_tokens: int
    output_tokens: int
    egress_chars: int
    latency_ms: int
    first_token_ms: int
    stopped: bool
    cost_cny: float | None = None
    selection: Mapping[str, int] | None = None
    error: str | None = None
    accepted: str | None = None
    accepted_chars: int | None = None

    def to_json(self) -> dict[str, Any]:
        """落盘用的 camelCase 形态（JSONL 的写法，``docs/11`` §3.6）。"""
        return {
            "id": self.id,
            "workId": self.work_id,
            "at": self.at,
            "taskType": self.task_type,
            "targetRef": self.target_ref,
            "selection": dict(self.selection) if self.selection is not None else None,
            "providerId": self.provider_id,
            "model": self.model,
            "promptDigest": self.prompt_digest,
            "contextTokens": self.context_tokens,
            "outputTokens": self.output_tokens,
            "egressChars": self.egress_chars,
            "costCny": self.cost_cny,
            "latencyMs": self.latency_ms,
            "firstTokenMs": self.first_token_ms,
            "accepted": self.accepted,
            "acceptedChars": self.accepted_chars,
            "stopped": self.stopped,
            "error": self.error,
        }


def parse_run(raw: object) -> AiRunRecord | None:
    """把一行 JSON 变成记录。**认不出来就返回 `None`**，由调用方跳过。

    为什么不抛：这个文件是追加写的，进程被杀时最后一行很可能是半截的。
    "因为文件末尾半行 JSON 就让整个外发记录面板打不开"是明显更糟的取舍。
    """
    if not isinstance(raw, dict):
        return None
    run_id = raw.get("id")
    at = raw.get("at")
    if not isinstance(run_id, str) or not isinstance(at, str):
        return None

    selection = raw.get("selection")
    return AiRunRecord(
        id=run_id,
        work_id=_text(raw.get("workId")),
        at=at,
        task_type=_text(raw.get("taskType")),
        target_ref=_text(raw.get("targetRef")),
        provider_id=_text(raw.get("providerId")),
        model=_text(raw.get("model")),
        prompt_digest=_text(raw.get("promptDigest")),
        context_tokens=_int(raw.get("contextTokens")),
        output_tokens=_int(raw.get("outputTokens")),
        egress_chars=_int(raw.get("egressChars")),
        latency_ms=_int(raw.get("latencyMs")),
        first_token_ms=_int(raw.get("firstTokenMs")),
        stopped=raw.get("stopped") is True,
        cost_cny=_float_or_none(raw.get("costCny")),
        selection=(
            {str(k): _int(v) for k, v in selection.items()} if isinstance(selection, dict) else None
        ),
        error=raw.get("error") if isinstance(raw.get("error"), str) else None,
        accepted=_accepted(raw.get("accepted")),
        accepted_chars=_int_or_none(raw.get("acceptedChars")),
    )


@dataclass(frozen=True, slots=True)
class RunFeedback:
    """用户对一条生成记录的表态。**落到另一个文件**（见模块说明）。"""

    id: str
    accepted: str
    accepted_chars: int

    def to_json(self) -> dict[str, Any]:
        return {"id": self.id, "accepted": self.accepted, "acceptedChars": self.accepted_chars}


class RunStore:
    """一部作品的运行记录读写。**每个请求新建一个**（它只持有一条 `WorkPaths`）。

    刻意不做进程内缓存：读取都在用户点开面板或算当日用量时发生，
    而"记录被另一个进程/另一处追加了、缓存却是旧的"会让外发审计看起来少了几条 ——
    那正是最不能出错的地方。
    """

    def __init__(self, paths: WorkPaths) -> None:
        self._paths = paths

    # ---- 写 ----

    async def append(self, record: AiRunRecord) -> None:
        """追加一条运行记录。**不被取消打断**（见模块说明）。"""
        await asyncio.shield(self._append(record))

    async def _append(self, record: AiRunRecord) -> None:
        await asyncio.to_thread(_append_line, self._paths.ai_runs_jsonl, record.to_json())

    async def append_feedback(self, feedback: RunFeedback) -> None:
        """记一条采纳结果。先确认那条运行记录确实存在。

        不校验的话，孤儿反馈只会静静地躺在文件里永不生效 —— 而它意味着
        "这次生成的记录丢了"，正是审计该发现的问题。宁可当场报一次。
        """
        if not await self.has(feedback.id):
            raise InvalidParam(
                "找不到这条生成记录，无法回填采纳结果。",
                detail={"runId": feedback.id},
            )
        await asyncio.to_thread(_append_line, self._paths.ai_feedback_jsonl, feedback.to_json())

    # ---- 读 ----

    async def read(self, *, limit: int = DEFAULT_LIMIT, since: str = "") -> list[AiRunRecord]:
        """读运行记录（新的在前），合并采纳结果。

        ``since`` 是 ISO 时间前缀比较（如 ``"2026-09-28"`` 表示当天）。
        前缀比较成立，是因为 `at` 一律由 `now_iso()` 产出、格式固定。
        """
        runs = await asyncio.to_thread(read_runs, self._paths.ai_runs_jsonl)
        feedback = await asyncio.to_thread(_read_feedback, self._paths.ai_feedback_jsonl)

        merged = [
            replace(run, accepted=fb.accepted, accepted_chars=fb.accepted_chars)
            if (fb := feedback.get(run.id)) is not None
            else run
            for run in runs
        ]
        if since:
            merged = [run for run in merged if run.at >= since]
        return merged[:limit]

    async def has(self, run_id: str) -> bool:
        runs = await asyncio.to_thread(read_runs, self._paths.ai_runs_jsonl)
        return any(run.id == run_id for run in runs)


# ---------------------------------------------------------------------------
# 文件层
# ---------------------------------------------------------------------------


def _append_line(path: Path, payload: Mapping[str, Any]) -> None:
    """追加一行 JSON。

    **不做原子替换**：原子写要"读全文 → 写临时文件 → 替换"，而它恰好会破坏
    "只追加"这条保证（替换期间文件一度不存在/内容不同）。这里要的是相反的性质：
    只往末尾写，崩溃最多留下一行半截的 JSON —— 而 `parse_run` 会跳过它。

    `fsync` 是必须的：不 fsync 时"记录已写"只是写进了页缓存，
    而断电正是留下审计缺口的那种场景。
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n"
    with path.open("a", encoding="utf-8", newline="\n") as handle:
        handle.write(line)
        handle.flush()
        os.fsync(handle.fileno())


def _read_lines(path: Path) -> list[str]:
    try:
        return path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []


def read_runs(path: Path, *, limit: int = 0) -> list[AiRunRecord]:
    """读一个 ``runs.jsonl``，**新的在前**。

    ``limit=0`` 表示不限。当日用量聚合要走全量（它只关心今天那几条，
    但今天是文件里的哪几条只有读完才知道），所以不能沿用接口层的默认上限。
    """
    records: list[AiRunRecord] = []
    for line in _read_lines(path):
        if line.strip() == "":
            continue
        try:
            raw = json.loads(line)
        except json.JSONDecodeError:
            # 半截行（进程被杀）或手改坏了的行。跳过但留痕：
            # 静默跳过会让"外发记录少了一条"永远查不出来。
            logger.warning("跳过无法解析的运行记录行", extra={"extra_fields": {"path": str(path)}})
            continue
        record = parse_run(raw)
        if record is not None:
            records.append(record)
    records.reverse()  # 文件里是追加顺序（旧→新），接口要新→旧
    return records[:limit] if limit > 0 else records


def _read_feedback(path: Path) -> dict[str, RunFeedback]:
    """读采纳结果，**后写的覆盖先写的**（用户改了主意时以最后一次为准）。"""
    result: dict[str, RunFeedback] = {}
    for line in _read_lines(path):
        if line.strip() == "":
            continue
        try:
            raw = json.loads(line)
        except json.JSONDecodeError:
            logger.warning("跳过无法解析的采纳记录行", extra={"extra_fields": {"path": str(path)}})
            continue
        if not isinstance(raw, dict):
            continue
        run_id = raw.get("id")
        accepted = _accepted(raw.get("accepted"))
        if not isinstance(run_id, str) or accepted is None:
            continue
        result[run_id] = RunFeedback(
            id=run_id, accepted=accepted, accepted_chars=_int(raw.get("acceptedChars"))
        )
    return result


# ---------------------------------------------------------------------------
# 值收敛
# ---------------------------------------------------------------------------


def _text(value: object) -> str:
    return value if isinstance(value, str) else ""


def _int(value: object) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def _int_or_none(value: object) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _float_or_none(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _accepted(value: object) -> str | None:
    return value if isinstance(value, str) and value in ACCEPTED_VALUES else None
