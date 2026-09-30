import { app, BrowserWindow, dialog, nativeTheme } from 'electron';
import path from 'node:path';
import type { AppCommand, Settings, SidecarStatus } from '@inkstone/shared';
import {
  PROXY_BYPASS_LIST,
  PROXY_BYPASS_SWITCH,
  SidecarState,
  checkProxyBypassList,
} from '@inkstone/shared';
import { pushAiConfig } from './ai-config';
import { installCrashGuard } from './crash-guard';
import { registerIpc } from './ipc';
import { installAppMenu } from './menu';
import { logsDirPath } from './paths';
import { startMainHeartbeat } from './renderer-diagnostics';
import { SidecarSupervisor } from './sidecar/supervisor';
import { loadCredentialStore } from './store/credentials';
import { loadSettings, subscribeSettings } from './store/settings';
import { createMainWindow } from './window';

/**
 * ELECTRON_RUN_AS_NODE 会让 Electron 以纯 Node 模式启动：
 * `require('electron')` 退化成"二进制路径字符串"，`app` / `BrowserWindow` 全是 undefined，
 * 于是首个访问点就抛 `Cannot read properties of undefined (reading 'requestSingleInstanceLock')`
 * —— 报错信息和真实原因毫无关系，能查很久。
 *
 * 这里直接拦下来并说清怎么修，比让人去翻源码强。
 */
