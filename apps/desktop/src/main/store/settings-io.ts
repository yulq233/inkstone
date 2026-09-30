/**
 * `settings.json` 的**纯逻辑**：解析自愈、窗口尺寸纠正、越界判定（`09` §3.4 / §5.2 / §6）。
 *
 * ## 为什么单独一个文件、且一行 electron 都不 import
 *
 * 主进程的模块只要 import 了 `electron`，vitest（node 环境）就载不进来，逻辑一行都测不到。
 * 而这里正是"写错了会让人**看不见窗口**"的那部分 —— 必须能被断言。
 * 所以：**IO 在 `settings.ts`，判断在这个文件**。
 */

import {
  AI_TASKS,
  DEFAULT_AI_SETTINGS,
  DEFAULT_SETTINGS,
  MIN_WINDOW,
  SETTINGS_SCHEMA_VERSION,
  SUPPORTED_SETTINGS_VERSIONS,
  THEME_MODES,
  clampDailyBudget,
  clampFontSize,
  clampLineHeight,
  isProviderKind,
  isValidBaseUrl,
  isValidProviderId,
  normalizeBaseUrl,
  normalizeModelName,
  themeToDataTheme as themeToDataThemeShared,
  type AiRouteTarget,
  type AiRouting,
  type AiSettings,
  type ProviderConfig,
  type Settings,
  type ThemeMode,
  type ThemeSettings,
  type WindowState,
} from '@inkstone/shared';

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 显示器工作区。与 `Bounds` 同形，单独命名是为了让调用点读起来知道自己在传什么。 */
export type WorkArea = Bounds;

/**
 * 窗口位置与尺寸。`x` / `y` 可空 —— `ensureOnScreen` 判出越界时把它们清掉，
 * 让 Electron 走"系统居中"。用 `0` 代替"没记住"是不行的：`0` 是合法坐标。
 */
export interface PlacedBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

export interface ParsedSettings {
  /** 规范化之后的已知字段（会被渲染进程与窗口创建读到） */
  value: Settings;
  /**
   * 落盘时应该写回的内容：`value` **加上原文件里的未知字段**。
   *
   * 「未知字段保留」是 `03` §4.2 三条原则之一：新版本写进去的字段，旧版本读过一轮
   * 不能把它抹掉 —— 否则用户降级一次就把配置清空了。
   */
  doc: Record<string, unknown>;
  /** 内容有问题（坏 JSON、字段缺失、值越界），已修正 */
  repaired: boolean;
  /** `schemaVersion` 不认识。调用方应把原文件改名留档，再用默认值启动（§6） */
  unsupportedVersion: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 取 `source` 里所有不在 `known` 中的键 —— 「未知字段保留」就靠它。 */
function pickExtras(
  source: Record<string, unknown>,
  known: readonly string[],
): Record<string, unknown> {
  const extras: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    if (!known.includes(key)) extras[key] = source[key];
  }
  return extras;
}

const TOP_KEYS = ['schemaVersion', 'theme', 'window', 'ai'] as const;
const THEME_KEYS = ['mode', 'fontSize', 'lineHeight'] as const;
const WINDOW_KEYS = ['x', 'y', 'width', 'height', 'maximized'] as const;
const AI_KEYS = [
  'providers',
  'defaultProviderId',
  'defaultModel',
  'routing',
  'dailyBudgetCny',
  'offlineOnly',
  'confirmContextPreview',
  'acknowledgedEgressProviders',
  'styleCard',
  'markAiDraft',
] as const;

/**
 * 把任意输入收敛成合法的主题模式。
 *
 * **文件读路径与 IPC 写路径共用这一份判断** —— 写路径原来直接信任 `SettingsPatch`，
 * 而类型只是编译期承诺：IPC 上来的数据没有运行时保证。放进去一个认不出的模式，
 * 轻则面板三个单选框全不选中，重则 `nativeTheme.themeSource = '…'` 这一句在
 * 广播订阅里抛出去，把"广播给渲染进程"和"重建菜单"一起跳过。
 */
