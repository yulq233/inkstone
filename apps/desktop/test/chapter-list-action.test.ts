/**
 * 章节列表加载动作的单测（`docs/13` M21）。
 *
 * 症状是**列表闪空**：sidecar 重启期间 `client` 短暂为 null，如果那一遍
 * 按"没有 client 就当没有作品"处理，侧栏会闪成「这部作品还没有章节。」+
 * 「新建章节」按钮 —— 用户的第一反应是稿子被删了。
 *
 * 这个判断原本埋在钩子的 `load()` 里，而渲染进程的测试环境是 node、没有 jsdom，
 * 钩子里的状态迁移一行都测不到。所以把**判断**抽出来钉住。
 */

import { describe, expect, it } from 'vitest';

import { decideChapterListAction } from '../src/renderer/src/features/chapter/chapter-list';

describe('这次该对章节列表做什么', () => {
  it('没打开作品 → 清空（不管有没有 client）', () => {
    expect(decideChapterListAction(null, false)).toBe('clear');
    expect(decideChapterListAction(null, true)).toBe('clear');
  });

  it('开着作品、sidecar 暂时不在 → 保留，**绝不清空**', () => {
    // 这一条就是 M21 的修复本体。列出这行的存在本身比断言值更重要：
    // 谁将来把它改回 'clear'，侧栏就会重新闪空。
    expect(decideChapterListAction('w-1', false)).toBe('keep');
  });

  it('正常 → 去拉一份新的', () => {
    expect(decideChapterListAction('w-1', true)).toBe('fetch');
  });

  it('判据是作品身份而不是"有没有 client"：作品在，列表就不该消失', () => {
    // 同一部作品在有/无 client 两个瞬间，都不该走到 clear。
    for (const hasClient of [false, true]) {
      expect(decideChapterListAction('w-1', hasClient)).not.toBe('clear');
    }
  });
});
