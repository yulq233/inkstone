/**
 * 确认闸门的**纯判定**（`useEgressGate` 与它共用；`docs/11` §2.3）。
 *
 * ## 为什么抽出来
 *
 * 这个钩子的骨架是一个无法在纯 node 里驱动的异步交错（无 jsdom → 不能渲染钩子），
 * 但整条链上真正**会静默错**的只有两个判定点：
 *
 * 1. `admitEgressCheck` —— 进门前那道守卫。"连点两次"与"卡片已经开着又申请一次"
 *    都靠它挡。改坏的症状是**多弹一张卡 / 发两次预览请求**，界面上完全看不出来；
 * 2. `needsEgressConfirm` —— 预览回来后的分岔。**`null` 必须走"放行"而不是"弹卡"**：
 *    伪造一张"将发送 0 字"的卡比不弹卡更糟（用户会在错误的认知上按「继续」）。
 *
 * 这两处的布尔代数抽出来就能穷举；剩下的异步交错（`inflightRef` 何时归还、
 * `seqRef` 何时自增）是**顺序**问题而不是**判定**问题，只能靠手工验收（`docs/12`）。
 */

import type { AiPreviewResponse } from '@inkstone/shared';

/** 一次放行申请该怎么处置。 */
export type GateAdmit<C> =
  /** 已有一张卡在等、或一次预览在飞 → **静默**丢弃这次申请（卡片本身就摆在界面上）。 */
  | { kind: 'ignore' }
  /** 没有客户端，无从预览 → 直接放行（调用方自己的 `NO_CLIENT` 分支会给出那句话）。 */
  | { kind: 'bypass' }
  /** 去问服务端这次要不要弹卡。`client` 一并带出来，调用方不必再断言它非空。 */
  | { kind: 'preview'; client: C };

/**
 * 进门前那道守卫。
 *
 * ## 为什么把 `client` 放在返回值里，而不是只回一个 `'preview'`
 *
 * 判据与"有没有客户端"是同一件事的两面：`'preview'` **蕴含** `client !== null`。
 * 但 TypeScript 看不出这层蕴含 —— 若只回字符串，调用方就得再写一次
 * `if (client === null) return;` 才能用（一个永远不会走的死分支），
 * 或者上非空断言（把类型安全丢掉）。带出来就没有这个问题。
 *
 * 泛型而不是直接写 `ApiClient`：这个模块刻意**零运行时依赖**，
 * 这样纯 node 的测试可以直接 import 它。
 */
export function admitEgressCheck<C>(input: {
  /** 已经有一张卡在等用户决定。 */
  hasPending: boolean;
  /** 一次预览请求在飞（同时兼作防连点守卫）。 */
  inflight: boolean;
  client: C | null;
}): GateAdmit<C> {
  // ⚠️ 守卫在"有没有客户端"**之前**：顺序反过来的话，卡片开着时再点一次生成
  // 会走"没有客户端 → 放行"那条路 —— 也就是一次连点就绕过了"等着确认"。
  if (input.hasPending || input.inflight) return { kind: 'ignore' };
  if (input.client === null) return { kind: 'bypass' };
  return { kind: 'preview', client: input.client };
}

/**
 * 预览回来后要不要弹卡。返回 `true` 时类型收窄成 `AiPreviewResponse`，调用方直接可用。
 *
 * ⚠️ `preview === null`（预览失败）走 `false` = **放行**。这不是"当作已确认"，
 * 只是"这一次不拦"：确认名单只在用户点「继续」时才写，所以下一次生成照样会弹。
 * 判据全部来自服务端（`needsConfirm` 已把本机 / 已确认 / 纯本地模式都算完）。
 */
export function needsEgressConfirm(
  preview: AiPreviewResponse | null,
): preview is AiPreviewResponse {
  return preview !== null && preview.needsConfirm;
}
