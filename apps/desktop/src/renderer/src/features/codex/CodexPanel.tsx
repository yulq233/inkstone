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
import type { AiExpandTarget, CodexEntry, CodexType } from '@inkstone/shared';
import { describeApiError, type ApiClient } from '../../lib/api';
import type { EgressGateCheck } from '../ai/use-egress-gate';
import {
  CODEX_TYPE_LABELS,
  CODEX_TYPE_ORDER,
  CODEX_TYPE_PLACEHOLDERS,
  entryToUpdateRequest,
  fieldsToRows,
  groupByType,
  isEntryDirty,
  joinList,
  rowsToFields,
  sortCodexList,
  splitList,
  type FieldRow,
} from './codex-model';
import {
  applyExpandResult,
  EXPAND_TARGET_BUTTONS,
  listAiBodySegments,
  removeAiBodySegment,
  segmentPreview,
} from './expand-model';
import { SettingCandidatePanel } from './SettingCandidatePanel';
import { useExpand } from './use-expand';
import { NameGeneratorCard } from './NameGenerator';
import type { UseCodexResult } from './use-codex';

interface PanelProps {
  codex: UseCodexResult;
}

/**
 * 展开设定编辑页要用到的外部依赖。
 *
 * `client` / `workId` 是 `useExpand` 发请求必需；`checkEgress` 是"首次把内容发往
 * 某家云端供应商"的确认闸门（`docs/16` §3.3）—— 由 WorkShell 的 `useEgressGate`
 * 提供，透传到这里而不是各自新建一个，闸门的"已确认名单"才能与续写/快捷生成共用。
 * 三个都是可选类型，缺任何一个时 `useExpand.start` 会静默返回（不会崩）。
 */
interface ExpandDeps {
  client: ApiClient | null;
  workId: string | null;
  checkEgress?: EgressGateCheck;
}

