import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { countWords, type ChapterContent, type WordCount } from '@inkstone/shared';
import type { AdapterWarning } from '@inkstone/md-adapter';
import { createCoalescer, type Coalescer } from '../../lib/coalescer';
import type { SlashCommandId } from '../ai/slash-commands';
import { AdapterWarningsBar } from './AdapterWarningsBar';
import { TipTapEditor, type EditorHandle } from './TipTapEditor';
import { WordCountBar } from './WordCountBar';
import { dedupeWarnings, sameWarnings } from './warning-text';
import './editor.css';

/**
 * 字数与导出告警的重算延迟（`docs/13` M22）。
 *
 * 200ms 是个体感阈值：短到"停下来看一眼字数"时数字已经是对的，
 * 长到能把连续打字期间的中间态全部合并掉。取固定值而不做自适应，
 * 是因为这里不值得引入复杂度 —— 最坏情况也只是每 200ms 一次全量序列化。
 */
const METRICS_DELAY_MS = 200;

/**
 * 正文的载入状态。**这个类型定义在消费方（本组件）而不是生产方** ——
 * 它描述的是"编辑器要显示哪种占位"，是编辑器的词汇，不是章节数据的属性。
 * （步骤 02 它曾放在 `use-chapter-loader.ts` 里；那个文件在步骤 04 被切章时序取代。）
 */
export type ChapterLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface EditorPaneProps {
  /** 当前章节正文。null = 尚未载入（**编辑器不挂载**，避免 setMarkdown 打到空实例上） */
  chapter: ChapterContent | null;
  status: ChapterLoadStatus;
  error: string | null;
  /**
   * 正在切章（读正文中）。显示遮罩并**挡住编辑** —— 见下方注释。
   */
  switching?: boolean;
  /** 内容变化。步骤 03 已接上 `Autosave.onChange` */
  onChange?: () => void;
  /** 编辑器就绪 / 卸载（卸载时传 null） */
  onHandleReady?: (handle: EditorHandle | null) => void;
  /**
   * `Ctrl/Cmd + Enter`：在光标处续写。
   *
   * 从这一层往下透传，是因为它必须注册在**编辑器**的 keymap 上
   * （`features/ai/shortcuts.ts` 有理由），而快捷键要触发的编排在 `WorkShell`
   * —— 只有那里同时知道作品、章节与 sidecar 客户端。
   */
  onContinue?: () => void;
  /** 斜杠菜单选中 `/续写`。 */
  onSlashContinue?: () => void;
  /** 斜杠菜单选中某个快捷 kind。 */
  onSlashQuick?: (kind: SlashCommandId) => void;
}

/**
 * 编辑器面板（`05` §3）：告警条 + 编辑器 + 字数条。
 *
 * 自身**不持有** `Autosave`、不处理切章、不认识 `ApiClient` —— 它只回答
 * "给我一章正文，我给你一块能写的区域"。
 *
 * 切章时把正文推进编辑器这件事也在这里（`chapter` 变化 → `setMarkdown`），
 * 而不是在切章时序里多调一次：**编辑器内容只能有一个写入者**，
 * 否则 步骤 04 的时序与这里的 effect 会各写一遍，将来很难判断哪次生效。
 */
