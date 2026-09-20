/**
 * 错误码全集。sidecar（Python）返回的 code 必须与此处一一对应。
 * 详见 docs/03-M0-详细设计.md §1.2
 */
export const ErrorCode = {
  INVALID_PARAM: 'INVALID_PARAM',
  UNAUTHORIZED: 'UNAUTHORIZED',
  WORK_NOT_FOUND: 'WORK_NOT_FOUND',
  CHAPTER_NOT_FOUND: 'CHAPTER_NOT_FOUND',
  WORK_EXISTS: 'WORK_EXISTS',
  EXTERNAL_MODIFIED: 'EXTERNAL_MODIFIED',
  WRITE_FAILED: 'WRITE_FAILED',
  READ_FAILED: 'READ_FAILED',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** sidecar 的统一错误信封 */
export interface ApiErrorBody {
  error: {
    code: ErrorCode | string;
    message: string;
    detail?: unknown;
    traceId?: string;
  };
}

export function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null) return false;
  const e = (value as Record<string, unknown>).error;
  return typeof e === 'object' && e !== null && typeof (e as Record<string, unknown>).code === 'string';
}
