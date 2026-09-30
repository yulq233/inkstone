import type { AppInfo } from '@inkstone/shared';
import { PROXY_BYPASS_LIST, checkProxyBypassList } from '@inkstone/shared';

/**
 * 渲染进程侧**只做读取与展示，不重复配置** —— 开关在主进程 `app.whenReady()` 之前
 * 就已声明（见 packages/shared/src/proxy.ts）。
 *
 * 这里存在的唯一理由：用户报"连不上本地服务"时，故障页要能一眼排除
 * "是不是系统代理把 loopback 请求截走了"这条最容易被误判成 sidecar bug 的原因。
 */
export function describeProxyBypass(info: AppInfo | null): string {
  // info 还没取回来时退回常量：这时展示的是"我们声明了什么"，取回后才是"实际生效的"。
  const list = info?.proxyBypassList ?? PROXY_BYPASS_LIST;
  const check = checkProxyBypassList(list);
  return check.ok
    ? `代理绕过已声明：${list}`
    : `代理绕过可能有误：${list}（${check.problems.join('；')}）`;
}
