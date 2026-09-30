import { useCallback, useEffect, useRef } from 'react';
import type { KeyboardEvent } from 'react';
import type { ChapterSummary } from '@inkstone/shared';
import { ChapterListItem } from './ChapterListItem';
import './chapter.css';

export interface ChapterSidebarProps {
  chapters: ChapterSummary[];
  currentChapterId: string | null;
  loading: boolean;
  error: string | null;
  onSelect: (chapter: ChapterSummary) => void;
  onCreate: () => void;
  onRefresh: () => void;
}

/**
 * 章节侧栏（`07` §4）。
 *
 * 组件本身**不做任何切换判断** —— 点击只是把目标交给 `onSelect`，
 * 时序（flush → 中断判定 → 读取）全在 `chapter-switch.ts` 里。
 * 所以这里可以简单地"点谁就是谁"。
 */
export function ChapterSidebar({
  chapters,
  currentChapterId,
  loading,
  error,
  onSelect,
  onCreate,
  onRefresh,
}: ChapterSidebarProps) {
  const listRef = useRef<HTMLUListElement | null>(null);

  /**
   * 切章后把当前项滚进视野。
   *
   * 用 `block: 'nearest'` 而不是 `'center'`：后者会让整个列表跳动，
   * 而这时用户的注意力在编辑器上，列表动一下只会让人以为点错了。
   */
  useEffect(() => {
    if (currentChapterId === null) return;
    const node = listRef.current?.querySelector('[data-current="true"]');
    node?.scrollIntoView({ block: 'nearest' });
  }, [currentChapterId]);

  /**
   * `↑` / `↓` 切上一章 / 下一章（§4.4）。
   *
   * 按 DOM 里的实际顺序取兄弟节点，不按 `chapters` 数组下标 ——
   * 两者理论上一致，但按 DOM 走就永远不会因为将来插入分组标题而错位。
   */
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLUListElement>) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;

      const buttons = Array.from(
        listRef.current?.querySelectorAll<HTMLButtonElement>('.chapter-item') ?? [],
      );
      if (buttons.length === 0) return;

      const activeIndex = buttons.findIndex((button) => button === document.activeElement);
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const nextIndex =
        activeIndex === -1 ? 0 : Math.min(buttons.length - 1, Math.max(0, activeIndex + step));
      const nextButton = buttons[nextIndex];
      if (nextButton === undefined) return;

      event.preventDefault();
      nextButton.focus();
      const target = chapters[nextIndex];
      if (target !== undefined) onSelect(target);
    },
    [chapters, onSelect],
  );

  return (
    <div className="chapter-sidebar">
      <div className="chapter-sidebar-head">
        <span className="slot-title">章节</span>
        {chapters.length === 0 ? null : <span className="hint">{chapters.length} 章</span>}
        <span className="chapter-sidebar-actions">
          <button
            type="button"
            className="linkish"
            onClick={onRefresh}
            // M0 不做文件监听（`02` §2.4 的决策），所以外部新增的 md 文件
            // 只能靠这个入口出现。说清楚它干什么，比只写"刷新"强。
            title="重新扫描作品目录（外部新增的章节文件要靠它出现）"
          >
            刷新
          </button>
          <button type="button" onClick={onCreate} title="在末尾新建一章">
            新建
          </button>
        </span>
      </div>

      {error === null ? null : (
        <div className="chapter-sidebar-error">
          <p className="inline-error">章节列表读取失败：{error}</p>
          <button type="button" onClick={onRefresh}>
            重试
          </button>
        </div>
      )}

      {chapters.length === 0 ? (
        <EmptyState loading={loading} onCreate={onCreate} />
      ) : (
        <ul className="chapter-list" ref={listRef} onKeyDown={handleKeyDown}>
          {chapters.map((chapter) => (
            <ChapterListItem
              key={chapter.id}
              chapter={chapter}
              current={chapter.id === currentChapterId}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * 空态（§4.3）。
 *
 * 只在两种情况下出现：用户手工删掉了所有章节目录，或作品是旧版本创建的、结构不全。
 * **不自动补建** —— 静默往用户的作品目录里塞文件是不礼貌的。
 */
function EmptyState({ loading, onCreate }: { loading: boolean; onCreate: () => void }) {
  if (loading) {
    return (
      <div className="chapter-empty">
        <span className="spinner" />
        <p className="hint">正在读取章节列表……</p>
      </div>
    );
  }
  return (
    <div className="chapter-empty">
      <p className="hint">这部作品还没有章节。</p>
      <button type="button" onClick={onCreate}>
        新建章节
      </button>
    </div>
  );
}
