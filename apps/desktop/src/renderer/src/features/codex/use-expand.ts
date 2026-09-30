/**
 * AI 扩充设定的编排（`docs/16` §3 / D-3）。
 *
 * ## 与 `useAiQuick` 同源但**全文必须进面板**
 *
 * 两者都走 `streamAiEvents` + 外发闸门 + 归属判定（`docs/13` M18），差别在产物：
 * 快捷生成 `done` 之后把全文**按行拆成候选**（点一行插一行）；expand 的产物是
 * **一段完整文本**，要显示在面板里让用户通读后再决定采纳 —— 所以这里不解析候选，
 * 只把流式全文攒起来。
 *
 * ## 全文进 React state，但要**节流**
 *
 * `gen-state.ts` 的续写把全文写进幽灵文本装饰、**不进 React state**（流式每秒几十
 * 帧，进 state 会让整个工作台跟着重渲染）。expand 走不了那条路：它的全文就显示在
 * 面板上，必须进 state。折中是**节流**（{@link TEXT_THROTTLE_MS}）：`delta` 只往
 * `textRef` 累加并排一次定时刷新，`done`/`error`/停止时立即 flush。
 *
 * 节流而不是"每帧 setState"：面板是模态浮层，但它挂在设定编辑页里，而那一页有一排
 * 受控输入框 —— 每帧重渲染会连着 diff 它们。
 *
 * ## 归属（`docs/13` M18）
 *
 * `EntryDetail` 用 `key={slug}` 重挂载，所以**换条目**会自动 unmount（cleanup 作废在飞
 * 生成）。但**同一个条目内**连着生成两次（先梗概后描述）不会重挂载 —— 所以起跑时
 * 自增 `seqRef`，让上一次那趟异步的所有落地动作失效（否则第二次生成的面板会被第一次的
 * `catch` 覆盖掉）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ErrorCode } from '@inkstone/shared';
import type {
  AiExpandRequest,
  AiExpandTarget,
  AiPreviewRequest,
  CodexEntry,
} from '@inkstone/shared';

import { ApiError, describeApiError, type ApiClient } from '../../lib/api';
import { streamAiEvents } from '../../lib/ai-stream';
import { buildExpandRequest } from './expand-model';
import type { EgressGateCheck } from '../ai/use-egress-gate';

export type ExpandPhase = 'idle' | 'running' | 'ready' | 'error';

export interface ExpandFailure {
  code: string;
  message: string;
}

export interface ExpandSnapshot {
  phase: ExpandPhase;
  /** 本次生成的目标（summary / body）。面板据此决定采纳动作。 */
  target: AiExpandTarget | null;
  model: string;
  costCny: number | null;
  firstTokenMs: number | null;
  egressChars: number;
  /** 本次外发记录的 id（`runs.jsonl`）。采纳 body 时当追加标记用（D-7）。 */
  runId: string;
  failure: ExpandFailure | null;
}

const IDLE_SNAPSHOT: ExpandSnapshot = {
  phase: 'idle',
  target: null,
  model: '',
  costCny: null,
  firstTokenMs: null,
  egressChars: 0,
  runId: '',
  failure: null,
};

/** 流式全文刷新节流。见文件头。 */
export const TEXT_THROTTLE_MS = 80;

export interface UseExpandOptions {
  client: ApiClient | null;
  workId: string | null;
  /** 目标条目；null = 尚未选中，`start` 会静默返回。 */
  entry: CodexEntry | null;
  /** 「首次把内容发往某家云端供应商」的确认闸门（`docs/11` §2.3）。 */
  checkEgress?: EgressGateCheck;
}

export interface UseExpandApi {
  snapshot: ExpandSnapshot;
  /** 流式全文（节流更新）。采纳时以它为准。 */
  text: string;
  /** 发起一次扩充。正在生成时重复调用被忽略。 */
  start: (target: AiExpandTarget, intent?: string) => void;
  stop: () => void;
  close: () => void;
}

