/**
 * 关窗前落盘的单测（`06` 文档 §7、§9）。
 *
 * 这里要钉住的是**最后一环**：`flushForQuit` 永远不能把异常漏给主进程。
 * 主进程那边没有 catch 的余地，一个未处理的 rejection 会变成"点关闭毫无反应"——
 * 比丢几个字更让用户愤怒，而且他无处可逃（§7.3 第 1 条）。
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  flushForQuit,
  getQuitFlushTarget,
  registerQuitFlushTarget,
} from '../src/renderer/src/features/editor/quit-flush';

beforeEach(() => {
  registerQuitFlushTarget(null);
});

describe('flushForQuit', () => {
  it('没有落盘目标（作品入口页）直接放行 —— 没有内容可丢，不该等满 3 秒超时', async () => {
    expect(await flushForQuit()).toEqual({ ok: true });
  });

  it('flush 成功 → ok', async () => {
    registerQuitFlushTarget({ flush: async () => true });
    expect(await flushForQuit()).toEqual({ ok: true });
  });

  it('flush 返回 false → ok:false 且带一句人能看懂的原因', async () => {
    registerQuitFlushTarget({ flush: async () => false });

    const result = await flushForQuit();

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('仍有内容没有写入磁盘');
  });

  it('flush 抛异常 → 收成 ok:false，而不是把 rejection 漏给主进程', async () => {
    registerQuitFlushTarget({
      flush: async () => {
        throw new Error('管道断了');
      },
    });

    const result = await flushForQuit();

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('管道断了');
  });

  it('注销之后不再命中旧目标（换章时旧实例必须先脱钩）', async () => {
    registerQuitFlushTarget({ flush: async () => false });
    expect(getQuitFlushTarget()).not.toBeNull();

    registerQuitFlushTarget(null);

    expect(getQuitFlushTarget()).toBeNull();
    expect(await flushForQuit()).toEqual({ ok: true });
  });

  it('注册会替换掉前一个目标（React 的清理顺序保证不会同时存在两个）', async () => {
    registerQuitFlushTarget({ flush: async () => false });
    registerQuitFlushTarget({ flush: async () => true });

    expect(await flushForQuit()).toEqual({ ok: true });
  });
});