export function coerceThemeMode(
  value: unknown,
  fallback: ThemeMode = DEFAULT_SETTINGS.theme.mode,
): ThemeMode {
  if (typeof value === 'string' && (THEME_MODES as readonly string[]).includes(value)) {
    return value as ThemeMode;
  }
  // 认不出的模式退回给定兜底：默认是 `system` —— 唯一"不会替用户做决定"的选项。
  return fallback;
}

function parseThemeMode(value: unknown): { mode: ThemeMode; repaired: boolean } {
  const mode = coerceThemeMode(value);
  return { mode, repaired: value !== undefined && mode !== value };
}

/**
 * 把外观补丁合并进当前设置。
 *
 * 抽成纯函数有两个理由：① `settings.ts` import 了 electron，测试环境载不进来，
 * 于是"写路径有没有校验"这件事**只有放在这里才断言得了**；② 三处收敛
 * （mode 收敛、字号夹紧、行距夹紧）写在一起，比散在 IO 函数里更难漏。
 */
export function mergeThemeSettings(
  current: ThemeSettings,
  patch: Partial<ThemeSettings> | undefined,
): ThemeSettings {
  const incoming = patch ?? {};
  return {
    mode: coerceThemeMode(incoming.mode ?? current.mode, current.mode),
    fontSize: clampFontSize(incoming.fontSize ?? current.fontSize),
    lineHeight: clampLineHeight(incoming.lineHeight ?? current.lineHeight),
  };
}

function parseFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

// ---------------------------------------------------------------------------
// AI 段（`docs/11` P0）
// ---------------------------------------------------------------------------

/** 供内部标记"这里发生了修正"。对象包一层是为了能跨函数传递可变标志。 */
interface RepairFlag {
  value: boolean;
}

/**
 * 供应商条目 → 合法配置，或 `null`（丢弃）。
 *
 * **为什么是"丢弃"而不是"补默认值"**：`kind` 认不出的供应商无法发起请求，
 * 而补成 `openai-compatible` 会让它带着错误的协议去打真实接口 ——
 * 那时报出来的是 404/400，与真实原因（配置坏了）毫无关系。
 * 丢掉它，界面上少一行；用户重新加一次，比读一个假错误快得多。
 */
function parseProvider(value: unknown): ProviderConfig | null {
  if (!isPlainObject(value)) return null;
  if (!isValidProviderId(value.id)) return null;
  if (!isProviderKind(value.kind)) return null;
  if (!isValidBaseUrl(value.baseUrl)) return null;
  const label =
    typeof value.label === 'string' && value.label.trim() !== '' ? value.label.trim() : value.id;
  return {
    id: value.id,
    kind: value.kind,
    label,
    baseUrl: normalizeBaseUrl(value.baseUrl),
    // `local` 只认显式的 true。这是**安全**属性：缺失时按"会外传"处理，
    // 反过来（缺失时当本机）会让一个云端供应商绕过隐私文案与外发审计。
    local: value.local === true,
    // `needsKey` 反过来：默认**需要**。缺失时按"要 Key"处理，界面上多一个输入框；
    // 少一个输入框的后果是"配置好了却发不出去，且没有任何地方可填"。
    needsKey: value.needsKey !== false,
  };
}

function parseProviders(raw: unknown, flag: RepairFlag): ProviderConfig[] {
  if (!Array.isArray(raw)) {
    flag.value = true;
    return freshPresetProviders();
  }
  const seen = new Set<string>();
  const out: ProviderConfig[] = [];
  for (const item of raw) {
    const provider = parseProvider(item);
    if (provider === null || seen.has(provider.id)) {
      flag.value = true;
      continue;
    }
    seen.add(provider.id);
    out.push(provider);
  }
  // 一个都不剩（老文件、或被手改坏）→ 回到预设。
  // 不这么做的话界面是一张空列表，而用户没有任何入口把它变回来。
  if (out.length === 0) {
    flag.value = true;
    return freshPresetProviders();
  }
  return out;
}

