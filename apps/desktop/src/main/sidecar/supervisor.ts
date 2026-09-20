import {
  SidecarState,
  type SidecarConnection,
  type SidecarFailureReason,
  type SidecarStatus,
} from '@inkstone/shared';
import { buildLaunchSpec, createToken, type SidecarLaunchSpec } from './env';
import { SidecarLauncher } from './launcher';

const HEALTH_INTERVAL_MS = 5_000;
const HEALTH_TIMEOUT_MS = 2_000;
/** 连续失败多少次才判定死亡。避免慢启动 / GC 抖动误判 */
const HEALTH_FAIL_THRESHOLD = 3;
/** 重启退避：1s → 2s → 4s，共 3 次机会 */
const RESTART_BACKOFF_MS = [1_000, 2_000, 4_000];
/** 就绪后的冷静期，这段时间内不判定不健康 */
const HEALTH_COOLDOWN_MS = 10_000;
const SHUTDOWN_GRACE_MS = 3_000;
const SHUTDOWN_REQUEST_TIMEOUT_MS = 1_000;

export interface SupervisorHandlers {
  onStatus(status: SidecarStatus): void;
}

/**
 * 编排层的关键决策必须有痕迹。
 *
 * 没有这些日志时的真实体验：用户说"应用偶尔重启一下本地服务"，你只能盯著界面猜，
 * 因为状态变化只被广播给了渲染进程、没有落到任何可查的地方。这几行就是为了终结这种猜测。
 */
function log(message: string, extra?: Record<string, unknown>): void {
  const suffix = extra ? ` ${JSON.stringify(extra)}` : '';
  process.stdout.write(`[supervisor] ${message}${suffix}\n`);
}

export class SidecarSupervisor {
  /** token 只生成一次：重启时沿用，所以渲染进程不需要刷新 token，只需要刷新端口 */
  private readonly token = createToken();
  private readonly spec: SidecarLaunchSpec;

  private state: SidecarState = SidecarState.BOOTING;
  private lastStatus: SidecarStatus = { state: SidecarState.BOOTING };
  private launcher: SidecarLauncher | null = null;
  private connection: SidecarConnection | null = null;

  private restartCount = 0;
  private restartPending = false;
  private healthFailures = 0;
  private healthTimer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private cooldownUntil = 0;
  private shuttingDown = false;

  constructor(private readonly handlers: SupervisorHandlers) {
    this.spec = buildLaunchSpec(this.token);
  }

  getStatus(): SidecarStatus {
    return this.lastStatus;
  }

  getConnection(): SidecarConnection | null {
    return this.connection;
  }

  start(): void {
    this.spawnOnce();
  }

  /**
   * 优雅退出：优先走 HTTP `/shutdown` 而不是信号。
   * Windows 上对非 GUI 子进程发信号不可靠，而 taskkill /F 是硬杀、不给清理机会。
   */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    log('开始退出清理');

    this.stopHealthLoop();
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    const launcher = this.launcher;
    const conn = this.connection;
    this.connection = null;
    if (!launcher) return;

    launcher.markIntentional();

    if (conn) {
      try {
        await fetch(`${conn.baseUrl}/api/v1/shutdown`, {
          method: 'POST',
          headers: { 'X-Inkstone-Token': conn.token },
          signal: AbortSignal.timeout(SHUTDOWN_REQUEST_TIMEOUT_MS),
        });
        log('已发出优雅关闭请求');
      } catch {
        /* 已退出或不可达，继续走等待 + 强杀 */
        log('优雅关闭请求未送达，直接进入等待/强杀');
      }
    }

