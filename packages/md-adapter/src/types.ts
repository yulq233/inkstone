/** 适配层的公开类型。放在单独文件是为了避免 index 与实现互相 import 造成环。 */

import type { Node as PMNode } from 'prosemirror-model';

/**
 * 降级告警。
 *
 * 存在的唯一理由：**绝不静默改变用户内容**。凡是白名单外的语法被当成纯文本处理，
 * 都要在这里留下痕迹，由界面提示用户。
 */
export interface AdapterWarning {
  /** DEGRADED_BLOCK：整块结构被降级；UNSUPPORTED_INLINE：行内标记被忽略 */
  code: 'DEGRADED_BLOCK' | 'UNSUPPORTED_INLINE';
  message: string;
  /** 原文字符偏移（含） */
  from: number;
  /** 原文字符偏移（不含） */
  to: number;
}

export interface FromMdResult {
  doc: PMNode;
  warnings: AdapterWarning[];
}

export interface ToMdResult {
  markdown: string;
  warnings: AdapterWarning[];
}

/** 文档里出现的一段文本及其标记，序列化时的中间表示。 */
export interface FlatText {
  text: string;
  marks: string[];
}