export function CodexPanel({ codex, ...deps }: PanelProps & ExpandDeps) {
  if (codex.current !== null) {
    return <EntryDetail key={codex.current.slug} codex={codex} entry={codex.current} {...deps} />;
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
  // 先排序再分组：groupByType 保序，组内自动是名字 locale 序（真机反馈：
  // 平铺一长列难找条目，按类型分节、节头带计数，空节不显示）。
  const groups = useMemo(() => groupByType(sorted), [sorted]);
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
        groups.map((group) => (
          <section key={group.type} className="codex-group">
            <div className="codex-group-head">
              <span className="codex-group-label">{group.label}</span>
              <span className="codex-group-count">{group.entries.length}</span>
            </div>
            <ul className="codex-list">
              {group.entries.map((entry) => (
                <li key={`${entry.type}:${entry.slug}`}>
                  <button
                    type="button"
                    className="codex-list-item"
                    onClick={() => void codex.openEntry(entry.type, entry.slug)}
                  >
                    <span className="codex-list-name">{entry.name}</span>
                    {/* 类型字由节头承担，卡内只显示第一个别名（有才渲染） */}
                    {entry.aliases.length > 0 ? (
                      <span className="codex-list-meta">{entry.aliases[0]}</span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}

      <NameGeneratorCard existingNames={existingNames} onCreate={codex.startCreate} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 新建表单
// ---------------------------------------------------------------------------

function EntryCreate({ codex, type }: { codex: UseCodexResult; type: CodexType }) {
  // 示例文案跟随类型（真机反馈：点「+地点」不该看到人物的「沈观澜」）。
  const ph = CODEX_TYPE_PLACEHOLDERS[type];
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
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={ph.name} />
      </label>
      <label className="codex-field">
        <span>别名（逗号分隔）</span>
        <input
          value={aliases}
          onChange={(e) => setAliases(e.target.value)}
          placeholder={ph.aliases}
        />
      </label>
      <label className="codex-field">
        <span>标签（逗号分隔）</span>
        <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder={ph.tags} />
      </label>
      <label className="codex-field">
        <span>一句话梗概</span>
        <textarea
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="50~100 字，用于 AI 记住这条设定"
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

function EntryDetail({
  codex,
  entry,
  client,
  workId,
  checkEgress,
}: { codex: UseCodexResult; entry: CodexEntry } & ExpandDeps) {
  const [name, setName] = useState(entry.name);
  const [aliases, setAliases] = useState(joinList(entry.aliases));
  const [tags, setTags] = useState(joinList(entry.tags));
  const [summary, setSummary] = useState(entry.summary);
  const [body, setBody] = useState(entry.body);
  const [rows, setRows] = useState<FieldRow[]>(() => fieldsToRows(entry.fields));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // AI 扩充设定（`docs/16`）。`entry` 直接给它 —— 它只读 type/slug 构造请求。
  const expand = useExpand({ client, workId, entry, checkEgress });

  /** body 里已有的 AI 追加段落（供"删除该次"渲染）。本地态派生，随编辑实时更新。 */
  const segments = useMemo(() => listAiBodySegments(body), [body]);

  /**
   * 表单是否有**未保存**的改动。
   *
   * ⚠️ 这不是个"锦上添花"的状态 —— 真机踩到过：AI 装配的唯一真源是**磁盘**，用户把
   * 名字改成「沈念」没保存就点「生成描述」，候选里写的是另一个名字（因为 sidecar 读到的
   * 仍是旧的 `name: 女主`），而界面上没有任何线索能让人想到"我忘了保存"。详见 `docs/16` §9。
   *
   * 判定用**归一化后**的值（`name` trim、别名/标签 `splitList`），与 `persist` 写盘的口径一致。
   */
  const dirty = useMemo(
    () =>
      isEntryDirty(
        {
          name: name.trim(),
          aliases: splitList(aliases),
          tags: splitList(tags),
          summary,
          body,
          fields: rowsToFields(rows),
        },
        entry,
      ),
    [name, aliases, tags, summary, body, rows, entry],
  );

  const addRow = useCallback(() => {
    setRows((prev) => [...prev, { id: Date.now(), key: '', value: '' }]);
  }, []);
  const setRow = useCallback((id: number, patch: Partial<FieldRow>) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }, []);
  const removeRow = useCallback((id: number) => {
    setRows((prev) => prev.filter((r) => r.id !== id));
  }, []);

  /**
   * 用给定的 summary / body 组装并保存**整条**设定。
   *
   * 抽出来给三个调用点共用：手动「保存」、AI 候选「采纳」、删除某次 AI 段落。
   * 后两者要**立即落盘**（而不是只改本地态等用户再点保存）：
   * - 采纳的候选是**瞬态**的（关掉面板就没有了），不落盘等于白生成；
   * - 删除若不落盘，用户点「← 返回」时那段文字会**静默复原**——他以为删掉了。
   *
   * 返回是否成功。失败（含 409 外部改动）已 `setError`，调用方据此决定要不要收尾。
   */
  const persist = useCallback(
    async (next: { summary: string; body: string }): Promise<boolean> => {
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
            summary: next.summary,
            body: next.body,
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
        // 回填本地态：服务端现在就是这个内容，输入框必须跟着走（否则用户看到的是旧值，
        // 再点一次保存又会把它覆盖回去）。
        setSummary(next.summary);
        setBody(next.body);
        setSaved(true);
        return true;
      } catch (err) {
        setError(describeApiError(err));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [codex, entry, name, aliases, tags, rows],
  );

  const submit = useCallback(async () => {
    if (name.trim() === '') {
      setError('名字不能为空。');
      return;
    }
    await persist({ summary, body });
  }, [persist, name, summary, body]);

  /**
   * 采纳 AI 候选：按目标写回 summary（替换）或 body（追加，见 D-7），然后立即保存。
   *
   * **从本地态 `body` 追加**而不是从 `entry.body`：用户可能手写了一段还没保存的草稿，
   * 追加必须保住它（这正是 D-7"保留草稿"的落点）。保存失败则**不收面板**，
   * 用户能重试（失败原因已显示在错误条上）。
   */
  const accept = useCallback(async () => {
    const target = expand.snapshot.target;
    if (target === null) return;
    const text = expand.text.trim();
    if (text === '') return;
    const next = applyExpandResult({ summary, body }, target, text, expand.snapshot.runId);
    if (await persist(next)) expand.close();
  }, [expand, persist, summary, body]);

  /**
   * 发起一次扩充（`docs/16` §9）——**有未保存改动就先落盘再生成**。
   *
   * 为什么不只是"禁用按钮 + 让用户自己去点保存"：用户点了「生成描述」，他想要的结果是
   * "生成"，把这一步拆成两个动作、还要他自己判断哪里没保存，是把系统的实现细节推给他。
   * 自动保存一步到位，而且**保存失败就不生成**（原因已由 `persist` 写在错误条上）——
   * 否则又会拿旧值生成一段白花钱、还得再解释一遍的候选。
   *
   * `dirty` 为假时不碰磁盘（无谓的 PUT 会推高 `ifMatch` 轮换、也会在别处开着编辑器时
   * 白白撞一次 409）。
   */
  const startExpand = useCallback(
    async (target: AiExpandTarget) => {
      if (dirty && !(await persist({ summary, body }))) return;
      expand.start(target);
    },
    [dirty, persist, summary, body, expand],
  );

  /** 删除某一次 AI 追加（D-7）：只切这一段的标记到下一标记之间的文本，然后落盘。 */
  const removeSegment = useCallback(
    async (runId: string) => {
      const nextBody = removeAiBodySegment(body, runId);
      if (nextBody === body) return; // runId 对不上（外部改动过）：不写
      await persist({ summary, body: nextBody });
    },
    [persist, summary, body],
  );

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

  const expandRunning = expand.snapshot.phase === 'running';

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

      {/* AI 刻画（docs/16 §3.1）：两个动作 + 候选面板。放在编辑表单**上方**——
          它是"生成内容"的入口，用户读完候选再往下填/改表单 */}
      <div className="codex-expand">
        <div className="codex-expand-head">
          <span className="codex-fields-title">AI 刻画</span>
          <span className="hint">按当前设定补充细节</span>
        </div>
        <div className="codex-expand-actions">
          <button
            type="button"
            disabled={expandRunning || busy}
            onClick={() => void startExpand('summary')}
          >
            {EXPAND_TARGET_BUTTONS.summary}
          </button>
          <button
            type="button"
            disabled={expandRunning || busy}
            onClick={() => void startExpand('body')}
          >
            {EXPAND_TARGET_BUTTONS.body}
          </button>
        </div>

        {/* 「有未保存改动」的显式提示（`docs/16` §9）。摆在按钮**正下方**：
            它解释的是"你按下去之后会发生什么"（会先保存），而不是一个错误 */}
        {dirty && !expandRunning ? (
          <p className="codex-expand-hint" role="status">
            AI 只读取<strong>已保存</strong>的设定。你有未保存的改动，生成前会先自动保存。
          </p>
        ) : null}

        <SettingCandidatePanel
          snapshot={expand.snapshot}
          text={expand.text}
          busy={busy}
          onStop={expand.stop}
          onAccept={() => void accept()}
          onDiscard={expand.close}
        />
      </div>

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

      {/* AI 追加段落的删改（D-7）。只列 AI 生成的部分，手写草稿不在候选里 */}
      {segments.length === 0 ? null : (
        <div className="codex-ai-segments">
          <span className="codex-fields-title">AI 追加的段落（{segments.length}）</span>
          {segments.map((segment) => (
            <div key={segment.runId} className="codex-ai-segment">
              <span className="codex-ai-segment-text">{segmentPreview(segment.text)}</span>
              <button
                type="button"
                className="linkish danger"
                disabled={busy}
                onClick={() => void removeSegment(segment.runId)}
              >
                删除该次
              </button>
            </div>
          ))}
        </div>
      )}

      <button type="button" className="codex-save" disabled={busy} onClick={() => void submit()}>
        {busy ? '保存中…' : '保存'}
      </button>
    </div>
  );
}
