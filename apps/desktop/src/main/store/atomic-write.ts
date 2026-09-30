/**
 * 原子写的真实实现（`docs/13` M16）。
 *
 * 顺序与理由见 `atomic-write-core.ts`；这里只负责把它接到 `node:fs` 上。
 * 单独一个文件是为了让"顺序"那部分能被单测覆盖（那边一行 node 都不 import）。
 */

import fs from 'node:fs';
import {
  atomicWriteFileSync,
  type AtomicWriteIo,
  type AtomicWriteTarget,
} from './atomic-write-core';

export const nodeAtomicWriteIo: AtomicWriteIo = {
  mkdir(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
  },

  /**
   * 用 fd 写而不是 `writeFileSync(path, …)`：只有拿到 fd 才能 `fsync`。
   * 这正是本次修复要补的那一步 —— 少了它，`rename` 之后磁盘上可能什么都没有。
   */
  writeDurable(file: string, data: string): void {
    const fd = fs.openSync(file, 'w');
    try {
      fs.writeFileSync(fd, data, { encoding: 'utf8' });
      fs.fsyncSync(fd);
    } finally {
      // 即使 fsync 抛了也要关掉 fd，否则这个进程会一直漏句柄
      fs.closeSync(fd);
    }
  },

  rename(from: string, to: string): void {
    fs.renameSync(from, to);
  },

  syncDir(dir: string): void {
    // Windows 上 `fs.openSync(dir, 'r')` 必然失败（目录不能当文件打开）→ 直接跳过，
    // 不必每一次保存都去撞一次异常。
    if (process.platform === 'win32') return;
    let fd: number | null = null;
    try {
      fd = fs.openSync(dir, 'r');
      fs.fsyncSync(fd);
    } catch {
      // 有些文件系统（部分网络盘、FUSE）不支持目录 fsync。忽略 —— 它只是"更保险"，
      // 不是这次保存成功与否的条件。
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  },
};

/** 便捷入口：调用方只需要关心"写哪三个路径"与"写什么"。 */
export function writeFileAtomicallySync(target: AtomicWriteTarget, data: string): void {
  atomicWriteFileSync(target, data, nodeAtomicWriteIo);
}
