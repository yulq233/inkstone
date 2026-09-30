/**
 * 把"高频事件 → 低频重算"合并成一个可测的调度器（`docs/13` M22）。
 *
 * ## 为什么需要它
 *
 * 编辑器的 `onUpdate` 每敲一个字符就触发一次。而每次都要跑两趟 O(全文)：
 * 一次全量 `toMd`（序列化整篇文档），一次 `countWords`。几万字的章节连打十个字
 * 就是二十趟 —— 掉帧是必然的，而且掉在**打字**这条最敏感的路径上。
 *
 * 但这两个结果（字数条、告警条）都只是**给人看的近似值**：晚两百毫秒出现，
 * 用户完全没有感觉。所以把连打过程中的中间态全部丢掉，只算最后那一次。
 *
 * ## 语义：尾部一定会算到
 *
 * `schedule()` 在已排队时**只合并、不重置计时器**。这一点是有意的：
 * 若按"每次调用都重置计时器"（经典 debounce），一直不停地打字就永远不触发，
 * 字数条会在整段输入期间冻住。合并语义下最多等 `delayMs`，停手后结果必然准确
 * —— 代价是算过一次的内容可能"过时"，但下次 `schedule` 会立刻补算。
 *
 * ## 为什么单独一个文件
 *
 * 渲染进程的测试环境是 `node`、没有 jsdom，组件里的调度一行都测不到。
 * 抽出来之后可以用假时钟钉住"连打 N 次只算一次""停手后一定算到"
 * 这两个真正要守住的性质。
 */

export interface Coalescer {
  /** 请求一次重算。已排队时合并进同一轮（不重置计时器）。 */
  schedule: () => void;
  /** 取消尚未触发的重算。卸载时调用，避免往已卸载的组件里 setState。 */
  cancel: () => void;
}

export interface CoalescerOptions {
  /**
   * 注入的定时器函数，默认 `setTimeout`。
   *
   * 允许注入只为测试：node 环境下真实定时器不好断言"排了几轮"。
   */
  setTimer?: (handler: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export function createCoalescer(
  delayMs: number,
  run: () => void,
  options: CoalescerOptions = {},
): Coalescer {
  const setTimer = options.setTimer ?? ((handler, delay) => setTimeout(handler, delay));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));

  let timer: ReturnType<typeof setTimeout> | null = null;

  return {
    schedule() {
      // 已经在排队：直接合并。**不重置计时器** —— 见文件头"尾部一定会算到"。
      if (timer !== null) return;
      timer = setTimer(() => {
        timer = null;
        run();
      }, delayMs);
    },
    cancel() {
      if (timer === null) return;
      clearTimer(timer);
      timer = null;
    },
  };
}
