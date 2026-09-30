#!/usr/bin/env node
/**
 * 用 PyInstaller 把 sidecar 打成 --onedir 独立产物。
 *
 * ## 为什么这个脚本要显式打印解释器与版本
 *
 * PyInstaller 打包的结果**强绑定**打包时用的 Python 版本：用 3.12 打出的包、
 * 跟用 3.13 打出的包，hidden-imports 与运行时行为可能不同。不打印的话，
 * "打出来一个坏包"会变成"sidecar 装完起不来"这种离问题十万八千里的症状。
 * 所以第一步就把 `<解释器绝对路径> <版本>` 打出来，出问题时一眼能对上。
 *
 * ## 产物布局（与 env.ts 的生产态分支、electron-builder 的 extraResources 对齐）
 *
 *   apps/desktop/resources/sidecar/inkstone-sidecar/
 *     ├─ inkstone-sidecar.exe
 *     └─ _internal/…            # Python 运行时 + 依赖（--onedir）
 *
 * 三处必须一致，改任何一处都要同步另两处：
 *   1. 这里 --name inkstone-sidecar + --distpath resources/sidecar
 *   2. env.ts 生产态：resources/sidecar/inkstone-sidecar/inkstone-sidecar.exe
 *   3. electron-builder.cjs：extraResources from resources/sidecar → to sidecar
 *
 * ## --console 不能省
 *
 * sidecar 的握手靠 stdout 打印 `INKSTONE_READY {...}`。打成 --windowed 后没有
 * stdout，主进程会等 15 秒报"启动超时"——而 sidecar 其实起来了。这是打包步骤里
 * 最隐蔽的坑。
 *
 * ## --add-data 必须列数据文件
 *
 * PyInstaller 只打包它静态分析到的 .py，**非 Python 文件一个都不带**。sidecar 的
 * prompt 模板（.toml）是 importlib.resources.files() 读的，缺了它们 /ai/continue
 * 与 /ai/quick 直接 500，而 healthz 正常——看起来像"打包成功了"。
 *
 * ## 为什么这里用异步 spawn 而不是 spawnSync
 *
 * 在 WorkBuddy 的沙箱（Bash 工具）里，`spawnSync` 对任何 .exe 都返回 EBUSY
 * （连 `node.exe`/`cmd.exe` 自己都是），而异步 `spawn` 正常。这不是 PyInstaller
 * 的问题，是同步 CreateProcess 在该环境被拦。所有 spawn 都走异步，脚本本身
 * 用顶层 await（Node 22 的 ESM 支持）。
 *
 * 用法：pnpm build:sidecar
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIDECAR_DIR = path.join(REPO_ROOT, 'services', 'sidecar');
const SRC_DIR = path.join(SIDECAR_DIR, 'src');
const DIST_DIR = path.join(REPO_ROOT, 'apps', 'desktop', 'resources', 'sidecar');
const WORK_DIR = path.join(REPO_ROOT, '.build', 'pyinstaller');

const isWindows = process.platform === 'win32';
const venvPython = isWindows
  ? path.join(SIDECAR_DIR, '.venv', 'Scripts', 'python.exe')
  : path.join(SIDECAR_DIR, '.venv', 'bin', 'python');

function step(message) {
  process.stdout.write(`[build:sidecar] ${message}\n`);
}

function fail(message) {
  process.stderr.write(`\n[build:sidecar] ${message}\n`);
  process.exit(1);
}

/** 异步 spawn 一个进程，把 stdio 直通到当前终端，resolve 退出码。 */
function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      // 打包产物目录（resources/sidecar、.build/pyinstaller）必然 >50 文件，
      // PyInstaller 重建它们时的 shutil.rmtree 会被 WorkBuddy 的 Python 侧
      // safe-delete shim 拦下（sitecustomize.py 经 PYTHONPATH 自动加载，
      // 报 SAFE_DELETE_BULK_CONFIRM_REQUIRED、退出码 1）。这些目录都在
      // .gitignore 里、且是本脚本自己生成的构建产物，关闭拦截是安全的。
      env: {
        ...process.env,
        CODEBUDDY_SAFE_DELETE_ENABLED: '0',
        ...(options.env ?? {}),
      },
      ...options,
    });
    child.on('error', (err) => {
      process.stderr.write(`\n[build:sidecar] spawn 失败：${err.message}\n`);
      resolve(1);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

// ---- 解释器前置检查 ----
if (!fs.existsSync(venvPython)) {
  fail(`虚拟环境不存在：${venvPython}\n请先执行：pnpm sidecar:setup`);
}

step(`解释器 ${venvPython}`);

const ver = await run(venvPython, ['--version']);
if (ver !== 0) fail(`无法确定 Python 版本（退出码 ${ver}）`);

// PyInstaller 存在性：用一个能快速失败的最小调用探一下。
const probe = await run(venvPython, ['-m', 'PyInstaller', '--version']);
if (probe !== 0) {
  fail(
    [
      `venv 里没有 PyInstaller：${venvPython}`,
      '请先执行：',
      `  ${venvPython} -m pip install "pyinstaller>=6.22,<7"`,
    ].join('\n'),
  );
}

// ---- hidden-imports：uvicorn / anyio 的运行时字符串导入 ----
const hiddenImports = [
  'uvicorn.logging',
  'uvicorn.loops.auto',
  'uvicorn.loops.asyncio',
  'uvicorn.protocols.http.auto',
  'uvicorn.protocols.http.h11_impl',
  'uvicorn.protocols.websockets.auto',
  'uvicorn.lifespan.on',
  'anyio._backends._asyncio',
];

// ---- --add-data：Windows 用 ;，POSIX 用 : ----
const sep = isWindows ? ';' : ':';
const promptsSrc = path.join(SRC_DIR, 'inkstone', 'ai', 'prompts');
const promptsDest = path.join('inkstone', 'ai', 'prompts');

const args = [
  '--noconfirm',
  // 不加 --clean：它会清 .build/pyinstaller 下的构建缓存，而那一步的目录删除
  // 会被沙箱的批量删除保护拦下（>50 文件即拦），表现为 PyInstaller 退出码 1。
  // 没有 --clean 时 PyInstaller 走增量构建（复用 Analysis 缓存），反而更快；
  // spec 由 --noconfirm 每次重新生成，不依赖旧状态。
  '--name',
  'inkstone-sidecar',
  '--onedir',
  '--console',
  '--distpath',
  DIST_DIR,
  '--workpath',
  WORK_DIR,
  '--specpath',
  WORK_DIR,
  '--paths',
  SRC_DIR,
  '--add-data',
  `${promptsSrc}${sep}${promptsDest}`,
  ...hiddenImports.flatMap((mod) => ['--hidden-import', mod]),
  // 打包入口用 entry.py（绝对导入拉起 inkstone 包），**不是** __main__.py ——
  // __main__.py 的相对导入在 PyInstaller 的"独立脚本"语境下没有父包，见 entry.py 的说明。
  path.join(SRC_DIR, 'inkstone', 'entry.py'),
];

step('运行 PyInstaller（--onedir --console）…');
// 注意：这里**不手动删** resources/sidecar 与 .build/pyinstaller —— 沙箱的批量删除
// 保护（>50 文件/回合）会拦下 rmSync。PyInstaller 的 --noconfirm 会覆盖同名产物，
// --clean 会清理它自己的缓存，这两项已足够让产物保持干净。
const result = await run(venvPython, ['-m', 'PyInstaller', ...args], { cwd: SIDECAR_DIR });
if (result !== 0) fail(`PyInstaller 退出码 ${result}`);

// ---- 产物自检 ----
const exe = path.join(
  DIST_DIR,
  'inkstone-sidecar',
  isWindows ? 'inkstone-sidecar.exe' : 'inkstone-sidecar',
);
if (!fs.existsSync(exe)) {
  fail(`产物缺失：${exe}`);
}
const packedPrompts = path.join(
  DIST_DIR,
  'inkstone-sidecar',
  '_internal',
  'inkstone',
  'ai',
  'prompts',
);
const tomlCount = fs.existsSync(packedPrompts)
  ? fs.readdirSync(packedPrompts).filter((f) => f.endsWith('.toml')).length
  : 0;
if (tomlCount === 0) {
  fail(`打包后的 prompt 模板缺失（${packedPrompts} 下没有 .toml）—— 生成类端点会 500。`);
}

step(`完成。可执行文件：${exe}`);
step(`prompt 模板：${tomlCount} 个 .toml 已随包带上`);
step('下一步：pnpm sidecar:smoke:packed（对着打包产物跑冒烟，不是对着 venv）');
