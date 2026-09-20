"""运行时配置。

所有敏感信息都来自环境变量，由 Electron 主进程在 spawn 时注入：
token 既不走命令行（可见于进程列表），也不走 stdout（会进日志），只走 env。

详见 docs/03-M0-详细设计.md §3.1。
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

VERSION = "0.1.0"

# 与主进程 launcher.ts 的 SUPPORTED_PROTOCOL 必须一致。
PROTOCOL_VERSION = 1

# token 只监听本机回环，绝不 bind 0.0.0.0。
DEFAULT_HOST = "127.0.0.1"


class ConfigError(RuntimeError):
    """环境不完整，无法启动。这类错误要给出"照着做就行"的提示。"""


@dataclass(frozen=True, slots=True)
class Settings:
    host: str
    token: str
    home: Path
    log_dir: Path
    parent_pid: int | None
    version: str = VERSION
    protocol_version: int = PROTOCOL_VERSION


def _require(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ConfigError(
            f"缺少环境变量 {name}。sidecar 不能独立运行，请通过砚台主进程启动，"
            f"或先执行 `pnpm sidecar:setup` 后使用 `pnpm dev`。"
        )
    return value


def load_settings() -> Settings:
    token = _require("INKSTONE_TOKEN")
    home = Path(_require("INKSTONE_HOME")).expanduser()

    raw_log_dir = os.environ.get("INKSTONE_LOG_DIR", "").strip()
    log_dir = Path(raw_log_dir).expanduser() if raw_log_dir else home / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)

    raw_parent_pid = os.environ.get("INKSTONE_PARENT_PID", "").strip()
    parent_pid = int(raw_parent_pid) if raw_parent_pid.isdigit() else None

    return Settings(
        host=DEFAULT_HOST,
        token=token,
        home=home,
        log_dir=log_dir,
        parent_pid=parent_pid,
    )
