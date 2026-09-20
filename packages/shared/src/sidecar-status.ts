/**
 * sidecar 生命周期状态。由主进程广播给渲染进程，驱动启动遮罩与状态横幅。
 * 详见 docs/03-M0-详细设计.md §2.2
 */
export const SidecarState = {
  /** 应用启动，读取配置 */
  BOOTING: 'booting',
  /** 正在 spawn 子进程 */
  SPAWNING: 'spawning',
  /** 已 spawn，等待 INKSTONE_READY 就绪行 */
  HANDSHAKING: 'handshaking',
  /** 探活通过，可正常使用 */
  HEALTHY: 'healthy',
  /** 探活失败 / 子进程异常退出，正在退避重启 */
  RESTARTING: 'restarting',
  /** 重启次数耗尽，终端失败态 */
  FAILED: 'failed',
} as const;

export type SidecarState = (typeof SidecarState)[keyof typeof SidecarState];

export type SidecarFailureReason =
  | 'handshake_timeout'
  | 'spawn_error'
  | 'unhealthy'
  | 'exited'
  | 'restart_exhausted';

export interface SidecarStatus {
  state: SidecarState;
  /** 失败或重启时的人类可读说明 */
  message?: string;
  /** 失败原因分类，供 UI 决定展示哪种引导 */
  reason?: SidecarFailureReason;
  /** 当前已重启次数 */
  restartCount?: number;
  /** 就绪后的实际端口（仅 HEALTHY 时有值） */
  port?: number;
  /** sidecar 版本（仅 HEALTHY 时有值） */
  sidecarVersion?: string;
}

/** 主进程握手成功后提供给渲染进程的连接信息 */
export interface SidecarConnection {
  baseUrl: string;
  token: string;
}
