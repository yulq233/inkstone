"""握手 / 退出的端到端测试。

这一组真的起进程、真的走 TCP，因为它要验证的东西**只有真进程才能验证**：
就绪行是否及时刷出、端口是否真的在 listen、父进程死掉时会不会留孤儿。

（同一套断言在 Node 侧还有一份 scripts/sidecar-smoke.mjs，
 那份用于不装 Python 工具链的场合；这里这份能被 pytest 选中、便于以后进 CI。）
"""

from __future__ import annotations

import contextlib
import json
import os
import secrets
import subprocess
import sys
import threading
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest

SIDECAR_DIR = Path(__file__).resolve().parents[1]
SRC_DIR = SIDECAR_DIR / "src"

READY_PREFIX = "INKSTONE_READY "
READY_TIMEOUT_S = 25.0
SHUTDOWN_TIMEOUT_S = 8.0


# ---------------------------------------------------------------------------
# 本地请求必须显式绕开系统代理
# ---------------------------------------------------------------------------
#
# sidecar 只监听 `127.0.0.1`，这些用例也只连 `127.0.0.1`。但 httpx 默认
# `trust_env=True`，会去读系统代理配置 —— 在 Windows 上连**注册表**都会被读到。
#
# 这不是"某台机器特殊"：国内开发机普遍装着本地代理客户端（Clash / v2ray 之类），
# 它们把系统代理指向 `127.0.0.1:7892` 这种地址。于是连本机 sidecar 的请求也被
# 送去代理，返回 **502 Bad Gateway**，六个握手用例一起挂。
#
# 最麻烦的是它看起来像"随机失败"：换台机器、换个终端就正常了，
# 于是很容易被当成 flaky 而忽略掉。所以这里显式 `trust_env=False`，
# 把"测试不依赖机器的网络配置"钉死。
#
# （注意：同名的 `scripts/sidecar-smoke.mjs` 用 Node 的 fetch，undici 不读系统代理，
# 所以那边没这个问题 —— 别以为两份脚本行为一致。）


def local_get(url: str, **kwargs: Any) -> httpx.Response:
    kwargs.setdefault("timeout", 3)
    kwargs["trust_env"] = False
    return httpx.get(url, **kwargs)


def local_post(url: str, **kwargs: Any) -> httpx.Response:
    kwargs.setdefault("timeout", 3)
    kwargs["trust_env"] = False
    return httpx.post(url, **kwargs)


class SidecarProcess:
    """包装一个真的 sidecar 进程，把 stdout/stderr 抽干以免管道堵住。"""

    def __init__(self, home: Path, token: str) -> None:
        self.token = token
        log_dir = home / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        self.log_file = log_dir / "sidecar.log"

        env = {
            **os.environ,
            "INKSTONE_TOKEN": token,
            "INKSTONE_HOME": str(home),
            "INKSTONE_LOG_DIR": str(log_dir),
            "INKSTONE_PARENT_PID": str(os.getpid()),
            "PYTHONUNBUFFERED": "1",
            "PYTHONUTF8": "1",
            "PYTHONPATH": str(SRC_DIR),
        }
        # stdin 必须是管道：sidecar 的孤儿防护依赖它；给 DEVNULL 会让进程一启动就自杀。
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "inkstone"],
            cwd=str(SIDECAR_DIR),
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

        self.stdout_lines: list[str] = []
        self.stderr_text = ""
        self._ready = threading.Event()
        self._payload: dict | None = None

        threading.Thread(target=self._pump_stdout, name="stdout", daemon=True).start()
        threading.Thread(target=self._pump_stderr, name="stderr", daemon=True).start()

    # ---- 输出收集 ----

    def _pump_stdout(self) -> None:
        assert self.proc.stdout is not None
        for raw in self.proc.stdout:
            line = raw.decode("utf-8", "replace").rstrip("\r\n")
            self.stdout_lines.append(line)
            if line.startswith(READY_PREFIX) and not self._ready.is_set():
                self._payload = json.loads(line[len(READY_PREFIX) :])
                self._ready.set()

    def _pump_stderr(self) -> None:
        assert self.proc.stderr is not None
        for raw in self.proc.stderr:
            self.stderr_text += raw.decode("utf-8", "replace")

    def drain(self, seconds: float = 0.3) -> None:
        """给输出线程一点收尾时间，避免断言时读到的还是半截。"""
        time.sleep(seconds)

    # ---- 握手 ----

    def wait_ready(self, timeout: float = READY_TIMEOUT_S) -> dict:
        if not self._ready.wait(timeout):
            raise AssertionError(
                f"{timeout}s 内未收到就绪行。\n"
                f"stdout={self.stdout_lines!r}\nstderr={self.stderr_text!r}"
            )
        assert self._payload is not None
        return self._payload

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.wait_ready()['port']}"

    @property
    def auth_headers(self) -> dict[str, str]:
        return {"X-Inkstone-Token": self.token}

    # ---- 清理 ----

    def kill(self) -> None:
        if self.proc.poll() is not None:
            return
        if sys.platform == "win32":
            subprocess.run(
                ["taskkill", "/PID", str(self.proc.pid), "/T", "/F"],
                capture_output=True,
                check=False,
            )
        else:
            self.proc.kill()
        with contextlib.suppress(subprocess.TimeoutExpired):  # pragma: no cover - 兜底
            self.proc.wait(timeout=5)


