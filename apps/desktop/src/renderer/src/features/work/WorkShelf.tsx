import type { RecentWork } from '@inkstone/shared';
import { coverGlyph, shelfCardStatus } from './shelf-view';
import { formatLastOpened, type OpenFailure } from './use-work-entry';

export interface WorkShelfProps {
  items: RecentWork[];
  /** 正在打开的那一本；null 表示空闲 */
  openingPath: string | null;
  failure: OpenFailure | null;
  canOpen: boolean;
  onOpen: (rootPath: string, title: string) => void;
  onForget: (rootPath: string) => void;
}

/**
 * 书架本体（`04` §11）。
 *
 * 一张卡片 = 一本书：封面色块上是书名首字，下面是书名、目录、上次打开时间。
 * **刻意不显示章节数与字数** —— `RecentWork` 里没有这两个字段，硬要显示就得扫每本书的
 * 目录（理由见 `shelf-view.ts` 的文件头）。
 *
 * `exists` 由 sidecar 读取时现算，前端不缓存 —— 缓存会让用户在文件管理器里挪完目录后，
 * 卡片仍显示"可用"，点进去才报错（`04` §5.3）。这里只负责把它呈现出来。
 */
export function WorkShelf({
  items,
  openingPath,
  failure,
  canOpen,
  onOpen,
  onForget,
}: WorkShelfProps) {
  return (
    <ul className="shelf">
      {items.map((item) => {
        const opening = openingPath === item.rootPath;
        const status = shelfCardStatus({
          opening,
          // 失败信息按 rootPath 认领：别人的失败不该染红这一张卡
          failureMessage: failure?.rootPath === item.rootPath ? failure.message : null,
          exists: item.exists,
          lastOpenedText: formatLastOpened(item.lastOpenedAt),
        });

        return (
          <li key={item.rootPath} className={status.bad ? 'shelf-card gone' : 'shelf-card'}>
            <button
              type="button"
              className="shelf-open"
              onClick={() => onOpen(item.rootPath, item.title)}
              disabled={!canOpen || opening}
              // 路径在卡片上是被截断的，悬停能看全 —— 两本同名书靠它区分
              title={item.rootPath}
            >
              <span className="shelf-cover" aria-hidden="true">
                {coverGlyph(item.title)}
              </span>
              <span className="shelf-title">{item.title}</span>
              <span className="shelf-path path-text">{item.rootPath}</span>
              <span className={status.bad ? 'shelf-meta bad' : 'shelf-meta'}>{status.text}</span>
            </button>
            {/* 不自动清理：用户可能只是把目录挪到了别处，回头还要用 */}
            {status.bad ? (
              <button
                type="button"
                className="shelf-forget"
                onClick={() => onForget(item.rootPath)}
              >
                从列表移除
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
