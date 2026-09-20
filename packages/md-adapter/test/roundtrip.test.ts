/**
 * 往返性质测试。
 *
 * 断言的核心是两条：
 *
 * - **I1 幂等**：`normalize(normalize(x)) === normalize(x)`
 * - **I2 不动点**：`render(render(x)) === render(x)`，其中 `render = toMd ∘ fromMd`
 *
 * 说明一处与设计文档 §5.3 的措辞差异：文档写的 I2 是
 * `toMd(fromMd(md)) === normalize(md)`（即输出必须与输入规范化后逐字相同）。
 * 这条在**纯文本**下成立，但对含 `*`、行首 `#`/`>`/`---` 的正文不成立 ——
 * 那些位置必须插入转义符才能保住语义。所以这里把它精确化为：
 *
 *   纯文本语料  →  `render(md) === normalize(md)`（逐字相同，强断言）
 *   含元字符语料 →  `render(render(md)) === render(md)`（一次规范化后不再漂移）
 *
 * 后者才是用户真正在意的性质：允许首次加载把文件规范化一次，之后不许再变。
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { fromMd, normalize, toMd } from '../src/index';

const render = (md: string): string => toMd(fromMd(md).doc).markdown;

/** 常用汉字（覆盖不同部首与笔画数），避免只测到零星几个字。 */
const CJK =
  '的一是不了人我在有他这为之大来以个中上们到说国和地也子时道出而要于就下得可你年生自会那后能对着事其里所去行过家十用发天如然作方成者多日都三小军二无同么经法当起与好看学进种将还分此心前面又定见只主没公从';

/** 中文全角标点 —— 必须能被正确排除在"不含标点"字数之外，且不影响往返。 */
const PUNCT = '，。！？；：、「」『』（）—…·';

/** Markdown 元字符。这些字符会触发转义或块级判定，是往返最容易翻车的地方。 */
const META = '*#\\>-`|_+~ ';

const plainUnit = fc.constantFrom(...CJK.split(''), ...PUNCT.split(''), ' ');
const metaUnit = fc.constantFrom(...META.split(''), ...CJK.split(''), ...PUNCT.split(''));

const plainDoc = fc
  .array(fc.string({ minLength: 1, maxLength: 40, unit: plainUnit }), {
    minLength: 1,
    maxLength: 6,
  })
  .map((lines) => lines.filter((line) => line.trim() !== '').join('\n'))
  .filter((md) => md.trim() !== '');

const metaDoc = fc
  .array(fc.string({ minLength: 0, maxLength: 40, unit: metaUnit }), {
    minLength: 0,
    maxLength: 6,
  })
  .map((lines) => lines.join('\n'));

describe('I1 · normalize 幂等', () => {
  it('对含元字符的随机文本成立', () => {
    fc.assert(
      fc.property(metaDoc, (md) => {
        const once = normalize(md);
        expect(normalize(once)).toBe(once);
      }),
      { numRuns: 300 },
    );
  });

  it('对纯中文正文成立', () => {
    fc.assert(
      fc.property(plainDoc, (md) => {
        const once = normalize(md);
        expect(normalize(once)).toBe(once);
      }),
      { numRuns: 200 },
    );
  });
});

describe('I2 · 纯文本往返逐字相同', () => {
  it('不含元字符时 render(md) === normalize(md)', () => {
    fc.assert(
      fc.property(plainDoc, (md) => {
        expect(render(md)).toBe(normalize(md));
      }),
      { numRuns: 200 },
    );
  });

  it('纯文本内容一个字符都不丢', () => {
    fc.assert(
      fc.property(plainDoc, (md) => {
        const expected = normalize(md)
          .split('\n')
          .filter((line) => line !== '')
          .join('');
        expect(fromMd(md).doc.textContent).toBe(expected);
      }),
      { numRuns: 200 },
    );
  });
});

describe('I3 · 含元字符时二次往返稳定', () => {
  it('render(render(md)) === render(md)', () => {
    fc.assert(
      fc.property(metaDoc, (md) => {
        const once = render(md);
        expect(render(once)).toBe(once);
      }),
      { numRuns: 300, verbose: false },
    );
  });

  it('含 ≥1000 字的连续段落也稳定', () => {
    const long = fc.string({ minLength: 1000, maxLength: 1400, unit: metaUnit });
    fc.assert(
      fc.property(long, (text) => {
        const once = render(text);
        expect(render(once)).toBe(once);
      }),
      { numRuns: 30 },
    );
  });
});

describe('约定的边界样本', () => {
  const samples: readonly string[] = [
    '',
    '\n',
    '甲',
    '#',
    '# 标题',
    '---',
    '\\',
    '\\\\',
    '*',
    '**',
    '***',
    '****',
    '*a',
    'a*',
    '\\*literal\\*',
    '**a***',
    '# 第一章 初入宗门\n\n他推开门。\n\n---\n\n风雪灌了进来。\n',
    '> 引用\n>\n> 第二段',
    '> > 深一层',
    '1. 他说\n- 他说\n| 甲 | 乙 |\n`code`\n[链接](a)\n<div>',
    '#\n##\n###\n####\n#####',
    'a\n\n\n\n\n\nb',
    ' file_name 与 __init__ 与 _x_ ',
    '中文🖋表情与生僻字𠮷',
    '甲\n---\n乙',
    '----',
  ];

  it.each(samples)('二次往返稳定 · %j', (md) => {
    const once = render(md);
    expect(render(once)).toBe(once);
  });

  it.each(samples)('归一化幂等 · %j', (md) => {
    expect(normalize(normalize(md))).toBe(normalize(md));
  });
});
