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
    # Codex（设定条目）不存在。单独一个码而不是复用 CHAPTER_NOT_FOUND：
    # 渲染层按码给文案，"章节不存在，请刷新章节列表"出现在设定面板里是灾难。
    "CODEX_NOT_FOUND": 404,
    # 卷纲不存在。与 CODEX_NOT_FOUND 同理：各自的 404 自己说话、自己给指引。
    # 章纲不存在**不是错误**（upsert 语义，GET 返回空壳），所以不涉及本码。
    "OUTLINE_NOT_FOUND": 404,
    "WRITE_FAILED": 500,
    "READ_FAILED": 500,
    # 正文不是 UTF-8。400 而不是 500：这是**用户能自己修**的（转存一次编码），
    # 不是服务端故障。
    "NOT_UTF8": 400,
    "INTERNAL": 500,
    # ---- AI（docs/11 §4.2）----
    "AI_NOT_CONFIGURED": 400,
    "AI_CREDENTIAL_MISSING": 400,
    # 401 但**码不同**：渲染进程按码判断，`UNAUTHORIZED` 会让它以为本地 token 失效、
    # 直接把整个界面推进 FAILED。这里的 401 描述的是**上游**拒绝，用户只需改 Key。
    "AI_AUTH_FAILED": 401,
    "AI_RATE_LIMITED": 429,
    "AI_UPSTREAM_ERROR": 502,
    "AI_TIMEOUT": 504,
    # 499 是 nginx 的非标准扩展码，语义正好是"客户端主动断开"。用在这里比 400 准：
    # 它不是错误，只是用户按了停止。
    "AI_ABORTED": 499,
    "AI_BUDGET_EXCEEDED": 429,
    "AI_OFFLINE_ONLY": 403,
    "AI_CONTEXT_TOO_LONG": 413,
    # 409 = 资源当前状态与请求冲突。同一章已有一个生成任务在跑，正是这个语义。
    # ⚠️ 这个码在 `docs/11` §4.2 的表里**没有**（写 P1 时补的，见 §7.3.1 的 D-6）：
    # 那张表只有"上游出错"与"配置不对"两类，而"两路生成同时改同一章"是
    # 本地并发问题。复用 INVALID_PARAM 会让用户看到"请求参数不合法" —— 参数没问题，
    # 他只需要等一等；复用 EXTERNAL_MODIFIED 更错（那会让界面弹出冲突解决框）。
    "AI_BUSY": 409,
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
        super().__init__(
            "WORK_NOT_FOUND",
            "作品不存在，或所在目录已被移动、删除。",
            detail={"workId": work_id},
        )


class ChapterNotFound(DomainError):
    def __init__(self, chapter_id: str) -> None:
        super().__init__(
            "CHAPTER_NOT_FOUND",
            "章节不存在，请刷新章节列表。",
            detail={"chapterId": chapter_id},
        )


class CodexNotFound(DomainError):
    """设定条目不存在（已被删除，或 slug 拼错）。

    ⚠️ 刻意不复用 ``CHAPTER_NOT_FOUND``：错误码会原样进渲染层的分支判断，
    "请刷新章节列表"这条指引对设定面板是**错误**的指引 —— 用户该做的是
    关掉这张卡回到清单。每个入口自己的 404 自己说话。
    """

    def __init__(self, entry_type: str, slug: str) -> None:
        super().__init__(
            "CODEX_NOT_FOUND",
            "这条设定不存在，可能已被删除。请回到设定清单刷新一下。",
            detail={"type": entry_type, "slug": slug},
        )


class OutlineNotFound(DomainError):
    """卷纲不存在（order 对不上 —— 已被删除或重排过）。"""

    def __init__(self, order: int) -> None:
        super().__init__(
            "OUTLINE_NOT_FOUND",
            "这一卷的大纲不存在，可能已被删除或移动。请回到大纲清单刷新一下。",
            detail={"order": order},
        )


class WorkExists(DomainError):
    def __init__(self, root_path: str) -> None:
        # 目标目录已存在且非空：绝不覆盖，也不静默合并。
        super().__init__(
            "WORK_EXISTS",
            "目标目录已存在且非空，请换一个目录名。",
            detail={"rootPath": root_path},
        )


class WriteFailed(DomainError):
    def __init__(self, reason: str) -> None:
        super().__init__(
            "WRITE_FAILED",
            "写入磁盘失败，请检查文件是否被其他程序占用。",
            detail={"reason": reason},
        )


class InvalidParam(DomainError):
    def __init__(self, message: str, *, detail: Any = None) -> None:
        super().__init__("INVALID_PARAM", message, detail=detail)


class NotUtf8(DomainError):
    """章节正文不是 UTF-8，**拒绝打开**而不是"尽力解码"。

    为什么必须报错：`bytes.decode("utf-8", errors="replace")` 会把解不出来的字节
    换成 U+FFFD，而渲染进程保存时按 UTF-8 回写 —— 原稿字节就此**不可逆地**被破坏。
    更隐蔽的是，`read_chapter` 返回的 `hash` 是**磁盘原始字节**的哈希，那份"替换后
    的文本"回存时算出的哈希对得上，于是冲突检测必然通过、"外部改动保护"形同虚设。

    两害相权：让这一章打不开（用户转个码就能继续），好过让它被静默改坏。
    """

    def __init__(self, path: str) -> None:
        super().__init__(
            "NOT_UTF8",
            "这个章节的文件不是 UTF-8 编码，无法安全编辑。"
            "请先用其他工具（如记事本「另存为 → UTF-8」）把它转存为 UTF-8。",
            detail={"path": path},
        )


