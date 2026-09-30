/**
 * 「将发送什么」的**纯逻辑**（`docs/11` §6.4 / §6.7）。
 *
 * ## 为什么抽出来
 *
 * 这个模块被两处复用 —— 工作台里的常驻预览入口（`PreviewPanel`）与首次云端确认卡
 * （`EgressConfirmDialog`），而**确认卡上写的那句话是有分量**的：
 * "这次会把 4820 个字符发给 DeepSeek（api.deepseek.com）"。它错了，用户就是在
 * 一次错误的认知上按了「继续」。而这句话的组成（字符数、去哪家、打哪个地址、用哪个模型）
 * 全是纯计算，正好可以穷举测试 —— 放在组件里就只能靠肉眼。
 *
 * ## 分块顺序为什么由这里定，而不是直接用服务端给的顺序
 *
 * 服务端返回的顺序是**丢块优先级**（先丢相邻章、最后动前文，`context.py` 的 `_collect`
 * 有说明），而界面要的是**阅读顺序**。两者刻意不同，直接照搬会让预览里的分组
 * 与下面那段 `user` 原文的顺序对不上 —— 而"我看到的和它要发的是同一份吗"
 * 正是这张卡唯一要回答的问题。
 */

import type { AiPreviewBlock, AiPreviewResponse } from '@inkstone/shared';

/**
 * 分块的阅读顺序 —— **必须与提示模板里 `{}` 出现的顺序一致**
 * （见 `ai/prompts/continue.toml` 的 `user`：设定 → 前文 → 光标之后 → 相邻章节）。
 *
 * 改模板里的顺序就要改这里；不一致的症状是"预览里的分组顺序与它给用户看的原文顺序不同"，
 * 用户会以为预览拼错了。
 */
const SLOT_ORDER: readonly string[] = ['settings', 'prefix', 'suffix', 'adjacent'];

/** 槽位 → 界面上的名字。服务端给的是 `prefix` 这种机器名，不该直接显示给用户。 */
const SLOT_LABEL: Record<string, string> = {
  settings: '作品设定',
  prefix: '本章前文',
  suffix: '光标之后的已有内容',
  adjacent: '相邻章节片段',
};

/** 认不出的槽位**不隐藏**：将来装配器加了新来源，界面上要看得见它，而不是悄悄少一行。 */
export function slotLabel(slot: string, fallbackTitle: string): string {
  return SLOT_LABEL[slot] ?? fallbackTitle;
}

/**
 * 按阅读顺序重排分块。认不出的槽位排在**末尾**，且保持服务端给的相对顺序。
 *
 * ## 为什么不写 `blocks.sort(cmp)`
 *
 * 那会**就地**改掉调用方传进来的数组。这个模块被 `ContextPreview` 与
 * `EgressConfirmDialog` 两处共用，"重排"是个只读动作 —— 一个看起来很纯的函数
 * 顺手改掉入参，是那种当场看不出来、以后某处"顺序莫名其妙变了"的 bug。
 * 先 `map` 出带下标的副本，从结构上杜绝（顺带让"未知槽位按原顺序排末尾"
 * 这件事由下标比较显式表达，不依赖读代码的人知道引擎的排序稳定性保证）。
 *
 * ## 变异验证的结论（别把它当测试缺口）
 *
 * 把这段换成 `[...blocks].sort(cmp)`，`context-preview.test.ts` **不会变红** ——
 * 因为 ES2019 起 `Array.prototype.sort` **保证稳定**，两者在"未知槽位保持
 * 相对顺序"上行为相同，那是一次**等价变异**。用例真正护住的是**就地改入参**
 * 那一版（把副本去掉就立刻红）。
 */
export function orderPreviewBlocks(blocks: readonly AiPreviewBlock[]): AiPreviewBlock[] {
  const known = new Map<string, number>(SLOT_ORDER.map((slot, index) => [slot, index]));
  return blocks
    .map((block, index) => ({ block, index }))
    .sort((a, b) => {
      const ai = known.get(a.block.slot) ?? SLOT_ORDER.length;
      const bi = known.get(b.block.slot) ?? SLOT_ORDER.length;
      return ai === bi ? a.index - b.index : ai - bi;
    })
    .map((entry) => entry.block);
}

/**
 * 从 `baseUrl` 里取出主机（带端口），用于回答"内容到底去了哪里"。
 *
 * 用正则而不是 `new URL()`：这个模块被纯 node 的测试直接 import，
 * 而 `URL` 在解析异常输入时的行为（抛不抛、抛什么）会随实现变化 ——
 * 这里要的只是"把协议与路径切掉"，不需要一个完整解析器。
 * 认不出协议时**原样返回**：宁可在界面上显示一个用户自己填过的怪字符串，
 * 也不要显示一个"我猜的"主机名。
 */
export function hostOf(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  const matched = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(trimmed);
  return matched?.[1] ?? trimmed;
}

export interface PreviewStats {
  /** 外发字符量（与 `AiRun.egressChars` 同口径）。 */
  egressChars: number;
  /** 本次上下文占用的 token（装配口径）。 */
  usedTokens: number;
  budgetTokens: number;
  /** 被预算截断过的块数。 */
  truncatedBlocks: number;
  /** 整块被丢掉、**不会发出去**的块数。 */
  droppedBlocks: number;
}

export function previewStats(preview: AiPreviewResponse): PreviewStats {
  return {
    egressChars: preview.egressChars,
    usedTokens: preview.budget.used,
    budgetTokens: preview.budget.budget,
    truncatedBlocks: preview.blocks.filter((block) => block.truncated).length,
    droppedBlocks: preview.dropped.length,
  };
}

/**
 * 一句话说清"这一次会发生什么"。**确认卡与预览面板共用这一句**。
 *
 * 三种说法对应三种处置，不能合并成一句"将发送 X 字"：
 * - 本机模型：要说清**不会离开这台机器**，这是它与其他项唯一有意义的区别；
 * - 云端：要说清**去哪家、打哪个地址、用哪个模型** —— 地址是用户可改的，
 *   而两家 label 相同、地址不同的配置是可能的，只报 label 答不了"去了哪里"；
 * - 被纯本地模式拦下：要说的是"发不出去"，而不是"将发送"。
 */
export function previewSummary(preview: AiPreviewResponse): string {
  const host = hostOf(preview.providerBaseUrl);
  if (preview.local) {
    return `本机模型 · 不外传：内容只会发给本机的 ${preview.providerLabel}（${host}）。`;
  }
  if (preview.offlineBlocked) {
    return `已开启纯本地模式，这次不会真的发送（目标 ${preview.providerLabel} 会被拦下）。`;
  }
  return (
    `这次会把 ${preview.egressChars} 个字符发给 ${preview.providerLabel}` +
    `（${host}），模型 ${preview.model}。`
  );
}

/** 被丢掉的原因。`docs/11` §3.5 要求"必须回报"，所以两种都要有说法。 */
export function dropReasonText(reason: string): string {
  if (reason === 'budget') return '超出上下文预算';
  if (reason === 'offline') return '纯本地模式';
  // 认不出就照原样显示：藏着它会让"装配器多了一种丢块原因"这件事没人发现
  return reason;
}
