import { describe, expect, it } from 'vitest';

import {
  ALLOWED_BLOCK_NODES,
  ALLOWED_MARK_NAMES,
  BLOCKQUOTE_PREFIX,
  BOLD_DELIMITER,
  DEGRADABLE_SYNTAX,
  HEADING_LEVELS,
  INKSTONE_ALLOWED_NAMES,
  ITALIC_DELIMITER,
  THEMATIC_BREAK,
} from '../src/md-schema';

/**
 * 白名单是三方共享的唯一真源（编辑器扩展集、`packages/md-adapter`、这份常量）。
 * 这里只钉住"自洽性"——扩展集与适配层的对齐在 `apps/desktop` 的测试里做。
 */
describe('md-schema 白名单自洽性', () => {
  it('块级与行内白名单合起来就是 INKSTONE_ALLOWED_NAMES，没有遗漏也没有重复', () => {
    expect(INKSTONE_ALLOWED_NAMES).toEqual([...ALLOWED_BLOCK_NODES, ...ALLOWED_MARK_NAMES]);
    expect(new Set(INKSTONE_ALLOWED_NAMES).size).toBe(INKSTONE_ALLOWED_NAMES.length);
  });

  it('标题层级只有 1~3 级', () => {
    expect([...HEADING_LEVELS]).toEqual([1, 2, 3]);
  });

  it('斜体只用 *，不用 _（否则 file_name 会被吃掉）', () => {
    expect(ITALIC_DELIMITER).toBe('*');
    expect(BOLD_DELIMITER).toBe('**');
  });

  it('分隔线规范写法是独占一行的 ---', () => {
    expect(THEMATIC_BREAK).toBe('---');
  });

  it('引用前缀没有多余空白（多一个空格就会让往返不稳定）', () => {
    expect(BLOCKQUOTE_PREFIX).toBe('>');
  });

  it('明确不支持的语法里不含任何白名单内的东西', () => {
    // 这是个"防手滑"断言：往 DEGRADABLE_SYNTAX 里加东西时，
    // 不该把段落 / 标题 / 引用 / 分隔线混进去。
    const allowedWords = ['段落', 'ATX 标题', '引用', '分隔线'];
    for (const item of DEGRADABLE_SYNTAX) {
      for (const word of allowedWords) {
        expect(item.includes(word), `「${item}」不该出现在不支持清单里`).toBe(false);
      }
    }
  });

  it('列表与代码块必须在不支持清单里（这是三个中文坑的根源）', () => {
    const joined = DEGRADABLE_SYNTAX.join('、');
    expect(joined).toContain('有序列表');
    expect(joined).toContain('无序列表');
    expect(joined).toContain('代码块');
    expect(joined).toContain('setext');
  });
});
