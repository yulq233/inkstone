import { useEffect, useState } from 'react';
import {
  DEFAULT_SETTINGS,
  FONT_SIZE,
  LINE_HEIGHT,
  THEME_MODES,
  THEME_MODE_LABEL,
  type ThemeMode,
  type ThemeSettings,
} from '@inkstone/shared';
import type { ApiClient } from '../../lib/api';
import { AiSection } from './AiSection';
import { useSettings } from './use-settings';
import './settings.css';

/**
 * 「设置」对话框（步骤 06 建立外观分区，P0 增加 AI 分区）。
 *
 * ## 一条不能省的性质：**外层必须常挂载**
 *
 * 主题与字号是 `useSettings` 的 effect 写到 `<html>` 上的。如果"关闭面板"表现为
 * 卸载本组件，那么**关掉面板就会把刚设好的主题一起撤掉** —— 属性还在，但不再有代码
 * 维护它，紧接着的一次系统主题变化就再也不同步了。所以关闭只是 `return null`，
 * hook 照常运行；真正的卸载路径只有整个应用退出。
 *
 * 里面的 AI 分区则**相反**，它随面板一起卸载 —— 那是想要的，
 * 密钥输入框里的明文会随卸载消失（见 `AiSection.tsx` 的说明）。
 */

/** 每种主题模式下的一句人话。三态的区别不是自明的，尤其 `system`。 */
const THEME_MODE_HINT: Record<ThemeMode, string> = {
  system: '跟随系统的深浅色设置 —— 系统切换时应用会一起变，不需要重启。',
  light: '始终使用浅色，不随系统变化。',
  dark: '始终使用深色，不随系统变化。',
};

type Section = 'appearance' | 'ai';

const SECTION_LABEL: Record<Section, string> = {
  appearance: '外观',
  ai: 'AI 模型',
};

export function SettingsPanel({ client }: { client: ApiClient | null }) {
  const { settings, panelOpen, closePanel, updateTheme, updateAi } = useSettings();
  const [section, setSection] = useState<Section>('appearance');

  // Esc 关闭。挂在 window 上而不是面板上：面板里到处是可聚焦的控件，
  // 挂在元素上就得先保证焦点在面板内（还得为此写焦点陷阱）。
  useEffect(() => {
    if (!panelOpen) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closePanel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [panelOpen, closePanel]);

  if (!panelOpen) return null;

  return (
    <div className="settings-backdrop">
      <div
        className="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <div className="settings-head">
          <h2 id="settings-title">设置</h2>
          <button type="button" className="linkish" onClick={closePanel}>
            关闭
          </button>
        </div>

        {/*
          两个分区用页签而不是"一长条滚动"：外观是常改的（调字号），
          AI 是配一次就不再动的，混在一起会让常改的那部分被埋起来。
        */}
        <div className="settings-tabs" role="tablist" aria-label="设置分区">
          {(Object.keys(SECTION_LABEL) as Section[]).map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              className="settings-tab"
              aria-selected={section === key}
              onClick={() => setSection(key)}
            >
              {SECTION_LABEL[key]}
            </button>
          ))}
        </div>

        <div className="settings-body">
          {section === 'appearance' ? (
            <AppearanceSection theme={settings.theme} updateTheme={updateTheme} />
          ) : (
            <AiSection settings={settings} updateAi={updateAi} client={client} />
          )}
        </div>
      </div>
    </div>
  );
}

function AppearanceSection({
  theme,
  updateTheme,
}: {
  theme: ThemeSettings;
  updateTheme: (patch: Partial<ThemeSettings>) => void;
}) {
  return (
    <div className="settings-section">
      <section className="settings-group">
        <h3>主题</h3>
        <div className="settings-radios">
          {THEME_MODES.map((mode) => (
            <label key={mode} className="settings-radio">
              <input
                type="radio"
                name="theme-mode"
                value={mode}
                checked={theme.mode === mode}
                onChange={() => updateTheme({ mode })}
              />
              <span>{THEME_MODE_LABEL[mode]}</span>
            </label>
          ))}
        </div>
        <p className="hint">{THEME_MODE_HINT[theme.mode]}</p>
      </section>

      <section className="settings-group">
        <div className="settings-slider-row">
          <label htmlFor="settings-font-size">正文字号</label>
          <span className="settings-value">{theme.fontSize}px</span>
        </div>
        <input
          id="settings-font-size"
          type="range"
          min={FONT_SIZE.min}
          max={FONT_SIZE.max}
          step={FONT_SIZE.step}
          value={theme.fontSize}
          onChange={(event) => updateTheme({ fontSize: Number(event.target.value) })}
        />
        <p className="hint">
          只影响正文，界面字号不变。范围 {FONT_SIZE.min}–{FONT_SIZE.max}px。
        </p>
      </section>

      <section className="settings-group">
        <div className="settings-slider-row">
          <label htmlFor="settings-line-height">正文行距</label>
          {/* 定一位小数：浮点累加会攒出 1.9000000000000001，直接写出来很吓人 */}
          <span className="settings-value">{theme.lineHeight.toFixed(1)}</span>
        </div>
        <input
          id="settings-line-height"
          type="range"
          min={LINE_HEIGHT.min}
          max={LINE_HEIGHT.max}
          step={LINE_HEIGHT.step}
          value={theme.lineHeight}
          onChange={(event) => updateTheme({ lineHeight: Number(event.target.value) })}
        />
        <p className="hint">
          范围 {LINE_HEIGHT.min}–{LINE_HEIGHT.max}，长文阅读一般 1.8 上下最舒服。
        </p>
      </section>

      <div className="actions">
        {/* 三样一起回默认（含主题），而不是只重置字号 —— 菜单里已经有单项的「重置字号」 */}
        <button type="button" onClick={() => updateTheme({ ...DEFAULT_SETTINGS.theme })}>
          恢复默认
        </button>
      </div>
    </div>
  );
}
