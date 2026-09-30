import { app, dialog, ipcMain, type BrowserWindow } from 'electron';
import type {
  AiCredentialResult,
  AiEgressAckResult,
  AppInfo,
  CredentialStatus,
  DesktopPlatform,
  PickDirectoryResult,
  Settings,
  SidecarConnection,
  SidecarStatus,
} from '@inkstone/shared';
import { PROXY_BYPASS_LIST } from '@inkstone/shared';
import { pushAiConfig } from './ai-config';
import {
  asAiCredentialSetRequest,
  asEgressAckRequest,
  asFlushResult,
  asPickDirectoryRequest,
  asProviderId,
  asSettingsPatch,
} from './ipc-guards';
import { logsDirPath } from './paths';
import { resolveFlushResult } from './quit-guard';
import { InvalidApiKeyError } from './store/credentials-io';
import {
  SecureStorageUnavailableError,
  clearCredential,
  credentialStatusesFor,
  isSecureStorageAvailable,
  loadCredentialStore,
  setCredential,
} from './store/credentials';
import { loadSettings, updateSettings } from './store/settings';
import { withEgressAck } from './store/settings-io';
import type { SidecarSupervisor } from './sidecar/supervisor';

export interface IpcDeps {
  supervisor: SidecarSupervisor;
  getWindow: () => BrowserWindow | null;
}

/**
 * IPC 只承载"系统能力"与 sidecar 生命周期事件。
 * 正文数据一律由渲染进程直连 sidecar 的本地 HTTP —— 少一层转发，也便于 DevTools 调试。
 */
