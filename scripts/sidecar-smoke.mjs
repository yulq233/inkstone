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
 *   M4  codex 端点探活：pyyaml 随包带上（`docs/15` B1）
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

// 打包产物探活：`--packed` 或 `INKSTONE_SIDECAR_BIN` 指向 `inkstone-sidecar.exe` 时，
// 对着**打包产物**跑冒烟（步骤 07 §3.2 的要求），而不是对着 venv。
// 打包产物的鉴权 / 握手 / 优雅退出 / 日志脱敏必须与开发态同一套判据。
const packedFlag = process.argv.includes('--packed');
const packedBinary =
  process.env.INKSTONE_SIDECAR_BIN ||
  (packedFlag
    ? path.join(
        REPO_ROOT,
        'apps',
        'desktop',
        'resources',
        'sidecar',
        'inkstone-sidecar',
        process.platform === 'win32' ? 'inkstone-sidecar.exe' : 'inkstone-sidecar',
      )
    : '');
const usePacked = packedBinary !== '';
// 启动命令：打包产物直接用 exe（无 `-m inkstone`），venv 用 `python -m inkstone`。
const launchCommand = usePacked ? packedBinary : venvPython;
const launchArgs = usePacked ? [] : ['-m', 'inkstone'];

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
if (!usePacked && !fs.existsSync(venvPython)) {
  process.stderr.write(
    `\n[sidecar:smoke] 虚拟环境不存在：${venvPython}\n请先执行：pnpm sidecar:setup\n\n`,
  );
  cleanup();
  process.exit(1);
}
if (usePacked && !fs.existsSync(packedBinary)) {
  process.stderr.write(
    `\n[sidecar:smoke] 打包产物不存在：${packedBinary}\n请先执行：pnpm build:sidecar\n\n`,
  );
  cleanup();
  process.exit(1);
}

process.stdout.write(
  `[sidecar:smoke] 启动 sidecar…（${usePacked ? '打包产物' : 'venv'}，沙箱 ${sandbox}）\n`,
);

child = spawn(launchCommand, launchArgs, {
  cwd: usePacked ? path.dirname(packedBinary) : SIDECAR_DIR,
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
    // venv 态要 PYTHONPATH 指到 src；打包产物自带模块，注入反而可能覆盖它自己的路径。
    ...(usePacked ? {} : { PYTHONPATH: path.join(SIDECAR_DIR, 'src') }),
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
check(
  'A2 port 是正整数',
  Number.isInteger(ready.port) && ready.port > 0,
  `实际 ${String(ready.port)}`,
);
check('A2 pid 是正整数', Number.isInteger(ready.pid) && ready.pid > 0, `实际 ${String(ready.pid)}`);
check(
  'A2 version 非空',
  typeof ready.version === 'string' && ready.version.length > 0,
  `实际 ${String(ready.version)}`,
);

const baseUrl = `http://127.0.0.1:${ready.port}`;

// ---- A5 healthz 免鉴权 ----
try {
  const res = await fetch(`${baseUrl}/api/v1/healthz`, { signal: AbortSignal.timeout(3_000) });
  const body = await res.json().catch(() => ({}));
  check('A5 /healthz 无 token 返回 200', res.status === 200, `实际 ${res.status}`);
  check(
    'A5 /healthz 返回 ok/version/uptimeMs',
    body?.ok === true && typeof body?.version === 'string' && typeof body?.uptimeMs === 'number',
  );
} catch (err) {
  check('A5 /healthz 可达', false, String(err));
}

// ---- A5 受保护端点鉴权 ----
try {
  const noToken = await fetch(`${baseUrl}/api/v1/shutdown`, {
    method: 'POST',
    signal: AbortSignal.timeout(3_000),
  });
  const body = await noToken.json().catch(() => ({}));
  check('A5 受保护端点无 token 返回 401', noToken.status === 401, `实际 ${noToken.status}`);
  check(
    'A5 401 使用统一错误信封',
    body?.error?.code === 'UNAUTHORIZED',
    `实际 ${JSON.stringify(body)}`,
  );

  const wrongToken = await fetch(`${baseUrl}/api/v1/shutdown`, {
    method: 'POST',
    headers: { 'X-Inkstone-Token': 'deadbeef'.repeat(8) },
    signal: AbortSignal.timeout(3_000),
  });
  check(
    'A5 错误 token 同样返回 401（不区分缺失/错误）',
    wrongToken.status === 401,
    `实际 ${wrongToken.status}`,
  );
} catch (err) {
  check('A5 鉴权链路', false, String(err));
}

// ---- 生成端点探活（打包特有：验 prompt 模板随包带上） ----
// 未配 provider 时 /ai/continue 应返回 400 + AI_NOT_CONFIGURED（配置缺失），
// 而不是 500（500 才是"模板没随包带上 / 打包损坏"的信号，docs/10 §3.1）。
try {
  const res = await fetch(`${baseUrl}/api/v1/ai/continue`, {
    method: 'POST',
    headers: { 'X-Inkstone-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workId: 'smoke-work',
      chapterId: 'smoke-chapter',
      prefix: '他推开门',
    }),
    signal: AbortSignal.timeout(3_000),
  });
  const body = await res.json().catch(() => ({}));
  const code = body?.error?.code ?? '';
  check(
    '生成端点返回配置错误（400，非 500 模板缺失）',
    res.status === 400 && code === 'AI_NOT_CONFIGURED',
    `实际 ${res.status} ${code || JSON.stringify(body).slice(0, 80)}`,
  );
} catch (err) {
  check('生成端点探活', false, String(err));
}

// ---- Codex 端点探活（打包特有：验 pyyaml 随包带上，docs/15 B1） ----
// codex 路由的 import 链里有 `import yaml`（frontmatter 解析）。打包产物缺
// pyyaml 时，症状是应用启动即崩或该路由 500。未开作品的 codex 清单应返回
// 404 + WORK_NOT_FOUND（业务分支），而不是 500（打包损坏的信号）。
try {
  const res = await fetch(`${baseUrl}/api/v1/works/smoke-work/codex`, {
    headers: { 'X-Inkstone-Token': token },
    signal: AbortSignal.timeout(3_000),
  });
  const body = await res.json().catch(() => ({}));
  check(
    'codex 端点返回业务错误（404，非 500 依赖缺失）',
    res.status === 404 && body?.error?.code === 'WORK_NOT_FOUND',
    `实际 ${res.status} ${body?.error?.code ?? JSON.stringify(body).slice(0, 80)}`,
  );
} catch (err) {
  check('codex 端点探活', false, String(err));
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

const exited = await Promise.race([exitInfo, sleep(EXIT_WAIT_MS).then(() => null)]);
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
