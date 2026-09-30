"""运行记录与当日用量（``ai/runs.py`` / ``ai/usage.py`` / ``ai/pricing.py``）。

这一份测的是**审计链路**：`egressChars` 是「用户有权知道发出去了多少字」的唯一证据，
而它只有在三个条件下才可信 ——

1. 记录写下来了，**包括用户按了停止的那一次**（`asyncio.shield` 的用途）；
2. `runs.jsonl` 是只追加的，采纳结果另写一个文件（否则"记录被改过"无法排除）；
3. 半截行只丢那一行，不让整个面板打不开。
"""

from __future__ import annotations

import asyncio
import json
import os
import threading
from pathlib import Path

import pytest

from inkstone.ai.pricing import estimate_cost, price_per_k
from inkstone.ai.runs import AiRunRecord, RunFeedback, RunStore, parse_run, read_runs
from inkstone.ai.state import ProviderConfig
from inkstone.ai.usage import UsageLedger
from inkstone.domain.clock import now_iso
from inkstone.domain.paths import WorkPaths
from inkstone.errors import InvalidParam

CLOUD = ProviderConfig(
    id="deepseek",
    kind="openai-compatible",
    label="DeepSeek",
    base_url="https://api.deepseek.com/v1",
    local=False,
    needs_key=True,
)
LOCAL = ProviderConfig(
    id="ollama",
    kind="ollama",
    label="Ollama（本机）",
    base_url="http://127.0.0.1:11434",
    local=True,
    needs_key=False,
)


def _record(
    *,
    id: str = "r_abc123",
    at: str | None = None,
    cost_cny: float | None = 0.0031,
    egress_chars: int = 3210,
    stopped: bool = False,
) -> AiRunRecord:
    return AiRunRecord(
        id=id,
        work_id="w_1",
        at=at if at is not None else now_iso(),
        task_type="continue",
        target_ref="chapter:ch_1",
        provider_id="deepseek",
        model="deepseek-chat",
        prompt_digest="sha256:0000",
        context_tokens=1800,
        output_tokens=400,
        egress_chars=egress_chars,
        latency_ms=4210,
        first_token_ms=680,
        stopped=stopped,
        cost_cny=cost_cny,
    )


class TestStore:
    @pytest.mark.asyncio
    async def test_append_and_read_newest_first(self, tmp_path: Path) -> None:
        store = RunStore(WorkPaths(tmp_path))
        await store.append(_record(id="r_1"))
        await store.append(_record(id="r_2"))

        runs = await store.read()
        assert [run.id for run in runs] == ["r_2", "r_1"]
        assert runs[0].egress_chars == 3210
        assert runs[0].cost_cny == 0.0031

    @pytest.mark.asyncio
    async def test_the_file_is_appended_not_rewritten(self, tmp_path: Path) -> None:
        """`runs.jsonl` 是审计流：写第二条不能改动第一条的字节。"""
        paths = WorkPaths(tmp_path)
        store = RunStore(paths)
        await store.append(_record(id="r_1"))
        first = paths.ai_runs_jsonl.read_bytes()

        await store.append(_record(id="r_2"))
        assert paths.ai_runs_jsonl.read_bytes().startswith(first)

    @pytest.mark.asyncio
    async def test_feedback_lands_in_another_file_and_merges_on_read(
        self, tmp_path: Path
    ) -> None:
        paths = WorkPaths(tmp_path)
        store = RunStore(paths)
        await store.append(_record(id="r_1"))
        before = paths.ai_runs_jsonl.read_bytes()

        await store.append_feedback(RunFeedback(id="r_1", accepted="partial", accepted_chars=412))

        # 关键：runs.jsonl **一个字节都没变**
        assert paths.ai_runs_jsonl.read_bytes() == before
        assert paths.ai_feedback_jsonl.is_file()
        run = (await store.read())[0]
        assert run.accepted == "partial"
        assert run.accepted_chars == 412

    @pytest.mark.asyncio
    async def test_later_feedback_wins(self, tmp_path: Path) -> None:
        """用户改了主意（先采纳一半，后来全采纳）以最后一次为准。"""
        paths = WorkPaths(tmp_path)
        store = RunStore(paths)
        await store.append(_record(id="r_1"))
        await store.append_feedback(RunFeedback(id="r_1", accepted="partial", accepted_chars=100))
        await store.append_feedback(RunFeedback(id="r_1", accepted="full", accepted_chars=412))
        run = (await store.read())[0]
        assert run.accepted == "full"
        assert run.accepted_chars == 412

    @pytest.mark.asyncio
    async def test_feedback_for_an_unknown_run_is_rejected(self, tmp_path: Path) -> None:
        """孤儿反馈意味着那条运行记录丢了 —— 正是审计该发现的事，不能静静收下。"""
        store = RunStore(WorkPaths(tmp_path))
        feedback = RunFeedback(id="r_不存在", accepted="full", accepted_chars=1)
        with pytest.raises(InvalidParam):
            await store.append_feedback(feedback)

    @pytest.mark.asyncio
    async def test_torn_last_line_is_skipped_not_fatal(self, tmp_path: Path) -> None:
        paths = WorkPaths(tmp_path)
        store = RunStore(paths)
        await store.append(_record(id="r_1"))
        # 模拟进程被杀：末尾留下半截 JSON
        with paths.ai_runs_jsonl.open("a", encoding="utf-8") as handle:
            handle.write('{"id":"r_2","at":"2026-09')

        runs = await store.read()
        assert [run.id for run in runs] == ["r_1"]

    @pytest.mark.asyncio
    async def test_since_filters_by_day_prefix(self, tmp_path: Path) -> None:
        paths = WorkPaths(tmp_path)
        store = RunStore(paths)
        await store.append(_record(id="r_old", at="2020-01-01T10:00:00+08:00"))
        await store.append(_record(id="r_new"))

        runs = await store.read(since=now_iso()[:10])
        assert [run.id for run in runs] == ["r_new"]

    @pytest.mark.asyncio
    async def test_append_survives_cancellation(self, tmp_path: Path) -> None:
        """**用户按停止时的那条记录最不能丢。**

        取消打在等待写盘的 `await` 上。若不用 `asyncio.shield` 包住，
        内层写盘会被一并打断 —— 于是"我按了停止，到底发出去多少字"永远查不到。
        """
        paths = WorkPaths(tmp_path)
        store = RunStore(paths)

        task = asyncio.create_task(store.append(_record(id="r_stopped", stopped=True)))
        await asyncio.sleep(0)  # 让任务进到 await 里
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

        # 取消照常往上抛；记录在下一次事件循环里落地（写盘是另一个线程）。
        # 轮询而不是 sleep 一个定值：写盘被真的取消时它会一直等不到，测试就红了。
        for _ in range(200):
            if paths.ai_runs_jsonl.is_file():
                break
            await asyncio.sleep(0.005)

        runs = await asyncio.to_thread(read_runs, paths.ai_runs_jsonl)
        assert [run.id for run in runs] == ["r_stopped"]
        assert runs[0].stopped is True