export function EditorPane({
  chapter,
  status,
  error,
  switching = false,
  onChange,
  onHandleReady,
  onContinue,
  onSlashContinue,
  onSlashQuick,
}: EditorPaneProps) {
  /** 载入侧（fromMd）的告警：只在下次 setMarkdown 时重算，**不随编辑消失** */
  const [loadWarnings, setLoadWarnings] = useState<AdapterWarning[]>([]);
  /** 导出侧（toMd）的告警：每次编辑重算。理论上恒为空（扩展集受白名单约束） */
  const [exportWarnings, setExportWarnings] = useState<AdapterWarning[]>([]);
  const [wordCount, setWordCount] = useState<WordCount | null>(null);
  const [editorReady, setEditorReady] = useState(false);

  const handleRef = useRef<EditorHandle | null>(null);

  /**
   * 重算一次字数与导出告警（`docs/13` M22）。
   *
   * 拆成独立的 `useCallback` 是因为它要读 `handleRef`（渲染期读 ref 违规），
   * 而它又被下面那个 effect 捕获。deps 为空 → 引用稳定，实例只建一个。
   */
  const recomputeMetrics = useCallback(() => {
    const handle = handleRef.current;
    if (handle === null) return;
    // 字数必须用**序列化结果**算，不能用 doc.textContent：标题的 `# `、
    // 引用的 `> `、转义反斜杠都不在正文里，两个口径必然对不上，
    // 而 sidecar 写进 meta.json 的是 markdown 口径。
    // 告警与字数取同一次序列化的结果，两者才不会互相矛盾。
    const { markdown, warnings } = handle.getMarkdown();
    setWordCount(countWords(markdown));
    // 内容没变就把旧数组还回去：导出侧告警绝大多数时候是空数组，
    // 换个新引用会让下游的 `useMemo`（去重）与告警条白重渲染一次。
    setExportWarnings((prev) => (sameWarnings(prev, warnings) ? prev : warnings));
  }, []);

  /**
   * 把上面那次重算合并到最多每 200ms 一次（`docs/13` M22）。
   *
   * 每次输入都跑两趟 O(全文)：一次全量 `toMd`、一次 `countWords`。几万字的章节
   * 连打十个字就是二十趟，掉帧掉在**打字**这条最敏感的路径上。而这两个值都只是
   * 给人看的近似值，合并到最多每 200ms 一次，用户完全无感。
   *
   * 在 **effect 里**创建，而不是 `useState` 惰性初始化：创建时要捕获
   * `recomputeMetrics`，而它内部读 `handleRef` —— 渲染期引用这样的函数会被
   * `react-hooks/refs` 判成"渲染期访问 ref"。effect 与事件回调里读写 ref 才是合法位置。
   * `recomputeMetrics` 的 deps 为空 → 这个 effect 只跑一次，实例是稳定的。
   */
  const metricsRef = useRef<Coalescer | null>(null);
  useEffect(() => {
    const coalescer = createCoalescer(METRICS_DELAY_MS, recomputeMetrics);
    metricsRef.current = coalescer;
    return () => {
      metricsRef.current = null;
      // 取消尚未触发的重算，否则定时器到点会往一个已经不在的组件里 setState。
      coalescer.cancel();
    };
  }, [recomputeMetrics]);

  const handleReady = useCallback(
    (handle: EditorHandle) => {
      handleRef.current = handle;
      setEditorReady(true);
      onHandleReady?.(handle);
    },
    [onHandleReady],
  );

  // 卸载时把 handle 收回去：上层若还拿着它去保存，写的就是一个已销毁的编辑器。
  useEffect(
    () => () => {
      handleRef.current = null;
      setEditorReady(false);
      onHandleReady?.(null);
    },
    [onHandleReady],
  );

  /**
   * 载入 / 切章。
   *
   * `setMarkdown` 内部用 `{ emitUpdate: false }`，所以这次灌入**不会**触发 `onUpdate`
   * —— "打开一章"与"用户改了一笔"在 `Autosave` 眼里必须是两件事。
   * 漏掉它的话，切章会用**旧 baseHash** 立刻发一次 PUT，弹出莫名其妙的冲突对话框。
   */
  useEffect(() => {
    const handle = handleRef.current;
    if (handle === null || chapter === null) return;
    const { warnings } = handle.setMarkdown(chapter.markdown);
    setLoadWarnings(warnings);
    setExportWarnings([]);
    setWordCount(countWords(chapter.markdown));
    handle.focusStart();
    // editorReady 进依赖：章节先到、编辑器后就绪时，这一次载入不能丢。
  }, [chapter, editorReady]);

  const handleChange = useCallback(() => {
    // 重算降频（`docs/13` M22），但 `onChange` → `Autosave` 必须**每次**都调：
    // 保存节流是 Autosave 自己的事，这里漏掉一次就是漏掉一个待保存标记。
    metricsRef.current?.schedule();
    onChange?.();
  }, [onChange]);

  const warnings = useMemo(
    () => dedupeWarnings([...loadWarnings, ...exportWarnings]),
    [loadWarnings, exportWarnings],
  );

  if (chapter === null) {
    return (
      <div className="editor-pane">
        <EditorPlaceholder status={status} error={error} />
      </div>
    );
  }

  return (
    <div className="editor-pane">
      <AdapterWarningsBar warnings={warnings} markdown={chapter.markdown} />
      <TipTapEditor
        onChange={handleChange}
        onReady={handleReady}
        onContinue={onContinue}
        onSlashContinue={onSlashContinue}
        onSlashQuick={onSlashQuick}
        // 遮罩期**同时**关掉可编辑（`docs/13` M17）。遮罩只挡鼠标，
        // 键盘仍能落进此刻还在编辑器里的**旧章正文**（见下面的注释）。
        editable={!switching}
      />
      <WordCountBar count={wordCount} />
      {/*
        切章遮罩。**必须挡住编辑**，不只是视觉提示：
        读大章节可能耗时，而此时代码还没来得及把旧章的 `content` 换成新的 ——
        用户在这段时间里敲的字会写进**正在被切走的旧章**（并且用的是旧 baseHash），
        紧接着编辑器内容被整体替换，这段输入就没了。

        两层缺一不可：这层 `inset:0` 的遮罩挡鼠标，`editable={!switching}` 挡键盘。
        上一条曾经只写在注释里（`editable` 从来没被传过），所以聚焦在正文里直接敲键
        仍然进得去 —— 见 `docs/13` M17。
      */}
      {switching ? (
        <div className="editor-mask">
          <span className="spinner" />
          <span className="hint">正在载入章节……</span>
        </div>
      ) : null}
    </div>
  );
}

function EditorPlaceholder({ status, error }: { status: ChapterLoadStatus; error: string | null }) {
  if (status === 'error') {
    return (
      <div className="editor-placeholder">
        <p className="inline-error">章节载入失败：{error}</p>
      </div>
    );
  }
  if (status === 'idle') {
    return (
      <div className="editor-placeholder">
        <p className="hint">这部作品还没有章节。</p>
      </div>
    );
  }
  return (
    <div className="editor-placeholder">
      <span className="spinner" />
      <p className="hint">正在载入章节……</p>
    </div>
  );
}
