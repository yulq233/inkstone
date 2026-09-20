#!/usr/bin/env node
/**
 * 跑 sidecar 的 Python 测试。venv 不存在时给一句能直接照做的提示，而不是让 pytest 报 import 错。
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
    `\n[sidecar:test] 虚拟环境不存在：${venvPython}\n请先执行：pnpm sidecar:setup\n\n`,
  );
  process.exit(1);
}

const args = process.argv.slice(2);
const result = spawnSync(venvPython, ['-m', 'pytest', ...(args.length ? args : [])], {
  cwd: SIDECAR_DIR,
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
