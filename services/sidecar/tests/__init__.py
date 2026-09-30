"""测试包。

有这个文件，`tests/` 才是**包**，mypy 眼里的模块名才是 `tests.test_recent` ——
`pyproject.toml` 里 `[[tool.mypy.overrides]] module = "tests.*"` 那句才会生效。

没有它时模块名是顶层的 `test_recent`，`tests.*` 匹配不上，整段 overrides
**静默失效**（配置看着没问题，错误一条不减）。mypy 的 `module` 模式只允许
整段 `*` 或 `.*`，写不了 `test_*` 这种半通配。所以只能靠这个文件。
"""
