/**
 * 设置的读取、应用与修改（`09` §3、`11` P0）。
 *
 * ## 一条硬约束：**主题立即生效，落盘不阻塞**
 *
 * 主题切换不走"发 IPC → 等回复 → 改界面"。顺序是**先改本地状态与 CSS 变量、再
 * fire-and-forget 落盘**：磁盘写失败不该让界面卡在半旧半新的状态里，
 * 而用户能观察到的全部就是"点了一下，颜色变了"（§3.6）。
 *
 * ## 为什么 AI 那半边**不**做本地合并
 *
 * 主题必须本地先合，是因为滑块会**回弹**（拖到边界时先显示越界值、等广播回来才跳回去）。
 * AI 的每个输入都不在"连续拖动"这一类里（下拉、复选框、失焦保存），
 * 一次广播往返在几十毫秒内完成，用户看不见中间态。
 * 于是 AI 走"只发补丁、等广播"这条路 —— 好处是**归一化只有一处**（主进程的
 * `parseAiSettings`），不必在渲染进程再抄一份夹取与校验规则。
 */

import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_SETTINGS,
  appearanceToCssVars,
  clampFontSize,
  clampLineHeight,
  themeToDataTheme,
  type AiSettings,
  type Settings,
  type ThemeSettings,
} from '@inkstone/shared';
import { subscribeAppCommand } from '../../lib/app-commands';

/** 非 Electron 环境（比如有人在浏览器里打开渲染进程）下拿不到这个桥 */
function settingsBridge(): Window['inkstone']['settings'] | undefined {
  return globalThis.window?.inkstone?.settings;
}

/**
 * 把外观写到 `<html>` 上。
 *
 * 两件事分开做，因为它们的机制不同：
 * - `data-theme` 走**属性**，由 CSS 的 `[data-theme='dark']` 选择器接管；
 * - 字号/行距走**内联 CSS 变量**（写在根元素上），沿继承链一路传给编辑器。
 *
 * 内联变量会覆盖 `editor.css` 里 `:root` 的同名声明 —— 这正是想要的：
 * 样式表给的是"JS 还没跑起来时"的初值，跑起来之后由设置说了算。
 */
function applyAppearance(theme: ThemeSettings): void {
  const root = document.documentElement;

  const dataTheme = themeToDataTheme(theme.mode);
  if (dataTheme === null) {
    // 「跟随系统」= **删掉属性**，交给媒体查询。留一个 `data-theme=""` 是另一种语义。
    delete root.dataset.theme;
  } else {
    root.dataset.theme = dataTheme;
  }

  for (const [name, value] of Object.entries(appearanceToCssVars(theme))) {
    root.style.setProperty(name, value);
  }
}

/**
 * 本地先夹一次，规则与主进程相同（都取自 shared 的 `clamp*`）。
 *
 * 不做这一步的话，滑块拖到边界时会先显示一个越界值，等主进程广播回来才跳回去 ——
 * 一次可见的回弹。
 */
function normalizeTheme(theme: ThemeSettings): ThemeSettings {
  return {
    mode: theme.mode,
    fontSize: clampFontSize(theme.fontSize),
    lineHeight: clampLineHeight(theme.lineHeight),
  };
}

export interface SettingsApi {
  settings: Settings;
  panelOpen: boolean;
  openPanel: () => void;
  closePanel: () => void;
  updateTheme: (patch: Partial<ThemeSettings>) => void;
  /** 改 AI 设置。**不改本地状态** —— 等主进程广播回来（见文件头）。 */
  updateAi: (patch: Partial<AiSettings>) => void;
}

/**
 * ⚠️ **这个 hook 必须常挂载**（在 `SettingsPanel` 里于早返回之前调用）。
 *
 * 主题与字号是这里写到 `<html>` 上的。如果"关闭面板"表现为卸载组件，
 * 那么**关掉面板就会把刚设好的主题一起撤掉** —— 属性还在，但不再有代码维护它，
 * 紧接着的一次系统主题变化就再也不同步了。所以关闭只是 `return null`，
 * hook 照常运行；真正的卸载路径只有整个应用退出。
 */
export function useSettings(): SettingsApi {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [panelOpen, setPanelOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const bridge = settingsBridge();
    if (bridge === undefined) return;

    // 读一次 + 订阅。两件都要：`get()` 覆盖"渲染进程比广播早挂载"，
    // 订阅覆盖"主进程改了设置（菜单里切主题）而渲染进程不知情"。
    void bridge.get().then((loaded) => {
      if (!cancelled) setSettings(loaded);
    });
    const offChanged = bridge.onChanged(setSettings);
    const offCommand = subscribeAppCommand((command) => {
      if (command === 'settings:openPanel') setPanelOpen(true);
    });

    return () => {
      cancelled = true;
      offChanged();
      offCommand();
    };
  }, []);

  useEffect(() => {
    applyAppearance(settings.theme);
  }, [settings.theme]);

  const updateTheme = useCallback((patch: Partial<ThemeSettings>) => {
    // 先改本地（本轮的 effect 会把它写到 DOM 上），再发出去。
    // 主进程广播回来的值会覆盖它 —— 两边用同一套夹取规则，所以结果一致。
    setSettings((prev) => ({ ...prev, theme: normalizeTheme({ ...prev.theme, ...patch }) }));
    void settingsBridge()?.set({ theme: patch });
  }, []);

  const updateAi = useCallback((patch: Partial<AiSettings>) => {
    // 只发出去。主进程归一化后广播回来，`onChanged` 会把它落到 `settings` 上。
    void settingsBridge()?.set({ ai: patch });
  }, []);

  const openPanel = useCallback(() => setPanelOpen(true), []);
  const closePanel = useCallback(() => setPanelOpen(false), []);

  return { settings, panelOpen, openPanel, closePanel, updateTheme, updateAi };
}
