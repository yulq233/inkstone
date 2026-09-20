"""领域错误 → HTTP 统一错误信封。

错误码全集必须与 ``packages/shared/src/errors.ts`` 一一对应（03 文档 §1.2）。

为什么单独做一个异常类型而不是到处 ``raise HTTPException``：
路由层只需要表达"发生了什么"，由一处统一决定它对应哪个状态码和什么文案。
这样错误码与状态码的对应关系只有一个定义处，不会在十几个 handler 里漂移。
"""

from __future__ import annotations

from typing import Any

# 错误码 → HTTP 状态码。与 shared/errors.ts 的 ErrorCode 同步维护。
_CODE_STATUS: dict[str, int] = {
    "INVALID_PARAM": 400,
    "UNAUTHORIZED": 401,
    "WORK_NOT_FOUND": 404,
    "CHAPTER_NOT_FOUND": 404,
    "WORK_EXISTS": 409,
    "EXTERNAL_MODIFIED": 409,
    "WRITE_FAILED": 500,
    "READ_FAILED": 500,
    "INTERNAL": 500,
}


class DomainError(Exception):
    """可直接翻译成统一错误信封的业务异常。"""

    __slots__ = ("code", "message", "detail", "status_code")

    def __init__(
        self,
        code: str,
        message: str,
        *,
        detail: Any = None,
        status_code: int | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.detail = detail
        self.status_code = status_code if status_code is not None else _CODE_STATUS.get(code, 500)


class WorkNotFound(DomainError):
    def __init__(self, work_id: str) -> None:
        super().__init__("WORK_NOT_FOUND", "作品不存在，或所在目录已被移动、删除。", detail={"workId": work_id})


class ChapterNotFound(DomainError):
    def __init__(self, chapter_id: str) -> None:
        super().__init__("CHAPTER_NOT_FOUND", "章节不存在，请刷新章节列表。", detail={"chapterId": chapter_id})


class WorkExists(DomainError):
    def __init__(self, root_path: str) -> None:
        # 目标目录已存在且非空：绝不覆盖，也不静默合并。
        super().__init__("WORK_EXISTS", "目标目录已存在且非空，请换一个目录名。", detail={"rootPath": root_path})


class WriteFailed(DomainError):
    def __init__(self, reason: str) -> None:
        super().__init__("WRITE_FAILED", "写入磁盘失败，请检查文件是否被其他程序占用。", detail={"reason": reason})


class InvalidParam(DomainError):
    def __init__(self, message: str, *, detail: Any = None) -> None:
        super().__init__("INVALID_PARAM", message, detail=detail)
