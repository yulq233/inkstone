/**
 * 进程级异常兜底（`docs/13` M14）。
 *
 * ## 为什么必须有
 *
 * 主进程是**没有"下一层"的那一层**：它的未捕获异常会让进程按 Node 的默认行为
 * 直接结束。而 Electron 主进程结束 = 窗口消失，用户看到的是"应用自己退了"，
 * 既没有提示、也没有日志（生产包的 stderr 没人看得到）。
 * 对一个写作应用来说，还有第二层代价：退出路径没走完，`will-quit` 不触发，
 * **sidecar 会变成孤儿进程**占着端口与 stdio 管道。
 *
 * ## 两类异常的处理**刻意不同**
 *
 * | 类别 | 处理 | 理由 |
 * |---|---|---|
 * | `uncaughtException` | 记录 → `app.quit()` 优雅退出 | 同步抛出的异常意味着代码路径已经崩了，继续跑下去只会二次伤害；而走 quit 能让 `quit-guard` 把那最多 3 秒的未落盘内容救回来 |
 * | `unhandledRejection` | **只记录**，继续运行 | 一条 Promise 被拒绝通常只是"这一个异步动作失败了"（推配置、存窗口位置…），进程状态并没有坏。为它退出应用，等于把一次 HTTP 失败升级成"用户正在写的东西没了"。Node 自己的默认在这里也是 warn |
 *
 * ## 为什么不 `app.exit(1)` 了事
 *
 * `app.exit()` 会跳过 `will-quit`，于是 sidecar 不会被收走 —— 这正是本项目
 * 反复踩过的那一类问题（管道不关 → 退出卡死 / 孤儿进程）。宁可多走一遍关闭流程。
 */

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { formatCrashEntry, type CrashKind } from './crash-report';

/** 崩溃日志的文件名。与 sidecar 的两份日志同目录（`<userData>/logs`）。 */
const CRASH_LOG = 'crash.log';

let installed = false;

/**
 * 是否已经在一个致命异常的处理流程里。
 *
 * 第二次致命异常（常见于"优雅退出那段代码自己又炸了"）**不能再重试一遍**
 * —— 那会变成无限循环，用户看到的是应用永远不退。
 */
let recovering = false;

/** 已记录过的条目（去重）+ 容量上限（`docs/13` 已有一条"只增不减"的同类发现，别再添一条）。 */
const seen = new Set<string>();
const MAX_TRACKED = 200;

/**
 * 装上兜底。**必须在 `app.setPath('userData', …)` 之后调用** ——
 * 否则 `logDir` 会指向 `%APPDATA%\Electron`，排查时就去错地方找日志了。
 */
export function installCrashGuard(logDir: string): void {
  if (installed) return;
  installed = true;

  process.on('uncaughtException', (err) => {
    handle(logDir, 'uncaughtException', err);
  });

  process.on('unhandledRejection', (reason) => {
    handle(logDir, 'unhandledRejection', reason);
  });
}

function handle(logDir: string, kind: CrashKind, thrown: unknown): void {
  const entry = formatCrashEntry(kind, thrown, new Date());

  // 已经记过的同一条不再重复写文件 —— "每次 tick 都失败"会把日志冲淡到没法看；
  // 但终端那一路照旧，它是"正在发生"的通道。
  //
  // `seen` 加容量上限：内容各不相同的拒绝虽然少见，但真有就是一条无界增长。
  // 到上限后不再去重（那一档只在日志已被刷爆时出现，"少写一条"没有意义）。
  const duplicated = seen.has(entry);
  if (seen.size < MAX_TRACKED) seen.add(entry);
  if (duplicated) process.stderr.write(`[inkstone] ${entry}`);
  else writeCrashLog(logDir, entry);

  if (kind === 'unhandledRejection') return;

  if (recovering) {
    process.stderr.write('[inkstone] 退出流程中再次发生致命异常，强制结束进程\n');
    app.exit(1);
    return;
  }
  recovering = true;

  try {
    app.quit();
  } catch (err) {
    // `app.quit()` 自己抛（ready 之前的极端情况）→ 没有更好的办法了，明确地结束。
    process.stderr.write(`[inkstone] 兜底退出失败，强制结束进程：${String(err)}\n`);
    app.exit(1);
  }
}

/**
 * 写一条崩溃记录。
 *
 * **这里的任何失败都不能逃逸**：它运行在 `uncaughtException` 处理器内部，
 * 再抛一次就是 Node 的 abort —— 那会把"有日志可查"变成"什么都没有"。
 */
function writeCrashLog(logDir: string, entry: string): void {
  try {
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, CRASH_LOG), entry, 'utf8');
  } catch {
    /* 写不下就算了，下面还有 stderr 那一份 */
  }
  process.stderr.write(`[inkstone] ${entry}`);
}
