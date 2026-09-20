"""sidecar 入口：``python -m inkstone``。

启动顺序（每一步的顺序都是有理由的，见 03 文档 §2.3 / §2.6）：

1. 强制 stdout/stderr 走 UTF-8 —— 避免 Windows 上 cp936 编码把日志写崩。
2. 读环境变量；缺 token 直接退出，不做任何"降级为无鉴权"的危险动作。
3. **先 bind 再宣告**：``bind(("127.0.0.1", 0))`` 由内核分配端口，
   端口在宣告前就已确定，不存在"先起服务再回头查端口"的竞态。
4. 打印单行 ``INKSTONE_READY {...}`` 到 stdout（握手通道）。
5. ``uvicorn.serve(sockets=[sock])`` 接管这个已经 bind 好的 socket。
6. 后台线程监听 stdin EOF：父进程一死就自杀，不留孤儿进程。
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import socket
import sys
import threading

import uvicorn

from .app import create_app
from .config import ConfigError, Settings, load_settings
from .logging import register_secrets, setup_logging

READY_PREFIX = "INKSTONE_READY "
BACKLOG = 2048

# 优雅关闭上限。稍大于主进程的等待窗口（3s），保证第 5 步的强杀很少被触发。
SHUTDOWN_GRACE_S = 4

logger = logging.getLogger("inkstone.main")


def _force_utf8_streams() -> None:
    """把 stdout/stderr 固定成 UTF-8。

    Windows 上管道默认按 locale（cp936）编码，中文日志、甚至某些字符
    都可能抛 UnicodeEncodeError —— 而那条异常恰好会打断握手。
    """
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            continue
        with contextlib.suppress(ValueError, OSError):
            reconfigure(encoding="utf-8", errors="backslashreplace")


def _listen_socket(host: str) -> socket.socket:
    """bind 到内核分配的随机端口，返回已 listen 的 socket。"""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    # asyncio.create_server 要求传入的 socket 带 SO_REUSEADDR，否则直接 ValueError。
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((host, 0))
    sock.setblocking(False)
    sock.listen(BACKLOG)
    return sock


def _announce(settings: Settings, port: int) -> None:
    """向 stdout 写就绪行。格式必须与 launcher.ts 的解析严格一致。"""
    payload = {
        "v": settings.protocol_version,
        "port": port,
        "pid": os.getpid(),
        "version": settings.version,
    }
    sys.stdout.write(
        READY_PREFIX + json.dumps(payload, separators=(",", ":"), ensure_ascii=True) + "\n"
    )
    sys.stdout.flush()


def _watch_parent() -> None:
    """保险二：父进程退出 → stdin 管道关闭 → 读到 EOF → 自杀。

    只由主进程拉起时才启用（此时 stdin 一定是管道，且 INKSTONE_PARENT_PID 必存在）。
    这样也能避免"手动跑 + stdin 被重定向到 /dev/null"时进程秒退。
    """
    if sys.stdin is None:
        return

    def _run() -> None:
        try:
            while sys.stdin.readline() != "":
                pass  # 主进程不会往 stdin 写东西，这里只是个阻塞点
        except (ValueError, OSError):
            pass  # 管道被粗暴关闭，同样视为父进程已死
        logger.warning("父进程 stdin 已关闭，sidecar 主动退出（孤儿进程防护）")
        logging.shutdown()  # 让 os._exit 之前把日志刷盘
        os._exit(0)

    threading.Thread(target=_run, name="inkstone-parent-watch", daemon=True).start()


def _build_server(settings: Settings) -> uvicorn.Server:
    app = create_app(settings)
    config = uvicorn.Config(
        app,
        # 日志配置由 inkstone.logging 统一接管：
        log_config=None,
        # 探活每 5s 一次，访问日志只会把有用信息刷掉。
        access_log=False,
        lifespan="on",
        timeout_graceful_shutdown=SHUTDOWN_GRACE_S,
    )
    server = uvicorn.Server(config)
    # 退出端点通过 app.state.server 触发优雅关闭。
    app.state.server = server
    return server


def main() -> int:
    _force_utf8_streams()

    try:
        settings = load_settings()
    except ConfigError as exc:
        sys.stderr.write(f"[inkstone] 启动失败：{exc}\n")
        return 2

    try:
        log_file = setup_logging(settings.log_dir)
    except OSError:
        # 日志目录不可写不该阻塞创作，降级为仅 stderr。
        logging.basicConfig(level=logging.INFO, stream=sys.stderr)
        log_file = settings.log_dir / "sidecar.log"
    register_secrets([settings.token])

    logger.info(
        "sidecar 正在启动",
        extra={
            "extra_fields": {
                "pid": os.getpid(),
                "version": settings.version,
                "logFile": str(log_file),
            }
        },
    )

    try:
        server = _build_server(settings)
    except Exception:
        logger.exception("装配 FastAPI 应用失败")
        return 3

    try:
        sock = _listen_socket(settings.host)
    except OSError:
        logger.exception("无法绑定本地端口")
        return 4

    port = int(sock.getsockname()[1])
    logger.info(
        "已绑定本地端口，准备宣告就绪",
        extra={"extra_fields": {"host": settings.host, "port": port}},
    )
    _announce(settings, port)

    if settings.parent_pid is not None:
        _watch_parent()

    try:
        asyncio.run(server.serve(sockets=[sock]))
    except KeyboardInterrupt:
        logger.info("收到中断信号，退出")
    finally:
        with contextlib.suppress(OSError):
            sock.close()

    logger.info("sidecar 已退出")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
