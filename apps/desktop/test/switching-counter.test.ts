/**
 * 「正在切章」在飞计数的单测（`docs/13` M23）。
 *
 * 这个模块存在的**唯一**理由是遮罩会卡死。下面每一条都在钉"谁负责收起遮罩"，
 * 而不是在测一个计数器 —— 计数器本身三行就写完了。
 */

import { describe, expect, it, vi } from 'vitest';

import { createSwitchingCounter } from '../src/renderer/src/features/chapter/switching-counter';

describe('切章在飞计数', () => {
  it('acquire 之后 release 才归零，归零时回调恰好一次', () => {
    const onIdle = vi.fn();
    const counter = createSwitchingCounter(onIdle);

    counter.acquire();
    expect(counter.pending).toBe(1);
    expect(onIdle).not.toHaveBeenCalled();

    counter.release();
    expect(counter.pending).toBe(0);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('两轮并发：先离场的不回调，最后一个离场的才收', () => {
    const onIdle = vi.fn();
    const counter = createSwitchingCounter(onIdle);

    counter.acquire(); // 点章 A
    counter.acquire(); // 紧接着点章 B —— 遮罩本来就开着，靠计数记住"有两个人在里面"
    counter.release(); // A 被取代，结果丢弃
    expect(onIdle).not.toHaveBeenCalled(); // B 还在飞，遮罩不能收

    counter.release(); // B 落地
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('被取代的那一轮自己收尾 —— 即"更新的那次没 proceed"也不会卡住遮罩', () => {
    // M23 的原始现场：点章 A（大章节，读得慢）→ 遮罩出现；
    // 等得不耐烦，点回**自己原来那章**想取消 → 那一轮 `ignored`，全程没 acquire；
    // A 回来发现 token 过期 → superseded。若按旧写法（superseded 早退不复位），
    // 两次都没人收遮罩，编辑器被永久盖住。
    const onIdle = vi.fn();
    const counter = createSwitchingCounter(onIdle);

    counter.acquire(); // 只有 A 进过场
    counter.release(); // A 被取代，但遮罩必须由它收起

    expect(onIdle).toHaveBeenCalledTimes(1);
    expect(counter.pending).toBe(0);
  });

  it('没 acquire 过就 release：忽略，且不把计数压成负数', () => {
    const onIdle = vi.fn();
    const counter = createSwitchingCounter(onIdle);

    counter.release();
    counter.release();

    expect(counter.pending).toBe(0);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it('归零之后再 release 也不会回调（结算不会重复发生）', () => {
    const onIdle = vi.fn();
    const counter = createSwitchingCounter(onIdle);

    counter.acquire();
    counter.release();
    counter.release();

    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('reset 直接归零但不回调（换作品时调用方自己已经关了遮罩）', () => {
    const onIdle = vi.fn();
    const counter = createSwitchingCounter(onIdle);

    counter.acquire();
    counter.reset();

    expect(counter.pending).toBe(0);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it('reset 之后在飞的那次 release 被忽略 —— 换作品不会把遮罩重新打开一次', () => {
    // 换作品时 token 已归零、计数也归零；旧作品那次切换迟到的 release
    // 如果还能触发 onIdle，就会对着**新作品**的界面来一次无意义的 setState。
    const onIdle = vi.fn();
    const counter = createSwitchingCounter(onIdle);

    counter.acquire();
    counter.reset();
    counter.release();

    expect(counter.pending).toBe(0);
    expect(onIdle).not.toHaveBeenCalled();
  });
});
