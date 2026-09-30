/**
 * 设定面板的数据钩子（docs/15 B3）。
 *
 * 职责与 `use-chapter-switch` 对等：加载清单、把 CRUD 结果映射成 React 状态、
 * 把中断原因变成一句话。判定逻辑全在 `codex-model.ts`（纯函数），这里不该有
 * 需要小心写的分支。
 *
 * 数据真源是磁盘文件（sidecar 的 codex store），所以：
 * - 切作品要**重新拉**（列表属于某一部作品，别把上一部的设定显示出来）；
 * - 保存失败（尤其 409 EXTERNAL_MODIFIED）要**响亮地报**，而不是静默吞掉。
 */

import { useCallback, useEffect, useState } from 'react';
import type { CodexEntry, CodexEntrySummary, CodexType } from '@inkstone/shared';
import { describeApiError, type ApiClient } from '../../lib/api';

export interface UseCodexInput {
  client: ApiClient | null;
  workId: string | null;
}

export interface UseCodexResult {
  entries: CodexEntrySummary[];
  loading: boolean;
  error: string | null;
  /** 当前正在查看/编辑的条目（全量）。null = 未选中或列表态。 */
  current: CodexEntry | null;
  /** 新建表单的类型（选了类型才显示表单）。null = 不新建。 */
  creatingType: CodexType | null;
  reload: () => Promise<void>;
  openEntry: (type: CodexType, slug: string) => Promise<void>;
  startCreate: (type: CodexType) => void;
  cancelCreate: () => void;
  /** 新建。成功后进入该条目的编辑态。 */
  create: (
    entry: Omit<CodexEntry, 'type' | 'slug' | 'hash'> & { type: CodexType },
  ) => Promise<void>;
  /** 保存（PUT）。成功回填新 hash。失败抛 `ApiError`，由调用方展示。 */
  save: (entry: CodexEntry, ifMatch: string) => Promise<void>;
  remove: (type: CodexType, slug: string) => Promise<void>;
  close: () => void;
}

export function useCodex({ client, workId }: UseCodexInput): UseCodexResult {
  // 挂载即处于加载态：初始 `true`，省掉 effect 里那次同步 `setLoading(true)`。
  // 切作品靠**父级 `key={workId}` 重挂载**（见 WorkShell）——所以这里不需要
  // "workId 变化时清空状态"的 effect，state 随组件重挂载自然重置。
  const [entries, setEntries] = useState<CodexEntrySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<CodexEntry | null>(null);
  const [creatingType, setCreatingType] = useState<CodexType | null>(null);

  /**
   * 挂载时的初次加载：在 `await` 之前**零 setState**（`loading` 由惰性初始值 `true`
   * 承担、`error` 本就是 `null`），同步路径完全干净。单独拆出来而不并入 `reload`，
   * 是因为 `reload` 要照顾事件处理器里的"显式刷新要先进 loading"，函数体里必然含
   * 同步 setState——eslint 的 react-hooks/set-state-in-effect 是纯静态的，不追踪参数
   * 分支，只要 effect 调用的函数体内任意处有同步 setState 就会标记。拆成这个零
   * setState 的函数，才能在 effect 里干净地触发初次拉取。
   */
  const initialLoad = useCallback(async () => {
    if (client === null || workId === null) return;
    try {
      setEntries(await client.listCodex(workId));
    } catch (err) {
      setError(describeApiError(err));
    } finally {
      setLoading(false);
    }
  }, [client, workId]);

  /** 事件处理器里的显式刷新（创建/保存/删除后）：先进 loading 态再拉。 */
  const reload = useCallback(async () => {
    if (client === null || workId === null) return;
    setLoading(true);
    setError(null);
    try {
      setEntries(await client.listCodex(workId));
    } catch (err) {
      setError(describeApiError(err));
    } finally {
      setLoading(false);
    }
  }, [client, workId]);

  // 挂载时拉一次（不置 loading：惰性初始值已 true）。
  useEffect(() => {
    // 规则误报：initialLoad 的 setState 全部发生在 `await client.listCodex()` 之后
    // （promise 回调里），不在 effect 的同步栈内，不产生级联渲染。这是 React 官方
    // 推荐的「挂载时 fetch」模式，与 use-chapter-switch 的 load 同构。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void initialLoad();
  }, [initialLoad]);

  const openEntry = useCallback(
    async (type: CodexType, slug: string) => {
      if (client === null || workId === null) return;
      setError(null);
      try {
        setCurrent(await client.readCodexEntry(workId, type, slug));
      } catch (err) {
        setError(describeApiError(err));
      }
    },
    [client, workId],
  );

  const startCreate = useCallback((type: CodexType) => {
    setCurrent(null);
    setCreatingType(type);
  }, []);

  const cancelCreate = useCallback(() => setCreatingType(null), []);

  const create = useCallback(
    async (entry: Omit<CodexEntry, 'type' | 'slug' | 'hash'> & { type: CodexType }) => {
      if (client === null || workId === null) return;
      const created = await client.createCodexEntry(workId, entry);
      setCreatingType(null);
      setCurrent(created);
      await reload();
    },
    [client, workId, reload],
  );

  const save = useCallback(
    async (entry: CodexEntry, ifMatch: string) => {
      if (client === null || workId === null) return;
      const saved = await client.writeCodexEntry(workId, entry.type, entry.slug, {
        type: entry.type,
        name: entry.name,
        aliases: entry.aliases,
        tags: entry.tags,
        fields: entry.fields,
        summary: entry.summary,
        relations: entry.relations,
        body: entry.body,
        ifMatch,
      });
      setCurrent(saved);
      await reload();
    },
    [client, workId, reload],
  );

  const remove = useCallback(
    async (type: CodexType, slug: string) => {
      if (client === null || workId === null) return;
      await client.deleteCodexEntry(workId, type, slug);
      setCurrent(null);
      await reload();
    },
    [client, workId, reload],
  );

  const close = useCallback(() => {
    setCurrent(null);
    setCreatingType(null);
  }, []);

  return {
    entries,
    loading,
    error,
    current,
    creatingType,
    reload,
    openEntry,
    startCreate,
    cancelCreate,
    create,
    save,
    remove,
    close,
  };
}
