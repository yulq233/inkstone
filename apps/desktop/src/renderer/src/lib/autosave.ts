/**
 * 自动保存状态机（03 文档 §6.3）。
 *
 * ```
 *          onChange
 *   ┌────────────────────► DIRTY
 *   │                        │
 *   │      debounce(500ms)   │  或  maxWait(3000ms) 到
 *   │                        ▼
 *   │                    SAVING ──── 200 ──► SAVED ──change──► DIRTY
 *   │                        │
 *   │                        ├──── 409 ──► CONFLICT
 *   │                        └──── 5xx ──► ERROR ──retry(手动/3s后一次)──► SAVING
 *   └────────────────────────┘
 *                     （SAVING 期间又有 change → 记 pending，完成后立刻再存一轮）
 * ```
 *
 * ## 为什么是这个形状，而不是"简单防抖"
 *
 * | 规则 | 漏掉它会怎样 |
 * |---|---|
 * | `debounce 500ms` | 每敲一个字发一次 PUT，请求刷屏 |
 * | `maxWait 3000ms` | 持续输入不中断时**永远不落盘**，崩溃即丢整段。纯防抖的经典坑 |
 * | 保存必须串行 | 两个并发 PUT 可能乱序落盘，后写的旧内容覆盖新内容 → "我刚打的字没了" |
 * | SAVING 期间记 pending | 保存过程中敲的字被丢掉 |
 * | 失焦 / 切章 / 关窗前 `flush()` | 这三个是用户认为"已经保存了"的时刻，不落盘就是丢字 |
 *
 * 这个类刻意不碰 DOM 也不碰 fetch：落盘动作由 `save` 注入，
 * 这样可以用假定时器把上面每一条规则都测出来（见 `test/autosave.test.ts`）。
 */

import { isExternalModifiedDetail, type ExternalModifiedDetail } from '@inkstone/shared';

import { ApiError } from './api';

export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'conflict' | 'error';

export interface SaveOutcome {
  /** 落盘后服务端返回的新 hash，成为下一次写入的 baseHash */
  hash: string;
  wordCount: number;
  savedAt: string | null;
}

export interface AutosaveOptions {
  /** 当前要保存的正文。**每次保存都重新取**，才能保证写的是最新内容 */
  getMarkdown: () => string;
  /** 实际落盘。抛 `ApiError` 时由本类按 code 分类处理 */
  save: (input: { markdown: string; baseHash: string }) => Promise<SaveOutcome>;
  /** 载入章节时拿到的 hash */
  baseHash: string;
  debounceMs?: number;
  maxWaitMs?: number;
  retryMs?: number;
  onStateChange?: (state: SaveState) => void;
  onConflict?: (detail: ExternalModifiedDetail | null) => void;
  onError?: (error: unknown) => void;
}

const DEFAULT_DEBOUNCE_MS = 500;
const DEFAULT_MAX_WAIT_MS = 3_000;
const DEFAULT_RETRY_MS = 3_000;

type Timer = ReturnType<typeof setTimeout>;

export class Autosave {
  private state: SaveState = 'idle';
  private baseHash: string;
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly retryMs: number;

  /** 有内容尚未落盘。它是"要不要再跑一轮"的唯一依据 */
  private mustSave = false;
  /**
   * 当前这批未保存改动最早的产生时刻，用于 maxWait 判定。`null` = 当前无未保存改动。
   *
   * 刻意不用 `0` 当哨兵：`Date.now()` 在某些环境下可能真的是 0（例如测试里的假定时器），
   * 那样"没有未保存改动"和"改动发生在时间原点"就无法区分，maxWait 会永远判不出来。
   */
  private pendingSince: number | null = null;

  private debounceTimer: Timer | null = null;
  private retryTimer: Timer | null = null;
  /** 已自动重试过一次 —— 第二次失败就只留手动重试，避免无限重试刷屏 */
  private autoRetried = false;

