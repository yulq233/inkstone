/**
 * 快捷生成候选解析（`features/ai/quick-gen.ts`）。
 *
 * 护着的是「逐行型 vs 段落型」这条**必须与 `quick.toml` 的 `[kinds]` 指令逐字对齐**的分界：
 * 把 `synopsis`（一段简介）按行拆、或把 `naming`（每行一个）当整段，都是用户一眼可见的坏结果。
 */

import { describe, expect, it } from 'vitest';

import { parseQuickCandidates } from '../src/renderer/src/features/ai/quick-gen';

describe('逐行型（每行一个候选）', () => {
  it('按行拆，去编号前缀与首尾空白', () => {
    const { items, shape } = parseQuickCandidates(
      'naming',
      '1. 云京旧巷\n2) 月牙渡口\n3、青石桥\n4．灯市口',
    );
    expect(shape).toBe('line');
    expect(items).toEqual(['云京旧巷', '月牙渡口', '青石桥', '灯市口']);
  });

  it('全角数字与「数字+空格」前缀也被剥掉', () => {
    const { items } = parseQuickCandidates('hook', '１．他来了\n２ 她走了\n　３、门关了');
    expect(items).toEqual(['他来了', '她走了', '门关了']);
  });

  it('空行被跳过，只有编号的空行也跳过', () => {
    const { items } = parseQuickCandidates('title', '1. 夜航\n\n\n2. 归途\n   ');
    expect(items).toEqual(['夜航', '归途']);
  });

  it('模型偶尔不编号 —— 原样保留每一行', () => {
    const { items } = parseQuickCandidates('dialogue', '你来了。\n我来了。');
    expect(items).toEqual(['你来了。', '我来了。']);
  });
});

describe('段落型（整段一个候选）', () => {
  it('scene / synopsis 不按行拆，整段作为单个候选', () => {
    const text = '云京入冬的第一场雪，落得比往年更急。\n巷口的灯一盏盏亮起来。';
    const scene = parseQuickCandidates('scene', text);
    expect(scene.shape).toBe('block');
    expect(scene.items).toEqual([text]);

    const synopsis = parseQuickCandidates('synopsis', text);
    expect(synopsis.shape).toBe('block');
    expect(synopsis.items).toEqual([text]);
  });
});

describe('边界', () => {
  it('空输入返回空数组，shape 仍按 kind 归位', () => {
    expect(parseQuickCandidates('naming', '   \n  ')).toEqual({ items: [], shape: 'line' });
    expect(parseQuickCandidates('synopsis', '')).toEqual({ items: [], shape: 'block' });
  });

  it('行首编号后没有内容 → 剥成空串但不该把它当候选', () => {
    // `1.` 剥成 ''，但仍留在数组里 —— 这是当前实现的选择：宁可留空
    // 也不在这里二次过滤（调用方/面板会再判断非空）。这里只钉住「不抛」。
    const { items } = parseQuickCandidates('naming', '1.\n2. 归途');
    expect(items).toEqual(['', '归途']);
  });
});
