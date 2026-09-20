import type { Node as PMNode } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';

import { fromMd, toMd } from '../src/index';

const render = (md: string): string => toMd(fromMd(md).doc).markdown;
const docOf = (md: string): PMNode => fromMd(md).doc;

const blockTypes = (md: string): string[] => {
  const types: string[] = [];
  docOf(md).forEach((child) => types.push(child.type.name));
  return types;
};

/** 行内结构拍平成 `标记:文本`，一条断言就能看清结构。 */
const inlineSpec = (node: PMNode): string[] => {
  const spec: string[] = [];
  node.forEach((child) => {
    spec.push(`${child.marks.map((m) => m.type.name).sort().join('+')}:${child.text ?? ''}`);
  });
  return spec;
};

const topBlock = (md: string, index = 0): PMNode => {
  const child = docOf(md).child(index);
  if (child === undefined) throw new Error(`没有第 ${index} 个块`);
  return child;
};

/**
 * 二次往返稳定：`render` 一旦输出，再喂回去必须得到同一个字符串。
 *
 * 这是适配层真正要守住的性质 —— 允许"首次加载把文件规范化一次"，
 * 但不允许之后每次打开都微妙地漂一点。
 */
const expectStable = (md: string): void => {
  const once = render(md);
  expect(render(once)).toBe(once);
};

// ---------------------------------------------------------------------------

describe('坑一：行首「数字 + 点」不是有序列表', () => {
  it('按段落解析，文字原样保留', () => {
    const line = '1. 他说，天要下雨了。';
    expect(blockTypes(line)).toEqual(['paragraph']);
    expect(topBlock(line).textContent).toBe(line);
  });

  it('中文里常见的 1. 到 9. 全部如此', () => {
    for (let n = 1; n <= 9; n += 1) {
      expect(blockTypes(`${n}. 他说`)).toEqual(['paragraph']);
    }
  });

  it('往返完全稳定，且不需要任何转义', () => {
    expect(render('1. 他说')).toBe('1. 他说\n');
    expectStable('1. 他说');
  });

  it('给出降级告警，不静默', () => {
    const { warnings } = fromMd('1. 他说');
    expect(warnings[0].code).toBe('DEGRADED_BLOCK');
    expect(warnings.some((w) => w.message.includes('有序列表'))).toBe(true);
  });
});

describe('坑二：行首 - * + 不是无序列表', () => {
  it('- 他说 是段落', () => {
    expect(blockTypes('- 他说')).toEqual(['paragraph']);
    expect(topBlock('- 他说').textContent).toBe('- 他说');
    expect(render('- 他说')).toBe('- 他说\n');
  });

  it('* 与 + 同理', () => {
    expect(blockTypes('* 他说')).toEqual(['paragraph']);
    expect(blockTypes('+ 他说')).toEqual(['paragraph']);
  });

  it('中文破折号开头不受影响，也不产生告警', () => {
    expect(blockTypes('——他说')).toEqual(['paragraph']);
    expect(fromMd('——他说').warnings).toEqual([]);
  });

  it('没有空白分隔时根本不是列表标记', () => {
    expect(fromMd('-他说').warnings).toEqual([]);
  });
});

describe('坑三：--- 是分隔线，不是 setext 标题下划线', () => {
  it('上一行有文字时仍然是分隔线', () => {
    expect(blockTypes('他推开门。\n\n---\n\n风雪灌了进来。')).toEqual([
      'paragraph',
      'horizontalRule',
      'paragraph',
    ]);
  });

  it('三个以上短横归一为 ---', () => {
    expect(render('甲\n\n----------\n\n乙')).toBe('甲\n\n---\n\n乙\n');
  });

  it('不是独占一行的短横只是段落', () => {
    expect(blockTypes('---他说')).toEqual(['paragraph']);
    expect(blockTypes('--- 他说')).toEqual(['paragraph']);
  });
});

// ---------------------------------------------------------------------------

