/**
 * 告警文案的单测（`05` §9）。
 *
 * 告警条本身是 UI，但"它说什么"是纯逻辑 —— 而这几句文案恰恰是
 * "绝不静默改变用户内容"这条底线的可见部分。文案错了，用户就不知道该不该信我们。
 */

import { describe, expect, it } from 'vitest';
import type { AdapterWarning } from '@inkstone/md-adapter';

import {
  dedupeWarnings,
  describeWarning,
  sameWarnings,
  summarizeWarnings,
} from '../src/renderer/src/features/editor/warning-text';

const degraded = (
  from: number,
  to: number,
  message = '无序列表标记已按纯文本保留',
): AdapterWarning => ({
  code: 'DEGRADED_BLOCK',
  message,
  from,
  to,
});

describe('summarizeWarnings', () => {
  it('没有告警时返回空串（调用方据此整条横幅都不渲染）', () => {
    expect(summarizeWarnings([])).toBe('');
  });

  it('一条也说"1 处"，不做单复数特殊处理', () => {
    expect(summarizeWarnings([degraded(0, 5)])).toBe('检测到 1 处不支持的格式，已按纯文本保留');
  });

  it('多条报准确的条数', () => {
    expect(summarizeWarnings([degraded(0, 5), degraded(6, 9), degraded(10, 12)])).toContain('3 处');
  });
});

describe('dedupeWarnings', () => {
  it('完全相同的告警（载入侧与导出侧都报同一条）只留一份', () => {
    const one = degraded(0, 5);
    expect(dedupeWarnings([one, { ...one }])).toHaveLength(1);
  });

  it('区间不同就认为是不同问题', () => {
    expect(dedupeWarnings([degraded(0, 5), degraded(6, 9)])).toHaveLength(2);
  });

  it('保持原有顺序（条目顺序就是阅读顺序）', () => {
    const result = dedupeWarnings([degraded(10, 12, '乙'), degraded(0, 5, '甲')]);
    expect(result.map((w) => w.message)).toEqual(['乙', '甲']);
  });
});

describe('describeWarning', () => {
  const markdown = '第一行\n第二行是不同的内容\n- 列表项\n结尾';

  it('区间落在文本两端时切片正确', () => {
    expect(describeWarning(degraded(0, 3), markdown).excerpt).toBe('第一行');
    const tail = describeWarning(degraded(19, 22), markdown);
    expect(tail.excerpt).toBe('结尾');
  });

  it('跨行的片段把换行折成空格', () => {
    expect(describeWarning(degraded(4, 13), markdown).excerpt).toBe('第二行是不同的内容');
  });

  it('标题是原始 message，不改写', () => {
    expect(describeWarning(degraded(0, 3, '表格行已按纯文本保留'), markdown).title).toBe(
      '表格行已按纯文本保留',
    );
  });

  it('from === to 表示"没有原文偏移"（导出侧告警），不给片段', () => {
    expect(describeWarning(degraded(0, 0), markdown).excerpt).toBe('');
  });

  it('偏移越界一律夹紧，不返回 undefined', () => {
    const beyond = describeWarning(degraded(999, 1000), markdown);
    expect(beyond.excerpt).toBe('');
    const negative = describeWarning(degraded(-5, 3), markdown);
    expect(negative.excerpt).toBe('第一行'.slice(0, 3));
  });

  it('超长片段按**码点**截断，不切坏代理对', () => {
    const long = '𠮷'.repeat(100) + '尾巴';
    const warning: AdapterWarning = {
      code: 'DEGRADED_BLOCK',
      message: '长行',
      from: 0,
      to: long.length,
    };
    const excerpt = describeWarning(warning, long).excerpt;

    expect(excerpt.endsWith('…')).toBe(true);
    expect(Array.from(excerpt).length).toBe(81); // 80 个码点 + 省略号
    // 截断后不应残留孤立代理项
    expect(excerpt).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(excerpt).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it('刚好等于上限时不加省略号', () => {
    const exact = '甲'.repeat(80);
    const warning: AdapterWarning = { code: 'DEGRADED_BLOCK', message: '80 字', from: 0, to: 80 };
    expect(describeWarning(warning, exact).excerpt).toBe(exact);
  });
});

describe('sameWarnings', () => {
  // 用途是省一次渲染（`docs/13` M22）：导出侧告警每次重算都产出新数组，
  // 内容没变时把旧引用还回去，下游的 useMemo 和告警条就不会白重渲染。

  it('同一个引用直接判等', () => {
    const list = [degraded(0, 5)];
    expect(sameWarnings(list, list)).toBe(true);
  });

  it('内容一样但引用不同 → 等价（这正是要拦下的那种"白渲染"）', () => {
    expect(sameWarnings([degraded(0, 5)], [degraded(0, 5)])).toBe(true);
  });

  it('空数组等价于另一个空数组（导出侧绝大多数时候就是这种）', () => {
    expect(sameWarnings([], [])).toBe(true);
  });

  it('条数不同 → 不等价', () => {
    expect(sameWarnings([degraded(0, 5)], [])).toBe(false);
    expect(sameWarnings([], [degraded(0, 5)])).toBe(false);
  });

  it('区间不同 → 不等价', () => {
    expect(sameWarnings([degraded(0, 5)], [degraded(0, 6)])).toBe(false);
  });

  it('文案不同 → 不等价', () => {
    expect(sameWarnings([degraded(0, 5, '甲')], [degraded(0, 5, '乙')])).toBe(false);
  });

  it('顺序不影响等价性（去重后本来就不保证同序）', () => {
    expect(
      sameWarnings(
        [degraded(0, 5, '甲'), degraded(6, 9, '乙')],
        [degraded(6, 9, '乙'), degraded(0, 5, '甲')],
      ),
    ).toBe(true);
  });
});
