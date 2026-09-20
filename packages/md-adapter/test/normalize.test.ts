import { describe, expect, it } from 'vitest';

import { normalize } from '../src/normalize';

/** I1：`normalize` 必须幂等。这是所有往返稳定的前提。 */
function expectIdempotent(input: string): void {
  const once = normalize(input);
  expect(normalize(once)).toBe(once);
}

describe('normalize · 基本规范化', () => {
  it('空文件保持为空', () => {
    expect(normalize('')).toBe('');
    expect(normalize('\n\n\n')).toBe('');
  });

  it('末尾恰好补一个换行', () => {
    expect(normalize('甲')).toBe('甲\n');
    expect(normalize('甲\n')).toBe('甲\n');
    expect(normalize('甲\n\n\n\n')).toBe('甲\n');
  });

  it('统一 CRLF / CR 为 LF', () => {
    expect(normalize('甲\r\n乙\r')).toBe('甲\n乙\n');
  });

  it('去掉 BOM', () => {
    expect(normalize('\ufeff甲')).toBe('甲\n');
  });

  it('去掉行尾空白（只去行尾，行首缩进保留）', () => {
    expect(normalize('甲   \t\n  乙')).toBe('甲\n  乙\n');
  });

  it('把连续空行压成最多一个', () => {
    expect(normalize('甲\n\n\n\n\n乙')).toBe('甲\n\n乙\n');
  });

  it('去掉文件开头与结尾的空行', () => {
    expect(normalize('\n\n甲\n\n')).toBe('甲\n');
  });
});

describe('normalize · 块级间距', () => {
  it('标题前后各保证一个空行', () => {
    expect(normalize('甲\n# 标题\n乙')).toBe('甲\n\n# 标题\n\n乙\n');
  });

  it('文件开头的标题不产生前导空行', () => {
    expect(normalize('# 标题\n正文')).toBe('# 标题\n\n正文\n');
  });

  it('分隔线统一为 --- 且前后各一个空行', () => {
    expect(normalize('甲\n---\n乙')).toBe('甲\n\n---\n\n乙\n');
    expect(normalize('甲\n----------\n乙')).toBe('甲\n\n---\n\n乙\n');
  });

  it('`#第一章` 没有空白分隔，不算标题', () => {
    expect(normalize('#第一章')).toBe('#第一章\n');
  });
});

describe('normalize · 强调标记统一', () => {
  it('__强调__ 统一为 **强调**', () => {
    expect(normalize('__粗体__')).toBe('**粗体**\n');
  });

  it('**强调** 保持不变', () => {
    expect(normalize('**粗体**')).toBe('**粗体**\n');
  });

  it('下划线不动 —— 否则 snake_case 会被改成 snake*case', () => {
    expect(normalize('file_name')).toBe('file_name\n');
    expect(normalize('_斜体_')).toBe('_斜体_\n');
  });

  it('词内的 __ 不算强调（与 CommonMark 一致）', () => {
    expect(normalize('a__b__')).toBe('a__b__\n');
  });

  it('形似但不成对的 __ 不被改写', () => {
    expect(normalize('___x___')).toBe('___x___\n');
  });

  it('已知后果：__init__ 会被当成强调', () => {
    // 记下来是为了将来的自己别以为是 bug：这是"统一标记"换来的代价，且是幂等的。
    expect(normalize('__init__')).toBe('**init**\n');
  });
});

describe('normalize · 幂等', () => {
  const samples = [
    '',
    '甲',
    '# 第一章 初入宗门\n\n他推开门。\n\n---\n\n风雪灌了进来。\n',
    '甲\n\n\n\n\n乙',
    '__粗__\n_斜_\nfile_name',
    '> 引用\n> 第二行\n\n正文',
    '甲\r\n乙\r丙',
    '\ufeff# 标题',
    '-----',
    '1. 他说\n- 他说\n| a | b |',
  ];

  it.each(samples)('normalize(normalize(x)) === normalize(x) · %j', (sample) => {
    expectIdempotent(sample);
  });
});
