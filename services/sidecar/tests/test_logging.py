"""日志脱敏（对应 03 文档 §3.4 与验收 A9）。

A9 的措辞是"任意日志文件内容中不含 token 原值"，所以这里的断言
一律基于**最终序列化出来的字符串**，而不是中间对象。
"""

from __future__ import annotations

import json
import logging
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import pytest

from inkstone.logging import REDACTED, JsonFormatter, redact, register_secrets, scrub, setup_logging

TOKEN = "9f2c" + "a" * 60


@pytest.fixture(autouse=True)
def _register_token() -> Iterator[None]:
    register_secrets([TOKEN])
    yield
    register_secrets([])


def _format(**kwargs) -> str:
    record = logging.LogRecord(
        name="inkstone.test",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg=kwargs.pop("msg", "事件"),
        args=(),
        exc_info=None,
    )
    for key, value in kwargs.items():
        setattr(record, key, value)
    return JsonFormatter().format(record)


def test_redact_filters_sensitive_keys_case_and_separator_insensitively() -> None:
    payload = {
        "token": "abc",
        "X-Inkstone-Token": "abc",
        "x_inkstone_token": "abc",
        "Authorization": "Bearer abc",
        "api_key": "abc",
        "apiKey": "abc",
        "note": "keep me",
    }
    result = redact(payload)
    assert result["note"] == "keep me"
    for key in (
        "token",
        "X-Inkstone-Token",
        "x_inkstone_token",
        "Authorization",
        "api_key",
        "apiKey",
    ):
        assert result[key] == REDACTED


def test_redact_walks_nested_structures() -> None:
    payload = {"headers": [{"x-inkstone-token": "abc"}], "deep": {"deeper": {"token": "abc"}}}
    result = redact(payload)
    assert result["headers"][0]["x-inkstone-token"] == REDACTED
    assert result["deep"]["deeper"]["token"] == REDACTED


def test_scrub_replaces_secret_values_anywhere() -> None:
    assert TOKEN not in scrub(f"请求失败，令牌={TOKEN}")


def test_formatter_redacts_token_in_message() -> None:
    line = _format(msg=f"请求失败，令牌={TOKEN}")
    assert TOKEN not in line
    assert REDACTED in line


def test_formatter_redacts_token_in_extra_fields() -> None:
    line = _format(msg="握手", extra_fields={"token": TOKEN, "port": 51234})
    payload = json.loads(line)
    assert payload["token"] == REDACTED
    assert payload["port"] == 51234


def test_formatter_outputs_single_line_json() -> None:
    line = _format(msg="多行\n消息\t带控制符")
    assert "\n" not in line
    assert json.loads(line)["msg"].startswith("多行")


def test_formatter_survives_uncopyable_values() -> None:
    class Weird:
        def __repr__(self) -> str:
            return "<weird>"

    line = _format(msg="对象", extra_fields={"obj": Weird()})
    assert json.loads(line)["obj"] == "<weird>"


@contextmanager
def _isolated_root_logging() -> Iterator[None]:
    root = logging.getLogger()
    saved = root.handlers[:]
    root.handlers.clear()
    try:
        yield
    finally:
        for handler in root.handlers[:]:
            handler.close()
        root.handlers.clear()
        root.handlers.extend(saved)


def test_log_file_never_contains_the_token(tmp_path: Path) -> None:
    """A9 的直测：真的写一个文件出来，再读回来找 token。"""
    with _isolated_root_logging():
        log_file = setup_logging(tmp_path)
        logger = logging.getLogger("inkstone.test.file")
        logger.info("启动，token=%s", TOKEN)
        logger.info("附带字段", extra={"extra_fields": {"token": TOKEN}})
        logging.shutdown()

    content = log_file.read_text(encoding="utf-8")
    assert content.strip(), "日志文件不该是空的"
    assert TOKEN not in content
    assert REDACTED in content
