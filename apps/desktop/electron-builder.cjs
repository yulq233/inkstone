/**
 * electron-builder 配置（`docs/10` §4.2）。
 *
 * ## 为什么是 .cjs 而不是 .yml
 *
 * `electronDist` 必须按环境算出来（见下），而 YAML **不支持** `${env.X}` 展开 ——
 * 它只对 `directories.output` 生效。原先只能硬编码 `C:/Users/40268/...`，换台机器
 * 换个用户名就不成立，`dist-win.mjs` 注入的 `INKSTONE_ELECTRON_DIST` 也没人读
 * （`docs/13` M24）。electron-builder 的 JS 配置可以直接 export 对象，路径现算。
 *
 * ⚠️ 两条**实测**出来的约束（不是从文档推的，别凭直觉改）：
 *
 * 1. **文件名只能是 `electron-builder.cjs`。** electron-builder 拿
 *    `configFilename`（固定为 `electron-builder`）+ 扩展名拼候选表，所以前缀不能改。
 *    叫 `electron-builder.config.cjs`（模仿 vite / vitest 那套命名）**不会被自动发现** ——
 *    实测只有显式 `--config` 指过去才读得到，裸跑 `electron-builder --win` 会静默
 *    回退到默认行为。
 * 2. **自动发现的候选顺序：`.yml` → `.yaml` → `.json` → `.json5` → `.toml` → `.js` →
 *    `.cjs` → `.ts`**（`app-builder-lib/out/util/config/load.js:54`）。yml 排在 cjs
 *    **前面** —— 实测把 yml 与本文件放一起时读到的仍是 yml，本文件被完全忽略。
 *    所以本文件取代 `electron-builder.yml` 的前提是**那个文件已经删掉**；同理，
 *    以后不要再往这里加 yml。`dist:win` 另外用 `--config` 显式钉住本文件，
 *    不依赖上面这个顺序。
 *
 * 三条不可动摇的约定：
 * 1. productName 用 ASCII「Inkstone」—— 安装目录与 userData 都是 ASCII，
 *    避开 PyInstaller bootloader / Python pathlib 在中文路径下的整类编码风险。
 *    用户能看到的中文（快捷方式、窗口标题）由 shortcutName 与应用内标题承担。
 * 2. deleteAppDataOnUninstall: false —— 卸载时删掉用户的作品是灾难。
 *    <userData> 与作品目录必须在卸载后原样保留。
 * 3. artifactName 用 ASCII —— 安装包文件名会被各种下载器/网盘处理，中文名易碎。
 *
 * extraResources 的三处对齐（改任何一处都要同步另两处，见 scripts/build-sidecar.mjs 头注）：
 *   1. build-sidecar.mjs 把 PyInstaller 产物放到 resources/sidecar/inkstone-sidecar/
 *   2. 这里把 resources/sidecar 整目录拷成 <安装目录>/resources/sidecar/
 *   3. env.ts 生产态从 process.resourcesPath/sidecar/inkstone-sidecar/ 拉 exe
 *
 * 注意 sidecar 必须走 extraResources（不能进 asar）：asar 内的可执行文件无法被 spawn。
 */

const fs = require('node:fs');
const path = require('node:path');

const { electronDistDir, releaseDir } = require('../../scripts/build-paths.cjs');

/**
 * 算出 electron-builder 该用哪份 electron。
 *
 * 优先 `INKSTONE_ELECTRON_DIST` —— `scripts/dist-win.mjs` 解压完 electron 后注入，
 * 与它解压的目录天然同一个。没设就走 `scripts/build-paths.cjs` 的默认公式，
 * 也就是"直接跑 `pnpm --filter @inkstone/desktop dist:win`、不经 dist-win.mjs"的情形。
 *
 * ## 为什么目录不存在要当场抛错
 *
 * 本机环境**目录 rename 被沙箱驱动整体禁止**（连两个文件的小目录都 EPERM，实测），
 * 而 electron-builder 自带的获取流程正是「下载 zip → 解压到 win-unpacked.tmp →
 * rename 成品」，必然失败。所以不能放它自己去下载：那只会得到一条 EPERM 栈，
 * 看不出该做什么。在这里说清楚，比让它在构建中途崩掉好。
 */
function resolveElectronDist() {
  const dist = process.env.INKSTONE_ELECTRON_DIST ?? electronDistDir;
  if (fs.existsSync(path.join(dist, 'electron.exe'))) {
    return dist;
  }
  throw new Error(
    [
      `electronDist 里没有 electron.exe：${dist}`,
      '',
      'electron 需要一份**已解压**的 dist（不是 zip）。两个办法：',
      '  1. 跑 `pnpm dist:win` —— 它会在构建前自动解压（推荐）',
      '  2. 手动把 electron-v<版本>-win32-x64.zip 解压到该目录，',
      '     或用 INKSTONE_ELECTRON_DIST=<别的目录> 指过去',
    ].join('\n'),
  );
}

module.exports = {
  appId: 'com.inkstone.app',
  productName: 'Inkstone',

  // 直接用本地已解压的 electron，跳过 electron-builder 的"下载 → 解压 → rename"
  // 链路（原因见上面 resolveElectronDist 的注释）。路径与 dist-win.mjs 同源：
  // 两侧都从 scripts/build-paths.cjs 取，不再有第二份需要手工同步的副本。
  electronDist: resolveElectronDist(),

  directories: {
    // 输出也在工作区外（用户目录）：electron-builder 在 win-unpacked 里生成 app.asar、
    // 复制 electron 自带的 asar，而 WorkBuddy 对工作区内 *.asar 有延迟锁定（EBUSY），
    // 留在工作区会让复制/删除随机失败。正常由 dist-win.mjs 经环境变量注入，
    // 直接跑 dist:win 时按 build-paths 回退到同一位置。
    output: process.env.INKSTONE_RELEASE_DIR ?? releaseDir,
    buildResources: 'resources',
  },

  // ⚠️ 这份 `files` **覆盖**了 electron-builder 的默认值，也就是说
  // `node_modules` 是**故意**不打包的：产物里只有 `out/**`（主进程/预加载/渲染进程
  // 三份已 bundle 的产物）与 `package.json`。
  //
  // 代价是一个必须维持的不变量：**主进程/预加载不得 require 任何未内联的裸模块**。
  // 一旦某天有人 import 了一个被 `externalizeDepsPlugin` 当外部依赖的包，
  // `pnpm dev` / `pnpm test` 全绿、只有装到用户机器上才 `MODULE_NOT_FOUND`。
  // 这条不变量由 `apps/desktop/test/packaging.test.ts` 钉住（`docs/13` M30）。
  files: ['out/**/*', 'package.json'],

  extraResources: [{ from: 'resources/sidecar', to: 'sidecar' }],

  win: {
    target: ['nsis'],
    icon: 'resources/icon.ico',
    // 不做代码签名（docs/10 §1.2）。不关这一项，electron-builder 仍会尝试下载
    // winCodeSign 二进制去"签名/编辑 exe"，在受限网络下 502 卡死整条构建。
    signAndEditExecutable: false,
  },

  nsis: {
    oneClick: true,
    perMachine: false,
    deleteAppDataOnUninstall: false,
    shortcutName: '砚台',
    artifactName: 'inkstone-${version}-setup.${ext}',
  },
};
