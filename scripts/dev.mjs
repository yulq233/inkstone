#!/usr/bin/env node
/**
 * 开发态一键启动（对应验收 A1）。
 *
 * 注意职责划分：**真正拉起 sidecar 的是 Electron 主进程**，与生产态走完全同一条
 * 代码路径。这个脚本只做「前置检查 + 参数透传」，绝不另外起一个 sidecar ——
 * 否则会出现两个服务各自绑端口，症状是"日志看起来正常但界面连的不是同一个进程"。
 *
 * sidecar 的输出由主进程（launcher）在开发态回显到本终端，所以一份终端就能看全。
 *
 * 用法：pnpm dev ｜ pnpm dev -- --inspect
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIDECAR_DIR = path.join(REPO_ROOT, 'services', 'sidecar');
const DESKTOP_DIR = path.join(REPO_ROOT, 'apps', 'desktop');

/**
 * 清掉 ELECTRON_RUN_AS_NODE。
 *
 * 有些环境（CI、容器、或本机被别的工具设过）会带上这个变量。一旦存在，Electron 会以
 * 纯 Node 模式启动，`require('electron')` 变成返回二进制路径字符串，`app` 为 undefined，
 * 应用在启动的第一行就崩，报错却指向 `requestSingleInstanceLock` —— 极难定位。
 *
 * 主进程里也有一道同样的检查作为兜底，但那是"报错得更清楚"；这里才是真正把它修好。
 * 只影响本脚本派生的子进程，不污染用户环境。
 */
delete process.env.ELECTRON_RUN_AS_NODE;

const venvPython =
  process.platform === 'win32'
    ? path.join(SIDECAR_DIR, '.venv', 'Scripts', 'python.exe')
    : path.join(SIDECAR_DIR, '.venv', 'bin', 'python');

/** 前置检查：把"启动后弹错误页"提前成"启动前一句话"。 */
if (!fs.existsSync(venvPython)) {
  process.stderr.write(
    [
      '',
      '  未找到 sidecar 的 Python 虚拟环境：',
      `    ${venvPython}`,
      '',
      '  请先在仓库根目录执行：',
      '    pnpm sidecar:setup',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

/** 从 apps/desktop 的依赖里解析 electron-vite 的入口，避免依赖 .bin 平台后缀。 */
function resolveElectronViteBin() {
  const require = createRequire(path.join(DESKTOP_DIR, 'package.json'));
  const pkgPath = require.resolve('electron-vite/package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const binEntry = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.['electron-vite'];
  if (!binEntry) {
    throw new Error('electron-vite 的 package.json 里没有可用的 bin 入口');
  }
  return path.join(path.dirname(pkgPath), binEntry);
}

let binPath;
try {
  binPath = resolveElectronViteBin();
} catch (err) {
  process.stderr.write(
    `\n  无法定位 electron-vite：${err instanceof Error ? err.message : String(err)}\n` +
      '  请先执行：pnpm install\n\n',
  );
  process.exit(1);
}

const child = spawn(process.execPath, [binPath, 'dev', ...process.argv.slice(2)], {
  cwd: DESKTOP_DIR,
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
