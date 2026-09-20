# 砚台 inkstone

本地优先的中文小说创作工作台。桌面应用，数据存在你自己的磁盘上。

> 当前进度：**M0 批次 B**。作品与文件层（WS3）、Markdown 适配层（WS4）已落地，
> 共 367 个测试通过；编辑器界面组件仍在开发中，`pnpm dev` 目前只能看到启动状态页。

## 文档

| 文件 | 内容 |
|---|---|
| `docs/02-M0-任务拆分与目录骨架.md` | M0 的 WBS、目录骨架、四批次计划、验收标准 |
| `docs/03-M0-详细设计.md` | M0 的模块、函数签名、算法、状态机、异常分支、测试设计 |

两份文档冲突时，以 `03` 为准。

> 另有一份产品设计文档（定位、竞品拆解、商业模式）**不随代码公开发布**，需要时请向作者索取。

## 结构

```
apps/desktop         Electron 桌面应用（主进程 / 预加载 / 渲染进程）
packages/shared      前后端共享的类型与常量、字数口径、语法白名单
packages/md-adapter  Markdown ↔ ProseMirror 适配层（正文读写的唯一入口）
services/sidecar     本地 Python 服务（FastAPI）
scripts              开发与构建辅助脚本
docs                 设计文档
```

## 环境要求

- Node.js >= 20.19、pnpm
- Python 3.12+（本项目在 3.13 上验证）

## 起步

```bash
# 1. 安装前端依赖
pnpm install

# 2. 创建 sidecar 的 Python 虚拟环境并装依赖
pnpm sidecar:setup

# 3. 启动（一条命令拉起 Electron，主进程会自动拉起 sidecar）
pnpm dev
```

> Python 不在 PATH 上时，用环境变量指定解释器：
> `INKSTONE_PYTHON="/path/to/python.exe" pnpm sidecar:setup`

## 验证

不需要启动 Electron 就能验证绝大部分逻辑：

```bash
pnpm verify           # 一次跑完：typecheck + sidecar 单测 + shared + md-adapter

# 或分开跑
pnpm typecheck        # 三个包的 TS 检查
pnpm sidecar:test     # sidecar 的 pytest（含真进程握手与孤儿防护）
pnpm shared:test      # 字数口径与语法白名单
pnpm md-adapter:test  # Markdown 往返不变量（含 property 测试）
pnpm sidecar:smoke    # 无头冒烟：握手 / 鉴权 / 优雅退出 / 日志脱敏
```

Python 侧的 lint：

```bash
cd services/sidecar && .venv/Scripts/python -m ruff check src tests
```

## 架构要点

- **进程**：Electron 主进程 spawn 本地 Python 服务（sidecar）。渲染进程通过本地 HTTP 直连 sidecar，IPC 只承载系统能力。
- **安全**：sidecar 只绑定 `127.0.0.1`，随机端口；token 由主进程生成、经环境变量注入，不落盘、不进日志。
- **数据**：作品是磁盘上的一个目录，Markdown 是正文的唯一真源。数据库只是可重建的索引。

详见 `docs/03-M0-详细设计.md`。

## 进程编排的两条硬规则

改 `apps/desktop/src/main/sidecar/` 之前请先读 `docs/03-M0-详细设计.md` §2.5，那里记了两个实测踩过的坑：

1. Windows 上 venv 的 `python.exe` 是一层 redirector **包装进程**，`spawn()` 返回的 pid 与 sidecar 自报的 pid 不是同一个。硬杀必须两个都杀，否则残留进程占着 stdio 管道，**点关闭后应用会卡死**。
2. 必须设 `PYTHONUNBUFFERED=1`，否则就绪行卡在 Python 缓冲区，表现为 15 秒超时后的"随机启动失败"。
