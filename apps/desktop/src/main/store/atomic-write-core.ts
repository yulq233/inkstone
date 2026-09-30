/**
 * 原子写的**纯逻辑**：只描述顺序，不碰文件系统（`docs/13` M16）。
 *
 * ## 为什么顺序才是重点
 *
 * 「先写临时文件再 rename」这个做法本身是对的，**但少了落盘那一步**：
 * `writeFileSync` 只把数据交给操作系统（页缓存），`rename` 只是改了个目录项 ——
 * 两者都可能还在内存里。断电/蓝屏之后拿到的是一个**名字正确、内容为空或半截**的文件，
 * 而它比"直接写坏"更难查，因为下一次启动看起来"文件明明是有的"。
 *
 * 所以正确顺序是：
 * 1. 建目录；
 * 2. 写临时文件，**并在返回前把它刷到介质上**（`fsync`）；
 * 3. `rename` 覆盖目标（同目录内的 rename 是原子的）；
 * 4. 刷父目录 —— 让"第 3 步这个改动本身"也落盘（尽力而为，见下）。
 *
 * ## 为什么 IO 走注入而不是直接 import `node:fs`
 *
 * 这个文件**不能** import `node:fs`：测试文件归 `tsconfig.web.json`（`types: ["vite/client"]`，
 * 没有 node 类型），一旦带上 node 依赖，测试就跑不起来 —— 而"顺序有没有写对"
 * 恰恰是这一段唯一值得断言的东西。真实实现（`atomic-write.ts`）是唯一碰 `node:fs` 的地方。
 */

export interface AtomicWriteIo {
  /** 建目录（递归、已存在不报错） */
  mkdir(dir: string): void;
  /** 写临时文件，并且**在返回前确保内容已落到介质上**（不是还在页缓存里） */
  writeDurable(file: string, data: string): void;
  /** 同目录内改名覆盖。跨目录/跨设备**不是**原子操作，调用方要保证同目录 */
  rename(from: string, to: string): void;
  /**
   * 刷父目录。
   *
   * POSIX 上 `rename` 这个动作本身也要落盘才算数，所以第 4 步不是洁癖；
   * 但 Windows 根本打不开目录句柄（`EISDIR`/`EPERM`），所以它是**尽力而为**：
   * 失败必须被忽略，而不是让一次正常的保存失败。
   */
  syncDir(dir: string): void;
}

/**
 * 一次原子写的三个路径。
 *
 * 刻意让调用方把 `dir` 一起传进来：这个文件不 import `node:path`，
 * 而 `dirname` 自己手写一遍（还要照顾 `\` 与 `/`）是白送一个 bug 进来。
 * 调用方本来就有完整路径，多传一个字段而已。
 */
export interface AtomicWriteTarget {
  /** 最终目标文件 */
  readonly file: string;
  /** 同目录的临时文件 */
  readonly tmp: string;
  /** `file` 所在目录；不存在时会被创建 */
  readonly dir: string;
}

export function atomicWriteFileSync(
  target: AtomicWriteTarget,
  data: string,
  io: AtomicWriteIo,
): void {
  io.mkdir(target.dir);
  io.writeDurable(target.tmp, data);
  io.rename(target.tmp, target.file);
  io.syncDir(target.dir);
}
