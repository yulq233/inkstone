/**
 * 冲突解决的三条路径（`06` 文档 §6.2）。
 *
 * ## 为什么单独成一个模块，而不是写在 `useAutosave` 里
 *
 * 这三条路径里有**两个"写错就静默毁掉用户内容"的点**：
 * 1. 「保留我的并覆盖」的 `baseHash` 必须取 `detail.diskHash` —— 用实例里那个旧 hash
 *    会再撞一次 409；而 `backup: true` 漏了，磁盘上那一版就彻底没了。
 * 2. 「另存副本」的**顺序不能反** —— 先重载当前章再写副本，一旦写副本失败，
 *    用户的内容既不在当前章、也不在副本里。
 *
 * 这两点靠"读代码时留神"是守不住的，必须能被测试断言。而渲染进程的测试环境是 node、
 * 没有 jsdom，挂在钩子里的逻辑一行都测不到。所以把编排抽成不依赖 React 的纯函数，
 * 让 `useAutosave` 只管把结果接回状态机。
 */

import type { ExternalModifiedDetail } from '@inkstone/shared';
import type { ApiClient } from '../../lib/api';

export type ConflictChoice = 'use-disk' | 'keep-mine' | 'save-as-copy';

/**
 * 当前情况下可用的选项。
 *
 * `detail === null`（服务端信封形状不对）时**不给「覆盖」**：覆盖需要 `diskHash`
 * 当 `baseHash`，没有它就只能瞎写一个，那是"可能盖错"的操作。
 * 宁可少给一个选项，也不做可能盖错的事（§6.1）。
 */
export function availableChoices(detail: ExternalModifiedDetail | null): ConflictChoice[] {
  if (detail === null) return ['use-disk', 'save-as-copy'];
  return ['use-disk', 'keep-mine', 'save-as-copy'];
}

/** 按钮文案与后果说明。集中在这里，让对话框与测试共用同一份事实。 */
export const CONFLICT_CHOICE_TEXT: Record<ConflictChoice, { label: string; hint: string }> = {
  'use-disk': {
    label: '用磁盘上的版本',
    // 必须说清"会丢什么"：点下去他的改动就从编辑器里消失了。
    hint: '丢弃我这边的改动，重新载入磁盘上的内容。',
  },
  'keep-mine': {
    label: '保留我的并覆盖',
    // §6.3 硬要求：这一句不能省。
    hint: '磁盘上的旧版本会先备份到 .inkstone/backups/，再写入我的内容。',
  },
  'save-as-copy': {
    label: '另存为新章节',
    hint: '我的内容写进一个新章节，当前章显示磁盘上的版本。',
  },
};

export interface ConflictContext {
  client: ApiClient;
  workId: string;
  chapterId: string;
  /** 冲突对话框拿到的磁盘版本信息；信封形状不对时为 null */
  detail: ExternalModifiedDetail | null;
  /**
   * 「我的版本」的正文。
   *
   * 由调用方**在点按钮的那一刻现取**（`getMarkdown()`），而不是用对话框打开时的快照 ——
   * 对话框打开后编辑器仍可编辑（§8），用快照会丢掉这几秒里敲的字。
   */
  mine: string;
  /** 当前章标题，用于「另存副本」的命名 */
  chapterTitle: string;
}

export interface ConflictResolution {
  /** 解决后状态机要接受的新基准 hash */
  hash: string;
  savedAt: string | null;
  /**
   * 服务端口径的字数，用于本地更新侧栏（`07` §4.2）。**可能为 null** ——
   * 「用磁盘版本」走 409 信封时不带字数（信封里只有 hash/内容/时间），
   * 而客户端不该自己算一个：服务端写 `meta.json` 用的是它自己的行级统计，
   * 两边各算一遍必然出现"界面显示 N 字、重启后变 N+1"这种没人能解释的现象。
   */
  wordCount: number | null;
  /** 覆盖发生时服务端返回的备份路径；其余情况为 null */
  backupPath: string | null;
  /** 「另存副本」新建出来的章节 id；其余为 null */
  copyChapterId: string | null;
  /**
   * 需要灌回编辑器的正文（磁盘版本）。`null` = 编辑器内容不用动。
   * 只对应「保留我的并覆盖」—— 那条路磁盘已经被我们写成一样了。
   */
  applyMarkdown: string | null;
}

