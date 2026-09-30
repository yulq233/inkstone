/**
 * 主进程日志脱敏（`docs/11` §3.3 / §8）。
 *
 * 这组用例的价值集中在一条：**从没见过的服务返回的报错里带着 Key 时也能擦掉**。
 * 按值擦除做不到这件事（要先知道 Key 是什么，那要求本模块持有凭据表），
 * 所以这里按形态擦 —— 而"形态认得全不全"只能靠用例钉住。
 */

import { describe, expect, it } from 'vitest';
import { redactSecrets, redactValue } from '../src/main/redact';

describe('redactSecrets', () => {
  it('擦掉 sk- 形态的密钥', () => {
    const out = redactSecrets('upstream said: invalid key sk-proj-abcdefghijklmnop');
    expect(out).not.toContain('sk-proj-abcdefghijklmnop');
    expect(out).toContain('<redacted>');
    // 其余上下文要留着：日志的价值在于"哪里出了什么事"
    expect(out).toContain('invalid key');
  });

  it('擦掉 Bearer 后面的内容但保留 Bearer 这个词', () => {
    const out = redactSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig');
    expect(out).toContain('Bearer <redacted>');
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  it('擦掉常见字段名后面的值（JSON 形式）', () => {
    const out = redactSecrets('{"apiKey":"abcdefghijklmnop","model":"deepseek-chat"}');
    expect(out).not.toContain('abcdefghijklmnop');
    expect(out).toContain('"model":"deepseek-chat"');
  });

  it('擦掉常见字段名后面的值（查询串形式）', () => {
    const out = redactSecrets('https://api.example.com/v1?apikey=abcdefgh&model=x');
    expect(out).not.toContain('abcdefgh');
    expect(out).toContain('model=x');
  });

  it('擦掉 x-inkstone-token 这类本地凭据', () => {
    const out = redactSecrets('x-inkstone-token: 9f2c1e4a7b3d5f809a1c2e3d4f5a6b7c');
    expect(out).not.toContain('9f2c1e4a7b3d5f809a1c2e3d4f5a6b7c');
  });

  it('擦掉下划线连接的 INKSTONE_TOKEN（`\\b` 在这里拿不到词边界）', () => {
    // 环境变量名里的 `_` 是词字符，`\bTOKEN` 因此永远不匹配 ——
    // 而这是真实存在的形态：sidecar 启动环境里就有 `INKSTONE_TOKEN`（`sidecar/env.ts`）。
    const out = redactSecrets('env: INKSTONE_TOKEN=9f2c1e4a7b3d5f809a1c2e3d4f5a6b7c');
    expect(out).not.toContain('9f2c1e4a7b3d5f809a1c2e3d4f5a6b7c');
    // 字段名要留着：日志的价值在于"这里曾经有个凭据"
    expect(out).toContain('INKSTONE_TOKEN=<redacted>');
  });

  it('同一个 Key 出现两次时两处都擦', () => {
    const key = 'sk-abcdefghijklmnop';
    const out = redactSecrets(`first=${key} second=${key}`);
    expect(out).not.toContain(key);
    expect(out.match(/<redacted>/g)).toHaveLength(2);
  });

  it('短到不可能是密钥的串不动它（避免把日志擦成一片红）', () => {
    // 4 个字符：形态上不满足任何一条模式的下限
    expect(redactSecrets('model: gpt')).toBe('model: gpt');
    expect(redactSecrets('耗时 128ms')).toBe('耗时 128ms');
  });

  it('中文与多行文本保持原样', () => {
    const text = '第一行\n第二行：模型服务拒绝了这次请求。';
    expect(redactSecrets(text)).toBe(text);
  });

  it('redactValue 对非字符串也安全', () => {
    expect(redactValue(new Error('bad sk-abcdefghijklmnop'))).toContain('<redacted>');
    expect(redactValue(undefined)).toBe('undefined');
  });
});