    const exited = await launcher.waitForExit(SHUTDOWN_GRACE_MS);
    if (!exited) {
      log(`等待 ${SHUTDOWN_GRACE_MS}ms 未退出，改为强杀`);
      launcher.hardKill();
    } else {
      log('sidecar 已自行退出');
    }
  }

  /** 开发态诊断用：直接杀掉 sidecar，验证自愈链路 */
  crashForDiagnostics(): void {
    this.launcher?.crashForDiagnostics();
  }

  private spawnOnce(): void {
    this.connection = null;
    this.healthFailures = 0;
    log('正在拉起 sidecar', { command: this.spec.command });
    this.setState(SidecarState.SPAWNING);

    const launcher = new SidecarLauncher(this.spec, {
      onReady: (payload) => {
        if (this.shuttingDown) return;
        this.connection = {
          baseUrl: `http://127.0.0.1:${payload.port}`,
          token: this.token,
        };
        this.restartCount = 0;
        this.cooldownUntil = Date.now() + HEALTH_COOLDOWN_MS;
        log('握手成功', { port: payload.port, pid: payload.pid, version: payload.version });
        this.setState(SidecarState.HEALTHY, {
          port: payload.port,
          sidecarVersion: payload.version,
        });
        this.startHealthLoop();
      },
      onExit: (info) => {
        if (this.shuttingDown || info.intentional) return;
        log('sidecar 进程退出', { code: info.code, signal: info.signal, state: this.state });
        // 就绪前退出的情况由 onFailure 负责报错，这里只处理"健康后突然挂掉"
        if (this.state === SidecarState.HEALTHY) {
          this.scheduleRestart('exited', `sidecar 意外退出（code=${info.code ?? 'null'}）`);
        }
      },
      onFailure: (info) => {
        if (this.shuttingDown) return;
        log('启动阶段失败', { reason: info.reason });
        this.scheduleRestart(info.reason, info.message);
      },
    });

    this.launcher = launcher;
    this.setState(SidecarState.HANDSHAKING);
    launcher.start();
  }

  private scheduleRestart(reason: SidecarFailureReason, message: string): void {
    if (this.shuttingDown || this.restartPending) return;

    if (this.restartCount >= RESTART_BACKOFF_MS.length) {
      log('重启次数耗尽，进入失败态', { restartCount: this.restartCount });
      this.setState(SidecarState.FAILED, {
        reason: 'restart_exhausted',
        message: `${message}\n\n已重试 ${this.restartCount} 次仍未恢复。`,
      });
      return;
    }

    this.restartPending = true;
    this.stopHealthLoop();

    const delay = RESTART_BACKOFF_MS[this.restartCount] ?? 4_000;
    this.restartCount += 1;
    log('计划重启', { reason, delayMs: delay, attempt: this.restartCount });

    this.setState(SidecarState.RESTARTING, {
      reason,
      message,
      restartCount: this.restartCount,
    });

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.restartPending = false;
      if (this.shuttingDown) return;
      this.spawnOnce();
    }, delay);
  }

  private startHealthLoop(): void {
    this.stopHealthLoop();
    this.healthTimer = setInterval(() => {
      void this.healthTick();
    }, HEALTH_INTERVAL_MS);
  }

  private stopHealthLoop(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  private async healthTick(): Promise<void> {
    if (this.shuttingDown || this.state !== SidecarState.HEALTHY) return;
    if (Date.now() < this.cooldownUntil) return;

    if (await this.probeHealth()) {
      this.healthFailures = 0;
      return;
    }

    this.healthFailures += 1;
    log('探活失败', { consecutive: this.healthFailures, of: HEALTH_FAIL_THRESHOLD });
    if (this.healthFailures < HEALTH_FAIL_THRESHOLD) return;

    this.healthFailures = 0;
    this.scheduleRestart('unhealthy', `连续 ${HEALTH_FAIL_THRESHOLD} 次探活失败，判定本地服务无响应`);
    this.launcher?.hardKill();
  }

  private async probeHealth(): Promise<boolean> {
    const conn = this.connection;
    if (!conn) return false;
    try {
      const res = await fetch(`${conn.baseUrl}/api/v1/healthz`, {
        headers: { 'X-Inkstone-Token': conn.token },
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private setState(state: SidecarState, extra: Omit<Partial<SidecarStatus>, 'state'> = {}): void {
    this.state = state;
    this.lastStatus = { state, restartCount: this.restartCount, ...extra };
    this.handlers.onStatus(this.lastStatus);
  }
}
