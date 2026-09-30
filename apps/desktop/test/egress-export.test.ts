/**
 * 外发记录导出（`features/ai/egress-export.ts`）。
 *
 * 护三件用户会直接较真的事：CSV 带表头、中文带 BOM、逗号/引号/换行正确转义。
 * 前两件是「功能对了但用户一看就以为坏了」的高发区（Excel 按 GBK 解 BOM 缺失的中文）。
 */

import { describe, expect, it } from 'vitest';
import type { AiRun } from '@inkstone/shared';

import { runsToCsv, runsToJson } from '../src/renderer/src/features/ai/egress-export';

function run(overrides: Partial<AiRun> = {}): AiRun {
  return {
    id: 'r_1',
    workId: 'w_1',
    at: '2026-03-20T14:30:00+08:00',
    taskType: 'continue',
    targetRef: 'chapter:c1',
    providerId: 'deepseek',
    model: 'deepseek-chat',
    promptDigest: 'd',
    contextTokens: 1200,
    outputTokens: 88,
    egressChars: 1500,
    costCny: 0.0031,
    latencyMs: 6400,
    firstTokenMs: 1800,
    accepted: 'full',
    acceptedChars: 30,
    stopped: false,
    error: null,
    ...overrides,
  };
}

describe('CSV 序列化', () => {
  it('带 UTF-8 BOM 且 CRLF 换行（Excel 能正确解中文的前提）', () => {
    const csv = runsToCsv([run()]);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('\r\n');
    // BOM 只出现在最开头，不在行中间
    expect(csv.slice(1)).not.toContain('\uFEFF');
  });

  it('表头列顺序与文案', () => {
    const csv = runsToCsv([]);
    const header = csv.replace('\uFEFF', '').split('\r\n')[0];
    expect(header).toBe(
      '时间,任务,提供方,模型,外发字符,上下文token,输出token,估算成本(元),首字延迟(ms),总耗时(ms),停止,采纳',
    );
  });

  it('空记录只有表头一行', () => {
    const lines = runsToCsv([]).replace('\uFEFF', '').split('\r\n');
    expect(lines).toEqual([
      '时间,任务,提供方,模型,外发字符,上下文token,输出token,估算成本(元),首字延迟(ms),总耗时(ms),停止,采纳',
      '',
    ]);
  });

  it('成本 null → 空单元格（不编 0），采纳 null → 空', () => {
    const csv = runsToCsv([run({ costCny: null, accepted: null })]);
    const row = csv.replace('\uFEFF', '').split('\r\n')[1];
    const cells = row.split(',');
    expect(cells[7]).toBe('');
    expect(cells[11]).toBe('');
  });

  it('含逗号/引号的字段被加引号并转义', () => {
    const csv = runsToCsv([run({ model: 'gpt, "4o"' })]);
    const row = csv.replace('\uFEFF', '').split('\r\n')[1];
    expect(row).toContain('"gpt, ""4o"""');
  });

  it('停止/采纳的布尔与枚举落成中文', () => {
    const csv = runsToCsv([run({ stopped: true, accepted: 'none' })]);
    const cells = csv.replace('\uFEFF', '').split('\r\n')[1].split(',');
    expect(cells[10]).toBe('是');
    expect(cells[11]).toBe('none');
  });
});

describe('JSON 序列化', () => {
  it('缩进 2，可回解析', () => {
    const json = runsToJson([run()]);
    expect(json.startsWith('[')).toBe(true);
    expect(json).toContain('\n  ');
    expect(JSON.parse(json)).toHaveLength(1);
  });
});