/** 预设的**深一层拷贝**：`providers` 是对象数组，浅拷贝会让两个设置共享同一个条目对象。 */
function freshPresetProviders(): ProviderConfig[] {
  return DEFAULT_AI_SETTINGS.providers.map((preset) => ({ ...preset }));
}

function parseRouteTarget(value: unknown, providerIds: ReadonlySet<string>): AiRouteTarget | null {
  if (!isPlainObject(value)) return null;
  const { providerId, model } = value;
  // 指向一个已经不存在的供应商 → 视为未配置。留着它只会让生成时抛
  // `AI_NOT_CONFIGURED`，而界面上那一行看起来是"已配好"的。
  if (typeof providerId !== 'string' || !providerIds.has(providerId)) return null;
  if (typeof model !== 'string' || model.trim() === '') return null;
  return { providerId, model: model.trim() };
}

function parseRouting(raw: unknown, providerIds: ReadonlySet<string>, flag: RepairFlag): AiRouting {
  const source = isPlainObject(raw) ? raw : {};
  const out = {} as AiRouting;
  for (const task of AI_TASKS) {
    const original = source[task];
    const target = parseRouteTarget(original, providerIds);
    // 只有"本来写了东西但写坏了"才算修正；`null` / 缺失都是正常的"未配置"
    if (target === null && original !== undefined && original !== null) flag.value = true;
    out[task] = target;
  }
  return out;
}

function pickBoolean(
  source: Record<string, unknown>,
  key: string,
  fallback: boolean,
  flag: RepairFlag,
): boolean {
  const value = source[key];
  if (typeof value === 'boolean') return value;
  if (value !== undefined) flag.value = true;
  return fallback;
}

/**
 * 解析「已确认可以把内容发往这家」的供应商名单（`docs/11` §2.3）。
 *
 * 两条收敛规则，都不是"洁癖"：
 *
 * 1. **只保留当前存在的 providerId** —— 与 sidecar 的 `AiState.apply()` 同一判据
 *    （两边都做是刻意的：这里是"落盘的那一份"，那边是"运行时判断用的那一份"）。
 *    删掉一家之后重建同名 id（比如把改坏的自定义端点改回 `deepseek`），
 *    留着旧记录会让**用户从没看过的一个新地址**被当成"已确认过"。
 * 2. **去重、丢掉非字符串项**。
 *
 * ⚠️ 与 `defaultModel` 同款处理：**不标 `repaired`**。丢掉的只是名单里的一行垃圾，
 * 不影响任何行为；标成"有问题"会让每个含垃圾项的文件每次启动都白写一次盘。
 * 规范化后的数组仍然会进 `doc`，所以下一次写入时它自然被清掉。
 */
function parseEgressAcks(raw: unknown, providerIds: ReadonlySet<string>): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    if (!providerIds.has(item) || out.includes(item)) continue;
    out.push(item);
  }
  return out;
}

/**
 * 解析 `settings.json` 的 `ai` 段。**永不抛异常**，任何输入都有合法输出。
 *
 * 读路径（`parseSettings`）与写路径（`mergeAiSettings`）共用这一份 ——
 * 与 `coerceThemeMode` 相同的理由：IPC 上来的数据没有运行时保证。
 */
