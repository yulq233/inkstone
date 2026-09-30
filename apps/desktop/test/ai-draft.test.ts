/**
 * AI 设置面板的纯逻辑（`docs/11` P0）。
 *
 * 这组用例里最重要的两条：
 * 1. **改地址必须保留 `local` 与 `needsKey`** —— 丢了 `local`，一个云端地址会被当成
 *    本机模型，从而**绕过纯本地模式**；
 * 2. **地址不合法时要拦住**，因为主进程的 `parseProviders` 对非法条目是**直接丢弃**的
 *    —— 放过去的话，用户丢的不是"这次修改"，而是整个供应商。
 */

import { describe, expect, it } from 'vitest';
import { PROVIDER_PRESETS, type ProviderConfig } from '@inkstone/shared';
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
  draftToProvider,
} from '../src/renderer/src/features/settings/ai-draft';

const CLOUD: ProviderConfig = {
  id: 'deepseek',
  kind: 'openai-compatible',
  label: 'DeepSeek',
  baseUrl: 'https://api.deepseek.com/v1',
  local: false,
  needsKey: true,
};

const LOCAL: ProviderConfig = {
  id: 'ollama',
  kind: 'ollama',
  label: 'Ollama（本机）',
  baseUrl: 'http://127.0.0.1:11434',
  local: true,
  needsKey: false,
};

describe('draftForProvider', () => {
  it('默认供应商才预填模型名', () => {
    const asDefault = draftForProvider(CLOUD, {
      defaultProviderId: 'deepseek',
      defaultModel: 'deepseek-chat',
    });
    expect(asDefault.model).toBe('deepseek-chat');

    // 把 A 家的模型名填进 B 家的输入框，用户点测试会拿到 "model not found"，
    // 而原因在我们的预填，不在他的配置
    const other = draftForProvider(LOCAL, {
      defaultProviderId: 'deepseek',
      defaultModel: 'deepseek-chat',
    });
    expect(other.model).toBe('');
  });

  it('密钥永不回填（主进程只回布尔）', () => {
    expect(
      draftForProvider(CLOUD, { defaultProviderId: 'deepseek', defaultModel: 'x' }).apiKey,
    ).toBe('');
  });

  it('地址取供应商当前的值', () => {
    expect(draftForProvider(CLOUD, { defaultProviderId: null, defaultModel: '' }).baseUrl).toBe(
      'https://api.deepseek.com/v1',
    );
  });
});

describe('validateBaseUrlInput', () => {
  it('空输入给出"请填写"', () => {
    expect(validateBaseUrlInput('')).toContain('请填写');
    expect(validateBaseUrlInput('   ')).toContain('请填写');
  });

  it('少打 https:// 是最常见的一种，必须拦住', () => {
    // 放过去的话，主进程会把这个供应商整个丢掉
    expect(validateBaseUrlInput('api.deepseek.com/v1')).not.toBeNull();
  });

  it('非 http(s) 协议一律拒绝', () => {
    expect(validateBaseUrlInput('javascript:alert(1)')).not.toBeNull();
    expect(validateBaseUrlInput('file:///etc/passwd')).not.toBeNull();
  });

  it('合法的 http/https（含端口与子路径）通过', () => {
    for (const url of [
      'https://api.deepseek.com/v1',
      'http://127.0.0.1:11434',
      'https://llm.corp.example.com/proxy/v1/',
      '  https://api.moonshot.cn/v1  ',
    ]) {
      expect(validateBaseUrlInput(url), url).toBeNull();
    }
  });
});

describe('validateModelInput', () => {
  it('空 → 提示去点获取模型列表', () => {
    expect(validateModelInput('')).toContain('获取模型列表');
    expect(validateModelInput('   ')).not.toBeNull();
  });

  it('带空白 → 拒绝（多半是粘贴带进来的）', () => {
    expect(validateModelInput('deepseek chat')).not.toBeNull();
  });

  it('允许常见的分隔符', () => {
    for (const name of ['deepseek-chat', 'qwen3:8b', 'deepseek/deepseek-chat', 'glm_4.6']) {
      expect(validateModelInput(name), name).toBeNull();
    }
  });
});

