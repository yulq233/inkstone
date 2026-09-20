import { SidecarState, type SidecarState as SidecarStateType } from '@inkstone/shared';

const LABELS: Record<SidecarStateType, string> = {
  [SidecarState.BOOTING]: '正在准备……',
  [SidecarState.SPAWNING]: '正在启动本地服务进程……',
  [SidecarState.HANDSHAKING]: '正在等待本地服务就绪……',
  [SidecarState.HEALTHY]: '已就绪',
  [SidecarState.RESTARTING]: '正在重启本地服务……',
  [SidecarState.FAILED]: '启动失败',
};

export function StartupOverlay({ state }: { state: SidecarStateType }) {
  return (
    <div className="center-stage">
      <div className="card">
        <div className="row" style={{ marginBottom: 8 }}>
          <div className="spinner" />
          <h1>砚台</h1>
        </div>
        <p>{LABELS[state]}</p>
        <div className="note">
          首次启动会慢一些（要拉起本地 Python 服务）。若长时间停在这里，请查看日志目录下的{' '}
          <code>sidecar-stdio.log</code>。
        </div>
      </div>
    </div>
  );
}
