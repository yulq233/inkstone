/**
 * 「首次启用某个非本机供应商」的确认闸门（`docs/11` §2.3）。
 *
 * ## 它做什么
 *
 * 在一次生成**真正发出去之前**问一次服务端："这次要不要弹确认卡？" ——
 * 判据是 `POST /ai/preview` 回来的 `needsConfirm`（服务端按
 * `!local && providerId ∉ 已确认名单 && !offlineBlocked` 算完，见 `AiState.egress_confirm_needed`）。
 * 要弹就把它交给界面，用户点了「继续」再放行。
 *
 * ## ⚠️ 预览失败时**放行**，而不是拦下
 *
 * 这一条看起来方向反了（一个隐私相关的闸门，判不出来时难道不该挡住吗），
 * 但挡住是错的，理由有三条：
 *
 * 1. **失败的几种成因，生成也一定会失败**：`AI_NOT_CONFIGURED`（没配模型）、
 *    `AI_CONTEXT_TOO_LONG`（没内容可发）、sidecar 连不上 —— 拦在这里只会把
 *    同一句错误提前一次，用户还得再点一次才知道真实原因；
 * 2. **跳过这张卡不等于"确认过了"**。确认名单只在用户**点了「继续」**时才写。
 *    所以放过这一次之后，`needsConfirm` 仍然为真 —— 下一次生成照样会弹。
 *    代价被限死在"有一次生成没弹卡"，而不是"永远不弹"；
 * 3. 预览与生成走的是**同一条** `resolve_route` + `_assemble`，两者之间能让
 *    前者失败而后者成功的窗口（sidecar 恰好在这一瞬重启、一次磁盘读闪失）极窄。
 *
 * 反过来说，**不能**在这种情况下伪造一张"将发送 0 字"的卡 —— 那会让用户
 * 在错误的认知上按「继续」，比不弹卡更糟。
 *
 * ## 归属（`docs/13` M18 那一族）
 *
 * `resume` 闭包里钉着**当时**的 body（含 `workId` / `chapterId` / 光标前文）。
 * 卡片在这期间一直开着的话，用户完全可能切了章 —— 那时按「继续」就会拿
 * **上一章的前文与章节 id** 去请求。所以换作品/换章时整张卡作废（`reset`），
 * 这与 `useAiContinue` / `useAiQuick` 里 `seqRef` 的理由是同一个。
 *
 * 「在飞守卫」用 `useRef<boolean>` 而不是 state：连点两次通常发生在**同一批事件**里，
 * 那时 state 还没更新。用布尔而不是计数是刻意的 —— 一个布尔无论被清几次结果都一样，
 * 而计数一旦漏挡下溢就再也回不到 0（`async-ownership-guard` 技能里记着这个坑）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AiPreviewRequest, AiPreviewResponse } from '@inkstone/shared';

import { describeApiError, type ApiClient } from '../../lib/api';
import { admitEgressCheck, needsEgressConfirm } from './egress-gate-rules';

/** 一张在等用户决定的确认卡。 */
export interface EgressGateSlot {
  preview: AiPreviewResponse;
  /** 用户点「继续」之后要接着做的事（由申请方给）。 */
  resume: () => void;
}

/**
 * 向闸门申请放行。
 *
 * `proceed` 是**放行时**要做的事 —— 闸门自己不会替调用方发请求，
 * 因为"发哪个端点、带什么 body"只有调用方知道（续写与快捷生成的路径不同）。
 */
export type EgressGateCheck = (body: AiPreviewRequest, proceed: () => void) => void;

export interface EgressGate {
  /** 有值时表示有一张卡在等用户决定。 */
  pending: EgressGateSlot | null;
  check: EgressGateCheck;
  /** 用户点了「继续」：记下确认并放行。 */
  confirm: () => void;
  /** 用户点了「取消」：什么都不发，也**不**记确认（下次还会弹）。 */
  cancel: () => void;
}

export interface EgressGateOptions {
  client: ApiClient | null;
  workId: string | null;
  chapterId: string | null;
}

/** 非 Electron 环境（浏览器里打开渲染进程）下没有这个桥。取法与本仓其他桥一致。 */
function ackBridge(): Window['inkstone']['ai'] | undefined {
  return globalThis.window?.inkstone?.ai;
}

