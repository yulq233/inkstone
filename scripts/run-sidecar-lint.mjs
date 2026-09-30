#!/usr/bin/env node
/**
 * sidecar 的 Python 静态检查：ruff + mypy。
 *
 * 只跑 `src tests`，不跑整个仓库 —— venv、缓存目录都在仓库里，全局扫会把它们
 * 一起读进来（既慢，又会报一堆第三方代码的错）。
 *
 * 为什么需要这个脚本而不是在 package.json 里直接写命令：venv 里的 python 路径
 * 随平台不同（Scripts\python.exe / bin/python），而 package.json 的 scripts
 * 不做平台分支。与 run-sidecar-tests.mjs 同构。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIDECAR_DIR = path.join(REPO_ROOT, 'services', 'sidecar');
const venvPython =
  process.platform === 'win32'
    ? path.join(SIDECAR_DIR, '.venv', 'Scripts', 'python.exe')
    : path.join(SIDECAR_DIR, '.venv', 'bin', 'python');

if (!fs.existsSync(venvPython)) {
  process.stderr.write(
    `\n[sidecar:lint] 虚拟环境不存在：${venvPython}\n请先执行：pnpm sidecar:setup\n\n`,
  );
  process.exit(1);
}

/** 两步都要跑完再判定，不能一失败就短路 —— 否则修完 ruff 才发现 mypy 也挂了。 */
const steps = [
  ['ruff', ['-m', 'ruff', 'check', 'src', 'tests']],
  ['mypy', ['-m', 'mypy', 'src', 'tests']],
];

let failed = false;
for (const [name, args] of steps) {
  process.stdout.write(`\n[sidecar:lint] ${name}\n`);
  const result = spawnSync(venvPython, args, { cwd: SIDECAR_DIR, stdio: 'inherit' });
  if ((result.status ?? 1) !== 0) failed = true;
}

process.exit(failed ? 1 : 0);
