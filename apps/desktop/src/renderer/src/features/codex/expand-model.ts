/**
 * AI 扩充设定的纯逻辑（`docs/16` D-6 / D-7）。**零 React 依赖**，vitest 直接 import。
 *
 * ## 为什么 body 的"每次追加"要带一个 HTML 注释标记（D-7）
 *
 * `target=body` 的候选是**追加**到条目 `body` 末尾的（保住用户手写的草稿），
 * 而用户要能**只删掉某一次** AI 生成的内容、不碰手写草稿与其他次。锚定手段有三种，
 * 选 HTML 注释 `<!-- ai:<runId> -->` 是因为：
 *
 * - Markdown 渲染时注释**不可见** —— 追加进 body 后，任何地方读这段文本都不受影响；
 * - 不与 `frontmatter.py` 的 `---` 分隔符冲突（那是 frontmatter 的分隔，不是注释）；
 * - `runId` 是 `runs.jsonl` 外发记录的 id，**每次生成唯一**，所以"删除该次"能精确
 *   切到"这一次"，而不是"最近一次"或"包含某关键词的那些"。
 *
 * ## 已知的（可接受的）边界
 *
 * 如果用户**手写**的字里恰好出现 `<!-- ai:<某个 runId> -->`，它会被当成一次 AI 追加。
 * 这不值得为此换一套编码（如 UUID 前缀 + base64）：那种标记会让"用记事本看一眼 body"
 * 变成一堆天书，而这是本项目的核心卖点之一。低概率 + 只影响"多列一条可删段落"，可接受。
 */

import type { AiExpandTarget, CodexEntry } from '@inkstone/shared';

/** 产物目标 → 展示名（按钮与面板标题用）。 */
export const EXPAND_TARGET_LABELS: Record<AiExpandTarget, string> = {
  summary: '梗概',
  body: '描述',
};

/** 两个动作在 UI 上的按钮文案（"生成梗概" / "生成描述"）。 */
export const EXPAND_TARGET_BUTTONS: Record<AiExpandTarget, string> = {
  summary: '生成梗概',
  body: '生成描述',
};

/**
 * AI 追加标记的正则。**故意限制 runId 的字符集**（字母数字与 `_`/`-`）：
 * 它匹配的是我们自己写的标记，宽到"任意字符"只会让一个手滑写坏的反引号吞掉整段正文。
 *
 * 每次用都要新建（`lastIndex` 是可变状态）—— 模块级共享一个带 `g` 的正则会串味。
 */
const AI_MARKER_SOURCE = '<!--\\s*ai:([A-Za-z0-9_-]+)\\s*-->';

/** 一次 AI 生成追加到 body 的标记（D-7）。 */
export function aiBodyMarker(runId: string): string {
  return `<!-- ai:${runId} -->`;
}

/**
 * 把一次 AI 生成的正文**追加**到 body 末尾（保留已有内容）。
 *
 * 空 body 时只放标记 + 正文（不留一个开头的空行）；非空时用空行隔开，
 * 让手写草稿与 AI 段落视觉上分开。
 */
export function appendAiBody(body: string, runId: string, text: string): string {
  const block = `${aiBodyMarker(runId)}\n${text.trim()}`;
  const base = body.replace(/\s+$/, '');
  return base === '' ? block : `${base}\n\n${block}`;
}

/** body 里的一次 AI 追加段落。 */
export interface AiBodySegment {
  runId: string;
  text: string;
}

/**
 * 列出 body 里所有 AI 追加段落（供"删除该次"的 UI 渲染）。
 *
 * 一段的正文 = 它的标记之后、下一个标记之前（或 body 末尾）的全部内容。
 * 手写草稿（第一个标记之前的部分）**不算一段** —— 它不在候选里，也就不该有删除按钮。
 */
