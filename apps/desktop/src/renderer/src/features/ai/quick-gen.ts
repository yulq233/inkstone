/**
 * 快捷生成的候选解析（`docs/11` §6.3 的「快捷生成」）。
 *
 * ## 与续写的一个根本区别：输出**不进幽灵文本**
 *
 * 续写是"接着写正文"，输出接在光标处、流式可见、接受即落笔 —— 幽灵文本装饰正合适。
 * 快捷生成是"要一份可选清单"（起 10 个名字、给 3 个钩子），用户要的是**挑一个**，
 * 不是"全部接上"。所以输出攒起来、按行拆成候选、在面板上逐个显示，点选才插入。
 * 这两者的区别不是"换个样式"，是产品形态不同（§6.3 把它列成与续写并列的入口）。
 *
 * ## 逐行型 vs 段落型
 *
 * `quick.toml` 的 `[kinds]` 里，有的指令要求"每行一个"，有的要求"写一段"。
 * 拆法必须跟着指令走：把 `synopsis`（一段 150 字简介）按行拆，会拆成一句一句的残片。
 *
 * | kind | 形态 | 拆法 |
 * |---|---|---|
 * | naming / dialogue / hook / direction / title | 每行一个 | 按行拆、去编号前缀 |
 * | scene / synopsis | 一段 | 整段作为一个候选 |
 *
 * 这个映射**必须与 `quick.toml` 的 `[kinds]` 指令逐字一致**（`ai-types.ts` 的
 * `AI_QUICK_KINDS` 也有同一条警告）—— 那边改了"每行一个"，这里不改，用户拿到的
 * 就是一堆挤在一起的候选。
 */

import type { AiQuickKind } from '@inkstone/shared';

/**
 * 逐行型的 kind。改这里要先看 `quick.toml` 里那条 kind 的指令是不是"每行一个"。
 */
const LINE_KINDS: readonly AiQuickKind[] = ['naming', 'dialogue', 'hook', 'direction', 'title'];

/** 行首的编号前缀：`1.` `1)` `1、` `1．` `1：` 以及全角数字、纯数字 + 空格。 */
const NUMBER_PREFIX = /^\s*(?:[0-9０-９]+[.)、．:：]\s*|[0-9０-９]+\s+)/;

export interface QuickCandidates {
  /** 候选项。**可能是空数组**（模型返回空，或整段都被过滤掉了）。 */
  items: string[];
  /** 逐行型（`line`）还是段落型（`block`）。面板据此决定"点选插入"还是"整段复制"。 */
  shape: 'line' | 'block';
}

/**
 * 把模型返回的原始文本拆成候选。
 *
 * 纯函数：这里只做字符串处理，不碰网络、不碰编辑器。逐行拆 + 去编号 + 去空行
 * 是几件"看着简单、手写必错"的事（全角数字、`1）` 与 `1、`、行首空格……），
 * 值得单独一个可测的单元。
 */
export function parseQuickCandidates(kind: AiQuickKind, text: string): QuickCandidates {
  const trimmed = text.trim();
  if (trimmed === '') return { items: [], shape: LINE_KINDS.includes(kind) ? 'line' : 'block' };

  if (!LINE_KINDS.includes(kind)) {
    return { items: [trimmed], shape: 'block' };
  }

  const items: string[] = [];
  for (const raw of trimmed.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    // 去编号前缀。模型偶尔会把"不要编号"的指令也输出成带编号的 ——
    // 与其让它脏着显示，不如在这里剥掉（编号信息列表自带的索引就有）。
    items.push(line.replace(NUMBER_PREFIX, ''));
  }
  return { items, shape: 'line' };
}