export function parseAiSettings(raw: unknown): { ai: AiSettings; repaired: boolean } {
  const flag: RepairFlag = { value: false };
  const source = isPlainObject(raw) ? raw : {};
  if (raw !== undefined && !isPlainObject(raw)) flag.value = true;

  const providers = parseProviders(source.providers, flag);
  const providerIds = new Set(providers.map((provider) => provider.id));

  const rawDefault = source.defaultProviderId;
  const defaultProviderId =
    typeof rawDefault === 'string' && providerIds.has(rawDefault) ? rawDefault : null;
  if (defaultProviderId === null && rawDefault !== undefined && rawDefault !== null)
    flag.value = true;

  const routing = parseRouting(source.routing, providerIds, flag);

  const dailyBudgetCny = clampDailyBudget(source.dailyBudgetCny);
  if (dailyBudgetCny !== source.dailyBudgetCny && source.dailyBudgetCny !== undefined) {
    flag.value = true;
  }

  const rawStyleCard = source.styleCard;
  const styleCard = typeof rawStyleCard === 'string' ? rawStyleCard : '';
  if (rawStyleCard !== undefined && typeof rawStyleCard !== 'string') flag.value = true;

  // 缺 `defaultModel` **不算修正**：它只是"还没选模型"，而 `parseAiSettings` 每次都会
  // 把它补成 ''，所以内存里的值总是完整的。标成修正只会让每个老文件都白写一次盘。
  //
  // ⚠️ **空串同样不算修正** —— 它是 `DEFAULT_AI_SETTINGS.defaultModel` 本身。
  // 第一版把"存在但不是合法模型名"一律标成修正，于是每个刚生成出来的 `settings.json`
  // 一启动就被判"有问题"并重写一遍（测试里那条"完整合法文件不标记修正"就是这么挂的）。
  // 只有**非空但写坏了**（带空格、超长、类型不对）才算真修正。
  const rawModel = source.defaultModel;
  const defaultModel = normalizeModelName(rawModel) ?? '';
  const rawModelFilled = typeof rawModel === 'string' && rawModel.trim() !== '';
  if (
    rawModel !== undefined &&
    (typeof rawModel !== 'string' || (rawModelFilled && defaultModel === ''))
  ) {
    flag.value = true;
  }

  return {
    ai: {
      providers,
      defaultProviderId,
      defaultModel,
      routing,
      dailyBudgetCny,
      offlineOnly: pickBoolean(source, 'offlineOnly', DEFAULT_AI_SETTINGS.offlineOnly, flag),
      confirmContextPreview: pickBoolean(
        source,
        'confirmContextPreview',
        DEFAULT_AI_SETTINGS.confirmContextPreview,
        flag,
      ),
      acknowledgedEgressProviders: parseEgressAcks(source.acknowledgedEgressProviders, providerIds),
      markAiDraft: pickBoolean(source, 'markAiDraft', DEFAULT_AI_SETTINGS.markAiDraft, flag),
      styleCard,
    },
    repaired: flag.value,
  };
}

/**
 * 合并 AI 补丁（渲染进程是唯一调用方）。
 *
 * 实现上**不复用"逐字段 merge"**，而是把合并结果整体再过一遍 `parseAiSettings` ——
 * 逐字段 merge 意味着校验逻辑写两遍，而两遍一定会漂移（`mode` 那条就是这么踩出来的）。
 */
export function mergeAiSettings(
  current: AiSettings,
  patch: Partial<AiSettings> | undefined,
): AiSettings {
  return parseAiSettings({ ...current, ...(patch ?? {}) }).ai;
}

/**
 * 记录 / 撤销"已确认可以把内容发往这家"（`docs/11` §2.3）。
 *
 * 返回新的名单；**`null` = 这个供应商不存在**（调用方回一句"请刷新设置页后重试"）。
 *
 * ## 为什么要有这个函数，而不是让渲染进程算好整个数组
 *
 * 渲染进程要算数组就得先读到它，而**读到的副本可能已经过期**（设置面板开着时
 * 主进程改了、或将来出现第二个窗口）。那样一次撤销会把另一处的确认一起覆盖掉。
 * 这里把"加一个 / 去一个"做成**在同一份当前值上**的操作，就不存在覆盖别人改动的问题。
 *
 * 顺带保住了一条性质：**新加的 id 也必须真的存在**。放进一个不存在的 id
 * 会给用户一个"确认成功了"的假象，而下次生成照样弹卡（`parseEgressAcks` 会把它丢掉）。
 */
export function withEgressAck(
  current: AiSettings,
  providerId: string,
  acknowledged: boolean,
): string[] | null {
  if (!current.providers.some((provider) => provider.id === providerId)) return null;
  const rest = current.acknowledgedEgressProviders.filter((id) => id !== providerId);
  // 追加到末尾而不是头部：顺序只影响设置页清单的显示顺序，
  // 而"最近确认的排最后"读起来比"排最前"更自然（与用户的操作顺序一致）。
  return acknowledged ? [...rest, providerId] : rest;
}

