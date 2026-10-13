/**
 * 生成结果相关工具
 * - isBackendTaskPendingGeneration: 正式 backend task pending 回执识别
 * - isCompatSubmittedGeneration: 历史 submitted 回执识别（compat）
 * - normalizeGenerationResult: 将任意响应包装为 GenerationResult
 * - extractCompatRequestId: 从历史回执或原始响应中提取 requestId（compat）
 */

import type {
  BackendTaskPendingGeneration,
  CompatSubmittedGeneration,
  GenerationResult,
} from '../adapters/types';
import { isRecord, toStringSafe } from './typeGuards';
import { isFormDataLike } from './http';

const readRecordValue = (record: object, key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor !== undefined ? descriptor.value : undefined;
};

/**
 * Canvas 正式执行主链回执识别：__backend_task_pending + taskId。
 */
export const isBackendTaskPendingGeneration = (value: unknown): value is BackendTaskPendingGeneration => {
  if (!isRecord(value)) return false;
  return (
    readRecordValue(value, '__backend_task_pending') === true &&
    typeof readRecordValue(value, 'taskId') === 'string' &&
    String(readRecordValue(value, 'taskId')).trim().length > 0
  );
};

/**
 * @deprecated 仅保留给历史 compat 回执识别。
 */
export const isCompatSubmittedGeneration = (value: unknown): value is CompatSubmittedGeneration => {
  if (!isRecord(value)) return false;
  return readRecordValue(value, 'submitted') === true;
};

export const normalizeGenerationResult = (value: unknown): GenerationResult => {
  if (value === null || value === undefined) {
    return value as GenerationResult;
  }
  if (isFormDataLike(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value as GenerationResult;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value as GenerationResult;
  }
  if (isRecord(value)) {
    return value as GenerationResult;
  }
  return { data: value } as GenerationResult;
};

/**
 * @deprecated Canvas 正式执行主链不再消费 requestId。
 * 该函数仅保留给历史兼容路径。
 */
export const extractCompatRequestId = (value: unknown): string | undefined => {
  if (!isRecord(value)) {
    return toStringSafe(value);
  }

  const direct = readRecordValue(value, 'requestId') ?? readRecordValue(value, 'request_id') ?? readRecordValue(value, 'id');
  if (direct !== undefined) {
    const directStr = toStringSafe(direct);
    if (directStr) return directStr;
  }

  const rawCandidate = readRecordValue(value, 'raw');
  const raw = isRecord(rawCandidate) ? rawCandidate : undefined;
  if (raw) {
    const nested = readRecordValue(raw, 'requestId') ?? readRecordValue(raw, 'request_id') ?? readRecordValue(raw, 'id');
    const nestedStr = toStringSafe(nested);
    if (nestedStr) return nestedStr;
  }

  return undefined;
};