describe('块级结构', () => {
  it('一到三级标题', () => {
    expect(topBlock('# 第一章').attrs.level).toBe(1);
    expect(topBlock('## 第一章').attrs.level).toBe(2);
    expect(topBlock('### 第一章').attrs.level).toBe(3);
  });

  it('四级及以上降级为段落并告警', () => {
    expect(blockTypes('#### 太深了')).toEqual(['paragraph']);
    expect(fromMd('#### 太深了').warnings.some((w) => w.message.includes('超出白名单'))).toBe(true);
  });

  it('连续多行引用合成一个 blockquote', () => {
    expect(blockTypes('> 甲\n> 乙')).toEqual(['blockquote']);
    const quote = topBlock('> 甲\n> 乙');
    expect(quote.childCount).toBe(2);
    expect(quote.textContent).toBe('甲乙');
  });

  it('空引用也给一个段落兜底（blockquote 要求至少一个块）', () => {
    const quote = topBlock('>');
    expect(quote.type.name).toBe('blockquote');
    expect(quote.childCount).toBe(1);
  });

  it('嵌套引用', () => {
    expect(topBlock('> > 深一层').firstChild?.type.name).toBe('blockquote');
  });

  it('空文档也给出一个空段落，保证文档结构合法', () => {
    const doc = docOf('');
    expect(doc.childCount).toBe(1);
    expect(doc.firstChild?.type.name).toBe('paragraph');
  });
});

// ---------------------------------------------------------------------------

describe('行内标记', () => {
  it('加粗', () => {
    expect(inlineSpec(topBlock('**粗体**'))).toEqual(['bold:粗体']);
  });

  it('斜体', () => {
    expect(inlineSpec(topBlock('*斜体*'))).toEqual(['italic:斜体']);
  });

  it('三星号 = 加粗 + 斜体', () => {
    expect(inlineSpec(topBlock('***粗斜***'))).toEqual(['bold+italic:粗斜']);
  });

  it('加粗与斜体混排', () => {
    expect(inlineSpec(topBlock('**粗**和*斜*'))).toEqual(['bold:粗', ':和', 'italic:斜']);
  });

  it('加粗内部嵌套斜体', () => {
    expect(inlineSpec(topBlock('**前 *中* 后**'))).toEqual([
      'bold:前 ',
      'bold+italic:中',
      'bold: 后',
    ]);
  });

  it('转义的星号是字面量', () => {
    // 转义后整段没有任何标记，且落盘时会把星号重新转义回去 —— 否则重开会变成斜体。
    expect(inlineSpec(topBlock('\\*不是斜体\\*'))).toEqual([':*不是斜体*']);
    expect(render('\\*不是斜体\\*')).toBe('\\*不是斜体\\*\n');
  });

  it('下划线始终是字面量（否则 file_name 会被吃掉）', () => {
    expect(topBlock('file_name 和 _x_').textContent).toBe('file_name 和 _x_');
  });

  it('配成对的星号按 Markdown 语义当强调，落盘后不再漂移', () => {
    // 两个星号会被当成一对强调符 —— 这是 Markdown 的固有语义，不是 bug。
    expect(inlineSpec(topBlock('3*4*5'))).toEqual([':3', 'italic:4', ':5']);
    expect(render('3*4*5')).toBe('3*4*5\n');
  });

  it('落单的星号是字面量，不会被吃掉', () => {
    // 更常见的写法：数字乘号只有一个星号，天然配不成对，因此原样保留。
    expect(inlineSpec(topBlock('3*4=12'))).toEqual([':3*4=12']);
    expect(topBlock('3*4').textContent).toBe('3*4');
  });

  it('字面量星号落盘时会被转义，且这是一次性的', () => {
    // 文档 §5.4/§5.5 明确规定的行为：字面量 `*` 在序列化时转义成 `\*`，
    // 首次规范化引入、之后稳定（I3）。用 `\*` 换掉"格式丢失"是划算的。
    const once = render('3*4=12');
    expect(once).toBe('3\\*4=12\n');
    expect(render(once)).toBe(once);
    // 转义不该产生告警 —— 内容一个字符都没丢，没有"不支持的格式"可言。
    expect(fromMd('3*4=12').warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('白名单外语法：降级为纯文本且必须告警', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['| 甲 | 乙 |', '表格行'],
    ['```', '代码块围栏'],
    ['`行内代码`', '行内代码'],
    ['![图](a.png)', '图片'],
    ['[链接](https://example.com)', '链接'],
    ['<div>', 'HTML 标签'],
  ];

  it.each(cases)('%j', (line, label) => {
    const { doc, warnings } = fromMd(line);
    expect(doc.firstChild?.type.name).toBe('paragraph');
    expect(doc.textContent).toBe(line);
    expect(warnings.some((w) => w.message.includes(label))).toBe(true);
  });

  it('普通中文正文一条告警都不产生', () => {
    const novel = [
      '# 第一章 初入宗门',
      '',
      '他推开门。',
      '风雪灌了进来。',
      '',
      '「你来了。」老人说。',
      '',
      '——他愣了一下。',
    ].join('\n');

    expect(fromMd(novel).warnings).toEqual([]);
  });
});
