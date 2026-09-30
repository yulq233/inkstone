/**
 * `Autosave` 实例的接线（`06` 文档 §4）。
 *
 * 本模块只做三件事：**建实例、接出口、给关窗用**。保存策略（防抖 / maxWait / 串行 /
 * 补偿轮）全在 `lib/autosave.ts` 里，冲突路径的编排在 `conflict-actions.ts` 里 ——
 * 钩子只负责把这两者接起来，所以它自己没有什么需要"小心写"的分支。
 *
 * ## 两个刻意的决定
 *
 * **1）实例生命周期 = 章节生命周期，换章就重建，不复用 `reset(hash)`。**
 * 复用会让上一章的 `mustSave` / `pendingSince` 有机会漏进来，代价是往新章节里写旧章的内容。
 * 重建是更安全的默认；`reset(hash)` 留给步骤 04 的"同一章内重载"。
 *
 * **2）`client` 通过 ref 读，不进依赖数组。**
 * sidecar 崩溃重启后端口会变，`useApiClient` 会重建 `ApiClient`（步骤 01 的设计）。
 * 如果把 `client` 放进依赖，那次重建会把实例连同 `mustSave` 一起丢掉 ——
 * 用户在这几秒里敲的字就**静默消失**了，而且界面还会显示"已保存"。
 * 改成 ref 之后，实例活过重启，那批改动留在 `mustSave` 里，服务回来后重试即可落盘。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChapterContent, ExternalModifiedDetail } from '@inkstone/shared';
import { ApiError, NETWORK_ERROR_CODE, type ApiClient } from '../../lib/api';
import { Autosave, type SaveState } from '../../lib/autosave';
import { applyConflictChoice, type ConflictChoice } from './conflict-actions';
import { flushForQuit, registerQuitFlushTarget } from './quit-flush';
import { describeSaveError, type SaveErrorView } from './save-status';

export type { ConflictChoice };

export interface UseAutosaveInput {
  /** 可以为 null（sidecar 不在）。此时保存会以"网络错误"失败并保留待存内容 */
  client: ApiClient | null;
  workId: string | null;
  /** null = 还没选中章节，此时不建实例 */
  chapter: ChapterContent | null;
  /** 现取当前正文。每渲染都会换引用，只能经 ref 进实例 */
  getMarkdown: () => string;
  /** 把编辑器内容换成给定正文（冲突选「用磁盘版本」与「另存副本」时用） */
  setMarkdown: (markdown: string) => void;
  /**
   * 落盘成功后回报字数，供侧栏**本地更新**那一项（`07` §4.2）。
   *
   * 做成回调而不是让上层读 `savedAt` 之类的间接信号：字数是"服务端算好的那个数"，
   * 上层拿到它就能直接替换列表项，零请求、实时、不闪。
   * 冲突路径也会调它 —— 那条路同样落盘了，只是绕开了状态机。
   *
   * 冲突走 409 信封时可能拿不到字数（`ConflictResolution.wordCount` 为 null），
   * 此时不调。
   */
  onSaved?: (chapterId: string, wordCount: number) => void;
}

export interface UseAutosaveResult {
  state: SaveState;
  savedAt: string | null;
  /** 非 null 表示存在未解决的冲突，界面应弹三选一 */
  conflict: ExternalModifiedDetail | null;
  /** 冲突对话框里「你的版本」的快照（冲突发生那一刻的内容） */
  conflictMine: string;
  error: string | null;
  canRetry: boolean;
  /** 发生过覆盖：磁盘旧版本被备份到这里。一次性提示用 */
  backupPath: string | null;
  retry: () => void;
  dismissBackup: () => void;
  /** 失败会向上抛，由对话框就地显示并**保持三选一界面不关**（§8） */
  resolveConflict: (choice: ConflictChoice) => Promise<void>;
  /** 供步骤 04（切章前 flush）与关窗前调用 */
  handle: Autosave | null;
}

