/**
 * 续写的编排（`docs/11` §3.1 渲染进程那一段）。
 *
 * ## 状态放在 ref 里，快照放 state 里
 *
 * 全文（`GenState.text`）只进 ref 和编辑器装饰，React 只拿 `GenSnapshot`
 * （不含全文）—— 理由在 `gen-state.ts` 的文件头。这个划分让"流式生成时整个工作台
 * 每帧重渲染"从设计上不可能发生，而不是靠"记得加 memo"。
 *
 * ## 流式文本用 rAF 批量落 DOM
 *
 * §9 的风险表要求"流式 chunk 用 requestAnimationFrame 批处理"。一个 1024 token 的输出
 * 可能有上千个 delta，而每个 delta 都会触发布局；攒到下一帧再写一次，
 * 视觉上完全一样（屏幕本来就是 60Hz）。
 *
 * ## ⚠️ 换章必须停掉生成
 *
 * 幽灵文本的锚点是**按当前文档**的位置映射出来的。切章会把文档整个换掉
 * （`setMarkdown` → `setContent`），锚点随即失去意义 —— 不停的话，用户在新章节里
 * 按下接受，插进去的是**上一章**的生成内容。这是数据事故，不是显示问题。
 * 所以 `workId` / `chapterId` 一变就中止（见下面那个 effect），
 * 并且 `setMarkdown` 自己也会清掉幽灵文本（双重保险）。
 *
 * 「中止」还不够，必须**作废**：请求被 abort 之后那趟异步会照常走到 catch，
 * 在那里收尾并 publish。于是切完章界面上会留着上一次的候选条，而它的幽灵锚点
 * 已经被清掉 —— 用户点「接受」得到的是"格式无法识别"，一个字都插不进去。
 * 判定这件事的就是 `seqRef`（见它的声明处）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ErrorCode, type AiGenRequest } from '@inkstone/shared';

import { ApiError, describeApiError, type ApiClient } from '../../lib/api';
import { streamAiEvents } from '../../lib/ai-stream';
import type { EditorHandle } from '../editor/TipTapEditor';
import {
  IDLE_GEN_STATE,
  absorbGenEvent,
  beginGen,
  failGen,
  genSnapshot,
  settleGen,
  type GenFailure,
  type GenSnapshot,
} from './gen-state';
import type { EgressGateCheck } from './use-egress-gate';

/** 客户端侧的伪错误码：内容拿到了，但没能插进编辑器。同 `EMPTY_OUTPUT` 一族。 */
export const INSERT_FAILED_CODE = 'INSERT_FAILED';

export interface AiContinueOptions {
  /** 与 `use-chapter-switch` / `use-autosave` 同一个约定：会话还没拿到连接信息时是 `null` */
  client: ApiClient | null;
  workId: string | null;
  chapterId: string | null;
  /** 惰性取句柄：编辑器实例会被 `useEditor` 换掉，拿实例会留下过期引用 */
  getHandle: () => EditorHandle | null;
  /**
   * 「首次把内容发往某家云端供应商」的确认闸门（`docs/11` §2.3）。
   *
   * 不传就是**没有闸门**（既有行为：直接发）。做成可选而不是必填，
   * 是因为"要不要拦"是使用方的策略，而这个钩子的职责只有"生成"这一件事。
   */
  checkEgress?: EgressGateCheck;
}

export interface AiContinueApi {
  snapshot: GenSnapshot;
  /** 开始续写。正在生成时重复调用会被忽略（不重复发请求） */
  start: (intent?: string) => void;
  /** 按上一次的附加指令重来一次（用户写好的要求不该因为一次失败就消失） */
  retry: () => void;
  stop: () => void;
  accept: () => void;
  discard: () => void;
}

