/**
 * 章节列表与切章时序的 React 接线（`07` 文档 §4、§5）。
 *
 * 时序本身在 `chapter-switch.ts` 里（纯函数、可测试）；本文件只负责三件事：
 * 加载列表、把结果映射成 React 状态、把中断原因变成用户能看懂的一句话。
 *
 * 所以这里**不该有需要小心写的分支** —— 所有判断都在那个纯函数里。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch } from 'react';
import type { ChapterContent, ChapterSummary } from '@inkstone/shared';
import { describeApiError, type ApiClient } from '../../lib/api';
import type { Autosave } from '../../lib/autosave';
import type { SessionAction } from '../session/session-reducer';
import {
  decideChapterListAction,
  defaultChapterTitle,
  firstChapter,
  patchChapterWordCount,
  sortChapters,
} from './chapter-list';
import { runChapterSwitch, type SwitchGuard } from './chapter-switch';
import { createSwitchingCounter } from './switching-counter';

export interface UseChapterSwitchInput {
  client: ApiClient | null;
  workId: string | null;
  /**
   * 会话里记着的当前章 id。
   *
   * 会话只记**身份**（`ChapterSummary`），正文由本钩子的 `content` 持有 ——
   * 见 `docs/07` v0.2 §11.1 关于这处偏差的说明。
   */
  currentChapterId: string | null;
  /**
   * 当前保存状态机；用于 flush 与判定冲突。
   *
   * 刻意传**取值函数**而不是实例：`useAutosave` 需要 `content`（本钩子的输出），
   * 本钩子又需要 `Autosave`（`useAutosave` 的输出）—— 直接互传在 JS 里是循环依赖，
   * 只能靠 useState 提升到中间层来打破，而那会让 WorkShell 多背一份状态。
   * 取值函数把这个环断在"读的时候才取"，语义上也更准：实例是会在换章时被换掉的。
   */
  getAutosave: () => Autosave | null;
  /** 新旧章正文的落地处 */
  setContent: (content: ChapterContent | null) => void;
  dispatch: Dispatch<SessionAction>;
  /** 被冲突拦下切换时通知外层打开对话框 */
  onBlockedByConflict: () => void;
}

export interface UseChapterSwitchResult {
  chapters: ChapterSummary[];
  listLoading: boolean;
  listError: string | null;
  /** 正在读正文（编辑器显示加载遮罩） */
  switching: boolean;
  /** 切换被中断的原因。null = 无 */
  notice: string | null;
  dismissNotice: () => void;
  switchTo: (target: ChapterSummary) => Promise<void>;
  createChapter: () => Promise<void>;
  /** 手动刷新列表（外部新增了 md 文件时用，会触发服务端重扫目录） */
  refresh: () => Promise<void>;
  /** 保存成功后本地更新该章字数（§4.2） */
  applyWordCount: (chapterId: string, wordCount: number) => void;
}