export function registerIpc({ supervisor, getWindow }: IpcDeps): void {
  ipcMain.handle('app:getInfo', (): AppInfo => {
    return {
      version: app.getVersion(),
      // NodeJS.Platform 比我们支持的三个平台更宽（还有 aix / sunos / android 等），
      // 这里按合同收窄。M0 只出 Windows，另两个平台留给后续。
      platform: process.platform as DesktopPlatform,
      userDataPath: app.getPath('userData'),
      logDir: logsDirPath(),
      isPackaged: app.isPackaged,
      proxyBypassList: PROXY_BYPASS_LIST,
    };
  });

  ipcMain.handle('sidecar:getConnection', (): SidecarConnection | null => {
    return supervisor.getConnection();
  });

  ipcMain.handle('sidecar:getStatus', (): SidecarStatus => {
    return supervisor.getStatus();
  });

  // 关窗拦截的答复（06 文档 §7）。这里只做转发：等待中的 resolver 归 quit-guard 管，
  // 因为它是"这次关闭"的状态，不是 IPC 层的能力。
  //
  // ⚠️ 载荷**认不出时按"未落盘"处理**，不能当成功（`docs/13` M15）：
  // 当成成功就等于"用户点一次关闭、静默丢掉最多 3 秒正文"，而那是 A4 明令禁止的。
  // 按未落盘处理会让 quit-guard 弹出确认框 —— 丢字变成需要用户主动点的动作，
  // 而窗口也不会卡住（对话框是有响应的）。
  ipcMain.on('app:flushResult', (_event, result: unknown): void => {
    const parsed = asFlushResult(result);
    if (parsed === null) {
      process.stderr.write('[inkstone] app:flushResult 的载荷不合法，按"未落盘"处理\n');
      resolveFlushResult({ ok: false, reason: '界面回报的保存结果不合法，已按有内容未保存处理。' });
      return;
    }
    resolveFlushResult(parsed);
  });

  // ---- 外观设置（09 文档 §3.6）----
  //
  // 只有两个通道，且**没有"主题专用"的通道**：主题与字号是同一份设置的字段，
  // 各开一条只会让"改主题要不要也改字号"这种问题出现两套答案。
  //
  // `settings:set` 落盘后会触发 index.ts 里的订阅 → 广播 `settings:changed`。
  // 所以渲染进程**不需要**等这个 Promise 的返回值：它已经先改了 CSS（§3.6），
  // 持久化失败不该让切换卡顿。
  ipcMain.handle('settings:get', (): Settings => loadSettings());

  // 补丁过一道运行时收敛（`docs/13` M15）：`null` / 字符串 / 数组一律变成空补丁，
  // 也就是"什么都没改"。界面上的乐观更新已经先落地了，这里悄无声息地不改设置，
  // 比抛一句 `Cannot read properties of null` 让用户对着一个报错框强。
  ipcMain.handle('settings:set', (_event, patch: unknown): Settings => {
    const safePatch = asSettingsPatch(patch);
    if (!safePatch.theme && !safePatch.ai) {
      process.stderr.write('[inkstone] settings:set 的补丁为空或不合法，忽略本次修改\n');
    }
    return updateSettings(safePatch);
  });

  // ---- AI 凭据（`docs/11` §4.4）----
  //
  // 三条通道的分工是**刻意的窄**：渲染进程能问"配了没有"、能写、能删，
  // 但**读不回密钥**（没有 `ai:getCredential`）。唯一的例外是 `ai:setCredential`
  // 的入参 —— 那是用户刚敲进来的东西，它本来就在渲染进程里。
  //
  // 每次写入/删除都**立刻推一次**给 sidecar：sidecar 只在内存里存 Key，
  // 不推的话它会继续用旧 Key（改 Key 后表现为"明明改了还是 401"）。
  ipcMain.handle('ai:getCredentialsStatus', (): CredentialStatus[] => {
    return credentialStatusesFor(loadSettings().ai.providers);
  });

  ipcMain.handle('ai:isSecureStorageAvailable', (): boolean => isSecureStorageAvailable());

  ipcMain.handle('ai:setCredential', async (_event, raw: unknown): Promise<AiCredentialResult> => {
    const req = asAiCredentialSetRequest(raw);
    if (req === null) {
      // 形状不对（不是对象 / 没有 providerId）—— 与"未知供应商"回同一句提示：
      // 对用户来说这是同一件事（界面上的配置与本机不一致）。刻意不新增 `kind`：
      // 它会被渲染进程 switch，加一个值就要两头一起改，而措辞精确不了多少。
      return {
        ok: false,
        kind: 'unknown-provider',
        message: '这条密钥请求没有带供应商标识，请刷新设置页后重试。',
      };
    }

    const settings = loadSettings();
    // 未知供应商：存下去也没人能用它（推送时会按 providers 过滤掉），
    // 明确拒绝比留一条看不见的垃圾记录好。
    if (!settings.ai.providers.some((provider) => provider.id === req.providerId)) {
      return {
        ok: false,
        kind: 'unknown-provider',
        message: `未知的供应商「${req.providerId}」，请刷新设置页后重试。`,
      };
    }

    try {
      setCredential(req.providerId, req.apiKey);
    } catch (err) {
      return describeCredentialFailure(err);
    }

    const outcome = await pushAiConfig(supervisor, {
      settings,
      credentials: loadCredentialStore(),
    });
    if (!outcome.ok) {
      // 密钥**已经存下来了**，只是没送到 sidecar。这不是失败，要说清区别 ——
      // 否则用户会反复重填，而问题其实出在推送那一步。
      return {
        ok: false,
        kind: 'write-failed',
        message: `密钥已保存，但没有送达本地服务（${outcome.reason}）。请稍后重新保存一次，或重启砚台。`,
      };
    }
    return { ok: true, statuses: credentialStatusesFor(settings.ai.providers) };
  });

  ipcMain.handle(
    'ai:clearCredential',
    async (_event, raw: unknown): Promise<AiCredentialResult> => {
      const providerId = asProviderId(raw);
      if (providerId === null) {
        return {
          ok: false,
          kind: 'unknown-provider',
          message: '这条删除请求没有带供应商标识，请刷新设置页后重试。',
        };
      }
      try {
        clearCredential(providerId);
      } catch (err) {
        return describeCredentialFailure(err);
      }
      const settings = loadSettings();
      // 删除也要推：否则 sidecar 内存里还留着刚被删掉的 Key，会继续拿它发请求。
      await pushAiConfig(supervisor, { settings, credentials: loadCredentialStore() });
      return { ok: true, statuses: credentialStatusesFor(settings.ai.providers) };
    },
  );

  /**
   * 记录 / 撤销"已确认可以把内容发往这家"（`docs/11` §2.3）。
   *
   * ## 为什么不是渲染进程自己 `settings:set` 一个数组
   *
   * 那要求渲染进程先读到当前名单，而**读到的副本可能已经过期** —— 一次撤销会把
   * 另一处刚加的确认一起覆盖掉。"加一个 / 去一个"在这里做，就不存在这个问题
   * （`withEgressAck` 的说明里有完整理由）。
   *
   * ## 同步返回，推送由设置广播旁路完成
   *
   * `updateSettings` 会触发 `index.ts` 的 `subscribeSettings` → `pushAiConfigNow(false)`，
   * 而后者按 `ai` 段的**序列化指纹**判要不要推 —— 名单变了指纹必然变，所以侧车一定会被
   * 刷新，这里不必也不该再 `await` 一次推送（那会让一次按钮点击等一个网络往返）。
   *
   * ⚠️ 由此存在一个**极小的窗口**：确认之后的那次推送是异步的，若用户在 1 秒内
   * 又发起一次生成，`/ai/preview` 可能仍报 `needsConfirm` 而再弹一次同样的卡。
   * 它的代价只是"多弹一次"，而拦掉它需要在渲染进程再存一份"本会话已确认" ——
   * 那就成了第二个判据，与"判据只有服务端一处"直接冲突。权衡后选择留着。
   */
  ipcMain.handle('ai:setEgressAck', (_event, raw: unknown): AiEgressAckResult => {
    const req = asEgressAckRequest(raw);
    if (req === null) {
      // 与 `ai:setCredential` 同一句话术：形状不对与"未知供应商"对用户是同一件事
      return {
        ok: false,
        kind: 'unknown-provider',
        message: '这条确认请求没有带供应商标识，请刷新设置页后重试。',
      };
    }

    const settings = loadSettings();
    const next = withEgressAck(settings.ai, req.providerId, req.acknowledged);
    if (next === null) {
      return {
        ok: false,
        kind: 'unknown-provider',
        message: `未知的供应商「${req.providerId}」，请刷新设置页后重试。`,
      };
    }

    try {
      const written = updateSettings({ ai: { acknowledgedEgressProviders: next } });
      return { ok: true, acknowledgedEgressProviders: written.ai.acknowledgedEgressProviders };
    } catch (err) {
      // `updateSettings` 内部已经把落盘失败降级成日志（设置是偏好不是数据），
      // 所以能走到这里的只有"解析/合并本身炸了"这种不该发生的情况。
      // 仍然用返回值而不是抛异常 —— `ipcMain.handle` 抛出去在渲染进程只剩一句
      // "Error invoking remote method …"，用户看不懂也定位不到。
      return { ok: false, kind: 'write-failed', message: `没有保存成功：${String(err)}` };
    }
  });

  ipcMain.handle(
    'dialog:pickDirectory',
    async (_event, raw: unknown): Promise<PickDirectoryResult> => {
      // 默认参数只在实参是 `undefined` 时生效，`null` 会绕过它 → 统一在守卫里收敛成 `{}`
      const req = asPickDirectoryRequest(raw);
      const win = getWindow();
      const result = win
        ? await dialog.showOpenDialog(win, {
            title: req.title ?? '选择目录',
            defaultPath: req.defaultPath,
            properties: ['openDirectory', 'createDirectory'],
          })
        : await dialog.showOpenDialog({
            title: req.title ?? '选择目录',
            defaultPath: req.defaultPath,
            properties: ['openDirectory', 'createDirectory'],
          });
      return { canceled: result.canceled, path: result.filePaths[0] };
    },
  );

  // 仅开发态：用于验证"崩溃 → 自愈"链路，生产包中不存在这个通道
  if (!app.isPackaged) {
    ipcMain.handle('sidecar:devCrash', (): void => {
      supervisor.crashForDiagnostics();
    });
  }
}

/**
 * 把凭据写入/删除过程中的异常翻译成渲染进程能展示的结果。
 *
 * **分三类而不是一句"失败"**：这三件事用户的下一步动作完全不同 ——
 * 密钥形状不对要重贴、系统加密不可用要换环境变量、写盘失败要看磁盘权限。
 * 混成一句话，用户只能反复重试同一件没用的事。
 */
function describeCredentialFailure(err: unknown): Extract<AiCredentialResult, { ok: false }> {
  if (err instanceof SecureStorageUnavailableError) {
    return {
      ok: false,
      kind: 'storage-unavailable',
      message:
        '当前系统没有可用的加密存储（多见于缺少 keyring 的 Linux 环境），砚台不会以明文保存密钥。' +
        '请改用环境变量提供密钥，或在支持系统加密的桌面上使用。',
    };
  }
  if (err instanceof InvalidApiKeyError) {
    return { ok: false, kind: 'invalid-key', message: err.message };
  }
  return { ok: false, kind: 'write-failed', message: `写入密钥失败：${String(err)}` };
}
