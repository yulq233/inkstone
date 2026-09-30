import type { ChapterSummary } from '@inkstone/shared';
import { chapterLabel, describeChapterStatus, formatWordCount } from './chapter-list';

export interface ChapterListItemProps {
  chapter: ChapterSummary;
  /** 与 `currentChapterId` 比对而来。**按 id 不按 order** —— 重排后 order 会变 */
  current: boolean;
  onSelect: (chapter: ChapterSummary) => void;
}

/**
 * 侧栏里的一项（`07` §4.1）：`● 第 3 章 · 夜行        1,842 字`。
 *
 * 用 `<button>` 而不是 `<div onClick>`：键盘可聚焦、回车可触发、屏幕阅读器认得，
 * 这些"顺手就有"的能力自己补要花不少代码。
 *
 * 数字与标题**都来自列表项本身**，不额外请求 —— 这是 `ChapterSummary`
 * 刻意带上 `wordCount` 的原因。
 */
export function ChapterListItem({ chapter, current, onSelect }: ChapterListItemProps) {
  const status = describeChapterStatus(chapter.status);
  const label = chapterLabel(chapter);

  return (
    <li className="chapter-item-wrap">
      <button
        type="button"
        className={`chapter-item${current ? ' is-current' : ''}`}
        // 给侧栏的自动滚动用（`scrollIntoView` 要能选到它）
        data-current={current ? 'true' : undefined}
        aria-current={current ? 'true' : undefined}
        title={`${label.text} · ${status.label}`}
        onClick={() => onSelect(chapter)}
      >
        {/* 状态只给一个着色圆点，不给文字 —— 横向空间留给标题（§4.1） */}
        <span className={`chapter-dot tone-${status.tone}`} aria-label={status.label} />
        <span className={`chapter-label${label.muted ? ' is-muted' : ''}`}>{label.text}</span>
        <span className="chapter-words">{formatWordCount(chapter.wordCount)}</span>
      </button>
    </li>
  );
}
