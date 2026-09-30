"""AI 运行时状态（**纯内存**，`docs/11` §3.3 / §4.3）。

## 为什么凭据只存在内存里

真源在主进程：`safeStorage` 加密后落到 `userData/credentials.enc`。
sidecar 只在**进程存活期间**持有解密后的明文，用来发请求。这样：

- 磁盘上（`settings.json`、`.inkstone/`、日志）永远不出现明文 Key；
- sidecar 重启后凭据消失，由主进程在握手完成后**重推一次**（见 `main/ai-config.ts`）；
- 代价是"推送失败"会表现为运行期报错而不是启动期报错 —— 所以
  `AiCredentialMissing` 的文案指向"重新保存一次"，而不是"你还没填"。

## 为什么是"推全量"而不是"逐项增删"

provider 列表、凭据、纯本地开关、分模型是一份**必须一致**的快照：
分三次推会在中途产生"provider 有了但凭据没到"的窗口，表现为偶发的凭据缺失 ——
而它只在启动那几秒出现，最难复现。所以对外只有 `apply()` 一个入口，整体替换。
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field

from ..errors import AiNotConfigured
from ..logging import add_secrets


@dataclass(frozen=True, slots=True)
class ProviderConfig:
    """一个供应商的连接方式（**不含凭据**）。字段与 `ai-types.ts` 的 `ProviderConfig` 对齐。"""

    id: str
    kind: str
    label: str
    base_url: str
    local: bool
    needs_key: bool


@dataclass(frozen=True, slots=True)
class RouteTarget:
    provider_id: str
    model: str


@dataclass(frozen=True, slots=True)
class AppliedCounts:
    """`apply()` 实际生效的条目数。推送侧据此确认"推到了"，对不上就是契约漂移。"""

    providers: int
    credentials: int


@dataclass(slots=True)
class AiState:
    providers: dict[str, ProviderConfig] = field(default_factory=dict)
    credentials: dict[str, str] = field(default_factory=dict)
    routing: dict[str, RouteTarget | None] = field(default_factory=dict)
    default_provider_id: str | None = None
    default_model: str = ""
    """默认模型名（`default_provider_id` 那一家的）。`routing[task]` 为 None 时回落到它。"""
    style_card: str = ""
    """风格卡（`docs/01` §3.7.4）。v1 由用户手写，装配器拼进系统指令。"""
    daily_budget_cny: float = 0.0
    """单日成本上限（元）。0 = 不限。生成**之前**用它拦一次（`docs/11` §8.3）。"""
    offline_only: bool = False
    """纯本地模式（`docs/01` §9.3）。由网关**单点**拦截，见 `gateway.py`。"""
    acked_egress_providers: set[str] = field(default_factory=set)
    """已确认"可以把内容发往这家"的**非本机**供应商 id（`docs/11` §2.3）。

    真源在主进程的 `settings.json`（理由见 `ai-types.ts` 的 `AiSettings`）——
    这里只是一份**只读副本**，供预览端点算 `needsConfirm`。所以它每次 `apply()`
    都被整体替换，从不在这里增删。
    """
    revision: int = 0
    """配置版本号。每 `apply()` 一次加一，只进日志不进契约 ——
    排查"推送到底有没有到"时，有它就不用靠猜。"""

    def apply(
        self,
        *,
        providers: Iterable[ProviderConfig],
        credentials: Mapping[str, str],
        offline_only: bool,
        routing: Mapping[str, RouteTarget | None],
        default_provider_id: str | None,
        default_model: str,
        style_card: str,
        daily_budget_cny: float,
        acknowledged_egress_providers: Iterable[str] = (),
    ) -> AppliedCounts:
        """整体替换配置。

        先把所有东西算完再一次性赋值 —— 换到一半就赋值的话，并发读会看到
        "provider 有、凭据没有"的中间态。本函数里没有 await，所以替换过程本身是原子的；
        显式写成"先算后赋"是把这个前提**写在代码里**，免得将来有人插进一句 await。
        """
        next_providers = {provider.id: provider for provider in providers}
        # 只保留当前存在的供应商的凭据：删掉一个供应商之后，它的 Key 不该继续留在内存里。
        next_credentials = {
            provider_id: secret
            for provider_id, secret in credentials.items()
            if provider_id in next_providers and secret != ""
        }
        next_routing = {
            task: target
            for task, target in routing.items()
            # 指向已删除供应商的分模型项一并清掉，否则生成时才会报"未配置"
            if target is None or target.provider_id in next_providers
        }
        next_default = (
            default_provider_id if default_provider_id in next_providers else None
        )
        # 没有默认供应商时把模型名一起清掉：模型名是"某一家的模型"，
        # 留着一个无主的模型名只会让 `resolve_route()` 的分支更难读
        # （"供应商没了但模型还在"是一个没有意义的中间态）。
        next_default_model = default_model if next_default is not None else ""

        self.providers = next_providers
        self.credentials = next_credentials
        self.routing = next_routing
        self.default_provider_id = next_default
        self.default_model = next_default_model
        self.style_card = style_card
        self.daily_budget_cny = daily_budget_cny
        self.offline_only = offline_only
        # 同样按"当前存在的供应商"过滤：用户在设置里删掉一家之后，
        # 它的确认记录留着没有意义（重建同名 id 时还会**静默继承**旧确认，
        # 而那意味着一个新的、用户没看过的端点被当成"已确认"）。
        self.acked_egress_providers = {
            provider_id
            for provider_id in acknowledged_egress_providers
            if provider_id in next_providers
        }
        self.revision += 1

        # 把 Key 登记进按值擦除表（`logging.add_secrets`）：
        # 任何库把 Key 拼进异常消息时，日志里也只剩 ***。
        add_secrets(next_credentials.values())

        return AppliedCounts(providers=len(next_providers), credentials=len(next_credentials))

    def provider(self, provider_id: str) -> ProviderConfig:
        """取一个供应商，没有就抛 `AiNotConfigured`。

        文案刻意提到"保存一次"：走到这里最常见的原因是**主进程还没推上来**
        （刚启动、或推送失败），而不是用户没配过。
        """
        found = self.providers.get(provider_id)
        if found is None:
            raise AiNotConfigured(
                f"本地服务还没有供应商「{provider_id}」的配置。"
                "请在 AI 设置里保存一次后重试；若持续出现，请重启砚台。"
            )
        return found

    def credential(self, provider_id: str) -> str | None:
        return self.credentials.get(provider_id)

    def routing_for(self, task: str) -> RouteTarget | None:
        """某个任务**显式**配了哪个模型。没配返回 `None`（不代表不可用，见 `resolve_route`）。"""
        return self.routing.get(task)

    def resolve_route(self, task: str) -> RouteTarget:
        """某个任务**最终**用哪个模型（`docs/01` §4.3 的取值顺序）。

        `routing[task]` 优先；为 `None` 时回落到 `(default_provider_id, default_model)`。
        两者任一为空即视为未配置。

        为什么要分"显式配置"与"最终取值"两层：界面上"给某个任务单独挑一个模型"是**可选**的，
        大多数用户只会设一次默认模型。如果只有 `routing` 一条路，那些人每次生成都会被告知
        "没有可用模型"—— 而配置页上明明填好了。这一层回落就是为这个状态存在的
        （也是 `defaultModel` 这个字段非有不可的原因，见 `ai-types.ts` 的说明）。
        """
        target = self.routing_for(task)
        if target is not None:
            return target
        if self.default_provider_id is None or self.default_model == "":
            # 文案点出**是哪个任务**：其他任务可能配得好好的，只说"没有可用模型"
            # 会让人以为整块配置都丢了，方向完全跑偏。
            raise AiNotConfigured(
                f"「{task}」还没有可用的模型。请在 AI 设置里为它单独选一个，"
                "或指定一个默认供应商与默认模型。"
            )
        return RouteTarget(provider_id=self.default_provider_id, model=self.default_model)

    def provider_list(self) -> list[dict[str, object]]:
        """给 `/ai/providers` 的响应体。**不含凭据信息**（`ai-types.ts` 文件头有理由）。"""
        return [
            {
                "id": provider.id,
                "kind": provider.kind,
                "label": provider.label,
                "baseUrl": provider.base_url,
                "local": provider.local,
                "needsKey": provider.needs_key,
            }
            for provider in self.providers.values()
        ]

    def offline_blocks(self, provider: ProviderConfig) -> bool:
        """这条路由会不会被「纯本地模式」拦下。

        与网关切的那一刀是**同一个判据**（`offline_only and not provider.local`），
        放这里是为了让预览端点能提前告诉界面"别白弹一次卡"：
        用户确认完之后生成仍会被拒，那时才看到 `AI_OFFLINE_ONLY` —— 那是纯浪费。
        """
        return self.offline_only and not provider.local

    def egress_confirm_needed(self, provider: ProviderConfig) -> bool:
        """这次要不要弹「将发送什么」确认卡（`docs/11` §2.3）。

        三个条件都要在**同一处**判完，理由与 `resolve_route` 相同：
        分散到界面去判，一定会出现"预览说不用确认、生成却换了另一家"的错位。
        """
        if provider.local:
            # 本机模型不外传，不弹（列表里标「本机模型·不外传」）
            return False
        if self.offline_blocks(provider):
            # 反正发不出去。让真正的生成去报 AI_OFFLINE_ONLY，
            # 而不是让用户先确认一次、再被拒一次。
            return False
        return provider.id not in self.acked_egress_providers
