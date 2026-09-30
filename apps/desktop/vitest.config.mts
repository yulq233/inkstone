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
    /**
     * 只放行 `global.css` 走正常的 Vite 管线。
     *
     * Vitest 默认会把**所有** CSS 请求的模块内容替换成 `''`，判定正则是
     * `/\.(css|…)(?:$|\?)/` —— `global.css?raw` 也落在里面。于是
     * `test/settings.test.ts` 里那条"`WINDOW_BG` 必须与 `global.css` 的 `--bg` 同值"
     * 拿到空串，断言永远失败（**失败信息是 `expected '' to contain`，看着像路径写错了**）。
     *
     * 放行之后 Vite 自己的 `vite:css` 会跳过带 `raw` 查询串的请求，`?raw` 拿到的就是
     * 文件原文。**刻意不写 `css: true`** 全量放行：实测那会让这个包的测试从 ~1.4s
     * 涨到 ~7s（每个模块都要过 CSS 插件链），而这里只需要一个文件。
     */
    css: { include: [/global\.css/] },
  },
});