class TestParse:
    def test_unknown_garbage_returns_none(self) -> None:
        assert parse_run("不是对象") is None
        assert parse_run({}) is None
        assert parse_run({"id": "r_1"}) is None  # 缺 at

    def test_missing_optional_fields_get_neutral_values(self) -> None:
        """手改过 / 旧版本写的行不该让整条记录消失，缺的字段取中性值。"""
        run = parse_run({"id": "r_1", "at": "2026-09-28T10:00:00+08:00"})
        assert run is not None
        assert run.egress_chars == 0
        assert run.cost_cny is None
        assert run.stopped is False
        assert run.accepted is None

    def test_bogus_accepted_value_is_dropped(self) -> None:
        run = parse_run({"id": "r_1", "at": "x", "accepted": "maybe"})
        assert run is not None
        assert run.accepted is None

    def test_to_json_is_camel_case_and_plain_data(self) -> None:
        payload = _record().to_json()
        assert set(payload) == {
            "id",
            "workId",
            "at",
            "taskType",
            "targetRef",
            "selection",
            "providerId",
            "model",
            "promptDigest",
            "contextTokens",
            "outputTokens",
            "egressChars",
            "costCny",
            "latencyMs",
            "firstTokenMs",
            "accepted",
            "acceptedChars",
            "stopped",
            "error",
        }
        # 必须是能直接 json.dumps 的纯数据（落盘就靠它）
        json.dumps(payload)

    def test_round_trip_preserves_every_field(self) -> None:
        original = _record(id="r_rt", cost_cny=None, egress_chars=77, stopped=True)
        restored = parse_run(json.loads(json.dumps(original.to_json())))
        assert restored == original


class TestPricing:
    def test_known_model_is_priced(self) -> None:
        assert price_per_k("deepseek-chat") == (0.002, 0.008)
        # 更具体的模式优先：reasoner 不能被泛化的 "deepseek" 吃掉
        assert price_per_k("deepseek-reasoner") == (0.004, 0.016)
        assert price_per_k("qwen3-max-2026-05-17") == (0.0024, 0.0096)

    def test_unknown_model_is_not_invented(self) -> None:
        assert price_per_k("my-local-ft-v3") is None

    def test_local_model_costs_zero_not_unknown(self) -> None:
        """本机模型是 0 元（只花电），不是"未知" —— 未知会让预算护栏无法判断。"""
        assert (
            estimate_cost(LOCAL, "whatever", prompt_tokens=10_000, completion_tokens=10_000) == 0.0
        )

    def test_cost_scales_with_tokens(self) -> None:
        cost = estimate_cost(CLOUD, "deepseek-chat", prompt_tokens=1_000, completion_tokens=1_000)
        assert cost == pytest.approx(0.002 + 0.008)

    def test_unknown_cloud_model_gives_none(self) -> None:
        assert estimate_cost(CLOUD, "custom-v9", prompt_tokens=1000, completion_tokens=1000) is None


