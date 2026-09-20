import { describe, expect, it } from 'vitest';

import { extractTitle, fromMd, inkstoneSchema, toMd } from '../src/index';

const render = (md: string): string => toMd(fromMd(md).doc).markdown;

const doc = (...children: ReturnType<typeof inkstoneSchema.node>[]) =>
  inkstoneSchema.node('doc', null, children);

const p = (text: string) =>
  text === ''
    ? inkstoneSchema.node('paragraph')
    : inkstoneSchema.node('paragraph', null, [inkstoneSchema.text(text)]);

describe('序列化 · 块级', () => {
  it('标题按级别输出，前后留空行', () => {
    expect(render('# 一级\n\n## 二级\n\n### 三级')).toBe('# 一级\n\n## 二级\n\n### 三级\n');
  });

  it('分隔线前后留空行', () => {
    expect(render('甲\n\n---\n\n乙')).toBe('甲\n\n---\n\n乙\n');
  });

  it('引用每行都带 > 前缀', () => {
    expect(render('> 甲\n> 乙')).toBe('> 甲\n> 乙\n');
  });

  it('引用里的空行写成裸 >', () => {
    const quote = inkstoneSchema.node('blockquote', null, [p('甲'), p(''), p('乙')]);
    // 空段落被丢弃，因此只留下两段；
    // 关键点是引用块整体不能塌掉。
    expect(toMd(doc(quote)).markdown).toBe('> 甲\n> 乙\n');
  });
});

describe('序列化 · 空块的处理', () => {
  it('空段落被丢弃（本方言里空行是分隔符，无法表示空段落）', () => {
    expect(toMd(doc(p('甲'), p(''), p('乙'))).markdown).toBe('甲\n乙\n');
  });

  it('整篇都是空段落时输出空字符串', () => {
    expect(toMd(doc(p(''))).markdown).toBe('');
  });

  it('空标题被丢弃', () => {
    const emptyHeading = inkstoneSchema.node('heading', { level: 1 });
    expect(toMd(doc(emptyHeading, p('正文'))).markdown).toBe('正文\n');
  });

  it('丢弃空段落之后仍然是往返不动点', () => {
    const once = toMd(doc(p('甲'), p(''), p('乙'))).markdown;
    expect(render(once)).toBe(once);
  });
});

describe('序列化 · 行首消歧', () => {
  it('正文里独占一行的 --- 会被转义，避免被当成分隔线吃掉', () => {
    const markdown = toMd(doc(p('---'))).markdown;
    expect(markdown).toBe('\\---\n');
    // 再解析回去必须是同一个段落，且文字还是 ---
    const reparsed = fromMd(markdown);
    expect(reparsed.doc.firstChild?.type.name).toBe('paragraph');
    expect(reparsed.doc.textContent).toBe('---');
  });

  it('正文以 # 空格开头时会被转义，避免被当成标题', () => {
    const markdown = toMd(doc(p('# 不是标题'))).markdown;
    expect(markdown).toBe('\\# 不是标题\n');
    const reparsed = fromMd(markdown);
    expect(reparsed.doc.firstChild?.type.name).toBe('paragraph');
    expect(reparsed.doc.textContent).toBe('# 不是标题');
  });

  it('正文以 > 开头时会被转义，避免被当成引用', () => {
    const markdown = toMd(doc(p('> 不是引用'))).markdown;
    expect(markdown).toBe('\\> 不是引用\n');
    const reparsed = fromMd(markdown);
    expect(reparsed.doc.firstChild?.type.name).toBe('paragraph');
    expect(reparsed.doc.textContent).toBe('> 不是引用');
  });

  it('行首的反斜杠不需要额外处理（行内转义本身就能还原）', () => {
    const markdown = toMd(doc(p('\\甲'))).markdown;
    expect(markdown).toBe('\\\\甲\n');
    expect(fromMd(markdown).doc.textContent).toBe('\\甲');
  });

  it('正文里的星号被转义，避免无意形成强调', () => {
    const markdown = toMd(doc(p('3*4'))).markdown;
    expect(markdown).toBe('3\\*4\n');
    expect(fromMd(markdown).doc.textContent).toBe('3*4');
  });

  it('正文中间的行首敏感字符不受影响', () => {
    expect(toMd(doc(p('他说 --- 然后走了'))).markdown).toBe('他说 --- 然后走了\n');
  });
});

describe('序列化 · 行内标记开合', () => {
  const t = (text: string, marks: string[] = []) =>
    inkstoneSchema.text(text, marks.map((name) => inkstoneSchema.marks[name].create()));

  it('相邻同标记合并输出', () => {
    expect(toMd(doc(inkstoneSchema.node('paragraph', null, [t('粗'), t('体', ['bold'])]))).markdown).toBe(
      '粗**体**\n',
    );
  });

  it('加粗内嵌斜体按嵌套输出', () => {
    const paragraph = inkstoneSchema.node('paragraph', null, [
      t('前 ', ['bold']),
      t('中', ['bold', 'italic']),
      t(' 后', ['bold']),
    ]);
    expect(toMd(doc(paragraph)).markdown).toBe('**前 *中* 后**\n');
    // 再解析回来结构必须一致
    expect(render('**前 *中* 后**')).toBe('**前 *中* 后**\n');
  });

  it('加粗与斜体相邻时正确收合', () => {
    const paragraph = inkstoneSchema.node('paragraph', null, [t('粗', ['bold']), t('斜', ['italic'])]);
    // 两个分隔符会拼成 `***`，解析端必须能把它拆回「加粗收尾 + 斜体开头」。
    expect(toMd(doc(paragraph)).markdown).toBe('**粗***斜*\n');
    expect(render('**粗***斜*')).toBe('**粗***斜*\n');
    // 结构确实拆对了，不是被当成纯文本
    const reparsed = fromMd('**粗***斜*').doc;
    expect(reparsed.childCount).toBe(1);
    expect(reparsed.firstChild?.childCount).toBe(2);
  });
});

describe('extractTitle', () => {
  it('取首个 H1', () => {
    expect(extractTitle('# 第一章 初入宗门\n\n正文')).toBe('第一章 初入宗门');
  });

  it('跳过前导的空行与 H2', () => {
    expect(extractTitle('\n\n## 二级\n\n# 一级')).toBe('一级');
  });

  it('没有 H1 时返回 null', () => {
    expect(extractTitle('正文\n\n## 只有二级')).toBeNull();
    expect(extractTitle('')).toBeNull();
  });

  it('空的 H1 返回 null', () => {
    expect(extractTitle('#   \n正文')).toBeNull();
  });
});
