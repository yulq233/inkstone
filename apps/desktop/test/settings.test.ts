/**
 * 设置与窗口状态的单测（`09` §7）。
 *
 * ## 为什么这些用例值得写
 *
 * `main/` 目录在步骤 06 之前**一行测试都没有**。而这一步新增的东西里有两处
 * "写错了不会有报错、只会有症状"：`ensureOnScreen`（错了用户看不见窗口，只能删配置文件）
 * 与 `parseSettings`（错了用户的外观设置与窗口位置一起回到默认）。
 * 两者都不碰 Electron API，所以都能在这里直接断言。
 *
 * 最后一组是**跨文件的一致性**：`WINDOW_BG` 与 `global.css` 的 `--bg` 必须同值，
 * 否则深色主题下启动会闪一下白（§3.5）。它只能靠读文件来钉住。
 */

import { describe, expect, it } from 'vitest';
import {
  AI_TASKS,
  DAILY_BUDGET,
  DEFAULT_SETTINGS,
  FONT_SIZE,
  LINE_HEIGHT,
  MIN_WINDOW,
  PROVIDER_PRESETS,
  SETTINGS_SCHEMA_VERSION,
  WINDOW_BG,
  appearanceToCssVars,
  clampFontSize,
  clampLineHeight,
} from '@inkstone/shared';

import {
  coerceThemeMode,
  ensureOnScreen,
  isDarkTheme,
  mergeAiSettings,
  mergeThemeSettings,
  normalizeWindowBounds,
  parseAiSettings,
  parseSettings,
  themeToDataTheme,
  windowStateToDoc,
  withEgressAck,
  type PlacedBounds,
  type WorkArea,
} from '../src/main/store/settings-io';

/**
 * 样式表**当字符串**读进来（Vite 的 `?raw`）。
 *
 * 刻意不用 `node:fs`：这个测试属于 `tsconfig.web.json` 那一份（`types: ["vite/client"]`，
 * 没有 node 类型），`import fs from 'node:fs'` 会直接编译不过。`?raw` 走的是 Vite 的
 * 资源处理，测试与打包用的是同一条路径。
 */
import globalCss from '../src/renderer/src/styles/global.css?raw';

const MAIN_SCREEN: WorkArea = { x: 0, y: 0, width: 1920, height: 1040 };

