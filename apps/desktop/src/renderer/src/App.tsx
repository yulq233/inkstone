import { useCallback, useEffect, useState } from 'react';
import {
  SidecarState,
  type AppInfo,
  type SidecarConnection,
  type SidecarStatus,
} from '@inkstone/shared';
import { ErrorPanel } from './components/ErrorPanel';
import { ReadyPanel, type ProbeResult } from './components/ReadyPanel';
import { StartupOverlay } from './components/StartupOverlay';
import { StatusBanner } from './components/StatusBanner';
import { probeHealth } from './lib/api';

export default function App() {
  const [status, setStatus] = useState<SidecarStatus>({ state: SidecarState.BOOTING });
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [connection, setConnection] = useState<SidecarConnection | null>(null);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [probing, setProbing] = useState(false);

  // 订阅状态 + 主动同步一次（新窗口可能错过早期广播）
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const [appInfo, current] = await Promise.all([
        window.inkstone.app.getInfo(),
        window.inkstone.sidecar.getStatus(),
      ]);
      if (cancelled) return;
      setInfo(appInfo);
      setStatus(current);
    })();

    const unsubscribe = window.inkstone.sidecar.onStatus((next) => {
      setStatus(next);
      if (next.state !== SidecarState.HEALTHY) setProbe(null);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  /**
   * 每次进入 healthy 都必须重新取连接信息：
   * token 不变，但重启后端口会变（sidecar 每次 bind :0 都拿新端口）。
   * 漏掉这一步的典型症状是"重启之后所有请求都打到旧端口，界面永远转圈"。
   */
  useEffect(() => {
    if (status.state !== SidecarState.HEALTHY) {
      setConnection(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const conn = await window.inkstone.sidecar.getConnection();
      if (!cancelled) setConnection(conn);
    })();
    return () => {
      cancelled = true;
    };
  }, [status.state, status.port]);

  const runProbe = useCallback(async () => {
    if (!connection) return;
    setProbing(true);
    try {
      const result = await probeHealth(connection);
      setProbe({ ok: true, version: result.version, uptimeMs: result.uptimeMs });
    } catch (err) {
      setProbe({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setProbing(false);
    }
  }, [connection]);

  const crashSidecar = useCallback(async () => {
    try {
      await window.inkstone.sidecar.devCrash();
    } catch {
      /* 生产态没有这个通道，忽略 */
    }
  }, []);

  return (
    <div className="app">
      {status.state === SidecarState.RESTARTING ? <StatusBanner status={status} /> : null}

      {status.state === SidecarState.FAILED ? (
        <ErrorPanel status={status} info={info} />
      ) : status.state === SidecarState.HEALTHY ? (
        <ReadyPanel
          info={info}
          connection={connection}
          probe={probe}
          probing={probing}
          onProbe={() => void runProbe()}
          onDevCrash={() => void crashSidecar()}
        />
      ) : (
        <StartupOverlay state={status.state} />
      )}
    </div>
  );
}