export async function applyConflictChoice(
  choice: ConflictChoice,
  ctx: ConflictContext,
): Promise<ConflictResolution> {
  // 双保险：对话框只渲染可用选项，但函数本身也不接受不可用的那一个。
  if (!availableChoices(ctx.detail).includes(choice)) {
    throw new Error('这个选项在当前情况下不可用。');
  }

  if (choice === 'keep-mine') {
    const detail = ctx.detail;
    if (detail === null) throw new Error('缺少磁盘版本信息，无法覆盖。');

    // 刻意**不走** `Autosave`：它的 baseHash 还是冲突前那个旧值，用它写必然再撞 409。
    // 这条路直接调 API，成功后再用返回的新 hash 把状态机拉回来。
    const res = await ctx.client.writeChapter(ctx.workId, ctx.chapterId, {
      markdown: ctx.mine,
      baseHash: detail.diskHash,
      backup: true,
    });
    return {
      hash: res.hash,
      savedAt: res.savedAt,
      wordCount: res.wordCount,
      backupPath: res.backupPath,
      copyChapterId: null,
      applyMarkdown: null,
    };
  }

  if (choice === 'use-disk') {
    const disk = await readDiskVersion(ctx);
    return {
      hash: disk.hash,
      savedAt: disk.savedAt,
      wordCount: disk.wordCount,
      backupPath: null,
      copyChapterId: null,
      applyMarkdown: disk.markdown,
    };
  }

  // 「另存副本」：先把副本写成功，**再**动当前章。
  // 反过来的话，写副本一旦失败，用户的选择就落空了 —— 当前章已经变成磁盘版本，
  // 而他的内容两边都不在。
  const created = await ctx.client.createChapter(ctx.workId, {
    title: `${ctx.chapterTitle}-副本`,
  });
  // 新建的章只有摘要、没有 hash，而写入必须带 baseHash，所以先读一次拿到它。
  const copy = await ctx.client.readChapter(ctx.workId, created.id);
  await ctx.client.writeChapter(ctx.workId, created.id, {
    markdown: ctx.mine,
    baseHash: copy.hash,
  });

  const disk = await readDiskVersion(ctx);
  return {
    hash: disk.hash,
    savedAt: disk.savedAt,
    wordCount: disk.wordCount,
    backupPath: null,
    copyChapterId: created.id,
    applyMarkdown: disk.markdown,
  };
}

/**
 * 取磁盘当前版本。
 *
 * 优先用冲突信封里带的内容（服务端读磁盘时顺手带回来的，省一次往返）；
 * 信封形状不对（`detail === null`）时才真的去读一次 ——
 * 「用磁盘版本」这条路的语义本来就是"以磁盘为准"，读一次是最不会错的做法。
 *
 * 注意走信封时**拿不到字数**（`ExternalModifiedDetail` 里没有这个字段），
 * 所以 `wordCount` 是可空的；宁可让侧栏的数字晚一步更新，也不在客户端造一个。
 */
async function readDiskVersion(
  ctx: ConflictContext,
): Promise<{ markdown: string; hash: string; savedAt: string | null; wordCount: number | null }> {
  const detail = ctx.detail;
  if (detail !== null) {
    return {
      markdown: detail.diskMarkdown,
      hash: detail.diskHash,
      savedAt: detail.diskSavedAt,
      wordCount: null,
    };
  }
  const disk = await ctx.client.readChapter(ctx.workId, ctx.chapterId);
  return {
    markdown: disk.markdown,
    hash: disk.hash,
    savedAt: disk.savedAt,
    wordCount: disk.wordCount,
  };
}

/**
 * 冲突对话框里的预览截断。按**码点**切，不是按 UTF-16 码元 ——
 * 中文小说里 emoji 与生僻字（代理对）被从中间切开会显示成乱码方块。
 */
export function previewMarkdown(markdown: string, limit = 400): string {
  const points = Array.from(markdown);
  if (points.length <= limit) return markdown;
  return `${points.slice(0, limit).join('')}…`;
}
