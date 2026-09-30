/**
 * 打包依赖守卫（`docs/13` M30）。
 *
 * ## 要防的是什么
 *
 * 产物只打包 `out/**` 与 `package.json`（`electron-builder.cjs` 的 `files`），
 * **不含 `node_modules`**。所以主进程/预加载里任何"没被打进 bundle、留成运行时 require"
 * 的裸模块说明符，装到用户机器上就是 `MODULE_NOT_FOUND` —— 而且**只有打包后才暴露**，
 * `pnpm dev` / `pnpm test` 全是绿的。
 *
 * 哪些会被留成运行时 require？`electron.vite.config.ts` 对 main/preload 用了
 * `externalizeDepsPlugin`，它把 `package.json` 的 `dependencies` 一律视为外部依赖。
 * 也就是说：往里加一个依赖（哪怕它只给渲染进程用），某天主进程 import 了它，
 * 就踩雷。这个守卫把"某天"提前成"提交前"。
 *
 * ## 为什么不做成"检查产物"
 *
 * 那需要先 `pnpm build`，而单测不该依赖构建产物（慢、且 CI 顺序敏感）。
 * 源码级的说明符检查是**确定性**的，覆盖的也正是同一个不变量。
 *
 * ## 允许清单为什么这么短
 *
 * - `electron`：运行时由 Electron 自己提供，本来就不该打包；
 * - `node:*`：Node 内建，Electron 里直接可用；
 * - `@inkstone/shared`：被 alias 到源码 + 在 `externalizeDepsPlugin` 的 `exclude` 里，
 *   所以是**内联打包**的；
 * - 相对路径：一定是源码，内联打包。
 *
 * 其余一律挡下。真需要往主进程引入某个依赖时，改两处即可通过本守卫：
 * 把它加进 `electron.vite.config.ts` 的 `exclude`（让它内联），再加进下面的允许集
 * —— 两处都改，等于强迫作者确认"它确实会被打进 bundle"。
 */
import { describe, expect, it } from 'vitest';

const MAIN_SOURCES = import.meta.glob('../src/main/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const PRELOAD_SOURCES = import.meta.glob('../src/preload/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** 允许出现在主进程/预加载里的**裸**模块说明符。 */
const ALLOWED_BARE_SPECIFIERS = new Set(['electron', '@inkstone/shared']);

/** 三种引入写法，`import type` / `export ... from` 也都被 `from` 那条覆盖。 */
const SPECIFIER_PATTERNS = [
  /\bfrom\s+['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]/g,
];

function specifiersIn(source: string): string[] {
  const found = new Set<string>();
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      found.add(match[1]);
    }
  }
  return [...found];
}

function isAllowed(specifier: string): boolean {
  if (specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/')) {
    return true; // 相对/绝对路径 = 源码，必然内联
  }
  if (specifier.startsWith('node:')) {
    return true; // Node 内建
  }
  return ALLOWED_BARE_SPECIFIERS.has(specifier);
}

describe('主进程与预加载的外部依赖', () => {
  it('glob 真的扫到了源文件（否则下面两条会变成空断言）', () => {
    // 这条不是凑数：`import.meta.glob` 的路径写错时**不会报错**，只会匹配到零个文件，
    // 于是"检查所有来源"变成"检查零个来源"而永远绿。先把它钉住。
    expect(Object.keys(MAIN_SOURCES).length).toBeGreaterThan(0);
    expect(Object.keys(PRELOAD_SOURCES).length).toBeGreaterThan(0);
  });

  it('只允许 electron / node 内建 / @inkstone/shared / 相对路径', () => {
    const offenders: string[] = [];
    for (const [file, source] of Object.entries({
      ...MAIN_SOURCES,
      ...PRELOAD_SOURCES,
    })) {
      for (const specifier of specifiersIn(source)) {
        if (!isAllowed(specifier)) {
          offenders.push(`${file} → ${specifier}`);
        }
      }
    }

    expect(
      offenders,
      '主进程/预加载引用了不会被内联打包的裸模块。产物不含 node_modules，' +
        '装到用户机器上会 MODULE_NOT_FOUND（只有打包后才暴露）。' +
        '要么把它加进 electron.vite.config.ts 的 externalizeDepsPlugin exclude ' +
        '并同步本文件的允许清单，要么改成相对路径引入。',
    ).toEqual([]);
  });
});
