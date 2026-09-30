/**
 * 应用外观与窗口状态的共享契约（`09` 文档 §3 / §5）。
 *
 * ## 为什么放在 shared 而不是主进程
 *
 * **两侧都要用同一份常量，而不是"各写一份看起来一样的"**：
 * 主进程建窗口时要按字号范围校验落盘值、要按最小尺寸纠正窗口 bounds；
 * 渲染进程要用同一组 min/max/step 渲染滑块。各写一份的结果是"滑块到头了但存下去的值超出范围"
 * 这类对不上的小毛病 —— 而它们只在边界上出现，最难发现。
 */

import { DEFAULT_AI_SETTINGS, type AiSettings } from './ai-types';

/** 主题三态。 */
export type ThemeMode = 'system' | 'light' | 'dark';

export const THEME_MODES = ['system', 'light', 'dark'] as const;

export const THEME_MODE_LABEL: Record<ThemeMode, string> = {
  system: '跟随系统',
  light: '浅色',
  dark: '深色',
};

/**
 * 主题三态里的 `system` **必须是默认值**，而且要和"用户手动选了浅色"区分开。
 *
 * 二态表达不了这个区别：用户选过一次浅色之后，系统切成深色时应用不跟随 ——
 * 而他以为自己选的是"跟随系统"。这个 bug 只有三态能避免。
 */

/**
 * 落盘格式版本。
 *
 * - `1`：只有 `theme` + `window`
 * - `2`：增加 `ai` 段（`docs/11` P0）
 *
 * ⚠️ **升版本不等于丢数据**。旧版本读到不认识的版本号时会把原文件改名留档、
 * 再用默认值启动（`settings.ts` 的 `loadSettings`）—— 那对 v1 → v2 是**不可接受**的：
 * 用户升一次应用，主题与窗口位置全没了。所以 `parseSettings` 必须
 * **接受 1 并就地补默认值**（见 `settings-io.ts` 的 `SUPPORTED_SETTINGS_VERSIONS`）。
 */
export const SETTINGS_SCHEMA_VERSION = 2;

/** 我们认识的落盘版本。不在这张表里的版本才走"留档 + 重置"。 */
export const SUPPORTED_SETTINGS_VERSIONS = [1, 2] as const;

export interface ThemeSettings {
  mode: ThemeMode;
  /** 编辑器字号（px）。**只影响编辑器**，不是整个界面的缩放 */
  fontSize: number;
  /** 编辑器行距（倍数） */
  lineHeight: number;
}

/**
 * 窗口状态。
 *
 * `x` / `y` 可空是有意的：越界恢复时把它们置空，交给系统居中（见 `main/store/settings-io.ts`
 * 的 `ensureOnScreen`）。用 `0` 表示"没记住"是不行的 —— `0` 是合法坐标。
 */
export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  /** 最大化状态单独存 —— 最大化时 `getBounds()` 给的是最大化后的尺寸，直接存会丢"之前的尺寸" */
  maximized: boolean;
}

export interface Settings {
  schemaVersion: number;
  theme: ThemeSettings;
  /** 主进程读、主进程写；渲染进程只透传，不关心内容 */
  window: WindowState;
  /**
   * AI 偏好（`docs/11` P0）。
   *
   * 放在这里的理由与 `theme` 相同：界面偏好，**不是作品数据** ——
   * 它应当在 sidecar 起不来时照样可读可改（用户正是在那时最需要它）。
   * 但**不含 API Key**，Key 走 `safeStorage`（见 `ai-types.ts` 的文件头）。
   */
  ai: AiSettings;
}

/** 渲染进程能改的：外观与 AI 偏好。窗口状态是主进程自己的事。 */
export interface SettingsPatch {
  theme?: Partial<ThemeSettings>;
  ai?: Partial<AiSettings>;
}

/**
 * 字号范围。步进 1px、上下限 14~22 —— 上限不是怕字号太大，而是超过 22px 之后
 * 正文行宽（42em）会宽到需要横向滚动，那是排版问题不是字号问题。
 */
export const FONT_SIZE = { min: 14, max: 22, step: 1, fallback: 16 } as const;

/**
 * 行距范围。默认 1.8 落在长文阅读的舒适区；下限 1.5 再低就会出现行间黏连。
 */
export const LINE_HEIGHT = { min: 1.5, max: 2.4, step: 0.1, fallback: 1.8 } as const;

export const DEFAULT_WINDOW = { width: 1180, height: 780 } as const;

/** 与 `window.ts` 建窗口时的 `minWidth` / `minHeight` 同源，避免两处漂移。 */
export const MIN_WINDOW = { width: 900, height: 600 } as const;

