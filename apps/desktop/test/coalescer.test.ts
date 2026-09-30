/**
 * 重算合并器的单测（`docs/13` M22）。
 *
 * 要守住的性质只有两条：
 * 1. **连打 N 次只算一次** —— 否则这个模块就白写了；
 * 2. **停手后一定算到** —— 否则字数条会在整段输入期间冻住，比不做优化更糟。
 *
 * 用一个注入的假定时器，才能断言"排了几轮""是不是同一轮" —— 真实定时器只能等，
 * 而"等 200ms 然后希望它只跑了一次"这种事没法断言。
 */

import { describe, expect, it, vi } from 'vitest';

import { createCoalescer } from '../src/renderer/src/lib/coalescer';

/** 手工可推进的假定时器：记录每一轮，`fireAll` 一次性把它们跑完。 */
function createFakeTimer() {
  const queue = new Map<ReturnType<typeof setTimeout>, () => void>();
  const delays: number[] = [];
  let seq = 0;

  return {
    setTimer: (handler: () => void, delayMs: number): ReturnType<typeof setTimeout> => {
      // 只需要一个稳定的身份，具体形状无所谓
      const id = { seq: (seq += 1) } as unknown as ReturnType<typeof setTimeout>;
      queue.set(id, handler);
      delays.push(delayMs);
      return id;
    },
    clearTimer: (timer: ReturnType<typeof setTimeout>): void => {
      queue.delete(timer);
    },
    /** 当前排了**几轮**（不是排了几次调用） */
    rounds: (): number => queue.size,
    delays: (): number[] => [...delays],
    fireAll: (): void => {
      const handlers = [...queue.values()];
      queue.clear();
      handlers.forEach((handler) => handler());
    },
  };
}

describe('重算合并器', () => {
  it('连打 10 次只算一次', () => {
    const run = vi.fn();
    const clock = createFakeTimer();
    const coalescer = createCoalescer(200, run, clock);

    for (let i = 0; i < 10; i += 1) coalescer.schedule();

    expect(clock.rounds()).toBe(1); // 合并进同一轮，不是排了 10 轮
    clock.fireAll();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('已排队时不重置计时器 —— 否则一直打字就永远不触发', () => {
    const clock = createFakeTimer();
    const coalescer = createCoalescer(200, vi.fn(), clock);

    coalescer.schedule();
    coalescer.schedule();
    coalescer.schedule();

    // 只有一轮，且延迟只被请求过一次（重置会让它再来一条）
    expect(clock.delays()).toEqual([200]);
  });

  it('算完之后再 schedule 会重新排队（尾部一定算到）', () => {
    const run = vi.fn();
    const clock = createFakeTimer();
    const coalescer = createCoalescer(200, run, clock);

    coalescer.schedule();
    clock.fireAll();
    expect(run).toHaveBeenCalledTimes(1);

    coalescer.schedule();
    expect(clock.rounds()).toBe(1);
    clock.fireAll();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('cancel 之后不再触发（卸载后不再 setState）', () => {
    const run = vi.fn();
    const clock = createFakeTimer();
    const coalescer = createCoalescer(200, run, clock);

    coalescer.schedule();
    coalescer.cancel();

    expect(clock.rounds()).toBe(0);
    clock.fireAll();
    expect(run).not.toHaveBeenCalled();
  });

  it('cancel 之后可以重新 schedule（不是一次性失效）', () => {
    const run = vi.fn();
    const clock = createFakeTimer();
    const coalescer = createCoalescer(200, run, clock);

    coalescer.schedule();
    coalescer.cancel();
    coalescer.schedule();
    clock.fireAll();

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('延迟按传入值交给定时器', () => {
    const clock = createFakeTimer();
    createCoalescer(200, vi.fn(), clock).schedule();
    expect(clock.delays()).toEqual([200]);
  });

  it('不传注入时用真实定时器，能真的跑起来', async () => {
    // 覆盖默认分支：注入只是为了测试，生产路径走的是 setTimeout。
    const run = vi.fn();
    const coalescer = createCoalescer(0, run);
    coalescer.schedule();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(run).toHaveBeenCalledTimes(1);
  });
});
