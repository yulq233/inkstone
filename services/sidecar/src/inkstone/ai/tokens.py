"""token 估算与按预算截断（``docs/11`` §8.2）。

## 为什么不引入 tokenizer

``tiktoken`` / ``transformers`` 都要**下载词表**，而 sidecar 的第一条前提是"本地可用"：
一个"第一次生成时去下 100MB 词表"的依赖会直接毁掉它。而这里要的精度不是
"账单准到 1 个 token"，而是"别把 6 千的请求发成 6 万"。

## 口径（刻意偏高）

中文按**字符**、英文按**词**、标点按 1 个算。真实分词里一个汉字常常不到 1 token
（主流国产模型落在 0.6~0.7），所以这个口径是**偏高**的。

方向是刻意选的：

- 估高 → 装配器早一点丢块、预算早一点拦，代价只是浪费一点上下文；
- 估低 → 请求超长被上游拒（``AI_CONTEXT_TOO_LONG``），而用户只能自己猜哪里长了。

## 为什么估算与截断必须共用一套走法

``estimate_tokens`` 与 ``truncate_tail`` 都建立在 ``_costs()`` 上。
两处各写一套"怎么数"的话，会出现**截断之后反而超预算**这种自相矛盾的结果 ——
而且它只在预算刚好卡在边界时才出现，最难查。
"""

from __future__ import annotations

from collections.abc import Iterator

#: 汉字所在的码位区间。扩展 A/B 也包含进去：用户会在人名与生僻字里用到它们。
_CJK_RANGES: tuple[tuple[int, int], ...] = (
    (0x3400, 0x4DBF),  # 扩展 A
    (0x4E00, 0x9FFF),  # 基本区
    (0xF900, 0xFAFF),  # 兼容表意
    (0x20000, 0x2FA1F),  # 扩展 B 及以后
)


def _is_cjk(ch: str) -> bool:
    code = ord(ch)
    return any(low <= code <= high for low, high in _CJK_RANGES)


def _costs(text: str) -> Iterator[int]:
    """逐字符成本。连续字母数字算**一个**词（"英文按词"），其余各算 1。

    空白算 0：它不单独占 token，只是词与词之间的分隔。
    """
    in_word = False
    for ch in text:
        if ch.isspace():
            in_word = False
            yield 0
        elif _is_cjk(ch):
            in_word = False
            yield 1
        elif ch.isalnum():
            yield 0 if in_word else 1
            in_word = True
        else:
            in_word = False
            yield 1


def estimate_tokens(text: str) -> int:
    """估一段文本占多少 token。空文本是 0（不是 1）。"""
    return sum(_costs(text))


def truncate_tail(text: str, max_tokens: int) -> str:
    """截成"最多 max_tokens 的**尾部**"。

    续写要的是**最近**写的那一段，所以超预算时从**前面**砍 —— 这与直觉相反，
    值得写下来：砍头保留结尾，模型才接得上；砍尾保留开头，它接的是半天前的情节。
    """
    return _truncate(text, max_tokens, keep_tail=True)


def truncate_head(text: str, max_tokens: int) -> str:
    """截成"最多 max_tokens 的**头部**"。用于参考资料类文本（设定、邻近章的开头）。"""
    return _truncate(text, max_tokens, keep_tail=False)


def _truncate(text: str, max_tokens: int, *, keep_tail: bool) -> str:
    if text == "":
        return ""
    costs = list(_costs(text))
    # 先判"根本不用截"：这一步放在 max_tokens <= 0 之前，因为纯空白文本的估算值是 0，
    # 限额 0 时它其实装得下 —— 早退成空串会让"装得下就原样返回"这条规则自相矛盾。
    if sum(costs) <= max_tokens:
        return text
    if max_tokens <= 0:
        return ""

    total = 0
    boundary = len(text) if keep_tail else 0
    order = range(len(text) - 1, -1, -1) if keep_tail else range(len(text))
    for index in order:
        cost = costs[index]
        if total + cost > max_tokens:
            break
        total += cost
        boundary = index if keep_tail else index + 1

    if not keep_tail:
        # 从头算的那一遍是**精确**的：末尾被截掉的半截词在 [0, boundary) 里的成本
        # 与它在整串里一样（词首一直都在）。所以只需去掉截断留下的尾随空白。
        return text[:boundary].rstrip()

    kept = text[boundary:]
    # 从尾算的那一遍会**低估 1**：截断点落在词中间时，那个半截词在新串里重新起算
    # （成本从 0 变 1）。差值最多 1（只有跨边界的那一个词会变），但
    # `estimate_tokens(truncate_tail(t, n)) <= n` 是本模块对外的承诺，
    # 不能靠"最多差一个，无所谓"糊过去 —— 预算判断正是靠这条不变式才敢不复查。
    while kept != "" and estimate_tokens(kept) > max_tokens:
        kept = kept[1:]
    # 去掉截断留下的前导空白：留一个前导空格会让模型接出多余的空格。
    return kept.lstrip()
