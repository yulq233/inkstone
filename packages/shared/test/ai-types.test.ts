/**
 * AI 契约层的纯函数（`docs/11` P0）。
 *
 * `isValidBaseUrl` 用的是正则而不是 `new URL()`（本包没有 DOM/Node 全局，
 * 见 `ai-types.ts` 里的说明），所以它的边界必须自己钉住 ——
 * 正则写宽了会让 `javascript:` 这类东西混进 `fetch()`，写窄了会把合法的自建端点拒掉。
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AI_SETTINGS,
  FINISH_REASONS,
  PROVIDER_PRESETS,
  DAILY_BUDGET,
  clampDailyBudget,
  emptyAiRouting,
  isFinishReason,
  isProviderKind,
  isValidBaseUrl,
  isValidProviderId,
  normalizeBaseUrl,
  normalizeModelName,
  providerById,
  replaceProvider,
} from '../src/ai-types';

describe('isValidBaseUrl —— 供应商地址的形态', () => {
  it('接受 http / https，带端口与路径都行', () => {
    for (const ok of [
      'https://api.deepseek.com/v1',
      'http://127.0.0.1:11434',
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
      'https://x.example',
      '  https://x.example/v1  ',
    ]) {
      expect(isValidBaseUrl(ok), ok).toBe(true);
    }
  });

  it('拒绝没写 scheme 的地址 —— 这类请求发不出去，而报错只说 Invalid URL', () => {
    for (const bad of ['api.deepseek.com/v1', '127.0.0.1:11434', '//x.example/v1']) {
      expect(isValidBaseUrl(bad), bad).toBe(false);
    }
  });

  it('拒绝非 http(s) 协议 —— 别把 `javascript:` 喂进 fetch', () => {
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'ftp://x.example', 'data:,x']) {
      expect(isValidBaseUrl(bad), bad).toBe(false);
    }
  });

  it('拒绝空 host、含空白、非字符串', () => {
    for (const bad of [
      'https://',
      'https:// a.example/v1',
      'https://a b/v1',
      '',
      '   ',
      42,
      null,
    ]) {
      expect(isValidBaseUrl(bad), String(bad)).toBe(false);
    }
  });
});

describe('normalizeBaseUrl', () => {
  it('去首尾空白与末尾斜杠（拼接路径时少一个 `//` 的坑）', () => {
    expect(normalizeBaseUrl('  https://x.example/v1/  ')).toBe('https://x.example/v1');
    expect(normalizeBaseUrl('https://x.example///')).toBe('https://x.example');
  });
});

describe('isValidProviderId', () => {
  it('只认小写字母、数字、连字符，且不以连字符开头', () => {
    for (const ok of ['deepseek', 'my-relay-2', 'a']) expect(isValidProviderId(ok), ok).toBe(true);
    for (const bad of ['DeepSeek', '有中文', 'a/b', '-lead', '', 'x'.repeat(33), 1, null]) {
      expect(isValidProviderId(bad), String(bad)).toBe(false);
    }
  });
});

describe('isProviderKind', () => {
  it('只认两种协议', () => {
    expect(isProviderKind('openai-compatible')).toBe(true);
    expect(isProviderKind('ollama')).toBe(true);
    expect(isProviderKind('anthropic')).toBe(false);
    expect(isProviderKind(undefined)).toBe(false);
  });
});

describe('isFinishReason —— 收尾方式是闭合三值（H3）', () => {
  it('恰好三个值，与联合类型同一份真源', () => {
    expect([...FINISH_REASONS]).toEqual(['stop', 'length', 'aborted']);
    for (const ok of FINISH_REASONS) expect(isFinishReason(ok), ok).toBe(true);
  });

  it('上游方言一律拒绝 —— 归一化发生在 sidecar 网关，不是这里', () => {
    // 关键点：这些值**不该**在这里被接受。接受了就等于把"上游报文"当成了契约，
    // 而契约是 `stop | length | aborted`。渲染进程对它们报协议错误是有意的。
    for (const dialect of ['content_filter', 'end_turn', 'stop_sequence', 'tool_calls', 'STOP']) {
      expect(isFinishReason(dialect), dialect).toBe(false);
    }
  });

  it('拒绝非字符串与空值', () => {
    for (const bad of ['', undefined, null, 0, false]) {
      expect(isFinishReason(bad), String(bad)).toBe(false);
    }
    // 对象与数组单独写：`String({})` 是 `[object Object]`，当失败信息等于没说
    // （eslint 的 `no-base-to-string` 拦的正是这件事，所以不传 message）。
    expect(isFinishReason({})).toBe(false);
    expect(isFinishReason([])).toBe(false);
  });
});

describe('clampDailyBudget', () => {
  it('夹到 [0, 10000]；非有限数落回 0（不限）', () => {
    expect(clampDailyBudget(-1)).toBe(DAILY_BUDGET.min);
    expect(clampDailyBudget(1e9)).toBe(DAILY_BUDGET.max);
    expect(clampDailyBudget(Number.NaN)).toBe(DAILY_BUDGET.min);
    expect(clampDailyBudget('20')).toBe(DAILY_BUDGET.min);
    expect(clampDailyBudget(12.5)).toBe(12.5);
  });
});

describe('默认值自身的一致性', () => {
  it('预设里恰好有一个本机供应商（Ollama），且它不需要 Key', () => {
    const locals = PROVIDER_PRESETS.filter((p) => p.local);
    expect(locals.map((p) => p.id)).toEqual(['ollama']);
    expect(locals[0]?.needsKey).toBe(false);
  });

  it('每个预设的 baseUrl 都通过形态校验 —— 否则用户一开箱就是坏的', () => {
    for (const preset of PROVIDER_PRESETS) {
      expect(isValidBaseUrl(preset.baseUrl), preset.id).toBe(true);
      expect(isValidProviderId(preset.id), preset.id).toBe(true);
    }
  });

  it('预设 id 不重复', () => {
    const ids = PROVIDER_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('默认 routing 全为空 —— 没配模型时不能假装配好了', () => {
    const routing = emptyAiRouting();
    for (const value of Object.values(routing)) expect(value).toBeNull();
    expect(DEFAULT_AI_SETTINGS.defaultProviderId).toBeNull();
    expect(DEFAULT_AI_SETTINGS.defaultModel).toBe('');
  });

  it('默认开启"发送前确认"，默认不做 AI 草稿标记', () => {
    expect(DEFAULT_AI_SETTINGS.confirmContextPreview).toBe(true);
    expect(DEFAULT_AI_SETTINGS.markAiDraft).toBe(false);
    expect(DEFAULT_AI_SETTINGS.offlineOnly).toBe(false);
  });
});

describe('providerById', () => {
  it('按 id 命中，找不到就回 null（而不是回第一个）', () => {
    // 静默换一家会让请求打到用户根本没看的地方
    expect(providerById(PROVIDER_PRESETS, 'ollama')?.label).toContain('Ollama');
    expect(providerById(PROVIDER_PRESETS, 'nope')).toBeNull();
    expect(providerById(PROVIDER_PRESETS, null)).toBeNull();
    expect(providerById([], 'ollama')).toBeNull();
  });
});

describe('replaceProvider', () => {
  it('只替换同 id 的那一条，顺序与其它条不动', () => {
    const next = replaceProvider(PROVIDER_PRESETS, {
      ...PROVIDER_PRESETS[0],
      baseUrl: 'https://proxy.example.com/v1',
    });

    expect(next.map((p) => p.id)).toEqual(PROVIDER_PRESETS.map((p) => p.id));
    expect(next[0]?.baseUrl).toBe('https://proxy.example.com/v1');
    expect(next[1]).toEqual(PROVIDER_PRESETS[1]);
  });

  it('**保留 local / needsKey** —— 丢了会把本机模型当成云端', () => {
    const ollama = PROVIDER_PRESETS.find((p) => p.id === 'ollama');
    expect(ollama?.local).toBe(true);

    const next = replaceProvider(PROVIDER_PRESETS, {
      ...(ollama as (typeof PROVIDER_PRESETS)[number]),
      baseUrl: 'http://127.0.0.1:11435',
    });

    const replaced = next.find((p) => p.id === 'ollama');
    // `local` 决定它受不受"纯本地模式"限制；改成 false 就等于让本机模型被误拦
    expect(replaced?.local).toBe(true);
    expect(replaced?.needsKey).toBe(false);
    expect(replaced?.kind).toBe('ollama');
  });

  it('不改动入参数组（返回新数组）', () => {
    const source = PROVIDER_PRESETS.map((p) => ({ ...p }));
    const snapshot = JSON.stringify(source);
    replaceProvider(source, { ...source[0], label: '改过了' });
    expect(JSON.stringify(source)).toBe(snapshot);
  });

  it('id 不存在时不新增（打错 id 不该悄悄多一行）', () => {
    const next = replaceProvider(PROVIDER_PRESETS, {
      id: 'ghost',
      kind: 'openai-compatible',
      label: 'Ghost',
      baseUrl: 'https://x.example.com/v1',
      local: false,
      needsKey: true,
    });
    expect(next).toHaveLength(PROVIDER_PRESETS.length);
  });
});

describe('normalizeModelName', () => {
  it('去首尾空白', () => {
    expect(normalizeModelName('  deepseek-chat \n')).toBe('deepseek-chat');
  });

  it('允许模型名里合法出现的分隔符', () => {
    for (const name of ['qwen3:8b', 'deepseek/deepseek-chat', 'gpt-4o-mini', 'glm_4.6']) {
      expect(normalizeModelName(name), name).toBe(name);
    }
  });

  it('拒绝空、纯空白、非字符串、超长', () => {
    expect(normalizeModelName('')).toBeNull();
    expect(normalizeModelName('   ')).toBeNull();
    expect(normalizeModelName(undefined)).toBeNull();
    expect(normalizeModelName(42)).toBeNull();
    expect(normalizeModelName('a'.repeat(201))).toBeNull();
  });

  it('拒绝中间带空白的输入（多半是粘贴带进来的）', () => {
    expect(normalizeModelName('deepseek chat')).toBeNull();
  });
});
