/**
 * `AdapterWarning` → 用户可读文案（纯函数，可单测）。
 *
 * 告警条的存在意义见 `03` 文档 §5.8：**绝不静默改变用户内容**。
 * 所以这里的每一条文案都要回答"我做了什么"，而不是"出了个错"。
 */

import type { AdapterWarning } from '@inkstone/md-adapter';

/** 明细里单条原文片段的最大长度（**按码点**，不是 UTF-16 码元）。 */
const EXCERPT_MAX = 80;

/** 告警的身份键：同一处问题、同样的文案 = 同一条。 */
function warningKey(warning: AdapterWarning): string {
  return `${warning.code}|${warning.from}|${warning.to}|${warning.message}`;
}

/**
 * 按 `code + 区间 + 文案` 去重。
 *
 * 载入侧（fromMd）与导出侧（toMd）的告警会并排展示，同一处问题可能两边都报一次；
 * 不去重的话用户会看到"同一个问题写了两遍"，接着就不再认真读它了。
 */
export function dedupeWarnings(warnings: readonly AdapterWarning[]): AdapterWarning[] {
  const seen = new Set<string>();
  const out: AdapterWarning[] = [];
  for (const warning of warnings) {
    const key = warningKey(warning);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(warning);
  }
  return out;
}

/**
 * 两组告警是否等价（不看顺序）。
 *
 * 用途是**省一次渲染**（`docs/13` M22）：导出侧告警每次重算都会产出一个新数组
 * （绝大多数时候是空数组），引用一变，下游的 `useMemo` 与告警条就跟着重渲染。
 * 内容没变时把旧数组原样还回去，React 的 `Object.is` 就能提前剪掉这一支。
 */
export function sameWarnings(a: readonly AdapterWarning[], b: readonly AdapterWarning[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  const keys = new Set(a.map(warningKey));
  return b.every((warning) => keys.has(warningKey(warning)));
}

/** 空数组返回**空串** —— 调用方据此决定整条横幅都不渲染（不要显示"0 处"）。 */
export function summarizeWarnings(warnings: readonly AdapterWarning[]): string {
  if (warnings.length === 0) return '';
  return `检测到 ${warnings.length} 处不支持的格式，已按纯文本保留`;
}

/**
 * 单条明细的标题与原文片段。
 *
 * `from === to` 表示"没有原文偏移"—— 导出侧（toMd）的告警就是这种，它不是
 * 从原文里找到的，而是从编辑器文档里发现的。此时不给片段，只给标题。
 */
export function describeWarning(
  warning: AdapterWarning,
  markdown: string,
): { title: string; excerpt: string } {
  return { title: warning.message, excerpt: excerptOf(warning, markdown) };
}

function excerptOf(warning: AdapterWarning, markdown: string): string {
  const from = clamp(warning.from, markdown.length);
  const to = clamp(warning.to, markdown.length);
  if (to <= from) return '';

  // 换行折成空格：明细是一行文本，原样带 `\n` 会把列表撑开。
  const raw = markdown.slice(from, to).replace(/\s+/g, ' ').trim();
  const points = Array.from(raw);
  if (points.length <= EXCERPT_MAX) return raw;
  return `${points.slice(0, EXCERPT_MAX).join('')}…`;
}

/** 偏移来自解析器，理论上就该在范围内；越界一律夹紧，绝不把 undefined 传下去。 */
function clamp(value: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.trunc(value), 0), max);
}
