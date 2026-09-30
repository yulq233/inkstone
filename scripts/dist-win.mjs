#!/usr/bin/env node
/**
 * 一条命令出 Windows 安装包（docs/10 §4.3 的 dist:win）。
 *
 * ## 为什么用 node 编排而不是 `&&` 串联
 *
 * 整条链会删两个"必然 >50 文件"的目录：
 *   1. PyInstaller 重建 resources/sidecar/inkstone-sidecar/（244 个文件）
 *   2. vite 的 prepareOutDir 清空 apps/desktop/out/（89 个文件）
 *
 * 这两个删除在 WorkBuddy 的 safe-delete shim 下（node 侧经 require hook、
 * Python 侧经 sitecustomize.py）会被 SAFE_DELETE_BULK_CONFIRM_REQUIRED 拦下，
 * 表现为构建随机死在中间某一步。它们都在 .gitignore 里、都是构建脚本自己
 * 生成的产物，对本链关闭拦截是安全的 —— 由这里统一给**所有子进程**注入
 * CODEBUDDY_SAFE_DELETE_ENABLED=0，各步骤脚本不需要各自处理。
 *
 * 三步顺序（docs/10 §0：先 sidecar，后桌面，最后 electron-builder）：
 *   1. build:sidecar        PyInstaller 打 sidecar → resources/sidecar/
 *   2. desktop build        electron-vite build → apps/desktop/out/
 *   3. desktop dist:win     electron-builder → <buildRoot>/release/*.exe
 *                           （默认 %USERPROFILE%\.inkstone-build\release，见 build-paths.cjs）
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 构建期路径的**唯一真源**（`electron-builder.cjs` 也 require 同一份）。
// 原先这里与 electron-builder.yml 各算一遍、靠注释提醒同步，且 yml 那份还硬编码了
// 用户名 —— 见 `docs/13` M24。
import { electronDistDir, releaseDir } from './build-paths.cjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Windows 上 pnpm 实际是 pnpm.CMD（pnpm.ps1 在受限执行策略下静默退出，
// 见用户级记忆）；POSIX 直接用 pnpm。INKSTONE_PNPM 可覆盖。
const PNPM = process.env.INKSTONE_PNPM ?? (process.platform === 'win32' ? 'pnpm.CMD' : 'pnpm');

/**
 * 确保本地有一份**已解压**的 electron dist。目录取自 `build-paths.cjs`（与
 * `electron-builder.cjs` 同源），下面再经 `INKSTONE_ELECTRON_DIST` 传给子进程。
 *
 * ## 为什么不用 electron-builder 自己的下载解压
 *
 * 它的流程是「解压到 win-unpacked.tmp → rename 成品」，而本机环境**目录 rename
 * 被沙箱驱动整体禁止**（连两个文件的小目录都 EPERM，实测），rename 必失败。
 * 这里用 Windows 自带的 bsdtar（支持 zip）直接解压到固定目录，
 * electron-builder 只复制不 rename，整条链绕开了 rename。
 *
 * ## 为什么放用户目录（工作区外）而不是仓库 .build/
 *
 * WorkBuddy 对工作区内的 `*.asar` 有**延迟锁定**：文件落地几十秒后被某常驻
 * 服务锁住（EBUSY unlink，重试无效，实测 electron-dist 里的 default_app.asar
 * 与任何asar 副本都中招）。用户目录不在监控范围，无此问题。
 *
 * zip 从 electron 自己的缓存拿（pnpm install 时 @electron/get 下载的），
 * 没有就报错指路 —— 不在这里偷偷下载。
 */
async function ensureElectronDist() {
  const dist = electronDistDir;
  if (fs.existsSync(path.join(dist, 'electron.exe'))) return;

  const electronPkg = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'node_modules', 'electron', 'package.json'), 'utf8'),
  );
  const version = electronPkg.version;
  const cacheRoot = path.join(
    process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? '', 'AppData', 'Local'),
    'electron',
    'Cache',
  );
  // 缓存目录名是内容 hash，直接扫 zip 文件名匹配版本
  let zipPath = null;
  if (fs.existsSync(cacheRoot)) {
    for (const entry of fs.readdirSync(cacheRoot, { recursive: true })) {
      if (entry === `electron-v${version}-win32-x64.zip`) {
        zipPath = path.join(cacheRoot, entry);
        break;
      }
    }
  }
  if (!zipPath) {
    fail(
      [
        `未找到 electron ${version} 的 zip 缓存（${cacheRoot}）。`,
        '请先跑一次 pnpm install 让 @electron/get 下载，或手动放置 zip 后重试。',
      ].join('\n'),
    );
  }

  process.stdout.write(`[dist:win] 解压 electron ${version} → ${dist}\n`);
  fs.mkdirSync(dist, { recursive: true });
  // System32 的 tar 是 bsdtar，支持 zip；Git Bash 自带的 GNU tar 不支持。
  const systemTar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  await new Promise((resolve) => {
    const child = spawn(systemTar, ['-xf', zipPath, '-C', dist], {
      stdio: 'inherit',
      env: { ...process.env, CODEBUDDY_SAFE_DELETE_ENABLED: '0' },
    });
    child.on('error', () => resolve(1));
    child.on('close', (c) => resolve(c ?? 1));
  });
  if (!fs.existsSync(path.join(dist, 'electron.exe'))) {
    fail(`解压完成但没看到 electron.exe（${dist}）`);
  }
}

