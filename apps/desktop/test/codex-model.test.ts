/**
 * 设定面板纯逻辑测试（docs/15 B3）。
 *
 * 只测 `codex-model.ts` / `name-generator.ts` 的纯函数 —— 判定逻辑全在这里，
 * 组件只是"把状态交给它们再渲染"，无 jsdom 环境也可穷举。
 */

import { describe, expect, it } from 'vitest';
import {
  brokenRelationText,
  entryToUpdateRequest,
  fieldsToRows,
  joinList,
  rowsToFields,
  sortCodexList,
  splitList,
} from '../src/renderer/src/features/codex/codex-model';
import { generateName, generateNames } from '../src/renderer/src/features/codex/name-generator';
import type { CodexEntrySummary } from '@inkstone/shared';

function summary(overrides: Partial<CodexEntrySummary>): CodexEntrySummary {
  return {
    type: 'character',
    slug: 'x',
    name: '沈观澜',
    aliases: [],
    tags: [],
    summary: '',
    hash: 'h',
    ...overrides,
  };
}

describe('sortCodexList', () => {
  it('按类型固定序、同类型按中文 locale 序', () => {
    const items = [
      summary({ type: 'location', name: '云京' }),
      summary({ type: 'character', name: '王五' }),
      summary({ type: 'character', name: '沈观澜' }),
      summary({ type: 'faction', name: '云京司' }),
    ];
    const sorted = sortCodexList(items);
    expect(sorted.map((i) => i.name)).toEqual(['沈观澜', '王五', '云京', '云京司']);
  });

  it('不改动入参数组（返回副本）', () => {
    const items = [summary({ type: 'location', name: '云京' }), summary({ name: '甲' })];
    const before = items.map((i) => i.name);
    sortCodexList(items);
    expect(items.map((i) => i.name)).toEqual(before);
  });
});

describe('fields ↔ rows 往返', () => {
  it('标量 / 列表 / 对象都能往返', () => {
    const fields = { 年龄: 27, 性格标签: ['谨慎', '重诺'], 外貌: { 瞳色: '黑' } };
    expect(rowsToFields(fieldsToRows(fields))).toEqual(fields);
  });

  it('空键行被丢弃，纯文本值当字符串保留', () => {
    const rows = [
      { id: 1, key: '职业', value: '主事' },
      { id: 2, key: '   ', value: 'x' },
      { id: 3, key: '备注', value: '带冒号的:文本' },
    ];
    expect(rowsToFields(rows)).toEqual({ 职业: '主事', 备注: '带冒号的:文本' });
  });

  it('非法 JSON 值回退为纯字符串，不抛错', () => {
    expect(rowsToFields([{ id: 1, key: '备注', value: '[未闭合' }])).toEqual({ 备注: '[未闭合' });
  });
});

describe('entryToUpdateRequest', () => {
  it('剥掉 slug 与 hash（服务端派生字段，回灌会被 extra=forbid 拦 400）', () => {
    const entry = {
      type: 'character' as const,
      slug: '沈观澜',
      name: '沈观澜',
      aliases: [],
      tags: [],
      summary: '',
      fields: {},
      relations: [],
      body: '',
      hash: 'abcdef',
    };
    const req = entryToUpdateRequest(entry, 'abcdef');
    expect('slug' in req).toBe(false);
    expect('hash' in req).toBe(false);
    expect(req.ifMatch).toBe('abcdef');
    expect(req.type).toBe('character');
  });
});

describe('splitList / joinList', () => {
  it('中英文逗号都分、剥空白丢空串', () => {
    expect(splitList('观澜，沈先生, 老沈,,')).toEqual(['观澜', '沈先生', '老沈']);
  });
  it('往返稳定', () => {
    expect(splitList(joinList(['观澜', '沈先生']))).toEqual(['观澜', '沈先生']);
  });
});

describe('brokenRelationText', () => {
  it('生成人能看懂的一句话', () => {
    const text = brokenRelationText({
      type: 'character',
      slug: 'a',
      name: '沈观澜',
      to: '沈砚之',
      kind: '父子',
    });
    expect(text).toContain('沈观澜');
    expect(text).toContain('沈砚之');
    expect(text).toContain('父子');
  });
});

describe('name-generator', () => {
  it('种子随机源可确定性复现', () => {
    const rng = (() => {
      let n = 0;
      return () => (n++ % 10) / 10;
    })();
    const a = generateName(rng);
    // 同一种子序列再跑一遍应得到同一名字（确定性）。
    const rng2 = (() => {
      let n = 0;
      return () => (n++ % 10) / 10;
    })();
    expect(generateName(rng2).name).toBe(a.name);
  });

  it('名字非空且为纯中文字符', () => {
    const name = generateName().name;
    expect(name.length).toBeGreaterThanOrEqual(2);
    expect(/^[\u4e00-\u9fa5]+$/.test(name)).toBe(true);
  });

  it('排除集里的名字不会被返回（除非字库退无可退）', () => {
    // 用递增 rng 覆盖整个字库（每次 rng 调用取不同下标），
    // 排除"沈观"后，只要字库还有别的组合，就绝不返回它。
    let call = 0;
    const rng = () => (call++ % 100) / 100; // 覆盖 0~0.99，足够遍历
    for (let i = 0; i < 50; i += 1) {
      const name = generateName(rng, new Set(['沈观'])).name;
      expect(name).not.toBe('沈观');
    }
  });

  it('批量生成去重且数量达标', () => {
    const names = generateNames(5).map((c) => c.name);
    expect(names.length).toBe(5);
    expect(new Set(names).size).toBe(5);
  });
});
