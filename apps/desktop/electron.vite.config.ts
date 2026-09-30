import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import type { Plugin } from 'vite';

/**
 * 共享包以 TS 源码形式被消费（package.json 的 exports 指向 src/index.ts）。
 * 因此必须把它从 externalize 中排除，否则主进程/预加载会把它当外部 CJS 依赖 require，
 * 运行时直接找不到模块。
 *
 * ## 这条 `exclude` 是个**必须维持的不变量**（`docs/13` M30）
 *
 * `externalizeDepsPlugin` 把 `package.json` 的 `dependencies` 一律当外部依赖，
 * 而打包产物只含 `out` 目录与 `package.json`（**不含 `node_modules`**）——
 * 所以任何被 externalize 却没被内联的裸模块，装到用户机器上就是 `MODULE_NOT_FOUND`。
 * 往主进程/预加载引入新的 workspace 包时，**必须同时**加进这里的 `exclude`。
 * 忘加的后果由 `test/packaging.test.ts` 在提交前拦下（它会扫主进程/预加载的裸说明符）。
 */
const SHARED = resolve(__dirname, '../../packages/shared/src/index.ts');
const MD_ADAPTER = resolve(__dirname, '../../packages/md-adapter/src/index.ts');

/**
 * 渲染进程 CSP（docs/10 §6.2，步骤 06 的遗留）。
 *
 * ## 为什么只能在这里做
 *
 * 生产页面走 `file://`，没有 HTTP 响应头可改，主进程的 `webRequest.onHeadersReceived`
 * 对 file 协议不触发 —— `file://` 下唯一能声明 CSP 的地方是 `<meta http-equiv>`。
 *
 * ## 为什么 dev 不注入
 *
 * Vite 的 HMR 需要内联脚本与 ws 连接，把生产那份严格策略也用在 dev 会先把开发环境弄坏
 * （症状是"改了代码页面不刷新"，很容易被误判成 Vite 的问题）。所以只在 `ctx.server`
 * 缺失（即 `vite build`，非 dev server）时注入。
 */
function cspPlugin(): Plugin {
  return {
    name: 'inkstone:csp',
    transformIndexHtml: {
      order: 'post',
      handler: (html, ctx) =>
        ctx.server ? html : html.replace('<head>', `<head>\n    ${CSP_META}`),
    },
  };
}

/**
 * 策略起始稿（docs/10 §6.2，必须实测调整）。
 *
 * 白名单式收口：没显式放行的都不许。`connect-src http://127.0.0.1:*` 是渲染进程直连
 * sidecar 的唯一出口，端口每次启动自选（`bind 127.0.0.1:0`），写死端口第二次启动就断连。
 * 主题与字号走 JS CSSOM 写到 `<html>`，不受 `style-src` 约束，故不给 `'unsafe-inline'`。
 */
const CSP_META =
  `<meta http-equiv="Content-Security-Policy" content="` +
  `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; ` +
  `font-src 'self'; connect-src http://127.0.0.1:*` +
  `" />`;

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@inkstone/shared'] })],
    resolve: { alias: { '@inkstone/shared': SHARED } },
    build: {
      sourcemap: true,
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['@inkstone/shared'] })],
    resolve: { alias: { '@inkstone/shared': SHARED } },
    build: {
      sourcemap: true,
    },
  },
  renderer: {
    plugins: [react(), cspPlugin()],
    resolve: {
      alias: {
        '@inkstone/shared': SHARED,
        // 适配层只在渲染进程用；它自身依赖 @inkstone/shared 与 prosemirror-model，
        // 前者由上面这条 alias 兜住，后者走 node_modules 正常解析。
        '@inkstone/md-adapter': MD_ADAPTER,
        '@': resolve(__dirname, 'src/renderer/src'),
      },
    },
  },
});
