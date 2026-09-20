import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * 测试专用的 Vite 配置。
 *
 * 单独一份而不是复用 `electron.vite.config.ts`：那份是 electron-vite 的格式，
 * vitest 不认。别名必须与 electron.vite.config.ts 保持一致 —— 否则会出现
 * "构建能过、测试报找不到模块"这种只浪费时间的差异。
 *
 * 环境用 node 而不是 jsdom：被测的是自动保存状态机与扩展集一致性，
 * 两者都不碰 DOM。真需要点 DOM 的时候（组件测试）再单独加环境。
 */
// `.mts` 而不是 `.ts`：这个包没有 `"type": "module"`，`.ts` 配置会被当 CJS 加载，
// Vite 会为"在 CJS 里写 ESM 语法"发警告。用 `.mts` 明示 ESM，`import.meta.dirname` 才可用。
const here = import.meta.dirname;

export default defineConfig({
  resolve: {
    alias: {
      '@inkstone/shared': resolve(here, '../../packages/shared/src/index.ts'),
      '@inkstone/md-adapter': resolve(here, '../../packages/md-adapter/src/index.ts'),
      '@': resolve(here, 'src/renderer/src'),
    },
  },
  test: {
    dir: 'test',
    environment: 'node',
    include: ['**/*.test.ts'],
  },
});
