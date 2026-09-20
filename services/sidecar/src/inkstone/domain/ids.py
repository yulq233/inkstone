"""标识符生成。

格式（03 文档 §1.1）：work ``w_`` + uuid4 hex 前 12 位；chapter ``ch_`` + 同。

**为什么 chapter 需要独立的 id，而不复用目录名**：目录名里的 ``001-`` 会因为
重排而变，而 id 不会。批注锚点、快照引用、AI 生成记录全部引用 id，
所以重排章节不会让任何引用失效。这是"目录名承载人可读排序、id 承载机器引用稳定性"。
"""

from __future__ import annotations

import uuid


def _short() -> str:
    return uuid.uuid4().hex[:12]


def new_work_id() -> str:
    return f"w_{_short()}"


def new_chapter_id() -> str:
    return f"ch_{_short()}"
