"""错误码的跨语言一致性（`docs/13` M27）。

``_CODE_STATUS``（本服务）与 ``packages/shared/src/errors.ts`` 的 ``ErrorCode``（前端）
原先各手抄一份，20 条全靠人眼对齐 —— 一侧改了、另一侧没跟，两侧的测试却都还是绿的。
这里读共享清单断言，任何一侧漂移都会红。

与 ``test_wordcount.py`` 同构：清单是外部数据，两端都读、都必须全绿。
"""

from __future__ import annotations

import ast
import json
from pathlib import Path
from typing import Any

from inkstone import errors
from inkstone.errors import _CODE_STATUS

_FIXTURE = (
    Path(__file__).resolve().parents[3]
    / "packages"
    / "shared"
    / "fixtures"
    / "error-codes.json"
)


def _load_shared_codes() -> dict[str, int]:
    """读共享清单。

    文件不存在时**故意让测试失败**而不是 skip：它是"两端不漂移"的唯一保障，
    静默跳过等于取消保障（理由同 ``test_wordcount.py``）。
    """
    assert _FIXTURE.is_file(), f"共享清单缺失：{_FIXTURE}"
    data: dict[str, Any] = json.loads(_FIXTURE.read_text(encoding="utf-8"))
    codes: dict[str, int] = data["codes"]
    return codes


def test_code_status_matches_shared_fixture() -> None:
    """码与状态码都必须逐条一致。

    状态码错一条，用户看到的失败语义就变了：例如把"上游拒绝了这次请求"
    写成本地的 401，界面会把整页推进"本地服务连接失败"（前端是按码分的支，
    而状态码是另一个信号）。
    """
    # 过一道变量而不是直接写 `_CODE_STATUS == _load_shared_codes()`：
    # ruff 的 SIM300 把全大写的名字当常量，会判成"Yoda 条件"并报错。
    actual = _CODE_STATUS
    expected = _load_shared_codes()
    assert actual == expected


def test_every_code_used_in_package_is_registered() -> None:
    """包里**实际用到的**错误码，必须都已在 ``_CODE_STATUS`` 登记。

    为什么需要这条：``DomainError.__init__`` 对没登记的码会走
    ``_CODE_STATUS.get(code, 500)`` —— **静默回退成 500**。新增一个错误类却忘了
    登记时，上面那条一致性断言照样通过（新码不在共享清单里，两侧都不知道它存在），
    而用户看到的是"服务器内部错误"。这条从源码侧兜住它。
    """
    used = _collect_used_codes()
    # 先确认扫描本身没坏 —— 否则下面那条在扫描失效时也是绿的。
    assert used, "没扫到任何错误码：扫描逻辑失效了，而不是真的通过"
    unregistered = sorted(used - set(_CODE_STATUS))
    assert not unregistered, f"这些码没在 _CODE_STATUS 里登记（会静默变成 500）：{unregistered}"


def _collect_used_codes() -> set[str]:
    """遍历整个 ``inkstone`` 包，收集所有当作错误码用的字符串字面量。

    覆盖两种写法：

    - ``raise DomainError("INTERNAL", …)`` —— ``storage/repo.py`` 里有 3 处
    - 子类里的 ``super().__init__("WORK_NOT_FOUND", …)`` —— ``errors.py`` 里全部

    用 ast 而不是正则：包里还有别的全大写字符串字面量（环境变量名
    ``INKSTONE_TOKEN``、日志器名之类），正则会把它们一并当成错误码报出来。
    """
    module_file = errors.__file__
    assert module_file is not None
    codes: set[str] = set()
    for path in Path(module_file).resolve().parent.rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and node.args and _is_domain_error_init(node.func):
                literal = _str_literal(node.args[0])
                if literal is not None:
                    codes.add(literal)
    return codes


def _is_domain_error_init(func: ast.expr) -> bool:
    """判断被调用的东西是不是 ``DomainError(...)`` 或 ``super().__init__(...)``。"""
    if isinstance(func, ast.Name):
        return func.id == "DomainError"
    return (
        isinstance(func, ast.Attribute)
        and func.attr == "__init__"
        and isinstance(func.value, ast.Call)
        and isinstance(func.value.func, ast.Name)
        and func.value.func.id == "super"
    )


def _str_literal(node: ast.expr) -> str | None:
    """节点是字符串字面量就返回它，否则 None（码是变量拼的就不在这条断言的范围内）。"""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return None
