/**
 * 大纲面板的数据钩子（docs/15 B4）。
 *
 * 与 `use-codex` 对等，但管四块数据：总纲（单例）、卷纲（列表）、章纲（当前章）、
 * 伏笔（扫描聚合的清单）。数据真源都是磁盘文件（sidecar 的 outline store）。
 *
 * 关键差异——章纲跟「当前章」走：
 * - 切章时 `chapterId` 变，要**重新读**那一章的纲；
 * - 但 `chapterId` 变化不是「重挂载」（本钩子由父级 `key={workId}` 挂载，切章
 *   不改 key），所以章纲读取要靠 `loadChapter` 在 effect 里跟随 `chapterId`。
 *
 * 保存失败（尤其 409 EXTERNAL_MODIFIED）要响亮地报，不静默吞 —— 与 use-codex 同口径。
 */

import { useCallback, useEffect, useState } from 'react';
import type {
  ChapterOutline,
  ForeshadowInput,
  ForeshadowItem,
  GeneralOutline,
  VolumeOutline,
  VolumeOutlineSummary,
} from '@inkstone/shared';
import { describeApiError, type ApiClient } from '../../lib/api';

export interface UseOutlineInput {
  client: ApiClient | null;
  workId: string | null;
  /** 当前章 id（切章时章纲跟随变化）。null = 尚未选中章节。 */
  chapterId: string | null;
}

export interface UseOutlineResult {
  general: GeneralOutline | null;
  volumes: VolumeOutlineSummary[];
  foreshadows: ForeshadowItem[];
  chapter: ChapterOutline | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  /** 保存总纲。成功回填新 hash。失败抛 ApiError，由调用方展示。 */
  saveGeneral: (body: string, ifMatch: string) => Promise<void>;
  createVolume: (title: string, body: string) => Promise<void>;
  /** 读单卷全量（含 body）。清单项不含 body，点进编辑时用它。 */
  readVolume: (order: number) => Promise<VolumeOutline>;
  /** 保存卷纲（可改 title/body，改 order 触发重排）。成功回填。 */
  saveVolume: (
    order: number,
    patch: { title: string; body: string; order?: number | null; ifMatch: string },
  ) => Promise<void>;
  deleteVolume: (order: number) => Promise<void>;
  moveVolume: (order: number, direction: 'up' | 'down') => Promise<void>;
  /** 保存当前章章纲（含伏笔）。成功回填新 hash 与补齐的伏笔 id。 */
  saveChapterOutline: (
    body: string,
    foreshadow: ForeshadowInput[],
    ifMatch: string,
  ) => Promise<void>;
}

