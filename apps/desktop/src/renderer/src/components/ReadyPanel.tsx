import type { AppInfo, SidecarConnection } from '@inkstone/shared';

export interface ProbeResult {
  ok: boolean;
  version?: string;
  uptimeMs?: number;
  error?: string;
}

interface ReadyPanelProps {
  info: AppInfo | null;
  connection: SidecarConnection | null;
  probe: ProbeResult | null;
  probing: boolean;
  onProbe: () => void;
  onDevCrash: () => void;
}

export function ReadyPanel({
  info,
  connection,
  probe,
  probing,
  onProbe,
  onDevCrash,
}: ReadyPanelProps) {
  const uptimeSec = probe?.uptimeMs !== undefined ? Math.round(probe.uptimeMs / 1000) : null;

  return (
    <div className="center-stage">
      <div className="card">
        <div className="row" style={{ marginBottom: 8 }}>
          <h1>本地服务已就绪</h1>
          <span className="pill ok">M0 · 批次 A</span>
        </div>
        <p>进程编排已跑通。写作界面从批次 B 开始。</p>

        <dl className="kv">
          <dt>桌面版本</dt>
          <dd>{info ? `${info.version}（${info.isPackaged ? '打包态' : '开发态'}）` : '—'}</dd>
          <dt>本地服务</dt>
          <dd>{connection ? connection.baseUrl : '未连接'}</dd>
          <dt>平台</dt>
          <dd>{info?.platform ?? '—'}</dd>
          <dt>日志目录</dt>
          <dd>{info?.logDir ?? '—'}</dd>
        </dl>

        <ul className="steps">
          <li>token 经环境变量注入，随机端口由内核分配</li>
          <li>渲染进程带 token 直连本地 HTTP（不经 IPC 转发）</li>
          <li>每 5 秒探活，连续 3 次失败自动重启，退避 1s / 2s / 4s</li>
          <li>退出时先走 HTTP 优雅关闭，超时再强杀</li>
          <li>父进程消失时 sidecar 靠 stdin EOF 自行退出，不留孤儿进程</li>
        </ul>

        <div className="actions">
          <button type="button" onClick={onProbe} disabled={probing || !connection}>
            {probing ? '探活中……' : '手动探活一次'}
          </button>
          {info && !info.isPackaged ? (
            <button type="button" onClick={onDevCrash}>
              模拟崩溃（验证自愈）
            </button>
          ) : null}
        </div>

        {probe ? (
          <div className="note">
            {probe.ok
              ? `探活成功 · sidecar 版本 ${probe.version} · 已运行 ${uptimeSec} 秒`
              : `探活失败 · ${probe.error}`}
          </div>
        ) : null}
      </div>
    </div>
  );
}