export function useEgressGate({ client, workId, chapterId }: EgressGateOptions): EgressGate {
  const [pending, setPending] = useState<EgressGateSlot | null>(null);
  /** 在等用户决定的那张卡。`state` 只负责渲染，判定一律读这里（同一批事件里 state 还是旧值）。 */
  const slotRef = useRef<EgressGateSlot | null>(null);
  /** 预览请求在飞。同时兼作"防连点"的守卫。 */
  const inflightRef = useRef(false);
  /** 归属序号：申请、确认、取消、换章都自增。见文件头。 */
  const seqRef = useRef(0);

  /** 作废当前这次申请：**三件事必须一起做**，少一件就会留下"卡在等一个已经被取代的结果"。 */
  const reset = useCallback(() => {
    seqRef.current += 1;
    inflightRef.current = false;
    slotRef.current = null;
    setPending(null);
  }, []);

  const check = useCallback<EgressGateCheck>(
    (body, proceed) => {
      // 判定点 ①：进门前那道守卫（已有一张卡在等 / 一次预览在飞 → 静默丢弃）。
      // **静默**是对的：卡片本身就摆在界面上，用户看得见"正在等确认"。
      const admit = admitEgressCheck({
        hasPending: slotRef.current !== null,
        inflight: inflightRef.current,
        client,
      });
      if (admit.kind === 'ignore') return;
      if (admit.kind === 'bypass') {
        proceed();
        return;
      }

      // `admit.kind === 'preview'` 已经蕴含客户端非空（它是判定的一部分），
      // 所以这里不需要再判一次 —— `admit.client` 就是收窄后的那个。
      const activeClient = admit.client;
      inflightRef.current = true;
      const seq = ++seqRef.current;
      void (async () => {
        let preview: AiPreviewResponse | null = null;
        try {
          preview = await activeClient.previewAi(body);
        } catch (err) {
          // 预览失败不该变成**新的**失败来源（文件头第 1 条）。
          // 用 warn 而不是 info：它意味着"这一次绕过了一道知情提示"，值得在日志里留痕。
          console.warn(`[inkstone] 生成前预览失败，本次不再拦确认卡：${describeApiError(err)}`);
        }
        // 先归还"在飞"，再判归属 —— 归还无条件，归属才分岔（`async-ownership-guard` 的落点四）。
        inflightRef.current = false;
        if (seqRef.current !== seq) return; // 已被换章 / 确认 / 取消取代
        // 判定点 ②：`null`（预览失败）走"放行"。返回 `true` 时 `preview` 已被收窄。
        if (!needsEgressConfirm(preview)) {
          proceed();
          return;
        }
        const slot: EgressGateSlot = { preview, resume: proceed };
        slotRef.current = slot;
        setPending(slot);
      })();
    },
    [client],
  );

  const confirm = useCallback(() => {
    const slot = slotRef.current;
    if (slot === null) return;
    // 先复位：`resume()` 会立刻发起一次生成，而那一步可能会走到"又一次申请"。
    // 留着旧卡会让那次申请被自己挡掉。
    reset();
    // 记下"这家已确认"。**不 await**：用户已经确认了，落盘失败只影响"下次会不会再弹"，
    // 而让一次按钮点击等一次磁盘写 + 一次 IPC 是不必要的。
    void (async () => {
      try {
        const result = await ackBridge()?.setEgressAck({
          providerId: slot.preview.providerId,
          acknowledged: true,
        });
        if (result !== undefined && !result.ok) {
          console.warn(`[inkstone] 确认记录没能保存：${result.message}`);
        }
      } catch (err) {
        console.warn(`[inkstone] 确认记录没能保存：${describeApiError(err)}`);
      }
    })();
    slot.resume();
  }, [reset]);

  const cancel = useCallback(() => {
    // **不记确认**：用户拒绝过的东西不该在下次悄悄放过。
    // 这里刻意不给"已取消"的提示 —— 卡片消失本身就是反馈，而正文一个字都没出去。
    reset();
  }, [reset]);

  // 换作品 / 换章：整张卡作废。理由见文件头（`resume` 里钉着旧的 body）。
  // ⚠️ `reset` 必须是**稳定引用**，否则这条 cleanup 会每渲染跑一次 ——
  // 于是卡片刚出现就被自己清掉（与 `WorkShell` 里 `getHandle` 那条注释同一个坑）。
  useEffect(() => reset, [workId, chapterId, reset]);

  return { pending, check, confirm, cancel };
}
