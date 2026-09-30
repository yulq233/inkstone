/**
 * 幽灵文本与"接受"（`docs/11` §6.1 / §6.6）。
 *
 * 这组用例护着三件**一旦坏掉、用户会立刻丢字或吃坏正文**的事：
 *
 * 1. **装饰不产生 step**。`tr.docChanged === false` 是 P1 验收第 3 条
 *    （"生成过程中关掉应用，磁盘上一个字节都没变"）的地基：
 *    TipTap 的 `onUpdate` 只在 `transactions.some(t => t.docChanged)` 时才发
 *    （`@tiptap/core` 的 `dispatchTransaction`），而 `onUpdate` → `Autosave.onChange`。
 *    这条断言把"AI 草稿不会被自动保存"从注释变成可执行的约束。
 * 2. **锚点跟着文档映射**。不映射的话，用户在生成期间在锚点前敲一个字，
 *    接受时内容就插到别的地方去了。
 * 3. **第一段必须接进当前段落**。"他推开门" + "，看见了她" 变成两段，
 *    是续写这个主场景里一眼可见的坏结果（`ghost-insert.ts` 记了实测结论）。
 */

import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { Transform } from '@tiptap/pm/transform';
import { fromMd, inkstoneSchema } from '@inkstone/md-adapter';

import {
  assertExtensionsMatchWhitelist,
  createEditorExtensions,
  describeExtensionSchema,
} from '../src/renderer/src/lib/editor-extensions';
import { planCharCount, planGhostInsert } from '../src/renderer/src/features/ai/ghost-insert';
import {
  clearGhostMeta,
  createGhostPlugin,
  createGhostTextExtension,
  readGhost,
  setGhostMeta,
} from '../src/renderer/src/features/ai/ghost-text';
import { handleAiShortcut } from '../src/renderer/src/features/ai/shortcuts';

/** 造一个只有幽灵插件的编辑器状态 —— 没有 DOM 也能跑（文件头那种"真编辑器"要 DOM）。 */
function ghostState(source: string): EditorState {
  return EditorState.create({
    schema: inkstoneSchema,
    doc: fromMd(source).doc,
    plugins: [createGhostPlugin()],
  });
}

// ---------------------------------------------------------------------------
// 装饰不进文档
// ---------------------------------------------------------------------------

describe('幽灵文本是装饰，不是内容', () => {
  it('加一件装饰扩展不影响白名单断言（节点与标记一个没变）', () => {
    const base = createEditorExtensions('写吧');
    const withGhost = [...base, createGhostTextExtension()];

    expect(() => assertExtensionsMatchWhitelist(withGhost)).not.toThrow();

    // 装饰落在 `others` 里 —— 白名单比的是**语法**（节点/标记），
    // 这才是"它不会悄悄放宽语法"的实质
    const before = describeExtensionSchema(base);
    const after = describeExtensionSchema(withGhost);
    expect(after.nodes).toEqual(before.nodes);
    expect(after.marks).toEqual(before.marks);
    expect(after.others).toContain('inkstoneGhostText');
  });

  it('写幽灵文本的事务 docChanged === false（→ 不触发 onUpdate → 不置脏）', () => {
    const state = ghostState('他推开门');
    const tr = state.tr;
    setGhostMeta(tr, 3, '，看见了她');

    expect(tr.docChanged).toBe(false);
    expect(tr.steps).toHaveLength(0);
    // `addToHistory: false`：没有 step 的事务本来就进不了撤销栈，
    // 这一条是替未来"万一它变成了带 step 的事务"先立个桩
    expect(tr.getMeta('addToHistory')).toBe(false);
  });

  it('清幽灵文本的事务同样不碰文档', () => {
    const state = ghostState('他推开门');
    const tr = state.tr;
    clearGhostMeta(tr);

    expect(tr.docChanged).toBe(false);
    expect(state.apply(tr).doc.eq(state.doc)).toBe(true);
  });

  it('set / clear 都落到插件状态上', () => {
    let state = ghostState('他推开门');

    expect(readGhost(state)).toBeNull();

    const set = state.tr;
    setGhostMeta(set, 3, '，看见了她');
    state = state.apply(set);
    expect(readGhost(state)).toEqual({ pos: 3, text: '，看见了她' });

    const clear = state.tr;
    clearGhostMeta(clear);
    state = state.apply(clear);
    expect(readGhost(state)).toBeNull();
  });

  it('锚点跟着文档变化映射（在锚点之前插字，锚点往后挪）', () => {
    let state = ghostState('他推开门');
    const set = state.tr;
    setGhostMeta(set, 3, '，看见了她');
    state = state.apply(set);

    // 用户在**锚点之前**敲了一个字
    state = state.apply(state.tr.insertText('忽然，', 1));

    expect(readGhost(state)?.pos).toBe(6);
    expect(readGhost(state)?.text).toBe('，看见了她');
  });

  it('文档里插了内容之后幽灵文本还在（它不随事务消失）', () => {
    let state = ghostState('他推开门');
    const set = state.tr;
    setGhostMeta(set, 3, 'x');
    state = state.apply(set);

    state = state.apply(state.tr.insertText('。', 4));

    expect(readGhost(state)?.text).toBe('x');
  });
});