if (process.env.ELECTRON_RUN_AS_NODE) {
  process.stderr.write(
    [
      '',
      '  启动失败：检测到环境变量 ELECTRON_RUN_AS_NODE。',
      '',
      '  它会让 Electron 以纯 Node 模式运行，界面相关 API 全部不可用。',
      '  请先清除该变量再启动：',
      '',
      '    PowerShell:  Remove-Item Env:\\ELECTRON_RUN_AS_NODE',
      '    CMD:         set ELECTRON_RUN_AS_NODE=',
      '    bash:        unset ELECTRON_RUN_AS_NODE',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

/**
 * 允许在无 GPU 的环境里运行（CI、虚拟机、远程桌面、容器、部分受管环境）。
 *
 * 这类环境里 Chromium 的 GPU 进程会连着重启若干次然后直接 FATAL：
 *   GPU process exited unexpectedly: exit_code=1
 *   FATAL: ... GPU process isn't usable. Goodbye.
 * 表现是"启动即崩、窗口都不出现"，而日志看起来像是程序自己的 bug。
 *
 * 写作类应用对 GPU 合成没有刚需，所以提供一个显式开关；默认不动，
 * 避免在正常桌面上白白牺牲滚动平滑度。
 */
if (process.env.INKSTONE_DISABLE_GPU === '1') {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('disable-software-rasterizer');
  // 关键的一条：受限环境里 GPU **子进程**常常因权限起不来，然后 Chromium 反复重试
  // 并最终 FATAL。把 GPU 放进主进程就不再单独 fork，可绕开这个失败模式。
  app.commandLine.appendSwitch('in-process-gpu');
}

let supervisor: SidecarSupervisor | null = null;
let mainWindow: BrowserWindow | null = null;
/** 退出流程是否已经进入"停 sidecar"这一步（避免 `will-quit` 重复进入）。 */
let shutdownStarted = false;

/**
 * 渲染进程的 fetch 会被系统代理截走（见 packages/shared/src/proxy.ts），
 * 这里显式声明 loopback 例外。
 *
 * 必须在 `app.whenReady()` 之前：命令行开关在进程启动时就生效，没有窗口期。
 * 刻意不用 `session.setProxy` —— 它是异步的，且必须在窗口加载**之前**完成，
 * 否则第一次请求仍会走错路径，而它返回的 Promise 与窗口创建之间存在竞态。
 */
app.commandLine.appendSwitch(PROXY_BYPASS_SWITCH, PROXY_BYPASS_LIST);

/**
 * 显式钉死应用名与 userData 路径（`docs/10` §4.1）。
 *
 * `productName` 用 ASCII 的 `Inkstone` 而不是「砚台」，是为了让安装目录与 userData
 * 目录都是 ASCII —— PyInstaller 的 bootloader、sidecar 写日志/备份、Python 的
 * pathlib↔Windows API 编码往返，都会在中文路径下变得"平时没事、出问题难定位"。
 * 用户能看到的中文（快捷方式、窗口标题）不受影响。
 *
 * `setName` 让 userData 默认指向 `%APPDATA%\Inkstone`；再显式 `setPath` 一次是
 * 为了**开发态与生产态一致** —— 不设的话开发态会落在 `%APPDATA%\Electron`，
 * 排查问题时"日志到底在哪"会绕一圈。
 */
app.setName('Inkstone');
app.setPath('userData', path.join(app.getPath('appData'), 'Inkstone'));

/**
 * 进程级异常兜底（`docs/13` M14）。
 *
 * **必须在 `setPath('userData')` 之后**：崩溃日志要写进 `<userData>/logs`，
 * 早于上面那一行装上的话，日志会落到 `%APPDATA%\Electron` ——
 * 也就是"用户按提示去日志目录里找不到东西"。
 *
 * 装在这里而不是 `bootstrap()` 里：`bootstrap()` 之前还有模块级代码会跑
 * （代理开关、自检），那些地方抛的一样会带走整个进程。
 */
installCrashGuard(logsDirPath());

{
  const check = checkProxyBypassList();
  process.stderr.write(`[inkstone] ${PROXY_BYPASS_SWITCH} = ${PROXY_BYPASS_LIST}\n`);
  if (!check.ok) {
    process.stderr.write(`[inkstone] 代理绕过自检未通过：${check.problems.join('；')}\n`);
  }
}

function broadcastStatus(status: SidecarStatus): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('sidecar:onStatus', status);
  }
  // sidecar 每次就绪都要重推 AI 配置：凭据只存在它的**内存**里（`docs/11` §3.3），
  // 崩溃重启是它的正常自愈路径，而重启后那份内存是空的 ——
  // 不重推的话，症状是"用着用着开始报密钥缺失"，且只在重启之后出现。
  if (status.state === SidecarState.HEALTHY) pushAiConfigNow(true);
}

/** 上次推成功的 `ai` 段指纹。用来避免"改主题也顺手把密钥推一遍"。 */
let pushedAiFingerprint: string | null = null;

/**
 * 把 AI 配置（含明文凭据）推给 sidecar。
 *
 * `force` 的两种取值对应两类触发，不能合并：
 * - `true`（sidecar 就绪）：必须推，因为对面的内存空了；
 * - `false`（设置变更）：只有 `ai` 段真的变了才推。`updateSettings` 每次都会造一个新的
 *   `ai` 对象（对象身份不可比），所以这里比的是**序列化结果**；
 *   而如果每次改主题都推一遍，就等于每次切主题都把明文 Key 再走一遍网络。
 *
 * 刻意不 `await`：这是旁路动作（启动流程、设置广播都不该等它），
 * 失败由 `pushAiConfig` 自己写日志，指纹清空让下一次变更再试。
 *
 * `.catch` 不是装饰（`docs/13` M14）：`pushAiConfig` 内部虽然自己吞了传输层异常，
 * 但 `buildAiConfigBody` 在 `try` 之外 —— 设置坏了它就会抛出来，
 * 而这条链是 `void` 起的，没人接。
 */
function pushAiConfigNow(force: boolean): void {
  if (!supervisor) return;

  const settings = loadSettings();
  const fingerprint = JSON.stringify(settings.ai);
  if (!force && fingerprint === pushedAiFingerprint) return;

  void pushAiConfig(supervisor, { settings, credentials: loadCredentialStore() })
    .then((outcome) => {
      pushedAiFingerprint = outcome.ok ? fingerprint : null;
    })
    .catch((err: unknown) => {
      pushedAiFingerprint = null;
      process.stderr.write(`[inkstone] 推送 AI 配置时异常：${String(err)}\n`);
    });
}

/** 设置变更广播（`09` §3.6）。渲染进程据此应用主题与字号 —— 单窗口下也只是留个通道。 */
function broadcastSettings(settings: Settings): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('settings:changed', settings);
  }
}

/**
 * 菜单 → 渲染进程的命令（`09` §4.4）。
 *
 * 主进程**不直接操作业务状态**：新建/打开/关闭作品、撤销重做都由渲染进程执行，
 * 这里只负责投递。窗口不在时静默丢弃 —— 那种情况本来也没有执行者。
 */
function sendCommand(command: AppCommand): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app:command', command);
  }
}

