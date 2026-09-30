import { useCallback, useEffect, useState } from 'react';
import { SidecarState, type AppInfo, type SidecarStatus } from '@inkstone/shared';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ErrorPanel } from './components/ErrorPanel';
import { ReadyPanel, type ProbeResult } from './components/ReadyPanel';
import { StartupOverlay } from './components/StartupOverlay';
import { StatusBanner } from './components/StatusBanner';
import { WorkSessionProvider, useWorkSession } from './features/session/WorkSessionProvider';
import { screenFor } from './features/session/session-reducer';
import { useQuitFlush } from './features/editor/use-autosave';
import { SettingsPanel } from './features/settings/SettingsPanel';
import { WorkShell } from './features/shell/WorkShell';
import { WorkEntry } from './features/work/WorkEntry';
import { describeApiError, probeHealth } from './lib/api';
import { emitAppCommand } from './lib/app-commands';
import { describeProxyBypass } from './lib/app-proxy';
import { useApiClient } from './lib/use-api-client';

export default function App() {
  const [status, setStatus] = useState<SidecarStatus>({ state: SidecarState.BOOTING });
  const [info, setInfo] = useState<AppInfo | null>(null);
  const client = useApiClient(status);

  /**
   * 关窗前落盘的通路（06 文档 §7）。
   *
   * 挂在最外层、且**与 sidecar 状态无关**：作品入口页没有 `Autosave` 实例，
   * 但主进程照样会问"可以关了吗"。那条通路不存在的话，每次从入口页关闭都要干等满 3 秒超时。
   */
  useQuitFlush();

  /**
   * 菜单命令的中转（`09` §4.4）。
   *
   * 命令的宿主分散在入口页与工作台两棵子树里，而且**跟着屏幕切换而变**。在根组件订阅一次、
   * 广播给所有订阅者，比让主进程去判断"现在哪个屏幕该收这条命令"简单得多 ——
   * 主进程也就保住了"不碰业务状态"这条边界。
   */
  useEffect(() => window.inkstone.app.onCommand(emitAppCommand), []);

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

    const unsubscribe = window.inkstone.sidecar.onStatus(setStatus);

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return (
    <div className="app">
      {/*
        兜底包住整棵界面。渲染期一抛，React 19 会把整棵根卸载 —— 那正是"白屏但什么都不说"
        的成因（见 `components/ErrorBoundary.tsx`）。包在这里而不是逐块包：见该文件的说明。
      */}
      <ErrorBoundary>
        {status.state === SidecarState.RESTARTING ? <StatusBanner status={status} /> : null}

        {/*
          Provider 在 sidecar 非 HEALTHY 时也保持挂载（只是 client 为 null）：
          会话状态必须活过 sidecar 重启，否则"打开到一半崩了"会把用户直接踢回入口页。
        */}
        <WorkSessionProvider client={client}>
          <AppRoutes status={status} info={info} />
        </WorkSessionProvider>

        {/*
          常挂载，且放在会话之外：主题与字号是**应用级**的外观，不属于任何作品 ——
          sidecar 挂了、还在入口页、正在看错误页，配色都必须是用户选的那个。

          `client` 传进去只给「AI 模型」分区的连接测试用：它要发真实请求，
          而连接信息（端口每次重启都变）的唯一来源是这里的 `useApiClient`。
        */}
        <SettingsPanel client={client} />
      </ErrorBoundary>
    </div>
  );
}

function AppRoutes({ status, info }: { status: SidecarStatus; info: AppInfo | null }) {
  const { state: session, client } = useWorkSession();
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [probing, setProbing] = useState(false);

  // 客户端一重建（sidecar 重启），上一次的探活结论就作废了
  useEffect(() => {
    setProbe(null);
  }, [client]);

  const runProbe = useCallback(async () => {
    if (!client) return;
    setProbing(true);
    try {
      const result = await probeHealth(client.connection);
      setProbe({ ok: true, version: result.version, uptimeMs: result.uptimeMs });
    } catch (err) {
      setProbe({ ok: false, error: describeApiError(err) });
    } finally {
      setProbing(false);
    }
  }, [client]);

  const crashSidecar = useCallback(async () => {
    try {
      await window.inkstone.sidecar.devCrash();
    } catch {
      /* 生产态没有这个通道，忽略 */
    }
  }, []);

  if (status.state === SidecarState.FAILED) {
    return <ErrorPanel status={status} info={info} proxyNote={describeProxyBypass(info)} />;
  }

  if (status.state !== SidecarState.HEALTHY) {
    return <StartupOverlay state={status.state} />;
  }

  if (showDiagnostics) {
    return (
      <ReadyPanel
        info={info}
        connection={client?.connection ?? null}
        probe={probe}
        probing={probing}
        onProbe={() => void runProbe()}
        onDevCrash={() => void crashSidecar()}
        onBack={() => setShowDiagnostics(false)}
        proxyNote={describeProxyBypass(info)}
      />
    );
  }

  /**
   * `opening` 也留在**入口页**，不换成全屏"正在打开"卡片（`docs/13` M19）。
   *
   * 这一步是有意的：`openingPath`（卡片上的「打开中……」）与条目级失败提示
   * （"目录已移动或删除"落在那一张卡上）都是**入口页自己的状态**。
   * 一旦把入口页换成全屏卡片，它随即卸载，那两个通道就永远显示不出来 ——
   * 而 `shelf-view.ts` 的 `shelfCardStatus` 恰恰是按"打开中 > 打开失败 > 目录没了"
   * 这个顺序设计的，也就是说那份逻辑当时就已经是死代码。
   *
   * 「正在打开」的提示改由入口页自己给（见 `WorkEntry`），书架全程可见 ——
   * 本地打开本来就是毫秒级，闪一张全屏卡片反而更像卡了一下。
   *
   * 判定本身在 `screenFor` 里，有单测钉着 —— 这里只是接线。
   */
  if (screenFor(session.kind) === 'entry') {
    return <WorkEntry onOpenDiagnostics={() => setShowDiagnostics(true)} />;
  }

  // ready / failed 都由容器自己按会话状态呈现
  return <WorkShell />;
}
