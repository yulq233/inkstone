"""Codex 领域模型与 frontmatter 序列化的测试（``docs/15`` §5 B1）。

核心是**往返不变性**：``parse_entry(dump_entry(entry)) == entry``。
这条钉住的是 dump 的三个参数（``sort_keys=False`` / ``allow_unicode`` /
``width=巨大``）—— 任何一个被"顺手优化"掉，症状都是往返后字节变化、
hash 变化、用户凭空多一次"外部修改"提示。
"""

from __future__ import annotations

import pytest

from inkstone.domain.codex import CodexEntry, Relation, dump_entry, parse_entry


def _entry(**overrides: object) -> CodexEntry:
    base: dict[str, object] = {
        "type": "character",
        "name": "沈观澜",
        "aliases": ["观澜", "沈先生"],
        "tags": ["主角", "云京司"],
        "fields": {"年龄": 27, "性格标签": ["谨慎", "重诺"], "外貌": {"瞳色": "黑"}},
        "summary": "云京司最年轻的主事。",
        "relations": [Relation(to="沈砚之", kind="父子", note="断绝往来多年")],
        "body": "第一段。\n\n第二段：带**加粗**与英文 mixed content。\n",
    }
    base.update(overrides)
    return CodexEntry.model_validate(base)


# ---- 往返不变性 ----


@pytest.mark.parametrize(
    "entry",
    [
        # 全字段 + 中文 + 嵌套 fields —— 最重的形态。
        _entry(),
        # 全空：只有 name 与 type。空列表序列化成 `[]`，解析回来还是空。
        _entry(aliases=[], tags=[], fields={}, summary="", relations=[], body=""),
        # 多行 summary（块标量路径）：YAML 会用 |- 折叠，往返必须原样。
        _entry(summary="第一行\n第二行\n"),
        # 正文含 YAML 敏感内容：行首 ---、#注释、冒号结尾。都只在 body 里，
        # 不进 frontmatter，解析器不许把它们当结构。
        _entry(body="---\n# 不是注释\n键: 值\n"),
        # 长 summary：钉 width=巨大 —— 默认 80 列会把长文本折行，字节就变了。
        _entry(summary="长" * 300),
        # location 类型 + 空 body：类型字面量要能原样往返。
        _entry(type="location", name="云京", body=""),
    ],
    ids=["full", "minimal", "multiline-summary", "yaml-tricky-body", "long-summary", "location"],
)
def test_round_trip_preserves_entry(entry: CodexEntry) -> None:
    text = dump_entry(entry)
    parsed = parse_entry(text)
    assert parsed is not None
    assert parsed == entry


def test_dump_keeps_field_order_and_unicode() -> None:
    text = dump_entry(_entry())
    # sort_keys=False：name 在 type 之后仍按写入顺序出现（type 最先、name 其次）。
    assert text.index("type:") < text.index("name:") < text.index("aliases:")
    # allow_unicode：中文不许被转义成 \uXXXX。
    assert "沈观澜" in text
    assert "\\u" not in text


# ---- 解析的宽容边界（手写文件生存空间，docs/15 D-1）----


def test_parse_returns_none_without_frontmatter() -> None:
    assert parse_entry("只是一个普通 markdown 文件\n") is None


def test_parse_tolerates_bom() -> None:
    text = dump_entry(_entry())
    parsed = parse_entry("\ufeff" + text)
    assert parsed == _entry()


def test_parse_accepts_closing_delimiter_without_trailing_newline() -> None:
    # 手写常见：删掉了最后一个换行。文件必须仍能打开。
    text = dump_entry(_entry()).rstrip("\n")
    parsed = parse_entry(text)
    assert parsed is not None
    assert parsed.name == "沈观澜"


def test_parse_tolerates_crlf_line_endings() -> None:
    """CRLF 是 Windows 记事本/外部编辑器的默认行尾。

    这是 B2 实测踩到的真 bug：``Path.write_text`` 在 Windows 上把 ``\\n`` 转成
    ``\\r\\n``，而拆装用 ``---\\n`` 匹配分隔符会失配 → 整个文件打不开。
    frontmatter 段要归一化匹配，body 保留原样（改 body 行尾 = 假冲突）。
    """
    text = dump_entry(_entry()).replace("\n", "\r\n")
    parsed = parse_entry(text)
    assert parsed is not None
    assert parsed.name == "沈观澜"
    assert parsed.body == _entry().body.replace("\n", "\r\n")


def test_parse_crlf_preserves_body_bytes() -> None:
    # body 的 CRLF 原样返回：写回时 hash 不变，不触发"外部修改"假告警。
    # body 用纯 LF 构造，整体转 CRLF 后，body 应原样变回 CRLF（不丢 \r、不多 \r）。
    text = dump_entry(_entry(body="第一段\n\n第二段\n")).replace("\n", "\r\n")
    parsed = parse_entry(text)
    assert parsed is not None
    assert parsed.body == "第一段\r\n\r\n第二段\r\n"


def test_parse_ignores_unknown_keys() -> None:
    # 向前兼容：frontmatter 里的未知键忽略，不许报错。
    text = dump_entry(_entry()).replace("type: character\n", "type: character\n自定义键: 1\n")
    parsed = parse_entry(text)
    assert parsed is not None
    assert parsed.name == "沈观澜"


def test_parse_raises_on_broken_yaml() -> None:
    with pytest.raises(ValueError, match="YAML"):
        parse_entry("---\nname: [未闭合\n---\n正文\n")


def test_parse_raises_on_non_mapping_frontmatter() -> None:
    with pytest.raises(ValueError, match="映射"):
        parse_entry("---\n- 只是\n- 一个列表\n---\n")


# ---- 校验（校验在领域层，API 层继承同一套）----


def test_blank_name_rejected() -> None:
    with pytest.raises(ValueError, match="name"):
        CodexEntry.model_validate({"type": "character", "name": "   "})


def test_empty_alias_rejected() -> None:
    with pytest.raises(ValueError, match="别名"):
        CodexEntry.model_validate({"type": "character", "name": "沈观澜", "aliases": [" "]})


def test_relation_to_rejects_path_characters() -> None:
    # relation.to 会变成对对方文件名的引用，路径分隔符必须被闸住（D-2 安全面）。
    with pytest.raises(ValueError, match="文件名"):
        CodexEntry.model_validate(
            {
                "type": "character",
                "name": "沈观澜",
                "relations": [{"to": "../../etc", "kind": "敌对"}],
            }
        )


def test_unknown_type_rejected() -> None:
    with pytest.raises(ValueError):
        CodexEntry.model_validate({"type": "spell", "name": "火球术"})


def test_fields_rejects_depth_three() -> None:
    # 深度 3 的嵌套超出 FieldValue 的形状，必须在校验层炸掉，
    # 而不是落盘后让"读回来"变成另一个形状。
    with pytest.raises(ValueError):
        CodexEntry.model_validate(
            {
                "type": "character",
                "name": "沈观澜",
                "fields": {"外貌": {"头": {"发色": "黑"}}},
            }
        )