async function bootstrap(): Promise<void> {
  await app.whenReady();

  /**
   * 主进程心跳（`renderer-diagnostics.ts`）。
   *
   * 只在开发态开：生产态的日志要长期留存，每 5 秒一行只会把有用信息冲淡。
   * 它回答的是排查白屏时的第一个问题 ——"主进程还活着吗"：菜单归主进程，
   * 所以"菜单也点不动"必然指向它，而这件事只能靠日志里心跳有没有停来判断。
   */
  if (!app.isPackaged) startMainHeartbeat();

  /**
   * 设置要在**建窗口之前**读：窗口尺寸、最大化状态、启动底色都来自它（`09` §3.5 / §5.2）。
   *
   * `nativeTheme.themeSource` 也在这里设一次，作用是让**原生控件**（系统对话框、
   * 右键菜单、滚动条）跟着应用主题走 —— 否则用户选了深色，冲突确认框还是亮白的。
   * 三个取值与 `ThemeMode` 完全同名（system / light / dark），所以直接赋值。
   *
   * 顺带一个副作用是好事：themeSource 也会决定渲染进程 `prefers-color-scheme` 的取值，
   * 于是"跟随系统"的媒体查询在任何模式下都与 `data-theme` 保持一致，不会互相打架。
   */
  const settings = loadSettings();
  nativeTheme.themeSource = settings.theme.mode;

  supervisor = new SidecarSupervisor({ onStatus: broadcastStatus });

  mainWindow = createMainWindow();
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  registerIpc({ supervisor, getWindow: () => mainWindow });

  const menuDeps = {
    getWindow: () => mainWindow,
    // 每次都现取：菜单重建时（切主题）要读到最新的勾选态
    getSettings: () => loadSettings(),
    sendCommand,
  };
  installAppMenu(menuDeps);

  // 一处订阅，四件事：原生主题、广播给渲染进程、重建菜单的勾选态、推送 AI 配置。
  // 集中在这里是为了让"设置改了要做什么"只有一个答案（菜单与面板两个入口都走它）。
  subscribeSettings((next) => {
    nativeTheme.themeSource = next.theme.mode;
    broadcastSettings(next);
    installAppMenu(menuDeps);
    // 供应商 / 分模型 / 纯本地模式 都在 `ai` 段里，改完必须让 sidecar 知道
    pushAiConfigNow(false);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
    }
  });

  // 刻意不 await：先把窗口显示出来，界面由 sidecar 状态驱动（启动遮罩 / 错误页）
  supervisor.start();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  /**
   * 退出前必须先让渲染进程把未落盘的内容写完 —— 但**不在 `before-quit` 里做**。
   *
   * ## 为什么 `before-quit` 里不能 `preventDefault()`
   *
   * 踩过的坑：`before-quit` 里 `event.preventDefault()` 会把**整个 quit 取消**，
   * 于是**窗口的 `close` 事件根本不会触发** —— 而"关窗前请渲染进程落盘"正挂在
   * `close` 上（`quit-guard.ts`）。点窗口 X 时 `close` 先跑，那条路一直是对的；
   * 但菜单「文件→退出」与 macOS 的 Cmd+Q 是直接 `app.quit()`、从这里进入，
   * 会**绕过 flush、静默丢掉最多 3 秒输入**（`Autosave` 的 `maxWait`），
   * 而 A4 的判定是"正常关闭零丢失"。
   *
   * 所以这里**刻意不拦**：让 Electron 照常去关窗口，也就是走 `quit-guard` 那条
   * flush 路径（它会在 flush 成功后才 `destroy()`）。用户在那一步选了「取消」的话，
   * 窗口不销毁、quit 自然中止，不需要这里额外处理。
   *
   * ## 为什么 sidecar 的清理放在 `will-quit`
   *
   * `will-quit` 在**所有窗口都关闭之后**才触发，也就意味着那次 flush 已经完成、
   * 内容已经安全。顺序反过来（先停 sidecar）的话，flush 必然失败，
   * 于是"每次退出都提示有未保存内容"。
   */
  app.on('will-quit', (event) => {
    if (!supervisor || shutdownStarted) return;
    event.preventDefault();
    shutdownStarted = true;
    void supervisor
      .shutdown()
      // `.catch` 在 `.finally` **之前**排不上、在之后才有意义：先保证 `app.exit(0)`
      // 一定执行（否则应用永远退不掉），再记一笔。`shutdown()` 目前自己吞了所有异常，
      // 但这里不能依赖那个实现细节（`docs/13` M14）。
      .finally(() => app.exit(0))
      .catch((err: unknown) => {
        process.stderr.write(`[inkstone] 退出清理时异常：${String(err)}\n`);
      });
  });

  /**
   * 启动失败要说人话（`docs/13` M14）。
   *
   * 不加这一段的话，`bootstrap()` 里的任何异常都只是一条没人接的 rejection：
   * 表现是**双击图标之后什么都没发生** —— 没有窗口、没有提示、没有日志，
   * 用户唯一的线索是任务管理器里一个一闪而过的进程。
   * 走 `app.quit()` 而不是 `app.exit()`：让已经起来的 sidecar 按正常流程被收走。
   */
  void bootstrap().catch((err: unknown) => {
    process.stderr.write(`[inkstone] 启动失败：${String(err)}\n`);
    dialog.showErrorBox(
      '砚台启动失败',
      `应用没能完成启动，请把下面这段发给开发者：\n\n${String(err)}`,
    );
    app.quit();
  });
}
