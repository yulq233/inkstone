/**
 * 关窗前落盘的"目标注册表"（`06` 文档 §7）。
 *
 * ## 为什么需要一层注册表，而不是让 WorkShell 直接监听 IPC
 *
 * 关窗这件事发生在**应用级**，而 `Autosave` 的实例活在**章节级**：
 * 每次换章都会重建（见 `use-autosave.ts`）。如果让 `WorkShell` 自己监听，
 * 就得到处同步"当前是哪个实例"，而且用户停在作品入口页（根本没有实例）时
 * 那条监听还得存在 —— 否则主进程等不到回复，只能走 3 秒超时。
 *
 * 所以拆成两半：这个模块持有"当前该为谁落盘"这一个事实（可被测试直接替换），
 * 应用根部挂一次监听（`useQuitFlush`）。没有目标 = 没有内容可丢 = 立刻放行。
 *
 * `flushForQuit` 刻意只认 `flush()` 一个动词，而不是接 `Autosave`：
 * 测试里塞一个假对象就够了，不需要造出真的 `ApiClient`。
 */

import type { FlushResult } from '@inkstone/shared';

export interface QuitFlushTarget {
  /** 立即落盘并等它真的写完；`false` 表示仍有内容没落盘 */
  flush(): Promise<boolean>;
}

let target: QuitFlushTarget | null = null;

/**
 * 注册 / 注销当前落盘目标。传 `null` 即注销。
 *
 * React 的 effect 清理顺序保证"旧实例注销 → 新实例注册"，
 * 所以这里不需要处理"同时存在两个目标"的情况。
 */
export function registerQuitFlushTarget(next: QuitFlushTarget | null): void {
  target = next;
}

/** 仅供测试：读回当前目标，确认注册与注销真的生效了。 */
export function getQuitFlushTarget(): QuitFlushTarget | null {
  return target;
}

/**
 * 主进程问"可以关了吗"的答案。
 *
 * 三种结果对应主进程的三条分支（`quit-guard.ts`）：
 * - 没有未落盘内容 → `{ ok: true }` → 直接关
 * - 仍有内容没落盘 → `{ ok: false, reason }` → 弹确认框
 * - `flush()` 自己抛了（理论上不该有，它内部已按 code 分类）→ 同样算没落盘
 *
 * 注意**不**把 `flush()` 抛出的异常原样往上扔：主进程那边没有 catch 的余地，
 * 一个未处理的 rejection 会变成"点关闭毫无反应"——正是 §7.3 第 1 条要防的事。
 */
export async function flushForQuit(): Promise<FlushResult> {
  const current = target;
  if (current === null) return { ok: true };

  try {
    if (await current.flush()) return { ok: true };
    return {
      ok: false,
      reason: '仍有内容没有写入磁盘（保存失败，或存在尚未解决的冲突）。',
    };
  } catch (err) {
    return {
      ok: false,
      reason: `落盘过程出错：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
