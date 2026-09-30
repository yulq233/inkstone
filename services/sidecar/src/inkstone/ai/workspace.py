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

from ..domain.paths import WorkPaths
from ..storage.repo import WorkRegistry

#: 章节正文在 `read_chapter()` 返回的字典里的键名。抽成常量是为了让"契约变了"
#: 变成一处编译期/改名期就能发现的事，而不是运行期读到空串。
_MARKDOWN_KEY = "markdown"


class RegistryWorkspace:
    """`WorkRegistry` → `Workspace` 的最小适配。

    刻意**只读**：装配器不该有写正文的能力。给它一个写方法等于给"AI 顺手改一下前文"
    留了一条路，而那种改动既没有冲突检测也没有备份。
    """

    def __init__(self, registry: WorkRegistry) -> None:
        self._registry = registry

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
