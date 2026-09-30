/**
 * 快捷生成的编排（`docs/11` §6.3）。
 *
 * ## 与 `useAiContinue` 同源但不同路
 *
 * 两者都走 `/ai/quick` / `/ai/continue` 的同一条流式通道（`streamAiEvents`），
 * 但续写把全文写进幽灵文本装饰，快捷生成把全文攒起来、`done` 之后按行拆成候选。
 * 所以这里**不碰幽灵文本**，也不复用 `useAiContinue` 的状态机 —— 强行复用会得到
 * 一个"既能接续写又能列候选"的怪东西，两个语义互相污染。
 *
 * ## 候选解析发生在 done 之后，不是边流边拆
 *
 * 逐行拆要等文本完整：流式中间拆，一个"名字"可能刚好被切在两半，拆出来的候选
 * 是残的。所以流式期间只累加，`done` / 停止后才 `parseQuickCandidates` 一次。
 * 这个"一次性拆"也比"每个 delta 都拆一遍"省，而且结果更对。
 *
 * ## ⚠️ 结果必须判「归属」（`docs/13` M18）
 *
 * 面板是模态浮层，而它的可见性只看 `snapshot.phase !== 'idle'`。于是"谁有权写这个
 * snapshot"就是唯一的开关，缺了它有三个症状：
 *
 * - `close()` 里 `abort()` 之后，在飞的那趟抛 `AI_ABORTED`，`catch` 里照常收尾 →
 *   **刚关掉的面板自己弹回来**；
 * - 换章只 abort、不复位 → 面板停在上一次的 `ready`；
 * - 那时点候选插入，用的是**新章**的光标 → **旧章的候选写进新章**（内容污染）。
 *
 * 判定的落点是 `seqRef`：起跑、关闭、换章都自增，落地前对一次。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ErrorCode, type AiGenRequest, type AiQuickKind } from '@inkstone/shared';

import { ApiError, describeApiError, type ApiClient } from '../../lib/api';
import { streamAiEvents } from '../../lib/ai-stream';
import type { EditorHandle } from '../editor/TipTapEditor';
import { parseQuickCandidates, type QuickCandidates } from './quick-gen';
import type { EgressGateCheck } from './use-egress-gate';

export type QuickPhase = 'idle' | 'running' | 'ready' | 'error';

export interface QuickFailure {
  code: string;
  message: string;
}

export interface QuickSnapshot {
  phase: QuickPhase;
  kind: AiQuickKind | null;
  /** 模型 / 成本等元信息（与续写候选条同口径）。 */
  model: string;
  costCny: number | null;
  firstTokenMs: number | null;
  egressChars: number;
  candidates: QuickCandidates | null;
  failure: QuickFailure | null;
}

const IDLE_SNAPSHOT: QuickSnapshot = {
  phase: 'idle',
  kind: null,
  model: '',
  costCny: null,
  firstTokenMs: null,
  egressChars: 0,
  candidates: null,
  failure: null,
};

export interface AiQuickOptions {
  client: ApiClient | null;
  workId: string | null;
  chapterId: string | null;
  getHandle: () => EditorHandle | null;
  /** 「首次把内容发往某家云端供应商」的确认闸门（`docs/11` §2.3）。见 `use-ai-continue`。 */
  checkEgress?: EgressGateCheck;
}

export interface AiQuickApi {
  snapshot: QuickSnapshot;
  /** 发起一次快捷生成。正在生成时重复调用被忽略。 */
  start: (kind: AiQuickKind, intent?: string) => void;
  stop: () => void;
  /** 点选某一项，插到当前光标处。返回是否插入成功。 */
  insert: (item: string) => boolean;
  close: () => void;
}

