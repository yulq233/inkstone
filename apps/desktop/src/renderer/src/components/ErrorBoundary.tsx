import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

export interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
  /** React 给的组件栈。与 `error.stack` **分开存**：JS 栈只说了哪个文件哪一行，指不出是哪个组件 */
  componentStack: string;
}

/**
 * 界面崩溃的兜底（2026-09-28 白屏事故）。
 *
 * ## 它解决的是什么
 *
 * 那次新建作品后整个界面变白，**连 header 和侧栏都不剩**。原因不是某个组件渲染成空，
 * 而是：渲染期一抛，React 19 在**没有错误边界**时会卸载整棵根 —— 于是 DOM 里一个节点
 * 都不剩，用户看到的是一块没有任何提示的白。这类故障最贵的地方在于它**什么都不说**。
 *
 * 装上它之后，同一个异常会变成一张写明原因和栈的卡片。
 *
 * ## 为什么日志走 `console.error`
 *
 * 主进程在 `main/renderer-diagnostics.ts` 里把渲染进程的 `warning` / `error` 转发到
 * 终端，所以这里**必须用 `console.error`**，而不是自己想办法写文件 —— 另开一条通道
 * 等于绕开统一入口，下次出问题又要多找一个地方。
 *
 * ## 边界划在哪
 *
 * 划在 `App.tsx` 里、包住整棵界面（`StatusBanner` / 会话 / `SettingsPanel`）。
 * 不更细是有意的：这个应用的各块界面共享会话状态，一块崩了另几块大概率也不可用，
 * 让用户看着一个"半活的"界面去描述症状，比一张说清了原因的卡片更难处理。
 *
 * ## 它管不到什么
 *
 * 只管**渲染期、生命周期与构造函数**里抛出的异常。事件回调、`setTimeout`、
 * Promise 拒绝都不经过 → 那些由 `main.tsx` 里的全局监听兜底。
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null, componentStack: '' };
  }

  /** 只更新状态：它必须是纯的，副作用归下面的 `componentDidCatch` */
  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // `info.componentStack` 的类型是 `string | undefined`（React 在拿不到组件栈时给 undefined），
    // 所以要先收敛成字符串再进状态 —— 状态里那个字段刻意不是可空的。
    const stack = info.componentStack ?? '';
    if (this.state.componentStack === '' && stack !== '') {
      this.setState({ componentStack: stack });
    }
    console.error(
      `[inkstone] 界面渲染失败：${error.name}: ${error.message}\n${stack === '' ? '(无组件栈)' : stack}`,
    );
  }

  override render(): ReactNode {
    const { error, componentStack } = this.state;
    // 没出错时原样透传：只返回 children，不额外包一层 DOM —— 否则崩溃前后的布局会不一样
    if (error === null) return this.props.children;

    const detail = [
      `${error.name}: ${error.message}`,
      '',
      error.stack ?? '(无 JS 栈)',
      '',
      '--- 组件栈 ---',
      componentStack === '' ? '(未捕获到组件栈)' : componentStack,
    ].join('\n');

    return (
      <div className="center-stage">
        <div className="card">
          <div className="row" style={{ marginBottom: 8 }}>
            <h1>界面出错了</h1>
            <span className="pill bad">已停止渲染</span>
          </div>
          <p>
            刚才这一步让界面崩溃了。为避免只留给你一片空白，下面写出原因 ——
            作品文件没有被动过，重新加载即可继续。
          </p>
          <div className="logbox">{detail}</div>
          <div className="actions">
            {/*
              用 `location.reload()` 而不是给主进程加一条 IPC：整页重载会丢掉内存里的会话，
              正好回到"没有打开作品"的干净状态，而这正是从崩溃里出来最想要的结果。
              主进程的 `will-navigate` 已经放行"URL 与当前完全相同"的导航，
              所以生产态（`file://`）也不会被它自己拦掉 —— 见 `window.ts` 的注释。
            */}
            <button type="button" onClick={() => window.location.reload()}>
              重新加载界面
            </button>
          </div>
          <div className="note">
            这一条已经写进终端日志（前缀 <code>[renderer]</code>）。排查时可以把它连同
            <code>%APPDATA%\砚台\logs\</code> 一起带上。
          </div>
        </div>
      </div>
    );
  }
}
