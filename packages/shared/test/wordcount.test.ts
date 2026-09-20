import { describe, expect, it } from 'vitest';

import fixture from '../fixtures/wordcount-cases.json';
import { countWords, countWordsDefault } from '../src/wordcount';

/**
 * 这份用例与 `services/sidecar/tests/test_wordcount.py` **共用同一个 JSON 文件**。
 *
 * 只在这里断言是不够的 —— 真正要防的是"两份实现各自都过自己的测试，但结果不一样"。
 * 所以用例必须是外部数据，两边都读、都必须全绿。改动前先想清楚是不是两边都要改。
 */

interface Case {
  id: string;
  note: string;
  text: string;
  withPunct: number;
  withoutPunct: number;
}

const cases = fixture.cases as Case[];

describe('字数口径 · 跨语言共享用例', () => {
  it('用例文件非空（防止误删后测试静默变成空跑）', () => {
    expect(cases.length).toBeGreaterThanOrEqual(10);
  });

  it.each(cases)('$id · $note', (testCase) => {
    const result = countWords(testCase.text);
    expect(result.withPunct, `${testCase.id} 含标点口径`).toBe(testCase.withPunct);
    expect(result.withoutPunct, `${testCase.id} 不含标点口径`).toBe(testCase.withoutPunct);
  });
});

describe('字数口径 · 定向要点', () => {
  it('全角空格是空白（中文排版里它真实存在）', () => {
    expect(countWords('你\u3000好')).toEqual({ withPunct: 2, withoutPunct: 2 });
  });

  it('按码点迭代，代理对被算成 1 个而不是 2 个', () => {
    // 若把实现改成 text.length，这条会失败 —— 它就是防这个的。
    expect(countWords('𠮷')).toEqual({ withPunct: 1, withoutPunct: 1 });
    expect(countWords('🖋')).toEqual({ withPunct: 1, withoutPunct: 0 });
  });

  it('emoji 属符号类，只出现在含标点口径里', () => {
    expect(countWords('他笑🖋')).toEqual({ withPunct: 3, withoutPunct: 2 });
  });

  it('默认口径是不含标点', () => {
    expect(countWordsDefault('你好，世界。')).toBe(4);
  });

  it('BOM/ZWNBSP 算空白 —— 与 Python 的 str.isspace() 在此分歧，以本实现为准', () => {
    // 正文中间混入 BOM（从 Word 粘贴常见）。若这里算成字符，
    // sidecar 写进 meta.json 的字数会比界面多 1，用户就会报"字数对不上"。
    expect(countWords('甲乙\uFEFF丙丁')).toEqual({ withPunct: 4, withoutPunct: 4 });
  });

  it('U+0085 与 U+001C 不算空白 —— 与 Python 的 str.isspace() 在此分歧', () => {
    expect(countWords('甲\u0085乙')).toEqual({ withPunct: 3, withoutPunct: 3 });
    expect(countWords('甲\u001C乙')).toEqual({ withPunct: 3, withoutPunct: 3 });
  });
});