// ---------------------------------------------------------------------------
// 接受时的插入形状
// ---------------------------------------------------------------------------

/**
 * 复刻 `ghostAccept` 的两步插入（**含它的末尾位置算法** —— 那是实测踩出来的坑，
 * 复刻的意义就是让"算法改了但实现没改（或反过来）"在测试里露馅）。
 *
 * 参数类型交给推断：`@tiptap/pm/model` 的 `Node` 与适配层的不是同一个类
 * （两个 `prosemirror-model` 实例），在测试里给参数写死类型反而会打架。
 */
function applyAccept(base: ReturnType<typeof fromMd>['doc'], pos: number, markdown: string) {
  const plan = planGhostInsert(markdown);
  const tr = new Transform(base);
  let end = Math.min(pos, tr.doc.content.size);

  if (plan.lead.length > 0) {
    tr.insert(end, fragmentOf('paragraph', plan.lead));
    // 此刻累积映射里只有这一步，map 是安全的
    end = tr.mapping.map(end, 1);
  }
  if (plan.rest.length > 0) {
    tr.insert(end, fragmentOf('doc', plan.rest));
    // ⚠️ 不能再 map：累积映射会把 end 连前面的步骤重走一遍（实现里有实测数字）
    const last = tr.mapping.maps[tr.mapping.maps.length - 1];
    let mapped = 0;
    last.forEach((_f, _t, _nf, newTo) => {
      if (mapped === 0) mapped = newTo;
    });
    end = mapped === 0 ? end : mapped;
  }
  return { doc: tr.doc, end, plan };
}

function fragmentOf(wrapper: 'doc' | 'paragraph', content: unknown[]) {
  return inkstoneSchema.nodeFromJSON({ type: wrapper, content }).content;
}

/** 文档的纯文本，段落之间用 `|` 分开 —— 断言"是不是被劈成了两段"最直观的形式。 */
function shapeOf(doc: { toJSON(): unknown }): string {
  const json = doc.toJSON() as { content?: { content?: { text?: string }[] }[] };
  return (json.content ?? [])
    .map((block) => (block.content ?? []).map((inline) => inline.text ?? '').join(''))
    .join('|');
}

