import { useState } from 'react';
import type { WordCount } from '@inkstone/shared';

interface WordCountBarProps {
  /** null = 正文还没载入 */
  count: WordCount | null;
}

/**
 * 双口径字数条（WS5.5）。
 *
 * 默认显示**不含标点** —— 这是网文平台的习惯口径，也是 sidecar 写进 `meta.json`
 * 的那个数（`countWordsDefault`）。两者必须是同一个数，否则会出"界面显示 N 字、
 * 重启后变 N+1"这种没人能解释的现象。
 *
 * 刻意**不**自己算字数：数字由上层用 `countWords` 算好传进来，保证全应用只有一个实现。
 */
export function WordCountBar({ count }: WordCountBarProps) {
  const [withPunct, setWithPunct] = useState(false);

  if (count === null) {
    return (
      <div className="wordcount-bar">
        <span className="hint">字数 —</span>
      </div>
    );
  }

  const value = withPunct ? count.withPunct : count.withoutPunct;

  return (
    <div className="wordcount-bar">
      <span className="wordcount-value">{formatCount(value)}</span>
      <span className="hint">字</span>
      <button
        type="button"
        className="linkish"
        onClick={() => setWithPunct((prev) => !prev)}
        title={withPunct ? '点此改为「不含标点」' : '点此改为「含标点」'}
      >
        {withPunct ? '含标点' : '不含标点'}
      </button>
    </div>
  );
}

/** 中文习惯的千分位（`1842` → `1,842`）。不依赖 locale，免得跟着系统语言变。 */
function formatCount(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
