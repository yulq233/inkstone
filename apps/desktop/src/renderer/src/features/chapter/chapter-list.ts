/**
 * 章节列表的纯操作（`07` 文档 §4）。
 *
 * 抽出来的理由和 `chapter-switch.ts` 一样：渲染进程的测试环境是 `node`，
 * 组件渲染测不了。凡是"算错了会让人看到错数字"的逻辑，都放到这里能被断言。
 *
 * 全部返回**新数组**，不原地改 —— 后者会让 React 看不到变化（同一个引用），
 * 症状是"保存完了侧栏字数不变"。
 */

import type { ChapterStatus, ChapterSummary } from '@inkstone/shared';

/**
 * 按 `order` 升序。
 *
 * 服务端已经按目录名（含零填充序号）排好序了（`repo.py` 的 `_scan_chapters`），
 * 所以这里是**防御性**的：一旦将来服务端换了排序依据（比如按 mtime），
 * 侧栏会安静地乱序，而那种 bug 看起来像"章节丢了"。
 */
export function sortChapters(chapters: ChapterSummary[]): ChapterSummary[] {
  return [...chapters].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/** 第一章。空列表返回 null —— 界面据此显示空态，**不自动补建**（§4.3）。 */
export function firstChapter(chapters: ChapterSummary[]): ChapterSummary | null {
  const sorted = sortChapters(chapters);
  return sorted.length === 0 ? null : sorted[0];
}

/**
 * 保存成功后本地更新某一章的字数（§4.2）。
 *
 * 为什么是本地更新而不是重新拉列表：每次保存完都 `listChapters` 会让侧栏
 * 在打字过程中反复闪动；完全不更新用户又看不到进度。本地更新两头都躲开。
 *
 * **按 `id` 匹配，不按 `order`** —— 重排后 `order` 会变，按它匹配会改错项。
 */
export function patchChapterWordCount(
  chapters: ChapterSummary[],
  chapterId: string,
  wordCount: number,
): ChapterSummary[] {
  let changed = false;
  const next = chapters.map((chapter) => {
    if (chapter.id !== chapterId || chapter.wordCount === wordCount) return chapter;
    changed = true;
    return { ...chapter, wordCount };
  });
  // 没有实际变化就返回原引用：避免调用方白白触发一次渲染
  return changed ? next : chapters;
}

export type ChapterListAction =
  /** 没打开作品：列表本就该是空的 */
  | 'clear'
  /** 开着作品、sidecar 暂时不在：**保留**上一份列表 */
  | 'keep'
  /** 正常：去拉一份新的 */
  | 'fetch';

/**
 * 这一次该对章节列表做什么（`docs/13` M21）。
 *
 * 抽成纯函数的理由与文件头一样：症状是"列表闪空"，但它由钩子里的状态迁移造成，
 * 而 node 环境（无 jsdom）测不到迁移。把**判断**拿出来，就能钉住。
 *
 * `keep` 那一档是这次修复的重点。sidecar 崩溃自愈是**设计内的常态**：
 * 重启后端口会变（每次 `bind 127.0.0.1:0`），所以 `useApiClient` 必须先把
 * `client` 置 `null`、拿到新连接信息后再重建。两步之间只隔一次异步取连接信息，
 * 但足以让「重新拉列表」的 effect 跑一遍。那一遍若按"没有 client 就当没有作品"
 * 处理，侧栏会瞬间变成「这部作品还没有章节。」外加一个「新建章节」按钮 ——
 * 用户的第一反应是稿子被删了，而不是"服务在重启"。
 *
 * 判据用 `workId` 而不是"有没有 client"：**作品身份**才是"该不该留着列表"的分界线。
 * 没打开作品（`workId === null`）时清空是对的 —— 上一步的列表不该漏给下一部作品。
 */
export function decideChapterListAction(
  workId: string | null,
  hasClient: boolean,
): ChapterListAction {
  if (workId === null) return 'clear';
  if (!hasClient) return 'keep';
  return 'fetch';
}

/** 新章的占位标题（§6）。用户随后在正文里改标题，服务端保存时会从首行同步。 */
export function defaultChapterTitle(chapters: ChapterSummary[]): string {
  let max = 0;
  for (const chapter of chapters) {
    if (chapter.order > max) max = chapter.order;
  }
  return `第 ${max + 1} 章`;
}

export interface ChapterStatusView {
  label: string;
  tone: 'draft' | 'revising' | 'done';
}

/**
 * 状态标签。M0 **只读展示**（§1.2），所以这里只回答"怎么显示"。
 *
 * `default` 分支刻意保留：服务端 `CHAPTER_STATUSES` 若将来多一个值，
 * 前端会安静地显示成"草稿"而不是崩掉 —— 但类型上 `status` 是收窄的联合，
 * 所以这里用 `default` 只是兜底，不是预期路径。
 */
export function describeChapterStatus(status: ChapterStatus): ChapterStatusView {
  switch (status) {
    case 'revising':
      return { label: '修改中', tone: 'revising' };
    case 'done':
      return { label: '已完成', tone: 'done' };
    default:
      return { label: '草稿', tone: 'draft' };
  }
}

/** 千分位。与 `WordCountBar` / `ConflictDialog` 同口径（刻意各自保留三行，不抽公共模块）。 */
export function formatWordCount(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 服务端在正文首行没有 ATX 标题时给的回退值（`domain/chapter.py` 的 `TITLE_FALLBACK`）。 */
export const TITLE_FALLBACK = '未命名';

export interface ChapterLabel {
  text: string;
  /** 没有真标题（或标题只是序号的重复）—— 用次要色显示，别让它冒充章节名 */
  muted: boolean;
}

/**
 * 列表里那一行文字：`第 3 章 · 夜行`。
 *
 * 三种"标题不值得显示"的情况合并成同一种处理，都退回只显示序号：
 * - 空标题；
 * - 服务端的回退值「未命名」（正文首行不是 ATX 标题）；
 * - 标题恰好就是 `第 N 章` —— 新章的占位标题就是这样（§6），
 *   不处理会显示成「第 3 章 · 第 3 章」。
 */
export function chapterLabel(chapter: ChapterSummary): ChapterLabel {
  const order = `第 ${chapter.order} 章`;
  const title = chapter.title.trim();
  if (title === '' || title === TITLE_FALLBACK || title === order) {
    return { text: order, muted: true };
  }
  return { text: `${order} · ${title}`, muted: false };
}