@pytest.fixture()
def spawn(tmp_path: Path) -> Iterator[Callable[..., SidecarProcess]]:
    """返回一个工厂：spawn("子目录名", token=...) → SidecarProcess。

    测试结束时统一兜底强杀，失败用例也不会留孤儿。
    """
    spawned: list[SidecarProcess] = []
    counter = {"n": 0}

    def _spawn(subdir: str | None = None, token: str | None = None) -> SidecarProcess:
        counter["n"] += 1
        home = tmp_path / (subdir or f"work{counter['n']}")
        proc = SidecarProcess(home, token or secrets.token_hex(32))
        spawned.append(proc)
        return proc

    yield _spawn

    for proc in spawned:
        proc.kill()


def test_handshake_line_is_complete_and_parseable(spawn) -> None:
    proc = spawn()
    payload = proc.wait_ready()

    assert payload["v"] == 1
    assert isinstance(payload["port"], int) and payload["port"] > 0
    assert isinstance(payload["pid"], int) and payload["pid"] > 0
    assert isinstance(payload["version"], str) and payload["version"]

    # 注意：**不要**断言 payload["pid"] == proc.proc.pid。
    # Windows 上 venv 的 python.exe 是一层 redirector 包装进程，它会再拉起真正的
    # 解释器，所以两者天然不同（实测 spawn=31380 / os.getpid()=9868，
    # 且 31380 正是 9868 的父进程）。主进程不能假设它们相等——
    # 这正是硬杀要同时杀两个 pid 的原因，见 test_hardkill_by_announced_pid_*。
    assert payload["port"] > 0
    assert (
        local_get(f"http://127.0.0.1:{payload['port']}/api/v1/healthz", timeout=3).status_code
        == 200
    )


def test_port_is_listening_the_moment_ready_is_announced(spawn) -> None:
    """验证"先 bind 再宣告"：拿到就绪行时端口必须已经能连。"""
    proc = spawn()
    payload = proc.wait_ready()

    res = local_get(f"http://127.0.0.1:{payload['port']}/api/v1/healthz", timeout=3)
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert body["version"] == payload["version"]
    assert isinstance(body["uptimeMs"], int)


def test_healthz_is_reachable_without_token_but_others_are_not(spawn) -> None:
    proc = spawn()
    base = proc.base_url

    assert local_get(f"{base}/api/v1/healthz", timeout=3).status_code == 200
    assert local_post(f"{base}/api/v1/shutdown", timeout=3).status_code == 401


def test_shutdown_endpoint_exits_cleanly(spawn) -> None:
    proc = spawn()
    base = proc.base_url

    res = local_post(f"{base}/api/v1/shutdown", headers=proc.auth_headers, timeout=3)
    assert res.status_code == 200

    assert proc.proc.wait(timeout=SHUTDOWN_TIMEOUT_S) == 0


def test_parent_death_leaves_no_orphan(spawn) -> None:
    """保险二：父进程侧关闭 stdin（等价于父进程消失）→ sidecar 必须自杀。"""
    proc = spawn()
    proc.wait_ready()

    assert proc.proc.stdin is not None
    proc.proc.stdin.close()

    started = time.monotonic()
    code = proc.proc.wait(timeout=SHUTDOWN_TIMEOUT_S)
    elapsed = time.monotonic() - started

    assert code == 0, f"退出码应为 0，实际 {code}；stderr={proc.stderr_text!r}"
    assert elapsed < SHUTDOWN_TIMEOUT_S
    proc.drain()
    assert "孤儿进程防护" in proc.stderr_text


def test_hardkill_by_announced_pid_terminates_everything(spawn) -> None:
    """复刻 `SidecarLauncher.hardKill()`：taskkill /PID <自报 pid> /T /F。

    验证两件事：

    1. 报文里的 pid 就是"真正跑服务、持有监听端口"的那个进程；
    2. **我们直接持有的子进程必须随之退出**。

    第 2 条在 Windows 上不是废话：venv 的 `python.exe` 是一层 redirector
    包装进程（实测 spawn=31380 而 os.getpid()=9868，且 31380 是 9868 的父进程）。
    包装进程通常会在子进程退出后自行退出，但一旦它赖着不走，stdio 管道就不会关，
    主进程的 `child.on('exit')` 永不触发 —— 表现是"点关闭后应用卡死"。
    """
    proc = spawn()
    payload = proc.wait_ready()

    assert payload["pid"] > 0
    # 服务此刻确实活着，否则这条测试证明不了"杀掉它服务就没了"
    assert local_get(proc.base_url + "/api/v1/healthz", timeout=3).status_code == 200

    subprocess.run(
        ["taskkill", "/PID", str(payload["pid"]), "/T", "/F"],
        capture_output=True,
        check=False,
    )

    # 强杀后退出码不为 0 是正常的（进程是被硬杀的），但它**必须**退出。
    code = proc.proc.wait(timeout=SHUTDOWN_TIMEOUT_S)
    assert code is not None


def test_token_never_appears_in_process_output(spawn) -> None:
    """A9 的进程级版本：token 不能出现在 stdout / stderr / 日志文件里。"""
    token = secrets.token_hex(32)
    proc = spawn("leak", token=token)
    base = proc.base_url

    # 故意先带一次正确 token 的请求，逼日志把请求相关信息写出来。
    local_get(f"{base}/api/v1/healthz", headers=proc.auth_headers, timeout=3)
    local_post(f"{base}/api/v1/shutdown", headers=proc.auth_headers, timeout=3)
    proc.proc.wait(timeout=SHUTDOWN_TIMEOUT_S)
    proc.drain()

    assert token not in "".join(proc.stdout_lines)
    assert token not in proc.stderr_text
    if proc.log_file.exists():
        assert token not in proc.log_file.read_text(encoding="utf-8")
