"""请求体模型。

字段名直接用 camelCase，与 ``packages/shared/src/api-types.ts`` 的契约一致，
少一层 alias 映射就少一个对不上的地方。
``extra="forbid"``：前端多传了字段说明契约漂移了，宁可 400 也不要静默忽略。
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from ...domain.codex import CodexEntry


class _Request(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CreateWorkRequest(_Request):
    parentDir: str = Field(min_length=1)
    title: str = Field(min_length=1)
    author: str = ""
    genre: str = ""
    wordGoal: int = Field(default=0, ge=0)


class OpenWorkRequest(_Request):
    rootPath: str = Field(min_length=1)


class CreateChapterRequest(_Request):
    title: str = Field(min_length=1)
    afterChapterId: str | None = None


class UpdateChapterRequest(_Request):
    markdown: str
    baseHash: str
    # 冲突后"保留我的并覆盖"时置 true：服务端会先把磁盘版本备份到
    # .inkstone/backups/ 再写。默认 False，普通保存不产生备份文件。
    backup: bool = False


# ---------------------------------------------------------------------------
# Codex（设定条目，docs/15 B1 / D-1 / D-2）
# ---------------------------------------------------------------------------


class CreateCodexRequest(CodexEntry):
    """新建条目。

    直接继承领域模型 ``CodexEntry``：字段与校验只有一份（别名剥空白、
    relation.to 的文件名安全 charset 都在领域层），API 层不复制一份校验 ——
    两份校验必然漂移。差别只在 ``extra="forbid"``：**API 路径**上多传字段
    说明契约漂移了，宁可 400；而 frontmatter 手写路径要求向前兼容（领域
    模型刻意忽略未知键），两处策略不同是刻意的。
    """

    model_config = ConfigDict(extra="forbid")


class UpdateCodexRequest(CreateCodexRequest):
    """全量替换（PUT）。

    ``ifMatch`` 必填且不给默认值：漏传会退化成"与空串比对"—— 永远 409，
    静默失效方向是"用户永远保存不了"；但更早、更响亮地 400 能让契约
    漂移当天就被发现。
    """

    ifMatch: str = Field(min_length=1)


# ---------------------------------------------------------------------------
# 大纲三层（docs/15 B2 / D-3 / D-5）
# ---------------------------------------------------------------------------


class UpdateGeneralOutlineRequest(_Request):
    """总纲是纯正文（无 frontmatter），所以只有 body + 预条件。

    ⚠️ ``ifMatch`` 允许**空串**：总纲是 upsert 语义，"磁盘上还没有总纲"的
    创建标记就是空串（GET 空壳返回的 hash）。与卷纲不同 —— 卷纲有独立
    POST，PUT 永不创建，空串在那里是契约漂移，要 400。
    """

    body: str
    ifMatch: str


class CreateVolumeRequest(_Request):
    title: str = Field(min_length=1, max_length=200)
    #: 卷目标/节点等自由正文。允许空串：先建卷占位、之后再填是正常流程。
    body: str = ""


class UpdateVolumeRequest(_Request):
    title: str = Field(min_length=1, max_length=200)
    body: str
    #: 目标卷序号。缺省 = 不动顺序（只改标题/正文）。移到已占用的序号会 400，
    #: 交换顺序走 reorder 端点。
    order: int | None = Field(default=None, ge=1)
    ifMatch: str = Field(min_length=1)


class ReorderVolumeRequest(_Request):
    direction: Literal["up", "down"]


class ForeshadowIn(_Request):
    """伏笔登记的入参。``id`` 允许空串：新增项由服务端补齐（D-5）——
    让客户端生成 id 等于让"同一张章纲在两个窗口里编辑"各造各的 id。"""

    id: str = Field(default="", max_length=64)
    title: str = Field(min_length=1, max_length=200)
    expectResolveBy: int | None = Field(default=None, ge=1)
    status: Literal["open", "resolved", "dropped"] = "open"
    resolvedIn: str | None = Field(default=None, max_length=64)


class UpdateChapterOutlineRequest(_Request):
    """章纲 PUT。``foreshadow`` 缺省 = **保留原值**（客户端只改正文时不必回声
    整个伏笔数组）；显式传 [] 才是清空 —— PUT 语义里开这一个口子是刻意的
    宽容，强一致的全量替换在这里反而让"手滑清空伏笔"变得太容易。

    ``ifMatch`` 允许空串，理由同 ``UpdateGeneralOutlineRequest``（upsert）。
    """

    body: str
    foreshadow: list[ForeshadowIn] | None = None
    ifMatch: str


# ---------------------------------------------------------------------------
# AI（docs/11 §4.1 / §4.2）
#
# 只做**形状**校验，不做语义校验：`id` 是不是合法供应商 id、`baseUrl` 是不是
# http(s)、`offlineOnly` 与 `local` 是否自相矛盾 —— 这些都由主进程在 settings.json
# 的读/写两条路径上收敛（`settings-io.ts` 的 `parseAiSettings`）。
#
# 为什么不在这里也做一遍：两处校验必然漂移，而"哪一处说了算"会变成一个没人记得的问题。
# 主进程是配置的真源（`ai-types.ts` 文件头），所以**校验只有一处**，这里只管
# "字段齐不齐、类型对不对"——那是契约漂移（前端改了字段名）才会触发的事。
# ---------------------------------------------------------------------------


class ProviderConfigIn(_Request):
    """一个供应商的连接方式。字段与 `ai-types.ts` 的 `ProviderConfig` **一一对应且全部必填**。

    同样不给默认值：`local` / `needsKey` 决定"受不受纯本地模式限制"与"要不要带 Key"，
    漏传它们会让闸门按错误的假设开关（详见 `AiConfigRequestIn` 的说明）。
    """

    id: str = Field(min_length=1, max_length=64)
    kind: str = Field(min_length=1)
    label: str
    baseUrl: str = Field(min_length=1)
    local: bool
    needsKey: bool


class AiRouteTargetIn(_Request):
    providerId: str = Field(min_length=1)
    model: str = Field(min_length=1)


class AiConfigRequestIn(_Request):
    """主进程推来的全量配置快照。

    ⚠️ **八个字段全部必填，刻意不给默认值。**

    给了默认值的诱惑很大（少一次契约协商），但 `offlineOnly` 是**隐私开关**：
    推送方若因为某个 bug 漏传它，Pydantic 会填上 `False` —— 于是"一次不完整的推送"
    表现为"纯本地模式被悄悄关掉，内容开始往外发"。这是 fail-open，方向反了。

    必填之后同样的 bug 变成一次 400：`apply()` 根本不会被调用，
    sidecar 保留上一份配置（其中 `offline_only` 仍是 `True`）—— 失败但不出门。

    P1 又补了三个（`defaultModel` / `styleCard` / `dailyBudgetCny`，见 `docs/11` §7.3.1 的 D-5）。
    它们不是隐私开关，但同样**不给默认值**：理由是这三条一旦漏推，症状分别是
    "生成报未配置"、"风格卡不生效"、"预算永不拦截" —— 三个都是**静默失效**，
    而不给默认值能让它们在推送那一刻就变成一次响亮的 400。
    """

    providers: list[ProviderConfigIn]
    #: providerId → 明文 Key（没有 Key 的供应商不出现在这里，值可以为空串由 state 过滤）。
    #: **只允许出现在这条回环请求上**：不进日志、不落盘、不回显。
    credentials: dict[str, str]
    offlineOnly: bool
    #: 任务名 → 目标模型。**刻意不校验任务名**：
    #: 未知任务名是无害的（网关按任务取值，取不到就报 AI_NOT_CONFIGURED），
    #: 而若在这里拒绝未知键，将来前端改一个任务名就会让整份配置推送失败 ——
    #: 失败方式是"凭据永远到不了"（每个请求都报凭据缺失），比漏配一个任务严重得多。
    routing: dict[str, AiRouteTargetIn | None]
    #: 可以为 null（用户还没选默认供应商），但**不能缺字段**（理由同上）。
    defaultProviderId: str | None
    #: 可以为空串（用户还没选默认模型），但**不能缺字段**。
    defaultModel: str
    #: 风格卡，可以为空串。
    styleCard: str
    #: 单日成本上限（元），0 = 不限。`ge=0` 只拦负数 —— 它是个金额，负值没有语义。
    dailyBudgetCny: float = Field(ge=0)
    #: 已确认"可以把内容发往这家"的非本机供应商 id（`docs/11` §2.3）。
    #: 预览端点用它算 `needsConfirm`；同样**不给默认值**（漏推会退化成空数组，
    #: 症状是"已确认过的供应商又开始弹卡"—— 多弹一次是 fail-closed，
    #: 但仍属契约漂移，宁可让它响亮地 400）。
    acknowledgedEgressProviders: list[str]


class AiTestRequestIn(_Request):
    providerId: str = Field(min_length=1)
    model: str = Field(min_length=1)


# ---------------------------------------------------------------------------
# 生成（docs/11 §4.1 的 AiGenRequest）
# ---------------------------------------------------------------------------


class AiGenRequestIn(_Request):
    """`POST /ai/continue` 与 `/ai/quick` 的请求体。

    与 `ai-types.ts` 的 `AiGenRequest` 一一对应。可选字段在这里**有默认值**
    （与 `AiConfigRequestIn` 的"全部必填"相反），因为两者的失效方向不同：
    配置漏推会让隐私闸门按错误假设开关（fail-open）；而这里漏传 `intent`
    只是"这次没有附加要求"，用户看得见结果，也不会有什么东西被悄悄打开。
    """

    workId: str = Field(min_length=1)
    chapterId: str = Field(min_length=1)
    #: 光标前文。**允许为空串**：新建的章还没有正文，而那时正确的回答是
    #: `AI_CONTEXT_TOO_LONG` 那句"先写几句"，不是"参数不合法"。
    prefix: str
    suffix: str = ""
    intent: str = ""
    styleCard: str | None = None
    temperature: float | None = Field(default=None, ge=0, le=2)
    maxTokens: int | None = Field(default=None, ge=1, le=32_768)
    #: 忽略单日预算拦截（用户看过告警后点了"继续"）。见 `AiGenRequest.force`。
    force: bool = False


class AiQuickRequestIn(AiGenRequestIn):
    """快捷生成。**一个端点 + `kind`**，不是七个端点（`docs/11` §4.3）。

    不在这里校验 `kind` 的取值：不认识的值会在装配时渲染出一条空指令（有日志），
    而在这里拒绝会让"渲染进程加了一种 kind、sidecar 还没更新"变成一个
    用户看得见的报错 —— 加一种快捷生成本来不该是一次跨包契约升级。
    """

    kind: str = Field(min_length=1)


class AiExpandRequestIn(_Request):
    """`POST /ai/expand` 的请求体 —— 「AI 扩充设定」（`docs/16` D-1）。

    **刻意不继承 `AiGenRequestIn`**：expand 不绑章节，没有 prefix/suffix，
    它的输入是"目标条目 + 产物目标"，语义与续写/快捷完全不同。继承会让
    `chapterId` / `prefix` 变成必填，而 expand 根本用不到它们 ——
    强迫渲染进程去编一个假 chapterId 正是契约漂移的开始。

    ``type`` 用 `Literal`（`domain/codex.py` 的 `CODEX_TYPES`）：这里不是
    "加一种快捷生成不该改代码"的宽松场景，type 决定磁盘目录，拼错就该响亮地 400，
    而不是落到装配时读一个不存在的目录。``target`` 只有两态，同样用 Literal。
    """

    workId: str = Field(min_length=1)
    type: Literal["character", "location", "faction", "item", "concept"]
    slug: str = Field(min_length=1, max_length=200)
    target: Literal["summary", "body"]
    intent: str = ""
    temperature: float | None = Field(default=None, ge=0, le=2)
    maxTokens: int | None = Field(default=None, ge=1, le=32_768)
    force: bool = False


class AiPreviewRequestIn(AiGenRequestIn):
    """`POST /ai/preview` 的请求体 —— 「**将发送什么**」（`docs/11` §6.4 / §6.7）。

    **刻意继承 `AiGenRequestIn` 而不是另造一份精简请求**：预览要回答的是
    "这一次真的要发什么"，所以它必须走同一条路由解析与同一份装配。
    另造一套的后果是"预览里显示的模型/上下文与实际用的不是同一个"——
    而用户正是**据此**决定要不要让它出门，那比不给预览更糟。

    `kind` 与 `AiQuickRequestIn` 不同，**允许为空串**（= 续写）：
    这里只是一个"按哪种模板装"的开关，认不出时 `_render_user` 会渲染出空指令
    并留一条日志 —— 预览的用途是"看一眼"，不该因为 kind 拼错就整个端点 400。

    `type` / `slug` / `target` 是 expand 预览的**可选**字段（`docs/16` §2.2）：
    三者都非空时按 expand 装配，否则走续写/快捷。它们与 `AiGenRequestIn` 的
    `chapterId` / `prefix` 并存（那些字段 expand 用不到、保持默认即可）——
    预览端点用同一个请求体覆盖三种 task，比拆三个端点少一处漂移。

    `chapterId` 在这里**允许空串**（override 掉父类 `min_length=1`）：expand 的
    预览没有章节，传空串是正常态而非参数错误。续写/快捷的预览仍会传真实
    chapterId，不受影响 —— 预览的"一次要看什么"由 `target` / `kind` 分流，
    chapterId 只是续写那条装配要用的输入。

    `prefix` 同样 override 出默认空串（父类是必填）：expand 预览没有"光标前文"，
    不给它是正常态。续写预览传了真实 prefix 不受影响。
    """

    chapterId: str = ""
    prefix: str = ""
    kind: str = ""
    type: str = ""
    slug: str = ""
    target: str = ""


class AiRunFeedbackIn(_Request):
    """回填采纳结果。

    `accepted` 用 `Literal` 而不是 `str`：它只有三态，多一个拼错的取值
    会让统计口径静默漂移（`accepted='Full'` 在按字符串分组的报表里是第四类）。
    """

    #: 运行记录按作品存，所以必须说明是哪个作品。
    workId: str = Field(min_length=1)
    accepted: Literal["full", "partial", "none"]
    acceptedChars: int = Field(ge=0)
