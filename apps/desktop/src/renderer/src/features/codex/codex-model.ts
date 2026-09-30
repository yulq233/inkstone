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

/** 一节清单（真机反馈：平铺一长列难找条目，按类型分节展示）。 */
export interface CodexTypeGroup {
  type: CodexType;
  label: string;
  entries: CodexEntrySummary[];
}

/**
 * 清单按类型分节。按 `CODEX_TYPE_ORDER` 固定序；**空节不返回**（还没有地点时
 * 不显示"地点 0"）。组内顺序 = 入参顺序，所以先 `sortCodexList` 再分组，
 * 组内自动是名字 locale 序。
 */
export function groupByType(items: CodexEntrySummary[]): CodexTypeGroup[] {
  return CODEX_TYPE_ORDER.map((type) => ({
    type,
    label: CODEX_TYPE_LABELS[type],
    entries: items.filter((item) => item.type === type),
  })).filter((group) => group.entries.length > 0);
}

/**
 * 新建表单的示例文案，按类型一套（真机反馈：点「+地点」不该看到人物的
 * 「沈观澜」）。示例统一走「云京」化名体系（写作约定）。
 */
export const CODEX_TYPE_PLACEHOLDERS: Record<
  CodexType,
  { name: string; aliases: string; tags: string }
> = {
  character: { name: '例如：沈观澜', aliases: '例如：观澜，沈先生', tags: '例如：主角，云京司' },
  location: { name: '例如：云京', aliases: '例如：京师，云京道', tags: '例如：主城，东域' },
  faction: { name: '例如：云京司', aliases: '例如：云司，巡按院', tags: '例如：官方，江湖' },
  item: { name: '例如：青霜剑', aliases: '例如：霜刃', tags: '例如：兵器，传承' },
  concept: { name: '例如：淬体诀', aliases: '例如：淬体功法', tags: '例如：功法，体系' },
};

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

/** 编辑表单的值（`isEntryDirty` 的入参；字段与 `entryToUpdateRequest` 的口径一致）。 */
export interface EntryFormValues {
  name: string;
  aliases: string[];
  tags: string[];
  summary: string;
  body: string;
  fields: Record<string, unknown>;
}

/**
 * 表单值是否与**磁盘上**的条目不同。
 *
 * ## 为什么需要它（真机踩出来的，`docs/16` §9）
 *
 * AI 装配的唯一真源是磁盘：sidecar 读 `codex/<type>/<slug>.md` 来拼 prompt。而编辑页
 * 是本地 state、点了「保存」才 PUT。于是"改了名字没保存就点生成"会得到一个用**旧值**
 * 写出来的候选 —— 真机表现为输入框写着「沈念」、候选里却是另一个名字，而界面上
 * 没有任何线索能让人联想到"我忘了保存"。
 *
 * 界面必须自己发现这件事（才能在生成前先落盘），所以判定要抽成纯函数、单独可测。
 *
 * ## `fields` 必须按**键序无关**的方式比
 *
 * `rowsToFields` 出来的对象键序跟用户编辑顺序一致，而磁盘那份是 YAML 解析出来的、
 * 键序可能不同。直接 `JSON.stringify` 比会把"什么都没改"判成 dirty —— 然后按钮一直
 * 拦着不让生成，比不拦更糟。所以走 {@link stableJson}。
 *
 * 入参的 `form` 必须是**已归一化**的值（`name` 已 trim、`aliases`/`tags` 已 `splitList`），
 * 否则"敲了个尾随空格"也会被判成改动。
 */
export function isEntryDirty(
  form: EntryFormValues,
  saved: Pick<CodexEntry, 'name' | 'aliases' | 'tags' | 'summary' | 'body' | 'fields'>,
): boolean {
  if (form.name !== saved.name) return true;
  if (!sameStringList(form.aliases, saved.aliases)) return true;
  if (!sameStringList(form.tags, saved.tags)) return true;
  if (form.summary !== saved.summary) return true;
  if (form.body !== saved.body) return true;
  return stableJson(form.fields) !== stableJson(saved.fields);
}

/** 顺序敏感的列表比较（别名的顺序在编辑器里是有意义的，不排序）。 */
function sameStringList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/** 键序无关的序列化，**只用于比较**（不用于落盘）。 */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const body = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',');
    return `{${body}}`;
  }
  // `String()` 兜住 `JSON.stringify(undefined)` 返回 undefined 的情况（保持确定性）
  return String(JSON.stringify(value));
}
