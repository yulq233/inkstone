/**
 * 崩溃条目的构造（`docs/13` M14）。
 *
 * 这一组用例的价值在两条：**脱敏**（崩溃现场往往正是手里拿着明文 Key 的那段代码）
 * 与**非 Error 抛出物**（`Object.create(null)` 这类东西 `String()` 会抛，
 * 而在 `uncaughtException` 处理器里再抛一次，Node 会直接 abort —— 什么线索都不剩）。
 */

import { describe, expect, it } from 'vitest';
import { describeThrown, formatCrashEntry } from '../src/main/crash-report';

describe('describeThrown', () => {
  it('Error 用栈（栈里同时含消息与调用点）', () => {
    const out = describeThrown(new Error('炸了'));
    expect(out).toContain('炸了');
  });

  it('栈是空串时退回 name: message', () => {
    const err = new Error('没有栈');
    err.stack = '';
    expect(describeThrown(err)).toBe('Error: 没有栈');
  });

  it('name 是空串时补成 Error', () => {
    const err = new Error('无名');
    err.name = '';
    err.stack = '';
    expect(describeThrown(err)).toBe('Error: 无名');
  });

  it('非 Error 抛出物直接字符串化', () => {
    expect(describeThrown('oops')).toBe('oops');
    expect(describeThrown(undefined)).toBe('undefined');
    expect(describeThrown({ code: 1 })).toBe('[object Object]');
    expect(describeThrown(42)).toBe('42');
  });

  it('字符串化会抛的抛出物不会把处理器带崩', () => {
    // 没有原型的对象在 `String()` 时抛 "Cannot convert object to primitive value"。
    // 它真的会出现在 `Promise.reject(Object.create(null))` 这种写法里。
    expect(describeThrown(Object.create(null))).toBe('<无法字符串化的抛出物>');
    expect(
      describeThrown({
        toString() {
          throw new Error('故意抛');
        },
      }),
    ).toBe('<无法字符串化的抛出物>');
  });
});

describe('formatCrashEntry', () => {
  const at = new Date('2026-09-29T03:04:05.678Z');

  it('带 UTC 时间戳与异常类别', () => {
    const out = formatCrashEntry('unhandledRejection', new Error('x'), at);
    expect(out).toContain('2026-09-29T03:04:05.678Z');
    expect(out).toContain('unhandledRejection');
    expect(out.endsWith('\n')).toBe(true);
  });

  it('崩溃现场里的密钥会被擦掉', () => {
    const out = formatCrashEntry(
      'uncaughtException',
      new Error('request failed: Authorization: Bearer sk-proj-abcdefghijklmnop'),
      at,
    );
    expect(out).not.toContain('sk-proj-abcdefghijklmnop');
    expect(out).toContain('<redacted>');
  });
});