describe('parseSettings —— settings.json 的自愈解析', () => {
  it('坏输入（非对象 / null）→ 全默认并标记已修正，且**不抛异常**', () => {
    for (const bad of [null, undefined, 'not json', 42, []]) {
      const parsed = parseSettings(bad);
      expect(parsed.value).toEqual(DEFAULT_SETTINGS);
      expect(parsed.repaired).toBe(true);
      expect(parsed.unsupportedVersion).toBe(false);
    }
  });

  it('完整合法的文件 → 原样取用，不标记修正', () => {
    const parsed = parseSettings({
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      theme: { mode: 'dark', fontSize: 18, lineHeight: 2 },
      window: { x: 100, y: 50, width: 1200, height: 800, maximized: true },
      ai: { ...DEFAULT_SETTINGS.ai, providers: [{ ...PROVIDER_PRESETS[0] }] },
    });

    expect(parsed.repaired).toBe(false);
    expect(parsed.value.theme).toEqual({ mode: 'dark', fontSize: 18, lineHeight: 2 });
    expect(parsed.value.window).toEqual({
      x: 100,
      y: 50,
      width: 1200,
      height: 800,
      maximized: true,
    });
  });

  it('缺字段 → 逐字段补默认，并标记已修正（好让调用方写回磁盘）', () => {
    const parsed = parseSettings({ schemaVersion: SETTINGS_SCHEMA_VERSION });

    expect(parsed.repaired).toBe(true);
    expect(parsed.value.theme).toEqual(DEFAULT_SETTINGS.theme);
    expect(parsed.value.window).toEqual(DEFAULT_SETTINGS.window);
  });

  it('越界值与坏字段 → 夹回范围：字号 99→22、行距 5→2.4、窗口 100×100→900×600', () => {
    const parsed = parseSettings({
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      theme: { mode: '深色', fontSize: 99, lineHeight: 5 },
      window: { width: 100, height: 100 },
    });

    expect(parsed.repaired).toBe(true);
    // 认不出的模式退回 `system` —— 唯一"不替用户做决定"的选项
    expect(parsed.value.theme).toEqual({ mode: 'system', fontSize: 22, lineHeight: 2.4 });
    expect(parsed.value.window.width).toBe(MIN_WINDOW.width);
    expect(parsed.value.window.height).toBe(MIN_WINDOW.height);
  });

  it('未知字段原样保留（含嵌套）—— 降级一次不该把新版写的配置抹掉', () => {
    const parsed = parseSettings({
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      futureTopLevel: 'keep me',
      theme: { mode: 'dark', fontSize: 17, lineHeight: 1.8, futureTheme: 1 },
      window: { x: 10, y: 20, width: 1000, height: 700, maximized: false, futureWindow: true },
    });

    expect(parsed.doc.futureTopLevel).toBe('keep me');
    expect((parsed.doc.theme as Record<string, unknown>).futureTheme).toBe(1);
    expect((parsed.doc.window as Record<string, unknown>).futureWindow).toBe(true);
    // 已知字段用规范化后的值覆盖同名字段
    expect((parsed.doc.theme as Record<string, unknown>).fontSize).toBe(17);
  });

  it('schemaVersion 不认识 → 全默认 + unsupportedVersion，交给调用方留档原文件', () => {
    const parsed = parseSettings({ schemaVersion: SETTINGS_SCHEMA_VERSION + 1, theme: {} });

    expect(parsed.unsupportedVersion).toBe(true);
    expect(parsed.value).toEqual(DEFAULT_SETTINGS);
  });
});

describe('windowStateToDoc', () => {
  it('没记住坐标时**不写出 x / y 这两个键**（而不是写成 null）', () => {
    const doc = windowStateToDoc({ width: 1180, height: 780, maximized: false });
    expect(Object.keys(doc).sort()).toEqual(['height', 'maximized', 'width']);
  });

  it('有坐标时带上', () => {
    const doc = windowStateToDoc({ x: 0, y: 0, width: 1180, height: 780, maximized: true });
    // 0 是合法坐标，不能被当成"没记住"
    expect(doc).toEqual({ x: 0, y: 0, width: 1180, height: 780, maximized: true });
  });
});

describe('normalizeWindowBounds', () => {
  it('小于最小值的尺寸被抬到最小值', () => {
    const fixed = normalizeWindowBounds({ width: 100, height: 50, maximized: false }, MIN_WINDOW);
    expect(fixed.width).toBe(MIN_WINDOW.width);
    expect(fixed.height).toBe(MIN_WINDOW.height);
  });

  it('已经够大时**返回同一个对象**（不做无谓的重建）', () => {
    const ok = { width: 1180, height: 780, maximized: false };
    expect(normalizeWindowBounds(ok, MIN_WINDOW)).toBe(ok);
  });
});

