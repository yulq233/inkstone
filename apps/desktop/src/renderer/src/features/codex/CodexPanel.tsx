/**
 * 设定面板（docs/15 B3）—— 人物卡等设定条目的清单 + 详情 + 新建 + 起名器。
 *
 * 信息架构：左（本组件整体占据侧栏 tab）自上而下是
 *   类型筛选 + 新建按钮 → 清单 → 点击进详情 / 新建表单 / 起名器卡片。
 * 详情是**替换清单**的视图（侧栏窄，不适合左右分栏），带「返回」回清单。
 *
 * ⚠️ 数据流约定（与 use-codex 一致）：保存失败（尤其 409）要响亮地报；
 * 编辑态是本地 state，点了「保存」才 PUT —— 这是低频结构化编辑，不做自动保存
 * （docs/15 §3.3：别复制 autosave 那套复杂度）。
 */

import { useCallback, useMemo, useState } from 'react';
import type { CodexEntry, CodexType } from '@inkstone/shared';
import { describeApiError } from '../../lib/api';
import {
  CODEX_TYPE_LABELS,
  CODEX_TYPE_ORDER,
  entryToUpdateRequest,
  fieldsToRows,
  joinList,
  rowsToFields,
  sortCodexList,
  splitList,
  type FieldRow,
} from './codex-model';
import { NameGeneratorCard } from './NameGenerator';
import type { UseCodexResult } from './use-codex';

interface PanelProps {
  codex: UseCodexResult;
}

export function CodexPanel({ codex }: PanelProps) {
  if (codex.current !== null) {
    return <EntryDetail key={codex.current.slug} codex={codex} entry={codex.current} />;
  }
  if (codex.creatingType !== null) {
    return <EntryCreate codex={codex} type={codex.creatingType} />;
  }
  return <EntryList codex={codex} />;
}

// ---------------------------------------------------------------------------
// 清单
// ---------------------------------------------------------------------------

