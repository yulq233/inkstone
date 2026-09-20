"""结构化 JSON 日志 + 强制脱敏。

两条硬约束（对应 03 文档 §3.4 与验收 A9）：

1. 日志只写 **stderr 与文件**，绝不写 stdout —— stdout 是握手通道，
   就绪行不能被日志淹没，否则主进程解析出错会表现为"随机启动失败"。
2. 任何落盘内容都要过 ``redact()`` 与 ``scrub()``：既按 key 过滤，
   也按值兜底替换。后者是最后一道保险：即使某个库把 token 拼进了
   异常消息里，日志文件里也只剩 ``***``。
"""

from __future__ import annotations

import json
import logging
import sys
from collections.abc import Iterable, Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

REDACT_KEYS = frozenset(
    {
        # 03 文档 §3.4 规定的最小集合
        "token",
        "authorization",
        "x-inkstone-token",
        "api-key",
        # 额外加固：误命中只是多打几个 ***，漏掉却是事故。所以宁可宽一点。
        "apikey",
        "x-api-key",
    }
)
REDACTED = "***"

# 递归深度上限：日志里塞进深递归对象时不要把栈打爆。
_MAX_DEPTH = 6

# 需要按值兜底擦除的明文（token 等），由 register_secrets() 注入。
_SECRETS: tuple[str, ...] = ()

# 短于该长度的"秘密"不参与按值擦除，避免把 'abc' 这种子串误伤成 ***。
_MIN_SECRET_LEN = 8


def register_secrets(values: Iterable[str]) -> None:
    """登记需要按值擦除的明文。必须在写第一条日志前调用。"""
    global _SECRETS
    _SECRETS = tuple(v for v in values if v and len(v) >= _MIN_SECRET_LEN)


def _normalize_key(key: str) -> str:
    """token / x_inkstone_token / X-Inkstone-Token 归一到同一形态。"""
    return key.strip().lower().replace("_", "-")


def redact(value: Any, _depth: int = 0) -> Any:
    """按 key 递归过滤敏感字段，不区分大小写与下划线/连字符写法。"""
    if _depth > _MAX_DEPTH:
        return "..."
    if isinstance(value, Mapping):
        return {
            key: (
                REDACTED
                if isinstance(key, str) and _normalize_key(key) in REDACT_KEYS
                else redact(item, _depth + 1)
            )
            for key, item in value.items()
        }
    if isinstance(value, (list, tuple, set)):
        return [redact(item, _depth + 1) for item in value]
    return value


def scrub(text: str) -> str:
    """按值兜底擦除。比按 key 过滤更暴力，但能兜住"token 被拼进消息体"的情况。"""
    for secret in _SECRETS:
        if secret in text:
            text = text.replace(secret, REDACTED)
    return text


class JsonFormatter(logging.Formatter):
    """单行 JSON。方便 `pnpm dev` 里肉眼扫，也方便以后接日志聚合。"""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": datetime.fromtimestamp(record.created, tz=UTC).isoformat(timespec="milliseconds"),
            "level": record.levelname.lower(),
            "logger": record.name,
            "msg": record.getMessage(),
        }

        extra = getattr(record, "extra_fields", None)
        if isinstance(extra, Mapping):
            payload.update(extra)

        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        if record.stack_info:
            payload["stack"] = self.formatStack(record.stack_info)

        line = json.dumps(redact(payload), ensure_ascii=False, default=str)
        return scrub(line)


def setup_logging(log_dir: Path, *, level: int = logging.INFO) -> Path:
    """装配根 logger：文件 + stderr。返回日志文件路径（UI 要展示给用户）。"""
    log_file = log_dir / "sidecar.log"
    formatter = JsonFormatter()

    file_handler = logging.FileHandler(log_file, encoding="utf-8", delay=True)
    file_handler.setFormatter(formatter)

    stderr_handler = logging.StreamHandler(sys.stderr)
    stderr_handler.setFormatter(formatter)

    root = logging.getLogger()
    root.handlers.clear()
    root.setLevel(level)
    root.addHandler(file_handler)
    root.addHandler(stderr_handler)

    # uvicorn 自己那套配置在这里被彻底接管（Config(log_config=None)）。
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        logging.getLogger(name).handlers.clear()
        logging.getLogger(name).propagate = True

    return log_file
