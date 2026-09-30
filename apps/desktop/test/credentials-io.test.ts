/**
 * 凭据文件的纯逻辑（`docs/11` §3.3 / §4.5）。
 *
 * 这个文件能存在，靠的是 `credentials-io.ts` 把加解密抽象成 `CredentialCipher` 注入进来。
 * 真实实现走 `safeStorage`，它在测试环境里根本载不进来 —— 而"文件坏成什么样还能救"
 * 恰恰是最需要用例的地方（自愈逻辑写错了不会有报错，只会**默默丢掉用户的 Key**）。
 *
 * 所以下面用一个最朴素的"加密"（就是加个前缀）来验逻辑，不验算法。
 */

import { describe, expect, it } from 'vitest';
import type { ProviderConfig } from '@inkstone/shared';
import {
  CREDENTIALS_SCHEMA_VERSION,
  credentialStatuses,
  decodeCredentialDoc,
  emptyCredentialDoc,
  normalizeApiKey,
  parseCredentialDoc,
  serializeCredentialDoc,
  type CredentialCipher,
} from '../src/main/store/credentials-io';

/**
 * 假 cipher：把明文倒序再套前缀。
 *
 * **刻意不用 `enc:${plain}` 这种"套个壳"的写法** —— 那样密文里仍然含有明文，
 * 于是"文件里不出现明文"这条断言无法验证（第一版就是这么写的，它自己跟自己矛盾）。
 * 倒序倒不是密码学，但对"密文与明文不重叠"这个被测性质来说足够了。
 */
const cipher: CredentialCipher = {
  encrypt: (plain) => `enc:${[...plain].reverse().join('')}`,
  decrypt: (encoded) =>
    encoded.startsWith('enc:') ? [...encoded.slice(4)].reverse().join('') : null,
};

function provider(id: string): ProviderConfig {
  return {
    id,
    kind: 'openai-compatible',
    label: id,
    baseUrl: 'https://api.example.com/v1',
    local: false,
    needsKey: true,
  };
}

describe('normalizeApiKey', () => {
  it('去掉粘贴时带进来的首尾空白与换行', () => {
    // 从网页复制 Key 时带上换行是极高频的事 —— 该修的是那个不可见字符，不是拒收
    expect(normalizeApiKey('  sk-abcdefgh\n')).toBe('sk-abcdefgh');
    expect(normalizeApiKey('\tsk-abcdefgh\r\n')).toBe('sk-abcdefgh');
  });

  it('拒绝空、纯空白、非字符串', () => {
    expect(normalizeApiKey('')).toBeNull();
    expect(normalizeApiKey('     ')).toBeNull();
    expect(normalizeApiKey(null)).toBeNull();
    expect(normalizeApiKey(12345)).toBeNull();
    expect(normalizeApiKey({ key: 'sk-abcdefgh' })).toBeNull();
  });

  it('拒绝太短与超长的输入', () => {
    expect(normalizeApiKey('abc')).toBeNull();
    expect(normalizeApiKey('a'.repeat(513))).toBeNull();
    expect(normalizeApiKey('abcd')).toBe('abcd');
    expect(normalizeApiKey('a'.repeat(512))).toBe('a'.repeat(512));
  });

  it('拒绝中间夹着空白或控制字符的输入', () => {
    expect(normalizeApiKey('sk-abcd efgh')).toBeNull();
    expect(normalizeApiKey('sk-abcd\nefgh')).toBeNull();
    // \u0000 是粘贴时可能混进来的不可见字符：不能让它进 Authorization 头
    expect(normalizeApiKey('sk-abcd\u0000efgh')).toBeNull();
  });

  it('不按前缀拒绝：自定义供应商的 Key 形态不限', () => {
    // 按 `sk-` 前缀拒绝会把能用的中转服务拦在门外
    expect(normalizeApiKey('local-token-1234')).toBe('local-token-1234');
  });
});

