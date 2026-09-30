/**
 * 书架（首页）的纯逻辑。
 *
 * 抽出来的理由同 `chapter-list.ts`：渲染进程的测试环境是 node，组件渲染测不了，
 * 凡是"判断错了会让人看到错东西"的分支都放这里，能被断言。
 *
 * **本模块只依赖类型**，不 import 任何带 React / `window` 的模块 —— 否则测试会顺带
 * 把整条 UI 依赖链拖进来。
 *
 * ## 书架为什么不显示章节数与字数
 *
 * `RecentWork` 只有四个字段（`rootPath` / `title` / `lastOpenedAt` / `exists`）。
 * `chapterCount` / `totalWords` 是 `WorkSummary` 的字段，由 `repo._summary()` 产出，
 * 而那份数据依赖 `ctx.chapters` —— 也就是**这本书已经被 sidecar 打开并注册**。
 * 想给"没打开的书"算这两个数，必须去扫它的 `chapters/` 目录（新增端点 + 首屏 N 份 I/O）。
 * 这一版刻意不为此改 sidecar 与数据结构，理由记在 `docs/04` §11。
 */

import type { RecentWork } from '@inkstone/shared';

export type ShelfList =
  | { kind: 'loading' }
  /** 一次都没读到过，且这次读取失败 —— 除了错误信息没有别的可显示 */
  | { kind: 'unavailable' }
  | { kind: 'empty' }
  | { kind: 'ready'; items: RecentWork[] };

export interface ShelfView {
  list: ShelfList;
  /** 列表读取失败的信息。**与 `list` 可以同时存在**，见下 */
  error: string | null;
}

/**
 * 书架该显示什么。
 *
 * `items === null`（还没拿到过）与 `items === []`（确实一本都没有）是**两种界面**：
 * 前者是"正在读取"，后者是"新建第一本"的引导 —— 混成一种会让首帧闪一下空态。
 *
 * **错误不覆盖列表**，两者可以同时存在：`useRecentWorks` 只在成功时写 `items`，
 * 失败时只写 `error` —— 于是"先成功过一次、之后某次刷新失败"会让两个字段同时有值。
 * 那种情况下把整块书架换成一句错误是错的：那些书还在磁盘上、也还能打开，
 * 而用户会以为书架被清空了。所以错误作为**附注**渲染在书架上方，
 * 列表照常显示，另外再给一个「重试」（否则错误信息是一条死路）。
 */
export function shelfView(items: RecentWork[] | null, error: string | null): ShelfView {
  if (items === null) {
    // 没拿到过列表、而且这次也失败了：不能再显示"正在读取……"，那是骗人等
    return { list: error === null ? { kind: 'loading' } : { kind: 'unavailable' }, error };
  }
  if (items.length === 0) return { list: { kind: 'empty' }, error };
  return { list: { kind: 'ready', items: sortShelf(items) }, error };
}

/**
 * 最近打开的在前。
 *
 * sidecar 的 `RecentStore.list_entries()` 已经按 `lastOpenedAt` 倒序返回，
 * `touch()` 也把新记录插在头部 —— 所以这里是**防御性**的，与 `sortChapters` 同理：
 * 一旦哪天换了排序依据，书架会安静地乱序，而那种 bug 看起来像"最近写的书不见了"。
 *
 * 时间解析不出来时排**最后**（空串、被手工编辑过的文件）：排最前会让一条坏记录
 * 占住书架的第一个格子。
 *
 * 注意比的是**字段字符串**还是时间戳：`RecentStore` 那边按 ISO 字符串倒序
 * （同一时区下等价），这里按 `Date.parse` 的真时间戳，跨夏令时/跨时区偏移也正确。
 */
export function sortShelf(items: RecentWork[]): RecentWork[] {
  return [...items].sort((a, b) => {
    const ta = timeOf(a.lastOpenedAt);
    const tb = timeOf(b.lastOpenedAt);
    if (ta !== tb) return tb - ta;
    // 时间相同（或都解析不出来）时给一个稳定次序，免得每次渲染位置都在跳
    return a.title.localeCompare(b.title, 'zh-Hans-CN');
  });
}

function timeOf(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

/**
 * 封面上的那个大字。
 *
 * 用 `Array.from` 而不是 `charAt(0)` / `title[0]`：标题可能以 emoji（代理对）或
 * 组合字符开头，按 UTF-16 码元切会切出半个字符，渲染成一个孤立的方块。
 */
export function coverGlyph(title: string): string {
  const first = Array.from(title.trim())[0];
  return first ?? '书';
}

export interface ShelfCardStatus {
  text: string;
  /** true = 这本书现在打不开（目录没了，或刚打开失败） */
  bad: boolean;
}

export interface ShelfCardInput {
  /** 这一本正在被打开 */
  opening: boolean;
  /** 这一本的打开失败信息；不属于这一本时传 null */
  failureMessage: string | null;
  exists: boolean;
  /** 已经格式化好的"上次打开"文字，本模块不碰时间格式化 */
  lastOpenedText: string;
}

/**
 * 卡片底部那一行状态。
 *
 * 四条出路**有顺序**，而顺序就是这里唯一的逻辑：打开中 > 打开失败 > 目录没了 > 正常。
 * 反过来的话，「正在打开」会被同时存在的旧失败信息盖掉，用户看到的是上一次的报错。
 */
export function shelfCardStatus(input: ShelfCardInput): ShelfCardStatus {
  if (input.opening) return { text: '打开中……', bad: false };
  if (input.failureMessage !== null) return { text: input.failureMessage, bad: true };
  if (!input.exists) return { text: '目录已移动或删除', bad: true };
  return { text: `上次打开 ${input.lastOpenedText}`, bad: false };
}
