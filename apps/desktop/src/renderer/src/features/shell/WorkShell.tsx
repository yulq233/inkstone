import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChapterContent, ChapterSummary } from '@inkstone/shared';
import {
  setPendingEntryIntent,
  subscribeAppCommand,
  type EntryIntent,
} from '../../lib/app-commands';
import type { Autosave } from '../../lib/autosave';
import { AiCandidatePanel } from '../ai/AiCandidatePanel';
import { EgressConfirmDialog } from '../ai/EgressConfirmDialog';
import { EgressPanel } from '../ai/EgressPanel';
import { PreviewPanel } from '../ai/PreviewPanel';
import { QuickGenPanel } from '../ai/QuickGenPanel';
import { useAiContinue } from '../ai/use-ai-continue';
import { useAiQuick } from '../ai/use-ai-quick';
import { useEgressGate } from '../ai/use-egress-gate';
import type { AiQuickKind } from '@inkstone/shared';
import { ChapterSidebar } from '../chapter/ChapterSidebar';
import { useChapterSwitch } from '../chapter/use-chapter-switch';
import { CodexSidebarPane } from '../codex/CodexSidebarPane';
import '../codex/codex.css';
import { OutlineSidebarPane } from '../outline/OutlineSidebarPane';
import '../outline/outline.css';
import { ConflictDialog } from '../editor/ConflictDialog';
import { EditorPane, type ChapterLoadStatus } from '../editor/EditorPane';
import { SaveErrorBar } from '../editor/SaveErrorBar';
import { BackupNotice, SaveStatusIndicator } from '../editor/SaveStatusIndicator';
import type { EditorHandle } from '../editor/TipTapEditor';
import { useAutosave } from '../editor/use-autosave';
import { useWorkSession } from '../session/WorkSessionProvider';

/**
 * 工作台容器（`04` §3、§10；`07` §3）。
 *
 * 它是三个东西的交汇点，也是唯一知道"当前是哪一章"的地方：
 *
 * | 关注点 | 归属 |
 * |---|---|
 * | 正文与编辑器句柄 | 本组件（`content` + `handleRef`） |
 * | 保存策略与状态 | `useAutosave` |
 * | 列表与切章时序 | `useChapterSwitch` |
 *
 * 两个钩子之间有依赖（保存要看章节、切章要 flush 保存），
 * 用"惰性取值函数 + 稳定的 `applyWordCount`"把环解开，而不是把状态提到中间层。
 */