describe('ensureOnScreen —— 拔掉外接显示器之后的兜底（§5.2）', () => {
  it('完全在屏幕外 → 清掉坐标，交给系统居中', () => {
    const placed: PlacedBounds = { x: 3000, y: 2000, width: 1180, height: 780 };
    expect(ensureOnScreen(placed, [MAIN_SCREEN])).toEqual({ width: 1180, height: 780 });
  });

  it('只露出一角也算可见 → 原样保留（用户能拖回来）', () => {
    const placed: PlacedBounds = { x: 1900, y: 1000, width: 1180, height: 780 };
    expect(ensureOnScreen(placed, [MAIN_SCREEN])).toBe(placed);
  });

  it('多显示器：落在第二块屏上照样保留', () => {
    const secondary: WorkArea = { x: 1920, y: 0, width: 2560, height: 1440 };
    const placed: PlacedBounds = { x: 2000, y: 200, width: 1180, height: 780 };
    expect(ensureOnScreen(placed, [MAIN_SCREEN, secondary])).toBe(placed);
  });

  it('本来就没有坐标 → 原样返回', () => {
    const placed: PlacedBounds = { width: 1180, height: 780 };
    expect(ensureOnScreen(placed, [MAIN_SCREEN])).toBe(placed);
  });

  it('显示器列表为空 → **不做判断**（那是"还没准备好"，不是"窗口在屏幕外"）', () => {
    const placed: PlacedBounds = { x: 3000, y: 2000, width: 1180, height: 780 };
    expect(ensureOnScreen(placed, [])).toBe(placed);
  });
});

describe('主题与外观取值', () => {
  it('主题模式 → data-theme：system 是 null（删属性），不是空字符串', () => {
    expect(themeToDataTheme('system')).toBeNull();
    expect(themeToDataTheme('light')).toBe('light');
    expect(themeToDataTheme('dark')).toBe('dark');
  });

  it('窗口底色该用深色还是浅色', () => {
    expect(isDarkTheme('dark', false)).toBe(true);
    expect(isDarkTheme('light', true)).toBe(false);
    expect(isDarkTheme('system', true)).toBe(true);
    expect(isDarkTheme('system', false)).toBe(false);
  });

  it('字号夹到 [14,22] 的整数', () => {
    expect(clampFontSize(10)).toBe(FONT_SIZE.min);
    expect(clampFontSize(30)).toBe(FONT_SIZE.max);
    expect(clampFontSize(16.6)).toBe(17);
    expect(clampFontSize(Number.NaN)).toBe(FONT_SIZE.fallback);
    expect(clampFontSize('18')).toBe(FONT_SIZE.fallback);
  });

  it('行距夹到 [1.5,2.4] 且四舍五入到一位小数 —— 不让浮点误差攒起来', () => {
    expect(clampLineHeight(1)).toBe(LINE_HEIGHT.min);
    expect(clampLineHeight(5)).toBe(LINE_HEIGHT.max);
    expect(clampLineHeight(1.94)).toBe(1.9);
    // 0.1 步进累加的典型产物
    expect(clampLineHeight(1.7000000000000002)).toBe(1.7);
    expect(clampLineHeight(null)).toBe(LINE_HEIGHT.fallback);
  });

  it('CSS 变量**带单位**：字号 px、行距纯数字', () => {
    const vars = appearanceToCssVars({ mode: 'light', fontSize: 18, lineHeight: 2 });

    expect(vars['--editor-font-size']).toBe('18px');
    // 少了 px 浏览器会静默忽略整条声明；而 `line-height: 1.8px` 是合法且会生效的，
    // 那才是更难查的那种 —— 所以这里两个方向都钉住
    expect(vars['--editor-line-height']).toBe('2');
    expect(vars['--editor-line-height']).not.toContain('px');
  });

  it('越界的值进 `appearanceToCssVars` 也会被夹住', () => {
    const vars = appearanceToCssVars({ mode: 'dark', fontSize: 999, lineHeight: -3 });
    expect(vars['--editor-font-size']).toBe('22px');
    expect(vars['--editor-line-height']).toBe('1.5');
  });
});

/**
 * 写路径的收敛。
 *
 * 读路径（`parseSettings`）一直有校验，但 IPC 的 `settings:set` 原来直接信任
 * `SettingsPatch` —— 而类型只是编译期承诺，IPC 上来的数据没有运行时保证。
 * 往 `mode` 里塞一个认不出的值时，轻则面板三个单选框全不选中（`data-theme` 变成
 * CSS 认不出的值，只剩媒体查询兜底），重则 `nativeTheme.themeSource = '…'` 在广播
 * 订阅里抛出去，把"广播给渲染进程"和"重建菜单"一起跳过。
 *
 * 这一组之所以能写在测试里，是因为收敛被抽成了纯函数：`settings.ts` import 了 electron，
 * 测试环境根本载不进来。
 */
