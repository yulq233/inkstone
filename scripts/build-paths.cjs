/**
 * 构建期路径真源（`docs/10` §4）。
 *
 * 谁在用：
 *   - `scripts/dist-win.mjs` —— 把 electron 解压到这里、安装包也输出到这里
 *   - `apps/desktop/electron-builder.config.cjs` —— `electronDist` / `directories.output`
 *
 * ## 为什么要单独一个文件
 *
 * 这三个路径原先在 `dist-win.mjs` 与 `electron-builder.yml` 里**各写一份**，靠注释
 * 提醒"改一处要同步另一处"（`docs/13` M24）。真实后果有两层：
 *   1. yml 那份是**硬编码用户名**的绝对路径 —— 换台机器、换个用户名就不成立；
 *   2. `dist-win.mjs` 注入的 `INKSTONE_ELECTRON_DIST` 因此成了**没人读的死变量**，
 *      看着像"已经参数化了"，其实没有。
 * 现在两侧共读本文件，公式只剩一份，且**没有用户名**。
 *
 * ## 为什么用 .cjs 而不是 .mjs
 *
 * electron-builder 的配置文件是 CJS（`require` 加载），它 require 不了 .mjs。
 * 而 ESM 的 `dist-win.mjs` 可以正常 `import` CJS（default 即 module.exports）。
 *
 * ## 为什么放用户目录（工作区外）而不是仓库 `.build/`
 *
 * WorkBuddy 对工作区内的 `*.asar` 有**延迟锁定**：文件落地几十秒后被某常驻服务
 * 锁住（EBUSY unlink，重试无效，实测 electron 自带的 default_app.asar 必中招）。
 * 用户目录不在监控范围，无此问题。同一理由见 `docs/10` §5。
 */

const os = require('node:os');
const path = require('node:path');

/**
 * 构建产物根目录。`INKSTONE_BUILD_ROOT` 可覆盖（CI、或想换盘时用）。
 *
 * `os.homedir()` 是 `USERPROFILE`/`HOME` 都没设时的兜底 —— Windows 上正常不会走到，
 * 但没有它的话一个空串会让路径变成相对的 `.inkstone-build`，反而落进工作区。
 */
const buildRoot =
  process.env.INKSTONE_BUILD_ROOT ??
  path.join(process.env.USERPROFILE ?? process.env.HOME ?? os.homedir(), '.inkstone-build');

/** **已解压**的 electron dist（不是 zip）。electron-builder 的 `electronDist` 指这里。 */
const electronDistDir = path.join(buildRoot, 'electron-dist');

/** electron-builder 的输出目录 —— `win-unpacked/` 与 `inkstone-<版本>-setup.exe` 都在这里。 */
const releaseDir = path.join(buildRoot, 'release');

module.exports = { buildRoot, electronDistDir, releaseDir };