  /** 串行闸门：非 null 表示正有一轮保存循环在跑 */
  private runningPromise: Promise<void> | null = null;

  private disposed = false;

  constructor(private readonly opts: AutosaveOptions) {
    this.baseHash = opts.baseHash;
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    this.retryMs = opts.retryMs ?? DEFAULT_RETRY_MS;
  }

  // ------------------------------------------------------------------
  // 只读视图
  // ------------------------------------------------------------------

  getState(): SaveState {
    return this.state;
  }

  getBaseHash(): string {
    return this.baseHash;
  }

  /** 有未落盘的改动（含正在保存的）。切章与关窗前用它判断要不要 flush */
  hasUnsavedChanges(): boolean {
    return this.mustSave || this.state === 'dirty' || this.state === 'saving';
  }

  /**
   * 状态机卡在"等用户决定"上：冲突未解决，或保存出错等重试。
   * 这两种状态下都不该自动再写 —— 冲突时继续写会盖掉磁盘上别人的版本，
   * 出错时继续写会变成忙循环。
   *
   * 写成 getter 而不是内联比较，是因为 TypeScript 不会因为中间调用了方法
   * 就重置 `this.state` 的类型收窄，内联比较会被判成"不可能成立的分支"而报错。
   * 语义上这也更清楚：调用方问的是"要不要停下来等人"，不是某个具体状态。
   */
  private get needsAttention(): boolean {
    return this.state === 'conflict' || this.state === 'error';
  }

  // ------------------------------------------------------------------
  // 外部事件
  // ------------------------------------------------------------------

  /** 编辑器内容变化。 */
  onChange(): void {
    if (this.disposed) return;
    // 冲突未解决时**停止自动保存**：此时磁盘上是别人的版本，
    // 继续写只会把它盖掉，而且用户还没做出选择。
    if (this.state === 'conflict') return;

    const now = Date.now();
    const since = this.pendingSince ?? now;
    this.pendingSince = since;
    this.mustSave = true;
    this.setState('dirty');

    if (now - since >= this.maxWaitMs) {
      // 持续输入已经超过 maxWait —— 不再等防抖，立刻落一次。
      this.clearDebounce();
      void this.pump();
      return;
    }
    this.armDebounce();
  }

  /**
   * 立即保存并等它**真的落盘**，返回是否已安全落盘。
   *
   * 章节切换、窗口失焦、关窗前必须 `await` 它并检查返回值 ——
   * 跳过这一步就是"偶发丢字"这类最难查的 bug 的来源（§6.5）。
   *
   * - `true`：没有未保存内容了（返回时状态是 `saved` / `idle`）
   * - `false`：还有内容没落盘（`error` 或 `conflict`）。调用方**必须中断**后续动作
   *   （比如不要切章），否则用户会以为稿子已经保住了。
   *
   * 循环的写法是必要的，不是保守：`runLoop` 退出与 promise settle 之间隔着微任务，
   * 那一瞬间仍可能有新改动进来。只 `await` 一次就返回，会漏掉这批内容 ——
   * 而调用方（切章）紧接着就会 `reset()`，那批字就真没了。
   */
  async flush(): Promise<boolean> {
    this.clearDebounce();
    if (this.disposed) return true;
    if (this.state === 'conflict') return false;

    // guard 是防御性上界：状态机若因将来改动出现活锁，宁可少存一次也不能卡死 UI。
    for (let guard = 0; guard < 100; guard += 1) {
      if (this.needsAttention) break;
      if (this.runningPromise !== null) {
        // 已有保存在飞：等它，然后**再检查一次**是否又有了新改动。
        await this.runningPromise;
        continue;
      }
      if (!this.mustSave && this.state !== 'dirty') break;
      this.mustSave = true;
      await this.pump();
    }

    return this.state === 'saved' || this.state === 'idle';
  }

  /** 用户点「重试」。重置自动重试计数，让后续失败还能再自动试一次。 */
  async retry(): Promise<void> {
    if (this.disposed || this.state === 'conflict') return;
    this.clearRetry();
    this.autoRetried = false;
    this.mustSave = true;
    await this.pump();
  }

