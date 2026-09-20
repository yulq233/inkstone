"""砚台本地服务（sidecar）。

由 Electron 主进程拉起，只监听 127.0.0.1 的随机端口，所有请求需带一次性令牌。
"""

from .config import VERSION

__all__ = ["VERSION"]
