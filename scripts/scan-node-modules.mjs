/**
 * 扫描 node_modules 里 pnpm 中断留下的 staging 目录与缺 dist 入口的包。
 * 只读，不改动任何东西。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const NM = path.join(ROOT, 'node_modules');

/** 只扫两层：node_modules/xxx 与 node_modules/@scope/xxx —— hoisted 布局下包都在这里 */
function packageDirs() {
  const dirs = [];
  for (const entry of fs.readdirSync(NM, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = path.join(NM, entry.name);
    if (entry.name.startsWith('@')) {
      for (const sub of fs.readdirSync(full, { withFileTypes: true })) {
        if (sub.isDirectory())
          dirs.push({ name: `${entry.name}/${sub.name}`, dir: path.join(full, sub.name) });
      }
    } else {
      dirs.push({ name: entry.name, dir: full });
    }
  }
  return dirs;
}

const all = packageDirs();
const staging = all.filter((p) => p.name.includes('_pacquet-stage_'));
const suspicious = [];

for (const pkg of all) {
  if (pkg.name.includes('_pacquet-stage_')) continue;
  const manifest = path.join(pkg.dir, 'package.json');
  if (!fs.existsSync(manifest)) {
    suspicious.push(`${pkg.name}: 无 package.json`);
    continue;
  }
  let json;
  try {
    json = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  } catch {
    suspicious.push(`${pkg.name}: package.json 解析失败`);
    continue;
  }
  // 只查显式声明了 main 的包：main 指向的文件必须存在
  const main = json.main;
  if (typeof main === 'string' && !main.includes('*') && !fs.existsSync(path.join(pkg.dir, main))) {
    suspicious.push(`${pkg.name}: main 缺失 -> ${main}`);
  }
  // exports["."].require/import 的第一个入口也查一下
  const dot = json.exports && json.exports['.'];
  if (dot && typeof dot === 'object') {
    for (const key of ['require', 'import', 'default']) {
      const target = dot[key];
      const first = typeof target === 'string' ? target : target && Object.values(target)[0];
      if (typeof first === 'string' && first.startsWith('./') && !first.includes('*')) {
        if (!fs.existsSync(path.join(pkg.dir, first)))
          suspicious.push(`${pkg.name}: exports["."].${key} 缺失 -> ${first}`);
      }
    }
  }
}

const out = [
  `包总数: ${all.length}`,
  '',
  `--- staging 残留 (${staging.length}) ---`,
  ...staging.map((s) => s.dir),
  '',
  `--- 入口缺失 / 异常 (${suspicious.length}) ---`,
  ...suspicious,
];
fs.writeFileSync(path.join(process.env.TEMP, 'inkstone-nm-scan.txt'), out.join('\n'), 'utf8');
console.log('scanned', all.length, 'staging', staging.length, 'suspicious', suspicious.length);