export function useAiContinue({
  client,
  workId,
  chapterId,
  getHandle,
  checkEgress,
}: AiContinueOptions): AiContinueApi {
  const stateRef = useRef(IDLE_GEN_STATE);
  const [snapshot, setSnapshot] = useState<GenSnapshot>(() => genSnapshot(IDLE_GEN_STATE));
  const abortRef = useRef<AbortController | null>(null);
  const frameRef = useRef(0);
  /** 上一次的附加指令，重试时沿用（用户已经写好的要求不该在重试后消失） */
  const intentRef = useRef('');

  /**
   * 「归属序号」（`docs/13` M18）。
   *
   * 每次起跑、每次换作品/换章都自增。自增之后，**上一次那趟异步留下的任何落地动作
   * 都失去写 UI 的资格** —— 这就是"结果归属"判定。
   *
   * 为什么必须有它：`abort()` 只让流抛 `AI_ABORTED`，那趟异步随即走到 `catch` 里
   * 照常收尾（`settleGen(..., 'aborted')` → 有内容就落 `ready`）。换章时幽灵锚点
   * 已被 `setMarkdown` 清掉，于是界面上留下一条**点了没反应**的候选条、
   * 或者点「接受」得到"格式无法识别"。它也是"关闭面板后面板自己弹回来"的同一个成因
   * （那一处在 `use-ai-quick.ts`）。
   */
  const seqRef = useRef(0);

  const publish = useCallback(() => {
    setSnapshot(genSnapshot(stateRef.current));
  }, []);

  /** 立刻把当前文本写进幽灵文本（不等下一帧）。**必须能取消已排队的帧**，否则会晚一帧写回旧值。 */
  const flushGhost = useCallback(() => {
    if (frameRef.current !== 0) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
    }
    getHandle()?.ghostUpdate(stateRef.current.text);
  }, [getHandle]);

  const scheduleGhost = useCallback(() => {
    if (frameRef.current !== 0) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      getHandle()?.ghostUpdate(stateRef.current.text);
    });
  }, [getHandle]);

  /**
   * 立刻清掉幽灵文本（含已排队的帧）。
   *
   * ⚠️ 清之前必须先取消排队的 rAF：不清的话，帧会在 `ghostClear()` 之后才触发，
   * 把刚清掉的文本**原样写回去** —— 「不要」按下去鬼影闪一下又回来。
   */
  const clearGhostNow = useCallback(() => {
    if (frameRef.current !== 0) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
    }
    getHandle()?.ghostClear();
  }, [getHandle]);

  const reset = useCallback(() => {
    // 作废在飞的那次（若有）。`discard` 之后面板又自己冒出候选，就是它在作怪。
    seqRef.current += 1;
    clearGhostNow();
    stateRef.current = IDLE_GEN_STATE;
    publish();
  }, [clearGhostNow, publish]);

  const run = useCallback(
    async (api: ApiClient, path: string, body: AiGenRequest): Promise<void> => {
      const handle = getHandle();
      if (handle === null) return;
      // 先把锚点钉在当前光标处：**必须在发请求之前**。
      // 慢一步的话，用户在看到第一个字之前动了光标，锚点就落在别处了。
      if (!handle.ghostBegin()) return;

      // 认领本次生成。之后每一步落地之前都要问一句"还是我吗"（见 `seqRef`）。
      const seq = ++seqRef.current;
      stateRef.current = beginGen(performance.now());
      publish();

      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const events = streamAiEvents({
          connection: api.connection,
          path,
          body,
          signal: controller.signal,
        });
        for await (const event of events) {
          // 已被换章 / 重跑作废：**连 stateRef 都不能碰** —— 那份状态已经属于新一代了
          if (seqRef.current !== seq) return;
          const now = performance.now();
          stateRef.current = absorbGenEvent(stateRef.current, event, now);
          if (event.type === 'delta') {
            scheduleGhost();
            continue;
          }
          publish();
        }
      } catch (err) {
        if (seqRef.current !== seq) return;
        const aborted = err instanceof ApiError && err.code === ErrorCode.AI_ABORTED;
        if (aborted) {
          // 用户按了停止。**没有 `done` 事件**，所以这里自己收尾（§6.5：不算错误）
          stateRef.current = settleGen(stateRef.current, 'aborted', performance.now());
        } else {
          stateRef.current = failGen(stateRef.current, genFailure(err), performance.now());
        }
      } finally {
        // 被作废时不能清 `abortRef`：它此刻可能已经指向**新一代**的 controller
        if (seqRef.current === seq) {
          abortRef.current = null;
          flushGhost();
          publish();
        }
      }
    },
    [getHandle, flushGhost, publish, scheduleGhost],
  );

  /** 被自己拦下的那几种情况也要给一句话：`Ctrl+Enter` 按下去什么都没发生，用户只会以为坏了。 */
  const blocked = useCallback(
    (code: string, message: string) => {
      stateRef.current = { ...IDLE_GEN_STATE, phase: 'error', failure: { code, message } };
      publish();
    },
    [publish],
  );

  const startWith = useCallback(
    (intent: string) => {
      // 正在生成时不重复发：sidecar 也会用 `AI_BUSY` 拦，但那是一次白跑的往返。
      // 这一条**静默**是对的 —— 候选条上已经写着"正在生成"。
      if (stateRef.current.phase === 'running') return;
      if (workId === null || chapterId === null) {
        blocked('NO_CHAPTER', '还没有打开章节。先在左侧选一章，再续写。');
        return;
      }
      if (client === null) {
        blocked('NO_CLIENT', '本地服务还没连上，稍等一下再试。');
        return;
      }
      const handle = getHandle();
      if (handle === null) {
        blocked('NO_EDITOR', '编辑器还没准备好，稍等一下再试。');
        return;
      }

      const { prefix, suffix } = handle.getContextAroundCursor();
      const body: AiGenRequest = { workId, chapterId, prefix, suffix };
      if (intent !== '') body.intent = intent;
      const launch = (): void => {
        void run(client, '/ai/continue', body);
      };
      if (checkEgress === undefined) {
        launch();
        return;
      }
      // 闸门可能把这次申请**挂起**（首次把内容发往某家云端供应商时弹确认卡）。
      // 用户点「继续」之后由它回调 `launch` —— 那时才由 `run` 去钉锚点、发请求，
      // 所以"锚点在发请求之前钉在当前光标处"这条性质仍然成立（甚至更准：
      // 用户在确认卡上停留期间可能动了光标，而此时取的才是他真正要接着写的位置）。
      checkEgress(body, launch);
    },
    [client, workId, chapterId, getHandle, run, blocked, checkEgress],
  );

  const start = useCallback(
    (intent?: string) => {
      intentRef.current = intent ?? '';
      startWith(intentRef.current);
    },
    [startWith],
  );

  const retry = useCallback(() => {
    startWith(intentRef.current);
  }, [startWith]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const report = useCallback(
    (accepted: 'full' | 'none', acceptedChars: number) => {
      const runId = stateRef.current.runId;
      // `runId` 为空说明 `meta` 还没到（比如 `prepare()` 就被拒了）—— 那样服务端
      // 根本没建记录，也就没有可回填的东西
      if (runId === '' || workId === null || client === null) return;
      // 回填失败**不打断用户**：这只是统计。删掉候选这件事与它记没记上没有关系。
      void client
        .sendAiFeedback(runId, { workId, accepted, acceptedChars })
        .catch((err: unknown) => {
          console.warn(`[inkstone] 采纳结果回填失败（不影响刚才的操作）：${describeApiError(err)}`);
        });
    },
    [client, workId],
  );

  const accept = useCallback(() => {
    const handle = getHandle();
    if (handle === null || !genSnapshot(stateRef.current).acceptable) return;
    const chars = handle.ghostAccept();
    if (chars === null) {
      // 插入失败时**不清幽灵文本**：内容还在眼前，用户可以自己复制走
      stateRef.current = failGen(
        stateRef.current,
        {
          code: INSERT_FAILED_CODE,
          message: '这段内容没能插入编辑器（格式无法识别）。内容仍显示在光标处，可以手动复制。',
        },
        performance.now(),
      );
      publish();
      return;
    }
    report('full', chars);
    reset();
  }, [getHandle, report, reset, publish]);

  const discard = useCallback(() => {
    if (stateRef.current.phase === 'idle') return;
    report('none', 0);
    reset();
  }, [report, reset]);

  // 换作品 / 换章 / 离开工作台：**作废 + 中止 + 复位**。理由见文件头与 `seqRef`。
  //
  // 只 `abort()` 不复位是不够的：那趟异步会在 `catch` 里照常收尾并 publish，
  // 于是切章之后界面上留着上一次的候选条 —— 而它的幽灵锚点已被 `setMarkdown`
  // 清掉，用户点「接受」只会得到"格式无法识别"（一个字都插不进去）。
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
      reset();
    };
  }, [workId, chapterId, reset]);

  return { snapshot, start, retry, stop, accept, discard };
}

function genFailure(err: unknown): GenFailure {
  if (err instanceof ApiError) return { code: err.code, message: err.message };
  return { code: 'INTERNAL', message: describeApiError(err) };
}
