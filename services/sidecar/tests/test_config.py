"""环境变量契约（对应 03 文档 §3.1）。

这里的重点是**失败时要给出能照着做的提示**——sidecar 启动失败的信息
最终会显示在错误页上，含糊的一句话会让排查变成翻源码。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from inkstone.config import ConfigError, Settings, load_settings


@pytest.fixture()
def env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    monkeypatch.setenv("INKSTONE_TOKEN", "a" * 64)
    monkeypatch.setenv("INKSTONE_HOME", str(tmp_path))
    monkeypatch.delenv("INKSTONE_LOG_DIR", raising=False)
    monkeypatch.delenv("INKSTONE_PARENT_PID", raising=False)
    return tmp_path


def test_missing_token_is_rejected_with_actionable_message(
    monkeypatch: pytest.MonkeyPatch, env: Path
) -> None:
    monkeypatch.delenv("INKSTONE_TOKEN", raising=False)
    with pytest.raises(ConfigError) as excinfo:
        load_settings()

    message = str(excinfo.value)
    assert "INKSTONE_TOKEN" in message
    assert "pnpm sidecar:setup" in message


def test_missing_home_is_rejected(monkeypatch: pytest.MonkeyPatch, env: Path) -> None:
    monkeypatch.delenv("INKSTONE_HOME", raising=False)
    with pytest.raises(ConfigError, match="INKSTONE_HOME"):
        load_settings()


def test_blank_token_is_treated_as_missing(monkeypatch: pytest.MonkeyPatch, env: Path) -> None:
    monkeypatch.setenv("INKSTONE_TOKEN", "   ")
    with pytest.raises(ConfigError):
        load_settings()


def test_log_dir_defaults_to_home_logs(env: Path) -> None:
    settings = load_settings()
    assert settings.log_dir == env / "logs"
    # 目录必须已经被建出来，否则第一条日志会写失败。
    assert settings.log_dir.is_dir()


def test_log_dir_can_be_overridden(monkeypatch: pytest.MonkeyPatch, env: Path) -> None:
    override = env / "elsewhere"
    monkeypatch.setenv("INKSTONE_LOG_DIR", str(override))
    settings = load_settings()
    assert settings.log_dir == override
    assert override.is_dir()


def test_host_is_always_loopback(env: Path) -> None:
    """只监听 127.0.0.1。这条不该有配置项——不给"改成 0.0.0.0"留口子。"""
    assert load_settings().host == "127.0.0.1"


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("1234", 1234), ("", None), ("abc", None), ("-1", None)],
)
def test_parent_pid_parsing(
    monkeypatch: pytest.MonkeyPatch, env: Path, raw: str, expected: int | None
) -> None:
    monkeypatch.setenv("INKSTONE_PARENT_PID", raw)
    assert load_settings().parent_pid == expected


def test_defaults_are_the_documented_ones(env: Path) -> None:
    settings = load_settings()
    assert isinstance(settings, Settings)
    assert settings.version == "0.1.0"
    assert settings.protocol_version == 1
    assert settings.token == "a" * 64
