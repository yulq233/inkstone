import { useCallback, useEffect, useState } from 'react';
import {
  providerById,
  type AiSettings,
  type CredentialStatus,
  type ModelSpec,
  type ProviderConfig,
  type Settings,
} from '@inkstone/shared';
import { ApiClient, describeApiError } from '../../lib/api';
import { hostOf } from '../ai/context-preview';
import {
  credentialFailureText,
  credentialStatusText,
  draftForProvider,
  emptyDraft,
  privacyNoteFor,
  testSuccessText,
  validateApiKeyInput,
  validateBaseUrlInput,
  validateModelInput,
  withUpdatedProvider,
  type ProviderDraft,
} from './ai-draft';
import './ai.css';

/** 必扣的隐私文案（`docs/01` §9.3 规定，措辞不得改写）。 */
const PRIVACY_LINE = '正文与设定默认只存在本机，索引可选用云端加速。';

interface AiSectionProps {
  settings: Settings;
  updateAi: (patch: Partial<AiSettings>) => void;
  /** sidecar 未就绪时为 `null`：面板仍可改设置、存密钥，只是不能发测试请求 */
  client: ApiClient | null;
}

/** 一次只允许一个异步动作在跑，避免"连点两下测试"叠出两个结果行。 */
type Busy = null | 'models' | 'test';

/** 一行即时反馈：`ok` 决定配色，`text` 直接显示。 */
interface Line {
  ok: boolean;
  text: string;
}

/**
 * 设置面板的「AI 模型」分区（`docs/11` P0）。
 *
 * ## 这个组件刻意**不常挂载**
 *
 * 与 `SettingsPanel` 的外观分区相反：它随面板关闭而卸载，这是想要的 ——
 * 密钥输入框里的内容会随卸载一起消失，**明文在内存里的寿命就短一点**。
 * 代价是每次打开面板都要重新问一次凭据状态（两次 IPC），可以忽略。
 *
 * ## 草稿与真源的关系
 *
 * 地址 / 模型是**草稿**（本地 state），点保存才写进 `settings.json`；
 * 密钥则**从不进设置**，直接走 `ai:setCredential` 落到系统加密存储。
 */
