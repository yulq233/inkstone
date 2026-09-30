/**
 * Chromium `proxy-bypass-list` 开关（04 文档 §6）。
 *
 * 渲染进程的 fetch 走 Chromium 网络栈，**会读取系统代理设置**。国内开发机普遍装着
 * 本地代理客户端（Clash / v2ray 之类），系统代理指向 127.0.0.1:7892。若代理规则没有
 * 显式放行 loopback，渲染进程对 sidecar 的请求会被送去代理，回来一个 502 ——
 * 用户看到的是"应用连不上自己的后端"，排查方向会被引到 sidecar 上（它其实好好的）。
 *
 * `<-loopback>` 里的 `-` 是**取反**：含义是"不对 loopback 使用代理"。语义与字面读感
 * 相反，极易被"顺手修正"成 `->loopback>` —— 那样反而会把 loopback 塞进代理。
 * 后面再显式列 127.0.0.1 与 localhost 是冗余保险：参数被其他启动器覆盖时仍能兜住。
 *
 * 这个常量放在 shared 而不是主进程：主进程要用它拼开关，渲染进程要用它做故障页展示，
 * 而放在这里才能被单测直接覆盖（主进程模块一 import 就会拉起 electron）。
 */
export const PROXY_BYPASS_LIST = '<-loopback>;127.0.0.1;localhost';

/** Chromium 命令行开关名。拼错不会报错，只会静默失效。 */
export const PROXY_BYPASS_SWITCH = 'proxy-bypass-list';

export interface ProxyBypassCheck {
  ok: boolean;
  problems: string[];
}

/**
 * 启动时自检。
 *
 * 存在的理由是这个开关**失效时没有任何症状**：不报错、不警告，只表现为
 * "某些机器上所有请求都 502"。把它变成一条可在启动日志里看到的结论，
 * 比事后从用户截图里猜要便宜得多。
 */
export function checkProxyBypassList(list: string = PROXY_BYPASS_LIST): ProxyBypassCheck {
  const problems: string[] = [];
  const entries = list
    .split(';')
    .map((item) => item.trim())
    .filter((item) => item !== '');

  if (!entries.includes('<-loopback>')) {
    problems.push('缺少 <-loopback>：loopback 请求仍会走系统代理');
  }
  if (list.includes('->loopback>')) {
    problems.push('出现 ->loopback>：取反写反了，它会把 loopback 加进代理');
  }
  for (const host of ['127.0.0.1', 'localhost']) {
    if (!entries.includes(host)) problems.push(`缺少冗余保险项 ${host}`);
  }

  return { ok: problems.length === 0, problems };
}
