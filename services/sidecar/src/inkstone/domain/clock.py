"""时间戳。

统一 ISO 8601 **带本地时区偏移**（``2026-09-18T16:49:19+08:00``），不用 UTC ``Z``。
理由：这是给人看的作品元数据，用户在资源管理器里对比"最后修改时间"时，
本地时间才不用心算。跨时区协作不在 M0 范围（v1 单机）。
"""

from __future__ import annotations

from datetime import datetime


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def iso_from_timestamp(ts: float) -> str:
    """把文件的 mtime 转成 ISO 8601。

    ``savedAt`` 用文件 mtime 而不是 meta.json 里的 updatedAt：mtime 反映的是
    **磁盘真实状态**，包括用户在 VS Code 里的外部改动。用副本字段会出现
    "界面上说 10:00 保存，磁盘上其实是 10:05 被人改过"这种误导。
    """
    return datetime.fromtimestamp(ts).astimezone().isoformat(timespec="seconds")


def compact_stamp() -> str:
    """``20260920-101530`` —— 可用作文件名的本地时间戳。

    不能用 ``now_iso()``：里面的 ``:`` 在 Windows 文件名里非法，
    而备份文件名必须一眼能看出时间顺序（按名字排序即按时间排序）。
    也用本地时间而不是 UTC —— 用户去 ``.inkstone/backups/`` 里翻备份时，
    看到的时间要能和"我下午三点改过"对上。
    """
    return datetime.now().strftime("%Y%m%d-%H%M%S")
