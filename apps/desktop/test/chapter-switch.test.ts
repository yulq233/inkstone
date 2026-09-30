/**
 * 切章时序的单测（`07` 文档 §5、§8）。
 *
 * `03` 文档 §6.5 有一句加粗的话：**第 1~3 步是这个功能的全部价值**。
 * 跳过 flush 直接切换，就是"偶发丢字"这类最难查的 bug 的来源 ——
 * 用户少了几百字，而且**复现不了**。
 *
 * 所以这份测试里最重要的两条是：
 * 1. `flush` 失败时**没有调用 `readChapter`**（整条切换被拦死在第一步）；
 * 2. **conflict 态下 `hasUnsavedChanges()` 是 false**，所以必须靠那道"双保险"
 *    才能拦住 —— 这一条是 `runChapterSwitch` 里最容易被后人删掉的判断。
 */

import { describe, expect, it } from 'vitest';
import { ErrorCode, type ChapterContent, type ChapterSummary } from '@inkstone/shared';

import { ApiError } from '../src/renderer/src/lib/api';
import type { SaveState } from '../src/renderer/src/lib/autosave';
import {
  runChapterSwitch,
  type SwitchDeps,
  type SwitchOutcome,
} from '../src/renderer/src/features/chapter/chapter-switch';

function summary(id: string, order = 1): ChapterSummary {
  return {
    id,
    order,
    title: `第 ${order} 章`,
    status: 'draft',
    wordCount: 0,
    dirName: `00${order}-x`,
  };
}