export function useAiQuick({
  client,
  workId,
  chapterId,
  getHandle,
  checkEgress,
}: AiQuickOptions): AiQuickApi {
  const [snapshot, setSnapshot] = useState<QuickSnapshot>(IDLE_SNAPSHOT);
  const textRef = useRef('');
  const abortRef = useRef<AbortController | null>(null);
  const startedAtRef = useRef(0);
  const firstTokenMsRef = useRef<number | null>(null);
  const modelRef = useRef('');
  const costRef = useRef<number | null>(null);
  const egressRef = useRef(0);
  const kindRef = useRef<AiQuickKind | null>(null);
  const intentRef = useRef('');

  /**
   * 「归属序号」（`docs/13` M18）：只有序号仍是最新的那一次生成，才有权写面板。
   *
   * 每次起跑 / 关闭 / 换章都自增；自增之后，**上一次那趟异步留下的任何落地动作
   * 都被丢弃**。理由见文件头 —— 三个症状（面板自己弹回、切章后停在 ready、
   * 旧章候选插进新章）都是"没人问过这结果还属不属于当前界面"。
   */
  const seqRef = useRef(0);

  const settle = useCallback(
    (seq: number, phase: QuickPhase, failure: QuickFailure | null = null) => {
      // 不是最新的那一次：**什么都不做**。它既不该开面板，也不该改面板上的内容。
      if (seqRef.current !== seq) return;
      const kind = kindRef.current;
      setSnapshot({
        phase,
        kind,
        model: modelRef.current,
        costCny: costRef.current,
        firstTokenMs: firstTokenMsRef.current,
        egressChars: egressRef.current,
        candidates:
          phase === 'ready' && kind !== null ? parseQuickCandidates(kind, textRef.current) : null,
        failure,
      });
    },
    [],
  );

  const start = useCallback(
    (kind: AiQuickKind, intent?: string) => {
      /**
       * 正在生成时不重复发 —— 与 `use-ai-continue` 同一条约定（它的注释同样适用：
       * sidecar 也会用 `AI_BUSY` 拦，但那是一次白跑的往返；静默是对的，面板上
       * 已经写着"正在生成"）。
       *
       * ⚠️ 判据是 `abortRef.current !== null` 而不是 `snapshot.phase`：连点两次
       * 通常发生在**同一批事件**里，state 那时还没更新。`abortRef` 恰好与"在飞"
       * 同生命周期：`launch` 挂上、收尾 `finally`（判归属后）/ `close` / 换章
       * 都会清掉 —— 三条路径核对过，它非空当且仅当一路生成在飞。
       *
       * ⚠️ 不做"顶掉前一次"：顶掉只是 `++seqRef` 让旧结果失效，旧的
       * `AbortController` **没有被 abort** —— 旧流会在后台把 tokens 烧完、
       * 占着 sidecar 的并发位，而它的结果又因序号过期全部被丢；新请求还会
       * 撞 `AI_BUSY` 409 让面板弹错。两头都是白花钱。
       */
      if (abortRef.current !== null) return;
      if (client === null || workId === null || chapterId === null) return;
      const handle = getHandle();
      if (handle === null) return;

      // 正文与上下文**只构造一次**，闸门与真正的请求共用同一个对象 ——
      // 两次各构造一遍的话，预览里显示的可能与实际发出去的不是同一份
      // （这正是这张卡唯一要回答的问题）。
      // 确认卡上停留期间光标动不了（`.modal-backdrop` 盖住整个窗口），所以前文不会过期。
      const wanted = intent ?? '';
      const { prefix, suffix } = handle.getContextAroundCursor();
      const body: AiGenRequest = { workId, chapterId, prefix, suffix };
      if (wanted !== '') body.intent = wanted;

      const launch = (): void => {
        // 收窄后的引用固定下来：`launch` 可能被闸门推迟，而 TS 不会把参数上的收窄带进闭包。
        const api = client;
        kindRef.current = kind;
        intentRef.current = wanted;
        textRef.current = '';
        modelRef.current = '';
        costRef.current = null;
        egressRef.current = 0;
        firstTokenMsRef.current = null;
        startedAtRef.current = performance.now();
        // 认领本次生成：它一自增，上一次那趟就再也写不动面板了（M18）
        const seq = ++seqRef.current;
        setSnapshot({ ...IDLE_SNAPSHOT, phase: 'running', kind });

        const controller = new AbortController();
        abortRef.current = controller;
        void (async () => {
          try {
            const events = streamAiEvents({
              connection: api.connection,
              path: '/ai/quick',
              body: { ...body, kind },
              signal: controller.signal,
            });
            for await (const event of events) {
              switch (event.type) {
                case 'meta':
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
                  break;
                case 'usage':
                  costRef.current = event.costCny;
                  break;
                case 'done':
                  settle(seq, 'ready');
                  return;
                case 'error':
                  settle(seq, 'error', { code: event.code, message: event.message });
                  return;
              }
            }
            // 流正常结束但没收到 done（异常上游）—— 有内容就当作 ready，没内容报空
            settle(seq, textRef.current.trim() === '' ? 'error' : 'ready', {
              code: 'INCOMPLETE',
              message: '生成被中断了。',
            });
          } catch (err) {
            if (err instanceof ApiError && err.code === ErrorCode.AI_ABORTED) {
              // 用户停止：有内容当 ready（§6.5 不算错误），没内容回 idle。
              // 注意这里**不区分**"用户按了停止"与"我们因为关面板/换章才 abort" ——
              // 后两种由 `seqRef` 挡掉（`close()` 与换章的 cleanup 都自增过），
              // 所以走到这里的一定是前者。
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

      if (checkEgress === undefined) {
        launch();
        return;
      }
      // ⚠️ 闸门**在面板打开之前**跑：面板一旦显示"正在生成"，里面却没有任何请求在跑，
      // 用户只能干等 —— 那种"点了没反应"正是这套界面一直在避免的东西。
      // 所以闸门挂起时界面完全没有变化，直到用户在同一张确认卡上做了决定。
      checkEgress({ ...body, kind }, launch);
    },
    [client, workId, chapterId, getHandle, settle, checkEgress],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const insert = useCallback(
    (item: string): boolean => {
      const handle = getHandle();
      if (handle === null) return false;
      return handle.insertAtCursor(item) !== null;
    },
    [getHandle],
  );

  /**
   * 关闭面板。
   *
   * **必须自增 `seqRef`，不能只 `abort()`**：abort 会让在飞的那趟抛 `AI_ABORTED`，
   * 而它的 `catch` 里照常 `settle(seq, ...)` —— 一次合法的收尾会把面板设回 `ready`，
   * 于是用户刚关掉的面板自己弹回来。自增之后那次落地的序号已经过期，被丢弃。
   */
  const close = useCallback(() => {
    seqRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setSnapshot(IDLE_SNAPSHOT);
  }, []);

  /**
   * 换作品/换章：作废在飞的生成并关掉面板。
   *
   * `abort()` 单独还不够（理由同 `close`），而且这里还多一层：候选是按**旧章**的
   * 上下文生成的，新章的光标位置与它毫无关系 —— 留着面板，用户点一下就把旧章的
   * 候选插进新章，这是内容污染而不是显示问题。
   */
  useEffect(() => {
    return () => {
      seqRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
      setSnapshot(IDLE_SNAPSHOT);
    };
  }, [workId, chapterId]);

  return { snapshot, start, stop, insert, close };
}