export function useChapterSwitch(input: UseChapterSwitchInput): UseChapterSwitchResult {
  const [chapters, setChapters] = useState<ChapterSummary[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  /**
   * 「正在切章」的在飞计数（`docs/13` M23）。
   *
   * 用计数而不是布尔值，是因为切章会并发，而**收起遮罩的责任不能落在
   * "最新那次"头上** —— 它可能压根没 proceed（被取代期间用户点回了当前章 → ignored）。
   * 详见 `switching-counter.ts` 的注释。
   *
   * 用 `useState` 的惰性初始化持有（而不是 `useRef` + 渲染期赋值）：
   * 后者在渲染期间写 ref，会被 `react-hooks` 的规则拦下，而实例本身
   * 只该建一次。这里 `setSwitching` 是稳定的 setter，闭包不会过期。
   */
  const [switchingCounter] = useState(() => createSwitchingCounter(() => setSwitching(false)));

  const guardRef = useRef<SwitchGuard>({ token: 0 });
  const loadTokenRef = useRef(0);
  /** 已经自动选过第一章的作品+draft，避免失败后无限重试 */
  const autoSelectedRef = useRef<string | null>(null);

  /**
   * 新建章节的**在飞守卫**（`docs/13` M20）。
   *
   * 没有它，连点两次「新建」会建出两个**同名**章节：两次调用读到的是同一份
   * `chaptersRef.current`，`defaultChapterTitle` 于是算出同一个名字；
   * 而且第二次的 `load` + `switchTo` 会与第一次交错，最后停在哪儿都不确定。
   *
   * 用 ref 而不是 state：守卫必须在**同一批事件里立刻生效**。state 要等下一次渲染
   * 才可见，而连点两次的第二次往往发生在同一个任务里 —— 那时它读到的还是旧值。
   */
  const creatingRef = useRef(false);

  /**
   * 一切"每渲染都换引用"的输入都从这里读。
   *
   * `switchTo` 必须是**稳定引用**：它要传给侧栏的每一项，一旦每渲染换引用，
   * 列表里所有按钮的 props 都会变，长列表会跟着重渲染。
   *
   * 这个 effect 声明在下面所有 effect **之前** —— React 按声明顺序执行，
   * 所以后续 effect 读到的 ref 一定是本次渲染的值。
   */
  const inputRef = useRef(input);
  useEffect(() => {
    inputRef.current = input;
  });

  const chaptersRef = useRef(chapters);
  useEffect(() => {
    chaptersRef.current = chapters;
  });

  const { client, workId } = input;

  const load = useCallback(async (force: boolean): Promise<void> => {
    const current = inputRef.current;
    const token = (loadTokenRef.current += 1);
    const { client, workId } = current;

    // 三种情况分开处理（`docs/13` M21）。最要紧的是 `keep`：
    // sidecar 重启期间 `client` 会短暂为 null，**绝不能**据此清空列表 ——
    // 那会把侧栏闪成「这部作品还没有章节。」+「新建章节」按钮。
    switch (decideChapterListAction(workId, client !== null)) {
      case 'clear':
        setChapters([]);
        setListLoading(false);
        setListError(null);
        return;
      case 'keep':
        // 收掉加载态（上一轮请求可能正卡在半路，`finally` 里因为 token 过期不再兜底），
        // 但 chapters / listError 一律不动：重连后 effect 会再拉一次，那次才更新。
        setListLoading(false);
        return;
      case 'fetch':
        break;
    }

    // 类型收窄。上面 `decideChapterListAction` 已经把这两种情况排除了，
    // 留着是为了让 `client` / `workId` 在下面以非空类型使用（也顺带防御将来改判据）。
    if (client === null || workId === null) return;

    setListLoading(true);
    setListError(null);
    try {
      const items = await client.listChapters(workId, force);
      // 晚到的旧响应丢弃：连着点两次刷新时，先发的那次可能后回来
      if (token !== loadTokenRef.current) return;
      setChapters(sortChapters(items));
    } catch (err) {
      if (token !== loadTokenRef.current) return;
      setListError(describeApiError(err));
    } finally {
      if (token === loadTokenRef.current) setListLoading(false);
    }
  }, []);

  const switchTo = useCallback(
    async (target: ChapterSummary): Promise<void> => {
      const current = inputRef.current;
      const client = current.client;
      const workId = current.workId;
      if (client === null || workId === null) return;
      const autosave = current.getAutosave();

      /** flush 已过、即将开始读正文。被挡下的切换不该闪一下遮罩，所以放在回调里 */
      let proceeded = false;

      const outcome = await runChapterSwitch(
        {
          currentChapterId: current.currentChapterId,
          hasUnsavedChanges: () => autosave?.hasUnsavedChanges() ?? false,
          flush: () => autosave?.flush() ?? Promise.resolve(true),
          saveState: () => autosave?.getState() ?? 'idle',
          readChapter: (chapterId) => client.readChapter(workId, chapterId),
          guard: guardRef.current,
          onProceed: () => {
            proceeded = true;
            switchingCounter.acquire();
            setSwitching(true);
          },
          apply: (summary, content) => {
            // 摘要与正文一起提交，React 合并成一次渲染 → 不存在
            // "内容已换、身份未换"的中间态被观察到
            current.setContent(content);
            current.dispatch({ type: 'chapter/selected', chapter: summary });
          },
        },
        target,
      );

      // ⚠️ 归还必须**无条件**、且在任何早退之前（`docs/13` M23）。
      //
      // 这里曾经是 `if (outcome.kind === 'superseded') return;` 先早退，
      // 把"收起遮罩"留给取代它的那一轮 —— 但那一轮不一定 proceed：
      // 用户等得不耐烦、点回自己原来那章 → `ignored`，全程没开过遮罩。
      // 两次都不收，遮罩就永久盖在编辑器上，界面看起来像卡死。
      // 计数归零才回调 `setSwitching(false)`，并发时最后一个离场的负责收尾。
      if (proceeded) switchingCounter.release();

      // 被取代时**只**丢弃结果：更新的那次切换正在跑，提示与列表刷新都归它管
      if (outcome.kind === 'superseded') return;

      switch (outcome.kind) {
        case 'switched':
          setNotice(null);
          break;
        case 'blocked-save':
          setNotice('当前章节还有内容没能写入磁盘，已阻止切换。请先点状态栏的「重试」。');
          break;
        case 'blocked-conflict':
          current.onBlockedByConflict();
          break;
        case 'failed':
          setNotice(`切换到「${target.title}」失败：${outcome.error}`);
          // 章节被外部删掉了：顺手刷新列表，让侧栏不再显示一个不存在的项
          if (outcome.missing) void load(true);
          break;
        case 'ignored':
          break;
      }
    },
    [load, switchingCounter],
  );

  const createChapter = useCallback(async (): Promise<void> => {
    // 在飞守卫。放在取 `inputRef` **之前**：它要在任何副作用（包括 setNotice）之前生效
    if (creatingRef.current) return;
    const current = inputRef.current;
    const client = current.client;
    const workId = current.workId;
    if (client === null || workId === null) return;

    creatingRef.current = true;
    try {
      setNotice(null);
      let created: ChapterSummary;
      try {
        created = await client.createChapter(workId, {
          title: defaultChapterTitle(chaptersRef.current),
        });
      } catch (err) {
        setNotice(`新建章节失败：${describeApiError(err)}`);
        return;
      }

      // 建的过程中用户可能已经换了作品。那时 `load` / `switchTo` 读的是**新**作品，
      // 拿旧作品返回的 chapter id 去切章只会得到一次 404。直接收手。
      if (inputRef.current.workId !== workId) return;

      // 先刷新列表（新章得出现在侧栏里），再走**同一条**切换路径。
      // 新建也是"切换" —— 忘了先 flush 当前章就会丢字（§6 的坑）。
      await load(false);
      await switchTo(created);
    } finally {
      creatingRef.current = false;
    }
  }, [load, switchTo]);

  const refresh = useCallback((): Promise<void> => load(true), [load]);

  const applyWordCount = useCallback((chapterId: string, wordCount: number) => {
    setChapters((prev) => patchChapterWordCount(prev, chapterId, wordCount));
  }, []);

  const dismissNotice = useCallback(() => setNotice(null), []);

  // 换作品：令牌与自动选章的记忆都要清掉，否则新作品会沿用旧作品的状态
  useEffect(() => {
    guardRef.current.token = 0;
    autoSelectedRef.current = null;
    // 计数一并归零（`reset` 不回调）：在飞的那几次切换之后 release 时会撞上
    // `pending === 0` 的守卫被忽略，不会再把遮罩打开一次。
    switchingCounter.reset();
    setNotice(null);
    setSwitching(false);
  }, [client, workId, switchingCounter]);

  // 列表加载。`client` 进依赖是有意的：sidecar 重启后端口变了，必须重新拉一次
  useEffect(() => {
    void load(false);
  }, [client, workId, load]);

  /**
   * 作品打开后自动选中第一章（`04` §5.2 第 7 步留给后续步骤的那件事）。
   *
   * 用 `autoSelectedRef` 记住"已经选过"，而不是每次 chapters 变化都试一次 ——
   * 后者在读取失败时会变成无限重试，把日志和网络一起打满。
   */
  useEffect(() => {
    if (input.currentChapterId !== null) return;
    if (chapters.length === 0) return;
    const first = firstChapter(chapters);
    if (first === null) return;

    const key = `${workId ?? ''}:${first.id}`;
    if (autoSelectedRef.current === key) return;
    autoSelectedRef.current = key;
    void switchTo(first);
  }, [chapters, input.currentChapterId, switchTo, workId]);

  return {
    chapters,
    listLoading,
    listError,
    switching,
    notice,
    dismissNotice,
    switchTo,
    createChapter,
    refresh,
    applyWordCount,
  };
}
