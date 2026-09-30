/**
 * 渲染进程的"黑匣子"。
 *
 * ## 为什么要有这个文件
 *
 * 2026-09-28 的一次事故：新建作品后整个界面变白，**连原生菜单都点不动**，而日志、
 * 控制台、崩溃转储里**一条线索都没有** —— 渲染进程的 console 只活在 DevTools 里
 * （dev 态还是独立窗口，很容易被主窗口挡住），主进程一条都不转发。于是"白屏"变成了
 * 一个无法开始的调查：不知道是主进程卡住、渲染进程卡住、还是渲染进程抛了异常。
 *
 * 本模块把这三件事分开说清楚，读数就是排查顺序：
 *
 * | 日志里的读数 | 含义 |
 * |---|---|
 * | `[hb] main alive` 停了 | **主进程**卡住（这时菜单也不会响应，因为菜单归主进程） |
 * | `[renderer] unresponsive` | **渲染进程**卡住（多半是死循环 / 长任务，不是抛异常） |
 * | `[renderer] error …` | 渲染进程抛了异常，栈就在后面几行 |
 * | `[renderer] gone …` | 渲染进程进程级消失（崩溃 / 被杀） |
 *
 * ## 两个刻意的决定
 *
 * **1）不区分开发态与生产态。** "白屏但什么都不说"是最贵的故障形态，线上同样需要
 * 这几条。唯一例外是心跳（见下），它的频率只在开发态有意义。
 *
 * **2）只转发 `warning` / `error`。** `info` / `debug` 里混着 Vite 的模块日志与 React 的
 * 日常输出，全量转发会把真正有用的那几行淹掉 —— 而本模块存在的全部理由就是"让那几行
 * 能被看到"。
 */

import type { BrowserWindow } from 'electron';

/** 心跳间隔。取 5 秒：够快能看出卡死，又不至于把终端刷满。 */
const HEARTBEAT_MS = 5_000;

/**
 * 把渲染进程的各种失败模式接到主进程 stderr（也就是 `pnpm dev` 的终端、CI 的日志）。
 *
 * 每个窗口挂一次 —— macOS 的 `activate` 会再造窗口，挂在创建处才不会漏。
 */
export function attachRendererDiagnostics(win: BrowserWindow): void {
  const wc = win.webContents;

  wc.on('console-message', (details) => {
    if (details.level !== 'error' && details.level !== 'warning') return;
    const where = details.sourceId === '' ? '' : `  (${details.sourceId}:${details.lineNumber})`;
    process.stderr.write(`[renderer] ${details.level} ${details.message}${where}\n`);
  });

  /**
   * 渲染进程停止 / 恢复响应。
   *
   * 这一条专门用来把"卡住"与"抛异常"分开：卡住时页面同样是一片白，但**没有任何异常栈**
   * ——没有它就只能靠猜，而猜错方向会让人去翻一个根本没问题的组件。
   */
  wc.on('unresponsive', () => {
    process.stderr.write('[renderer] unresponsive —— 渲染进程停止响应（死循环或长任务）\n');
  });
  wc.on('responsive', () => {
    process.stderr.write('[renderer] responsive —— 渲染进程已恢复响应\n');
  });

  wc.on('render-process-gone', (_event, details) => {
    process.stderr.write(`[renderer] gone reason=${details.reason} exitCode=${details.exitCode}\n`);
  });

  /**
   * preload 抛异常。
   *
   * 单独接是因为它**不会**走 `console-message`：preload 在页面脚本之前执行，它挂了的话
   * 页面拿不到 `window.inkstone`，而症状会是"界面正常但所有功能无效"——又是另一种白屏。
   */
  wc.on('preload-error', (_event, preloadPath, error) => {
    process.stderr.write(`[renderer] preload-error ${preloadPath}\n${String(error)}\n`);
  });

  wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    // 只报主框架：子框架失败（图标、内嵌资源）与"页面根本没起来"是两件事。
    if (!isMainFrame) return;
    process.stderr.write(
      `[renderer] did-fail-load ${errorCode} ${errorDescription} ${validatedURL}\n`,
    );
  });
}

/**
 * 主进程心跳。
 *
 * 存在的理由很具体：白屏那次**原生菜单也点不动**，而菜单是主进程的 —— 这只有"主进程
 * 卡住"能解释，可是日志里没有心跳，就永远分不清"主进程卡住"与"渲染进程卡住"。
 * 有了它这件事就从推测变成读数：心跳停 = 主进程卡住；心跳还在 = 问题在渲染进程。
 *
 * 只在开发态开：生产态日志要长期留存，每 5 秒一行会把有用信息冲淡。
 */
export function startMainHeartbeat(): void {
  const timer = setInterval(() => {
    process.stderr.write(`[hb] main alive ${new Date().toISOString()}\n`);
  }, HEARTBEAT_MS);

  // 不要让心跳把进程钉住 —— 退出时不该为它多等一个间隔。
  timer.unref();
}
