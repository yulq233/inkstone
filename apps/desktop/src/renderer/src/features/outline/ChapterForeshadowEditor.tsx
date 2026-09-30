/**
 * 章纲内的伏笔登记编辑器（docs/15 B4）。
 *
 * 伏笔住在章纲 frontmatter（D-5），登记动作发生在"写某章的纲"时。本组件是章纲
 * 编辑视图里的一个子区域：编辑**当前章**的伏笔列表。跨章清单与超期提醒走
 * `ForeshadowList`（扫描聚合），这里只做本章的登记增删改。
 *
 * 编辑态是本地 state，随章纲的「保存」一起 PUT（`saveChapterOutline` 把 foreshadow
 * 一并提交）——伏笔不是独立落盘，改完章纲点保存才生效。
 */

import { useCallback } from 'react';
import type { Foreshadow } from '@inkstone/shared';

export interface ForeshadowDraft extends Omit<Foreshadow, 'expectResolveBy'> {
  /** 期望回收卷序号（数字输入，空 = 无限期）。 */
  expectResolveBy: number | null;
}

interface Props {
  items: ForeshadowDraft[];
  onChange: (items: ForeshadowDraft[]) => void;
  /** 已存在的最大卷序号，用于提示"期望回收卷"的取值范围。 */
  maxVolume: number;
}

export function ChapterForeshadowEditor({ items, onChange, maxVolume }: Props) {
  const patch = useCallback(
    (id: string, update: Partial<ForeshadowDraft>) => {
      onChange(items.map((it) => (it.id === id ? { ...it, ...update } : it)));
    },
    [items, onChange],
  );

  const add = useCallback(() => {
    onChange([
      ...items,
      {
        id: `draft_${Date.now()}`,
        title: '',
        expectResolveBy: null,
        status: 'open',
        resolvedIn: null,
      },
    ]);
  }, [items, onChange]);

  const remove = useCallback(
    (id: string) => {
      onChange(items.filter((it) => it.id !== id));
    },
    [items, onChange],
  );

  return (
    <div className="foreshadow-editor">
      <div className="foreshadow-editor-head">
        <span className="outline-section-title">伏笔</span>
        <button type="button" className="linkish" onClick={add}>
          + 登记伏笔
        </button>
      </div>

      {items.length === 0 ? (
        <div className="outline-empty">本章还没有登记伏笔。</div>
      ) : (
        <ul className="foreshadow-edit-list">
          {items.map((it) => (
            <li key={it.id} className="foreshadow-edit-item">
              <div className="foreshadow-edit-row">
                <input
                  className="foreshadow-edit-title"
                  value={it.title}
                  placeholder="伏笔内容（例如：旧宅地窖里那半封信）"
                  onChange={(e) => patch(it.id, { title: e.target.value })}
                />
                <button type="button" className="linkish danger" onClick={() => remove(it.id)}>
                  ×
                </button>
              </div>
              <div className="foreshadow-edit-row">
                <label className="foreshadow-edit-field">
                  <span>期望回收卷</span>
                  <input
                    type="number"
                    min={1}
                    value={it.expectResolveBy ?? ''}
                    placeholder={maxVolume > 0 ? `1~${maxVolume}，留空=无限期` : '留空=无限期'}
                    onChange={(e) => {
                      const raw = e.target.value;
                      const n = raw === '' ? null : Number(raw);
                      patch(it.id, {
                        expectResolveBy: n !== null && Number.isFinite(n) && n >= 1 ? n : null,
                      });
                    }}
                  />
                </label>
                <label className="foreshadow-edit-field">
                  <span>状态</span>
                  <select
                    value={it.status}
                    onChange={(e) =>
                      patch(it.id, { status: e.target.value as ForeshadowDraft['status'] })
                    }
                  >
                    <option value="open">未回收</option>
                    <option value="resolved">已回收</option>
                    <option value="dropped">已放弃</option>
                  </select>
                </label>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
