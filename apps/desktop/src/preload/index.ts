import { contextBridge, ipcRenderer } from 'electron';
import type {
  AiCredentialResult,
  AiCredentialSetRequest,
  AiEgressAckRequest,
  AiEgressAckResult,
  AppCommand,
  AppInfo,
  CredentialStatus,
  FlushResult,
  PickDirectoryRequest,
  PickDirectoryResult,
  Settings,
  SettingsPatch,
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
    /**
     * 主进程在关窗前请求把未落盘内容写完（`06` §7）。返回取消订阅函数。
     *
     * 刻意用 `on` 而不是 `invoke`：这条通路的方向是**主问渲染答**，
     * 而"答"要等一个不确定多久的 `flush()`（最多 3 秒），让它挂在 `handle` 上
     * 会让主进程的对话框流程和 IPC 的生命周期绑在一起。
     */
    onBeforeQuit: (callback: () => void): (() => void) => {
      const handler = (): void => callback();
      ipcRenderer.on('app:beforeQuit', handler);
      return () => {
        ipcRenderer.off('app:beforeQuit', handler);
      };
    },
    /** 回报落盘结果。主进程据此决定直接关还是弹确认框。 */
    sendFlushResult: (result: FlushResult): void => {
      ipcRenderer.send('app:flushResult', result);
    },
    /**
     * 菜单命令（`09` §4.4）。主进程的菜单不直接操作业务状态，只投递命令。
     *
     * 与 `onBeforeQuit` 同样是"主 → 渲染"的单向通知，所以用 `on` 而非 `invoke`。
     */
    onCommand: (callback: (command: AppCommand) => void): (() => void) => {
      const handler = (_event: unknown, command: AppCommand): void => callback(command);
      ipcRenderer.on('app:command', handler);
      return () => {
        ipcRenderer.off('app:command', handler);
      };
    },
  },
  settings: {
    /** 启动时读一次，之后靠 `onChanged` 同步 */
    get: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
    /**
     * 改外观设置。**刻意不 await**（调用方 fire-and-forget）：
     * 切换主题时渲染进程已经先改了 CSS 变量（立即生效），落盘只是记下来 ——
     * 让一次磁盘写阻塞主题切换是本末倒置（§3.6）。
     */
    set: (patch: SettingsPatch): Promise<Settings> => ipcRenderer.invoke('settings:set', patch),
    onChanged: (callback: (settings: Settings) => void): (() => void) => {
      const handler = (_event: unknown, settings: Settings): void => callback(settings);
      ipcRenderer.on('settings:changed', handler);
      return () => {
        ipcRenderer.off('settings:changed', handler);
      };
    },
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
  ai: {
    /**
     * 各供应商"配没配密钥"。**只回布尔**（`11` §4.4）：
     * 没有 `getCredential` 这种通道，渲染进程拿不到 Key 本身。
     */
    getCredentialsStatus: (): Promise<CredentialStatus[]> =>
      ipcRenderer.invoke('ai:getCredentialsStatus'),
    /**
     * 系统加密是否可用。渲染进程据此**先**把保存按钮禁掉并说明原因 ——
     * 比让用户填完 Key 再收到"存不了"好得多。
     */
    isSecureStorageAvailable: (): Promise<boolean> =>
      ipcRenderer.invoke('ai:isSecureStorageAvailable'),
    /** 写一条密钥。入参是唯一出现明文 Key 的地方（用户刚敲的那个）。 */
    setCredential: (req: AiCredentialSetRequest): Promise<AiCredentialResult> =>
      ipcRenderer.invoke('ai:setCredential', req),
    clearCredential: (providerId: string): Promise<AiCredentialResult> =>
      ipcRenderer.invoke('ai:clearCredential', providerId),
    /**
     * 记录 / 撤销"已确认可以把内容发往这家"（`docs/11` §2.3）。
     *
     * 只有"加一个 / 去一个"两种意图，名单本身由主进程持有 ——
     * 渲染进程**读不到也传不了整个数组**，所以不会出现"两处都改、后写的覆盖先写的"。
     */
    setEgressAck: (req: AiEgressAckRequest): Promise<AiEgressAckResult> =>
      ipcRenderer.invoke('ai:setEgressAck', req),
  },
  dialog: {
    pickDirectory: (req: PickDirectoryRequest): Promise<PickDirectoryResult> =>
      ipcRenderer.invoke('dialog:pickDirectory', req),
  },
};

contextBridge.exposeInMainWorld('inkstone', api);