describe('mergeThemeSettings / coerceThemeMode —— 外观补丁的收敛', () => {
  const current = { mode: 'dark', fontSize: 16, lineHeight: 1.8 } as const;

  it('合法的模式原样通过，不受传入 fallback 影响', () => {
    expect(coerceThemeMode('dark', 'light')).toBe('dark');
    expect(coerceThemeMode('system', 'dark')).toBe('system');
    expect(coerceThemeMode('light', 'system')).toBe('light');
  });

  it('认不出的模式一律退回给定 fallback', () => {
    for (const bad of ['darkk', 'DARK', '深色', '', 1, null, {}, []]) {
      expect(coerceThemeMode(bad, 'light')).toBe('light');
    }
    // 不传 fallback 时退回默认值 —— 唯一"不替用户做决定"的那个
    expect(coerceThemeMode(undefined)).toBe(DEFAULT_SETTINGS.theme.mode);
  });

  it('坏模式不会污染当前的合法值', () => {
    // `as never` 就是在模拟"IPC 上传来了类型系统不允许、运行时却真会发生"的值
    expect(mergeThemeSettings(current, { mode: 'darkk' as never }).mode).toBe(current.mode);
  });

  it('字号与行距照样被夹紧', () => {
    expect(mergeThemeSettings(current, { fontSize: 999, lineHeight: -3 })).toEqual({
      mode: current.mode,
      fontSize: FONT_SIZE.max,
      lineHeight: LINE_HEIGHT.min,
    });
  });

  it('空补丁与 undefined → 保持当前值不变', () => {
    expect(mergeThemeSettings(current, undefined)).toEqual(current);
    expect(mergeThemeSettings(current, {})).toEqual(current);
  });
});

/**
 * 跨文件不变式：**原生窗口铺底的底色 == CSS 的 `--bg`**。
 *
 * 两处硬编码，靠注释互相指认（§3.5）。注释拦不住人，这个断言能 ——
 * 值不一致的症状只是"启动时闪一下"，在上百次改动里基本不会被注意到。
 */
describe('WINDOW_BG 与 global.css 的 --bg 同值', () => {
  it.each([
    ['浅色', WINDOW_BG.light],
    ['深色', WINDOW_BG.dark],
  ])('%s底色在 global.css 里出现', (_label, value) => {
    expect(globalCss).toContain(`--bg: ${value};`);
  });

  it('浅色块是 :root、深色块走属性选择器 + 媒体查询兜底（三态要靠它）', () => {
    expect(globalCss).toContain(`:root[data-theme='dark']`);
    expect(globalCss).toContain(`:root:not([data-theme='light']):not([data-theme='dark'])`);
  });
});

/**
 * v1 → v2 的升级路径。
 *
 * 这条**必须有测试**：`parseSettings` 原来把"schemaVersion 不等于当前值"一律判成
 * 不认识，而那个分支的处置是**把原文件改名留档、用默认值启动**。
 * 升到 v2 之后如果 v1 也走那条路，用户升一次应用就会丢掉主题与窗口位置 ——
 * 而这两项恰好是"丢了会立刻被发现"的。所以 v1 必须被**接受并就地补 ai 段**。
 */
