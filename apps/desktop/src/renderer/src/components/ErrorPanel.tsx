import type { AppInfo, SidecarStatus } from '@inkstone/shared';

export function ErrorPanel({
  status,
  info,
  proxyNote,
}: {
  status: SidecarStatus;
  info: AppInfo | null;
  /** 代理绕过诊断（04 文档 §6.4）：故障页要能一眼排除"系统代理截走了 loopback" */
  proxyNote?: string;
}) {
  const firstLine = status.message?.split('\n')[0] ?? '未知原因';

  return (
    <div className="center-stage">
      <div className="card">
        <div className="row" style={{ marginBottom: 8 }}>
          <h1>本地服务启动失败</h1>
          <span className="pill bad">已停止</span>
        </div>
        <p>{firstLine}</p>
        {status.message ? <div className="logbox">{status.message}</div> : null}
        <div className="note">
          日志目录：<code>{info?.logDir ?? '（未知）'}</code>
          {proxyNote ? (
            <>
              <br />
              {proxyNote}
            </>
          ) : null}
          <br />
          最常见的原因是没有创建 Python 虚拟环境 —— 请在仓库根目录执行{' '}
          <code>pnpm sidecar:setup</code>，然后重启应用。
        </div>
      </div>
    </div>
  );
}
