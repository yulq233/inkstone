#!/usr/bin/env node
/**
 * sidecar 无头冒烟测试 —— 不启动 Electron，直接验证批次 A 的验收点。
 *
 * 覆盖：
 *   A1  能 spawn 出进程并 bind 到随机端口
 *   A2  stdout 能解析出 INKSTONE_READY 就绪行（字段齐全、格式正确）
 *   A5  /api/v1/healthz 免鉴权可达；受保护端点无 token 返回 401
 *   A6  POST /api/v1/shutdown 能让进程优雅退出（退出码 0）
 *   A9  stdout / stderr / 日志文件里都不出现 token 原值
 *
 * 用法：pnpm sidecar:smoke
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIDECAR_DIR = path.join(REPO_ROOT, 'services', 'sidecar');
const venvPython =
  process.platform === 'win32'
    ? path.join(SIDECAR_DIR, '.venv', 'Scripts', 'python.exe')
    : path.join(SIDECAR_DIR, '.venv', 'bin', 'python');

const READY_PREFIX = 'INKSTONE_READY ';
const HANDSHAKE_TIMEOUT_MS = 20_000;
const EXIT_WAIT_MS = 6_000;

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok });
  process.stdout.write(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}\n`);
}

function fail(message) {
  process.stderr.write(`\n[sidecar:smoke] ${message}\n`);
  cleanup();
  process.exit(1);
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'inkstone-smoke-'));
const logDir = path.join(sandbox, 'logs');
fs.mkdirSync(logDir, { recursive: true });

const token = crypto.randomBytes(32).toString('hex');
let child = null;

function cleanup() {
  if (child && child.exitCode === null) {
    try {
      child.kill();
    } catch {
      /* 已退出 */
    }
  }
  try {
    fs.rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* Windows 上文件句柄可能还没释放，忽略即可 */
  }
}

/** 依赖必须在 setup 之后才存在，先探一下给个可照做的提示。 */
if (!fs.existsSync(venvPython)) {
  process.stderr.write(`\n[sidecar:smoke] 虚拟环境不存在：${venvPython}\n请先执行：pnpm sidecar:setup\n\n`);
  cleanup();
  process.exit(1);
}

process.stdout.write(`[sidecar:smoke] 启动 sidecar…（沙箱 ${sandbox}）\n`);

child = spawn(venvPython, ['-m', 'inkstone'], {
  cwd: SIDECAR_DIR,
  // stdin 保留管道：sidecar 靠它做孤儿进程防护；关掉会让进程立刻自杀。
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
  env: {
    ...process.env,
    INKSTONE_TOKEN: token,
    INKSTONE_HOME: sandbox,
    INKSTONE_LOG_DIR: logDir,
    INKSTONE_PARENT_PID: String(process.pid),
    PYTHONUNBUFFERED: '1',
    PYTHONUTF8: '1',
    PYTHONPATH: path.join(SIDECAR_DIR, 'src'),
  },
});

let stdoutText = '';
let stderrText = '';
let ready = null;
let stdoutBuf = '';

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  stdoutText += chunk;
  stdoutBuf += chunk;
  let idx = stdoutBuf.indexOf('\n');
  while (idx >= 0) {
    const line = stdoutBuf.slice(0, idx).replace(/\r$/, '');
    stdoutBuf = stdoutBuf.slice(idx + 1);
    if (line.startsWith(READY_PREFIX) && !ready) {
      try {
        ready = JSON.parse(line.slice(READY_PREFIX.length).trim());
      } catch {
        fail(`就绪行不是合法 JSON：${line}`);
      }
    } else if (line.trim()) {
      process.stdout.write(`    sidecar| ${line}\n`);
    }
    idx = stdoutBuf.indexOf('\n');
  }
});

child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
  stderrText += chunk;
  for (const line of chunk.split('\n')) {
    if (line.trim()) process.stdout.write(`    sidecar! ${line}\n`);
  }
});

const exitInfo = new Promise((resolve) => {
  child.on('exit', (code, signal) => resolve({ code, signal }));
});

const readyDeadline = Date.now() + HANDSHAKE_TIMEOUT_MS;
while (!ready) {
  if (Date.now() > readyDeadline) {
    fail(`等待 INKSTONE_READY 超时（${HANDSHAKE_TIMEOUT_MS / 1000}s）。\n\nstderr:\n${stderrText}`);
  }
  if (child.exitCode !== null) {
    fail(`sidecar 在就绪前退出（code=${child.exitCode}）。\n\nstderr:\n${stderrText}`);
  }
  await sleep(50);
}

