/**
 * 一次生成的界面状态（纯函数，`docs/11` §6.4 / §6.5）。
 *
 * ## 为什么候选**全文**不进 `GenSnapshot`
 *
 * 流式生成每秒能来几十个 `delta`。如果每个都进 React state，整个工作台
 * （侧栏、状态条、字数条……）就跟着重渲染几十次 —— §9 的风险表把这条列成
 * "边写边生成的卡顿：编辑器掉帧"。
 *
 * 所以全文只走一条路：**直接写进编辑器的幽灵文本装饰**（它不需要 React 参与）。
 * React 拿到的 `GenSnapshot` 只含这类低频信息：模型名、token、成本、首字延迟。
 * 每次生成它最多变四次（meta / usage / done / error）。
 *
 * ## 为什么"用户停止"不是错误
 *
 * §6.5：「用户停止 | 不算错误：已生成部分转为候选」。所以 `finishReason === 'aborted'`
 * 且有内容时落到 `ready`（可接受）；一个字都没有时干脆落回 `idle` ——
 * 弹一条"生成失败"去责怪用户自己按的按钮，是最没用的提示。
 */

import type { AiBudgetReport, AiDropInfo, AiFinishReason, AiStreamEvent } from '@inkstone/shared';

export type GenPhase = 'idle' | 'running' | 'ready' | 'error';

export interface GenFailure {
  code: string;
  message: string;
}

/**
 * 客户端侧的伪错误码：上游正常返回了，但内容是空的。
 *
 * 与 `NETWORK` / `STREAM_PROTOCOL` 同一族 —— 不出现在 HTTP 信封里，所以不进
 * `errors.ts` 的错误码全集（那张表是**跨进程**的 wire 契约，塞客户端判断进去会让
 * "两边必须一一对应"这条变成假命题）。
 */
export const EMPTY_OUTPUT_CODE = 'EMPTY_OUTPUT';

export interface GenState {
  phase: GenPhase;
  /** 单调时钟起点，只用来算延迟。用 `performance.now()` 而不是 `Date.now()`：后者会被系统时间调整影响 */
  startedAt: number;
  runId: string;
  providerId: string;
  model: string;
  templateId: string;
  /** 候选全文。**只在 reducer 里流转，不进 React state** */
  text: string;
  dropped: AiDropInfo[];
  budget: AiBudgetReport | null;
  egressChars: number;
  promptTokens: number | null;
  completionTokens: number | null;
  costCny: number | null;
  /** 首字延迟。§6.4 要求显示 —— 它比总耗时更能说明"模型是不是卡着不动" */
  firstTokenMs: number | null;
  totalMs: number | null;
  finishReason: AiFinishReason | null;
  failure: GenFailure | null;
}

export const IDLE_GEN_STATE: GenState = {
  phase: 'idle',
  startedAt: 0,
  runId: '',
  providerId: '',
  model: '',
  templateId: '',
  text: '',
  dropped: [],
  budget: null,
  egressChars: 0,
  promptTokens: null,
  completionTokens: null,
  costCny: null,
  firstTokenMs: null,
  totalMs: null,
  finishReason: null,
  failure: null,
};

export function beginGen(now: number): GenState {
  return { ...IDLE_GEN_STATE, phase: 'running', startedAt: now };
}

export function absorbGenEvent(state: GenState, event: AiStreamEvent, now: number): GenState {
  switch (event.type) {
    case 'meta':
      return {
        ...state,
        runId: event.runId,
        providerId: event.providerId,
        model: event.model,
        templateId: event.templateId,
        dropped: event.dropped,
        budget: event.budget,
        egressChars: event.egressChars,
      };
    case 'delta':
      return {
        ...state,
        text: state.text + event.text,
        firstTokenMs: state.firstTokenMs ?? Math.max(0, Math.round(now - state.startedAt)),
      };
    case 'usage':
      return {
        ...state,
        promptTokens: event.promptTokens,
        completionTokens: event.completionTokens,
        costCny: event.costCny,
      };
    case 'done':
      return settleGen(state, event.finishReason, now);
    case 'error':
      return failGen(state, { code: event.code, message: event.message }, now);
  }
}

export function failGen(state: GenState, failure: GenFailure, now: number): GenState {
  return { ...state, phase: 'error', failure, totalMs: Math.round(now - state.startedAt) };
}

/**
 * 收尾。**必须导出**：用户按停止时**不会有 `done` 事件**（流是被我们自己掐断的），
 * 所以调用方要自己用它收尾 —— 两条路（服务端报 aborted / 客户端掐断）走同一个函数，
 * 否则"按了停止之后界面停在生成中"这种状态就只会出现在其中一条路上。
 */