export function WorkShell() {
  const { state, dispatch, client } = useWorkSession();

  /** 编辑器句柄：正文的唯一出处。用 ref 而不是 state —— 只有读写时才用它，不参与渲染 */
  const handleRef = useRef<EditorHandle | null>(null);
  const onHandleReady = useCallback((handle: EditorHandle | null) => {
    handleRef.current = handle;
  }, []);

  // 这两个回调必须是**稳定引用**：它们进的是 Autosave 的 opts（只构造一次）。
  const getMarkdown = useCallback(() => handleRef.current?.getMarkdown().markdown ?? '', []);
  const setMarkdown = useCallback((markdown: string) => {
    handleRef.current?.setMarkdown(markdown);
  }, []);

  /**
   * 当前章正文。
   *
   * 切章时序成功时才被写入（摘要与正文同一次提交，见 `chapter-switch.ts` 的 `apply`）。
   * 放在本组件而不是会话 reducer 里：正文是"页面的数据"，不是"应用的会话身份"，
   * 而且它每次切章都会整块换掉，进 reducer 只会让 `session-reducer` 的单测跟着变复杂。
   */
  const [content, setContent] = useState<ChapterContent | null>(null);

  const workId = state.kind === 'ready' ? state.work.id : null;
  const currentChapterId = state.kind === 'ready' ? (state.chapter?.id ?? null) : null;

  /**
   * 惰性取句柄的**稳定**函数。
   *
   * 必须 `useCallback` 且依赖为空：它被 `useAiContinue` 的各个回调闭包着，
   * 一路传到那个"换章就作废"的 effect 依赖里（`reset` ← `clearGhostNow` ← 本函数）。
   * 每次渲染换一个新函数，那条 cleanup 就会**每渲染一次跑一次** —— 也就是
   * 生成一开始就被自己中止，症状是"按了 Ctrl+Enter 立刻回到待机"。
   */
  const getHandle = useCallback(() => handleRef.current, []);

  /**
   * 首次把内容发往某家非本机供应商时的确认闸门（`docs/11` §2.3）。
   *
   * 声明在两个 AI 钩子**之前**：它们都要拿 `gate.check`。闸门自己不做任何生成，
   * 只回答"这次要不要先问一句"（判据在服务端算，见 `use-egress-gate.ts`）。
   */
  const gate = useEgressGate({ client, workId, chapterId: currentChapterId });

  const ai = useAiContinue({
    client,
    workId,
    chapterId: currentChapterId,
    getHandle,
    checkEgress: gate.check,
  });

  const quick = useAiQuick({
    client,
    workId,
    chapterId: currentChapterId,
    getHandle,
    checkEgress: gate.check,
  });

  const autosaveRef = useRef<Autosave | null>(null);
  const [conflictOpen, setConflictOpen] = useState(false);
  const openConflict = useCallback(() => setConflictOpen(true), []);

  // ---- 切章（列表 + 时序）。声明在前：useAutosave 需要它的 applyWordCount ----
  const {
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
  } = useChapterSwitch({
    client,
    workId,
    currentChapterId,
    // 惰性取值：实例是 state（`autosave.handle`），每次换章都会被换掉，
    // 传实例本身会让本钩子持有过期的那一个。
    getAutosave: () => autosaveRef.current,
    setContent,
    dispatch,
    onBlockedByConflict: openConflict,
  });

  /**
   * 侧栏要的是「发出意图」，不是「等它做完」。
   *
   * 这三个函数本身是 `Promise<void>`，而 `ChapterSidebar` 的 props 声明为 `() => void`
   * —— 直接透传会让 `onClick` 拿到一个返回 Promise 的处理函数：`no-misused-promises`
   * 拦的正是这种写法，因为它一旦 reject 就是 unhandled rejection，而 React 不会替你
   * 兜。这里显式 `void` 掉，把「不关心完成」这个语义写在代码里；失败与进度改由
   * `listError` / `notice` 表达。
   *
   * 用 `useCallback` 而不是内联箭头：`switchTo` 的注释（`use-chapter-switch.ts` §82）
   * 要求它是稳定引用，每次渲染换一个会让侧栏每一项都重渲染。
   */
  const handleSelect = useCallback(
    (chapter: ChapterSummary) => {
      void switchTo(chapter);
    },
    [switchTo],
  );
  const handleCreate = useCallback(() => {
    void createChapter();
  }, [createChapter]);
  const handleRefresh = useCallback(() => {
    void refresh();
  }, [refresh]);

  // ---- 侧栏 tab（章节 / 设定 / 大纲）----
  // ⚠️ 常挂载原则（docs/11 §7.3）：tab 内容都渲染、用 CSS 隐藏，别条件卸载
  // —— 章节列表被卸载再挂回，滚动位置与选中态会丢，还会多拉一轮章节清单。
  // 设定/大纲 pane 用 `key={workId}` 让切作品时整个重挂载（重置清单/详情/表单），
  // 而不是在 effect 里手动清状态。
  const [sidebarTab, setSidebarTab] = useState<'chapters' | 'codex' | 'outline'>('chapters');

  // ---- 保存 ----
  const autosave = useAutosave({
    client,
    workId,
    chapter: content,
    getMarkdown,
    setMarkdown,
    onSaved: applyWordCount,
  });

  useEffect(() => {
    autosaveRef.current = autosave.handle;
  }, [autosave.handle]);

  // ---- 菜单命令（`09` §4.4）----

  /** 「关闭作品被拦下」的原因。与 `useChapterSwitch` 的 `notice` 共用同一条通知位 */
  const [closeBlocked, setCloseBlocked] = useState<string | null>(null);

  /**
   * 关闭作品 = **先落盘，再离开**。
   *
   * 不 flush 直接 `work/leave` 是一条**静默丢字**的路径：离开会卸载本组件，
   * `useAutosave` 的清理函数随即 `dispose()` 掉实例，防抖窗口里那批还没写盘的改动
   * 就跟着实例一起没了（`07` §3 的时序只覆盖"切章前 flush"，没覆盖"离开作品"）。
   *
   * flush 失败（冲突未解决 / 保存出错）时**不离开**：那时离开等于把用户的正文丢掉，
   * 而他看到的只是"界面回到了入口页"，完全没有线索。改成留在原地并说明原因。
   */
  const closeWork = useCallback(
    async (intent: EntryIntent | null): Promise<void> => {
      const handle = autosaveRef.current;
      if (handle !== null) {
        let flushed: boolean;
        try {
          flushed = await handle.flush();
        } catch {
          // `flush()` 正常不抛（落盘的错误码已在 `Autosave` 内部分类）。但它序列化正文那一步
          // 在 try 之外，一旦抛（文档里进了 schema 应付不来的节点就会），我们真的不知道
          // 内容落没落盘 —— 而两个调用点都是 `void closeWork(...)`，接不住 rejection。
          // 保守按"没落盘"处理，与切章那条路径（`chapter-switch.ts`）同一个口径。
          flushed = false;
        }
        if (!flushed) {
          setCloseBlocked('当前章节还有未落盘的内容（保存出错或存在冲突），先处理完再关闭作品。');
          return;
        }
      }
      // 意图必须**在离开之前**记下：入口页要到下一轮渲染才挂载，那时这条命令早发完了
      if (intent !== null) setPendingEntryIntent(intent);
      setCloseBlocked(null);
      dispatch({ type: 'work/leave' });
    },
    [dispatch],
  );

  /**
   * 只认领本屏幕拿得到的那几条命令。
   *
   * 「新建 / 打开作品」在作品内触发时先离开当前作品，再由入口页取走那个意图 ——
   * 这里不直接干活，因为入口页此刻还不存在（见 `lib/app-commands.ts`）。
   */
  useEffect(
    () =>
      subscribeAppCommand((command) => {
        switch (command) {
          case 'editor:undo':
            handleRef.current?.undo();
            break;
          case 'editor:redo':
            handleRef.current?.redo();
            break;
          case 'work:close':
            void closeWork(null);
            break;
          case 'work:new':
            void closeWork('new');
            break;
          case 'work:open':
            void closeWork('open');
            break;
          case 'settings:openPanel':
            // 「设置」由常挂载的 SettingsPanel 自己认领，这里刻意什么都不做
            break;
        }
      }),
    [closeWork],
  );

  // ---- 冲突对话框 ----
  /**
   * 冲突出现时**自动弹出**（否则一个窄条上的状态变化太容易被漏掉），
   * 但允许「稍后处理」关掉它继续写 —— `06` §8 要求"对话框弹出后编辑器仍可编辑"，
   * 而全屏遮罩不放行就等于把编辑锁死。关掉后点状态指示可以再打开。
   *
   * 切章被冲突拦下时也走这里（`onBlockedByConflict` → `setConflictOpen(true)`）。
   */
  const wasConflicting = useRef(false);
  useEffect(() => {
    const conflicting = autosave.conflict !== null;
    if (conflicting && !wasConflicting.current) setConflictOpen(true);
    if (!conflicting) setConflictOpen(false);
    wasConflicting.current = conflicting;

    // 冲突与保存错误一解除，「关闭作品被拦下」的理由就不成立了。不清的话那条提示会一直挂着
    // 直到用户手动点掉 —— 而它描述的是一件已经过去的事（`setCloseBlocked` 不在依赖里，
    // 所以这条只在冲突/错误状态**变化**时才跑，不会误清刚设上去的那条）。
    if (!conflicting && autosave.state !== 'error') setCloseBlocked(null);
  }, [autosave.conflict, autosave.state]);

  /**
   * 正在打开。
   *
   * ⚠️ `AppRoutes` 现在把 `opening` 也交给**入口页**渲染（`docs/13` M19：
   * 书架上的「打开中……」与条目级失败提示都活在那个组件里，换成这一屏就把它们
   * 一起卸载了）。所以这个分支**当前走不到** —— 保留它是因为 `SessionState` 里
   * `opening` 是合法状态，而"兜底渲染成空白"是最差的失败方式；
   * 想改回全屏卡片，把 `AppRoutes` 的 `opening` 分支挪回这里即可。
   */
  if (state.kind === 'opening') {
    return (
      <div className="center-stage">
        <div className="card">
          <div className="row" style={{ marginBottom: 8 }}>
            <span className="spinner" />
            <h1>正在打开《{state.title}》</h1>
          </div>
          <p>正在读取作品目录与元信息……</p>
        </div>
      </div>
    );
  }

  if (state.kind === 'failed') {
    return (
      <div className="center-stage">
        <div className="card">
          <div className="row" style={{ marginBottom: 8 }}>
            <h1>打开作品失败</h1>
            <span className="pill bad">未打开</span>
          </div>
          {state.work ? <p>作品：《{state.work.title}》</p> : null}
          <p>{state.error}</p>
          <div className="actions">
            {/* 刻意不做自动重试：sidecar 崩溃期间盲目重试只会刷出一串同样的错误 */}
            <button type="button" onClick={() => dispatch({ type: 'work/leave' })}>
              返回作品入口
            </button>
          </div>
        </div>
      </div>
    );
  }

  // entry 由入口页负责，不会走到这里
  if (state.kind !== 'ready') return null;

  const { work, chapter } = state;

  /**
   * 编辑器的占位状态。
   *
   * 与正文解耦：`content !== null` 就是 ready，其余情况按"列表出错 > 正在加载 > 空作品"排序。
   * 列表出错要优先显示 —— 那是用户唯一能拿到的线索。
   */
  const editorStatus: ChapterLoadStatus =
    content !== null
      ? 'ready'
      : listError !== null
        ? 'error'
        : listLoading || switching
          ? 'loading'
          : 'idle';

  return (
    <div className="work-shell">
      <header className="work-header">
        <div className="col">
          <strong className="work-title">{work.title}</strong>
          <span className="hint">
            {work.author || '未署名'} · {work.chapterCount} 章 · {work.totalWords} 字
            {work.wordGoal > 0 ? ` · 目标 ${work.wordGoal} 字` : ''}
          </span>
        </div>
        <div className="row">
          <SaveStatusIndicator
            state={autosave.state}
            savedAt={autosave.savedAt}
            onClick={autosave.conflict === null ? undefined : openConflict}
          />
          <span className="pill">{chapter ? chapter.title : '尚未选择章节'}</span>
          {/* 与菜单的「关闭作品」同一条路径：都要先落盘再离开，不能只是切状态 */}
          <button type="button" onClick={() => void closeWork(null)}>
            返回入口
          </button>
        </div>
      </header>

      <div className="work-body">
        <aside className="work-sidebar sidebar-host">
          <div className="sidebar-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={sidebarTab === 'chapters'}
              className={sidebarTab === 'chapters' ? 'sidebar-tab active' : 'sidebar-tab'}
              onClick={() => setSidebarTab('chapters')}
            >
              章节
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={sidebarTab === 'codex'}
              className={sidebarTab === 'codex' ? 'sidebar-tab active' : 'sidebar-tab'}
              onClick={() => setSidebarTab('codex')}
            >
              设定
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={sidebarTab === 'outline'}
              className={sidebarTab === 'outline' ? 'sidebar-tab active' : 'sidebar-tab'}
              onClick={() => setSidebarTab('outline')}
            >
              大纲
            </button>
          </div>
          <div className={sidebarTab === 'chapters' ? 'sidebar-pane' : 'sidebar-pane hidden'}>
            <ChapterSidebar
              chapters={chapters}
              currentChapterId={currentChapterId}
              loading={listLoading}
              error={listError}
              onSelect={handleSelect}
              onCreate={handleCreate}
              onRefresh={handleRefresh}
            />
          </div>
          <div className={sidebarTab === 'codex' ? 'sidebar-pane' : 'sidebar-pane hidden'}>
            <CodexSidebarPane key={workId ?? 'no-work'} client={client} workId={workId} />
          </div>
          <div className={sidebarTab === 'outline' ? 'sidebar-pane' : 'sidebar-pane hidden'}>
            <OutlineSidebarPane
              key={workId ?? 'no-work'}
              client={client}
              workId={workId}
              chapterId={currentChapterId}
            />
          </div>
        </aside>
        <main className="work-content editor-host">
          <div className="editor-stack">
            {autosave.backupPath === null ? null : (
              <BackupNotice backupPath={autosave.backupPath} onDismiss={autosave.dismissBackup} />
            )}
            {autosave.error === null ? null : (
              <SaveErrorBar
                message={autosave.error}
                canRetry={autosave.canRetry}
                onRetry={autosave.retry}
              />
            )}
            {/* 切章被拦下（旧章没落盘 / 冲突）、关闭作品被拦下：一句人能看懂的话，
                否则用户只会觉得"点了没反应"。两条原因共用这一处通知位 —— 它们天然互斥 */}
            {(notice ?? closeBlocked) === null ? null : (
              <div className="shell-notice" role="alert">
                <span className="shell-notice-text">{notice ?? closeBlocked}</span>
                <button
                  type="button"
                  className="linkish"
                  onClick={() => {
                    dismissNotice();
                    setCloseBlocked(null);
                  }}
                >
                  知道了
                </button>
              </div>
            )}
            <AiCandidatePanel
              snapshot={ai.snapshot}
              onStop={ai.stop}
              onAccept={ai.accept}
              onDiscard={ai.discard}
              onRetry={ai.retry}
            />
            <EgressPanel client={client} workId={workId} />
            {/* 「将发送什么」的常驻入口（§6.4 / §6.7）。落在工作台内与 `EgressPanel`
                同一个理由：它要 `chapterId` 与光标上下文才能产出真实 payload（D-10） */}
            <PreviewPanel
              client={client}
              workId={workId}
              chapterId={currentChapterId}
              getHandle={getHandle}
            />
            <EditorPane
              chapter={content}
              status={editorStatus}
              error={listError}
              switching={switching}
              onChange={() => autosave.handle?.onChange()}
              onHandleReady={onHandleReady}
              onContinue={() => ai.start()}
              onSlashContinue={() => ai.start()}
              onSlashQuick={(kind) => quick.start(kind as AiQuickKind)}
            />
          </div>
        </main>
      </div>

      <QuickGenPanel
        snapshot={quick.snapshot}
        onStop={quick.stop}
        onInsert={quick.insert}
        onClose={quick.close}
      />

      {/* 首次云端确认卡（§2.3）。放在最外层是因为它可能在任何一次生成之前出现
          （续写与快捷生成共用同一个闸门），而不是挂在某一个面板里面 */}
      {gate.pending === null ? null : (
        <EgressConfirmDialog slot={gate.pending} onConfirm={gate.confirm} onCancel={gate.cancel} />
      )}

      {autosave.conflict !== null && conflictOpen ? (
        <ConflictDialog
          detail={autosave.conflict}
          mine={autosave.conflictMine}
          onDismiss={() => setConflictOpen(false)}
          onChoose={autosave.resolveConflict}
        />
      ) : null}
    </div>
  );
}
