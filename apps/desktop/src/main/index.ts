import { app, BrowserWindow } from 'electron';
import type { SidecarStatus } from '@inkstone/shared';
import { registerIpc } from './ipc';
import { SidecarSupervisor } from './sidecar/supervisor';
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
let quitting = false;

function broadcastStatus(status: SidecarStatus): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('sidecar:onStatus', status);
  }
}

async function bootstrap(): Promise<void> {
  await app.whenReady();

  supervisor = new SidecarSupervisor({ onStatus: broadcastStatus });

  mainWindow = createMainWindow();
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  registerIpc({ supervisor, getWindow: () => mainWindow });

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

  app.on('before-quit', (event) => {
    if (quitting || !supervisor) return;
    event.preventDefault();
    quitting = true;
    // TODO(批次 B)：退出前先让渲染进程 flush 未保存内容（最多等 2s），再关 sidecar
    void supervisor.shutdown().finally(() => app.exit(0));
  });

  void bootstrap();
}