describe('parseCredentialDoc', () => {
  it('非对象一律当空文档，并标记需要重写', () => {
    for (const bad of [null, undefined, 42, 'text', []]) {
      const parsed = parseCredentialDoc(bad);
      expect(parsed.doc).toEqual(emptyCredentialDoc());
      expect(parsed.repaired).toBe(true);
      expect(parsed.unsupportedVersion).toBe(false);
    }
  });

  it('版本号不认识时不自作主张，交给调用方留档', () => {
    const parsed = parseCredentialDoc({ schemaVersion: 99, entries: { deepseek: 'enc:x' } });
    // 关键：**不按 v1 解读**。万一那是未来版本写的，就地解读会把新字段全删掉
    expect(parsed.unsupportedVersion).toBe(true);
    expect(parsed.doc.entries).toEqual({});
  });

  it('一个坏条目只丢它自己，其余照用', () => {
    const parsed = parseCredentialDoc({
      schemaVersion: 1,
      entries: { deepseek: 'enc:good', broken: 42, alsoBroken: '', ollama: 'enc:local' },
    });
    expect(Object.keys(parsed.doc.entries)).toEqual(['deepseek', 'ollama']);
    expect(parsed.repaired).toBe(true);
  });

  it('缺 schemaVersion 时按当前版本升格，并标记重写', () => {
    const parsed = parseCredentialDoc({ entries: { deepseek: 'enc:x' } });
    expect(parsed.doc.schemaVersion).toBe(CREDENTIALS_SCHEMA_VERSION);
    expect(parsed.repaired).toBe(true);
    expect(parsed.doc.entries).toEqual({ deepseek: 'enc:x' });
  });

  it('合法的文件原样通过且不标记重写', () => {
    const parsed = parseCredentialDoc({
      schemaVersion: CREDENTIALS_SCHEMA_VERSION,
      entries: { deepseek: 'enc:x' },
    });
    expect(parsed.repaired).toBe(false);
    expect(parsed.unsupportedVersion).toBe(false);
  });
});

describe('serializeCredentialDoc', () => {
  it('写入时全部经过 cipher，文件里不出现明文', () => {
    const doc = serializeCredentialDoc(new Map([['deepseek', 'sk-plainsecret']]), cipher);
    expect(doc.schemaVersion).toBe(CREDENTIALS_SCHEMA_VERSION);
    expect(JSON.stringify(doc)).not.toContain('sk-plainsecret');
    expect(doc.entries.deepseek).toBe(`enc:${[...'sk-plainsecret'].reverse().join('')}`);
  });

  it('空值不写进文件（避免文件里留一堆空壳条目）', () => {
    const doc = serializeCredentialDoc(new Map([['deepseek', '']]), cipher);
    expect(doc.entries).toEqual({});
  });
});

describe('decodeCredentialDoc', () => {
  it('往返一致（encode → parse → decode）', () => {
    const source = new Map([
      ['deepseek', 'sk-aaaa1111'],
      ['ollama', 'not-needed'],
    ]);
    const doc = serializeCredentialDoc(source, cipher);
    const parsed = parseCredentialDoc(JSON.parse(JSON.stringify(doc)));
    const decoded = decodeCredentialDoc(parsed.doc, cipher);

    expect(decoded.failed).toEqual([]);
    expect(decoded.entries).toEqual(source);
  });

  it('解不开的条目如实报告并跳过，不影响其它条目', () => {
    // 换机器 / 系统密钥重置 → 多半是全部解不开，但"部分解不开"也必须能正确报告
    const doc = {
      schemaVersion: CREDENTIALS_SCHEMA_VERSION,
      entries: { deepseek: 'enc:ok', stale: 'GARBAGE', ollama: 'enc:ok2' },
    };
    const decoded = decodeCredentialDoc(doc, cipher);

    expect(decoded.failed).toEqual(['stale']);
    expect([...decoded.entries.keys()]).toEqual(['deepseek', 'ollama']);
  });
});

describe('credentialStatuses', () => {
  it('只回布尔，且不含任何 Key 片段', () => {
    const providers = [provider('deepseek'), provider('ollama')];
    const statuses = credentialStatuses(providers, new Map([['deepseek', 'sk-secret']]));

    expect(statuses).toEqual([
      { providerId: 'deepseek', hasCredential: true },
      { providerId: 'ollama', hasCredential: false },
    ]);
    // 每个条目只能有这两个字段（多一个"脱敏提示"就等于把 Key 片段放进渲染进程）
    for (const status of statuses)
      expect(Object.keys(status).sort()).toEqual(['hasCredential', 'providerId']);
    expect(JSON.stringify(statuses)).not.toContain('sk-secret');
  });

  it('空串算未配置', () => {
    const statuses = credentialStatuses([provider('deepseek')], new Map([['deepseek', '']]));
    expect(statuses[0]?.hasCredential).toBe(false);
  });
});
