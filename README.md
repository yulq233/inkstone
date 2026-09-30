# 砚台 inkstone

本地优先的中文小说创作工作台。桌面应用，数据存在你自己的磁盘上。

> 当前进度：**M0 已完成**。七个步骤（工作台容器 → 编辑器 → 保存与冲突 → 章节侧栏 →
> 主题菜单窗口 → 打包交付）全部落地，`pnpm dist:win` 已能产出安装包。整套测试 1121 个
> （sidecar 505 / shared 57 / md-adapter 150 / desktop 409）全绿。
>
> 剩余工作：手工验收（拿安装包走 `docs/12` 的 A~E 组清单）+ 后续里程碑（M1 性能、
> M3 AI 能力已落地 P0/P1/P1-b，P2 改写与去 AI 味待排期）。

## 文档

| 文件 | 内容 |
|---|---|
| `docs/02-M0-任务拆分与目录骨架.md` | M0 的 WBS、目录骨架、四批次计划、验收标准 |
| `docs/03-M0-详细设计.md` | M0 的模块、函数签名、算法、状态机、异常分支、测试设计 |
| `docs/04-步骤01-工作台容器与作品入口.md` | 三栏容器、作品新建/打开/最近、会话状态、渲染进程代理绕过 |
| `docs/05-步骤02-编辑器面板.md` | TipTap 接入、降级告警条、ProseMirror 基础样式 |
| `docs/06-步骤03-保存状态与冲突处理.md` | 自动保存接线、状态指示、冲突三选一、关窗前 flush |
| `docs/07-步骤04-章节侧栏与切章时序.md` | 章节列表、切章九步时序、连点竞态防护 |
| `docs/08-步骤05-工程规范与持续集成.md` | mypy / ESLint / Prettier、GitHub Actions、`pnpm verify` 补全 |
| `docs/09-步骤06-主题菜单与窗口状态.md` | 主题三态、应用菜单、窗口状态持久化 |
| `docs/10-步骤07-打包交付与验收.md` | PyInstaller + electron-builder、手工验收清单、性能基线 |

`02` 与 `03` 冲突时以 `03` 为准。`04`~`10` 是**按依赖顺序拆出的实施设计**，其中对 `03` 的修正已在各自文档里显式标注（例如 `05` §2 修正了 `03` §6.5 的 `setContent` 签名）。

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

## 构建安装包

一条命令出 Windows 安装包（sidecar → 桌面 → electron-builder 三步编排，见 `docs/10` §4.3）：

```bash
pnpm dist:win
```

产物在 `%USERPROFILE%\.inkstone-build\release\inkstone-<version>-setup.exe`。几个打包特有的坑已由
`scripts/dist-win.mjs` 兜住（详见其文件头注释与 `docs/10` §9）：

- **electron 二进制需先本地解压**：`scripts/dist-win.mjs` 会用系统 `bsdtar` 把 electron zip
  解到 `%USERPROFILE%\.inkstone-build\electron-dist\`，再经环境变量交给
  `apps/desktop/electron-builder.cjs`（绕开本机「目录 rename 被禁」与「工作区内 `*.asar`
  被延迟锁定」两个限制）。electron 与输出目录的路径真源都是 `scripts/build-paths.cjs`。
- **跳过签名**：`signAndEditExecutable: false`，未签名安装包首次运行会有 SmartScreen 提示，
  点「更多信息 → 仍要运行」即可（`docs/10` §10）。

## 架构要点

- **进程**：Electron 主进程 spawn 本地 Python 服务（sidecar）。渲染进程通过本地 HTTP 直连 sidecar，IPC 只承载系统能力。
- **安全**：sidecar 只绑定 `127.0.0.1`，随机端口；token 由主进程生成、经环境变量注入，不落盘、不进日志。
- **数据**：作品是磁盘上的一个目录，Markdown 是正文的唯一真源。数据库只是可重建的索引。

详见 `docs/03-M0-详细设计.md`。

## 进程编排的两条硬规则

改 `apps/desktop/src/main/sidecar/` 之前请先读 `docs/03-M0-详细设计.md` §2.5，那里记了两个实测踩过的坑：

1. Windows 上 venv 的 `python.exe` 是一层 redirector **包装进程**，`spawn()` 返回的 pid 与 sidecar 自报的 pid 不是同一个。硬杀必须两个都杀，否则残留进程占着 stdio 管道，**点关闭后应用会卡死**。
2. 必须设 `PYTHONUNBUFFERED=1`，否则就绪行卡在 Python 缓冲区，表现为 15 秒超时后的"随机启动失败"。