export function useExpand({ client, workId, entry, checkEgress }: UseExpandOptions): UseExpandApi {
  const [snapshot, setSnapshot] = useState<ExpandSnapshot>(IDLE_SNAPSHOT);
  const [text, setText] = useState('');
  const textRef = useRef('');
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<number | null>(null);
  const startedAtRef = useRef(0);
  const firstTokenMsRef = useRef<number | null>(null);
  const modelRef = useRef('');
  const costRef = useRef<number | null>(null);
  const egressRef = useRef(0);
  const runIdRef = useRef('');
  const targetRef = useRef<AiExpandTarget | null>(null);
  /** 归属序号（M18）。起跑 / 关闭 / unmount 都自增。 */
  const seqRef = useRef(0);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  /** 立即把 `textRef` 落到 state（`done` / `error` / 停止时用，不等节流）。 */
  const flushText = useCallback(
    (seq: number) => {
      clearTimer();
      if (seqRef.current !== seq) return;
      setText(textRef.current);
    },
    [clearTimer],
  );

  /** 排一次节流刷新。已在排期内则不动 —— 最后落地的一定是最新全文。 */
  const scheduleTextFlush = useCallback((seq: number) => {
    if (timerRef.current !== null) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      if (seqRef.current !== seq) return;
      setText(textRef.current);
    }, TEXT_THROTTLE_MS);
  }, []);

  const settle = useCallback(
    (seq: number, phase: ExpandPhase, failure: ExpandFailure | null = null) => {
      if (seqRef.current !== seq) return;
      setSnapshot({
        phase,
        target: targetRef.current,
        model: modelRef.current,
        costCny: costRef.current,
        firstTokenMs: firstTokenMsRef.current,
        egressChars: egressRef.current,
        runId: runIdRef.current,
        failure,
      });
    },
    [],
  );

  const start = useCallback(
    (target: AiExpandTarget, intent?: string) => {
      // 正在生成时不重复发（与 use-ai-continue / use-ai-quick 同一条约定）。
      // 判据用 `abortRef` 而不是 phase：连点通常在同一批事件里，state 还没更新。
      if (abortRef.current !== null) return;
      if (client === null || workId === null || entry === null) return;

      const wanted = intent ?? '';
      const body: AiExpandRequest = buildExpandRequest(workId, entry, target, wanted);
      // 预览请求：**必须带 chapterId/prefix**（`AiPreviewRequest` 继承 `AiGenRequest`
      // 的必填字段），expand 用不到它们、留空串。sidecar 的 `AiPreviewRequestIn` 已
      // override 成允许空串（见其 docstring）。
      const previewBody: AiPreviewRequest = {
        workId,
        chapterId: '',
        prefix: '',
        suffix: '',
        type: entry.type,
        slug: entry.slug,
        target,
      };
      if (wanted !== '') previewBody.intent = wanted;

      const launch = (): void => {
        const api = client;
        targetRef.current = target;
        textRef.current = '';
        modelRef.current = '';
        costRef.current = null;
        egressRef.current = 0;
        runIdRef.current = '';
        firstTokenMsRef.current = null;
        startedAtRef.current = performance.now();
        const seq = ++seqRef.current;
        clearTimer();
        setText('');
        setSnapshot({ ...IDLE_SNAPSHOT, phase: 'running', target });

        const controller = new AbortController();
        abortRef.current = controller;
        void (async () => {
          try {
            const events = streamAiEvents({
              connection: api.connection,
              path: '/ai/expand',
              body,
              signal: controller.signal,
            });
            for await (const event of events) {
              switch (event.type) {
                case 'meta':
                  runIdRef.current = event.runId;
                  modelRef.current = event.model;
                  egressRef.current = event.egressChars;
                  break;
                case 'delta':
                  textRef.current += event.text;
                  if (firstTokenMsRef.current === null) {
                    firstTokenMsRef.current = Math.max(
                      0,
                      Math.round(performance.now() - startedAtRef.current),
                    );
                  }
                  scheduleTextFlush(seq);
                  break;
                case 'usage':
                  costRef.current = event.costCny;
                  break;
                case 'done':
                  flushText(seq);
                  settle(seq, 'ready');
                  return;
                case 'error':
                  flushText(seq);
                  settle(seq, 'error', { code: event.code, message: event.message });
                  return;
              }
            }
            // 流正常结束但没收到 done —— 有内容当 ready，没内容报"中断"。
            flushText(seq);
            settle(seq, textRef.current.trim() === '' ? 'error' : 'ready', {
              code: 'INCOMPLETE',
              message: '生成被中断了。',
            });
          } catch (err) {
            flushText(seq);
            if (err instanceof ApiError && err.code === ErrorCode.AI_ABORTED) {
              // 用户停止：有内容当 ready（可采纳），没内容回 idle。
              settle(seq, textRef.current.trim() === '' ? 'idle' : 'ready');
            } else {
              settle(seq, 'error', {
                code: err instanceof ApiError ? err.code : 'INTERNAL',
                message: describeApiError(err),
              });
            }
          } finally {
            if (seqRef.current === seq) abortRef.current = null;
          }
        })();
      };

      // 闸门在面板打开**之前**跑：面板一旦显示"正在生成"却没有任何请求在跑，
      // 用户只能干等（与 use-ai-quick 同一理由）。
      if (checkEgress === undefined) {
        launch();
        return;
      }
      checkEgress(previewBody, launch);
    },
    [client, workId, entry, checkEgress, settle, flushText, scheduleTextFlush, clearTimer],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  /**
   * 关闭面板。**必须自增 `seqRef`**：abort 会让在飞那趟抛 `AI_ABORTED`，
   * 而它的 catch 照常 settle —— 一次合法收尾会把刚关掉的面板设回 ready（自己弹回来）。
   */
  const close = useCallback(() => {
    seqRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    clearTimer();
    textRef.current = '';
    setText('');
    setSnapshot(IDLE_SNAPSHOT);
  }, [clearTimer]);

  // unmount（换条目 / 关面板导致 EntryDetail 卸载）：作废在飞生成并清定时器。
  useEffect(() => {
    return () => {
      seqRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  return { snapshot, text, start, stop, close };
}
