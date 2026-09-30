/**
 * 起名器（docs/15 D-6）—— 纯本地、无数据文件、零 AI 外发。
 *
 * 字库硬编码：公有领域常用姓 + 名字音节。组合规则极简（姓 + 一/二字名），
 * P0 定位是"灵感抽签"而非命理工具，所以**不做**五行八字、不做性别约束、
 * 不做生僻字过滤（给几个冷门字反而是灵感）。
 *
 * 随机源用可注入的 `rng`，测试时传种子函数即可确定性复现；生产默认 `Math.random`。
 */

export interface NameCandidate {
  /** 组合出的名字（含姓）。 */
  name: string;
}

// 常见单姓（公有领域常用字，无特殊含义集合）。
const SURNAMES = [
  '沈',
  '林',
  '苏',
  '顾',
  '陆',
  '程',
  '萧',
  '谢',
  '江',
  '温',
  '许',
  '周',
  '吴',
  '郑',
  '冯',
  '陈',
  '韩',
  '杨',
  '朱',
  '秦',
  '柳',
  '裴',
  '叶',
  '季',
  '白',
  '云',
  '闻',
  '简',
  '楚',
  '晏',
] as const;

// 名字音节（可单用可组合，公领域常用、无明显褒贬）。
const GIVEN_PARTS = [
  '观',
  '澜',
  '砚',
  '知',
  '行',
  '清',
  '和',
  '若',
  '书',
  '川',
  '临',
  '照',
  '之',
  '白',
  '玄',
  '辞',
  '景',
  '明',
  '微',
  '远',
  '初',
  '恒',
  '修',
  '宁',
  '昭',
  '晏',
  '迟',
  '舟',
  '鹤',
  '霜',
] as const;

export type Rng = () => number;

const defaultRng: Rng = Math.random;

function pick<T>(arr: readonly T[], rng: Rng): T {
  return arr[Math.floor(rng() * arr.length)];
}

/**
 * 生成一个名字。单字名/双字名概率大致对半，避免"全是三个字"的呆板。
 *
 * `exclude` 是已有人物名集合（对照 codex 清单），命中就重试；重试次数有限
 * 以避免极端情况下死循环（字库组合有限时可能反复撞）。
 */
export function generateName(
  rng: Rng = defaultRng,
  exclude: ReadonlySet<string> = new Set(),
): NameCandidate {
  // 撞名重试：最多试 3 次（每次完整重抽），仍撞就原样返回，由 UI 提示"撞名了"。
  // 完整重抽而不是"只换姓"：字库组合有限时，只换姓可能反复撞同一个名字。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const name = drawName(rng);
    if (!exclude.has(name)) return { name };
  }
  return { name: drawName(rng) };
}

function drawName(rng: Rng): string {
  const surname = pick(SURNAMES, rng);
  // 约 40% 单字名，60% 双字名（含少数叠字）。
  const useDouble = rng() > 0.4;
  let given: string;
  if (!useDouble) {
    given = pick(GIVEN_PARTS, rng);
  } else {
    const first = pick(GIVEN_PARTS, rng);
    // 少量叠字（AA），大多数 AB。
    given = rng() < 0.2 ? `${first}${first}` : `${first}${pick(GIVEN_PARTS, rng)}`;
  }
  return `${surname}${given}`;
}

/** 批量生成，返回去重后的 N 个候选。 */
export function generateNames(
  count: number,
  rng: Rng = defaultRng,
  exclude: ReadonlySet<string> = new Set(),
): NameCandidate[] {
  const seen = new Set<string>();
  const out: NameCandidate[] = [];
  for (let i = 0; i < count * 3 && out.length < count; i += 1) {
    const candidate = generateName(rng, exclude);
    if (!seen.has(candidate.name)) {
      seen.add(candidate.name);
      out.push(candidate);
    }
  }
  return out;
}
