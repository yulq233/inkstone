/**
 * 关窗前"请渲染进程落盘"（`06` 文档 §7）。
 *
 * ## 为什么必须来回一次
 *
 * 主进程持有窗口，渲染进程持有正文。而 `Autosave` 有 3000ms 的 `maxWait`，
 * 也就是说**任何时刻都可能存在最多 3 秒的未落盘内容**。用户点关闭按钮时若直接关掉，
 * 这几秒就没了 —— 而 A4 的判定是"正常关闭零丢失"（强杀才允许丢 3 秒）。
 *
 * ## 三条硬规则的落点
 *
 * | 规则 | 代码里的体现 |
 * |---|---|
 * | 必须有超时，否则"关不掉" | `FLUSH_TIMEOUT_MS` + 超时直接 destroy |
 * | 先 flush，再关 sidecar | 这里只 destroy 窗口；sidecar 交给 `will-quit`（`index.ts`） |
 * | `app:beforeQuit` 只发一次 | `flushRequested`（**每个窗口一份**，见下） |
 *
 * `close` 事件在 `destroy()` 之前可能触发多次，而重复发送只是让渲染进程白 flush 一遍，
 * 所以那个标志位是省事，不是正确性所必需。
 */

import { dialog, type BrowserWindow } from 'electron';
import type { FlushResult } from '@inkstone/shared';
import { saveWindowState } from './store/settings';
import { captureWindowState } from './window-state';

/** 等渲染进程回复的上限。超时按 §7.2 的第三支处理：视为卡死，直接 destroy。 */
const FLUSH_TIMEOUT_MS = 3_000;

/**
 * 等待中的 resolver。
 *
 * 刻意用单槽而不是 Map：同一时刻只可能有一次关闭在等（`quit-guard` 的
 * `flushRequested` 挡住了同一窗口的重复进入，而 `activate` 只在**没有**窗口时才建新的）。
 * 用单槽还能顺手把"超时后迟到的回复"丢掉 —— 那种回复如果被接进一个已经收尾的流程，
 * 会变成一次没有意义的状态回退。
 */
let pending: ((result: FlushResult) => void) | null = null;

/**
 * 渲染进程的回复。由 `ipc.ts` 的 `app:flushResult` 处理器调用 ——
 * `ipcMain` 的注册集中在 `ipc.ts`，这里只持有状态。
 */
export function resolveFlushResult(result: FlushResult): void {
  const resolve = pending;
  if (resolve === null) return;
  pending = null;
  resolve(result);
}

/** 给窗口挂上关闭拦截。在 `createMainWindow()` 里调用。 */
export function attachCloseGuard(win: BrowserWindow): void {
  /**
   * 这个窗口是否已经为某次关闭发过 flush 请求。
   *
   * **刻意放闭包、每个窗口一份**，不放模块级。模块级会在 macOS 上出错：
   * `activate` 会再建一个窗口（见 `window.ts`），而那个标志在**上一个窗口销毁后仍是
   * `true`**，于是新窗口的 `close` 会直接 `return` —— 不 flush、不提示、静默丢字。
   */
  let flushRequested = false;

  win.on('close', (event) => {
    if (flushRequested) return;
    event.preventDefault();
    flushRequested = true;
    // 这个 Promise 必须接住（`docs/13` M14）：走到这里 `close` 已经被 preventDefault 过了，
    // 如果它因为异常悄悄结束，表现是**点关闭没反应、也没有任何提示**，
    // 而用户唯一的办法是杀进程 —— 那才是真的丢字。
    void handleCloseRequest(win, () => {
      // 用户选了「取消」：放开标志，让他写完再点关闭时还能走一遍这个流程。
      flushRequested = false;
    }).catch((err: unknown) => {
      process.stderr.write(`[inkstone] 关闭流程异常，已取消本次关闭：${String(err)}\n`);
      // 按「取消」处理，而不是硬关：异常时落盘**没有确认成功**，
      // 这时候销毁窗口等于替用户做了"丢掉这段"的决定。
      if (!win.isDestroyed()) flushRequested = false;
    });
  });
}

async function handleCloseRequest(win: BrowserWindow, onCancelled: () => void): Promise<void> {
  const result = await requestFlush(win);

  if (result.ok) {
    destroyWindow(win);
    return;
  }

  // 渲染进程明确回报"还有内容没落盘"。这里**不能**静默关掉 ——
  // 那等于用户点一下关闭就丢掉他刚敲的一段。交给他自己拍板。
  if (win.isDestroyed()) return;
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['取消', '仍要退出'],
    // 默认与取消都落在「取消」：让"丢字"成为需要主动点的那个动作，
    // 而不是回车键的默认结果。
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: '有内容尚未保存',
    message: '有内容尚未保存',
    detail: result.reason ?? '仍要退出会丢弃这些改动。',
  });

  if (response === 1) {
    destroyWindow(win);
    return;
  }

  onCancelled();
}

/**
 * 真正关掉窗口。**这是窗口销毁的唯一出口**（两条分支都走它）。
 *
 * 窗口状态的落盘**刻意放在这里**（`09` §5.4）：它与"关窗前 flush"是同一件事的两半 ——
 * 都必须在 `destroy()` 之前完成。放在一处（而不是各写各的 close 监听）有两个好处：
 * 用户点「取消」时不会白存一次当前尺寸；将来有人改关闭流程，也不容易只改一半。
 */
function destroyWindow(win: BrowserWindow): void {
  // 先存状态：`destroy()` 之后 `getBounds()` 就取不到了
  if (!win.isDestroyed()) {
    try {
      saveWindowState(captureWindowState(win));
    } catch (err) {
      // 存不下窗口位置不该拦住用户关闭应用
      process.stderr.write(`[inkstone] 窗口状态落盘失败：${String(err)}\n`);
    }
    win.destroy();
  }
}

/**
 * 请渲染进程落盘。
 *
 * 窗口还没加载完 / 已经销毁时直接放行：那种情况下渲染进程里本来就没有内容可丢，
 * 而等一个永远不会来的回复会让应用死在启动阶段。
 */
function requestFlush(win: BrowserWindow): Promise<FlushResult> {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return Promise.resolve({ ok: true });

  return new Promise<FlushResult>((resolve) => {
    const timer = setTimeout(() => {
      pending = null;
      // 超时按"卡死"处理并**直接关闭**（§7.2 第三支）。宁愿丢掉这次的改动，
      // 也绝不允许出现"点关闭没反应"—— 那比丢字更让用户愤怒，而且无处可逃。
      process.stderr.write(
        `[inkstone] 关窗前落盘请求 ${FLUSH_TIMEOUT_MS}ms 无响应，直接关闭窗口\n`,
      );
      resolve({ ok: true });
    }, FLUSH_TIMEOUT_MS);

    pending = (result) => {
      clearTimeout(timer);
      resolve(result);
    };

    win.webContents.send('app:beforeQuit');
  });
}