describe('settings.json 的 v1 → v2 迁移', () => {
  const v1File = {
    schemaVersion: 1,
    theme: { mode: 'dark', fontSize: 20, lineHeight: 2.2 },
    window: { x: 320, y: 180, width: 1400, height: 900, maximized: true },
  };

  it('v1 文件被接受，**主题与窗口一个都不丢**', () => {
    const parsed = parseSettings(v1File);

    expect(parsed.unsupportedVersion).toBe(false);
    expect(parsed.value.theme).toEqual({ mode: 'dark', fontSize: 20, lineHeight: 2.2 });
    expect(parsed.value.window).toEqual({
      x: 320,
      y: 180,
      width: 1400,
      height: 900,
      maximized: true,
    });
  });

  it('缺失的 ai 段补默认值，并标记修正（触发写回 → 落盘变成 v2）', () => {
    const parsed = parseSettings(v1File);

    expect(parsed.repaired).toBe(true);
    expect(parsed.value.ai).toEqual(DEFAULT_SETTINGS.ai);
    expect(parsed.doc.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
    expect(parsed.doc.ai).toBeDefined();
  });

  it('真正不认识的版本（3）仍然走留档重置那条路', () => {
    const parsed = parseSettings({ ...v1File, schemaVersion: 3 });
    expect(parsed.unsupportedVersion).toBe(true);
    expect(parsed.value).toEqual(DEFAULT_SETTINGS);
  });

  it('`providers` 是深一层拷贝 —— 不能让两份设置共享同一个条目对象', () => {
    const a = parseSettings(v1File).value.ai.providers;
    const b = parseSettings(v1File).value.ai.providers;
    expect(a[0]).not.toBe(b[0]);
    expect(a[0]).toEqual(b[0]);
  });

  it('v1 文件里未知的顶层字段照样保留（降级不丢配置）', () => {
    const parsed = parseSettings({ ...v1File, somethingFromTheFuture: { a: 1 } });
    expect(parsed.doc.somethingFromTheFuture).toEqual({ a: 1 });
  });
});

describe('parseAiSettings —— AI 段的收敛', () => {
  it('认不出 kind 的供应商被丢弃（而不是补成 openai-compatible 去打错接口）', () => {
    const { ai, repaired } = parseAiSettings({
      providers: [
        { id: 'good', kind: 'openai-compatible', label: '好', baseUrl: 'https://a.example/v1' },
        { id: 'bad-kind', kind: 'grpc', label: '坏', baseUrl: 'https://b.example/v1' },
      ],
    });
    expect(ai.providers.map((p) => p.id)).toEqual(['good']);
    expect(repaired).toBe(true);
  });

  it('baseUrl 缺 scheme / 非法 id 的条目被丢弃', () => {
    const { ai } = parseAiSettings({
      providers: [
        { id: 'no-scheme', kind: 'openai-compatible', baseUrl: 'api.example.com/v1' },
        { id: 'Bad_Id', kind: 'openai-compatible', baseUrl: 'https://c.example/v1' },
        { id: 'ok', kind: 'openai-compatible', baseUrl: 'https://d.example/v1/' },
      ],
    });
    expect(ai.providers.map((p) => p.id)).toEqual(['ok']);
    // 末尾斜杠被规范化掉 —— 拼接路径时少一个 `//` 的坑
    expect(ai.providers[0]?.baseUrl).toBe('https://d.example/v1');
  });

  it('一个合法条目都不剩 → 回到预设（不让界面变成空列表）', () => {
    const { ai, repaired } = parseAiSettings({ providers: [{ id: 'x' }] });
    expect(ai.providers).toEqual(DEFAULT_SETTINGS.ai.providers);
    expect(repaired).toBe(true);
  });

  it('`local` 只认显式 true；`needsKey` 默认 true', () => {
    const { ai } = parseAiSettings({
      providers: [{ id: 'p', kind: 'openai-compatible', baseUrl: 'https://p.example/v1' }],
    });
    // 缺 local → 按"会外传"处理（安全方向）
    expect(ai.providers[0]?.local).toBe(false);
    expect(ai.providers[0]?.needsKey).toBe(true);
  });

  it('routing 指向已不存在的供应商 → 视为未配置', () => {
    const { ai, repaired } = parseAiSettings({
      providers: [{ id: 'alive', kind: 'openai-compatible', baseUrl: 'https://a.example/v1' }],
      routing: {
        continue: { providerId: 'gone', model: 'm' },
        rewrite: { providerId: 'alive', model: 'm' },
      },
    });
    expect(ai.routing.continue).toBeNull();
    expect(ai.routing.rewrite).toEqual({ providerId: 'alive', model: 'm' });
    expect(repaired).toBe(true);
  });

  it('六个任务槽位永远齐全 —— 缺哪个补 null，不让界面少一行', () => {
    const { ai } = parseAiSettings({});
    expect(Object.keys(ai.routing).sort()).toEqual([...AI_TASKS].sort());
    for (const task of AI_TASKS) expect(ai.routing[task]).toBeNull();
  });

  it('预算被夹到 [0, 10000]，非法值落回 0（不限）', () => {
    expect(parseAiSettings({ dailyBudgetCny: -5 }).ai.dailyBudgetCny).toBe(DAILY_BUDGET.min);
    expect(parseAiSettings({ dailyBudgetCny: 1e9 }).ai.dailyBudgetCny).toBe(DAILY_BUDGET.max);
    expect(parseAiSettings({ dailyBudgetCny: '20' }).ai.dailyBudgetCny).toBe(DAILY_BUDGET.min);
  });

  it('布尔字段的类型错误 → 落回默认值，而不是"真值"', () => {
    const { ai } = parseAiSettings({ offlineOnly: 'yes', confirmContextPreview: 0 });
    expect(ai.offlineOnly).toBe(DEFAULT_SETTINGS.ai.offlineOnly);
    expect(ai.confirmContextPreview).toBe(DEFAULT_SETTINGS.ai.confirmContextPreview);
  });

  it('defaultModel 的三种输入：缺 / 空 / 给坏了', () => {
    // 先给一份**除了被测字段以外都合法**的输入，否则 providers 缺失会自己把
    // repaired 置上，这条用例就测不到 defaultModel 的行为了。
    const withProviders = (extra: Record<string, unknown>): Record<string, unknown> => ({
      providers: [{ ...PROVIDER_PRESETS[0] }],
      ...extra,
    });

    // 「缺」与「空串」都是合法的"还没选模型"（空串本身就是默认值）——
    // 把它们判成"需要修正"的代价是：每个刚生成的 settings.json 一启动就被重写一遍
    // （第一版就是这么写的，"完整合法文件不标记修正"那条用例当场挂掉）
    expect(parseAiSettings(withProviders({})).ai.defaultModel).toBe('');
    expect(parseAiSettings(withProviders({})).repaired).toBe(false);
    expect(parseAiSettings(withProviders({ defaultModel: '' })).repaired).toBe(false);
    expect(parseAiSettings(withProviders({ defaultModel: '   ' })).repaired).toBe(false);

    // 「给坏了」才算真修正：带空格的模型名发出去只会拿到 "model not found"
    expect(parseAiSettings(withProviders({ defaultModel: 'deepseek chat' })).ai.defaultModel).toBe(
      '',
    );
    expect(parseAiSettings(withProviders({ defaultModel: 'deepseek chat' })).repaired).toBe(true);
    expect(parseAiSettings(withProviders({ defaultModel: 42 })).repaired).toBe(true);

    expect(parseAiSettings(withProviders({ defaultModel: '  qwen3:8b ' })).ai.defaultModel).toBe(
      'qwen3:8b',
    );
    expect(parseAiSettings(withProviders({ defaultModel: '  qwen3:8b ' })).repaired).toBe(false);
  });

  it('已确认外发的名单：只留当前存在的供应商，去重、丢非字符串', () => {
    // 「已删除的供应商」那条不是洁癖：删掉一家之后重建同名 id（比如把改坏的自定义端点
    // 改回 `deepseek`），留着旧记录会让**用户从没看过的一个新地址**被当成已确认过 ——
    // 那是一道隐私闸门被悄悄打开。sidecar 的 `AiState.apply()` 用同一判据（两边都做是刻意的）。
    expect(
      parseAiSettings({ acknowledgedEgressProviders: ['deepseek'] }).ai.acknowledgedEgressProviders,
    ).toEqual(['deepseek']);

    const dirty = parseAiSettings({
      providers: [{ ...PROVIDER_PRESETS[0] }],
      acknowledgedEgressProviders: [
        'deepseek',
        'deepseek', // 重复
        '已删除的那家', // 不在 providers 里
        42, // 非字符串
        null,
      ],
    }).ai.acknowledgedEgressProviders;
    expect(dirty).toEqual(['deepseek']);

    // 坏形状 → 空名单。**不标 repaired**：丢掉的只是名单里的一行垃圾，
    // 标成"有问题"会让每个含垃圾项的文件每次启动都白写一次盘（与 defaultModel 同款处理）。
    expect(
      parseAiSettings({ acknowledgedEgressProviders: 'deepseek' }).ai.acknowledgedEgressProviders,
    ).toEqual([]);
    expect(
      parseAiSettings({
        providers: [{ ...PROVIDER_PRESETS[0] }],
        acknowledgedEgressProviders: ['ghost'],
      }).repaired,
    ).toBe(false);
  });
});

describe('withEgressAck —— 确认名单的读改写（docs/11 §2.3）', () => {
  const base = parseAiSettings({
    providers: [{ ...PROVIDER_PRESETS[0] }], // deepseek
    acknowledgedEgressProviders: ['deepseek'],
  }).ai;

  it('记录一个新的确认 → 追加到末尾', () => {
    const withMoonshot = parseAiSettings({
      providers: [...PROVIDER_PRESETS],
      acknowledgedEgressProviders: ['deepseek'],
    }).ai;
    expect(withEgressAck(withMoonshot, 'moonshot', true)).toEqual(['deepseek', 'moonshot']);
  });

  it('撤销 → 移出名单（下次生成会重新弹卡）', () => {
    expect(withEgressAck(base, 'deepseek', false)).toEqual([]);
    // 撤销一个本来就不在名单里的，结果不变（幂等 —— 连点两次不会出事）
    expect(withEgressAck(base, 'deepseek', false)).toEqual([]);
  });

  it('重复确认同一家 → 不会出现两个条目', () => {
    expect(withEgressAck(base, 'deepseek', true)).toEqual(['deepseek']);
  });

  it('未知供应商 → `null`（调用方回一句"刷新设置页后重试"，而不是静默吞掉）', () => {
    // 静默吞掉会让用户看到"确认成功"的假象，而下次生成照样弹卡 ——
    // 因为 `parseEgressAcks` 会把不存在的 id 丢掉。
    expect(withEgressAck(base, 'nope', true)).toBeNull();
    expect(withEgressAck(base, 'nope', false)).toBeNull();
  });
});

describe('mergeAiSettings —— AI 写路径的收敛', () => {
  const current = parseAiSettings({}).ai;

  it('空补丁与 undefined → 保持当前值不变', () => {
    expect(mergeAiSettings(current, undefined)).toEqual(current);
    expect(mergeAiSettings(current, {})).toEqual(current);
  });

  it('坏 `offlineOnly`（IPC 上传来的非布尔值）不会污染当前值', () => {
    expect(mergeAiSettings(current, { offlineOnly: 'yes' as never }).offlineOnly).toBe(
      current.offlineOnly,
    );
  });

  it('补丁只改一个字段时，其余字段原样保留', () => {
    const next = mergeAiSettings(current, { dailyBudgetCny: 30 });
    expect(next.dailyBudgetCny).toBe(30);
    expect(next.providers).toEqual(current.providers);
    expect(next.routing).toEqual(current.routing);
  });

  it('把 defaultProviderId 指向一个不存在的供应商 → 落回 null', () => {
    expect(mergeAiSettings(current, { defaultProviderId: 'nope' }).defaultProviderId).toBeNull();
    const first = current.providers[0];
    expect(mergeAiSettings(current, { defaultProviderId: first?.id ?? '' }).defaultProviderId).toBe(
      first?.id,
    );
  });
});
