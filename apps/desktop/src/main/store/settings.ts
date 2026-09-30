/**
 * `settings.json` 的读写与内存缓存（`09` §3.4 / §5.3）。
 *
 * 位置：`app.getPath('userData')/settings.json`，与 `logs/` 同一个目录。
 *
 * ## 为什么不放 localStorage / sidecar
 *
 * | 方案 | 问题 |
 * |---|---|
 * | `localStorage` | 清缓存即丢；且**主进程读不到** —— 而窗口位置与启动底色必须在建窗口**之前**拿到 |
 * | sidecar | 主题是界面偏好不是作品数据。放 sidecar 意味着"sidecar 挂了主题也没了"，而主题恰好在 sidecar 启动失败时最需要（错误页也要配色） |
 * | 主进程 `userData` 下的 JSON | 两侧都能读；排查问题只去一个目录；sidecar 挂了照样可用 |
 *
 * 这个文件可以放心 import electron（纯逻辑都在 `settings-io.ts`，那边一行 electron 都没有）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { MIN_WINDOW, type Settings, type SettingsPatch, type WindowState } from '@inkstone/shared';
import {
  mergeAiSettings,
  mergeThemeSettings,
  normalizeWindowBounds,
  parseSettings,
  windowStateToDoc,
  type ParsedSettings,
} from './settings-io';
import { writeFileAtomicallySync } from './atomic-write';

type SettingsListener = (settings: Settings) => void;

/** 读一次就够了：设置只在进程内被这一个模块改。 */
let cached: ParsedSettings | null = null;

const listeners = new Set<SettingsListener>();

function log(message: string): void {
  // 只写 stderr：stdout 是 sidecar 的握手通道（`03` §6.1）
  process.stderr.write(`[inkstone] ${message}\n`);
}

export function settingsFilePath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

/**
 * 原子写：先写同目录的临时文件并**刷到介质**，再 `rename` 覆盖（`atomic-write-core.ts`）。
 *
 * 直接 `writeFileSync` 的话，写到一半断电会留下**半个 JSON** —— 而下次启动读它必然失败，
 * 于是用户的所有外观设置与窗口位置一起回到默认。
 *
 * `rename` 之外还要 `fsync`（`docs/13` M16）：只有 rename 的话，掉电后可能得到一个
 * **名字正确、内容为空**的文件 —— 比"写坏"更难查，因为文件看上去是存在的。
 */
function writeDoc(): void {
  if (cached === null) return;
  const file = settingsFilePath();
  try {
    writeFileAtomicallySync(
      { file, tmp: `${file}.tmp`, dir: path.dirname(file) },
      `${JSON.stringify(cached.doc, null, 2)}\n`,
    );
  } catch (err) {
    // 落盘失败不该让调用方崩：设置是偏好，不是数据。下次改设置时会再试一遍。
    log(`settings.json 写入失败：${String(err)}`);
  }
}

/**
 * 取已解析的缓存。`loadSettings()` 是唯一填充它的地方 —— 走到这里还是 `null`
 * 说明调用顺序错了（比如在 `app.whenReady()` 之前就读窗口状态）。
 */
function ensureLoaded(): ParsedSettings {
  if (cached === null) loadSettings();
  if (cached === null) throw new Error('settings 尚未初始化');
  return cached;
}

/**
 * 读设置（首次调用时读盘，之后走缓存）。
 *
 * 损坏 / 版本不认识时的自愈策略见 `parseSettings`；这里额外做两件事：
 * 1. 版本不认识 → 把原文件**改名留档**（不删、不覆盖），再用默认值写一份新的；
 * 2. 有任何修正或文件本来不存在 → 立刻写回，让磁盘上的内容与内存一致。
 *
 * 第 2 条不是洁癖：验收第 10 项要看的就是"手写坏文件 → 启动后被重写为合法内容"。
 */
export function loadSettings(): Settings {
  if (cached !== null) return cached.value;

  const file = settingsFilePath();
  let raw: unknown = null;
  let existed = false;

  try {
    if (fs.existsSync(file)) {
      existed = true;
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch (err) {
    // 坏 JSON / 读不了：**不弹错误**，外观偏好不值得打断用户（§6）
    log(`settings.json 不可用，改用默认值：${String(err)}`);
    raw = null;
  }

  const parsed = parseSettings(raw);
  cached = parsed;

  if (parsed.unsupportedVersion && existed) {
    const backup = `${file}.bak`;
    try {
      fs.renameSync(file, backup);
      log(`settings.json 的 schemaVersion 不认识，已留档为 ${backup}`);
    } catch (err) {
      log(`settings.json 留档失败：${String(err)}`);
    }
    writeDoc();
  } else if (!existed || parsed.repaired) {
    if (parsed.repaired && existed) log('settings.json 有字段缺失或越界，已修正并写回');
    writeDoc();
  }

  return parsed.value;
}

/**
 * 合并外观与 AI 设置（渲染进程是唯一调用方），落盘并广播。返回值是合并后的完整设置。
 *
 * 收敛（`mode` 校验、字号与行距夹紧、供应商与 routing 校验、预算夹紧）都在
 * `settings-io.ts` 里 —— 本文件 import 了 electron，测试环境载不进来，
 * 所以"写路径到底有没有校验"这件事只有放在那边才断言得了。
 * 读路径（`parseSettings`）用的是同一份判断。
 */
export function updateSettings(patch: SettingsPatch): Settings {
  const parsed = ensureLoaded();
  const theme = mergeThemeSettings(parsed.value.theme, patch.theme);
  const ai = mergeAiSettings(parsed.value.ai, patch.ai);

  parsed.value = { ...parsed.value, theme, ai };
  parsed.doc.theme = { ...(parsed.doc.theme as Record<string, unknown>), ...theme };
  // `parsed.doc.ai` 可能是 undefined（v1 老文件）—— `{...undefined}` 是 `{}`，正好。
  parsed.doc.ai = { ...(parsed.doc.ai as Record<string, unknown> | undefined), ...ai };
  writeDoc();
  emit(parsed.value);
  return parsed.value;
}

/**
 * 存窗口状态。**不广播** —— 渲染进程不关心窗口位置，窗口状态也没进 `Settings` 的共享面。
 */
export function saveWindowState(state: WindowState): void {
  const parsed = ensureLoaded();
  const window = normalizeWindowBounds(state, MIN_WINDOW);
  parsed.value = { ...parsed.value, window };
  parsed.doc.window = {
    ...(parsed.doc.window as Record<string, unknown>),
    ...windowStateToDoc(window),
  };
  writeDoc();
}

/** 订阅设置变更（主进程内部用：广播给渲染进程 + 重建菜单的勾选态）。 */
export function subscribeSettings(listener: SettingsListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(settings: Settings): void {
  for (const listener of listeners) listener(settings);
}
