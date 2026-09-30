/**
 * 斜杠菜单的浮层（`docs/11` §6.3）。
 *
 * ## 键盘导航在**这里**，不在插件里
 *
 * 插件（`slash-plugin.ts`）只负责检测触发、跟踪 `/` 是否还在、阻止导航键的默认行为；
 * "高亮移到哪一项""Enter 选中谁"是这里的 state（`highlight`）。
 * 这个划分的理由：高亮是纯 React 状态，放插件里就要在插件状态里存 index、
 * 再经 `onChange` 回传，多绕一层；而插件确实需要的只有"`/` 的位置"。
 *
 * ## 选中后先删 `/`，再触发动作
 *
 * `confirmSlash(view, id)` 删掉 `/` 并退出菜单，然后才调 `onSelect(id)`。
 * 顺序不能反：动作（续写/快捷面板）可能立即读取光标位置取上下文，
 * 而 `/` 还留在文档里时，那段上下文是脏的（多了个斜杠）。
 */

import { useCallback, useEffect, useState } from 'react';
import type { EditorView } from '@tiptap/pm/view';

import { SLASH_COMMANDS, type SlashCommandId } from './slash-commands';
import { cancelSlash, confirmSlash, type SlashState } from './slash-plugin';
import './ai-panel.css';

export interface SlashMenuProps {
  /** 插件上报的当前状态。`null` 或 `!active` 时不渲染。 */
  state: SlashState | null;
  /** 拿当前编辑器视图（调 confirm/cancel 用）。 */
  getView: () => EditorView | null;
  /** 选中 `/续写`。 */
  onContinue: () => void;
  /** 选中某个快捷 kind。 */
  onQuick: (kind: SlashCommandId) => void;
}

export function SlashMenu({ state, getView, onContinue, onQuick }: SlashMenuProps) {
  const active = state !== null && state.active;

  if (!active || state === null) return null;

  // `key={state.from}`：每次重新触发（`/` 的位置不同）都重建这个子组件，
  // 于是高亮 state 自然归零 —— 不用 effect 去手动 reset（`set-state-in-effect`）。
  return (
    <SlashMenuBody key={state.from} getView={getView} onContinue={onContinue} onQuick={onQuick} />
  );
}

function SlashMenuBody({ getView, onContinue, onQuick }: Omit<SlashMenuProps, 'state'>) {
  const [highlight, setHighlight] = useState(0);
  const items = SLASH_COMMANDS;

  const pick = useCallback(
    (id: SlashCommandId): void => {
      const view = getView();
      if (view === null) return;
      confirmSlash(view, id);
      if (id === 'continue') onContinue();
      else onQuick(id);
    },
    [getView, onContinue, onQuick],
  );

  const cancel = useCallback((): void => {
    const view = getView();
    if (view === null) return;
    cancelSlash(view);
  }, [getView]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          setHighlight((h) => (h + 1) % items.length);
          break;
        case 'ArrowUp':
          event.preventDefault();
          setHighlight((h) => (h - 1 + items.length) % items.length);
          break;
        case 'Enter':
        case 'Tab':
          event.preventDefault();
          pick(items[highlight]?.id ?? 'continue');
          break;
        case 'Escape':
          event.preventDefault();
          cancel();
          break;
      }
    };
    // 捕获阶段：插件的 handleKeyDown 已经在编辑器里 preventDefault 了，
    // 但 window 捕获阶段仍能先拿到按键，保证高亮/确认先于任何默认行为。
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [highlight, items, pick, cancel]);

  return (
    <div className="slash-menu" role="listbox" aria-label="指令">
      {items.map((item, index) => (
        <button
          key={item.id}
          type="button"
          role="option"
          aria-selected={index === highlight}
          className={`slash-item${index === highlight ? ' slash-item-active' : ''}`}
          onMouseEnter={() => setHighlight(index)}
          onClick={() => pick(item.id)}
        >
          <span className="slash-label">/{item.label}</span>
          {item.shortcut === undefined ? null : (
            <span className="slash-shortcut">{item.shortcut}</span>
          )}
        </button>
      ))}
      <p className="slash-hint">↑↓ 选择 · Enter 确认 · Esc 取消</p>
    </div>
  );
}