export function AiSection({ settings, updateAi, client }: AiSectionProps) {
  const { providers, defaultProviderId, defaultModel, offlineOnly } = settings.ai;

  const [selectedId, setSelectedId] = useState<string>(
    () => defaultProviderId ?? providers[0]?.id ?? '',
  );
  const provider = providerById(providers, selectedId) ?? providers[0] ?? null;

  /**
   * 草稿带着"它是哪个供应商的"一起存。
   *
   * 这样就不需要"切换供应商时重置草稿"的 effect —— 那个 effect 的依赖数组是个陷阱：
   * 依赖 `provider` 对象时，用户在地址框里打字 → 广播回来 → 新对象 → 草稿被覆盖，
   * **字打不进去**；依赖 `provider.id` 又永远过不了 exhaustive-deps。
   * 存成 `{ id, value }` 之后，"草稿与当前供应商不匹配"在 render 里直接判得出来。
   */
  const [draftState, setDraftState] = useState<{ id: string; value: ProviderDraft } | null>(null);
  const draft: ProviderDraft =
    provider === null
      ? emptyDraft()
      : draftState !== null && draftState.id === provider.id
        ? draftState.value
        : draftForProvider(provider, settings.ai);

  const [busy, setBusy] = useState<Busy>(null);
  const [testLine, setTestLine] = useState<Line | null>(null);
  const [notice, setNotice] = useState<Line | null>(null);
  const [models, setModels] = useState<ModelSpec[] | null>(null);
  const [statuses, setStatuses] = useState<CredentialStatus[]>([]);
  const [secureAvailable, setSecureAvailable] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [next, available] = await Promise.all([
        window.inkstone.ai.getCredentialsStatus(),
        window.inkstone.ai.isSecureStorageAvailable(),
      ]);
      if (cancelled) return;
      setStatuses(next);
      setSecureAvailable(available);
    })().catch(() => {
      /* 主进程异常时保持"未配置"的初始态即可，不值得打断用户 */
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const editDraft = useCallback(
    (patch: Partial<ProviderDraft>): void => {
      if (provider === null) return;
      setNotice(null);
      setDraftState({ id: provider.id, value: { ...draft, ...patch } });
    },
    [provider, draft],
  );

  const selectProvider = useCallback((id: string): void => {
    setSelectedId(id);
    // 不在这里填草稿：草稿的"供应商不匹配"判定会在下次 render 用新供应商的值重建
    setTestLine(null);
    setNotice(null);
    setModels(null);
  }, []);

  if (provider === null) {
    return <p className="hint">设置里没有任何供应商，请重启砚台以恢复内置预设。</p>;
  }

  const hasCredential = statuses.find((item) => item.providerId === provider.id)?.hasCredential;

  /**
   * 已确认可以把内容发往的那些供应商。名单**真源在主进程** `settings.json`，
   * 这里只是随广播下来的只读副本 —— sidecar 那两个字段是纯内存的，重启即重建。
   *
   * 按 `providers` 过滤而不是直接遍历 id 名单：删掉一家供应商后重建同名 id 会
   * 静默继承旧确认（用户从没看过的一个新地址被当成"已确认"）。主进程的
   * `parseEgressAcks` 已经在写盘侧做了同一层过滤，这里再筛一遍是因为**这一份
   * 是广播来的**，可能与写盘那一刻的 providers 不同步。
   */
  const ackedProviders = providers.filter((item) =>
    settings.ai.acknowledgedEgressProviders.includes(item.id),
  );

  /**
   * 「纯本地模式」下这个供应商能不能发请求。
   *
   * 与网关那道拦截是**两件事**，都要做：网关保证"发不出去"（安全边界），
   * 这里保证"点不动"（用户不必先失败一次才知道）。
   *
   * ⚠️ 刻意**只禁按钮，不禁选择与编辑**：开着纯本地模式时用户可能正是要改配置
   * （比如换回本机模型、或者先把 Key 填好等关掉开关再用）。
   * 把整个供应商下拉置灰会让他连"看一眼另一家配的是什么"都做不到。
   */
  const offlineBlocked = offlineOnly && !provider.local;
  const canReachModel = client !== null && !offlineBlocked;

  // ---- 动作 ----

  const saveBaseUrl = (): void => {
    const error = validateBaseUrlInput(draft.baseUrl);
    if (error !== null) {
      setNotice({ ok: false, text: error });
      return;
    }
    // 走 `withUpdatedProvider`（内部是 shared 的 `replaceProvider`）而不是拼半截对象：
    // 主进程的 `parseProviders` 对 baseUrl 不合法的条目是**直接丢弃**的，
    // 而丢掉的是整个供应商 —— 它的密钥状态也一起没了。
    updateAi({
      providers: withUpdatedProvider(providers, { ...provider, baseUrl: draft.baseUrl }),
    });
    setNotice({ ok: true, text: '服务地址已保存。' });
  };

  const saveAsDefault = (): void => {
    const error = validateModelInput(draft.model);
    if (error !== null) {
      setNotice({ ok: false, text: error });
      return;
    }
    // 一起写 `defaultProviderId`：模型名只对某一家有意义，分开保存会留下
    // "默认供应商是 A、默认模型是 B 家的名字"这种自相矛盾的状态
    updateAi({ defaultProviderId: provider.id, defaultModel: draft.model });
    setNotice({ ok: true, text: `已把「${provider.label} / ${draft.model.trim()}」设为默认。` });
  };

  const saveKey = (): void => {
    const error = validateApiKeyInput(draft.apiKey);
    if (error !== null) {
      setNotice({ ok: false, text: error });
      return;
    }
    void (async () => {
      const result = await window.inkstone.ai.setCredential({
        providerId: provider.id,
        apiKey: draft.apiKey,
      });
      if (result.ok) {
        setStatuses(result.statuses);
        // 存好之后清空输入框：明文没有理由继续留在 DOM 里
        setDraftState({ id: provider.id, value: { ...draft, apiKey: '' } });
        setNotice({ ok: true, text: '密钥已加密保存。' });
      } else {
        setNotice({ ok: false, text: credentialFailureText(result) });
      }
    })();
  };

  const clearKey = (): void => {
    void (async () => {
      const result = await window.inkstone.ai.clearCredential(provider.id);
      if (result.ok) {
        setStatuses(result.statuses);
        setNotice({ ok: true, text: '密钥已删除。' });
      } else {
        setNotice({ ok: false, text: credentialFailureText(result) });
      }
    })();
  };

  const fetchModels = (): void => {
    if (!client) return;
    setBusy('models');
    setTestLine(null);
    void client
      .listAiModels(provider.id)
      .then((items) => {
        setModels(items);
        if (items.length === 0) {
          setNotice({ ok: false, text: '这个地址没有返回任何模型，可能需要先在服务端拉取模型。' });
        } else if (draft.model.trim() === '') {
          // 顺手填第一个：点这个按钮的意图就是"我不知道该填什么"
          editDraft({ model: items[0]?.id ?? '' });
        }
      })
      .catch((err: unknown) => setNotice({ ok: false, text: describeApiError(err) }))
      .finally(() => setBusy(null));
  };

  const runTest = (): void => {
    if (!client) return;
    const error = validateModelInput(draft.model);
    if (error !== null) {
      setNotice({ ok: false, text: error });
      return;
    }
    setBusy('test');
    setTestLine(null);
    setNotice(null);
    void client
      .testAiConnection(provider.id, draft.model)
      .then((result) =>
        setTestLine({
          ok: true,
          text: testSuccessText(result.latencyMs, result.model, result.echo),
        }),
      )
      // 失败文案直接用服务端给的那句：`AI_AUTH_FAILED` / `AI_OFFLINE_ONLY` 等
      // 已经是"说清下一步做什么"的人话，在这里再翻译一遍只会让两处漂移
      .catch((err: unknown) => setTestLine({ ok: false, text: describeApiError(err) }))
      .finally(() => setBusy(null));
  };

  /**
   * 撤销"已确认外发"。下次用这家生成时会重新弹确认卡。
   *
   * 走 `ai:setEgressAck`（单一意图：只加/删一个 id）而不是"把整个名单写回去"：
   * 渲染进程手里的这份是广播副本，可能已经过期，整份回写会把别人刚加的确认覆盖掉。
   *
   * 失败只 `console.warn`：撤销是个"顺手清一下"的动作，它失败不影响用户当下
   * 要做的任何事，弹个红条反而更吵。真失败了下次生成会重新弹卡 —— 结果是安全的。
   */
  const revokeAck = (providerId: string): void => {
    void window.inkstone.ai
      .setEgressAck({ providerId, acknowledged: false })
      .then((result) => {
        // 结果里带失败原因（`unknown-provider` / `write-failed`）：这种情况下界面
        // 上名单**不会变**，没有一句 warn 就成了"点了没反应"。
        if (!result.ok) console.warn(`[inkstone] 撤销「已确认外发」未生效：${result.message}`);
      })
      .catch((err: unknown) => {
        console.warn(`[inkstone] 撤销「已确认外发」失败：${describeApiError(err)}`);
      });
  };

  const defaultLine =
    defaultProviderId === null
      ? '尚未设置（生成时会提示先选一个模型）'
      : `${providerById(providers, defaultProviderId)?.label ?? defaultProviderId} / ${defaultModel === '' ? '未填模型' : defaultModel}`;

  return (
    <div className="ai">
      <section className="settings-group">
        <h3>供应商</h3>
        <select
          className="ai-input"
          value={provider.id}
          onChange={(event) => selectProvider(event.target.value)}
          aria-label="选择供应商"
        >
          {providers.map((item: ProviderConfig) => (
            <option key={item.id} value={item.id}>
              {item.label}
              {item.local ? '（本机）' : ''}
              {item.id === defaultProviderId ? ' · 默认' : ''}
            </option>
          ))}
        </select>
        <p className="hint">{privacyNoteFor(provider, offlineOnly)}</p>
      </section>

      <section className="settings-group">
        <h3>服务地址</h3>
        <input
          className="ai-input"
          type="text"
          value={draft.baseUrl}
          spellCheck={false}
          onChange={(event) => editDraft({ baseUrl: event.target.value })}
          aria-label="服务地址"
        />
        <div className="ai-row">
          <button type="button" onClick={saveBaseUrl}>
            保存地址
          </button>
        </div>
        <p className="hint">
          填到 <code>/v1</code> 为止，不要带 <code>/chat/completions</code> 这类路径后缀。
        </p>
      </section>

      <section className="settings-group">
        <h3>默认模型</h3>
        <div className="ai-row">
          <input
            className="ai-input"
            type="text"
            value={draft.model}
            spellCheck={false}
            list="ai-model-options"
            onChange={(event) => editDraft({ model: event.target.value })}
            aria-label="默认模型"
          />
          <button type="button" onClick={fetchModels} disabled={!canReachModel || busy !== null}>
            {busy === 'models' ? '获取中…' : '获取模型列表'}
          </button>
        </div>
        {/* datalist 而不是 select：拉不到列表时用户仍能手打模型名
            （很多自建/中转端点不实现 /models） */}
        <datalist id="ai-model-options">
          {(models ?? []).map((item) => (
            <option key={item.id} value={item.id} />
          ))}
        </datalist>
        <div className="ai-row">
          <button type="button" onClick={saveAsDefault}>
            保存为默认
          </button>
        </div>
        <p className="hint">当前默认：{defaultLine}</p>
      </section>

      <section className="settings-group">
        <h3>密钥</h3>
        <p className="ai-key-status">
          <span className={hasCredential === true ? 'ai-badge ai-badge-ok' : 'ai-badge'}>
            {credentialStatusText(provider, hasCredential === true)}
          </span>
        </p>
        {secureAvailable ? null : (
          <p className="hint ai-warn">
            这台机器上系统加密不可用。砚台不会以明文保存密钥，所以这里保存不了。
          </p>
        )}
        {provider.needsKey ? (
          <>
            <div className="ai-row">
              <input
                className="ai-input"
                type="password"
                value={draft.apiKey}
                autoComplete="off"
                spellCheck={false}
                placeholder={hasCredential === true ? '已保存（重新填写可替换）' : '粘贴 API Key'}
                onChange={(event) => editDraft({ apiKey: event.target.value })}
                aria-label="API 密钥"
              />
              <button type="button" onClick={saveKey} disabled={!secureAvailable}>
                保存
              </button>
              <button type="button" onClick={clearKey} disabled={hasCredential !== true}>
                删除
              </button>
            </div>
            <p className="hint">
              密钥用系统级加密存在本机，不会写进 <code>settings.json</code>，界面上也不会回显。
            </p>
          </>
        ) : (
          <p className="hint">这个供应商不需要密钥。</p>
        )}
      </section>

      <section className="settings-group">
        <h3>连接测试</h3>
        <div className="ai-row">
          <button type="button" onClick={runTest} disabled={!canReachModel || busy !== null}>
            {busy === 'test' ? '测试中…' : '测试连接'}
          </button>
          {client === null ? (
            <span className="hint">本地服务未就绪，暂时不能测试。</span>
          ) : offlineBlocked ? (
            // 说清"按不动"的原因，否则用户只会以为按钮坏了
            <span className="hint">已开启纯本地模式，不会向云端发送任何内容。</span>
          ) : null}
        </div>
        {testLine === null ? null : (
          <p className={testLine.ok ? 'ai-line ai-line-ok' : 'ai-line ai-line-bad'}>
            {testLine.text}
          </p>
        )}
        <p className="hint">会真的发一次最小请求，所以能验出密钥对不对，而不只是地址通不通。</p>
      </section>

      <section className="settings-group">
        <h3>隐私</h3>
        <label className="ai-check">
          <input
            type="checkbox"
            checked={offlineOnly}
            onChange={(event) => updateAi({ offlineOnly: event.target.checked })}
          />
          <span>纯本地模式（不向云端发送任何内容）</span>
        </label>
        <p className="hint">
          开启后云端供应商一律不可用，只允许本机模型。开关在本地服务侧生效 ——
          所有请求都会经过同一道拦截，绕不过去。
        </p>
        <p className="hint ai-privacy">{PRIVACY_LINE}</p>
      </section>

      {/*
        「已确认外发」的名单（`docs/11` §2.3）。

        为什么这里必须能**撤销**：确认卡只在第一次出现，而这个动作是"从此以后
        这家不再问"。没有撤销口子的话，一次误点就是单向门 —— 用户再也看不到那张卡，
        而它在产品里的职责恰恰是"每次启用新的一家的知情"。

        这里看不到「将发送什么」的真实内容（那要有当前章节与光标上下文，D-10），
        所以只放一句指路，而不是放一个"打开后报错"的按钮。真实预览在工作台内。
      */}
      <section className="settings-group">
        <h3>已确认外发的供应商</h3>
        {ackedProviders.length === 0 ? (
          <p className="hint">
            还没有确认过任何云端供应商。第一次用云端模型生成时，砚台会先把「将发送什么」给你看一遍。
          </p>
        ) : (
          <ul className="ai-ack-list">
            {ackedProviders.map((item) => (
              <li key={item.id}>
                <span className="ai-ack-name">{item.label}</span>
                <span className="hint">{hostOf(item.baseUrl)}</span>
                <button type="button" className="linkish" onClick={() => revokeAck(item.id)}>
                  取消确认
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="hint">
          真实的发送内容可以在工作台里随时查看（编辑器上方的「将发送什么」）——
          那里才有当前章节与光标上下文，能看到这一次实际会发出去的原文。
        </p>
      </section>

      {/*
        反馈行固定在面板底部（`ai.css` 的 sticky）而不是各分区各放一个：
        分区多、每个都能产生反馈，逐个放会让状态翻倍；而只在顶部放，
        用户滚到「密钥」那一栏时又看不见。
      */}
      {notice === null ? null : (
        <p className={notice.ok ? 'ai-line ai-line-ok ai-notice' : 'ai-line ai-line-bad ai-notice'}>
          {notice.text}
        </p>
      )}
    </div>
  );
}
