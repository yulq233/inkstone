import { createContext, useContext, useMemo, useReducer } from 'react';
import type { Dispatch, ReactNode } from 'react';
import type { ApiClient } from '../../lib/api';
import {
  initialSessionState,
  sessionReducer,
  type SessionAction,
  type SessionState,
} from './session-reducer';

export interface WorkSessionValue {
  state: SessionState;
  dispatch: Dispatch<SessionAction>;
  client: ApiClient | null;
}

const SessionContext = createContext<WorkSessionValue | null>(null);

/**
 * `client` 刻意不进 reducer：它是**外部资源**不是状态，生命周期跟着 sidecar 走。
 * 放进 reducer 会把"重建客户端"变成一次状态迁移，语义上说不通。
 *
 * 因此 Provider 在 sidecar 非 HEALTHY 时也必须**保持挂载**（只是 client 变 null）——
 * 会话状态要活过 sidecar 重启。否则"打开到一半 sidecar 崩了"会把用户直接踢回入口页，
 * 而 04 文档 §5.4 要求的是"停在打开中，显示横幅，恢复后提示重新打开"。
 */
export function WorkSessionProvider({
  client,
  children,
}: {
  client: ApiClient | null;
  children: ReactNode;
}) {
  const [state, dispatch] = useReducer(sessionReducer, initialSessionState);
  const value = useMemo<WorkSessionValue>(() => ({ state, dispatch, client }), [state, client]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useWorkSession(): WorkSessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useWorkSession 必须在 WorkSessionProvider 内使用');
  return ctx;
}