describe('draftToProvider', () => {
  it('地址不合法时返回 null（调用方据此不发 IPC）', () => {
    expect(draftToProvider(CLOUD, 'api.deepseek.com')).toBeNull();
    expect(draftToProvider(CLOUD, '')).toBeNull();
  });

  it('规范化地址：去首尾空白与末尾斜杠', () => {
    const next = draftToProvider(CLOUD, '  https://proxy.example.com/v1///  ');
    expect(next?.baseUrl).toBe('https://proxy.example.com/v1');
  });

  it('**保留 local / needsKey / kind** —— 否则会绕过纯本地模式', () => {
    const next = draftToProvider(LOCAL, 'http://127.0.0.1:11435/');

    expect(next).not.toBeNull();
    expect(next?.local).toBe(true);
    expect(next?.needsKey).toBe(false);
    expect(next?.kind).toBe('ollama');
    expect(next?.id).toBe('ollama');
  });

  it('不改动原对象', () => {
    const source = { ...CLOUD };
    draftToProvider(source, 'https://other.example.com/v1');
    expect(source.baseUrl).toBe('https://api.deepseek.com/v1');
  });
});

describe('withUpdatedProvider', () => {
  it('替换同 id 的那一条，顺序不动', () => {
    const next = withUpdatedProvider(PROVIDER_PRESETS, { ...CLOUD, label: '改过了' });
    expect(next.map((p) => p.id)).toEqual(PROVIDER_PRESETS.map((p) => p.id));
    expect(next[0]?.label).toBe('改过了');
  });
});

describe('validateApiKeyInput', () => {
  it('空 → 拒绝', () => {
    expect(validateApiKeyInput('')).not.toBeNull();
    expect(validateApiKeyInput('   ')).not.toBeNull();
  });

  it('中间有空白 → 拒绝', () => {
    expect(validateApiKeyInput('sk-abcd efgh')).not.toBeNull();
    expect(validateApiKeyInput('sk-abcd\nefgh')).not.toBeNull();
  });

  it('首尾空白不算错（粘贴常态，主进程会 trim）', () => {
    expect(validateApiKeyInput('  sk-abcdefgh\n')).toBeNull();
  });
});

describe('credentialFailureText', () => {
  it('四类失败给四句不同的话（用户的下一步动作不同）', () => {
    const texts = (
      ['invalid-key', 'storage-unavailable', 'unknown-provider', 'write-failed'] as const
    ).map((kind) => credentialFailureText({ ok: false, kind, message: `原始信息-${kind}` }));

    expect(new Set(texts).size).toBe(4);
    expect(texts[1]).toContain('明文'); // storage-unavailable 必须说清"不会明文保存"
    expect(texts[3]).toContain('原始信息-write-failed'); // write-failed 原样透出主进程的话
  });
});

describe('credentialStatusText', () => {
  it('不需要密钥的供应商不显示"未配置"', () => {
    expect(credentialStatusText(LOCAL, false)).toContain('不需要密钥');
    expect(credentialStatusText(CLOUD, true)).toContain('已保存');
    expect(credentialStatusText(CLOUD, false)).toContain('未配置');
  });
});

describe('privacyNoteFor', () => {
  it('本机模型说"内容不出这台机器"', () => {
    expect(privacyNoteFor(LOCAL, false)).toContain('本机');
    expect(privacyNoteFor(LOCAL, true)).toContain('也能用');
  });

  it('云端 + 纯本地模式 → 说清"不会被调用"', () => {
    expect(privacyNoteFor(CLOUD, true)).toContain('纯本地模式');
    expect(privacyNoteFor(CLOUD, true)).toContain('不会被调用');
  });

  it('云端 + 未开纯本地 → 说清"会发出去、可能花钱"', () => {
    const text = privacyNoteFor(CLOUD, false);
    expect(text).toContain('发送');
    expect(text).toContain('费用');
  });
});

describe('testSuccessText', () => {
  it('成功时同时给出延迟与回声（回声是"确实是这个模型在答"的证据）', () => {
    const text = testSuccessText(820, 'deepseek-chat', '你好');
    expect(text).toContain('820');
    expect(text).toContain('deepseek-chat');
    expect(text).toContain('你好');
  });

  it('模型没有文字也要说清"请求是通的"', () => {
    const text = testSuccessText(300, 'qwq:32b', '');
    expect(text).toContain('通');
  });
});

describe('emptyDraft', () => {
  it('三项都是空串', () => {
    expect(emptyDraft()).toEqual({ baseUrl: '', model: '', apiKey: '' });
  });
});
