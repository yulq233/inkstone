import path from 'node:path';
import { app, dialog, ipcMain, type BrowserWindow } from 'electron';
import type {
  AppInfo,
  DesktopPlatform,
  PickDirectoryRequest,
  PickDirectoryResult,
  SidecarConnection,
  SidecarStatus,
} from '@inkstone/shared';
import type { SidecarSupervisor } from './sidecar/supervisor';

export interface IpcDeps {
  supervisor: SidecarSupervisor;
  getWindow: () => BrowserWindow | null;
}

/**
 * IPC 只承载"系统能力"与 sidecar 生命周期事件。
 * 正文数据一律由渲染进程直连 sidecar 的本地 HTTP —— 少一层转发，也便于 DevTools 调试。
 */
export function registerIpc({ supervisor, getWindow }: IpcDeps): void {
  ipcMain.handle('app:getInfo', (): AppInfo => {
    return {
      version: app.getVersion(),
      // NodeJS.Platform 比我们支持的三个平台更宽（还有 aix / sunos / android 等），
      // 这里按合同收窄。M0 只出 Windows，另两个平台留给后续。
      platform: process.platform as DesktopPlatform,
      userDataPath: app.getPath('userData'),
      logDir: path.join(app.getPath('userData'), 'logs'),
      isPackaged: app.isPackaged,
    };
  });

  ipcMain.handle('sidecar:getConnection', (): SidecarConnection | null => {
    return supervisor.getConnection();
  });

  ipcMain.handle('sidecar:getStatus', (): SidecarStatus => {
    return supervisor.getStatus();
  });

  ipcMain.handle(
    'dialog:pickDirectory',
    async (_event, req: PickDirectoryRequest = {}): Promise<PickDirectoryResult> => {
      const win = getWindow();
      const result = win
        ? await dialog.showOpenDialog(win, {
            title: req.title ?? '选择目录',
            defaultPath: req.defaultPath,
            properties: ['openDirectory', 'createDirectory'],
          })
        : await dialog.showOpenDialog({
            title: req.title ?? '选择目录',
            defaultPath: req.defaultPath,
            properties: ['openDirectory', 'createDirectory'],
          });
      return { canceled: result.canceled, path: result.filePaths[0] };
    },
  );

  // 仅开发态：用于验证"崩溃 → 自愈"链路，生产包中不存在这个通道
  if (!app.isPackaged) {
    ipcMain.handle('sidecar:devCrash', (): void => {
      supervisor.crashForDiagnostics();
    });
  }
}