/** 全默认的写回文档。显式构造而不是 `structuredClone(DEFAULT_SETTINGS)`，免得来回 cast。 */
function defaultDoc(): Record<string, unknown> {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    theme: { ...DEFAULT_SETTINGS.theme },
    window: { ...DEFAULT_SETTINGS.window },
    ai: { ...DEFAULT_AI_SETTINGS, providers: freshPresetProviders() },
  };
}

/**
 * 解析 `settings.json` 的内容。**永不抛异常** —— 外观偏好不值得打断用户（§6）。
 *
 * 四种输入分别对应四种结果：
 * | 输入 | 结果 |
 * |---|---|
 * | 坏 JSON / 非对象 | 全默认，`repaired = true` |
 * | `schemaVersion` 不在 `SUPPORTED_SETTINGS_VERSIONS` 里 | 全默认 + `unsupportedVersion = true`（调用方留档原文件） |
 * | v1 老文件（缺 `ai` 段） | **就地补默认值**，`repaired = true`（触发写回，于是升到 v2） |
 * | 正常对象 | 逐字段取值，缺的补默认、越界的夹回范围 |
 *
 * ⚠️ v1 必须**接受**而不是"不认识"：把 v1 当成未知版本会让用户升一次应用
 * 就丢掉主题与窗口位置 —— 而这两项恰好是"丢了会被立刻发现"的。
 */
export function parseSettings(raw: unknown): ParsedSettings {
  if (!isPlainObject(raw)) {
    return {
      value: DEFAULT_SETTINGS,
      doc: defaultDoc(),
      repaired: true,
      unsupportedVersion: false,
    };
  }

  if (!(SUPPORTED_SETTINGS_VERSIONS as readonly unknown[]).includes(raw.schemaVersion)) {
    // 不认识的版本：**不猜**它长什么样。用默认值启动，原文件交给调用方留档。
    return { value: DEFAULT_SETTINGS, doc: defaultDoc(), repaired: true, unsupportedVersion: true };
  }

  let repaired = false;

  // ---- theme ----
  const rawTheme = isPlainObject(raw.theme) ? raw.theme : {};
  if (!isPlainObject(raw.theme)) repaired = true;

  const modeResult = parseThemeMode(rawTheme.mode);
  if (modeResult.repaired) repaired = true;

  const fontSize = clampFontSize(rawTheme.fontSize);
  if (fontSize !== rawTheme.fontSize) repaired = true;

  const lineHeight = clampLineHeight(rawTheme.lineHeight);
  if (lineHeight !== rawTheme.lineHeight) repaired = true;

  const theme = { mode: modeResult.mode, fontSize, lineHeight };

  // ---- window ----
  const rawWindow = isPlainObject(raw.window) ? raw.window : {};
  if (!isPlainObject(raw.window)) repaired = true;

  const windowState = normalizeWindowBounds(
    {
      x: parseFiniteNumber(rawWindow.x),
      y: parseFiniteNumber(rawWindow.y),
      width: parseFiniteNumber(rawWindow.width) ?? DEFAULT_SETTINGS.window.width,
      height: parseFiniteNumber(rawWindow.height) ?? DEFAULT_SETTINGS.window.height,
      maximized: rawWindow.maximized === true,
    },
    MIN_WINDOW,
  );
  if (
    windowState.width !== rawWindow.width ||
    windowState.height !== rawWindow.height ||
    windowState.maximized !== (rawWindow.maximized === true) ||
    windowState.x !== rawWindow.x ||
    windowState.y !== rawWindow.y
  ) {
    repaired = true;
  }

  // ---- ai ----
  const rawAi = isPlainObject(raw.ai) ? raw.ai : {};
  // 整个 ai 段不存在 = v1 老文件 → 必须置 repaired，否则不会写回，永远停在 v1
  if (!isPlainObject(raw.ai)) repaired = true;
  const aiResult = parseAiSettings(raw.ai);
  if (aiResult.repaired) repaired = true;

  const value: Settings = {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    theme,
    window: windowState,
    ai: aiResult.ai,
  };

  // ---- 写回用的文档：已知字段用规范化的值，未知字段原样带着 ----
  const doc: Record<string, unknown> = {
    ...pickExtras(raw, TOP_KEYS),
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    theme: { ...pickExtras(rawTheme, THEME_KEYS), ...theme },
    window: { ...pickExtras(rawWindow, WINDOW_KEYS), ...windowStateToDoc(windowState) },
    ai: { ...pickExtras(rawAi, AI_KEYS), ...aiResult.ai },
  };

  return { value, doc, repaired, unsupportedVersion: false };
}

