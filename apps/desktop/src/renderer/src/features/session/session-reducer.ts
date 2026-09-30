/**
 * 应用级会话状态（04 文档 §4）。
 *
 * 为什么不用一堆 `useState`：当前作品、当前章节、打开中、失败原因这四个字段之间有
 * 耦合约束（"没有作品就不可能有当前章节"）。散装 `useState` 允许出现"作品为 null
 * 但章节非 null"这种非法组合，而它恰好会在切章时序里被读到。判别联合把非法状态
 * **表示不出来**。
 *
 * 这是纯函数，不碰 React、不碰磁盘 —— 步骤 03（切章）与步骤 04（保存）都要读写它，
 * 单测直接覆盖它的迁移规则，比点界面快得多。
 */

import type { ChapterSummary, WorkSummary } from '@inkstone/shared';

export type SessionState =
  /** 作品入口页：没有打开任何作品 */
  | { kind: 'entry' }
  /**
   * 正在打开。只带一个 `title` 而不是完整的 `WorkSummary` ——
   * 打开请求返回之前我们根本拿不到摘要，硬造一个会让后续代码读到假的
   * `chapterCount` / `totalWords`。这个名字来自最近列表项或用户填写的标题。
   */
  | { kind: 'opening'; title: string }
  /** 已打开。chapter 为 null 表示"作品已打开但还没选章节" */
  | { kind: 'ready'; work: WorkSummary; chapter: ChapterSummary | null }
  /** 打开失败。保留 work（可能为 null）以便失败页说明是哪个作品出的错 */
  | { kind: 'failed'; work: WorkSummary | null; error: string };

export type SessionAction =
  | { type: 'work/opening'; title: string }
  | { type: 'work/opened'; work: WorkSummary; chapter: ChapterSummary | null }
  | { type: 'work/failed'; error: string }
  | { type: 'work/leave' }
  | { type: 'chapter/selected'; chapter: ChapterSummary };

export const initialSessionState: SessionState = { kind: 'entry' };

export function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case 'work/opening':
      return { kind: 'opening', title: action.title };

    case 'work/opened':
      return { kind: 'ready', work: action.work, chapter: action.chapter };

    case 'work/failed':
      return {
        kind: 'failed',
        // 只有 ready / failed 持有作品摘要；entry 与 opening 都没有
        work: state.kind === 'ready' || state.kind === 'failed' ? state.work : null,
        error: action.error,
      };

    // 只切回入口页，**不碰磁盘**：目录的增删是文件管理器的事（04 文档 §1.2）。
    case 'work/leave':
      return { kind: 'entry' };

    // 非 ready 态下收到这个动作直接忽略。防御而非逻辑：真正的原因是选中动作
    // 由异步请求回调触发，而用户可能已经返回入口页了。
    case 'chapter/selected':
      if (state.kind !== 'ready') return state;
      return { ...state, chapter: action.chapter };

    default:
      return state;
  }
}

/** 哪一屏负责这个会话状态。 */
export type SessionScreen = 'entry' | 'workbench';

/**
 * 会话状态 → 屏幕（`docs/13` M19）。
 *
 * 看起来只是个 `if`，但它错了会**静默地弄丢一整条通道**，所以抽出来单测：
 * `opening` 必须留在**入口页**。卡片上的「打开中……」与条目级失败提示
 * （"目录已移动或删除"落在那一张卡上）都是入口页自己的状态 ——
 * 把 `opening` 交给工作台，入口页随即卸载，那两个通道就再也没机会显示，
 * 而界面上看不出任何异常（只是"点了打开没反应/失败后不知道去哪了"）。
 *
 * 这个映射还有一处佐证：`shelf-view.ts` 的 `shelfCardStatus` 是按
 * "打开中 > 打开失败 > 目录没了 > 正常"排序的 —— 那份逻辑只有在打开期间
 * 书架仍然可见时才有意义。
 */
export function screenFor(kind: SessionState['kind']): SessionScreen {
  return kind === 'entry' || kind === 'opening' ? 'entry' : 'workbench';
}
