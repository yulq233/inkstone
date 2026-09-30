import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/global.css';

/**
 * 全局兜底：错误边界管不到的那些异常（事件回调、`setTimeout`、Promise 拒绝）。
 *
 * 它只做一件事 —— 让这些异常**落到 `console.error`**。主进程会把渲染进程的
 * `error` / `warning` 转发到终端（`main/renderer-diagnostics.ts`），所以走 console
 * 就等于进了日志。这也是白屏事故欠下的账：当时页面全白，终端里却一个字节都没有，
 * 完全无从查起 —— 而现在只需要看一眼跑 `pnpm dev` 的那个终端窗口。
 *
 * 注册在 `createRoot` **之前**：挂载阶段抛的异常同样要留痕。
 *
 * 资源加载失败（图片 404 之类）**不会**走到这里 —— 它们不冒泡。
 */
window.addEventListener('error', (event) => {
  console.error(`[inkstone] 未捕获错误：${event.message}（${event.filename}:${event.lineno}）`);
});

window.addEventListener('unhandledrejection', (event) => {
  // 先收成 `unknown` 再分支：Promise 的拒绝值可以是任何东西，
  // 直接拼字符串会把 Error 的栈丢掉，而排障要的正是那个栈。
  const reason: unknown = event.reason;
  const text =
    reason instanceof Error
      ? `${reason.name}: ${reason.message}\n${reason.stack ?? '(无栈)'}`
      : String(reason);
  console.error(`[inkstone] 未处理的 Promise 拒绝：${text}`);
});

const container = document.getElementById('root');
if (!container) {
  throw new Error('找不到挂载点 #root');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
