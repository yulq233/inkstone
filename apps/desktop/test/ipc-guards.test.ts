/**
 * IPC 入参的运行时校验（`docs/13` M15）。
 *
 * 这一层挡的是**类型系统管不到的那一半**：类型注解只是编译期承诺，
 * IPC 另一头送来的东西可以是任何值。用例按"最坏输入"写：
 * `null`、数组、字符串、缺字段 —— 而不是"类型正确时的行为"。
 */

import { describe, expect, it } from 'vitest';
import {
  asAiCredentialSetRequest,
  asEgressAckRequest,
  asFlushResult,
  asPickDirectoryRequest,
  asProviderId,
  asSettingsPatch,
} from '../src/main/ipc-guards';

describe('asSettingsPatch', () => {
  it('非对象一律收敛成空补丁（等价于"什么都没改"）', () => {
    for (const value of [null, undefined, 'theme', 42, [], true]) {
      expect(asSettingsPatch(value)).toEqual({});
    }
  });

  it('放行 theme / ai 两个对象字段', () => {
    const patch = asSettingsPatch({ theme: { mode: 'dark' }, ai: { offlineOnly: true } });
    expect(patch.theme).toEqual({ mode: 'dark' });
    expect(patch.ai).toEqual({ offlineOnly: true });
  });

  it('丢掉补丁里的其它键（补丁面只有这两个）', () => {
    const patch = asSettingsPatch({ theme: { mode: 'dark' }, window: { width: 1 }, x: 1 });
    expect(Object.keys(patch).sort()).toEqual(['theme']);
  });

  it('字段值是数组/标量时不当成对象放行', () => {
    expect(asSettingsPatch({ theme: [], ai: 'x' })).toEqual({});
  });
});

describe('asFlushResult', () => {
  it('认不出的载荷返回 null —— 调用方必须按"未落盘"处理', () => {
    // null 是最要命的一个：以前它会在 `result.ok` 上抛，而那一步之后
    // 窗口的 close 已经被 preventDefault 过了 → 窗口永远关不掉。
    for (const value of [null, undefined, {}, { ok: 'yes' }, { ok: 1 }, 'ok', []]) {
      expect(asFlushResult(value)).toBeNull();
    }
  });

  it('ok 是布尔值就认', () => {
    expect(asFlushResult({ ok: true })).toEqual({ ok: true });
    expect(asFlushResult({ ok: false })).toEqual({ ok: false });
  });

  it('reason 只在是字符串时保留', () => {
    expect(asFlushResult({ ok: false, reason: '还有 3 秒内容' })).toEqual({
      ok: false,
      reason: '还有 3 秒内容',
    });
    // 非字符串的 reason 会被直接塞进对话框的 detail，变成 [object Object]
    expect(asFlushResult({ ok: false, reason: { a: 1 } })).toEqual({ ok: false });
  });
});

describe('asAiCredentialSetRequest', () => {
  it('没有供应商标识就当请求无效', () => {
    for (const value of [null, undefined, [], { apiKey: 'sk-abcdefgh' }, { providerId: '' }]) {
      expect(asAiCredentialSetRequest(value)).toBeNull();
    }
  });

  it('正常请求原样通过', () => {
    expect(asAiCredentialSetRequest({ providerId: 'deepseek', apiKey: 'sk-abcdefgh' })).toEqual({
      providerId: 'deepseek',
      apiKey: 'sk-abcdefgh',
    });
  });

  it('apiKey 不是字符串时压成空串，交给 normalizeApiKey 回 invalid-key', () => {
    expect(asAiCredentialSetRequest({ providerId: 'deepseek', apiKey: 123 })).toEqual({
      providerId: 'deepseek',
      apiKey: '',
    });
    expect(asAiCredentialSetRequest({ providerId: 'deepseek' })).toEqual({
      providerId: 'deepseek',
      apiKey: '',
    });
  });
});

describe('asProviderId', () => {
  it('只认非空字符串', () => {
    expect(asProviderId('deepseek')).toBe('deepseek');
    expect(asProviderId('  deepseek  ')).toBe('deepseek');
    for (const value of [null, undefined, 42, '', '   ', ['x']]) {
      expect(asProviderId(value)).toBeNull();
    }
  });
});

describe('asPickDirectoryRequest', () => {
  it('非对象收敛成空请求（默认参数挡不住 null）', () => {
    for (const value of [null, undefined, 'x', []]) {
      expect(asPickDirectoryRequest(value)).toEqual({});
    }
  });

  it('只放行字符串字段', () => {
    expect(asPickDirectoryRequest({ title: '选个目录', defaultPath: 'E:/稿件' })).toEqual({
      title: '选个目录',
      defaultPath: 'E:/稿件',
    });
    // 非字符串会直接进 dialog.showOpenDialog，在那里是抛错而不是被忽略
    expect(asPickDirectoryRequest({ title: 5, defaultPath: null })).toEqual({});
  });
});

describe('asEgressAckRequest', () => {
  it('形状不对一律拒（连 providerId 都没有时无从下手）', () => {
    for (const value of [
      null,
      undefined,
      [],
      'deepseek',
      {},
      { acknowledged: true },
      { providerId: '  ', acknowledged: true },
      { providerId: 'deepseek' },
    ]) {
      expect(asEgressAckRequest(value)).toBeNull();
    }
  });

  it('正常请求通过，providerId 去空白', () => {
    expect(asEgressAckRequest({ providerId: ' deepseek ', acknowledged: true })).toEqual({
      providerId: 'deepseek',
      acknowledged: true,
    });
    expect(asEgressAckRequest({ providerId: 'deepseek', acknowledged: false })).toEqual({
      providerId: 'deepseek',
      acknowledged: false,
    });
  });

  it('⚠️ `acknowledged` 非布尔时**拒**，不兜成 true', () => {
    // 这一条与 `asAiCredentialSetRequest` 的"坏 apiKey 压成空串"正好相反，是刻意的：
    // 压成空串只会换来一句"请重新复制粘贴"，而把 `acknowledged` 兜成 true
    // 等于**替用户确认了一次外发** —— 一道隐私闸门被一次形状错误悄悄打开。
    for (const bad of [1, 0, 'true', 'yes', null, undefined, {}]) {
      expect(asEgressAckRequest({ providerId: 'deepseek', acknowledged: bad })).toBeNull();
    }
  });
});
