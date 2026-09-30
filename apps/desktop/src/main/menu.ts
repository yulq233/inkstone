/**
 * 应用菜单（`09` §4）。
 *
 * ## 两条边界
 *
 * **1）主进程不碰业务状态。** 新建/打开/关闭作品、撤销重做这类动作，菜单只发一条命令
 * 给渲染进程，由它执行（`02` §2.2 的边界）。主进程自己只做两件事：改**设置**（主题、字号
 * ——那是主进程的存储）、以及打开系统资源（日志目录、关于对话框）。
 *
 * **2）主题与字号走设置，不走命令。** 它们已经是 `settings.json` 的一部分，改完广播
 * `settings:changed` 即可。同一件事若既发命令又改设置，就会出现两个真源 ——
 * "设置里写着深色、界面却是浅色"这类不一致极难复现。
 *
 * ## 菜单栏是常显的
 *
 * `window.ts` 原来是 `autoHideMenuBar: true`（刻意隐藏）。这里改成常显（§4.1）：
 * Windows 桌面应用的菜单栏常显符合预期，而且 M0 的功能入口本来就少，
 * 藏在 Alt 后面等于没有。快捷键仍然可用，菜单只是把它们的**可见性**补上。
 */

import fs from 'node:fs';
import {
  Menu,
  app,
  dialog,
  shell,
  type BrowserWindow,
  type MenuItemConstructorOptions,
} from 'electron';
import {
  FONT_SIZE,
  THEME_MODES,
  THEME_MODE_LABEL,
  clampFontSize,
  type AppCommand,
  type Settings,
  type ThemeMode,
} from '@inkstone/shared';
import { logsDirPath } from './paths';
import { settingsFilePath, updateSettings } from './store/settings';

export interface MenuDeps {
  getWindow: () => BrowserWindow | null;
  getSettings: () => Settings;
  /** 发命令给渲染进程。窗口不在（还没建好 / 已销毁）时静默丢弃 */
  sendCommand: (command: AppCommand) => void;
}

/** 关于对话框里的版本信息。独立成函数是为了别把 `app.getVersion()` 写进模板字面量里。 */
function aboutDetail(): string {
  return [
    `版本 ${app.getVersion()}`,
    `设置文件：${settingsFilePath()}`,
    '',
    '本地优先的中文小说创作工作台',
  ].join('\n');
}

/**
 * 菜单动作的留痕。
 *
 * 白屏那次"点菜单没有任何反应"完全无法定位：分不清是**点击没送进主进程**
 * （主进程卡住 / 窗口被模态对话框挡住），还是**送到了但看不出效果**
 * （命令投给了一个已经卸载的渲染进程 —— 那正是"界面死了、菜单还活着"的样子）。
 * 每个自己实现的 `click` 进来先留一行，这两者立刻可辨。
 *
 * 局限：`role` 那几项（剪切 / 复制 / 粘贴 / 全选 / 退出 / 全屏 / 重新加载 / 开发者工具）
 * 由 Electron 内部派发，**没有回调可挂** —— 它们有没有响应只能靠副作用判断。
 */
function trace(label: string): void {
  process.stderr.write(`[menu] ${label}\n`);
}

function themeSubmenu(deps: MenuDeps): MenuItemConstructorOptions[] {
  const current = deps.getSettings().theme.mode;
  return THEME_MODES.map((mode: ThemeMode) => ({
    label: THEME_MODE_LABEL[mode],
    type: 'radio' as const,
    checked: current === mode,
    click: () => {
      trace(`视图 → 主题 → ${THEME_MODE_LABEL[mode]}`);
      // 改设置 → 订阅者广播 `settings:changed` 并重建菜单（勾选态跟着动）。
      // 这里刻意**不**直接调 `deps.sendCommand`：见文件头「两条边界」。
      updateSettings({ theme: { mode } });
    },
  }));
}

