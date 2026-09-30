import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { SidecarReadyPayload } from '@inkstone/shared';
import { redactSecrets } from '../redact';
import { SidecarEnvError, assertLaunchSpecUsable, type SidecarLaunchSpec } from './env';

/** 就绪行前缀，必须与 sidecar 的 __main__.py 保持一致 */
const READY_PREFIX = 'INKSTONE_READY ';
/** 支持的握手协议版本 */
const SUPPORTED_PROTOCOL = 1;
const HANDSHAKE_TIMEOUT_MS = 15_000;
/** 内存里保留的最近日志行数，失败时回传给 UI */
const TAIL_LINES = 200;

export interface LauncherHandlers {
  onReady(payload: SidecarReadyPayload): void;
  onExit(info: { code: number | null; signal: NodeJS.Signals | null; intentional: boolean }): void;
  onFailure(info: { reason: 'handshake_timeout' | 'spawn_error'; message: string }): void;
}

export class SidecarLauncher {
  private child: ChildProcessWithoutNullStreams | null = null;
  private intentional = false;
  private settled = false;
  private readyPayload: SidecarReadyPayload | null = null;
  private stdoutBuf = '';
  /** `writeLog` 的行缓冲 —— 见那里"为什么不能逐块擦"的注释。 */
  private logBuffer = '';
  private tail: string[] = [];
  private handshakeTimer: NodeJS.Timeout | null = null;
  private logStream: fs.WriteStream | null = null;
  private exitResolvers: Array<() => void> = [];

  constructor(
    private readonly spec: SidecarLaunchSpec,
    private readonly handlers: LauncherHandlers,
  ) {}

  get ready(): SidecarReadyPayload | null {
    return this.readyPayload;
  }

  /**
   * 优先返回握手报文里的 pid —— 那才是真正跑服务的进程。
   * `spawn()` 返回的可能是包装进程（Windows venv 下确实如此，见 hardKill 的注释）。
   */
  get pid(): number | null {
    return this.readyPayload?.pid ?? this.child?.pid ?? null;
  }

