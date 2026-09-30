"""把 `WorkRegistry` 适配成装配器要的只读视图（`ai/context.py` 的 `Workspace` 协议）。

## 为什么单开一个文件，而不是塞进 `context.py`

`context.py` 是**纯装配逻辑**：它不需要知道仓储、锁、任何磁盘布局。
正因如此，测试里可以用一个假的 `Workspace` 把"哪些块、丢哪个、渲染成什么"
穷举干净。适配器塞进去就会让那个文件 import 存储层 —— 纯逻辑被拖进一条依赖链，
而它自己一点没变。

## 为什么 `paths()` 是同步的

仓储的 `_get()` 本来就同步（查一个内存字典），把它包成 async 只会给调用方
多加一层 `await` 而没有任何并发收益。`chapter_ids()` / `read_chapter()` 要走磁盘，
保持 async。
"""

from __future__ import annotations

from typing import Any

from ..domain.paths import WorkPaths
from ..storage.codex_store import CodexStore
from ..storage.outline_store import OutlineStore
from ..storage.repo import WorkRegistry

#: 章节正文在 `read_chapter()` 返回的字典里的键名。抽成常量是为了让"契约变了"
#: 变成一处编译期/改名期就能发现的事，而不是运行期读到空串。
_MARKDOWN_KEY = "markdown"


class RegistryWorkspace:
    """`WorkRegistry` → `Workspace` 的最小适配。

    刻意**只读**：装配器不该有写正文的能力。给它一个写方法等于给"AI 顺手改一下前文"
    留了一条路，而那种改动既没有冲突检测也没有备份。

    codex / outline 的读取借 `CodexStore` / `OutlineStore` 的**只读**方法
    （`read_entry` / `list_entries` / `read_general` 都不加锁、直接 `to_thread`）。
    这里各持一份实例而不是从 app.state 传进来：装配器要的是"最小只读视图"，
    不该为了三个读方法把整个 store 图搬进构造函数签名（`docs/16` D-2 的"形状定死"，
    上层 `Assembler` 的构造处一个参数都不加）。store 是 registry 的无状态包装，
    各持一份只读实例没有并发问题（它们的写锁字典在这里从不被触碰）。
    """

    def __init__(self, registry: WorkRegistry) -> None:
        self._registry = registry
        self._codex = CodexStore(registry)
        self._outline = OutlineStore(registry)

    def paths(self, work_id: str) -> WorkPaths:
        # 作品不存在时仓储抛 WorkNotFound（DomainError），经由统一错误处理器变成 404
        # —— 正是"这个作品已经被移走了"应有的回答。
        return self._registry.work_paths(work_id)

    async def chapter_ids(self, work_id: str) -> list[str]:
        """**按正文顺序**（`order` 升序）返回章节 id。

        顺序是 `_read_adjacent()` 的全部依据 —— 它靠"上一章 / 下一章"定位，
        拿到的若是一个按 id 或文件名排序的列表，读出来的就是随机的两章。
        """
        records = await self._registry.list_chapters(work_id)
        return [str(record["id"]) for record in records]

    async def read_chapter(self, work_id: str, chapter_id: str) -> str:
        """读一章的 Markdown 正文。"""
        payload = await self._registry.read_chapter(work_id, chapter_id)
        value = payload.get(_MARKDOWN_KEY, "")
        return value if isinstance(value, str) else ""

    # ------------------------------------------------------------------
    # expand 专用（docs/16 D-5）
    # ------------------------------------------------------------------

    async def read_codex_entry(self, work_id: str, entry_type: str, slug: str) -> dict[str, Any]:
        """读一条 codex 条目的**全量**（含 body/fields/relations）。条目不存在抛
        `CodexNotFound`（404）—— 扩充设定必须有目标，条目被删了就该响亮地报错，
        而不是静默装配一份空上下文（那会让 AI 瞎编一个从没见过的角色）。"""
        return await self._codex.read_entry(work_id, entry_type, slug)

    async def codex_relation_summaries(self, work_id: str, entry: dict[str, Any]) -> list[str]:
        """把 `entry["relations"]` 翻译成"一行一个关联条目 summary"。

        relation 只存对方的 slug（`domain/codex.py`），**不存 type**——而 slug 跨
        type 可能重名。这里沿用 M4-P0 断链检测（`codex_store._broken_sync`）的既有
        口径：slug 作**全局**引用键，`list_entries` 建 `slug → summary` 映射，
        重名时取先扫到的那一个。装配层只读、不判断链：指向已删条目时该 relation
        自然映射不到，静默跳过（一条断链不该让"扩充设定"整个失败）。
        """
        relations = entry.get("relations") or []
        if not relations:
            return []
        wanted = {str(relation.get("to", "")).strip() for relation in relations}
        wanted.discard("")

        items = await self._codex.list_entries(work_id)
        by_slug: dict[str, str] = {}
        for item in items:
            slug = str(item.get("slug", ""))
            summary = str(item.get("summary", "")).strip()
            # 重复 slug 取先扫到的（与断链检测的全局并集口径一致）。
            if slug and slug not in by_slug and summary:
                by_slug[slug] = summary

        return [by_slug[slug] for slug in wanted if slug in by_slug]

    async def read_general_outline(self, work_id: str) -> str:
        """读 `outline/总纲.md` 的正文。不存在返回空串（总纲是 upsert 语义，空是常态）。"""
        result = await self._outline.read_general(work_id)
        body = result.get("body", "")
        return body if isinstance(body, str) else ""
