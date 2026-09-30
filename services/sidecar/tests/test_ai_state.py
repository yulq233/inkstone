"""AI 运行时状态的纯单测（``ai/state.py``）。

为什么单独一份：``test_ai_api.py`` 走 HTTP，只能看到"端点怎么答"；
而 ``resolve_route()`` 的取值顺序（``routing[task]`` 优先、回落默认供应商+默认模型）
是**每次生成的入口判断**，分支比端点能表达的更多，直接测状态更省事也更准。

这批用例对应 ``docs/11`` §7.3.1 的 D-5：P1 补上的 ``defaultModel`` 只有在
``routing`` 为空时才生效，而"配好了供应商、还没给任何任务分模型"正是最常见的那个状态 ——
不把它测出来，D-5 就只是加了个字段而已。
"""

from __future__ import annotations

import pytest

from inkstone.ai.state import AiState, ProviderConfig, RouteTarget
from inkstone.errors import AiNotConfigured

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


def _apply(
    state: AiState,
    *,
    providers: list[ProviderConfig] | None = None,
    routing: dict[str, RouteTarget | None] | None = None,
    default_provider_id: str | None = None,
    default_model: str = "",
    style_card: str = "",
    daily_budget_cny: float = 0.0,
    offline_only: bool = False,
) -> None:
    state.apply(
        providers=[CLOUD, LOCAL] if providers is None else providers,
        credentials={},
        offline_only=offline_only,
        routing={} if routing is None else routing,
        default_provider_id=default_provider_id,
        default_model=default_model,
        style_card=style_card,
        daily_budget_cny=daily_budget_cny,
    )


# ---------------------------------------------------------------------------
# resolve_route：routing 优先、回落默认
# ---------------------------------------------------------------------------


def test_explicit_routing_wins_over_default_pair() -> None:
    state = AiState()
    _apply(
        state,
        routing={"continue": RouteTarget(provider_id="ollama", model="qwen3:8b")},
        default_provider_id="deepseek",
        default_model="deepseek-chat",
    )

    assert state.resolve_route("continue") == RouteTarget(provider_id="ollama", model="qwen3:8b")


def test_falls_back_to_default_pair_when_task_has_no_model() -> None:
    """这条就是 D-5 补 `defaultModel` 的理由：只设了默认的那一次，也必须能用。"""
    state = AiState()
    _apply(state, default_provider_id="deepseek", default_model="deepseek-chat")

    assert state.resolve_route("continue") == RouteTarget(
        provider_id="deepseek", model="deepseek-chat"
    )
    # 任何一个任务槽位都该回落到同一对
    assert state.resolve_route("rewrite").provider_id == "deepseek"


def test_explicit_null_falls_back_too() -> None:
    """`routing[task] = None` 的语义是"这个任务没单独挑"，不是"不可用"。"""
    state = AiState()
    _apply(
        state,
        routing={"continue": None},
        default_provider_id="deepseek",
        default_model="deepseek-chat",
    )

    assert state.resolve_route("continue").model == "deepseek-chat"


@pytest.mark.parametrize(
    ("provider", "model"),
    [
        (None, "deepseek-chat"),  # 有模型名，但没有默认供应商
        ("deepseek", ""),  # 有供应商，但没有模型名
        (None, ""),  # 两个都没有
    ],
)
def test_not_configured_mentions_the_task_name(provider: str | None, model: str) -> None:
    """文案必须点出**是哪个任务**：其他任务可能配得好好的，
    只说"没有可用模型"会让人以为整块配置都丢了。"""
    state = AiState()
    _apply(state, default_provider_id=provider, default_model=model)

    with pytest.raises(AiNotConfigured) as excinfo:
        state.resolve_route("continue")

    assert "continue" in excinfo.value.message
    assert excinfo.value.code == "AI_NOT_CONFIGURED"


# ---------------------------------------------------------------------------
# apply：整体替换的一致性
# ---------------------------------------------------------------------------


def test_default_model_is_cleared_when_its_provider_disappears() -> None:
    """"有模型名但没有供应商"是一个没有意义的中间态，替换配置时顺手清掉。"""
    state = AiState()
    _apply(state, default_provider_id="deepseek", default_model="deepseek-chat")
    assert state.default_model == "deepseek-chat"

    _apply(
        state,
        providers=[LOCAL],  # deepseek 被删了
        default_provider_id="deepseek",
        default_model="deepseek-chat",
    )

    assert state.default_provider_id is None
    assert state.default_model == ""


def test_default_model_survives_when_its_provider_stays() -> None:
    state = AiState()
    _apply(state, default_provider_id="deepseek", default_model="deepseek-chat")

    assert state.default_provider_id == "deepseek"
    assert state.default_model == "deepseek-chat"


def test_style_card_and_budget_are_stored() -> None:
    state = AiState()
    _apply(state, style_card="短句为主，少用形容词。", daily_budget_cny=3.5)

    assert state.style_card == "短句为主，少用形容词。"
    assert state.daily_budget_cny == 3.5


def test_routing_entries_pointing_at_deleted_provider_are_dropped() -> None:
    state = AiState()
    _apply(state, routing={"continue": RouteTarget(provider_id="deepseek", model="deepseek-chat")})
    assert state.routing_for("continue") is not None

    _apply(state, providers=[LOCAL])

    assert state.routing_for("continue") is None


def test_revision_increases_on_every_apply() -> None:
    """推送到底有没有到，靠这个数字判断（只进日志不进契约）。"""
    state = AiState()
    assert state.revision == 0
    _apply(state)
    _apply(state)
    assert state.revision == 2