  /**
   * 切换到另一章时重置。
   *
   * 调用前必须 `await flush()` 过 —— 这里只负责把状态清干净，
   * 不负责保存，因为"该不该保存"是调用方的判断。
   */
  reset(hash: string): void {
    this.clearAllTimers();
    this.baseHash = hash;
    this.mustSave = false;
    this.pendingSince = null;
    this.autoRetried = false;
    this.setState('idle');
  }

  /**
   * 冲突解决后调用，把状态机重新拉回可保存。
   *
   * `newHash` 是**磁盘当前版本**的 hash：无论用户选了"用磁盘版本"还是"覆盖"，
   * 解决完之后基准都是它（覆盖那条路磁盘已经是我们的内容了，hash 就是新写入的 hash）。
   */
  resolve(newHash: string): void {
    this.clearAllTimers();
    this.baseHash = newHash;
    this.mustSave = false;
    this.pendingSince = null;
    this.autoRetried = false;
    this.setState('saved');
  }

  dispose(): void {
    this.disposed = true;
    this.clearAllTimers();
  }

  // ------------------------------------------------------------------
  // 内部
  // ------------------------------------------------------------------

  private setState(next: SaveState): void {
    if (this.state === next) return;
    this.state = next;
    this.opts.onStateChange?.(next);
  }

  private armDebounce(): void {
    this.clearDebounce();
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.pump();
    }, this.debounceMs);
  }

  private clearDebounce(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private clearAllTimers(): void {
    this.clearDebounce();
    this.clearRetry();
  }

  /**
   * 串行闸门。同一时刻只有一个保存循环在跑；在跑的时候再调用，返回的是同一个 promise，
   * 于是 `flush()` 天然会等到"当前这批 + 后续补偿的那批"都落盘才返回。
   */
  private pump(): Promise<void> {
    if (this.runningPromise !== null) return this.runningPromise;
    const promise = this.runLoop().finally(() => {
      this.runningPromise = null;
    });
    this.runningPromise = promise;
    return promise;
  }

  private async runLoop(): Promise<void> {
    while (this.mustSave && !this.disposed && this.state !== 'conflict') {
      // 先把标志清掉再写：写入期间新到的改动会重新把它置 true，
      // 于是循环下一圈会再存一次 —— 这就是"完成后立刻补一轮"。
      this.mustSave = false;
      this.pendingSince = null;

      await this.attemptSave();

      // 失败就退出循环，交给自动重试 / 手动重试。
      // 不能在这里 continue：否则网络断了会变成忙循环，把 CPU 和日志同时打满。
      if (this.needsAttention) return;
    }
  }

  private async attemptSave(): Promise<void> {
    const markdown = this.opts.getMarkdown();
    this.setState('saving');
    try {
      const outcome = await this.opts.save({ markdown, baseHash: this.baseHash });
      this.baseHash = outcome.hash;
      this.autoRetried = false;
      // 若写入期间又有改动，runLoop 会立刻再跑一圈，状态很快回到 dirty。
      this.setState('saved');
    } catch (err) {
      if (err instanceof ApiError && err.isConflict) {
        this.setState('conflict');
        // 形状不对时给 null：宁可让对话框退化成"只说明有冲突"，也不能因为
        // detail 缺字段就抛异常 —— 那样用户连"发生了冲突"都不知道。
        this.opts.onConflict?.(isExternalModifiedDetail(err.detail) ? err.detail : null);
        return;
      }
      // 内容还没落盘 —— 标志必须留着，否则这次改动就真丢了。
      this.mustSave = true;
      this.setState('error');
      this.opts.onError?.(err);
      this.scheduleAutoRetry();
    }
  }

  private scheduleAutoRetry(): void {
    if (this.autoRetried || this.retryTimer !== null || this.disposed) return;
    this.autoRetried = true;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.pump();
    }, this.retryMs);
  }
}
