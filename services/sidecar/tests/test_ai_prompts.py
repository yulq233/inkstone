"""prompt 模板的加载与 id 校验（`docs/13` M8）。

模板 id 最终会被拼进**资源文件名**，所以这里同时钉两件事：

1. 已知模板照常读得到；
2. 非法**形状**被挡下 —— 这是安全边界，不是风格检查。
   `importlib.resources` 的 `joinpath` 不做净化，所以 `../` 这类值能读到包外文件。
"""

from __future__ import annotations

import pytest

from inkstone.ai.prompts import load_template

#: 每一个都对应一种"能读到包外文件"或"多读/少读一个后缀"的写法。
_TRAVERSAL_IDS = [
    "../continue",  # 经典上跳
    "..",  # 上跳一级（joinpath("...toml") 不是它，但 "." 开头也不该放行）
    "./continue",  # 显式当前目录
    "continue/../../README",  # 藏在中间的上跳
    "..\\continue",  # Windows 反斜杠
    "/etc/passwd",  # 绝对路径
    "C:continue",  # 盘符前缀
    "continue.toml",  # 带后缀（id 是文件名词干，不该自己带扩展名）
    "",  # 空
    "Continue",  # 大写开头
    "-continue",  # 标点开头
    "a" * 65,  # 超长
]


def test_known_templates_still_load() -> None:
    """形状白名单不能把合法 id 一起挡掉。"""
    for template_id in ("continue", "quick"):
        assert load_template(template_id).id == template_id


@pytest.mark.parametrize("template_id", _TRAVERSAL_IDS)
def test_traversal_shaped_ids_are_rejected(template_id: str) -> None:
    with pytest.raises(ValueError, match="非法的 prompt 模板 id"):
        load_template(template_id)
