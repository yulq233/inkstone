/**
 * 大纲面板（docs/15 B4）—— 总纲 / 卷纲 / 章纲 / 伏笔 四块，侧栏 tab 内再次分层。
 *
 * 信息架构：侧栏窄，用**视图切换**而不是并排。顶部一条「总纲 | 卷纲 | 章纲 | 伏笔」
 * 的二级 tab，各自占满 pane：
 * - 总纲：单例纯正文，一个 OutlineEditor；
 * - 卷纲：清单（可新建/上移/下移/删除）→ 点进单卷编辑（正文 + 标题）；
 * - 章纲：当前章的纲 = 正文编辑器 + 伏笔登记（ChapterForeshadowEditor）；
 * - 伏笔：跨章扫描聚合的清单 + 超期/孤儿提醒（ForeshadowList）。
 *
 * ⚠️ 与 use-codex 同口径：保存失败（尤其 409）响亮报错；低频结构化编辑不做自动保存。
 * 章纲跟「当前章」走（use-outline 的 chapterId），切章时本面板自动换到新章。
 */

import { useCallback, useMemo, useState } from 'react';
import type { ChapterOutline, VolumeOutline } from '@inkstone/shared';
import { describeApiError } from '../../lib/api';
import { ChapterForeshadowEditor, type ForeshadowDraft } from './ChapterForeshadowEditor';
import { ForeshadowList } from './ForeshadowList';
import { OutlineEditor } from './OutlineEditor';
import { sortVolumes } from './outline-model';
import type { UseOutlineResult } from './use-outline';

type OutlineTab = 'general' | 'volumes' | 'chapter' | 'foreshadow';

interface Props {
  outline: UseOutlineResult;
  /** 当前章 id（用于判断章纲是否对应当前章，避免切章瞬间显示上一章的纲）。 */
  chapterId: string | null;
}

export function OutlinePanel({ outline, chapterId }: Props) {
  const [tab, setTab] = useState<OutlineTab>('general');

  return (
    <div className="outline-panel">
      <div className="outline-tabs" role="tablist">
        <TabButton active={tab === 'general'} label="总纲" onClick={() => setTab('general')} />
        <TabButton active={tab === 'volumes'} label="卷纲" onClick={() => setTab('volumes')} />
        <TabButton active={tab === 'chapter'} label="章纲" onClick={() => setTab('chapter')} />
        <TabButton
          active={tab === 'foreshadow'}
          label="伏笔"
          onClick={() => setTab('foreshadow')}
        />
      </div>

      {outline.error === null ? null : (
        <div className="outline-error" role="alert">
          {outline.error}
        </div>
      )}

      <div className="outline-tab-body">
        {tab === 'general' ? <GeneralView outline={outline} /> : null}
        {tab === 'volumes' ? <VolumesView outline={outline} /> : null}
        {tab === 'chapter' ? <ChapterView outline={outline} chapterId={chapterId} /> : null}
        {tab === 'foreshadow' ? <ForeshadowView outline={outline} /> : null}
      </div>
    </div>
  );
}

function TabButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={active ? 'outline-tab active' : 'outline-tab'}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// 总纲
// ---------------------------------------------------------------------------

function GeneralView({ outline }: { outline: UseOutlineResult }) {
  const general = outline.general;
  if (outline.loading && general === null) {
    return <div className="outline-empty">加载中…</div>;
  }
  return (
    <OutlineEditor
      key="general"
      value={general?.body ?? ''}
      hash={general?.hash ?? ''}
      placeholder="还没写总纲。这里写整本书的主线、世界观、冲突……"
      onSave={outline.saveGeneral}
    />
  );
}

// ---------------------------------------------------------------------------
// 卷纲
// ---------------------------------------------------------------------------

