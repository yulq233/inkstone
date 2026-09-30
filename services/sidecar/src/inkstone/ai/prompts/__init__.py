"""prompt 模板的加载与渲染（``docs/11`` §3.7）。

## 为什么是 TOML 而不是 YAML

`docs/11` §3.7 写的是 YAML。落地时改成 TOML，理由与 §3.4 拒绝 LiteLLM 是**同一条**：

- sidecar 的运行时依赖里**没有** YAML 解析器（`pyproject.toml` 只有 fastapi / uvicorn /
  pydantic / httpx），为了几个模板文件引入 PyYAML，换来的是打包体积与一条新的供应链；
- `tomllib` 是 **3.11 起的标准库**，而本项目 `requires-python >= 3.12` —— 零成本。

代价是模板里的多行串要用**三个单引号**那种字面量写法：TOML 的三个双引号多行串
会做转义处理，`\\n` 之类的序列会被吃掉，而 prompt 文案里出现反斜杠并非不可能。
字面量串不处理转义，prompt 写什么就是什么 —— 这对"prompt 必须可原样核对"更重要。

## 渲染不用 `str.format`

模板里出现一个孤立的 `{` 就会让 `str.format` 抛 `KeyError`/`ValueError` ——
而 prompt 文案是**人写的、会随时改的**，用一个"改文案就可能崩"的渲染器不合适。
这里只做已知键的整段替换：未提供的键会在文本里原样留着 `{key}`，一眼能看出来。
"""

from __future__ import annotations

import re
import tomllib
from collections.abc import Mapping
from dataclasses import dataclass
from importlib import resources

#: 顶层必备键。缺任何一个都是**装机/编辑错误**，不该静默兜底成空 prompt
#: —— 空 prompt 的后果是模型自由发挥，而用户以为自己按风格卡在续写。
_REQUIRED_KEYS = ("id", "version", "temperature", "system", "user")

#: 模板 id 的**合法形状**（`docs/13` M8）。
#:
#: 这不是风格要求，是**安全边界**：id 会被拼进资源文件名，而
#: `importlib.resources` 的 `joinpath` 不做任何净化 —— 只要允许 `/`、`\` 或 `.`，
#: `../` 之类的值就能读到包外的任意文件（`resources.files(pkg).joinpath("../x")`）。
#:
#: 为什么用**形状**白名单而不是枚举已知 id（`{"continue", "quick"}`）：
#: `docs/11` §4.3 的约定是"加一种快捷生成不该改 Python"，枚举会把新模板变成改代码；
#: 而形状约束把危险输入挡在外面，同时不限制合法 id 的增长。
_TEMPLATE_ID_RE = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")


@dataclass(frozen=True, slots=True)
class PromptTemplate:
    id: str
    version: int
    temperature: float
    system: str
    user: str
    source: str
    #: 子类型 → 一句指令。目前只有 `quick` 用（`docs/11` §4.3 的 `kind`）。
    #: 放在模板里而不是代码里：加一种快捷生成不该改 Python。
    kinds: Mapping[str, str]


def load_template(template_id: str) -> PromptTemplate:
    """从包内读一个 ``<id>.toml``。找不到就抛 —— 模板缺失是**装机错误**，不该静默兜底。

    先过 `_TEMPLATE_ID_RE` 形状白名单再拼路径：目前调用方传的都是常量
    （路由里写死的 `"continue"` / `"quick"`），但"当前调用方传常量"是一条**会被改掉**的
    前提 —— 检查放这里，形状上就不可能穿越（`docs/13` M8）。
    """
    if not _TEMPLATE_ID_RE.fullmatch(template_id):
        raise ValueError(
            f"非法的 prompt 模板 id {template_id!r}：只允许小写字母开头的 "
            "小写字母/数字/下划线/连字符（这是防止 `../` 读到包外文件的安全边界）。"
        )
    path = resources.files(__package__).joinpath(f"{template_id}.toml")
    raw = tomllib.loads(path.read_text(encoding="utf-8"))

    missing = [key for key in _REQUIRED_KEYS if key not in raw]
    if missing:
        # 最常见的成因：在 `system` / `user` **之前**写了 `[kinds]` 这类表头 ——
        # TOML 的表头会把它之后的所有键都吞进那张表，于是 system 成了 kinds 的子键。
        # 原生报错是一句 `KeyError: 'system'`，完全指不到这里，所以自己报一条。
        raise ValueError(
            f"prompt 模板 {template_id}.toml 缺少字段 {missing}；"
            "若模板里有 `[xxx]` 表头，请确认它写在所有顶层键（system/user 等）**之后**。"
        )

    raw_kinds = raw.get("kinds", {})
    kinds: dict[str, str] = {}
    if isinstance(raw_kinds, dict):
        for key, value in raw_kinds.items():
            if isinstance(key, str) and isinstance(value, str):
                kinds[key] = value
    return PromptTemplate(
        id=str(raw["id"]),
        version=int(raw["version"]),
        temperature=float(raw["temperature"]),
        system=str(raw["system"]),
        user=str(raw["user"]),
        source=str(raw.get("source", "")),
        kinds=kinds,
    )


def render(template: str, values: Mapping[str, str]) -> str:
    """把 ``{key}`` 整段替换成值。未提供的键原样保留（见模块说明）。"""
    rendered = template
    for key, value in values.items():
        rendered = rendered.replace("{" + key + "}", value)
    return rendered