# ---------------------------------------------------------------------------
# AI（docs/11 §4.2）
#
# 这些类存在的意义不只是"分类"：**文案本身就是交付物**。
# 模型侧的失败有一大半是用户能自己修的（没配 Key、Key 不对、地址填错、额度用完），
# 所以每条都说清"下一步做什么"，而不是把上游的英文原始报文丢给用户。
# ---------------------------------------------------------------------------


class AiNotConfigured(DomainError):
    """没有可用供应商 / 模型。"""

    def __init__(
        self, message: str = "还没有可用的 AI 模型，请先在设置里选一个供应商并填写密钥。"
    ) -> None:
        super().__init__("AI_NOT_CONFIGURED", message)


class AiCredentialMissing(DomainError):
    """本地服务内存里没有这个供应商的 Key。

    出现它通常意味着**推送失败**（而不是用户没填）—— 所以提示要指向"重开设置面板保存一次"，
    而不是"你还没填"。
    """

    def __init__(self, provider_id: str) -> None:
        super().__init__(
            "AI_CREDENTIAL_MISSING",
            "本地服务还没有拿到该供应商的密钥。请在 AI 设置里重新保存一次密钥。",
            detail={"providerId": provider_id},
        )


class AiAuthFailed(DomainError):
    """上游鉴权失败。`upstream_status` 是上游返回的状态码，进 detail 便于反馈。"""

    def __init__(self, provider_id: str, upstream_status: int | None = None) -> None:
        detail: dict[str, Any] = {"providerId": provider_id}
        if upstream_status is not None:
            detail["upstreamStatus"] = upstream_status
        super().__init__(
            "AI_AUTH_FAILED",
            "模型服务拒绝了这次请求：密钥无效、已过期，或没有该模型的权限。",
            detail=detail,
        )


class AiRateLimited(DomainError):
    def __init__(self, provider_id: str) -> None:
        super().__init__(
            "AI_RATE_LIMITED",
            "模型服务提示请求过于频繁或额度已用尽，请稍后再试，或在设置里换一个供应商。",
            detail={"providerId": provider_id},
        )


class AiUpstreamError(DomainError):
    """上游连不上 / 返回了不认识的结构 / 5xx。"""

    def __init__(self, provider_id: str, reason: str, upstream_status: int | None = None) -> None:
        detail: dict[str, Any] = {"providerId": provider_id, "reason": reason}
        if upstream_status is not None:
            detail["upstreamStatus"] = upstream_status
        super().__init__(
            "AI_UPSTREAM_ERROR",
            f"模型服务返回了异常结果：{reason}",
            detail=detail,
        )


class AiTimedOut(DomainError):
    def __init__(self, provider_id: str, seconds: float) -> None:
        super().__init__(
            "AI_TIMEOUT",
            f"等待模型响应超过 {seconds:.0f} 秒。请检查网络与供应商地址，或换一个模型。",
            detail={"providerId": provider_id},
        )


class AiOfflineOnly(DomainError):
    """已开启纯本地模式，云端供应商被网关拦下（docs/01 §9.3）。"""

    def __init__(self, provider_id: str) -> None:
        super().__init__(
            "AI_OFFLINE_ONLY",
            "已开启「纯本地模式」，不会向云端发送任何内容。请改用本机模型，或关闭该模式。",
            detail={"providerId": provider_id},
        )


class AiBudgetExceeded(DomainError):
    def __init__(self, spent: float, limit: float) -> None:
        super().__init__(
            "AI_BUDGET_EXCEEDED",
            f"今日 AI 用量已达上限（{spent:.2f} / {limit:.2f} 元）。请调整限额或改用更便宜的模型。",
            detail={"spentCny": spent, "limitCny": limit},
        )


class AiContextTooLong(DomainError):
    """上下文超长 —— 也涵盖**装配后无内容可发**这一种。

    「一个块都没剩下」在界面上要用户做的事与超长是同一件（调整输入再重试），
    为它单独加一个码要同时改 `errors.ts` / `docs/03` §1.2 / `docs/11` §4.2 三处，
    而收益只是文案更贴切。所以复用本码，但允许调用方传入**更具体的** `message`
    —— 「先写几句正文」与「缩短选区」是两条不同的指引，混用会让用户去改一个没问题的东西。
    """

    def __init__(self, provider_id: str = "", *, message: str | None = None) -> None:
        super().__init__(
            "AI_CONTEXT_TOO_LONG",
            message
            or "发送给模型的内容超出了它的上下文长度。请缩短选区，或换一个上下文更大的模型。",
            detail={"providerId": provider_id} if provider_id else None,
        )


class AiBusy(DomainError):
    """同一章已经有一个生成任务在跑。

    为什么**拒绝**而不是排队：排队意味着用户按了 Ctrl+Enter 之后要等前一次
    跑完（可能 60 秒）才开始，而界面上什么都不会发生 —— 那看起来就是"卡住了"。
    拒绝能让界面立刻说清"这一章正在生成中"。

    两路 AI 同时改同一章是**最坏的数据事故**（`docs/11` §8.3），所以宁可吵一点。
    """

    def __init__(self) -> None:
        super().__init__(
            "AI_BUSY",
            "这一章已经有一个生成任务在进行，请等它结束，或先点停止。",
        )


class AiAborted(DomainError):
    """用户主动停止。**不是错误** —— 界面上不报警，只结束这次生成。"""

    def __init__(self) -> None:
        super().__init__("AI_ABORTED", "已停止生成。")
