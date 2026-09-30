/**
 * 崩溃条目的构造（`docs/13` M14）。
 *
 * ## 为什么单独一个文件、且一行 electron / node 都不 import
 *
 * 真正装兜底的那段代码要写盘、要退出应用，它只在主进程里跑得起来 ——
 * 于是最容易错的部分（**擦不擦得干净**、**非 Error 的抛出物会不会又抛一次**）
 * 一行都测不到。把"这一条崩溃日志长什么样"抽成纯函数，就能用单测钉住它。
 *
 * ## 为什么必须脱敏
 *
 * 崩溃现场往往正是**手里拿着明文 Key 的那段代码**（推配置、拼请求头）。
 * 栈里带着局部变量、消息里带着上游回显的场景在真实事故里很常见，
 * 而这份日志是要用户贴给我们的。
 */

import { redactSecrets } from './redact';

export type CrashKind = 'uncaughtException' | 'unhandledRejection';

/**
 * 把任意抛出物变成一段可读文本。
 *
 * `throw` 的东西可以是任意值（字符串、`undefined`、Promise、Symbol），
 * 而 `String(symbol)` 会抛 —— 在崩溃处理器里再抛一次，Node 会直接 abort，
 * 于是"记一条日志"这件事变成"什么线索都没留下"。
 */
export function describeThrown(value: unknown): string {
  if (value instanceof Error) {
    // `err.stack` 在部分运行时/被手工构造的 Error 上是空串 → 退回 `name: message`
    const name = value.name === '' ? 'Error' : value.name;
    if (typeof value.stack === 'string' && value.stack !== '') return value.stack;
    return `${name}: ${value.message}`;
  }
  try {
    return String(value);
  } catch {
    return '<无法字符串化的抛出物>';
  }
}

/**
 * 一条崩溃记录。带 ISO 时间戳与类别 —— 用 `toISOString()` 而不是本地格式，
 * 是为了让它和 sidecar 那份日志（同为 UTC）能直接按时间对齐。
 */
export function formatCrashEntry(kind: CrashKind, thrown: unknown, now: Date): string {
  return `[${now.toISOString()}] ${kind}\n${redactSecrets(describeThrown(thrown))}\n`;
}