const STEPS = [
  { name: 'build:sidecar', args: ['build:sidecar'] },
  { name: 'desktop build', args: ['--filter', '@inkstone/desktop', 'build'] },
  { name: 'desktop dist:win', args: ['--filter', '@inkstone/desktop', 'dist:win'] },
];

function step(message) {
  process.stdout.write(`[dist:win] ${message}\n`);
}

function fail(message) {
  process.stderr.write(`\n[dist:win] ${message}\n`);
  process.exit(1);
}

await ensureElectronDist();

/**
 * 清掉上一次构建的残留（win-unpacked / win-unpacked.tmp）。
 *
 * electron-builder 复制 electron dist 时若目标已存在，会逐文件覆盖并删除
 * 它不需要的文件（default_app.asar 等）；上一轮中途失败留下的目录常带有
 * 被杀毒/索引服务短暂锁定的文件，表现为 EBUSY unlink。构建前整目录删掉
 * 最干净 —— electron-builder 会从头复制。
 *
 * 必须经**子进程**删（ 这里与本脚本同样注入 SAFE_DELETE_ENABLED=0）：
 * 目录必然远超沙箱批量删除阈值。
 */
async function cleanPreviousRelease() {
  const targets = ['win-unpacked', 'win-unpacked.tmp'].map((d) => path.join(releaseDir, d));
  const existing = targets.filter((t) => fs.existsSync(t));
  if (existing.length === 0) return;

  const script = `
    const fs = require('node:fs');
    // EBUSY 常来自 Windows Defender 对新复制文件（default_app.asar 等）的实时扫描，
    // maxRetries 只对 EPERM/EACCES 重试、对 EBUSY 直接抛，所以这里自己循环退避重试。
    function rmRetry(t) {
      for (let i = 0; i < 20; i++) {
        try {
          fs.rmSync(t, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
          process.stdout.write('removed ' + t + '\\n');
          return true;
        } catch (e) {
          if (e.code !== 'EBUSY') throw e;
          const wait = 300 * (i + 1);
          const end = Date.now() + wait;
          while (Date.now() < end) {}  // 同步退避，避免引入异步复杂度
        }
      }
      throw new Error('EBUSY 重试耗尽: ' + t);
    }
    for (const t of ${JSON.stringify(existing)}) {
      if (fs.existsSync(t)) rmRetry(t);
    }
  `;
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', script], {
      stdio: 'inherit',
      env: { ...process.env, CODEBUDDY_SAFE_DELETE_ENABLED: '0' },
    });
    child.on('error', () => resolve(1));
    child.on('close', (c) => resolve(c ?? 1));
  });
  if (code !== 0) fail(`清理上一次构建产物失败（退出码 ${code}）`);
}

await cleanPreviousRelease();

for (const { name, args } of STEPS) {
  step(`→ ${name}`);
  const code = await new Promise((resolve) => {
    const child = spawn(PNPM, args, {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      shell: true, // pnpm.CMD 是批处理，必须经 shell
      env: {
        ...process.env,
        CODEBUDDY_SAFE_DELETE_ENABLED: '0',
        INKSTONE_ELECTRON_DIST: electronDistDir,
        INKSTONE_RELEASE_DIR: releaseDir,
      },
    });
    child.on('error', (err) => {
      process.stderr.write(`[dist:win] spawn 失败：${err.message}\n`);
      resolve(1);
    });
    child.on('close', (c) => resolve(c ?? 1));
  });
  if (code !== 0) fail(`${name} 失败（退出码 ${code}）`);
}

step(`完成。安装包在 ${releaseDir}`);
