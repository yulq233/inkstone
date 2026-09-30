/**
 * 代理绕过开关的单测（04 文档 §6.4、§8）。
 *
 * 值得测的点只有一个：`<-loopback>` 的 `-` 是**取反**，语义与字面读感相反。
 * 任何人（包括将来的我）看到它都可能当成笔误"顺手改成" `->loopback>` ——
 * 那样是静默失效：不报错、不警告，只在某些装了代理客户端的机器上表现为
 * "应用连不上自己的后端"。
 */

import { describe, expect, it } from 'vitest';
import { PROXY_BYPASS_LIST, PROXY_BYPASS_SWITCH, checkProxyBypassList } from '@inkstone/shared';

describe('代理绕过开关', () => {
  it('开关名与 Chromium 的命令行开关一致', () => {
    expect(PROXY_BYPASS_SWITCH).toBe('proxy-bypass-list');
  });

  it('loopback 取反写成 <-loopback>，不是 ->loopback>', () => {
    expect(PROXY_BYPASS_LIST).toContain('<-loopback>');
    expect(PROXY_BYPASS_LIST).not.toContain('->loopback>');
  });

  it('冗余保险项在位：显式列出 127.0.0.1 与 localhost', () => {
    const entries = PROXY_BYPASS_LIST.split(';');
    expect(entries).toContain('127.0.0.1');
    expect(entries).toContain('localhost');
  });

  it('当前取值通过自检', () => {
    expect(checkProxyBypassList(PROXY_BYPASS_LIST)).toEqual({ ok: true, problems: [] });
  });
});

describe('代理绕过自检', () => {
  it('取反写反了要能抓出来', () => {
    const result = checkProxyBypassList('->loopback>;127.0.0.1;localhost');
    expect(result.ok).toBe(false);
    expect(result.problems.join('')).toContain('->loopback>');
  });

  it('缺 <-loopback> 要能抓出来', () => {
    const result = checkProxyBypassList('127.0.0.1;localhost');
    expect(result.ok).toBe(false);
    expect(result.problems.join('')).toContain('<-loopback>');
  });

  it('丢了冗余保险项要能报出来', () => {
    expect(checkProxyBypassList('<-loopback>;127.0.0.1').problems).toContain(
      '缺少冗余保险项 localhost',
    );
  });

  it('空字符串是最危险的输入：全部规则都违反，一条都不能漏', () => {
    const result = checkProxyBypassList('');
    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(3);
  });

  it('多余空白不影响判定', () => {
    expect(checkProxyBypassList(' <-loopback> ; 127.0.0.1 ; localhost ').ok).toBe(true);
  });
});
