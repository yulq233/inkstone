/**
 * 应用数据目录的路径（单一来源）。
 *
 * 起因：`<userData>/logs` 曾在 `ipc.ts`、`sidecar/env.ts`、`menu.ts` 三处各自手算
 * （`path.join(app.getPath('userData'), 'logs')`）。写成三份的后果不是"多几行"，
 * 而是**口径会漂**：设置页显示的日志目录与菜单打开的目录一旦指向不同位置，
 * 只在排查问题时才暴露，而那时最不该再多一个变量。
 */

import path from 'node:path';
import { app } from 'electron';

/** `app.getPath('userData')`，即 `%APPDATA%/<产品名>`。`settings.json`、`credentials.enc` 都在这一层 */
function userDataPath(): string {
  return app.getPath('userData');
}

/**
 * sidecar 的日志目录（`03` §「日志目录」：`<userData>/logs`）。
 *
 * 注意它**可能尚不存在**：正常情况下 `buildLaunchSpec()` 在拉起 sidecar 时会建。
 * 调用方若要把它交给 `shell.openPath()` 之类的系统接口，需自行确保目录存在 ——
 * 否则 openPath 只返回一段错误字符串，界面上什么都不会发生（菜单那处就是先建再开）。
 */
export function logsDirPath(): string {
  return path.join(userDataPath(), 'logs');
}
