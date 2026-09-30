#!/usr/bin/env node
/**
 * 准备 sidecar 的 Python 虚拟环境。
 *
 * 设计原则：**不做隐式全局安装**。所有依赖只进 services/sidecar/.venv，
 * 不碰系统 Python、不装到用户 site-packages。
 *
 * 用法：
 *   pnpm sidecar:setup
 *   INKSTONE_PYTHON=/path/to/python3.12 pnpm sidecar:setup   # 指定解释器
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIDECAR_DIR = path.join(REPO_ROOT, 'services', 'sidecar');
const VENV_DIR = path.join(SIDECAR_DIR, '.venv');
const MIN_PYTHON = [3, 12];

const isWindows = process.platform === 'win32';
const venvPython = isWindows
  ? path.join(VENV_DIR, 'Scripts', 'python.exe')
  : path.join(VENV_DIR, 'bin', 'python');

/** 首轮筛选：能跑起来就算候选，具体版本随后再验。 */
const CANDIDATES = [
  process.env.INKSTONE_PYTHON && { command: process.env.INKSTONE_PYTHON, args: [] },
  // Windows 的 py launcher 能自动挑到最新的 3.x
  isWindows && { command: 'py', args: ['-3'] },
  { command: 'python', args: [] },
  { command: 'python3', args: [] },
].filter(Boolean);

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', ...options });
}

function fail(message) {
  process.stderr.write(`\n[sidecar:setup] ${message}\n`);
  process.exit(1);
}

function step(message) {
  process.stdout.write(`[sidecar:setup] ${message}\n`);
}

/** 找一个 >= 3.12 的解释器。找不到就报清楚该装什么，而不是抛出看不懂的错。 */
function pickBasePython() {
  const tried = [];
  for (const candidate of CANDIDATES) {
    const probe = run(candidate.command, [
      ...candidate.args,
      '-c',
      'import sys;print("%d.%d"%sys.version_info[:2])',
    ]);
    if (probe.status !== 0) {
      tried.push(`${candidate.command} → 不可用`);
      continue;
    }
    const version = (probe.stdout ?? '').trim();
    const [major, minor] = version.split('.').map(Number);
    if (major > MIN_PYTHON[0] || (major === MIN_PYTHON[0] && minor >= MIN_PYTHON[1])) {
      return { ...candidate, version };
    }
    tried.push(`${candidate.command} → ${version}（低于 ${MIN_PYTHON.join('.')}）`);
  }

  fail(
    [
      `未找到 Python >= ${MIN_PYTHON.join('.')}。`,
      '',
      '已尝试：',
      ...tried.map((line) => `  - ${line}`),
      '',
      '请安装 Python 3.12+ 后重试，或显式指定解释器：',
      '  INKSTONE_PYTHON="C:\\path\\to\\python.exe" pnpm sidecar:setup',
    ].join('\n'),
  );
}

function pip(args) {
  const result = spawnSync(venvPython, ['-m', 'pip', ...args], {
    cwd: SIDECAR_DIR,
    stdio: 'inherit',
  });
  if (result.status !== 0) fail(`pip ${args.join(' ')} 失败（退出码 ${result.status}）`);
}

function main() {
  if (!fs.existsSync(SIDECAR_DIR)) fail(`未找到 sidecar 目录：${SIDECAR_DIR}`);

  if (fs.existsSync(venvPython)) {
    step(`复用已有虚拟环境：${path.relative(REPO_ROOT, venvPython)}`);
  } else {
    const base = pickBasePython();
    step(`使用 Python ${base.version}（${base.command}）创建虚拟环境`);
    const created = spawnSync(base.command, [...base.args, '-m', 'venv', VENV_DIR], {
      cwd: SIDECAR_DIR,
      stdio: 'inherit',
    });
    if (created.status !== 0) fail(`创建虚拟环境失败（退出码 ${created.status}）`);
  }

  // 依赖只装进 .venv，绝不出圈。
  step('升级 pip');
  pip(['install', '--upgrade', 'pip']);

  step('安装 sidecar 依赖（含 dev 组：pytest / httpx / ruff）');
  pip(['install', '-e', '.[dev]']);

  step(`完成。解释器：${venvPython}`);
  step('下一步：pnpm dev（或先跑 pnpm sidecar:test 验证）');
}

main();
