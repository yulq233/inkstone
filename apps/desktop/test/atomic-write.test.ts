/**
 * 原子写的**顺序**（`docs/13` M16）。
 *
 * 这里唯一的断言对象是"第几步在第几步之前" —— 而它恰恰是这段代码唯一的正确性来源：
 * 少了 `writeDurable`（fsync），掉电后拿到的是一个**名字正确、内容为空**的文件，
 * 比"直接写坏"更难查，因为文件看上去是存在的。
 *
 * 用假 IO 记录调用序列，而不是真的写盘：真实实现（`atomic-write.ts`）是唯一碰
 * `node:fs` 的地方，测试环境（`tsconfig.web.json`）加载不了 node 内建模块。
 */

import { describe, expect, it } from 'vitest';
import { atomicWriteFileSync, type AtomicWriteIo } from '../src/main/store/atomic-write-core';

/** 只记"谁被调了、参数是什么"的假实现。 */
function recordingIo(failOn?: keyof AtomicWriteIo): { io: AtomicWriteIo; calls: string[] } {
  const calls: string[] = [];
  const io: AtomicWriteIo = {
    mkdir: (dir) => {
      calls.push(`mkdir ${dir}`);
      if (failOn === 'mkdir') throw new Error('mkdir 失败');
    },
    writeDurable: (file, data) => {
      calls.push(`writeDurable ${file} ${data}`);
      if (failOn === 'writeDurable') throw new Error('写入失败');
    },
    rename: (from, to) => {
      calls.push(`rename ${from} -> ${to}`);
      if (failOn === 'rename') throw new Error('rename 失败');
    },
    syncDir: (dir) => {
      calls.push(`syncDir ${dir}`);
      if (failOn === 'syncDir') throw new Error('目录 fsync 失败');
    },
  };
  return { io, calls };
}

const target = { file: '/d/settings.json', tmp: '/d/settings.json.tmp', dir: '/d' };

describe('atomicWriteFileSync', () => {
  it('顺序是 建目录 → 写完落盘 → rename → 刷目录', () => {
    const { io, calls } = recordingIo();
    atomicWriteFileSync(target, '{"a":1}\n', io);

    expect(calls).toEqual([
      'mkdir /d',
      'writeDurable /d/settings.json.tmp {"a":1}\n',
      'rename /d/settings.json.tmp -> /d/settings.json',
      'syncDir /d',
    ]);
  });

  it('落盘必须发生在 rename 之前', () => {
    const { io, calls } = recordingIo();
    atomicWriteFileSync(target, 'x', io);

    // 这条断言就是本次修复的内容：以前是"写完直接 rename"，
    // 中间那一步（把内容刷到介质）不在。
    expect(calls.indexOf('writeDurable /d/settings.json.tmp x')).toBeLessThan(
      calls.indexOf('rename /d/settings.json.tmp -> /d/settings.json'),
    );
  });

  it('写临时文件失败时不 rename（目标文件保持原样）', () => {
    const { io, calls } = recordingIo('writeDurable');
    expect(() => atomicWriteFileSync(target, 'x', io)).toThrow('写入失败');
    expect(calls.some((call) => call.startsWith('rename'))).toBe(false);
  });

  it('目录 fsync 失败会传出去 —— 是否容忍由实现决定，不由这里悄悄决定', () => {
    const { io } = recordingIo('syncDir');
    expect(() => atomicWriteFileSync(target, 'x', io)).toThrow('目录 fsync 失败');
  });
});
