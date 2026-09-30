/**
 * 入口页的数据与动作（04 文档 §5.1~§5.3）。
 *
 * 三件事刻意分开：
 * - 列表加载失败 → 页面级提示，不阻塞"新建"（后端刚起来时列表可能先失败一次）
 * - 单个作品打开失败（目录被挪走）→ **条目级**提示，不进会话失败态。
 *   把它升级成会话失败会让用户以为整个应用坏了，而他只是挪了一个目录。
 * - 新建失败 → 表单内联提示，保留已填内容
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ErrorCode } from '@inkstone/shared';
import type { PickDirectoryRequest, RecentWork, WorkSummary } from '@inkstone/shared';
import { ApiError, describeApiError } from '../../lib/api';
import { useWorkSession } from '../session/WorkSessionProvider';

const LAST_PARENT_DIR_KEY = 'inkstone.lastParentDir';

/** localStorage 在隐私模式等场景会抛，读不到就当作没有 —— 它只是"下次默认路径"，不是必需品。 */
export function readLastParentDir(): string | undefined {
  try {
    return window.localStorage.getItem(LAST_PARENT_DIR_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function writeLastParentDir(dir: string): void {
  try {
    window.localStorage.setItem(LAST_PARENT_DIR_KEY, dir);
  } catch {
    /* 忽略：不影响主流程 */
  }
}

/** 弹目录选择器。选中即记住，供下次做默认路径（即使随后创建失败，这个目录仍是好默认值）。 */
export async function pickDirectory(title: string, defaultPath?: string): Promise<string | null> {
  const req: PickDirectoryRequest = {
    title,
    defaultPath: defaultPath ?? readLastParentDir(),
  };
  const result = await window.inkstone.dialog.pickDirectory(req);
  if (result.canceled || !result.path) return null;
  writeLastParentDir(result.path);
  return result.path;
}

export interface RecentWorksHandle {
  /** null 表示"还没拿到过"，与 `[]`（确实没有最近作品）是两种不同的界面 */
  items: RecentWork[] | null;
  error: string | null;
  reload: () => Promise<void>;
}

export function useRecentWorks(): RecentWorksHandle {
  const { client } = useWorkSession();
  const [items, setItems] = useState<RecentWork[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    // sidecar 重启中：保留上一次拿到的列表，不要闪成空列表
    if (!client) return;
    try {
      // exists 由 sidecar 读取时现算，前端不缓存 —— 缓存会让用户在文件管理器里
      // 挪完目录后，界面仍显示"可用"，点进去才报错（04 文档 §5.3）。
      setItems(await client.listRecent());
      setError(null);
    } catch (err) {
      setError(describeApiError(err));
    }
  }, [client]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { items, error, reload };
}

export interface OpenFailure {
  rootPath: string;
  message: string;
}

export interface OpenWorkHandle {
  /** 正在打开的那个作品的 rootPath；null 表示空闲 */
  openingPath: string | null;
  /** 条目级失败：目录被移动或删除 */
  failure: OpenFailure | null;
  open: (rootPath: string, title: string) => Promise<void>;
  forget: (rootPath: string) => Promise<void>;
  dismissFailure: () => void;
}

/**
 * 打开已有作品 + 从最近列表移除。
 *
 * 没有 `client` 时**直接不动作**：这时点按钮什么都不会发生，但会话状态也不会被
 * 推进到 `opening` —— 否则 sidecar 恢复后界面会停在一个永远不会完成的"正在打开"。
 *
 * 状态留在**入口页**而不是会话 reducer 里，前提是入口页在 `opening` 期间**不卸载**
 * （`AppRoutes` 保证）。那正是 `docs/13` M19 的落点：这两个状态描述的是"这张卡片
 * 现在怎么样"，属于书架；一旦入口页被换掉，它们就再也显示不出来了。
 */
export function useOpenWork(recent: RecentWorksHandle): OpenWorkHandle {
  const { client, dispatch } = useWorkSession();
  const [openingPath, setOpeningPath] = useState<string | null>(null);
  const [failure, setFailure] = useState<OpenFailure | null>(null);
  // 只依赖 reload 的引用：recent 本身每次渲染都是新对象，直接进依赖会让回调反复重建。
  const { reload } = recent;

  /**
   * 在飞守卫（`docs/13` M20 同族）。同一批事件里的两次点击会在**同一次渲染**里
   * 读到 `openingPath === null`，光靠 state 挡不住；而两次 `openWork` 交错回来的顺序
   * 不确定，最终停在哪个作品上全看运气。
   */
  const openingRef = useRef(false);

  const open = useCallback(
    async (rootPath: string, title: string) => {
      if (!client) return;
      if (openingRef.current) return;
      openingRef.current = true;
      setFailure(null);
      setOpeningPath(rootPath);
      dispatch({ type: 'work/opening', title });
      try {
        const work = await client.openWork(rootPath);
        dispatch({ type: 'work/opened', work, chapter: null });
      } catch (err) {
        if (err instanceof ApiError && err.code === ErrorCode.WORK_NOT_FOUND) {
          // 目录没了：退回入口页并在该条目上报错，同时重拉列表（exists 会现算成 false）。
          //
          // ⚠️ 顺序要紧：`work/leave` 会让入口页重新渲染（它本来就在，只是换个 kind），
          // 而 `setFailure` 与它同批提交 —— 所以这条提示**看得见**。
          // 旧实现在这里把提示写进一个随即被卸载的组件，于是这条通道形同不存在（M19）。
          setFailure({ rootPath, message: err.message });
          dispatch({ type: 'work/leave' });
          void reload();
        } else {
          dispatch({ type: 'work/failed', error: describeApiError(err) });
        }
      } finally {
        openingRef.current = false;
        setOpeningPath(null);
      }
    },
    [client, dispatch, reload],
  );

  const forget = useCallback(
    async (rootPath: string) => {
      if (!client) return;
      try {
        await client.forgetRecent(rootPath);
        setFailure((prev) => (prev?.rootPath === rootPath ? null : prev));
        await reload();
      } catch (err) {
        setFailure({ rootPath, message: describeApiError(err) });
      }
    },
    [client, reload],
  );

  const dismissFailure = useCallback(() => setFailure(null), []);

  return { openingPath, failure, open, forget, dismissFailure };
}

/** 列表里显示"什么时候打开过"。本地时区、秒级精度，够用且不会被 locale 差异咬到。 */
export function formatLastOpened(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '时间未知';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
}

/** 新建成功后统一走这里：拿到摘要 → 进 ready 态（章节由步骤 03 负责选） */
export function useCreateWork(): (
  parentDir: string,
  body: { title: string; author?: string; genre?: string; wordGoal?: number },
) => Promise<WorkSummary> {
  const { client, dispatch } = useWorkSession();

  return useCallback(
    async (parentDir, body) => {
      if (!client) throw new Error('本地服务未就绪，请稍后重试。');
      const work = await client.createWork({ parentDir, ...body });
      dispatch({ type: 'work/opened', work, chapter: null });
      return work;
    },
    [client, dispatch],
  );
}
