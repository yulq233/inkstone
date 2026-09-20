import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppInfo,
  PickDirectoryRequest,
  PickDirectoryResult,
  SidecarConnection,
  SidecarStatus,
} from '@inkstone/shared';

/**
 * 暴露给渲染进程的白名单 API。
 * 刻意不暴露任意 channel 的 invoke —— 只开放下面这几个具体能力。
 */
const api = {
  app: {
    getInfo: (): Promise<AppInfo> => ipcRenderer.invoke('app:getInfo'),
  },
  sidecar: {
    /** 拿连接信息（baseUrl + token）。端口每次重启都会变，必须重新取 */
    getConnection: (): Promise<SidecarConnection | null> =>
      ipcRenderer.invoke('sidecar:getConnection'),
    /** 新窗口打开时同步一次当前状态，避免错过早期的广播 */
    getStatus: (): Promise<SidecarStatus> => ipcRenderer.invoke('sidecar:getStatus'),
    onStatus: (callback: (status: SidecarStatus) => void): (() => void) => {
      const handler = (_event: unknown, status: SidecarStatus): void => callback(status);
      ipcRenderer.on('sidecar:onStatus', handler);
      return () => {
        ipcRenderer.off('sidecar:onStatus', handler);
      };
    },
    /** 仅开发态可用：模拟崩溃，验证自愈 */
    devCrash: (): Promise<void> => ipcRenderer.invoke('sidecar:devCrash'),
  },
  dialog: {
    pickDirectory: (req: PickDirectoryRequest): Promise<PickDirectoryResult> =>
      ipcRenderer.invoke('dialog:pickDirectory', req),
  },
};

contextBridge.exposeInMainWorld('inkstone', api);
