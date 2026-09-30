import { useEffect, useState } from 'react';
import { SidecarState, type SidecarStatus } from '@inkstone/shared';
import { ApiClient } from './api';

/**
 * 随 sidecar 状态重建 `ApiClient`（04 文档 §5.4）。
 *
 * **每次进入 HEALTHY 都必须重新取连接信息**：token 不变，但端口变了 ——
 * sidecar 每次启动都 `bind 127.0.0.1:0` 由内核分配。漏掉这一步的症状是
 * "崩溃自愈之后所有请求打到旧端口，界面永远转圈"。
 *
 * 非 HEALTHY 时返回 null 而不是保留旧客户端：拿一个已经连不上的客户端继续发请求，
 * 只会把"服务在重启"这件事伪装成一堆网络错误。
 */
export function useApiClient(status: SidecarStatus): ApiClient | null {
  const [client, setClient] = useState<ApiClient | null>(null);

  useEffect(() => {
    if (status.state !== SidecarState.HEALTHY) {
      setClient(null);
      return;
    }

    let cancelled = false;
    void (async () => {
      const connection = await window.inkstone.sidecar.getConnection();
      if (cancelled) return;
      setClient(connection ? new ApiClient(connection) : null);
    })();

    return () => {
      cancelled = true;
    };
    // 依赖 port 而不是整个 status 对象：status 每次广播都是新对象，会白白重建客户端。
  }, [status.state, status.port]);

  return client;
}
