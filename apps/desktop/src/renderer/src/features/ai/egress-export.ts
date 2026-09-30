/**
 * 外发记录面板的纯逻辑（`docs/11` §6.7 的「外发记录」）。
 *
 * ## 这里只管"怎么把一个记录表变成文件"，不碰数据怎么来
 *
 * 数据来自 `GET /ai/runs`（`ApiClient.listAiRuns`），展示与导出都在这一层之上。
 * 把 CSV / JSON 序列化抽成纯函数，是因为"CSV 里要不要带表头""中文怎么编码"
 * "逗号/引号怎么转义"这几件事**手写必错**，值得单测钉住 —— 而导出的正确性
 * 恰恰是用户最可能较真的（他会把 CSV 打开来看）。
 *
 * ## CSV 的编码
 *
 * 导出带 **UTF-8 BOM**。没有 BOM 的话，Windows 的 Excel 会按本机 ANSI（GBK）解码，
 * 中文全是乱码 —— 这是"功能明明对了、用户一看就以为坏了"的典型。BOM 就是
 * 告诉 Excel"这是 UTF-8"的那个信号。
 */

import type { AiRun } from '@inkstone/shared';

/** CSV 列（与 `AiRun` 的展示字段对齐，顺序即列顺序）。 */
const CSV_HEADERS = [
  '时间',
  '任务',
  '提供方',
  '模型',
  '外发字符',
  '上下文token',
  '输出token',
  '估算成本(元)',
  '首字延迟(ms)',
  '总耗时(ms)',
  '停止',
  '采纳',
] as const;

function runRow(run: AiRun): string[] {
  return [
    run.at,
    run.taskType,
    run.providerId,
    run.model,
    String(run.egressChars),
    String(run.contextTokens),
    String(run.outputTokens),
    run.costCny === null ? '' : String(run.costCny),
    String(run.firstTokenMs),
    String(run.latencyMs),
    run.stopped ? '是' : '否',
    run.accepted ?? '',
  ];
}

/** 把一个单元格转成 CSV 安全形式：含逗号/引号/换行时加引号并转义。 */
function csvCell(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/** 把记录表序列化成 CSV 文本（**带 UTF-8 BOM**，见文件头）。 */
export function runsToCsv(runs: readonly AiRun[]): string {
  const lines = [CSV_HEADERS.join(','), ...runs.map((run) => runRow(run).map(csvCell).join(','))];
  // \uFEFF 是 BOM。用字符串拼而不是编码层加，是为了让这个函数保持"纯字符串进、
  // 纯字符串出"，下载时再由调用方 `new Blob([...])` 处理编码。
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/** 把记录表序列化成 JSON 文本（缩进 2，便于人直接读）。 */
export function runsToJson(runs: readonly AiRun[]): string {
  return JSON.stringify(runs, null, 2);
}

/**
 * 触发浏览器下载一个文本文件。
 *
 * 用 Blob URL 而不是 `data:` URL：大文件下 `data:` 会撑爆内存与地址栏限制。
 * `URL.revokeObjectURL` 在下一轮事件循环回收，让浏览器有机会先开始下载。
 */
export function downloadText(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  // 触发点击后立刻移除：不留一个游离的 anchor 在文档里
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
