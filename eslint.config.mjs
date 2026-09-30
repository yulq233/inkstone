/**
 * 砚台 · ESLint flat config（`docs/08` §4）
 *
 * ## 分工
 *
 * **格式一律交给 Prettier，ESLint 不碰格式** —— 所以本文件里没有任何缩进 / 引号 /
 * 换行类规则，最后一层 `eslint-config-prettier` 负责关掉冲突项。
 *
 * ## 规则分级原则
 *
 * | 级别 | 用在哪 |
 * |---|---|
 * | `error` | 能导致**数据丢失或静默错误**的（`no-floating-promises`、`no-restricted-imports`） |
 * | `warn` | 风格与可读性（未使用变量等） |
 * | 关掉 | 在 TS 下冗余的（`no-undef` —— TS 编译器已经管了） |
 *
 * ## 两条值得单独说明的规则
 *
 * 1. **`no-floating-promises`**（来自 typescript-eslint 的类型感知规则集）。
 *    它是这一步存在的**主要理由**：`docs/06` §6.5 的切章时序里"忘了 `await flush()`"
 *    是一个语法上完全合法、跑起来也不报错、只是**偶尔丢字**的错误 ——
 *    正是 lint 该抓、而编译器抓不到的那类问题。
 * 2. **`no-restricted-imports`**（禁止绕过 md-adapter）。`02` 文档 §2.1 的硬要求：
 *    正文读写只能经过 `@inkstone/md-adapter`。它用 ESLint 内置规则实现，
 *    **不依赖类型信息** —— 所以即使 typescript-eslint 将来在 TS 大版本上跑不动，
 *    走退路时这一条仍然保得住。
 *
 * ## ⚠️ 两个 TypeScript 并存（改动本文件或依赖前必读）
 *
 * typescript-eslint 8.70 **明确拒绝** TS 7：一启动就抛
 * `typescript-eslint does not support TS 7.0.` 并以 exit 2 退出（**报错很响，
 * 不是静默降级** —— 这点值得记下，因为本步骤前前后后踩到的坑大多是静默的）。
 *
 * 按 TypeScript 7.0 发布说明给的并存方案，仓库里保留两个 TS：
 *
 * | 位置 | 版本 | 谁用 |
 * |---|---|---|
 * | 根 `node_modules/typescript` | 6.0.3（`~6.0.3`，见根 package.json） | typescript-eslint / 本文件 |
 * | 三个包各自的 `node_modules/typescript` | 7.0.2 | `pnpm typecheck` 的 `tsc` |
 *
 * 项目的编译版本**没有被降级**（已实测：三个包的 `.bin/tsc` 都指向自己那份 7.0.2）。
 * 代价是：根目录若有人直接跑 `tsc`，用的是 6.0.3 —— 但根目录没有 tsconfig，跑不起来。
 */

import js from '@eslint/js';
import globals from 'globals';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';
import { fileURLToPath } from 'node:url';

const tsconfigRootDir = fileURLToPath(new URL('.', import.meta.url));

const TS_FILES = ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'];
const JS_FILES = ['**/*.js', '**/*.mjs', '**/*.cjs'];