function content(id: string): ChapterContent {
  return {
    id,
    order: 1,
    title: '第 1 章',
    status: 'draft',
    markdown: `# ${id}`,
    hash: `hash-${id}`,
    wordCount: 10,
    savedAt: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface SetupOptions {
  currentChapterId?: string | null;
  hasUnsavedChanges?: () => boolean;
  flush?: () => Promise<boolean>;
  saveState?: () => SaveState;
  readChapter?: (chapterId: string) => Promise<ChapterContent>;
}

function setup(options: SetupOptions = {}) {
  const calls: string[] = [];
  const applied: string[] = [];

  const deps: SwitchDeps = {
    currentChapterId: options.currentChapterId ?? 'a',
    hasUnsavedChanges: options.hasUnsavedChanges ?? (() => false),
    flush:
      options.flush ??
      (async () => {
        calls.push('flush');
        return true;
      }),
    saveState: options.saveState ?? (() => 'idle'),
    readChapter:
      options.readChapter ??
      (async (chapterId) => {
        calls.push(`read:${chapterId}`);
        return content(chapterId);
      }),
    guard: { token: 0 },
    onProceed: () => calls.push('proceed'),
    apply: (target) => {
      calls.push(`apply:${target.id}`);
      applied.push(target.id);
    },
  };

  return { deps, calls, applied };
}

const B = summary('b', 2);
const C = summary('c', 3);

describe('runChapterSwitch —— 第 1~3 步是全部价值', () => {
  it('flush 失败时中断：**根本不读正文**（最关键的一条回归测试）', async () => {
    const { deps, calls } = setup({
      hasUnsavedChanges: () => true,
      flush: async () => {
        calls.push('flush');
        return false;
      },
      saveState: () => 'error',
    });

    const outcome = await runChapterSwitch(deps, B);

    expect(outcome).toEqual({ kind: 'blocked-save' });
    // 一个字都不许往下走
    expect(calls).toEqual(['flush']);
    expect(calls.some((c) => c.startsWith('read:'))).toBe(false);
    expect(calls.some((c) => c.startsWith('apply:'))).toBe(false);
  });

  it('没有未落盘内容时不 flush（白 flush 一次会拖慢切换）', async () => {
    const { deps, calls } = setup({ hasUnsavedChanges: () => false });

    const outcome = await runChapterSwitch(deps, B);

    expect(outcome.kind).toBe('switched');
    expect(calls).toEqual(['proceed', 'read:b', 'apply:b']);
  });

  it('有未落盘内容时：flush 在 readChapter 之前', async () => {
    const { deps, calls } = setup({ hasUnsavedChanges: () => true });

    await runChapterSwitch(deps, B);

    expect(calls).toEqual(['flush', 'proceed', 'read:b', 'apply:b']);
  });

  it('flush 抛异常时按"没落盘"处理 —— 绝不放行，也绝不把 rejection 漏给调用方', async () => {
    const { deps, calls } = setup({
      hasUnsavedChanges: () => true,
      flush: async () => {
        calls.push('flush');
        throw new Error('不该发生');
      },
    });

    // 调用方是 `void switchTo(...)`，接不住 rejection：
    // 漏出去就是"点了切章，毫无反应"。所以这里必须收敛成 blocked。
    expect(await runChapterSwitch(deps, B)).toEqual({ kind: 'blocked-save' });
    expect(calls).toEqual(['flush']);
  });
});

describe('runChapterSwitch —— 冲突态的双保险', () => {
  it('**冲突态下 hasUnsavedChanges() 是 false，只有双保险能拦住**', async () => {
    // 这是真实行为，不是构造出来的：Autosave 每轮 runLoop 开头就把 mustSave 清成 false，
    // 然后在写入时撞上 409 进入 conflict —— 此刻 mustSave 已经是 false 了。
    const { deps, calls } = setup({
      hasUnsavedChanges: () => false,
      saveState: () => 'conflict',
    });

    const outcome = await runChapterSwitch(deps, B);

    expect(outcome).toEqual({ kind: 'blocked-conflict' });
    // 如果漏掉双保险，这里会是 ['proceed', 'read:b', 'apply:b'] —— 冲突被静默跨过
    expect(calls).toEqual([]);
  });

  it('flush 失败且状态是冲突时，报冲突而不是保存失败（要开对话框，不是给重试）', async () => {
    const { deps } = setup({
      hasUnsavedChanges: () => true,
      flush: async () => false,
      saveState: () => 'conflict',
    });

    expect((await runChapterSwitch(deps, B)).kind).toBe('blocked-conflict');
  });

  it('blocked 时不会显示加载遮罩（onProceed 未被调用）', async () => {
    const { deps, calls } = setup({ saveState: () => 'conflict' });

    await runChapterSwitch(deps, B);

    expect(calls).not.toContain('proceed');
  });
});

describe('runChapterSwitch —— 竞态（连点）', () => {
  it('切到当前章：什么都不做（否则会白 flush 一次并把光标弄没）', async () => {
    const { deps, calls } = setup({ currentChapterId: 'a', hasUnsavedChanges: () => true });

    const outcome = await runChapterSwitch(deps, summary('a'));

    expect(outcome).toEqual({ kind: 'ignored' });
    expect(calls).toEqual([]);
  });

  it('连点两次：第一次的响应晚到，必须被丢弃（否则用户被拉回中间那次）', async () => {
    const gate = deferred<ChapterContent>();
    const { deps, calls, applied } = setup({
      readChapter: (chapterId) => {
        calls.push(`read:${chapterId}`);
        return chapterId === 'b' ? gate.promise : Promise.resolve(content(chapterId));
      },
    });

    const first = runChapterSwitch(deps, B); // 会卡在 gate 上
    const second = runChapterSwitch(deps, C); // 立刻完成

    const secondOutcome = await second;
    expect(secondOutcome.kind).toBe('switched');
    expect(applied).toEqual(['c']);

    // 现在才放行第一次
    gate.resolve(content('b'));
    const firstOutcome = await first;

    expect(firstOutcome).toEqual({ kind: 'superseded' });
    // 关键：第一次的结果**没有覆盖**第二次的
    expect(applied).toEqual(['c']);
  });

  it('被取代的那次不报错也不提交（用户根本没在等它）', async () => {
    const gate = deferred<ChapterContent>();
    const { deps, calls } = setup({
      readChapter: (chapterId) => {
        calls.push(`read:${chapterId}`);
        return chapterId === 'b' ? gate.promise : Promise.resolve(content(chapterId));
      },
    });

    const first = runChapterSwitch(deps, B);
    await runChapterSwitch(deps, C);

    gate.reject(new ApiError(ErrorCode.READ_FAILED, '磁盘炸了', 500));
    const firstOutcome: SwitchOutcome = await first;

    // 旧响应即使是失败也不该弹提示：那条提示会挂在一个用户已经离开的章节上
    expect(firstOutcome).toEqual({ kind: 'superseded' });
    expect(calls).not.toContain('apply:b');
  });
});

describe('runChapterSwitch —— 读取失败', () => {
  it('中断且不提交，原章内容不被破坏', async () => {
    const { deps, calls } = setup({
      readChapter: async () => {
        throw new ApiError('READ_FAILED', '读不出来', 500);
      },
    });

    const outcome = await runChapterSwitch(deps, B);

    expect(outcome).toEqual({ kind: 'failed', error: '读不出来', missing: false });
    expect(calls.some((c) => c.startsWith('apply:'))).toBe(false);
  });

  it('章节被外部删掉时标记 missing（调用方据此刷新列表）', async () => {
    const { deps } = setup({
      readChapter: async () => {
        throw new ApiError(ErrorCode.CHAPTER_NOT_FOUND, '章节不存在，请刷新章节列表。', 404);
      },
    });

    const outcome = await runChapterSwitch(deps, B);

    expect(outcome.kind).toBe('failed');
    expect(outcome.kind === 'failed' && outcome.missing).toBe(true);
  });

  it('非 ApiError 也能收敛成一句话', async () => {
    const { deps } = setup({
      readChapter: async () => {
        throw new Error('网络断了');
      },
    });

    const outcome = await runChapterSwitch(deps, B);

    expect(outcome.kind === 'failed' && outcome.error).toBe('网络断了');
  });
});
