/**
 * IPC 入参的**运行时**校验（`docs/13` M15）。
 *
 * ## 为什么类型注解不够
 *
 * `ipcMain.handle('x', (_e, patch: SettingsPatch) => …)` 里的 `SettingsPatch` 只是
 * 编译期承诺 —— 它对另一头送来的东西没有任何约束力：`undefined`、`null`、
 * 一个字符串、一个被改过的对象都会原样进来。而这一层的代价是**不对称的**：
 *
 * - `settings:set` 收到 `null` → `patch.theme` 抛 TypeError → 渲染进程拿到一句
 *   "Error invoking remote method …"，用户看不懂、我们也定位不到；
 * - `app:flushResult` 收到 `null` → `result.ok` 在 `handleCloseRequest` 里抛 →
 *   那个 async 函数的 rejection 没人接（`void handleCloseRequest(...)`）→
 *   **窗口的 `close` 已经被 preventDefault 过了，于是窗口永远关不掉**；
 * - `dialog:pickDirectory` 的默认值只在实参是 `undefined` 时生效，`null` 会绕过它。
 *
 * ## 口径：**能收敛就收敛，收敛不了才拒**
 *
 * 与 `settings-io.ts` 的读路径同一条思路 —— 外观偏好不值得打断用户，
 * 于是"形状不对"一律退化成"什么都不改"，而不是抛异常。唯一例外是
 * `app:flushResult`：那里默认值意味着**静默丢字**，所以调用方要按"未落盘"处理。
 *
 * 这个文件**不 import electron**：它被单测直接 import，而测试跑在
 * `tsconfig.web.json` 下（没有 node 类型）。
 */

import type {
  AiCredentialSetRequest,
  AiEgressAckRequest,
  FlushResult,
  PickDirectoryRequest,
  SettingsPatch,
} from '@inkstone/shared';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `settings:set` 的补丁。认不出的形状 → 空补丁（合并后就是"什么都没改"）。
 *
 * 只放行 `theme` / `ai` 两个**对象**字段：`SettingsPatch` 之外的东西一律丢掉。
 * 里面的逐字段收敛（mode、字号、行距、供应商、预算）由 `settings-io.ts` 负责 ——
 * 在这里再判一遍只会得到两份会漂移的规则。
 */
export function asSettingsPatch(value: unknown): SettingsPatch {
  if (!isPlainObject(value)) return {};
  const patch: SettingsPatch = {};
  // 这里**刻意不逐字段判类型**：真正把未知数据变成 `ThemeSettings` 的不是这个函数，
  // 而是下游的 `coerceThemeMode` / `clampFontSize` / `parseAiSettings` ——
  // 它们对每个字段逐个判类型并夹范围，认不出的一律退回当前值。
  // 抄两遍一定会漂，`mode` 那条就是这么踩出来的。
  if (isPlainObject(value.theme)) patch.theme = value.theme;
  if (isPlainObject(value.ai)) patch.ai = value.ai;
  return patch;
}

/**
 * `app:flushResult` 的载荷。`null` = **认不出**（调用方要按"未落盘"处理，不能当成功）。
 *
 * `reason` 只要不是字符串就当没给 —— 它是要显示在对话框里的文案，
 * 塞一个对象进去会让 `detail` 变成 `[object Object]`。
 */
export function asFlushResult(value: unknown): FlushResult | null {
  if (!isPlainObject(value)) return null;
  if (typeof value.ok !== 'boolean') return null;
  return typeof value.reason === 'string'
    ? { ok: value.ok, reason: value.reason }
    : { ok: value.ok };
}

/**
 * `ai:setCredential` 的入参。`null` = 连供应商标识都没有，调用方按"未知供应商"回。
 *
 * `apiKey` 非字符串时**不在这里拒**，而是压成空串交给 `normalizeApiKey`：那边本来就会
 * 回一条 `invalid-key`（"请重新复制粘贴一次"），在这里另造一句只会让同一个问题有两套说法。
 */
export function asAiCredentialSetRequest(value: unknown): AiCredentialSetRequest | null {
  if (!isPlainObject(value)) return null;
  const { providerId, apiKey } = value;
  if (typeof providerId !== 'string' || providerId === '') return null;
  return { providerId, apiKey: typeof apiKey === 'string' ? apiKey : '' };
}

/** `ai:clearCredential` 的入参。`null` = 形状不对。 */
export function asProviderId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * `ai:setEgressAck` 的入参。`null` = 形状不对。
 *
 * ⚠️ `acknowledged` **必须是真布尔**，非布尔一律拒（与 `ai:setCredential` 把坏 `apiKey`
 * 压成空串的做法**相反**）。理由是失效方向不同：`apiKey` 压成空串只会得到一句
 * "请重新复制粘贴"，而把 `acknowledged` 兜成 `true` 等于**替用户确认了一次外发** ——
 * 那是一道隐私闸门被一次形状错误悄悄打开，属于 fail-open。
 * 宁可回一句"请刷新设置页后重试"。
 */
export function asEgressAckRequest(value: unknown): AiEgressAckRequest | null {
  if (!isPlainObject(value)) return null;
  const { providerId, acknowledged } = value;
  const id = asProviderId(providerId);
  if (id === null) return null;
  if (typeof acknowledged !== 'boolean') return null;
  return { providerId: id, acknowledged };
}

/**
 * `dialog:pickDirectory` 的入参。缺省/坏形状 → `{}`。
 *
 * 两个字段都必须是字符串：它们会被直接交给 `dialog.showOpenDialog`，
 * 非字符串在那里是抛错而不是被忽略。
 */
export function asPickDirectoryRequest(value: unknown): PickDirectoryRequest {
  if (!isPlainObject(value)) return {};
  const req: PickDirectoryRequest = {};
  if (typeof value.title === 'string') req.title = value.title;
  if (typeof value.defaultPath === 'string') req.defaultPath = value.defaultPath;
  return req;
}
