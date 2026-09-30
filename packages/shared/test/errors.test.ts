import { describe, expect, it } from 'vitest';

import fixture from '../fixtures/error-codes.json';
import { ErrorCode } from '../src/errors';

/**
 * 错误码的跨语言一致性（`docs/13` M27）。
 *
 * 这份清单与 `services/sidecar/tests/test_errors.py` **共用同一个 JSON 文件**。
 * 只在本侧断言是不够的 —— 真正要防的是"两侧各自都对、合起来却换了码"：
 * 前端按码分支（`isUnauthorized` / `isConflict`…），后端按码定 HTTP 状态码。
 *
 * ⚠️ 本侧只校验**码名**（键）。状态码（值）只对 Python 侧有意义 ——
 * HTTP 响应由它发出，前端拿到的只是已经成形的状态码。
 */
const sharedCodes = fixture.codes as Record<string, number>;

describe('错误码 · 跨语言共享清单', () => {
  it('ErrorCode 的键与共享清单完全一致（多一个、少一个都算漂移）', () => {
    expect(Object.keys(ErrorCode).sort()).toEqual(Object.keys(sharedCodes).sort());
  });

  it('ErrorCode 是恒等映射 —— 键必须等于值', () => {
    // 看着多余，其实是跨语言可比的前提：Python 侧只认字符串码，
    // 一旦有人写成 `{ INVALID_PARAM: 'BAD_REQUEST' }`，
    // 上面那条"键一致"照样是绿的，而两端说的已经不是一回事了。
    for (const [key, value] of Object.entries(ErrorCode)) {
      expect(value, `ErrorCode.${key}`).toBe(key);
    }
  });
});
