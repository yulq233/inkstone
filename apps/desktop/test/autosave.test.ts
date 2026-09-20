/**
 * 自动保存状态机的单测（03 文档 §6.3）。
 *
 * 这里每一条用例都对应 §6.3 表格里的一行"漏掉它会怎样"。
 * 这个类值得这么测，是因为它的失效方式都很隐蔽：不是崩溃，而是
 * **用户以为自己写下的字没了** —— 上线之后从用户嘴里听回来的成本极高。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorCode } from '@inkstone/shared';

import { ApiError } from '../src/renderer/src/lib/api';
import { Autosave, type AutosaveOptions, type SaveOutcome, type SaveState } from '../src/renderer/src/lib/autosave';

const DEBOUNCE = 500;
const MAX_WAIT = 3_000;
const RETRY = 3_000;

interface SaveCall {
  markdown: string;
  baseHash: string;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(overrides: Partial<AutosaveOptions> = {}) {
  let markdown = '第一版';
  const calls: SaveCall[] = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  let behavior: (call: SaveCall, index: number) => Promise<SaveOutcome> = async (_call, index) => ({
    hash: `h${index + 1}`,
    wordCount: markdown.length,
    savedAt: null,
  });

  const save = async (input: SaveCall): Promise<SaveOutcome> => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    calls.push(input);
    try {
      return await behavior(input, calls.length - 1);
    } finally {
      concurrent -= 1;
    }
  };

  const states: SaveState[] = [];
  const conflicts: unknown[] = [];
  const errors: unknown[] = [];

  const autosave = new Autosave({
    getMarkdown: () => markdown,
    save,
    baseHash: 'h0',
    debounceMs: DEBOUNCE,
    maxWaitMs: MAX_WAIT,
    retryMs: RETRY,
    onStateChange: (state) => states.push(state),
    onConflict: (detail) => conflicts.push(detail),
    onError: (err) => errors.push(err),
    ...overrides,
  });

  return {
    autosave,
    calls,
    states,
    conflicts,
    errors,
    get maxConcurrent() {
      return maxConcurrent;
    },
    write(value: string) {
      markdown = value;
      autosave.onChange();
    },
    setBehavior(next: typeof behavior) {
      behavior = next;
    },
  };
}

const conflictError = (diskMarkdown = '磁盘上的版本') =>
  new ApiError(ErrorCode.EXTERNAL_MODIFIED, '已被外部修改', 409, {
    diskHash: 'disk1',
    diskMarkdown,
    diskSavedAt: '2026-09-20T10:00:00+08:00',
  });

const serverError = () => new ApiError(ErrorCode.INTERNAL, '内部错误', 500);

describe('自动保存 · 防抖与 maxWait', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('防抖窗口内的连续输入只落一次盘', async () => {
    const h = setup();
    h.write('甲');
    await vi.advanceTimersByTimeAsync(200);
    h.write('甲乙');
    await vi.advanceTimersByTimeAsync(200);
    h.write('甲乙丙');

    expect(h.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    expect(h.calls).toHaveLength(1);
    // 落盘的是**最新**内容，不是最早那版。
    expect(h.calls[0].markdown).toBe('甲乙丙');
  });

  it('持续输入超过 maxWait 时必须落盘（纯防抖会永远不写）', async () => {
    const h = setup();
    // 每 400ms 敲一次，始终在 500ms 防抖窗口内 —— 纯防抖实现永远不会触发。
    const ticks = Math.ceil(MAX_WAIT / 400) + 1;
    for (let i = 0; i < ticks; i += 1) {
      h.write(`第${i}版`);
      await vi.advanceTimersByTimeAsync(400);
    }

    expect(h.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('落盘后状态回到 saved，且不再是"有未保存改动"', async () => {
    const h = setup();
    h.write('甲');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    expect(h.autosave.getState()).toBe('saved');
    expect(h.autosave.hasUnsavedChanges()).toBe(false);
    expect(h.states).toEqual(['dirty', 'saving', 'saved']);
  });
});

describe('自动保存 · 串行与补偿', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('同一时刻最多只有一个写入在飞', async () => {
    const h = setup();
    const gate = deferred<SaveOutcome>();
    h.setBehavior(() => gate.promise);

    h.write('甲');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    // 保存途中多次改动 + 多次 flush，都不能绕出第二个并发写入。
    h.write('甲乙');
    const flushed = h.autosave.flush();
    h.write('甲乙丙');

    expect(h.calls).toHaveLength(1);
    expect(h.maxConcurrent).toBe(1);

    gate.resolve({ hash: 'h1', wordCount: 1, savedAt: null });
    await flushed;
    expect(h.maxConcurrent).toBe(1);
  });

  it('保存期间到来的改动不会丢，会在完成后补一轮', async () => {
    const h = setup();
    const gate = deferred<SaveOutcome>();
    h.setBehavior(() => gate.promise);

    h.write('甲');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(h.calls).toHaveLength(1);

    // 写入在飞的时候用户继续打字 —— 这批字必须在完成后被补上。
    h.write('甲乙');

    gate.resolve({ hash: 'h1', wordCount: 1, savedAt: null });
    await vi.advanceTimersByTimeAsync(0);

    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].markdown).toBe('甲乙');
    // 第二轮用的是第一轮返回的新 hash。
    expect(h.calls[1].baseHash).toBe('h1');
  });

  it('flush() 在保存进行中必须等它落盘，不能立刻返回', async () => {
    const h = setup();
    const gate = deferred<SaveOutcome>();
    h.setBehavior(() => gate.promise);

    h.write('甲');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    let result: boolean | null = null;
    const flushed = h.autosave.flush().then((ok) => {
      result = ok;
    });
    await vi.advanceTimersByTimeAsync(0);
    // 这一步曾经是错的：flush() 看到 state === 'saving' 就直接返回了，
    // 于是"切章前先 flush"变成了没等 —— 正是丢字的成因。
    expect(result).toBeNull();

    gate.resolve({ hash: 'h1', wordCount: 1, savedAt: null });
    await flushed;
    expect(result).toBe(true);
    expect(h.autosave.hasUnsavedChanges()).toBe(false);
  });

  it('保存失败时 flush() 返回 false，调用方据此中断切章', async () => {
    const h = setup();
    h.setBehavior(() => Promise.reject(serverError()));

    h.write('甲');
    const ok = await h.autosave.flush();

    expect(ok).toBe(false);
    expect(h.autosave.getState()).toBe('error');
  });

  it('没有未保存改动时 flush() 不发请求且返回 true', async () => {
    const h = setup();
    await expect(h.autosave.flush()).resolves.toBe(true);
    expect(h.calls).toHaveLength(0);
  });
});

describe('自动保存 · 冲突', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('409 进入 conflict，把磁盘版本交给上层', async () => {
    const h = setup();
    h.setBehavior(() => Promise.reject(conflictError('外部编辑器写的')));

    h.write('甲');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    expect(h.autosave.getState()).toBe('conflict');
    expect(h.conflicts).toEqual([
      expect.objectContaining({ diskHash: 'disk1', diskMarkdown: '外部编辑器写的' }),
    ]);
    expect(h.errors).toHaveLength(0);
  });

  it('冲突未解决时不再自动保存（否则会把磁盘上的版本盖掉）', async () => {
    const h = setup();
    h.setBehavior(() => Promise.reject(conflictError()));

    h.write('甲');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(h.calls).toHaveLength(1);

    h.write('甲的后续输入');
    await vi.advanceTimersByTimeAsync(MAX_WAIT * 2);
    await h.autosave.flush();

    expect(h.calls).toHaveLength(1);
    expect(h.autosave.getState()).toBe('conflict');
  });

  it('resolve() 之后可以用新的 baseHash 继续保存', async () => {
    const h = setup();
    h.setBehavior(() => Promise.reject(conflictError()));

    h.write('甲');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(h.autosave.getState()).toBe('conflict');

    h.autosave.resolve('disk1');
    expect(h.autosave.getState()).toBe('saved');
    expect(h.autosave.getBaseHash()).toBe('disk1');

    h.setBehavior(async (_call, index) => ({ hash: `h${index + 1}`, wordCount: 1, savedAt: null }));
    h.write('解决冲突后的内容');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].baseHash).toBe('disk1');
  });
});

describe('自动保存 · 失败与重试', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('5xx 进入 error 且不丢未保存标志', async () => {
    const h = setup();
    h.setBehavior(() => Promise.reject(serverError()));

    h.write('甲');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    expect(h.autosave.getState()).toBe('error');
    expect(h.errors).toHaveLength(1);
    expect(h.autosave.hasUnsavedChanges()).toBe(true);
  });

  it('3s 后自动重试一次，再失败就停下等手动重试', async () => {
    const h = setup();
    h.setBehavior(() => Promise.reject(serverError()));

    h.write('甲');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(h.calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(RETRY);
    expect(h.calls).toHaveLength(2);

    // 无限重试会把日志和 CPU 一起打满，所以第二次失败后必须停。
    await vi.advanceTimersByTimeAsync(RETRY * 5);
    expect(h.calls).toHaveLength(2);
    expect(h.autosave.getState()).toBe('error');
  });

  it('重试成功后回到 saved', async () => {
    const h = setup();
    let failFirst = true;
    h.setBehavior(async (_call, index) => {
      if (failFirst) {
        failFirst = false;
        throw serverError();
      }
      return { hash: `h${index + 1}`, wordCount: 1, savedAt: null };
    });

    h.write('甲');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(h.autosave.getState()).toBe('error');

    await vi.advanceTimersByTimeAsync(RETRY);
    expect(h.autosave.getState()).toBe('saved');
    expect(h.autosave.hasUnsavedChanges()).toBe(false);
  });

  it('手动 retry() 之后自动重试额度会恢复', async () => {
    const h = setup();
    h.setBehavior(() => Promise.reject(serverError()));

    h.write('甲');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    await vi.advanceTimersByTimeAsync(RETRY); // 自动重试一次，又失败 → 停
    expect(h.calls).toHaveLength(2);

    await h.autosave.retry();
    expect(h.calls).toHaveLength(3);
  });
});

describe('自动保存 · 章节切换', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reset() 清空未保存标志与基准 hash', async () => {
    const h = setup();
    h.write('甲');
    h.autosave.reset('新章节的hash');

    expect(h.autosave.getState()).toBe('idle');
    expect(h.autosave.getBaseHash()).toBe('新章节的hash');
    expect(h.autosave.hasUnsavedChanges()).toBe(false);

    // 旧章节遗留的防抖计时器不能在切章后补一枪，把内容写到新章节去。
    await vi.advanceTimersByTimeAsync(MAX_WAIT);
    expect(h.calls).toHaveLength(0);
  });

  it('dispose() 之后不再有任何写入', async () => {
    const h = setup();
    h.write('甲');
    h.autosave.dispose();

    await vi.advanceTimersByTimeAsync(MAX_WAIT);
    await h.autosave.flush();

    expect(h.calls).toHaveLength(0);
  });
});
