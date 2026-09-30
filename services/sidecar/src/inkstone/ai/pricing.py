"""模型价格的**量级估算**（``docs/11`` §3.6 的 ``costCny``）。

## 为什么需要它，而不是"拿不到价格就 null"

``dailyBudgetCny`` 是一道**钱**的护栏。若每次生成的成本都是 ``null``，
当日累计就永远是 0 —— 护栏变成一段永不触发的死代码，而它失效的方式是
"用户以为设了限额，其实没有任何东西被拦住"。所以认得的模型必须给出估算价。

**认不得的仍然给 ``None``**（不编）：编一个价格的后果是用户按一个错的数
去判断"这次要花多少"，比"不知道"更糟。用量接口会把无法估价的条数报出来
（``unpricedRuns``），让"预算判断可能偏低"这件事可见。

## 本机模型是 0 元，不是"未知"

``provider.local`` 为真时成本是 **0.0**：它不花钱（只花电）。这个区分很重要 ——
``None`` 会让预算护栏无法判断，而 Ollama 用户在开了纯本地模式之后，
本来就永远不该被预算拦住。

## 这张表会过时，这是已知且可接受的

价格随供应商调整，而且中转/自建各不相同。本表的用途只是"别把 6 分的请求
发成 6 块的"这个量级的判断。真源是用户可改的 ``ModelSpec.pricePerKIn/Out``
（``ai-types.ts``）—— P2 接上之后，这张表退化成它的默认值。
"""

from __future__ import annotations

from .state import ProviderConfig

#: 模型名子串 → （输入每千 token 价, 输出每千 token 价），单位**元**。
#: 按顺序取第一个命中，所以**具体模式必须排在泛化模式之前**。
_MODEL_PRICES: tuple[tuple[str, float, float], ...] = (
    ("deepseek-reasoner", 0.004, 0.016),
    ("deepseek", 0.002, 0.008),
    ("qwen3-max", 0.0024, 0.0096),
    ("qwen-max", 0.0024, 0.0096),
    ("qwen-plus", 0.0008, 0.002),
    ("qwen-turbo", 0.0003, 0.0006),
    ("qwen", 0.0008, 0.002),
    ("kimi", 0.012, 0.012),
    ("moonshot", 0.012, 0.012),
    ("glm-4", 0.001, 0.001),
    ("gpt-4o-mini", 0.0011, 0.0044),
    ("gpt-4o", 0.018, 0.072),
)


def price_per_k(model: str) -> tuple[float, float] | None:
    """按模型名找出（输入价, 输出价）。认不出返回 ``None``。"""
    lowered = model.lower()
    for key, price_in, price_out in _MODEL_PRICES:
        if key in lowered:
            return price_in, price_out
    return None


def estimate_cost(
    provider: ProviderConfig,
    model: str,
    *,
    prompt_tokens: int,
    completion_tokens: int,
) -> float | None:
    """估算一次生成花了多少钱（元）。``None`` = 认不出这个模型，不编数。"""
    if provider.local:
        return 0.0
    price = price_per_k(model)
    if price is None:
        return None
    price_in, price_out = price
    return round(prompt_tokens / 1000 * price_in + completion_tokens / 1000 * price_out, 6)