export function useOutline({ client, workId, chapterId }: UseOutlineInput): UseOutlineResult {
  // 挂载即处于加载态：初始 `true`，省掉 effect 里那次同步 setLoading(true)。
  const [general, setGeneral] = useState<GeneralOutline | null>(null);
  const [volumes, setVolumes] = useState<VolumeOutlineSummary[]>([]);
  const [foreshadows, setForeshadows] = useState<ForeshadowItem[]>([]);
  const [chapter, setChapter] = useState<ChapterOutline | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const ready = client !== null && workId !== null;

  /** 拉总纲 + 卷纲 + 伏笔（不含章纲，章纲由 loadChapter 单独拉）。 */
  const fetchBase = useCallback(async () => {
    if (!ready || client === null || workId === null) return;
    const [g, v, f] = await Promise.all([
      client.readGeneralOutline(workId),
      client.listVolumes(workId),
      client.listForeshadows(workId),
    ]);
    setGeneral(g);
    setVolumes(v);
    setForeshadows(f);
  }, [ready, client, workId]);

  /**
   * 挂载时的初次加载：`await` 之前零 setState（`loading` 惰性初始 `true`、`error`
   * 本就是 null）。单独拆出与 `reload` 区分，理由同 use-codex 的 `initialLoad` ——
   * eslint 的 react-hooks/set-state-in-effect 是纯静态的，effect 调用的函数体内
   * 任意处有同步 setState 就标记，拆成零 setState 函数才能干净地触发初次拉取。
   */
  const initialLoad = useCallback(async () => {
    if (!ready || client === null || workId === null) return;
    try {
      await fetchBase();
    } catch (err) {
      setError(describeApiError(err));
    } finally {
      setLoading(false);
    }
  }, [ready, client, workId, fetchBase]);

  /** 事件处理器里的显式刷新：先进 loading 态再拉。 */
  const reload = useCallback(async () => {
    if (!ready || client === null || workId === null) return;
    setLoading(true);
    setError(null);
    try {
      await fetchBase();
    } catch (err) {
      setError(describeApiError(err));
    } finally {
      setLoading(false);
    }
  }, [ready, client, workId, fetchBase]);

  /**
   * 读当前章章纲。`await` 之前零 setState，供切章 effect 用（见文件头注释）。
   * 未就绪 / 未选中章节时**直接 return 不 setState**：挂载时 `chapter` 惰性初始
   * 就是 null（未选中态），WorkShell ready 态下 `chapterId` 一旦选中就不会再回到
   * null（回到 null 意味着离开作品，本组件随 `key={workId}` 重挂载），所以这里
   * 无需同步清空，也避免把 setState 留在 effect 的同步栈里。
   */
  const loadChapter = useCallback(async () => {
    if (!ready || client === null || workId === null) return;
    if (chapterId === null) return;
    try {
      setChapter(await client.readChapterOutline(workId, chapterId));
    } catch (err) {
      setChapter(null);
      setError(describeApiError(err));
    }
  }, [ready, client, workId, chapterId]);

  useEffect(() => {
    // 规则误报：initialLoad/loadChapter 的 setState 全在 `await` 之后（promise 回调），
    // 不在 effect 同步栈内，不产生级联渲染。这是 React 官方推荐的「挂载时 fetch」模式。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void initialLoad();
  }, [initialLoad]);

  useEffect(() => {
    // 切章重读章纲。loadChapter 在 await 前零 setState，理由同上。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadChapter();
  }, [loadChapter]);

  const saveGeneral = useCallback(
    async (body: string, ifMatch: string) => {
      if (!ready || client === null || workId === null) return;
      const res = await client.writeGeneralOutline(workId, body, ifMatch);
      setGeneral((prev) => (prev === null ? prev : { body, hash: res.hash }));
    },
    [ready, client, workId],
  );

  const createVolume = useCallback(
    async (title: string, body: string) => {
      if (!ready || client === null || workId === null) return;
      await client.createVolume(workId, title, body);
      await reload();
    },
    [ready, client, workId, reload],
  );

  const readVolume = useCallback(
    async (order: number) => {
      if (!ready || client === null || workId === null) {
        throw new Error('client 或 workId 未就绪');
      }
      return client.readVolume(workId, order);
    },
    [ready, client, workId],
  );

  const saveVolume = useCallback(
    async (
      order: number,
      patch: { title: string; body: string; order?: number | null; ifMatch: string },
    ) => {
      if (!ready || client === null || workId === null) return;
      await client.writeVolume(workId, order, patch);
      await reload();
    },
    [ready, client, workId, reload],
  );

  const deleteVolume = useCallback(
    async (order: number) => {
      if (!ready || client === null || workId === null) return;
      await client.deleteVolume(workId, order);
      await reload();
    },
    [ready, client, workId, reload],
  );

  const moveVolume = useCallback(
    async (order: number, direction: 'up' | 'down') => {
      if (!ready || client === null || workId === null) return;
      await client.reorderVolume(workId, order, direction);
      await reload();
    },
    [ready, client, workId, reload],
  );

  const saveChapterOutline = useCallback(
    async (body: string, foreshadow: ForeshadowInput[], ifMatch: string) => {
      if (!ready || client === null || workId === null || chapterId === null) return;
      const outline = await client.writeChapterOutline(workId, chapterId, {
        body,
        foreshadow,
        ifMatch,
      });
      setChapter(outline);
      // 伏笔聚合随章纲变化，刷新伏笔清单。
      await reload();
    },
    [ready, client, workId, chapterId, reload],
  );

  return {
    general,
    volumes,
    foreshadows,
    chapter,
    loading,
    error,
    reload,
    saveGeneral,
    createVolume,
    readVolume,
    saveVolume,
    deleteVolume,
    moveVolume,
    saveChapterOutline,
  };
}
