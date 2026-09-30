/**
 * 「这个 URL 能不能交给系统浏览器打开」的**唯一**判定（`docs/13` H4）。
 *
 * ## 为什么是独立模块
 *
 * 判定本身只有三行，但它守的是一条安全红线：`shell.openExternal` 在 Windows 上
 * 不止能开 http(s) —— `file://`、UNC 路径（`\\host\share`，会带着凭据去连目标主机）、
 * `ms-settings:` 这类自定义协议都会被转交给系统处理。漏判一个就是从网页/稿件里
 * 点一下 = 打开本机任意资源。
 *
 * 所以它必须能被单测覆盖，而 `window.ts` 做不到 —— 那个模块一 import 就拉起
 * `electron`（测试环境是纯 node）。这与 `redact.ts`、shared 的 `proxy.ts` 是同一个理由。
 *
 * ## 为什么"判不出来 = 不该外开"
 *
 * 入参来自页面（可能是别人稿子里的一段文本）。`new URL()` 对畸形串会抛，
 * 而一次点击不该把主进程带崩；即便不崩，我们也无从判断它到底是什么协议。
 * 两个方向里，"不放行"只会让一个链接点不开（用户能看见、能复制），
 * "放行"可能把系统交给一个未知协议处理器。
 */
export function isExternalHttpUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}