class TestUsageLedger:
    @pytest.mark.asyncio
    async def test_roots_are_read_off_the_event_loop_thread(self) -> None:
        """读"最近作品列表"必须**离开事件循环线程**（`docs/13` M7）。

        注入的 `_roots` 是同步函数（它要读 `recent-works.json`，并对每条记录做一次
        `is_file()`），而 `today()` 在**每次生成之前**都会跑（预算护栏）。
        直接在事件循环里调它，外置盘/网络盘上就会把整个 sidecar 卡住一段时间 ——
        期间所有请求一起无响应，而用户看到的是"点了续写，界面整个僵住"。

        这里断言的是**在哪个线程跑**，不是"快不快"：快的机器上那点耗时根本测不出来，
        而线程归属是确定性的，也正是这次修复的全部内容。
        """
        main_thread = threading.get_ident()
        seen: list[int] = []

        def roots() -> list[str]:
            seen.append(threading.get_ident())
            return []

        await UsageLedger(roots).today()

        assert len(seen) == 1  # 只读一次（不是每个作品读一次）
        assert seen[0] != main_thread

    @pytest.mark.asyncio
    async def test_sums_only_today(self, tmp_path: Path) -> None:
        root = tmp_path / "作品甲"
        store = RunStore(WorkPaths(root))
        await store.append(_record(id="r_old", at="2020-01-01T10:00:00+08:00", cost_cny=99.0))
        await store.append(_record(id="r_today", cost_cny=1.5, egress_chars=100))

        summary = await UsageLedger(lambda: [str(root)]).today()
        assert summary.spent_cny == 1.5
        assert summary.runs == 1
        assert summary.egress_chars == 100
        assert summary.works == 1

    @pytest.mark.asyncio
    async def test_aggregates_across_works(self, tmp_path: Path) -> None:
        """预算上限是**用户**的，不是某个作品的 —— 不然开三个作品就能用超三倍。"""
        roots = [tmp_path / "甲", tmp_path / "乙"]
        for index, root in enumerate(roots):
            await RunStore(WorkPaths(root)).append(_record(id=f"r_{index}", cost_cny=1.0))

        summary = await UsageLedger(lambda: [str(r) for r in roots]).today()
        assert summary.spent_cny == 2.0
        assert summary.works == 2

    @pytest.mark.asyncio
    async def test_unpriced_runs_are_counted_and_reported(self, tmp_path: Path) -> None:
        """认不出模型时成本是 None（不编数），但必须让"统计偏低"这件事可见。"""
        root = tmp_path / "甲"
        store = RunStore(WorkPaths(root))
        await store.append(_record(id="r_x", cost_cny=None))
        await store.append(_record(id="r_y", cost_cny=0.5))

        summary = await UsageLedger(lambda: [str(root)]).today()
        assert summary.spent_cny == 0.5
        assert summary.unpriced_runs == 1

    @pytest.mark.asyncio
    async def test_missing_work_directory_is_not_an_error(self, tmp_path: Path) -> None:
        summary = await UsageLedger(lambda: [str(tmp_path / "已被删掉")]).today()
        assert summary.spent_cny == 0.0
        assert summary.works == 0
        assert summary.date == now_iso()[:10]

    @pytest.mark.asyncio
    async def test_cache_is_invalidated_when_the_file_grows(self, tmp_path: Path) -> None:
        root = tmp_path / "甲"
        paths = WorkPaths(root)
        store = RunStore(paths)
        await store.append(_record(id="r_1", cost_cny=1.0))

        ledger = UsageLedger(lambda: [str(root)])
        assert (await ledger.today()).spent_cny == 1.0

        await store.append(_record(id="r_2", cost_cny=2.0))
        assert (await ledger.today()).spent_cny == 3.0

    @pytest.mark.asyncio
    async def test_cache_is_invalidated_when_only_the_content_changes(self, tmp_path: Path) -> None:
        """同长度、被外部改动过的文件也必须重算（缓存的键里有 mtime，不只是 size）。"""
        root = tmp_path / "甲"
        paths = WorkPaths(root)
        await RunStore(paths).append(_record(id="r_1", cost_cny=1.5))

        ledger = UsageLedger(lambda: [str(root)])
        assert (await ledger.today()).spent_cny == 1.5

        raw = paths.ai_runs_jsonl.read_text(encoding="utf-8")
        assert '"costCny":1.5' in raw
        paths.ai_runs_jsonl.write_text(
            raw.replace('"costCny":1.5', '"costCny":2.5'), encoding="utf-8"
        )
        # 显式推一下 mtime：Windows 的 mtime 粒度可能让"刚改过"与"刚读过"看起来一样，
        # 那样这条用例就会因为环境而假绿。
        stamp = paths.ai_runs_jsonl.stat().st_mtime_ns + 1_000_000_000
        os.utime(paths.ai_runs_jsonl, ns=(stamp, stamp))

        assert (await ledger.today()).spent_cny == 2.5
