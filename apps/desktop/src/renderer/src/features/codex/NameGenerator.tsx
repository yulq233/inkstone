/**
 * 起名器卡片（docs/15 D-6）。
 *
 * 纯本地抽签：点「再来一批」换候选；点某个名字 → 预填到「新建人物」表单。
 * 与清单里的现有人物名对照，撞名的候选会标出来（但不拦，用户可能就想用）。
 */

import { useCallback, useState } from 'react';
import type { CodexType } from '@inkstone/shared';
import { generateNames } from './name-generator';

interface Props {
  existingNames: ReadonlySet<string>;
  onCreate: (type: CodexType) => void;
}

export function NameGeneratorCard({ existingNames, onCreate }: Props) {
  const [candidates, setCandidates] = useState<string[]>([]);

  const roll = useCallback(() => {
    setCandidates(generateNames(6, Math.random, existingNames).map((c) => c.name));
  }, [existingNames]);

  return (
    <div className="name-gen">
      <div className="name-gen-header">
        <span className="codex-title">起名器</span>
        <button type="button" className="linkish" onClick={roll}>
          再来一批
        </button>
      </div>
      {candidates.length === 0 ? (
        <div className="codex-empty">点「再来一批」随机抽几个名字。</div>
      ) : (
        <div className="name-gen-list">
          {candidates.map((name) => (
            <button
              key={name}
              type="button"
              className="name-gen-item"
              onClick={() => onCreate('character')}
            >
              {name}
              {existingNames.has(name) ? <span className="name-gen-dup">（已有）</span> : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