export function settleGen(state: GenState, finishReason: AiFinishReason, now: number): GenState {
  const done = { ...state, finishReason, totalMs: Math.round(now - state.startedAt) };
  if (finishReason === 'aborted') {
    // 用户按的停止。有内容就留成候选（§6.5），一个字都没有就静静回到初始态。
    return state.text === '' ? { ...IDLE_GEN_STATE } : { ...done, phase: 'ready' };
  }
  if (state.text.trim() === '') {
    return {
      ...done,
      phase: 'error',
      failure: {
        code: EMPTY_OUTPUT_CODE,
        message: '模型这次没有返回任何内容。可以调高输出长度上限，或换一个模型再试。',
      },
    };
  }
  return { ...done, phase: 'ready' };
}

// ---------------------------------------------------------------------------
// 给面板看的快照
// ---------------------------------------------------------------------------

/**
 * 面板要显示的东西。**刻意不含 `text`** —— 理由见文件头。
 *
 * `chars` 只用来显示"已生成 N 字"，它在 `delta` 时不更新（那样就是每个 delta 一次渲染）。
 * 真正逐字变化的东西在编辑器里（幽灵文本），那才是用户看的进度。
 */
export interface GenSnapshot {
  phase: GenPhase;
  running: boolean;
  providerId: string;
  model: string;
  chars: number;
  /** 有没有东西可以接受 */
  acceptable: boolean;
  promptTokens: number | null;
  completionTokens: number | null;
  costCny: number | null;
  firstTokenMs: number | null;
  totalMs: number | null;
  finishReason: GenState['finishReason'];
  egressChars: number;
  dropsText: string | null;
  budget: AiBudgetReport | null;
  failure: GenFailure | null;
}

export function genSnapshot(state: GenState): GenSnapshot {
  return {
    phase: state.phase,
    running: state.phase === 'running',
    providerId: state.providerId,
    model: state.model,
    chars: state.text.length,
    acceptable: state.phase === 'ready' && state.text.trim() !== '',
    promptTokens: state.promptTokens,
    completionTokens: state.completionTokens,
    costCny: state.costCny,
    firstTokenMs: state.firstTokenMs,
    totalMs: state.totalMs,
    finishReason: state.finishReason,
    egressChars: state.egressChars,
    dropsText: dropsText(state.dropped),
    budget: state.budget,
    failure: state.failure,
  };
}

/**
 * 上下文因预算被省略的部分。**必须说出来**（§3.5）：用户以为模型看过《设定.md》，
 * 而它其实没看到 —— 那种"它为什么不知道这件事"的困惑，只有这条提示能解释。
 */
export function dropsText(dropped: readonly AiDropInfo[]): string | null {
  if (dropped.length === 0) return null;
  const tokens = dropped.reduce((sum, item) => sum + item.tokens, 0);
  const budget = dropped.filter((item) => item.reason === 'budget').length;
  const offline = dropped.length - budget;
  const head = `已省略 ${dropped.length} 块上下文（约 ${tokens} token）`;
  if (offline === 0) return head;
  if (budget === 0) return `${head}：其中 ${offline} 块因「纯本地模式」未发送`;
  return `${head}：${budget} 块超出预算，${offline} 块因「纯本地模式」未发送`;
}

/** 候选卡底部那一行（§6.4：模型名、耗时、token、成本、首字延迟）。 */
export function candidateMetaLine(snapshot: GenSnapshot): string {
  const parts: string[] = [snapshot.model === '' ? '未知模型' : snapshot.model];
  if (snapshot.firstTokenMs !== null) parts.push(`首字 ${durationText(snapshot.firstTokenMs)}`);
  if (snapshot.totalMs !== null) parts.push(`共 ${durationText(snapshot.totalMs)}`);
  if (snapshot.completionTokens !== null) parts.push(`输出 ${snapshot.completionTokens} token`);
  if (snapshot.promptTokens !== null) parts.push(`上下文 ${snapshot.promptTokens} token`);
  parts.push(costText(snapshot.costCny));
  return parts.join(' · ');
}

export function costText(costCny: number | null): string {
  // `null` = 认不出模型，**不编一个数**（`ai/pricing.py` 的口径）。编 0 会让用户
  // 以为这次不要钱，而这正是"预算还早着呢"那种错觉的来源。
  if (costCny === null) return '成本未知';
  if (costCny === 0) return '¥0';
  // 单次生成的成本常在千分位以下，两位小数会全部显示成 ¥0.00
  return costCny >= 0.01 ? `¥${costCny.toFixed(2)}` : `¥${costCny.toFixed(4)}`;
}

export function durationText(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** 达到输出长度上限时的提示。不说的话，用户看到的是"它写到一半停了"。 */
export function lengthNotice(snapshot: GenSnapshot): string | null {
  if (snapshot.finishReason !== 'length') return null;
  return '已达到输出长度上限，内容可能没写完。可以再按一次续写接着写。';
}
