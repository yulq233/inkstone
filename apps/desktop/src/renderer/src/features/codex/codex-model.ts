/**
 * 设定面板的纯逻辑（docs/15 B3）。**零 React 依赖**，vitest 直接 import。
 *
 * 把"排序 / 字段编辑行的增删 / 断链提示行 / 详情↔请求体转换"从组件里抽出来：
 * 组件只做"把状态交给这些函数、再渲染返回结果"，判定逻辑全部可穷举测试。
 */

import type {
  BrokenRelation,
  CodexEntry,
  CodexEntrySummary,
  CodexRelation,
  CodexType,
} from '@inkstone/shared';

/** 类型 → 展示名。目录名用字面量（sidecar 侧同款），这里是给人看的标签。 */
export const CODEX_TYPE_LABELS: Record<CodexType, string> = {
  character: '人物',
  location: '地点',
  faction: '势力',
  item: '物品',
  concept: '概念',
};

export const CODEX_TYPE_ORDER: CodexType[] = [
  'character',
  'location',
  'faction',
  'item',
  'concept',
];

/**
 * 清单排序：类型按固定序、同类型内按名字（中文按 locale 序，别按码点——
 * 码点序会让"沈观澜"排在"王五"前面，看着乱）。
 */
export function sortCodexList(items: CodexEntrySummary[]): CodexEntrySummary[] {
  const typeRank = new Map(CODEX_TYPE_ORDER.map((t, i) => [t, i]));
  return [...items].sort((a, b) => {
    const ra = typeRank.get(a.type) ?? 99;
    const rb = typeRank.get(b.type) ?? 99;
    if (ra !== rb) return ra - rb;
    return a.name.localeCompare(b.name, 'zh-Hans-CN');
  });
}

/** 字段编辑行：fields 是开放键值，编辑态用"一行一个 {key, value}"表示，落盘再还原成 dict。 */
export interface FieldRow {
  id: number;
  key: string;
  /** 序列化后的值（标量用字面量，列表/对象用 JSON 文本，编辑时当字符串处理）。 */
  value: string;
}

/** 把 fields dict 展开成可编辑的 FieldRow[]。 */
export function fieldsToRows(fields: Record<string, unknown>): FieldRow[] {
  return Object.entries(fields).map(([key, value], index) => ({
    id: index,
    key,
    value: scalarOrJson(value),
  }));
}

/** 把 FieldRow[] 还原成 fields dict。值为非法 JSON 或空时按"放弃该行"处理（返回 null）。 */
export function rowsToFields(rows: FieldRow[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key === '') continue;
    result[key] = parseScalarOrJson(row.value);
  }
  return result;
}

function scalarOrJson(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function parseScalarOrJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === '') return '';
  // 尝试 JSON（列表 / 对象 / 数字 / 布尔）。
  try {
    return JSON.parse(trimmed);
  } catch {
    // 不是合法 JSON → 当纯字符串（"谨慎" 这种裸词、带引号的都不该被强转）。
    return text;
  }
}

/** 断链提示：把 broken-relations 按发起条目分组，生成一句人能看懂的话。 */
export function brokenRelationText(item: BrokenRelation): string {
  return `「${item.name}」的关系指向了已不存在的「${item.to}」（${item.kind}）`;
}

/**
 * 详情 → 请求体（PUT 用）。**剥掉 slug/hash**：这俩是服务端派生字段，
 * 回灌会被 `extra="forbid"` 拦成 400（docs/15 §6.6 实测踩到）。
 */
export function entryToUpdateRequest(
  entry: CodexEntry,
  ifMatch: string,
): {
  type: CodexType;
  name: string;
  aliases: string[];
  tags: string[];
  fields: Record<string, unknown>;
  summary: string;
  relations: CodexRelation[];
  body: string;
  ifMatch: string;
} {
  return {
    type: entry.type,
    name: entry.name,
    aliases: entry.aliases,
    tags: entry.tags,
    fields: entry.fields,
    summary: entry.summary,
    relations: entry.relations,
    body: entry.body,
    ifMatch,
  };
}

/** 逗号分隔文本 → 别名数组（剥空白、丢空串）。 */
export function splitList(text: string): string[] {
  return text
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** 别名数组 → 逗号分隔文本（编辑态显示）。 */
export function joinList(items: string[]): string {
  return items.join('，');
}