export function useAutosave(input: UseAutosaveInput): UseAutosaveResult {
  const [state, setState] = useState<SaveState>('idle');
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ExternalModifiedDetail | null>(null);
  const [conflictMine, setConflictMine] = useState('');
  const [error, setError] = useState<SaveErrorView | null>(null);
  const [backupPath, setBackupPath] = useState<string | null>(null);
  const [handle, setHandle] = useState<Autosave | null>(null);

  const instanceRef = useRef<Autosave | null>(null);

  /**
   * 一切"每渲染都换引用"的输入都从这里读。
   *
   * 这个 effect 刻意声明在创建实例的 effect **之前**：React 按声明顺序执行 effect，
   * 所以实例创建时读到的 ref 一定是本次渲染的值。
   */
  const inputRef = useRef(input);
  useEffect(() => {
    inputRef.current = input;
  });

  const chapterId = input.chapter?.id ?? null;
  const workId = input.workId;

  useEffect(() => {
    if (chapterId === null || workId === null) return;

    const instance = new Autosave({
      getMarkdown: () => inputRef.current.getMarkdown(),
      baseHash: inputRef.current.chapter?.hash ?? '',
      save: async ({ markdown, baseHash }) => {
        const client = requireClient(inputRef.current.client);
        const res = await client.writeChapter(workId, chapterId, { markdown, baseHash });
        if (res.backupPath !== null) setBackupPath(res.backupPath);
        setSavedAt(res.savedAt);
        inputRef.current.onSaved?.(chapterId, res.wordCount);
        return res;
      },
      onStateChange: (next) => {
        setState(next);
        // 重新开始写就撤掉错误条：它还挂在那里，只会让人以为又失败了。
        if (next === 'saving') setError(null);
      },
      onConflict: (detail) => {
        setConflict(detail);
        setConflictMine(inputRef.current.getMarkdown());
      },
      onError: (err) => setError(describeSaveError(err)),
    });

    instanceRef.current = instance;
    setHandle(instance);
    registerQuitFlushTarget(instance);

    return () => {
      // 先摘掉关窗目标，再销毁。销毁后 `flush()` 会立刻返回 true，
      // 若此时仍有未落盘内容，关窗就会被静默放行 —— 正是 A4 要防的那件事。
      registerQuitFlushTarget(null);
      instance.dispose();
      instanceRef.current = null;
      setHandle(null);
    };
  }, [chapterId, workId]);

  const retry = useCallback(() => {
    setError(null);
    void instanceRef.current?.retry();
  }, []);

  const dismissBackup = useCallback(() => setBackupPath(null), []);

  const resolveConflict = useCallback(
    async (choice: ConflictChoice) => {
      const instance = instanceRef.current;
      const chapter = inputRef.current.chapter;
      if (instance === null || chapter === null || workId === null) return;

      const resolution = await applyConflictChoice(choice, {
        client: requireClient(inputRef.current.client),
        workId,
        chapterId: chapter.id,
        detail: conflict,
        // 现取，不用 conflictMine：对话框打开后编辑器仍可编辑（§8），
        // 用快照会把这几秒里敲的字丢掉。
        mine: inputRef.current.getMarkdown(),
        chapterTitle: chapter.title,
      });

      if (resolution.applyMarkdown !== null) {
        inputRef.current.setMarkdown(resolution.applyMarkdown);
      }
      if (resolution.backupPath !== null) setBackupPath(resolution.backupPath);
      if (resolution.savedAt !== null) setSavedAt(resolution.savedAt);
      // 冲突路径同样落盘了，只是绕开了状态机 —— 侧栏的字数也得跟上
      if (resolution.wordCount !== null) {
        inputRef.current.onSaved?.(chapter.id, resolution.wordCount);
      }
      // 无论走哪条路，解决完之后基准都是磁盘当前版本 —— 这是 `resolve()` 的语义。
      instance.resolve(resolution.hash);
      setConflict(null);
      setError(null);
    },
    [conflict, workId],
  );

  return {
    state,
    savedAt,
    conflict,
    conflictMine,
    error: error?.message ?? null,
    canRetry: error?.canRetry ?? false,
    backupPath,
    retry,
    dismissBackup,
    resolveConflict,
    handle,
  };
}

/**
 * 在应用根部挂一次：主进程问"可以关了吗"，就请当前实例落盘并回话（`06` §7）。
 *
 * 挂在根部而不是 `WorkShell`：作品入口页根本没有 `Autosave` 实例，但主进程照样会问。
 * 那条通路必须存在，否则每次从入口页关闭都要干等满 3 秒超时。
 */
export function useQuitFlush(): void {
  useEffect(() => {
    const bridge = globalThis.window?.inkstone?.app;
    if (bridge === undefined) return;
    return bridge.onBeforeQuit(() => {
      void flushForQuit().then((result) => bridge.sendFlushResult(result));
    });
  }, []);
}

/**
 * sidecar 不在时用网络错误表达。
 *
 * 刻意不抛一个普通 `Error`：`Autosave` 只按 `ApiError` 的 code 分类，
 * 普通错误会落进同一个 `error` 分支，可重试的语义就丢了 ——
 * 而重启期间失败的这批内容恰恰是**最该能重试**的。
 */
function requireClient(client: ApiClient | null): ApiClient {
  if (client === null) {
    throw new ApiError(NETWORK_ERROR_CODE, '本地服务尚未就绪。', 0);
  }
  return client;
}
