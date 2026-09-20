import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

/** sidecar 的 Python 模块名（`python -m inkstone`） */
const SIDECAR_MODULE = 'inkstone';

export interface SidecarLaunchSpec {
  /** 一次性令牌。由主进程生成，经环境变量注入，不落盘、不进日志 */
  token: string;
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  logDir: string;
  /**
   * 开发态把 sidecar 的输出同时回显到主进程终端。
   * 生产态为 false —— 打包后没有终端，输出只进日志文件。
   */
  devEcho: boolean;
}

export class SidecarEnvError extends Error {}

export function createToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * 开发态下 app.getAppPath() 指向 <repo>/apps/desktop，
 * 因此仓库根目录是它的上两级。
 */
function resolveRepoRoot(): string {
  return path.resolve(app.getAppPath(), '..', '..');
}

export function resolveSidecarDir(): string {
  return path.join(resolveRepoRoot(), 'services', 'sidecar');
}

export function resolveVenvPython(sidecarDir = resolveSidecarDir()): string {
  return process.platform === 'win32'
    ? path.join(sidecarDir, '.venv', 'Scripts', 'python.exe')
    : path.join(sidecarDir, '.venv', 'bin', 'python');
}

export function buildLaunchSpec(token: string): SidecarLaunchSpec {
  const logDir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(logDir, { recursive: true });

  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    INKSTONE_TOKEN: token,
    INKSTONE_HOME: app.getPath('userData'),
    INKSTONE_LOG_DIR: logDir,
    INKSTONE_PARENT_PID: String(process.pid),
    // 关键：不缓冲 stdout。否则 INKSTONE_READY 就绪行会卡在 Python 缓冲区里，
    // 主进程一直等不到握手，15 秒后超时——而且看起来像"随机启动失败"。
    PYTHONUNBUFFERED: '1',
    PYTHONUTF8: '1',
    PYTHONDONTWRITEBYTECODE: '1',
  };

  if (app.isPackaged) {
    const dir = path.join(process.resourcesPath, 'sidecar');
    return {
      token,
      command: path.join(dir, process.platform === 'win32' ? 'inkstone.exe' : 'inkstone'),
      args: [],
      cwd: dir,
      env: baseEnv,
      logDir,
      devEcho: false,
    };
  }

  const sidecarDir = resolveSidecarDir();
  return {
    token,
    command: resolveVenvPython(sidecarDir),
    args: ['-m', SIDECAR_MODULE],
    cwd: sidecarDir,
    env: { ...baseEnv, PYTHONPATH: path.join(sidecarDir, 'src') },
    logDir,
    // 开发态把 sidecar 日志并到主进程终端：A1 要求"一条命令，日志合并到一处"。
    devEcho: true,
  };
}

/** 开发态前置检查，把"看不懂的失败"变成一句能照做的提示 */
export function assertLaunchSpecUsable(spec: SidecarLaunchSpec): void {
  if (app.isPackaged) return;
  if (!fs.existsSync(spec.command)) {
    throw new SidecarEnvError(
      `未找到 sidecar 的 Python 虚拟环境：\n${spec.command}\n\n请先在仓库根目录执行：pnpm sidecar:setup`,
    );
  }
}