/** 字号 / 行距作用的 CSS 变量名。渲染进程写值、`editor.css` 读值。 */
export const CSS_VAR_FONT_SIZE = '--editor-font-size';
export const CSS_VAR_LINE_HEIGHT = '--editor-line-height';

export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  theme: {
    mode: 'system',
    fontSize: FONT_SIZE.fallback,
    lineHeight: LINE_HEIGHT.fallback,
  },
  window: {
    width: DEFAULT_WINDOW.width,
    height: DEFAULT_WINDOW.height,
    maximized: false,
  },
  // `providers` 是 `DEFAULT_AI_SETTINGS` 里那个数组的**同一个引用**。
  // 这不是疏忽：消费方永远不会原地改它（`parseSettings` 每次新建数组、
  // `mergeAiSettings` 返回新对象、跨 IPC 还会被结构化克隆）。若哪天出现
  // 原地改动，症状是"改了设置却没落盘，但界面变了"。
  ai: DEFAULT_AI_SETTINGS,
};

/**
 * 窗口底色。**必须与 `global.css` 的 `--bg` 同值** —— 两处硬编码、互相注释指认。
 *
 * 值不一致的后果不是"颜色差点"，而是**启动时闪一下**：原生窗口先用这个值铺底，
 * 渲染进程加载完才换成 CSS 变量。深色主题下用浅色值铺底，用户会看到一次明显的白光。
 * 这条注释与 `global.css` 顶部的注释是一对，改一处务必改另一处。
 */
export const WINDOW_BG = {
  light: '#faf9f7',
  dark: '#1c1b19',
} as const;

/** 非有限数一律落回兜底值 —— `JSON` 里混进 `null` / 字符串时会走到这里。 */
function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** 字号夹到 `[14, 22]` 的整数。 */
export function clampFontSize(value: unknown): number {
  const n = Math.round(finiteOr(value, FONT_SIZE.fallback));
  return Math.min(FONT_SIZE.max, Math.max(FONT_SIZE.min, n));
}

/**
 * 行距夹到 `[1.5, 2.4]`，并**四舍五入到一位小数**。
 *
 * 不修约就会攒出 `1.9000000000000001` 这种值：滑块按 0.1 步进做浮点累加，
 * 落盘之后每次读回来再存一次，误差会慢慢长出来。
 */
export function clampLineHeight(value: unknown): number {
  const n = finiteOr(value, LINE_HEIGHT.fallback);
  const clamped = Math.min(LINE_HEIGHT.max, Math.max(LINE_HEIGHT.min, n));
  return Math.round(clamped * 10) / 10;
}

/**
 * 主题模式 → `<html data-theme>` 的值。返回 `null` 表示**删除该属性**。
 *
 * 这里刻意不用空字符串。`element.dataset.theme = ''` 写出的是 `data-theme=""`，
 * 也就是**属性存在、值为空** —— 语义正好相反（"显式指定了一个空主题"）。
 * 而 CSS 侧的 `:not([data-theme='light']):not([data-theme='dark'])` 恰好仍然匹配，
 * 于是这个错**没有症状**，直到有人换一种选择器写法才炸出来。
 */
export function themeToDataTheme(mode: ThemeMode): 'light' | 'dark' | null {
  return mode === 'system' ? null : mode;
}

/**
 * 外观设置 → 要写到 `<html>` 上的 CSS 变量。
 *
 * 抽成函数是为了能被断言：字号必须是 `px` 结尾、行距必须是纯数字 ——
 * 少了单位浏览器会静默忽略整条声明（而 `line-height: 1.8px` 是合法的，会真的生效成 1.8px，
 * 那才是更难查的）。
 */
export function appearanceToCssVars(theme: ThemeSettings): Record<string, string> {
  return {
    [CSS_VAR_FONT_SIZE]: `${clampFontSize(theme.fontSize)}px`,
    [CSS_VAR_LINE_HEIGHT]: String(clampLineHeight(theme.lineHeight)),
  };
}

/**
 * 菜单命令（主进程 → 渲染进程）。
 *
 * **主题与字号不在这里** —— 它们走 `settings:changed`：主进程改存储、广播新设置，
 * 渲染进程应用。多一条命令只会造出两个真源（"设置里是深色"而"界面是浅色"）。
 *
 * 边界遵循 `02` §2.2：主进程**不直接操作业务状态**，只发命令，由渲染进程执行。
 */
export type AppCommand =
  | 'work:new'
  | 'work:open'
  | 'work:close'
  /** 菜单的撤销/重做转发给编辑器自己执行 —— 见 `docs/09` §4.3 与 v0.2 §11.3 */
  | 'editor:undo'
  | 'editor:redo'
  | 'settings:openPanel';