function VolumesView({ outline }: { outline: UseOutlineResult }) {
  // 编辑态存「全量卷」（含 body）。清单项不含 body，点进编辑时事件处理器里读全量。
  const [editing, setEditing] = useState<VolumeOutline | null>(null);
  const [loadingVolume, setLoadingVolume] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const sorted = useMemo(() => sortVolumes(outline.volumes), [outline.volumes]);

  const openVolume = useCallback(
    async (order: number) => {
      setLoadingVolume(true);
      setLoadError(null);
      try {
        setEditing(await outline.readVolume(order));
      } catch (err) {
        setLoadError(describeApiError(err));
      } finally {
        setLoadingVolume(false);
      }
    },
    [outline],
  );

  if (editing !== null) {
    return (
      <VolumeEdit
        key={editing.order}
        volume={editing}
        outline={outline}
        onBack={() => setEditing(null)}
      />
    );
  }

  return (
    <div className="outline-list-view">
      <div className="outline-toolbar">
        <span className="outline-title">卷纲</span>
        <button type="button" className="linkish" onClick={() => void outline.createVolume('', '')}>
          + 新建卷
        </button>
      </div>

      {loadError === null ? null : (
        <div className="outline-error" role="alert">
          {loadError}
        </div>
      )}

      {loadingVolume ? (
        <div className="outline-empty">加载中…</div>
      ) : sorted.length === 0 ? (
        <div className="outline-empty">还没有卷。点「新建卷」开始搭骨架。</div>
      ) : (
        <ul className="outline-list">
          {sorted.map((volume) => (
            <li key={volume.order} className="outline-list-item">
              <button
                type="button"
                className="outline-list-main"
                onClick={() => void openVolume(volume.order)}
              >
                <span className="outline-list-name">
                  第 {volume.order} 卷 · {volume.title || '（未命名）'}
                </span>
              </button>
              <div className="outline-list-actions">
                <button
                  type="button"
                  className="linkish"
                  disabled={volume.order === 1}
                  onClick={() => void outline.moveVolume(volume.order, 'up')}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="linkish"
                  disabled={volume.order === sorted.length}
                  onClick={() => void outline.moveVolume(volume.order, 'down')}
                >
                  ↓
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function VolumeEdit({
  volume,
  outline,
  onBack,
}: {
  volume: VolumeOutline;
  outline: UseOutlineResult;
  onBack: () => void;
}) {
  const [title, setTitle] = useState(volume.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 卷纲的正文用 OutlineEditor（它内部管理自己的保存态），标题单独一个输入框。
  // 保存时两者一起 PUT。这里不管保存的 busy，只负责把错误接住展示。
  const saveVolume = async (body: string, ifMatch: string) => {
    setError(null);
    try {
      await outline.saveVolume(volume.order, {
        title: title.trim() || volume.title,
        body,
        ifMatch,
      });
    } catch (err) {
      setError(describeApiError(err));
    }
  };

  const remove = async () => {
    if (!window.confirm(`确定删除「第 ${volume.order} 卷」吗？此操作不可撤销。`)) return;
    setBusy(true);
    setError(null);
    try {
      await outline.deleteVolume(volume.order);
      onBack();
    } catch (err) {
      setError(describeApiError(err));
      setBusy(false);
    }
  };

  return (
    <div className="outline-panel">
      <div className="outline-toolbar">
        <button type="button" className="linkish" onClick={onBack}>
          ← 返回
        </button>
        <span className="outline-title">第 {volume.order} 卷</span>
        <button
          type="button"
          className="linkish danger"
          disabled={busy}
          onClick={() => void remove()}
        >
          删除
        </button>
      </div>
      {error === null ? null : (
        <div className="outline-error" role="alert">
          {error}
        </div>
      )}
      <label className="outline-field">
        <span>卷标题</span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="例如：风起云京"
        />
      </label>
      <OutlineEditor
        value={volume.body}
        hash={volume.hash}
        placeholder="这一卷要讲什么……"
        onSave={saveVolume}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 章纲
// ---------------------------------------------------------------------------

function ChapterView({
  outline,
  chapterId,
}: {
  outline: UseOutlineResult;
  chapterId: string | null;
}) {
  const chapter = outline.chapter;

  // 切章瞬间 `chapter` 还是上一章的纲（loadChapter 还没回来），用 chapterId 对不上
  // 就显示加载态，避免把上一章的纲显示成当前章的。
  if (chapterId === null) {
    return <div className="outline-empty">尚未选择章节。先在「章节」tab 里选一章。</div>;
  }
  if (chapter === null || chapter.chapterId !== chapterId) {
    return <div className="outline-empty">加载章纲…</div>;
  }

  return <ChapterOutlineEdit key={chapterId} chapter={chapter} outline={outline} />;
}

function ChapterOutlineEdit({
  chapter,
  outline,
}: {
  chapter: ChapterOutline;
  outline: UseOutlineResult;
}) {
  const [drafts, setDrafts] = useState<ForeshadowDraft[]>(() =>
    chapter.foreshadow.map((f) => ({ ...f })),
  );
  const maxVolume = useMemo(
    () => Math.max(0, ...outline.volumes.map((v) => v.order)),
    [outline.volumes],
  );

  const save = async (body: string, ifMatch: string) => {
    const foreshadow = drafts.map((d) => ({
      id: d.id.startsWith('draft_') ? '' : d.id,
      title: d.title.trim(),
      expectResolveBy: d.expectResolveBy,
      status: d.status,
      resolvedIn: d.resolvedIn,
    }));
    // 过滤掉空标题的伏笔（用户加了行但没填内容）。
    const valid = foreshadow.filter((f) => f.title !== '');
    await outline.saveChapterOutline(body, valid, ifMatch);
  };

  return (
    <div className="outline-panel">
      <ChapterForeshadowEditor items={drafts} onChange={setDrafts} maxVolume={maxVolume} />
      <div className="outline-section-title">章纲正文</div>
      <OutlineEditor
        key={chapter.chapterId}
        value={chapter.body}
        hash={chapter.hash}
        placeholder="这一章要发生什么、怎么推进……"
        onSave={save}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 伏笔
// ---------------------------------------------------------------------------

function ForeshadowView({ outline }: { outline: UseOutlineResult }) {
  if (outline.loading && outline.foreshadows.length === 0) {
    return <div className="outline-empty">加载中…</div>;
  }
  return <ForeshadowList items={outline.foreshadows} />;
}
