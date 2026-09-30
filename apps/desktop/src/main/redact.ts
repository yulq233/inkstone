/**
 * 主进程侧的日志脱敏（`docs/11` §3.3 的"日志"一行 / §8）。
 *
 * ## 为什么主进程也要一份
 *
 * sidecar 侧有 `logging.redact()` + `scrub()`（按 key 过滤 + 按值兜底），
 * 但主进程写的是**另一个文件**（`userData/logs/`），它没有那一层。
 * 而主进程恰好是唯一见过明文 Key 的地方 —— 它要解密、要推给 sidecar。
 * 只要有一处 `String(err)` 把上游响应体或请求头带进日志，Key 就落盘了。
 *
 * ## 为什么按"形态"擦除而不是按值
 *
 * 按值擦除需要先知道 Key 是什么，而那要求本模块持有凭据表 —— 那又会把明文
 * 多存一份。按形态（`sk-` 前缀 / `Bearer xxx` / `apiKey: xxx`）不需要知道任何值，
 * 且能在"我们从没见过的那个服务返回的报错里带着 Key"这种情况下也生效。
 *
 * ## 误伤的代价是对的
 *
 * 宁可把一个不敏感的串擦成 `<redacted>`，也不能漏掉一个真 Key：
 * 前者只是日志少一点信息，后者是用户的账号被盗刷。
 */

const REDACTED = '<redacted>';

/**
 * 要擦除的形态。
 *
 * 每个模式都刻意**保留字段名**（`apiKey=<redacted>` 而不是整行消失）：
 * 排查问题时"这里曾经有个 Key"本身就是有效信息。
 */
const PATTERNS: readonly { readonly pattern: RegExp; readonly replace: string }[] = [
  // OpenAI 系（含 DeepSeek / Kimi / 百炼 / 硅基流动）几乎都是 sk- 开头
  { pattern: /\bsk-[A-Za-z0-9_-]{8,}/g, replace: REDACTED },
  // Authorization: Bearer xxx
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, replace: `Bearer ${REDACTED}` },
  // 字段名 + 值（JSON / query / 日志拼接三种写法都覆盖）。
  // 把 `Bearer` / `Basic` 这类 scheme 放进**前半段**：留着它才有"这是个 Authorization 头"的信息，
  // 而如果留给"值"那一段去处理，`Basic dXNlcjpwYXNz` 这种会被整段擦掉（看不出是认证信息）
  // 或者干脆漏掉（Basic 不在上面那条 Bearer 规则里）。
  {
    // 字段名的**左边界**用 `(?<![A-Za-z0-9])` 而不是 `\b`：`\b` 把下划线也算词字符，
    // 于是 `INKSTONE_TOKEN=xxx` 里的 `TOKEN` 前面是 `_`、拿不到词边界 ——
    // 这个真实存在的形态就永远擦不掉（`docs/13` M11）。这里只排除 ASCII 字母数字，
    // `_` 与 `-` 都能充当边界，`inkstone[-_]token` 与 `x-inkstone-token` 一并覆盖。
    pattern:
      /(["']?(?<![A-Za-z0-9])(?:api[-_]?key|apikey|authorization|inkstone[-_]token|token|secret)["']?\s*[:=]\s*["']?(?:bearer\s+|basic\s+)?)([^"'\s,;&}]{4,})/gi,
    replace: `$1${REDACTED}`,
  },
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const { pattern, replace } of PATTERNS) {
    // 每次都从上次的位置重来：正则带 g，`replace` 自己会重置 lastIndex
    out = out.replace(pattern, replace);
  }
  return out;
}

/** 顺手让调用方少写一次模板串。 */
export function redactValue(value: unknown): string {
  return redactSecrets(String(value));
}
