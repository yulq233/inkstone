/**
 * `isExternalHttpUrl` —— 外链白名单（`docs/13` H4）。
 *
 * 这条判定是 `will-navigate` 与 `setWindowOpenHandler` **共用**的那道口子。
 * 上一版 `setWindowOpenHandler` 是无条件 `shell.openExternal(url)`，
 * 与 `will-navigate` 的口径不一致 —— 这个文件把"一致"钉在测试里。
 *
 * 反例都挑的是 Windows 上真会被系统接管的东西：
 * `ms-settings:` 会打开设置面板，`\\host\share` 会带着当前凭据去连目标主机。
 */

import { describe, expect, it } from 'vitest';
import { isExternalHttpUrl } from '../src/main/url-guard';

describe('isExternalHttpUrl', () => {
  it('只放行 http / https', () => {
    for (const ok of [
      'http://127.0.0.1:5173',
      'https://example.com/page?q=1#frag',
      'HTTPS://EXAMPLE.COM',
    ]) {
      expect(isExternalHttpUrl(ok), ok).toBe(true);
    }
  });

  it('拒绝本机文件与自定义协议 —— 这些交给系统就是打开本机任意资源', () => {
    for (const bad of [
      'file:///C:/Windows/System32/calc.exe',
      'ms-settings:',
      'javascript:alert(1)',
      'data:text/html,<h1>x',
      'ftp://example.com',
      'mailto:a@b.c',
    ]) {
      expect(isExternalHttpUrl(bad), bad).toBe(false);
    }
  });

  it('拒绝 UNC 路径（双反斜杠开头的网络共享）—— 会带着凭据去连目标主机', () => {
    for (const bad of ['\\\\host\\share', '\\\\192.168.1.1\\c$']) {
      expect(isExternalHttpUrl(bad), bad).toBe(false);
    }
  });

  it('判不出来的（空串 / 畸形串）一律不放行 —— 一次点击不该把主进程带崩', () => {
    for (const bad of ['', '   ', 'not a url', '//example.com']) {
      expect(isExternalHttpUrl(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});
