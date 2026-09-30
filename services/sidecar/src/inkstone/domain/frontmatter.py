"""frontmatter（``---`` 包裹的 YAML 头 + Markdown 正文）的共用拆装。

B1（codex）与 B2（outline）两套文件都用这个格式，拆装机制只允许**一份实现**：
两份各自手写 "---" 切分，宽容规则（BOM、缺尾换行）必然只在一侧补齐 ——
漂移的症状是"同样手写坏的文件，人物卡能打开、章纲打不开"，极难排查。

## 宽容边界（手写文件的生存空间）

文件在用户磁盘上，随时可能被记事本改：

- 开头 BOM → 剥掉（``utf-8-sig`` 解码不覆盖"文件中段被贴进 BOM"的怪情况）；
- 结束符 ``---`` 后没有换行 → 也接受（用户删掉最后一行换行不该打不开文件）；
- 未知键 → **保留在返回的 dict 里**，由调用方决定忽略还是拒绝（codex 忽略，
  outline 的 order/title 也是"多出来的键"同样路径）；
- YAML 语法错误 / 顶层不是映射 → 抛 ``ValueError``，由调用方裁决。

## 序列化钉死项

``sort_keys=False``（字段顺序 = 写入顺序，人读的文件不被字典序搅乱）、
``allow_unicode=True``（中文原样不转义）、``width=1_000_000``（默认 80 列
会把长文本折行 → 往返后字节变化 → hash 变化 → 凭空多一次"外部修改"提示）。

往返不变性由各调用方的 property 测试共同钉住。
"""

from __future__ import annotations

import re
from typing import Any

import yaml

_FM_OPEN = "---\n"
_FM_CLOSE = "\n---\n"


def join_frontmatter(data: dict[str, Any], body: str) -> str:
    """合成完整文件文本。body 原样拼接、不补尾随换行：body 的每个字节都是
    用户写的，序列化层无权添加。"""
    frontmatter = yaml.safe_dump(
        data,
        sort_keys=False,
        allow_unicode=True,
        default_flow_style=False,
        width=1_000_000,
    )
    return f"{_FM_OPEN}{frontmatter}{_FM_CLOSE}{body}"


def split_frontmatter(text: str) -> tuple[dict[str, Any], str] | None:
    """拆成 ``(frontmatter 字典, body)``。

    返回 ``None`` = 没有 frontmatter（调用方区分"不是本格式"与"格式坏了"）；
    YAML 语法错误 / 顶层非映射抛 ``ValueError``（格式是本格式但内容坏）。

    ⚠️ 容忍 CRLF：Windows 记事本保存、或外部编辑器默认配置，都会把文件写成
    ``\\r\\n`` 行尾。所以这里**只对 frontmatter 段做行尾归一化**（把 ``\\r\\n``
    当 ``\\n`` 看待来匹配 ``---`` 分隔符），body 从原文按字节切、原样返回 ——
    body 的每个字节都是用户写的，改它的行尾会让 hash 无端变化、触发假冲突。
    """
    text = text.lstrip("\ufeff")
    if not text.startswith("---\n") and not text.startswith("---\r\n"):
        return None

    # 打开分隔符占一整行（"---" + 换行），长度因行尾风格而异。
    open_len = len("---\r\n") if text.startswith("---\r\n") else len("---\n")
    after_open = text[open_len:]

    # 结束分隔符 = 独占一行的 "---"。用正则定位"行首 --- 到行尾"（不含
    # 行尾换行符本身），再从该行之后切 body —— 这样 body 不含前导换行。
    # ``[ \t]*`` 容忍 "--- " 这类尾随空格的手写；``\r?`` 容忍 CRLF。
    match = re.search(r"(?m)^---[ \t]*\r?$", after_open)
    if match is None:
        # 没有结束分隔符。接受"文件以 --- 结尾"的退化形式（手写常见）。
        stripped = after_open.rstrip("\r\n")
        if stripped.endswith("---"):
            frontmatter_text = after_open[: stripped.rfind("---")]
            body = ""
        else:
            return None
    else:
        frontmatter_text = after_open[: match.start()]
        # body 从结束行**之后**开始：跳过 "---" 行 + 其后的换行（\n 或 \r\n）。
        body_start = match.end()
        if after_open.startswith("\r\n", body_start):
            body_start += 2
        elif after_open.startswith("\n", body_start):
            body_start += 1
        body = after_open[body_start:]

    # frontmatter 段做 CRLF→LF 归一化再喂 YAML：yaml 本就把 \r 当空白，
    # 但归一化能让"键值里的 \r\n"不残留进字符串值（安全边际）。
    frontmatter_text = frontmatter_text.replace("\r\n", "\n")
    try:
        data = yaml.safe_load(frontmatter_text)
    except yaml.YAMLError as exc:
        raise ValueError(f"frontmatter 不是合法的 YAML：{exc}") from exc
    if data is None:
        data = {}
    if not isinstance(data, dict):
        raise ValueError("frontmatter 必须是键值映射")
    return data, body

