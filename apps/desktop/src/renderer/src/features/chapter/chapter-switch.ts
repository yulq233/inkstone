/**
 * 切章时序（`07` 文档 §5）—— 这一步的核心，写成一个**不依赖 React 的纯函数**。
 *
 * ## 为什么必须是纯函数
 *
 * `03` 文档 §6.5 有一句加粗的话：**第 1~3 步是这个功能的全部价值**。
 * 漏掉 flush 直接切换，就是"偶发丢字"这类最难查的 bug 的来源 ——
 * 用户少了几百字，而且**复现不了**。
 *
 * 这类 bug 只能靠测试锁住，而渲染进程的测试环境是 `node`、没有 jsdom
 * （`vitest.config.mts` 写明了这个取舍），挂在钩子里的时序一行都测不到。
 * 所以把时序抽出来，`use-chapter-switch.ts` 只剩"把结果映射成 React 状态"。
 *
 * ## 时序（与 §5 的对应关系）
 *
 * ```
 * 1. 切到当前章？        → ignored（不是省事：会白 flush 一次并把光标弄没）
 * 2. 有未落盘内容？      → flush()
 * 3. flush 失败？        → blocked-save / blocked-conflict（**必须中断**）
 * 4. conflict 双保险     → blocked-conflict
 * 5. 取 token、读正文     → failed / superseded
 * 6. token 还新？        → 提交（apply）
 * ```
 *
 * **第 4 步不是冗余**：`Autosave` 在 conflict 态下 `mustSave` 是 `false`
 * （`runLoop` 每轮开头就把它清掉了），所以 `hasUnsavedChanges()` 会返回 `false`、
 * 第 2 步根本不会触发 flush。**只有这一步能拦住冲突态的切换。**
 */

import { ErrorCode, type ChapterContent, type ChapterSummary } from '@inkstone/shared';
import { ApiError, describeApiError } from '../../lib/api';
import type { SaveState } from '../../lib/autosave';

/**
 * 竞态令牌。快速翻章是真实场景（找一段话时会连点好几章），
 * 所以不能靠"切章期间禁用侧栏"—— 那会把后几次点击吞掉，用户感觉是卡。
 * 每次切换自增，晚到的旧响应据此丢弃。
 *
 * 用可变对象而不是返回值：令牌必须在**并发调用之间共享**，
 * 而纯函数不该持有状态，所以由调用方持有、传进来。
 */
export interface SwitchGuard {
  token: number;
}

export interface SwitchDeps {
  /** 当前所在章节 id（还没选章节时为 null） */
  currentChapterId: string | null;
  /** 有内容尚未落盘 */
  hasUnsavedChanges: () => boolean;
  /** 立即落盘并等它真的写完 */
  flush: () => Promise<boolean>;
  /** 保存状态机的当前状态（用于区分 blocked-save 与 blocked-conflict） */
  saveState: () => SaveState;
  readChapter: (chapterId: string) => Promise<ChapterContent>;
  guard: SwitchGuard;
  /**
   * flush 已过、即将开始读正文。用于"显示加载遮罩"——
   * 放在这里而不是函数开头，是为了让被挡下的切换**不会闪一下遮罩**。
   */
  onProceed?: () => void;
  /**
   * 提交：`content` 已就绪且 token 未过期。
   *
   * 刻意让调用方一次性拿到摘要与正文（而不是分两步 dispatch + setContent）：
   * React 会把它们合并成一次渲染，不存在"内容已换、身份未换"的中间态。
   */
  apply: (target: ChapterSummary, content: ChapterContent) => void;
}

export type SwitchOutcome =
  /** 已切换 */
  | { kind: 'switched'; chapter: ChapterContent }
  /** 点的就是当前章，什么都没做 */
  | { kind: 'ignored' }
  /** 旧章内容没落盘且不是冲突（保存失败）—— 已中断 */
  | { kind: 'blocked-save' }
  /** 旧章处于冲突态 —— 已中断，调用方应打开冲突对话框 */
  | { kind: 'blocked-conflict' }
  /** 读正文失败 —— 已中断，**原章内容仍在编辑器里，未被破坏** */
  | { kind: 'failed'; error: string; missing: boolean }
  /** 已被更新的点击取代，本次结果丢弃 */
  | { kind: 'superseded' };

export async function runChapterSwitch(
  deps: SwitchDeps,
  target: ChapterSummary,
): Promise<SwitchOutcome> {
  // 1. 点的就是当前章：直接返回。比对 `id` 不是 `order` —— 重排后 order 会变。
  if (deps.currentChapterId === target.id) return { kind: 'ignored' };

  // 2~3. 先把旧章的未落盘内容救出来。**跳过这一步就是丢字**。
  if (deps.hasUnsavedChanges()) {
    let flushed: boolean;
    try {
      flushed = await deps.flush();
    } catch {
      // `Autosave.flush()` 内部已按错误码分类，正常不会抛。但万一抛了，
      // 我们**真的不知道**内容落没落盘 —— 而调用方是 `void switchTo(...)`，
      // 接不住 rejection，一个未处理的 promise 会变成"点了切章，毫无反应"。
      // 保守起见按"没落盘"处理：留在原章，让用户看到提示。
      flushed = false;
    }
    if (!flushed) {
      // 不能切。用哪种提示取决于状态：冲突要开对话框，失败要给「重试」。
      return deps.saveState() === 'conflict'
        ? { kind: 'blocked-conflict' }
        : { kind: 'blocked-save' };
    }
  }

  // 4. 双保险。conflict 态下 `hasUnsavedChanges()` 是 false（见文件头注释），
  //    所以**这一条才是拦下冲突态切换的那一道**。
  if (deps.saveState() === 'conflict') return { kind: 'blocked-conflict' };

  const token = (deps.guard.token += 1);
  deps.onProceed?.();

  let content: ChapterContent;
  try {
    content = await deps.readChapter(target.id);
  } catch (err) {
    // 已被取代时连错误都不该报：用户根本没在等这一次的结果。
    if (token !== deps.guard.token) return { kind: 'superseded' };
    return { kind: 'failed', error: describeApiError(err), missing: isChapterMissing(err) };
  }

  // 5. `readChapter` 可能很慢（大章节）。期间用户又点了几次的话，
  //    这一次的结果必须丢弃 —— 否则会把他拉回**中间那次**点击的章节。
  if (token !== deps.guard.token) return { kind: 'superseded' };

  // 6. 提交。token 刚查过，这里不再 `await`，所以不会再被取代。
  deps.apply(target, content);
  return { kind: 'switched', chapter: content };
}

/** 章节被外部删掉了 —— 除了提示，还要顺手刷新一次列表（§7 最后一行）。 */
export function isChapterMissing(err: unknown): boolean {
  return err instanceof ApiError && err.code === ErrorCode.CHAPTER_NOT_FOUND;
}