describe('接受时的插入形状', () => {
  it('光标在段落末尾：第一段接上，后面的段落另起', () => {
    const base = fromMd('他推开门').doc;
    // 段落内容末尾的位置 = 1（段首）+ 4（"他推开门"）
    const { doc, end } = applyAccept(base, 5, '，看见了她\n\n风从门缝里挤进来。');

    expect(shapeOf(doc)).toBe('他推开门，看见了她|风从门缝里挤进来。');
    // 光标最终落进最后一个段落的结尾 —— 与实现同一条路：
    // `end` 本身可能落在文档层（段落后），`TextSelection.near(…, -1)` 把它收进
    // 前一个文本块。断言直接钉最终落点，而不是中间那个数字。
    const selection = TextSelection.near(doc.resolve(Math.min(end, doc.content.size)), -1);
    expect(doc.textBetween(selection.from - '风从门缝里挤进来。'.length, selection.from)).toBe(
      '风从门缝里挤进来。',
    );
  });

  it('光标在段落中间：同一段里接上，不把原句劈开', () => {
    const base = fromMd('他推开门').doc;
    // 位置 3 落在「推」与「开」之间。TipTap 的 `insertContentAt` 会在这里**拆段**
    // （`replaceWith` 的语义），于是"他推"和"开门"会变成两段 —— 这正是本模块存在的理由
    const { doc } = applyAccept(base, 3, '，看见了她');

    expect(shapeOf(doc)).toBe('他推，看见了她开门');
    expect((doc.toJSON() as { content: unknown[] }).content).toHaveLength(1);
  });

  it('单段候选不产生任何新段落', () => {
    const base = fromMd('他推开门').doc;
    const { doc } = applyAccept(base, 5, '，看见了她');

    expect(shapeOf(doc)).toBe('他推开门，看见了她');
    expect((doc.toJSON() as { content: unknown[] }).content).toHaveLength(1);
  });

  it('模型给的第一块是标题时，整批另起（不把标题降级成正文）', () => {
    const base = fromMd('他推开门').doc;
    const { doc } = applyAccept(base, 5, '# 第三章\n\n他到底还是没醒。');

    expect(shapeOf(doc)).toBe('他推开门|第三章|他到底还是没醒。');
  });

  it('首尾空白不会变成空段落', () => {
    const base = fromMd('他推开门').doc;
    const { doc } = applyAccept(base, 5, '\n\n，看见了她\n\n');

    expect(shapeOf(doc)).toBe('他推开门，看见了她');
  });

  it('内容一个字都没有时不动文档', () => {
    const base = fromMd('他推开门').doc;
    const plan = planGhostInsert('   \n\n  ');

    expect(plan).toEqual({ lead: [], rest: [] });
    expect(shapeOf(base)).toBe('他推开门');
  });
});

describe('planGhostInsert', () => {
  it('第一段拆成内联，其余是块', () => {
    const plan = planGhostInsert('先这样。\n\n再那样。');
    expect(plan.lead).toEqual([{ type: 'text', text: '先这样。' }]);
    expect(plan.rest).toHaveLength(1);
    expect(plan.rest[0].type).toBe('paragraph');
  });

  it('保留行内标记（加粗不能退化成纯文本）', () => {
    const plan = planGhostInsert('他**猛地**回头。');
    expect(plan.lead[0]).toMatchObject({ type: 'text', text: '他' });
    expect(plan.lead[1]).toMatchObject({ text: '猛地', marks: [{ type: 'bold' }] });
  });

  it('第一块不是段落时整批当块（不把标题降级成正文）', () => {
    const plan = planGhostInsert('> 引用一段');
    expect(plan.lead).toEqual([]);
    expect(plan.rest).toHaveLength(1);
  });

  it('字数口径按**进文档的字**算，不按原始 Markdown 的长度', () => {
    const plan = planGhostInsert('他**猛地**回头。');
    // 四个 `**` 进进出出：原始 10 个字符，进文档 6 个字
    expect(planCharCount(plan)).toBe('他猛地回头。'.length);
  });
});

// ---------------------------------------------------------------------------
// Ctrl + Enter
// ---------------------------------------------------------------------------

describe('Ctrl/Cmd + Enter', () => {
  const key = (patch: Partial<{ key: string; ctrlKey: boolean; metaKey: boolean }>) => ({
    key: 'Enter',
    ctrlKey: false,
    metaKey: false,
    ...patch,
  });

  it('Ctrl+Enter 触发续写并消费按键', () => {
    let calls = 0;
    expect(handleAiShortcut(key({ ctrlKey: true }), { onContinue: () => calls++ })).toBe(true);
    expect(calls).toBe(1);
  });

  it('macOS 的 Cmd+Enter 走同一条路', () => {
    let calls = 0;
    expect(handleAiShortcut(key({ metaKey: true }), { onContinue: () => calls++ })).toBe(true);
    expect(calls).toBe(1);
  });

  it('光按 Enter 不接管（否则用户就换不了段）', () => {
    let calls = 0;
    expect(handleAiShortcut(key({}), { onContinue: () => calls++ })).toBe(false);
    expect(calls).toBe(0);
  });

  it('别的键配 Ctrl 也不接管', () => {
    let calls = 0;
    expect(handleAiShortcut(key({ key: 'k', ctrlKey: true }), { onContinue: () => calls++ })).toBe(
      false,
    );
    expect(calls).toBe(0);
  });

  it('没有接续写功能时按键交还给默认行为', () => {
    expect(handleAiShortcut(key({ ctrlKey: true }), {})).toBe(false);
  });
});
