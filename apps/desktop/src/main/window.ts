import path from 'node:path';
import { app, BrowserWindow, nativeTheme, screen, shell } from 'electron';
import { MIN_WINDOW, WINDOW_BG } from '@inkstone/shared';
import { ensureOnScreen, isDarkTheme, normalizeWindowBounds } from './store/settings-io';
import { loadSettings } from './store/settings';
import { attachCloseGuard } from './quit-guard';
import { attachRendererDiagnostics } from './renderer-diagnostics';
import { attachWindowStatePersistence } from './window-state';
import { isExternalHttpUrl } from './url-guard';

/**
 * 渲染进程的加载来源由 electron-vite 注入：
 * 开发态给 ELECTRON_RENDERER_URL（Vite dev server），生产态走本地文件。
 */
export function createMainWindow(): BrowserWindow {
  const settings = loadSettings();

  /**
   * 窗口状态恢复。两个约束：
   *
   * 1. **必须在 `app.whenReady()` 之后** —— `screen` 模块在 ready 前调用会抛错
   *    （Windows 上表现为返回空数组）。本函数只从 `bootstrap()` 里调用，顺序天然满足；
   *    将来若有人把它挪到 ready 之前，越界检查会静默退化成"不做判断"。
   * 2. `x` / `y` 可能是 `undefined`（首次启动，或上一次判定为越界）——
   *    那时**不要**给个 0，让 BrowserWindow 走系统居中。
   */
  const workAreas = screen.getAllDisplays().map((display) => display.workArea);
  const saved = ensureOnScreen(normalizeWindowBounds(settings.window, MIN_WINDOW), workAreas);

  /**
   * 启动底色（§3.5）。原来是硬编码的 `#f7f6f3`，而 `global.css` 的 `--bg` 是 `#faf9f7`
   * —— 两个值不一样，于是浅色下也会有一次肉眼可辨的跳色，深色下更是一次明显的白光。
   * 现在两个值都取自 `WINDOW_BG`（与 `global.css` 互相注释指认）。
   *
   * `nativeTheme.shouldUseDarkColors` 只在 ready 之后可靠 —— 本函数满足。
   * 注意 `themeSource` 已由 `index.ts` 按设置设过，所以这里读到的就是"应用实际要用的"
   * 那个明暗，而不是操作系统的（用户选浅色时，两者可能不同）。
   */
  const dark = isDarkTheme(settings.theme.mode, nativeTheme.shouldUseDarkColors);

  const win = new BrowserWindow({
    x: saved.x,
    y: saved.y,
    width: saved.width,
    height: saved.height,
    minWidth: MIN_WINDOW.width,
    minHeight: MIN_WINDOW.height,
    show: false,
    title: '砚台',
    backgroundColor: dark ? WINDOW_BG.dark : WINDOW_BG.light,
    // 常显（§4.1）。原来是 true（刻意隐藏），本步骤改成常显：功能入口少，
    // 菜单是可发现性的主要来源，藏在 Alt 后面等于没有。
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      /**
       * 沙箱**暂不开**：安全清单项，实测受阻后回退。
       *
       * 从代码看它本可以开 —— preload 只用 `contextBridge` 与 `ipcRenderer`（沙箱下可用），
       * 其余 import 全是 `import type`、编译期即被擦除，不需要 Node 运行时。
       *
       * 但 2026-09-28 的对照实验里唯一的变量就是这一行：`true` 时主进程日志出现
       * `Render frame was disposed before WebFrameMain could be accessed`、窗口始终不出现
       * （`ready-to-show` 不触发）；改回 `false` 窗口立刻正常出现。详见 `docs/09` §11.13。
       *
       * 取舍：**未经验证的加固不如不加**。症状是"窗口不出现"，而日志只有一句含义模糊的
       * frame dispose，排查成本高于它挡掉的风险（渲染进程只加载自家页面，远程内容的口子
       * 已由 CSP 与 `will-navigate` 收掉）。复验方式：在**不加外层沙箱**的终端里把它改成
       * `true` 跑一次 `pnpm dev`，窗口正常出现即可恢复。
       *
       * ⚠️ 若哪天开启：沙箱 preload 的 `require` 只剩 `electron` / `events` / `timers` / `url`
       * 这组白名单，谁在 preload 里加 `node:fs` 之类会**静默失效**而不是编译报错。
       */
      sandbox: false,
    },
  });

  /**
   * 黑匣子要在**加载之前**挂上（`renderer-diagnostics.ts`）：
   * `did-fail-load` / `preload-error` 都发生在最开始，晚一行就漏掉它们，
   * 而那两个恰恰是"页面根本没起来"的唯一证据。
   */
  attachRendererDiagnostics(win);

  // 最大化要在 `show()` 之前恢复：窗口先以普通尺寸闪一帧再放大，观感像是"点错了"。
  if (settings.window.maximized) win.maximize();

  // 避免白屏闪烁：等首帧渲染完再显示
  win.once('ready-to-show', () => win.show());

  /**
   * 渲染进程的加载来源（electron-vite 注入）。**要在挂 `will-navigate` 之前算出来**，
   * 因为那个监听需要用白名单放行 dev server。
   *
   * ⚠️ `app.isPackaged` 这道门禁不能省（`docs/13` M12）：打包产物里这个环境变量
   * 依然读得到，于是"注入 `ELECTRON_RENDERER_URL=https://evil.example` 再启动"
   * 就能让窗口带着 preload 去加载一个远程页 —— `contextIsolation` 护着的那套 API
   * 等于交给了对方。只在开发态信任它，一行判断堵掉整条路。
   */
  const devUrl = app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL'];

  /**
   * 同窗口导航一律拦掉（安全清单项）。
   *
   * `setWindowOpenHandler` 只管 `window.open` / `target=_blank`，**管不到 `<a href>` 的普通跳转**。
   * 那种跳转会把应用窗口变成一个没有 preload 的外部页面 —— 没有地址栏、没有后退按钮，
   * 用户只能重启应用。当前正文的 md 白名单还造不出链接，但编辑器早晚要渲染链接
   * （批注定位、引用出处），所以现在就补上。
   *
   * dev 必须放行 Vite dev server：它的全量刷新走 `location.reload()`，也算"页面发起的导航"，
   * 一律拦会把 HMR 弄坏，而症状（改了代码页面不更新）很容易被误判成 Vite 的问题。
   */
  /**
   * 导航守卫 —— `will-navigate` 与 `will-redirect` **共用同一份逻辑**。
   *
   * 两个都要挂，因为它们拦的不是同一类跳转：`will-navigate` 只覆盖"页面自己发起的
   * 导航"，而**服务端 302 与 `<meta http-equiv="refresh">` 走的是 `will-redirect`**。
   * 只挂前者时，一个能控制响应头（或所在域的 CDN 被接管）的页面就能把应用窗口带走
   * （`docs/13` M13）。抽成具名函数而不是复制一段，是不给"只改一处"留机会。
   */
  const guardNavigation = (details: { readonly url: string; preventDefault: () => void }): void => {
    if (devUrl !== undefined && details.url.startsWith(devUrl)) return;

    /**
     * 页面自己 `location.reload()` —— URL 与当前**完全相同**。
     *
     * 必须放行，否则界面里崩溃兜底页的「重新加载界面」在生产态会被这里自己拦掉
     * （那时 URL 是 `file://`，既不在 dev 白名单里，也不该当外链外开）。
     *
     * 判**全等**而不是判同源，是有意的：`file://` 的 origin 是字符串 `"null"`，
     * 按同源放行等于放行任意本地文件 —— 拖一个 md 进窗口就能把应用窗口变成文件预览，
     * 而那正是这条监听要防的事。
     */
    if (details.url === win.webContents.getURL()) return;

    details.preventDefault();
    // 外链仍交给系统浏览器，与下面的 setWindowOpenHandler 同一个口径：
    // 应用窗口只承载自家界面，不做浏览器。
    if (isExternalHttpUrl(details.url)) void shell.openExternal(details.url).catch(() => {});
  };

  win.webContents.on('will-navigate', guardNavigation);
  win.webContents.on('will-redirect', guardNavigation);

  win.webContents.setWindowOpenHandler(({ url }) => {
    /**
     * **必须过同一道白名单**（与上面 `will-navigate` 的口径一致）。
     *
     * 原来这里是无条件 `shell.openExternal(url)` —— 而 `shell.openExternal` 在 Windows 上
     * 不止能开 http(s)：`file://`、UNC 路径（`\\host\share`，会带凭据去连）、
     * 以及 `ms-settings:` 这类自定义协议都会被转交给系统处理。
     *
     * 当前**还不可达**（md 白名单把链接降级成了纯文本），但这个洞是为"编辑器早晚要渲染链接"
     * 主动留的（见上面 `will-navigate` 的注释）—— 等到那时再补就晚了一步。
     *
     * `.catch` 不是装饰：`openExternal` 在系统没有默认浏览器/关联程序时会 reject，
     * 漏了它就是一条 unhandledRejection（`void` 只是让 lint 闭嘴，并不接住它）。
     */
    if (isExternalHttpUrl(url)) void shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  // 关窗拦截（06 文档 §7）：先请渲染进程把未落盘内容写完，再真正关闭。
  // 挂在这里而不是 bootstrap 里，是因为 macOS 的 `activate` 会再建一个窗口，
  // 挂在创建处才不漏。
  attachCloseGuard(win);

  // 尺寸/位置的采集（09 文档 §5.3）。关窗那一次的落盘在 quit-guard 的 destroyWindow 里。
  attachWindowStatePersistence(win);

  /**
   * `loadURL` / `loadFile` 都会 reject（dev server 没起来、index.html 缺失时最常见），
   * 而 `void` 只是让 lint 闭嘴、**并不接住它** —— 留一条 unhandledRejection
   * （`docs/13` M14）。这里至少让它以可读形式出现在日志里，而不是静默白屏。
   */
  const reportLoadFailure = (err: unknown): void => {
    process.stderr.write(`[inkstone] 渲染页面加载失败：${String(err)}\n`);
  };

  if (devUrl) {
    void win.loadURL(devUrl).catch(reportLoadFailure);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html')).catch(reportLoadFailure);
  }

  return win;
}
