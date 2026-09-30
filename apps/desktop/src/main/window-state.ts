/**
 * 窗口状态的采集（`09` §5.3）。
 *
 * 三种时机，理由各不相同：
 *
 * | 时机 | 处理 | 为什么 |
 * |---|---|---|
 * | `resize` / `move` | **debounce 500ms** | 拖一次窗口每秒触发几十次，直接写盘是纯浪费 |
 * | `maximize` / `unmaximize` | 立即 | 离散事件，不会连发 |
 * | 关窗前 | 立即 | 见下 |
 *
 * ## 关窗那条为什么写在 `quit-guard.ts` 里
 *
 * `close` 事件已经被 `quit-guard.ts` 拦截（先请渲染进程把内容落盘）。窗口状态的落盘
 * 与它是**同一件事的两半** —— 都必须在 `destroy()` 之前完成 —— 所以统一放在
 * `quit-guard.ts` 的 `destroyWindow()` 这一个出口：被拦下或用户取消时不会白存一次，
 * 将来有人改关闭流程也不容易只改一半（`09` §5.4）。
 *
 * 反过来说：**这个文件不监听 `close`**。重复监听会让"取消关闭"也把当时的尺寸存下来。
 */

import type { BrowserWindow } from 'electron';
import type { WindowState } from '@inkstone/shared';
import { saveWindowState } from './store/settings';

/** 拖拽时的事件密度很高，攒一下再写。 */
const DEBOUNCE_MS = 500;

/**
 * 采集当前窗口状态。
 *
 * **最大化或最小化时都要取 `getNormalBounds()`**：
 *
 * - 最大化：`getBounds()` 给的是最大化后的尺寸，直接存下去，用户下次取消最大化就会得到
 *   一个"最大化尺寸的普通窗口" —— 而他从来没设过那个尺寸。
 * - 最小化：Windows 会把最小化窗口挪到屏幕外，`getBounds()` 因此返回 `-32000` 附近的坐标。
 *   而最小化会触发 `resize` / `move`，500ms 后防抖的 `save()` 就把这对坐标写进了磁盘。
 *
 * `getNormalBounds()` 是 Electron 专门为这两个场景提供的：无论当前是最大化、最小化还是
 * 全屏，它给的都是"普通状态"下的位置与尺寸。
 *
 * 本函数是**两条写盘路径**（防抖 `save()` 与关窗时 `destroyWindow()`）的唯一采集点，
 * 所以判断写在这里一处就够。
 */
export function captureWindowState(win: BrowserWindow): WindowState {
  const maximized = win.isMaximized();
  const bounds = maximized || win.isMinimized() ? win.getNormalBounds() : win.getBounds();
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    maximized,
  };
}

export function attachWindowStatePersistence(win: BrowserWindow): void {
  let timer: NodeJS.Timeout | null = null;

  const cancel = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  /**
   * 定时器可能在窗口销毁**之后**才到期（拖拽刚结束就点了关闭）。
   * 那时 `win.getBounds()` 会抛 `Object has been destroyed` —— 而这个抛错发生在
   * 一个 setTimeout 回调里，没人接得住，表现为控制台一行红字 + 关窗流程被打断。
   */
  const save = (): void => {
    timer = null;
    if (win.isDestroyed()) return;
    saveWindowState(captureWindowState(win));
  };

  const schedule = (): void => {
    cancel();
    timer = setTimeout(save, DEBOUNCE_MS);
  };

  win.on('resize', schedule);
  win.on('move', schedule);
  win.on('maximize', () => {
    cancel();
    save();
  });
  win.on('unmaximize', () => {
    cancel();
    save();
  });
  win.on('closed', cancel);
}
