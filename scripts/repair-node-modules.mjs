#!/usr/bin/env node
/**
 * 删除 pnpm 中断安装留下的 staging 目录与**入口文件缺失**的包，让 `pnpm install` 重新解包。
 *
 * 为什么需要它：本机装依赖时偶尔会撞上沙箱对 pnpm store 的拒绝（os error 5），
 * pnpm 会留下一个 `<pkg>_pacquet-stage_<pid>_<时间戳>_0` 目录，而真实包目录里少一个
 * 入口文件（症状：`Cannot find module '.../dist/index.js'`，但包目录看起来是"在的"）。
 * 光看目录存在与否会误判成"装好了"。`scripts/scan-node-modules.mjs` 负责找出它们。
 *
 * 用法：
 *   node scripts/repair-node-modules.mjs          # 只删"入口文件缺失"的包与 staging 残留
 *   node scripts/repair-node-modules.mjs --dry    # 只看会删什么
 *   node scripts/repair-node-modules.mjs --all    # 删掉全部 node_modules（全新安装用）
 *
 * `--all` 存在的理由：本机 `pnpm install --force` 会在
 * "failed to remove existing directory ... prior to swap" 上失败（os error 5，
 * 每次卡在不同目录，疑似被 AV/索引器瞬时占用）。而**全新安装不需要 swap**
 * —— 目录本来就不存在。所以清空重装的路径比 --force 稳。
 *
 * 一律用 fs.rmSync 而不是 `Remove-Item -Recurse -Force`：本机 node_modules 里
 * 有大量 junction，PowerShell 5.1 会跟进链接导致命令卡住不返回（实测 >2min）。
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const NM = path.join(ROOT, 'node_modules');
const DRY = process.argv.includes('--dry');
const ALL = process.argv.includes('--all');

if (!fs.existsSync(NM)) {
  console.error('[repair] node_modules 不存在，先跑 pnpm install');
  process.exit(1);
}

if (ALL) {
  const targets = [
    'node_modules',
    'apps/desktop/node_modules',
    'packages/shared/node_modules',
    'packages/md-adapter/node_modules',
  ].map((p) => path.join(ROOT, p));

  for (const t of targets) {
    if (!fs.existsSync(t)) {
      console.log(`[repair] 跳过（不存在）${path.relative(ROOT, t)}`);
      continue;
    }
    console.log(`${DRY ? '[dry] 会删除' : '[repair] 删除'} ${path.relative(ROOT, t)}`);
    if (!DRY) fs.rmSync(t, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
  if (!DRY) console.log('\n[repair] 已清空，请接着跑：pnpm install（不要加 --force）');
  process.exit(0);
}

const targets = [];

// 1) pnpm 的 staging 残留（顶层与 @scope 下各扫一层）
for (const entry of fs.readdirSync(NM, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const full = path.join(NM, entry.name);
  if (entry.name.includes('_pacquet-stage_')) {
    targets.push(full);
    continue;
  }
  if (!entry.name.startsWith('@')) continue;
  for (const sub of fs.readdirSync(full, { withFileTypes: true })) {
    if (sub.isDirectory() && sub.name.includes('_pacquet-stage_')) {
      targets.push(path.join(full, sub.name));
    }
  }
}

/**
 * 解析一个"不带扩展名也可能成立"的入口声明。
 * `main: "index"` 与 `main: "./index"` 都要能命中 `index.js`，
 * 否则会把好包误判成坏包（第一版就误报了 `ms` / `@eslint-community/*`）。
 */
function entryExists(pkgDir, rel) {
  const base = path.resolve(pkgDir, rel);
  // 防越界：声明的入口必须落在包目录内
  if (!base.startsWith(path.resolve(pkgDir) + path.sep)) return true;
  if (fs.existsSync(base)) {
    const st = fs.statSync(base);
    if (st.isFile()) return true;
    // 指向目录时按 index 解析
    for (const name of ['index.js', 'index.cjs', 'index.mjs', 'index.json']) {
      if (fs.existsSync(path.join(base, name))) return true;
    }
    return false;
  }
  for (const ext of ['.js', '.cjs', '.mjs', '.json']) {
    if (fs.existsSync(base + ext)) return true;
  }
  return false;
}

/** 只把"看起来是文件路径"的值当作入口，跳过 browser 之类的条件键 */
function looksLikePath(value) {
  return typeof value === 'string' && /\.(js|cjs|mjs|json)$/.test(value);
}

/**
 * 收出一个包声明的**运行入口**。三条规则都来自实测，漏掉任何一条都会误报
 * —— 而误报会让这个脚本去删好好的包，比漏报危险得多：
 *
 * 1. **有 `exports` 就完全忽略 `main`** —— Node 就是这么做的。`@humanfs/core`
 *    的 `main` 写的是 `dist/index.js`（该版本没发布这个文件），但 `exports`
 *    指向 `./src/index.js`（存在），`import()` 实测可解析。只看 `main` 必误报。
 * 2. **`exports` 里没有 `"."` 键时，整个 `exports` 就是根入口** ——
 *    这是"条件糖"写法（`{"import": {...}}` 等价于 `{".": {"import": {...}}}`）。
 *    一开始只读 `exports['.']`，在 `@humanfs/core` 上拿到 `undefined`，
 *    于是 fallback 回 `main`，又误报了一次。
 * 3. **跳过 `types` 条件** —— 类型声明不是运行入口。
 */
function declaredEntries(json) {
  const ex = json.exports;

  if (typeof ex === 'string') return looksLikePath(ex) ? [ex] : [];

  if (ex && typeof ex === 'object') {
    const root = '.' in ex ? ex['.'] : ex;
    const found = [];
    const walk = (value) => {
      if (typeof value === 'string') {
        if (looksLikePath(value)) found.push(value);
        return;
      }
      if (value && typeof value === 'object') {
        for (const [key, sub] of Object.entries(value)) {
          if (key === 'types') continue;
          walk(sub);
        }
      }
    };
    walk(root);
    // 一条都没收出来（例如只有 types）说明没有可检查的运行入口，别当损坏
    return found;
  }

  return typeof json.main === 'string' ? [json.main] : [];
}

function packageDirs() {
  const dirs = [];
  for (const entry of fs.readdirSync(NM, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = path.join(NM, entry.name);
    if (entry.name.startsWith('@')) {
      for (const sub of fs.readdirSync(full, { withFileTypes: true })) {
        if (sub.isDirectory() && !sub.name.includes('_pacquet-stage_')) {
          dirs.push({ name: `${entry.name}/${sub.name}`, dir: path.join(full, sub.name) });
        }
      }
    } else {
      dirs.push({ name: entry.name, dir: full });
    }
  }
  return dirs;
}

for (const pkg of packageDirs()) {
  const manifest = path.join(pkg.dir, 'package.json');
  if (!fs.existsSync(manifest)) continue;
  let json;
  try {
    json = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  } catch {
    continue;
  }

  const declared = declaredEntries(json);

  if (declared.some((rel) => !entryExists(pkg.dir, rel))) targets.push(pkg.dir);
}

if (targets.length === 0) {
  console.log('[repair] 没有发现问题包');
  process.exit(0);
}

for (const t of targets) {
  console.log(`${DRY ? '[dry] 会删除' : '[repair] 删除'} ${path.relative(ROOT, t)}`);
  if (DRY) continue;
  fs.rmSync(t, { recursive: true, force: true, maxRetries: 5 });
}

if (!DRY) {
  console.log(`\n[repair] 已删除 ${targets.length} 处，请接着跑：pnpm install`);
}