// ---- A2 就绪行字段 ----
check('A2 就绪行前缀与 JSON 解析正确', true);
check('A2 v === 1', ready.v === 1, `实际 ${String(ready.v)}`);
check('A2 port 是正整数', Number.isInteger(ready.port) && ready.port > 0, `实际 ${String(ready.port)}`);
check('A2 pid 是正整数', Number.isInteger(ready.pid) && ready.pid > 0, `实际 ${String(ready.pid)}`);
check('A2 version 非空', typeof ready.version === 'string' && ready.version.length > 0, `实际 ${String(ready.version)}`);

const baseUrl = `http://127.0.0.1:${ready.port}`;

// ---- A5 healthz 免鉴权 ----
try {
  const res = await fetch(`${baseUrl}/api/v1/healthz`, { signal: AbortSignal.timeout(3_000) });
  const body = await res.json().catch(() => ({}));
  check('A5 /healthz 无 token 返回 200', res.status === 200, `实际 ${res.status}`);
  check('A5 /healthz 返回 ok/version/uptimeMs', body?.ok === true && typeof body?.version === 'string' && typeof body?.uptimeMs === 'number');
} catch (err) {
  check('A5 /healthz 可达', false, String(err));
}

// ---- A5 受保护端点鉴权 ----
try {
  const noToken = await fetch(`${baseUrl}/api/v1/shutdown`, { method: 'POST', signal: AbortSignal.timeout(3_000) });
  const body = await noToken.json().catch(() => ({}));
  check('A5 受保护端点无 token 返回 401', noToken.status === 401, `实际 ${noToken.status}`);
  check('A5 401 使用统一错误信封', body?.error?.code === 'UNAUTHORIZED', `实际 ${JSON.stringify(body)}`);

  const wrongToken = await fetch(`${baseUrl}/api/v1/shutdown`, {
    method: 'POST',
    headers: { 'X-Inkstone-Token': 'deadbeef'.repeat(8) },
    signal: AbortSignal.timeout(3_000),
  });
  check('A5 错误 token 同样返回 401（不区分缺失/错误）', wrongToken.status === 401, `实际 ${wrongToken.status}`);
} catch (err) {
  check('A5 鉴权链路', false, String(err));
}

// ---- A6 优雅退出 ----
try {
  const res = await fetch(`${baseUrl}/api/v1/shutdown`, {
    method: 'POST',
    headers: { 'X-Inkstone-Token': token },
    signal: AbortSignal.timeout(3_000),
  });
  check('A6 正确 token 调用 /shutdown 返回 200', res.status === 200, `实际 ${res.status}`);
} catch (err) {
  check('A6 /shutdown 可达', false, String(err));
}

const exited = await Promise.race([
  exitInfo,
  sleep(EXIT_WAIT_MS).then(() => null),
]);
check('A6 进程在等待窗口内自行退出（无需强杀）', exited !== null);
if (exited) check('A6 退出码为 0', exited.code === 0, `实际 code=${String(exited.code)}`);

// ---- A9 日志脱敏 ----
const logFile = path.join(logDir, 'sidecar.log');
const logText = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
check('A9 已生成日志文件', logText.length > 0, logFile);
check('A9 stdout 不含 token 原值', !stdoutText.includes(token));
check('A9 stderr 不含 token 原值', !stderrText.includes(token));
check('A9 日志文件不含 token 原值', !logText.includes(token));

waitForExitOrKill();

const failed = checks.filter((c) => !c.ok);
cleanup();
process.stdout.write(
  `\n[sidecar:smoke] ${checks.length - failed.length}/${checks.length} 项通过\n`,
);
if (failed.length) {
  process.stderr.write(`失败项：${failed.map((c) => c.name).join('、')}\n`);
  process.exit(1);
}
process.stdout.write('[sidecar:smoke] 批次 A 冒烟全部通过\n');
process.exit(0);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 若进程还没退干净（比如只被硬杀），确保不留下孤儿。 */
function waitForExitOrKill() {
  if (child.exitCode === null) {
    try {
      child.kill();
    } catch {
      /* 忽略 */
    }
  }
}