/** 未使用变量：`_` 前缀豁免（对齐 Python 侧 ruff 的惯例，两侧读起来一致）。 */
const UNUSED_VARS = ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/out/**',
      '**/dist/**',
      '**/release/**',
      '**/.venv/**',
      '**/__pycache__/**',
      '**/.pytmp/**',
      '**/.vite/**',
      '**/*.d.ts',
      // 构建产物里的 map 与声明文件
      '**/*.tsbuildinfo',
    ],
  },

  // ---- JS / MJS：不做类型感知 ----
  // scripts/ 与根配置是 Node 侧的一次性脚本，没有 tsconfig 覆盖它们；
  // 强行开类型感知会得到 "file not included in project"。
  {
    files: JS_FILES,
    extends: [js.configs.recommended],
    languageOptions: {
      globals: { ...globals.node },
      sourceType: 'module',
    },
    rules: {
      'no-unused-vars': UNUSED_VARS,
    },
  },

  // ---- TS / TSX：类型感知 ----
  {
    files: TS_FILES,
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        // ⚠️ 这里**不能**用 `projectService: true`。
        //
        // 项目服务只按文件名发现 `tsconfig.json`，而本仓库把配置拆开了：
        // apps/desktop 有 node / web 两份，`test/**` 只写在 **tsconfig.web.json** 里，
        // `vitest.config.mts` 只写在 **tsconfig.node.json** 里。项目服务顺着
        // `test/app-proxy.test.ts` 往上只找到 `apps/desktop/tsconfig.json`
        // （它的 include 是 `src/**` + 一个配置文件），于是把 12 个文件全判成
        // "was not found by the project service" 的解析错误 —— 一次 12 条 fatal，
        // 看着像代码坏了，其实是配置没被找到。
        //
        // 改成显式列全部 tsconfig：ESLint 会依次匹配，取第一个包含该文件的项目。
        project: [
          'apps/desktop/tsconfig.node.json',
          'apps/desktop/tsconfig.web.json',
          'packages/shared/tsconfig.json',
          'packages/md-adapter/tsconfig.json',
        ],
        tsconfigRootDir,
      },
    },
    rules: {
      // TS 编译器已经管了。开着只会对 DOM / Node 全局名误报。
      'no-undef': 'off',
      '@typescript-eslint/no-unused-vars': UNUSED_VARS,
    },
  },

  // ---- 渲染进程：React Hooks ----
  {
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,

      // 降级为 warn：这条规则建议"不要在 effect 里同步 setState"，
      // 理由是它多跑一轮渲染（性能）。但本仓库那几处都是
      // **"外部输入变了就把内部状态复位"** 的写法（换作品清空 notice、
      // sidecar 重建就丢弃探活结论……），是**有意的**；
      // 按规则的建议改成 key 重挂会连组件实例与滚动位置一起丢掉，代价更大。
      // 挂 warn 让它继续可见，但不拦 CI。
      'react-hooks/set-state-in-effect': 'warn',
    },
  },

  // ---- 渲染进程：禁止绕过 md-adapter（`02` §2.1）----
  {
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'],
    // 唯一豁免点：这个文件就是"把 schema 交给编辑器"的地方，天然要碰扩展包。
    ignores: ['apps/desktop/src/renderer/src/lib/editor-extensions.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'prosemirror-model',
              message: '正文读写必须经过 @inkstone/md-adapter，不要直接操作 ProseMirror。',
            },
            {
              name: '@tiptap/pm/model',
              message: '正文读写必须经过 @inkstone/md-adapter，不要直接操作 ProseMirror。',
            },
          ],
          patterns: [
            {
              group: ['**/md-adapter/src/*'],
              message: '从包名 @inkstone/md-adapter 导入，不要深入源码路径。',
            },
          ],
        },
      ],
    },
  },

  // ---- 测试文件：放宽「声明了 async 就必须 await」 ----
  //
  // `require-await` 的意图是抓"写了 async 却忘了 await"的 bug。但测试里真正大量存在的
  // 是**替身**：为了满足 `flush: () => Promise<boolean>`、`readChapter: () =>
  // Promise<ChapterContent>` 这类异步契约，最自然的写法就是 `async () => {…}`——
  // 另一种写法 `() => Promise.resolve(…)` 只是把噪音从规则挪进代码，并没有多出信息。
  //
  // 关键的覆盖面**没有**被牺牲：真正的"忘了 await"由 `no-floating-promises` 与
  // `await-thenable` 负责，这两条在测试文件里**照常开启**（都是 error）。
  {
    files: ['**/test/**/*.{ts,tsx}', '**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}'],
    rules: {
      '@typescript-eslint/require-await': 'off',
    },
  },

  // ---- 最后：关掉所有与 Prettier 冲突的格式规则 ----
  prettier,
);
