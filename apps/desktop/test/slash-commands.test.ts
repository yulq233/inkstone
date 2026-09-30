/**
 * 斜杠指令元数据与过滤（`features/ai/slash-commands.ts`）。
 *
 * 护两件事：指令顺序（续写恒第一，因为它是最高频入口）与过滤口径
 * （空查询返回全集、中文标签匹配、英文 id 大小写不敏感）。
 */

import { describe, expect, it } from 'vitest';

import {
  SLASH_COMMANDS,
  filterSlashCommands,
} from '../src/renderer/src/features/ai/slash-commands';

describe('指令全集', () => {
  it('续写排第一，且带 Ctrl+Enter 快捷键提示', () => {
    expect(SLASH_COMMANDS[0]).toEqual({
      id: 'continue',
      label: '续写',
      shortcut: 'Ctrl+Enter',
    });
  });

  it('续写 + 7 个快捷 kind = 8 条，id 无重复', () => {
    expect(SLASH_COMMANDS).toHaveLength(8);
    const ids = SLASH_COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('每条指令都有非空 label（菜单要显示名字）', () => {
    for (const cmd of SLASH_COMMANDS) {
      expect(cmd.label.trim()).not.toBe('');
    }
  });
});

describe('过滤', () => {
  it('空查询返回全集（顺序不变）', () => {
    expect(filterSlashCommands('')).toEqual([...SLASH_COMMANDS]);
    expect(filterSlashCommands('   ')).toEqual([...SLASH_COMMANDS]);
  });

  it('中文标签匹配：敲「起」命中「起名」与「起标题」', () => {
    // 「起」同时命中 naming（起名）与 title（给这一章起标题），这是包含匹配的正确行为
    const result = filterSlashCommands('起');
    expect(result.map((c) => c.id)).toEqual(['naming', 'title']);
  });

  it('英文 id 匹配大小写不敏感', () => {
    expect(filterSlashCommands('naming').map((c) => c.id)).toEqual(['naming']);
    expect(filterSlashCommands('NAMING').map((c) => c.id)).toEqual(['naming']);
  });

  it('无匹配返回空数组', () => {
    expect(filterSlashCommands('zzz')).toEqual([]);
  });

  it('返回新数组但元素是共享引用（常量元数据，无副作用）', () => {
    const a = filterSlashCommands('');
    const b = filterSlashCommands('');
    expect(a).not.toBe(b);
    expect(a[0]).toBe(b[0]);
  });
});