function EntryList({ codex }: PanelProps) {
  const sorted = useMemo(() => sortCodexList(codex.entries), [codex.entries]);
  const existingNames = useMemo(() => new Set(codex.entries.map((e) => e.name)), [codex.entries]);

  return (
    <div className="codex-panel">
      <div className="codex-toolbar">
        <span className="codex-title">设定</span>
        <button type="button" className="linkish" onClick={() => void codex.reload()}>
          刷新
        </button>
      </div>

      {codex.error === null ? null : (
        <div className="codex-error" role="alert">
          {codex.error}
        </div>
      )}

      <div className="codex-type-buttons">
        {CODEX_TYPE_ORDER.map((type) => (
          <button
            key={type}
            type="button"
            className="codex-type-button"
            onClick={() => codex.startCreate(type)}
          >
            +{CODEX_TYPE_LABELS[type]}
          </button>
        ))}
      </div>

      {codex.loading ? (
        <div className="codex-empty">加载中…</div>
      ) : sorted.length === 0 ? (
        <div className="codex-empty">还没有设定条目。点上方按钮新建。</div>
      ) : (
        <ul className="codex-list">
          {sorted.map((entry) => (
            <li key={`${entry.type}:${entry.slug}`}>
              <button
                type="button"
                className="codex-list-item"
                onClick={() => void codex.openEntry(entry.type, entry.slug)}
              >
                <span className="codex-list-name">{entry.name}</span>
                <span className="codex-list-meta">
                  {CODEX_TYPE_LABELS[entry.type]}
                  {entry.aliases.length > 0 ? ` · ${entry.aliases[0]}` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <NameGeneratorCard existingNames={existingNames} onCreate={codex.startCreate} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 新建表单
// ---------------------------------------------------------------------------

function EntryCreate({ codex, type }: { codex: UseCodexResult; type: CodexType }) {
  const [name, setName] = useState('');
  const [aliases, setAliases] = useState('');
  const [tags, setTags] = useState('');
  const [summary, setSummary] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    if (name.trim() === '') {
      setError('名字不能为空。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await codex.create({
        type,
        name: name.trim(),
        aliases: splitList(aliases),
        tags: splitList(tags),
        summary,
        fields: {},
        relations: [],
        body,
      });
    } catch (err) {
      setError(describeApiError(err));
    } finally {
      setBusy(false);
    }
  }, [codex, type, name, aliases, tags, summary, body]);

  return (
    <div className="codex-panel">
      <div className="codex-toolbar">
        <button type="button" className="linkish" onClick={codex.cancelCreate}>
          ← 返回
        </button>
        <span className="codex-title">新建{CODEX_TYPE_LABELS[type]}</span>
      </div>
      {error === null ? null : (
        <div className="codex-error" role="alert">
          {error}
        </div>
      )}
      <label className="codex-field">
        <span>名字</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：沈观澜" />
      </label>
      <label className="codex-field">
        <span>别名（逗号分隔）</span>
        <input
          value={aliases}
          onChange={(e) => setAliases(e.target.value)}
          placeholder="例如：观澜，沈先生"
        />
      </label>
      <label className="codex-field">
        <span>标签（逗号分隔）</span>
        <input
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="例如：主角，云京司"
        />
      </label>
      <label className="codex-field">
        <span>一句话梗概</span>
        <textarea
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="50~100 字，用于 AI 记住这个人物"
        />
      </label>
      <label className="codex-field">
        <span>自由描述</span>
        <textarea
          className="codex-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="任何你不想进 AI 上下文的草稿、灵感都放这里"
        />
      </label>
      <button type="button" className="codex-save" disabled={busy} onClick={() => void submit()}>
        {busy ? '创建中…' : '创建'}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 详情 / 编辑
// ---------------------------------------------------------------------------

function EntryDetail({ codex, entry }: { codex: UseCodexResult; entry: CodexEntry }) {
  const [name, setName] = useState(entry.name);
  const [aliases, setAliases] = useState(joinList(entry.aliases));
  const [tags, setTags] = useState(joinList(entry.tags));
  const [summary, setSummary] = useState(entry.summary);
  const [body, setBody] = useState(entry.body);
  const [rows, setRows] = useState<FieldRow[]>(() => fieldsToRows(entry.fields));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const addRow = useCallback(() => {
    setRows((prev) => [...prev, { id: Date.now(), key: '', value: '' }]);
  }, []);
  const setRow = useCallback((id: number, patch: Partial<FieldRow>) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }, []);
  const removeRow = useCallback((id: number) => {
    setRows((prev) => prev.filter((r) => r.id !== id));
  }, []);

  const submit = useCallback(async () => {
    if (name.trim() === '') {
      setError('名字不能为空。');
      return;
    }
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const patch = entryToUpdateRequest(
        {
          ...entry,
          name: name.trim(),
          aliases: splitList(aliases),
          tags: splitList(tags),
          summary,
          body,
          fields: rowsToFields(rows),
        },
        entry.hash,
      );
      await codex.save(
        {
          ...entry,
          name: patch.name,
          aliases: patch.aliases,
          tags: patch.tags,
          summary: patch.summary,
          body: patch.body,
          fields: patch.fields,
        },
        entry.hash,
      );
      setSaved(true);
    } catch (err) {
      setError(describeApiError(err));
    } finally {
      setBusy(false);
    }
  }, [codex, entry, name, aliases, tags, summary, body, rows]);

  const remove = useCallback(async () => {
    if (!window.confirm(`确定删除「${entry.name}」吗？此操作不可撤销。`)) return;
    setBusy(true);
    setError(null);
    try {
      await codex.remove(entry.type, entry.slug);
    } catch (err) {
      setError(describeApiError(err));
      setBusy(false);
    }
  }, [codex, entry]);

  return (
    <div className="codex-panel">
      <div className="codex-toolbar">
        <button type="button" className="linkish" onClick={codex.close}>
          ← 返回
        </button>
        <span className="codex-title">{CODEX_TYPE_LABELS[entry.type]}</span>
        <button type="button" className="linkish danger" onClick={() => void remove()}>
          删除
        </button>
      </div>

      {error === null ? null : (
        <div className="codex-error" role="alert">
          {error}
        </div>
      )}
      {saved ? <div className="codex-saved">已保存</div> : null}

      <label className="codex-field">
        <span>名字</span>
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="codex-field">
        <span>别名</span>
        <input value={aliases} onChange={(e) => setAliases(e.target.value)} />
      </label>
      <label className="codex-field">
        <span>标签</span>
        <input value={tags} onChange={(e) => setTags(e.target.value)} />
      </label>
      <label className="codex-field">
        <span>一句话梗概</span>
        <textarea value={summary} onChange={(e) => setSummary(e.target.value)} />
      </label>

      <div className="codex-fields">
        <span className="codex-fields-title">属性</span>
        {rows.map((row) => (
          <div key={row.id} className="codex-field-row">
            <input
              className="codex-field-key"
              value={row.key}
              placeholder="键"
              onChange={(e) => setRow(row.id, { key: e.target.value })}
            />
            <input
              className="codex-field-value"
              value={row.value}
              placeholder="值"
              onChange={(e) => setRow(row.id, { value: e.target.value })}
            />
            <button type="button" className="linkish" onClick={() => removeRow(row.id)}>
              ×
            </button>
          </div>
        ))}
        <button type="button" className="linkish" onClick={addRow}>
          + 添加属性
        </button>
      </div>

      <label className="codex-field">
        <span>自由描述</span>
        <textarea className="codex-body" value={body} onChange={(e) => setBody(e.target.value)} />
      </label>

      <button type="button" className="codex-save" disabled={busy} onClick={() => void submit()}>
        {busy ? '保存中…' : '保存'}
      </button>
    </div>
  );
}
