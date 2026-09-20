import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

/**
 * 共享包以 TS 源码形式被消费（package.json 的 exports 指向 src/index.ts）。
 * 因此必须把它从 externalize 中排除，否则主进程/预加载会把它当外部 CJS 依赖 require，
 * 运行时直接找不到模块。
 */
const SHARED = resolve(__dirname, '../../packages/shared/src/index.ts');
const MD_ADAPTER = resolve(__dirname, '../../packages/md-adapter/src/index.ts');

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
    plugins: [react()],
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