export function listAiBodySegments(body: string): AiBodySegment[] {
  const marks = collectMarks(body);
  return marks.map((mark, index) => {
    const stop = index + 1 < marks.length ? marks[index + 1].start : body.length;
    return { runId: mark.runId, text: body.slice(mark.end, stop).trim() };
  });
}

/**
 * 删掉某一次 AI 追加（D-7）：切掉它的标记到"下一个标记之前（或末尾）"的全部文本。
 *
 * `runId` 对不上时**原样返回**（不抛）：这条删除动作可能晚于一次外部改动到达，
 * 而"把用户的内容切错"远比"这次删除没生效"危险 —— 前者不可逆。
 */
export function removeAiBodySegment(body: string, runId: string): string {
  const marks = collectMarks(body);
  const index = marks.findIndex((mark) => mark.runId === runId);
  if (index === -1) return body;
  const start = marks[index].start;
  const stop = index + 1 < marks.length ? marks[index + 1].start : body.length;
  return joinBodyParts(body.slice(0, start), body.slice(stop));
}

/**
 * 一次 AI 追加段落的**单行预览**（"删除该次"列表里显示用）。
 *
 * 取第一行非空文字并截断 —— 直接用整段会把侧栏撑爆，而首行已经足够让用户认出
 * "这是哪一次生成的"。截断加省略号，避免看起来像"这段就这么短"。
 */
export function segmentPreview(text: string, max = 60): string {
  const line = text.split('\n').find((item) => item.trim() !== '') ?? '';
  const trimmed = line.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

interface Mark {
  runId: string;
  start: number;
  end: number;
}

function collectMarks(body: string): Mark[] {
  const re = new RegExp(AI_MARKER_SOURCE, 'g');
  const marks: Mark[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    marks.push({ runId: match[1], start: match.index, end: match.index + match[0].length });
  }
  return marks;
}

/**
 * 拼两段 body。中间最多留一个空行 —— 删掉中间一段之后，前后各自可能留下
 * `\n\n`，直接相接会变成三四个连续换行。**不删正文里原生的空行**：
 * 只有紧贴切口的那一串会被收拾。
 */
function joinBodyParts(before: string, after: string): string {
  const head = before.replace(/\s+$/, '');
  const tail = after.replace(/^\s+/, '');
  if (head === '') return tail;
  if (tail === '') return head;
  return `${head}\n\n${tail}`;
}

/**
 * 从一次展开的结果算出要写回条目的 `summary` / `body`（D-7）。
 *
 * - `summary` 直接替换（它本来就是"一段话"，追加没有意义）；
 * - `body` 追加（保住手写草稿）。
 */
export function applyExpandResult(
  entry: Pick<CodexEntry, 'summary' | 'body'>,
  target: AiExpandTarget,
  text: string,
  runId: string,
): { summary: string; body: string } {
  if (target === 'summary') {
    return { summary: text.trim(), body: entry.body };
  }
  return { summary: entry.summary, body: appendAiBody(entry.body, runId, text) };
}

/**
 * 构造 `POST /ai/expand` 的请求体。
 *
 * **只带 expand 需要的字段**：`chapterId` / `prefix` 之类一律不出现 —— sidecar 的
 * `AiExpandRequestIn` 是 `extra="forbid"`，回灌派生字段（slug/name）或续写字段
 * 会被 400（`docs/15` §6.6 的坑）。
 */
export function buildExpandRequest(
  workId: string,
  entry: Pick<CodexEntry, 'type' | 'slug'>,
  target: AiExpandTarget,
  intent: string,
): {
  workId: string;
  type: CodexEntry['type'];
  slug: string;
  target: AiExpandTarget;
  intent?: string;
} {
  const request: {
    workId: string;
    type: CodexEntry['type'];
    slug: string;
    target: AiExpandTarget;
    intent?: string;
  } = { workId, type: entry.type, slug: entry.slug, target };
  if (intent.trim() !== '') request.intent = intent.trim();
  return request;
}
