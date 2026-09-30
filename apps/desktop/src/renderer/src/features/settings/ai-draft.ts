/**
 * AI 设置面板的**纯逻辑**（`docs/11` P0）。
 *
 * 与 `settings-io.ts` 同一条理由：组件里只留渲染，判断放这里才断言得了。
 * 而这些判断里有一条直接关系到隐私：**改服务地址必须保留 `local` 标志**
 * —— 丢了它，一个本机模型会被算成云端（受纯本地模式误拦），
 * 或者反过来，一个云端地址会被算成本机（绕过纯本地模式）。后者是事故。
 */

import {
  isValidBaseUrl,
  normalizeBaseUrl,
  normalizeModelName,
  replaceProvider,
  type AiCredentialResult,
  type ProviderConfig,
} from '@inkstone/shared';

/** 面板上正在编辑的一份草稿。全部是**原始输入**，落盘前才规范化。 */
export interface ProviderDraft {
  /** 服务地址（未规范化，保留用户输入的样子以便他继续改） */
  baseUrl: string;
  /** 模型名 */
  model: string;
  /** 密钥输入框的内容。**只存在这个组件的 state 里，不进 settings.json** */
  apiKey: string;
}

export function emptyDraft(): ProviderDraft {
  return { baseUrl: '', model: '', apiKey: '' };
}

/**
 * 选中某个供应商时，用它当前的值填草稿。
 *
 * `model` 只在"它正好是默认供应商"时才预填：每个供应商的模型名各不相干，
 * 把 A 家的 `deepseek-chat` 填进 B 家的输入框，用户点测试会拿到一个
 * "model not found"，而原因是我们的预填，不是他的配置。
 */
export function draftForProvider(
  provider: ProviderConfig,
  ai: { defaultProviderId: string | null; defaultModel: string },
): ProviderDraft {
  const isDefault = ai.defaultProviderId === provider.id;
  return {
    baseUrl: provider.baseUrl,
    model: isDefault ? ai.defaultModel : '',
    // 密钥**永远不回填**：主进程只回布尔（`ai-types.ts`），面板上也就不留上一把的痕迹
    apiKey: '',
  };
}

/** 地址输入的校验。返回 `null` 表示可以保存。 */
export function validateBaseUrlInput(raw: string): string | null {
  const normalized = normalizeBaseUrl(raw);
  if (normalized === '') return '请填写服务地址。';
  if (!isValidBaseUrl(normalized)) {
    return '地址需要以 http:// 或 https:// 开头，例如 https://api.deepseek.com/v1。';
  }
  return null;
}

/** 模型输入的校验。返回 `null` 表示可以保存。 */
export function validateModelInput(raw: string): string | null {
  if (raw.trim() === '') return '请填写模型名，或点「获取模型列表」从列表里选一个。';
  if (normalizeModelName(raw) === null) return '模型名里不能有空格或换行。';
  return null;
}

/**
 * 把地址草稿合进供应商配置。地址不合法时返回 `null`（**调用方不该把它发给主进程**）。
 *
 * ⚠️ 这里必须走 `replaceProvider` 而不是自己拼一个 `{ id, baseUrl }`：
 * 主进程的 `parseProviders` 对 `baseUrl` 不合法的条目是**直接丢弃**的，
 * 所以一次误发不只是"没保存成功"，而是**这个供应商从设置里消失了**
 * —— 连它已经配好的密钥状态都一起没了。宁可在界面上拦住。
 */
export function draftToProvider(
  provider: ProviderConfig,
  baseUrlInput: string,
): ProviderConfig | null {
  if (validateBaseUrlInput(baseUrlInput) !== null) return null;
  return { ...provider, baseUrl: normalizeBaseUrl(baseUrlInput) };
}

/** 把改好的供应商合进列表（保持顺序）。供 `settings.set` 的 `ai.providers` 用。 */
export function withUpdatedProvider(
  providers: readonly ProviderConfig[],
  next: ProviderConfig,
): ProviderConfig[] {
  return replaceProvider(providers, next);
}

/** 密钥是否够格去提交。`null` 表示可以提交。 */
export function validateApiKeyInput(raw: string): string | null {
  if (raw.trim() === '') return '请先填入密钥。';
  if (/\s/.test(raw.trim())) return '密钥里不能有空格或换行，请重新复制粘贴一次。';
  return null;
}

/**
 * 凭据写入失败时给用户看的文案。
 *
 * 三类失败**不能合并成一句"保存失败"**：用户的下一步动作完全不同
 * （`invalid-key` 要重贴、`storage-unavailable` 要换环境或改用环境变量、
 * `write-failed` 要看磁盘/重试）。混在一起他只能反复点同一个按钮。
 */
export function credentialFailureText(result: Extract<AiCredentialResult, { ok: false }>): string {
  switch (result.kind) {
    case 'storage-unavailable':
      return '这台机器上系统加密不可用，砚台不会以明文保存密钥。请改用环境变量，或在支持系统加密的桌面上使用。';
    case 'invalid-key':
      return '密钥格式看起来不对，请重新复制粘贴一次。';
    case 'unknown-provider':
      return '这个供应商已经不在设置里了，请刷新后重试。';
    case 'write-failed':
      // 主进程在这一支里说的可能是"密钥已保存但没送达"，所以**原样透出**它的话
      return result.message;
  }
}

/** 密钥状态徽标上的字。 */
export function credentialStatusText(provider: ProviderConfig, hasCredential: boolean): string {
  if (!provider.needsKey) return '本机模型，不需要密钥';
  return hasCredential ? '已保存密钥' : '未配置密钥';
}

/**
 * 某个供应商在"纯本地模式"下的处境说明。
 *
 * 三态而不是两态：`offlineOnly` 关着时云端供应商也是可用的，
 * 所以文案要能回答"我现在开这个开关会发生什么"，而不是只标一个"云端/本机"。
 */
export function privacyNoteFor(provider: ProviderConfig, offlineOnly: boolean): string {
  if (provider.local) {
    return '这是本机模型，内容不出这台机器；纯本地模式下也能用。';
  }
  return offlineOnly
    ? '已开启纯本地模式，这个云端地址不会被调用。'
    : '内容会发送到这个地址，可能产生费用。';
}

/**
 * 测试连接的结果文案。
 *
 * 成功时把**延迟**和**模型回的几个字**都报出来：前者能让用户判断"这个模型行不行"，
 * 后者是"确实是这个模型在答"的唯一证据（配错了模型但地址通，只看"成功"看不出来）。
 */
export function testSuccessText(latencyMs: number, model: string, echo: string): string {
  const head = `连接成功：${model} 响应 ${latencyMs} ms`;
  return echo === '' ? `${head}（模型没有返回文字，但请求是通的）` : `${head} · 它说「${echo}」`;
}