  start(): void {
    try {
      assertLaunchSpecUsable(this.spec);
    } catch (err) {
      const message = err instanceof SidecarEnvError ? err.message : String(err);
      this.handlers.onFailure({ reason: 'spawn_error', message });
      return;
    }

    this.openLogStream();

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.spec.command, this.spec.args, {
        cwd: this.spec.cwd,
        env: this.spec.env,
        // stdin 必须是管道：sidecar 靠它检测父进程死亡（EOF）
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      this.handlers.onFailure({ reason: 'spawn_error', message: String(err) });
      return;
    }

    this.child = child;

    child.on('error', (err) => {
      this.fail('spawn_error', `无法启动 sidecar 进程：${err.message}`);
    });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.consumeStdout(chunk));

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => this.writeLog(chunk));

    child.on('exit', (code, signal) => {
      this.clearHandshakeTimer();
      this.closeLogStream();
      const intentional = this.intentional;
      const wasReady = this.settled;
      const resolvers = this.exitResolvers.splice(0);
      for (const r of resolvers) r();
      if (!wasReady && !intentional) {
        this.handlers.onFailure({
          reason: 'spawn_error',
          message: `sidecar 在就绪前退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}）\n\n${this.tailText()}`,
        });
      }
      this.handlers.onExit({ code, signal, intentional });
    });

    this.handshakeTimer = setTimeout(() => {
      this.fail(
        'handshake_timeout',
        `等待 sidecar 就绪超时（${HANDSHAKE_TIMEOUT_MS / 1000}s）。\n\n最近输出：\n${this.tailText()}`,
      );
      this.hardKill();
    }, HANDSHAKE_TIMEOUT_MS);
  }

  /** 等待进程退出，用于退出清理时的优雅等待 */
  waitForExit(timeoutMs: number): Promise<boolean> {
    if (!this.child || this.child.exitCode !== null) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.exitResolvers.indexOf(onExit);
        if (idx >= 0) this.exitResolvers.splice(idx, 1);
        resolve(false);
      }, timeoutMs);
      const onExit = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      this.exitResolvers.push(onExit);
    });
  }

  /**
   * 硬杀。
   *
   * 两个 pid 都要杀，这不是保险起见，而是必需：
   *
   * - `payload.pid`：真正跑服务、持有监听 socket 的进程。Windows 上 venv 的
   *   `python.exe` 是一层 redirector **包装进程**，它会再拉起真正的解释器，
   *   于是"spawn 返回的 pid" 和 "Python 自报的 pid" 是两个不同的进程
   *   （实测：spawn=31380，os.getpid()=9868，且 31380 正是 9868 的父进程）。
   * - `child.pid`：我们直接持有的那个子进程，也就是上面那层包装。
   *
   * 只杀其中一个都可能留下另一半占着 stdio 管道 —— 而管道不关，
   * `child.on('exit')` 就永远不触发，退出流程会直接卡死在这里。
   * 包装进程通常会在子进程退出后自行退出，但那是"通常"，不是保证。
   */
  hardKill(): void {
    const pids = new Set<number>();
    // 这里再挡一层看似与 `maybeReady` 的校验重复，但这条路径的代价是**孤儿进程**，
    // 而 `taskkill /PID undefined` 是静默无操作 —— 多一次类型判断非常划算。
    const readyPid = this.readyPayload?.pid;
    if (typeof readyPid === 'number' && Number.isInteger(readyPid) && readyPid > 0) {
      pids.add(readyPid);
    }
    const childPid = this.child?.pid;
    if (typeof childPid === 'number' && childPid > 0) pids.add(childPid);
    for (const pid of pids) this.killTree(pid);
  }

  /** Windows 必须 taskkill /T 才能带走子进程树；SIGKILL 只杀一个进程。 */
  private killTree(pid: number): void {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    } else {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* 已退出 */
      }
    }
  }

  /**
   * 标记为"主动退出"，随后停止或杀进程都不会触发重启。
   * 恢复时需重新 new 一个 launcher。
   */
  markIntentional(): void {
    this.intentional = true;
  }

  /** 测试/诊断用：不做标记直接杀，走异常退出路径 */
  crashForDiagnostics(): void {
    this.hardKill();
  }

  private consumeStdout(chunk: string): void {
    this.writeLog(chunk);
    this.stdoutBuf += chunk;
    let idx = this.stdoutBuf.indexOf('\n');
    while (idx >= 0) {
      const line = this.stdoutBuf.slice(0, idx).replace(/\r$/, '');
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      this.maybeReady(line);
      idx = this.stdoutBuf.indexOf('\n');
    }
  }

  private maybeReady(line: string): void {
    if (this.settled || !line.startsWith(READY_PREFIX)) return;
    const raw = line.slice(READY_PREFIX.length).trim();
    let payload: SidecarReadyPayload;
    try {
      payload = JSON.parse(raw) as SidecarReadyPayload;
    } catch {
      this.fail('spawn_error', `就绪行不是合法 JSON：${raw}`);
      return;
    }
    if (payload.v !== SUPPORTED_PROTOCOL) {
      this.fail(
        'spawn_error',
        `握手协议版本不匹配：sidecar=${payload.v}，应用=${SUPPORTED_PROTOCOL}`,
      );
      return;
    }
    if (!Number.isInteger(payload.port) || payload.port <= 0) {
      this.fail('spawn_error', `就绪行端口非法：${String(payload.port)}`);
      return;
    }
    /**
     * `pid` 必须与 `port` 一起校验（`docs/13` M15）。
     *
     * 它是 `hardKill()` 强杀的依据，而 `taskkill /PID undefined /T /F` **不报错** ——
     * 它只是什么都不做。于是握手"成功"、功能全可用，退出时却留下一个**孤儿 sidecar**
     * 占着端口与 stdio 管道（管道不关，`child.on('exit')` 也不触发，退出流程会卡住）。
     * 在这里拦下比事后去用户机器上查进程树便宜得多。
     */
    if (!Number.isInteger(payload.pid) || payload.pid <= 0) {
      this.fail('spawn_error', `就绪行进程号非法：${String(payload.pid)}`);
      return;
    }
    this.settled = true;
    this.readyPayload = payload;
    this.clearHandshakeTimer();
    this.handlers.onReady(payload);
  }

  private fail(reason: 'handshake_timeout' | 'spawn_error', message: string): void {
    if (this.settled) return;
    this.settled = true;
    this.clearHandshakeTimer();
    this.handlers.onFailure({ reason, message });
  }

  private openLogStream(): void {
    try {
      const file = path.join(this.spec.logDir, 'sidecar-stdio.log');
      this.logStream = fs.createWriteStream(file, { flags: 'a', encoding: 'utf8' });
    } catch {
      this.logStream = null;
    }
  }

  private closeLogStream(): void {
    // 先把缓冲里那半行吐出去 —— 否则"最后一行没带换行"的收尾输出会永远留在内存里。
    this.flushLogBuffer();
    this.logStream?.end();
    this.logStream = null;
  }

  /**
   * 写 sidecar 的 stdout / stderr（`docs/13` M11）。
   *
   * ## 为什么这里也必须脱敏
   *
   * 这条出口写的是 `<userData>/logs/sidecar-stdio.log`，**和 sidecar 自己那份日志
   * 是两个文件** —— 后者经过它自己的 `redact()` / `scrub()`，这一份此前完全没有。
   * 不能让"对面已经脱敏了"成为唯一防线：A9 验收项查的正是主进程的日志目录，
   * 而在主进程眼里 sidecar 的输出就是一段**不可信文本**（它与上游 HTTP 打交道，
   * 报错里带出请求头是常事）。
   *
   * ## 为什么要攒成整行再擦，而不是逐块擦
   *
   * 管道 chunk 的边界**与行边界无关**：一个 `sk-abcdef123456` 完全可能被切成
   * `sk-abc` + `def123456` 两块，逐块做时两块都不匹配任何形态，于是照样落盘。
   * 所以先按 `\n` 攒成完整行，再对整行擦。
   */
  private writeLog(chunk: string): void {
    this.logBuffer += chunk;
    const lines = this.logBuffer.split('\n');
    // 最后一段可能是半行（还没等到换行），留着与下一个 chunk 拼。
    this.logBuffer = lines.pop() ?? '';
    for (const line of lines) this.emitLogLine(line);
  }

  /** 缓冲里剩下的半行 —— 只在收尾时当一整行处理。 */
  private flushLogBuffer(): void {
    if (this.logBuffer.length === 0) return;
    const rest = this.logBuffer;
    this.logBuffer = '';
    this.emitLogLine(rest);
  }

  /**
   * 单行的三条出口（日志文件 / 开发态终端 / 内存 tail）。
   *
   * **脱敏只在这一处做**：三条出口共享同一个已擦过的字符串，
   * 不存在"某一条忘了擦"的可能 —— 那正是这个函数被拆出来的原因。
   */
  private emitLogLine(rawLine: string): void {
    const line = redactSecrets(rawLine);
    this.logStream?.write(`${line}\n`);
    if (line.trim().length === 0) return;
    // 开发态回显到终端，日志与 Electron 主进程输出混在一处，便于边写边看。
    // 生产态不回显（没有终端），只进日志文件。
    if (this.spec.devEcho) process.stdout.write(`[sidecar] ${line}\n`);
    this.tail.push(line);
    if (this.tail.length > TAIL_LINES) {
      this.tail.splice(0, this.tail.length - TAIL_LINES);
    }
  }

  private tailText(): string {
    return this.tail.slice(-50).join('\n');
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
  }
}