function buildTemplate(deps: MenuDeps): MenuItemConstructorOptions[] {
  const dev = !app.isPackaged;
  const settings = deps.getSettings();

  return [
    {
      label: '文件',
      submenu: [
        {
          label: '新建作品',
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            trace('文件 → 新建作品');
            deps.sendCommand('work:new');
          },
        },
        {
          label: '打开作品…',
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            trace('文件 → 打开作品…');
            deps.sendCommand('work:open');
          },
        },
        { type: 'separator' },
        // 刻意不给快捷键：Ctrl+W 在桌面应用里普遍是"关窗口"，与"关作品"混淆的代价
        // 是用户以为退出了应用、其实还在作品入口页。
        {
          label: '关闭作品',
          click: () => {
            trace('文件 → 关闭作品');
            deps.sendCommand('work:close');
          },
        },
        { type: 'separator' },
        { label: '退出', role: 'quit' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        /**
         * ## 为什么不用 `role: 'undo'`，也**不给快捷键**
         *
         * `role: 'undo'` 会自带 `CmdOrCtrl+Z` 这个 accelerator，并最终调用
         * `webContents.undo()` —— Chromium 的原生编辑撤销栈。而正文的撤销栈由
         * `prosemirror-history` 自己维护，两者不是一套东西。原生撤销可能绕过插件改 DOM，
         * 被 ProseMirror 的 DOM observer 当成"外部变更"接住 —— 轻则撤销跳回很久以前，
         * 重则文档状态错乱，而**状态错乱意味着存盘存进去一堆乱结构**（`09` §4.3）。
         *
         * §4.3 给的是"先按 role 实现再实测"的两步策略。这里直接走第二步（保险方案），
         * 理由：role 的语义**只能在真窗口里手工验**，而这条路径一旦错了代价是文档损坏。
         * 直接转发给编辑器自己执行，行为与编辑器内 Ctrl+Z 完全一致，且可证。
         *
         * 至于 accelerator：一旦把 `CmdOrCtrl+Z` 注册成菜单快捷键，键盘那条路就会被
         * 菜单劫持（Electron 的 accelerator 先于页面 keydown）。那样在**普通输入框**里
         * （比如新建作品表单）按 Ctrl+Z 会被转发给编辑器，输入框自己的撤销就没了。
         * 所以这里**不注册快捷键**，键盘路径完全留给 ProseMirror 的 keymap（本来就是对的），
         * 菜单项只承担"让这个功能可见、可点"的职责。
         */
        {
          label: '撤销',
          click: () => {
            trace('编辑 → 撤销');
            deps.sendCommand('editor:undo');
          },
        },
        {
          label: '重做',
          click: () => {
            trace('编辑 → 重做');
            deps.sendCommand('editor:redo');
          },
        },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '全选', role: 'selectAll' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '主题', submenu: themeSubmenu(deps) },
        {
          label: '设置…',
          click: () => {
            trace('视图 → 设置…');
            deps.sendCommand('settings:openPanel');
          },
        },
        { type: 'separator' },
        {
          label: '放大字号',
          accelerator: 'CmdOrCtrl+=',
          click: () => {
            trace('视图 → 放大字号');
            updateSettings({
              theme: { fontSize: clampFontSize(settings.theme.fontSize + FONT_SIZE.step) },
            });
          },
        },
        {
          label: '缩小字号',
          accelerator: 'CmdOrCtrl+-',
          click: () => {
            trace('视图 → 缩小字号');
            updateSettings({
              theme: { fontSize: clampFontSize(settings.theme.fontSize - FONT_SIZE.step) },
            });
          },
        },
        {
          label: '重置字号',
          accelerator: 'CmdOrCtrl+0',
          click: () => {
            trace('视图 → 重置字号');
            updateSettings({ theme: { fontSize: FONT_SIZE.fallback } });
          },
        },
        { type: 'separator' },
        // 开发态才出现的两项：放进生产包只会让用户误点，然后以为应用坏了
        ...(dev
          ? ([
              { label: '重新加载', role: 'reload' },
              { label: '开发者工具', role: 'toggleDevTools' },
              { type: 'separator' },
            ] satisfies MenuItemConstructorOptions[])
          : []),
        { label: '全屏', role: 'togglefullscreen' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于砚台',
          click: () => {
            trace('帮助 → 关于砚台');
            const win = deps.getWindow();
            const options = {
              type: 'info' as const,
              title: '关于砚台',
              message: '砚台',
              detail: aboutDetail(),
              buttons: ['好'],
              noLink: true,
            };
            void (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options));
          },
        },
        {
          // 排查问题时最常用的一项：`settings.json` 在上一层，日志本身在这一层
          label: '打开日志目录',
          click: () => {
            trace('帮助 → 打开日志目录');
            // 先建再开：尚未拉起过 sidecar 时 `logs/` 可能不存在，
            // 而 `openPath` 对不存在的路径只返回一段错误字符串、界面毫无反应。
            const dir = logsDirPath();
            fs.mkdirSync(dir, { recursive: true });
            void shell.openPath(dir);
          },
        },
      ],
    },
  ];
}

/**
 * 装菜单。主题切换后要**重新调用一次** —— 勾选态是菜单项的静态属性，
 * `Menu.getApplicationMenu()` 改起来比重建更容易出错，而菜单很小，重建成本可忽略（§4.4）。
 */
export function installAppMenu(deps: MenuDeps): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildTemplate(deps)));
}
