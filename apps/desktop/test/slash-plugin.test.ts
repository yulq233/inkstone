/**
 * 斜杠菜单插件（`features/ai/slash-plugin.ts`）。
 *
 * 这组用例护的是「只在行首触发」与「/ 一旦被删菜单就退」这两条最容易漂移的口径。
 * 插件本体只依赖 `state` / `dispatch`，所以用一个 stub view（无 DOM）驱动
 * `handleTextInput` / `confirmSlash` / `cancelSlash`；行内 `/` 不该触发、退格删 `/`
 * 后 `apply` 要主动把状态清掉 —— 这些正是真机里最容易被 IME 或别处写入破坏的路径。
 *
 * ## 位置语义（写测试前必须先对齐，否则全错）
 *
 * ProseMirror 里块级节点的**边界**占一个位置：`paragraph > text "和或"` 中，
 * text 从 pos 1 开始（pos 0 是段落起始边界），`和` 在 1~2、`或` 在 2~3。
 * 所以「行首字符位置」= pos 1，**不是** pos 0；「行内」= pos 2 起。
 */

import { describe, expect, it } from 'vitest';
import { EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { fromMd, inkstoneSchema } from '@inkstone/md-adapter';

import {
  cancelSlash,
  confirmSlash,
  createSlashPlugin,
  readSlashState,
} from '../src/renderer/src/features/ai/slash-plugin';

/** 一个只提供 `state`/`dispatch` 的最小 view：够插件驱动，不需要真 DOM。 */
class StubView {
  state: EditorState;
  readonly spec: ReturnType<typeof createSlashPlugin>['spec'];
  onChange: (state: unknown) => void;

  constructor(doc: string, onChange: (state: unknown) => void) {
    this.onChange = onChange;
    const plugin = createSlashPlugin({ onChange });
    this.spec = plugin.spec;
    this.state = EditorState.create({
      schema: inkstoneSchema,
      doc: fromMd(doc).doc,
      plugins: [plugin],
    });
  }

  dispatch(tr: import('@tiptap/pm/state').Transaction): void {
    this.state = this.state.apply(tr);
  }

  /** 驱动 `handleTextInput`（插件的 props 不暴露在 spec 外，用 spec.props 取）。 */
  textInput(from: number, text: string): boolean {
    // handleTextInput 声明里 `this: Plugin`，但实现只用 `view` 参数、不碰 `this`。
    // 这里把它剥成普通函数签名（`this` 绑定无关紧要），返回值 `boolean | void` 收敛成 boolean。
    const handler = this.spec.props!.handleTextInput as unknown as (
      view: EditorView,
      from: number,
      to: number,
      text: string,
      deflt: () => import('@tiptap/pm/state').Transaction,
    ) => boolean | void;
    return handler(this as unknown as EditorView, from, from, text, () => this.state.tr) === true;
  }
}

function stubView(doc: string, onChange: (s: unknown) => void): StubView {
  return new StubView(doc, onChange);
}

describe('行首触发', () => {
  it('行首（pos 1）敲 / 激活菜单并插入 /', () => {
    let latest: unknown = undefined;
    const view = stubView('他推开门', (s) => (latest = s));

    expect(view.textInput(1, '/')).toBe(true);
    expect(latest).toEqual({ active: true, from: 1 });
    expect(view.state.doc.textContent).toBe('/他推开门');
  });

  it('行内敲 / 不激活（"和/或"的斜杠不该弹菜单）', () => {
    let latest: unknown = undefined;
    const view = stubView('和或', (s) => (latest = s));

    // 「和」在 1~2，所以「和」与「或」之间是 pos 2（行内）
    expect(view.textInput(2, '/')).toBe(false);
    expect(latest).toBeUndefined();
    expect(view.state.doc.textContent).toBe('和或');
  });

  it('第二行行首敲 / 也触发（行首 ≠ 文档首）', () => {
    let latest: unknown = undefined;
    const view = stubView('第一行\n第二行', (s) => (latest = s));
    // 第一段「第一行」占 pos 1~4（3 字），第一段边界到 pos 5，第二段内容从 pos 6 起
    const secondLineStart = 6;
    expect(view.textInput(secondLineStart, '/')).toBe(true);
    expect(latest).toEqual({ active: true, from: secondLineStart });
  });
});

describe('确认与取消', () => {
  function activatedView(onChange: (s: unknown) => void): StubView {
    const view = stubView('他推开门', onChange);
    view.textInput(1, '/');
    return view;
  }

  it('confirmSlash 删掉 / 并退出菜单', () => {
    let latest: unknown = { active: true };
    const view = activatedView((s) => (latest = s));

    confirmSlash(view as unknown as EditorView, 'continue');
    expect(view.state.doc.textContent).toBe('他推开门');
    expect(readSlashState(view.state)).toBeNull();
    expect(latest).toBeNull();
  });

  it('cancelSlash 同样删 / 退出（Esc 路径）', () => {
    let latest: unknown = { active: true };
    const view = activatedView((s) => (latest = s));

    cancelSlash(view as unknown as EditorView);
    expect(view.state.doc.textContent).toBe('他推开门');
    expect(latest).toBeNull();
  });

  it('菜单未激活时 confirm/cancel 是 no-op', () => {
    let latest: unknown = undefined;
    const view = stubView('他推开门', (s) => (latest = s));

    confirmSlash(view as unknown as EditorView, 'continue');
    cancelSlash(view as unknown as EditorView);
    expect(latest).toBeUndefined();
    expect(view.state.doc.textContent).toBe('他推开门');
  });
});

describe('state.apply 的存活检查', () => {
  it('退格删掉 / 后，apply 把状态清空', () => {
    let latest: unknown = undefined;
    const view = stubView('他推开门', (s) => (latest = s));
    view.textInput(1, '/');
    expect(readSlashState(view.state)).not.toBeNull();

    // 删掉第一个字符（/ 在 pos 1），模拟退格（走 apply 的 docChanged 分支）
    view.dispatch(view.state.tr.delete(1, 2));
    expect(readSlashState(view.state)).toBeNull();
    expect(latest).toBeNull();
  });

  it('非删除性的文档变化（别处插入）不误清 /', () => {
    const view = stubView('他推开门', () => {});
    view.textInput(1, '/');
    const before = readSlashState(view.state);

    // 在 / 之后（pos 2）插入字符，/ 本身（pos 1）还在
    view.dispatch(view.state.tr.insertText('续', 2));
    expect(readSlashState(view.state)).toEqual(before);
    expect(view.state.doc.textContent).toBe('/续他推开门');
  });
});
