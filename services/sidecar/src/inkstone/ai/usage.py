"""当日 AI 用量聚合（跨作品，``docs/11`` §8.3 的预算护栏靠它）。

## 为什么要跨作品

`dailyBudgetCny` 是**用户**的单日上限，不是某个作品的。只看当前作品的话，
用户在同一天开三个作品各写一会儿，就能把限额用超三倍 —— 而护栏看起来完全正常。

## 数据从哪来

`recent-works.json` 里的作品目录 → 各自的 `.inkstone/ai/runs.jsonl`。
只扫最近打开过的作品（上限 20 个，`recent.py` 的 `MAX_ENTRIES`），
**不递归扫磁盘**：为了统计去遍历用户的小说目录既慢又越界。

代价是"一个从没被打开过的作品目录"不计入 —— 而它里面也不可能有运行记录
（记录只能由砚台自己写，而写记录必然伴随一次打开）。这条推论值得写下来，
否则以后有人会想"顺手加个全盘扫描"。

## 缓存的口径

按 ``(mtime_ns, size)`` 缓存每个文件的聚合结果。文件是**只追加**的，
所以这两个值一变大就说明有新记录 —— 不需要 invalidate 逻辑。

缓存里还存了**它是哪一天算的**：日期一变，昨天那次的聚合就不能用了。
`0 = 不限`的预算下这个缓存其实没人查，但它仍然要被正确地失效 ——
用户是可以在设置里随时打开预算的。
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path

from ..domain.clock import now_iso
from ..domain.paths import WorkPaths
from .runs import read_runs

logger = logging.getLogger("inkstone.ai.usage")


@dataclass(frozen=True, slots=True)
class UsageSummary:
    """本地**今天**的用量。"""

    date: str
    spent_cny: float
    runs: int
    #: 无法估价（模型名认不出）的条数。它 > 0 时 `spent_cny` 是**偏低**的，
    #: 所以要把这个数报出去，让"预算判断可能不准"这件事可见。
    unpriced_runs: int
    egress_chars: int
    #: 参与统计的作品数。界面用它解释"为什么统计里没有某个作品"。
    works: int


@dataclass(slots=True)
class _FileAgg:
    date: str
    spent_cny: float
    runs: int
    unpriced_runs: int
    egress_chars: int


class UsageLedger:
    """当日用量。**进程内单例**（缓存挂在实例上）。"""

    def __init__(self, roots: Callable[[], Sequence[str]]) -> None:
        # 注入一个"返回最近作品根目录"的函数，而不是直接拿 RecentStore：
        # 这样测试可以完全不碰文件系统地喂进几个目录，也能把"读不到"的
        # 情形（目录被删）单独构造出来。
        self._roots = roots
        self._cache: dict[str, tuple[int, int, _FileAgg]] = {}

    async def today(self) -> UsageSummary:
        day = now_iso()[:10]
        spent = 0.0
        runs = 0
        unpriced = 0
        egress = 0
        counted = 0

        # `_roots` 是**注入的同步函数**（它要读 `recent-works.json`），所以必须丢线程：
        # 在事件循环里直接 `self._roots()` 就是每天一次阻塞磁盘读（`docs/13` M7），
        # 而这条路径恰好在**每次生成之前**跑（预算护栏），外置盘上会明显卡。
        # 放在这里而不是要求注入方自己 async，是为了让"不阻塞"成为本类的保证 ——
        # 注入方换实现也不会把事件循环拖住。
        roots = await asyncio.to_thread(self._roots)
        for root in roots:
            agg = await self._file_agg(Path(root), day)
            if agg is None:
                continue
            counted += 1
            spent += agg.spent_cny
            runs += agg.runs
            unpriced += agg.unpriced_runs
            egress += agg.egress_chars

        return UsageSummary(
            date=day,
            spent_cny=round(spent, 6),
            runs=runs,
            unpriced_runs=unpriced,
            egress_chars=egress,
            works=counted,
        )

    async def _file_agg(self, root: Path, day: str) -> _FileAgg | None:
        path = WorkPaths(root).ai_runs_jsonl
        try:
            stat = path.stat()
        except OSError:
            # 作品目录被移走了，或这个作品还没生成过任何东西（文件不存在）。
            # 两种都不是错误：统计少一个 0 而已。
            return None

        cached = self._cache.get(str(path))
        # 缓存里存了"这是哪一天算的"：跨过零点之后它就不能再用了，
        # 所以日期也是命中的必要条件（`0 = 不限`时没人查，但用户随时能打开预算）。
        if (
            cached is not None
            and cached[0] == stat.st_mtime_ns
            and cached[1] == stat.st_size
            and cached[2].date == day
        ):
            return cached[2]

        agg = await asyncio.to_thread(_aggregate, path, day)
        self._cache[str(path)] = (stat.st_mtime_ns, stat.st_size, agg)
        return agg


def _aggregate(path: Path, day: str) -> _FileAgg:
    spent = 0.0
    runs = 0
    unpriced = 0
    egress = 0
    # `at` 是本地时间带偏移（clock.py 的约定），所以 `at[:10]` 就是本地日期，
    # 不需要任何时区换算 —— 换成 UTC 的话"今天"会从早上八点开始。
    for record in read_runs(path):
        if not record.at.startswith(day):
            continue
        runs += 1
        egress += record.egress_chars
        if record.cost_cny is None:
            unpriced += 1
        else:
            spent += record.cost_cny
    return _FileAgg(
        date=day,
        spent_cny=round(spent, 6),
        runs=runs,
        unpriced_runs=unpriced,
        egress_chars=egress,
    )
