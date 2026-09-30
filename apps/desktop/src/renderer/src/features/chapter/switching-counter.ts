/**
 * 「正在切章」的在飞计数（`docs/13` M23）。
 *
 * ## 为什么不是布尔值
 *
 * 切章会**并发**：快速连点两章时两次 `switchTo` 都在飞，各自把遮罩打开。
 * 先回来的那次是 `superseded`（结果被丢弃，连错误都不报），由后回来的那次负责收尾。
 *
 * 这个假设会破：`SwitchOutcome` 里有一半的种类**根本没走到「打开遮罩」那一步**
 * （点的就是当前章 → `ignored`；旧章没落盘 → `blocked-save` / `blocked-conflict`）。
 * 于是出现这一串 ——
 *
 * 1. 点章 A（大章节，读得慢）→ 遮罩出现；
 * 2. 等得不耐烦，点回**自己原来那章**想取消 → `ignored`，这次没有 proceed；
 * 3. A 回来发现 token 过期 → `superseded`，早退。
 *
 * 两次都没人去收起遮罩，它就永久盖在编辑器上 —— 界面看起来像卡死，只能重启。
 *
 * 计数把"谁负责收"变成**结构性**的：进一次 `+1`、出一次 `-1`，归零才收遮罩。
 * 谁离开时归零谁负责，与"谁是最新那次"无关，因此上面那种"更新的那次不 proceed"
 * 的情形自然被覆盖。
 */

export interface SwitchingCounter {
  /** 有一次切换即将显示遮罩（`SwitchDeps.onProceed` 里调用）。 */
  acquire: () => void;
  /**
   * 有一次切换已经结束 —— **无论结果是什么，哪怕是 `superseded`**。
   *
   * 这是这个模块存在的全部理由：调用方必须无例外地调它，
   * 只要本次 `acquire` 过。归零时回调 `onIdle`。
   */
  release: () => void;
  /**
   * 直接归零且**不回调**。用于换作品 / 卸载：那时代入的 `setSwitching(false)`
   * 已经由调用方自己发出，或者组件已经不在了。
   */
  reset: () => void;
  /** 当前在飞的次数（测试断言用） */
  readonly pending: number;
}

export function createSwitchingCounter(onIdle: () => void): SwitchingCounter {
  let pending = 0;
  return {
    acquire() {
      pending += 1;
    },
    release() {
      // 没 acquire 过就 release：忽略，且**绝不能**让计数变成负数 ——
      // 负数会让下一次 acquire(1) 落在 -1 → 0 之外的区间，遮罩再也收不齐。
      if (pending === 0) return;
      pending -= 1;
      if (pending === 0) onIdle();
    },
    reset() {
      pending = 0;
    },
    get pending() {
      return pending;
    },
  };
}
