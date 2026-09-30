"""PyInstaller 打包入口（``docs/10`` §3）。

## 为什么需要这个文件，而不能直接打包 ``__main__.py``

``__main__.py`` 用相对导入（``from .app import ...``），这依赖"以 ``python -m inkstone``
方式运行"时 Python 赋予的包上下文（``__package__ == "inkstone"``）。

PyInstaller 把入口文件当**独立脚本**执行，``__package__`` 是 ``None``，
相对导入会抛 ``ImportError: attempted relative import with no known parent package``。

这个文件用绝对导入 ``from inkstone.__main__ import main`` —— 当它被 PyInstaller
打包时，``inkstone`` 包通过 ``--paths src`` 被纳入，``import inkstone.__main__``
会带着正确的 ``__package__`` 执行 ``__main__.py`` 的模块体（此时 ``__name__``
是 ``inkstone.__main__`` 而非 ``__main__``，所以它末尾的 ``if __name__`` 块不会执行），
里面的相对导入随之正常解析。

开发态**不受影响**：``pnpm dev`` 仍走 ``python -m inkstone``（``__main__.py`` 直接入口），
这个文件只有 ``scripts/build-sidecar.mjs`` 引用。
"""

from inkstone.__main__ import main

if __name__ == "__main__":
    import sys

    sys.exit(main())