/**
 * `WindowState` → 要写进 JSON 的普通对象。
 *
 * `JSON.stringify` 会把值为 `undefined` 的键整个丢掉，但那是**序列化时**才发生的事 ——
 * 中间如果经过 `structuredClone` 或手工合并，就会得到 `"x": null`。
 * 显式做一次，把"哪些键不该出现"写死在代码里。
 */
export function windowStateToDoc(state: WindowState): Record<string, unknown> {
  const out: Record<string, unknown> = {
    width: state.width,
    height: state.height,
    maximized: state.maximized,
  };
  if (state.x !== undefined) out.x = state.x;
  if (state.y !== undefined) out.y = state.y;
  return out;
}

/**
 * 把窗口尺寸纠正到不小于最小值（§6）。
 *
 * 为什么会出现更小的值：用户在旧版本里把窗口缩到很小、或者配置被手改过。
 * 不纠正的后果是建出一个**比 `minWidth` 还窄的窗口**，而 Electron 会把它当成
 * "用户设的"照单接受 —— 界面的两栏布局在那个宽度下会互相压字。
 */
export function normalizeWindowBounds(
  bounds: WindowState,
  min: { width: number; height: number },
): WindowState {
  const width = Math.max(bounds.width, min.width);
  const height = Math.max(bounds.height, min.height);
  return width === bounds.width && height === bounds.height ? bounds : { ...bounds, width, height };
}

function intersects(a: Bounds, b: Bounds): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * 越界检查（§5.2）—— **最容易漏的一步**。
 *
 * 场景：用户把窗口拖到外接显示器上 → 拔掉显示器 → 下次启动窗口落在屏幕外，
 * 完全看不见，只能删配置文件救回来。
 *
 * 判定用**交集**而不是"包含"：窗口只有一部分在屏幕内也算可见 —— 用户能拖回来。
 * 完全在屏幕外才清掉坐标，交给系统居中。
 *
 * `workAreas` 为空时**不做判断**（原样返回）。那个状态的成因是"显示器还没准备好"，
 * 而不是"窗口在屏幕外"；凭空改用户的位置是没有依据的。
 */
export function ensureOnScreen(bounds: PlacedBounds, workAreas: readonly WorkArea[]): PlacedBounds {
  if (workAreas.length === 0) return bounds;
  const { x, y } = bounds;
  // 坐标本来就没记住（首次启动 / 上次被判越界）→ 没什么可判的
  if (x === undefined || y === undefined) return bounds;
  if (
    workAreas.some((area) => intersects(area, { x, y, width: bounds.width, height: bounds.height }))
  ) {
    return bounds;
  }
  return { width: bounds.width, height: bounds.height };
}

/**
 * 该用浅色还是深色窗口底色（§3.5）。
 *
 * `systemIsDark` 由调用方传（主进程传 `nativeTheme.shouldUseDarkColors`）——
 * 这个文件不 import electron，所以只能这样接。
 */
export function isDarkTheme(mode: ThemeMode, systemIsDark: boolean): boolean {
  return mode === 'dark' || (mode === 'system' && systemIsDark);
}

/** 单测与外部复查共用的一份映射导出，避免测试里各写一份期望值。 */
export const themeToDataTheme = themeToDataThemeShared;
