import { isRecord, type UnknownRecord } from './typeGuards';
import { isFormDataLike } from './http';
import type { TaskType } from '../adapters/types';
import type { SchemaGenerationPayload, SchemaGenerationMeta } from '../types/generation';
import type { ModelConfigEntry } from '../config/models.config';

const readRecordValue = (record: object, key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor !== undefined ? descriptor.value : undefined;
};

const writeRecordValue = (record: object, key: string, value: unknown): void => {
  Object.defineProperty(record, key, {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  });
};

const normalizeHeaders = (value: unknown): Record<string, string> | undefined => {
  if (!isRecord(value) || Array.isArray(value)) {
    return undefined;
  }
  const headers: Record<string, string> = {};
  for (const [key, headerValue] of Object.entries(value)) {
    if (typeof headerValue === 'string') {
      headers[key] = headerValue;
    }
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
};

const normalizeTaskType = (value: unknown): TaskType | undefined => {
  return value === 'text' || value === 'image' || value === 'video' || value === 'audio' || value === 'multimodal'
    ? value
    : undefined;
};

const normalizeApiConfig = (value: UnknownRecord): SchemaGenerationPayload['api'] => {
  const endpoint = readRecordValue(value, 'endpoint');
  const method = readRecordValue(value, 'method');
  const contentType = readRecordValue(value, 'contentType');
  const responseHandling = readRecordValue(value, 'responseHandling');
  return {
    endpoint: typeof endpoint === 'string' ? endpoint : undefined,
    method: typeof method === 'string' ? method : undefined,
    headers: normalizeHeaders(readRecordValue(value, 'headers')),
    contentType: typeof contentType === 'string' || contentType === null ? contentType : undefined,
    taskType: normalizeTaskType(readRecordValue(value, 'taskType')),
    responseHandling: isRecord(responseHandling) ? responseHandling : undefined,
  };
};

/**
 * 将模型默认配置（defaults）合并进 payload.api，仅在缺失时填充。
 */
export const applyModelDefaultsToPayload = (
  sourcePayload: SchemaGenerationPayload,
  modelConfig: ModelConfigEntry | null | undefined
): SchemaGenerationPayload => {
  const defaults = (modelConfig !== null && modelConfig !== undefined ? modelConfig.defaults : undefined);
  if (!isRecord(defaults) || Array.isArray(defaults)) {
    return sourcePayload;
  }

  const currentApi = isRecord(sourcePayload.api) ? sourcePayload.api : undefined;
  const mergedApi: UnknownRecord = currentApi ? { ...currentApi } : {};
  let mutated = false;

  for (const [key, value] of Object.entries(defaults)) {
    if (key === 'headers' && isRecord(value) && !Array.isArray(value)) {
      const currentHeaders = readRecordValue(mergedApi, 'headers');
      const existingHeaders = isRecord(currentHeaders) ? { ...currentHeaders } : {};
      let headerMutated = false;
      for (const [headerKey, headerValue] of Object.entries(value)) {
        if (existingHeaders[headerKey] === undefined) {
          existingHeaders[headerKey] = headerValue as unknown;
          headerMutated = true;
        }
      }
      if (headerMutated) {
        writeRecordValue(mergedApi, 'headers', existingHeaders);
        mutated = true;
      }
      continue;
    }

    if (mergedApi[key] === undefined) {
      mergedApi[key] = value as unknown;
      mutated = true;
    }
  }

  if (!mutated) {
    return sourcePayload;
  }

  const nextPayload: UnknownRecord = {
    ...sourcePayload,
    api: normalizeApiConfig(mergedApi),
  };
  const input = readRecordValue(nextPayload, 'input');
  const prompt = readRecordValue(nextPayload, 'prompt');
  const meta = readRecordValue(nextPayload, 'meta');
  const body = readRecordValue(nextPayload, 'body');
  const filtered: SchemaGenerationPayload = {
    api: normalizeApiConfig(mergedApi),
    input: undefined,
    prompt: undefined,
    meta: undefined,
    body: undefined,
  };
  if (input !== undefined) filtered.input = input as string;
  if (prompt !== undefined) filtered.prompt = prompt as string;
  if (meta !== undefined) filtered.meta = meta as SchemaGenerationMeta;
  if (body !== undefined) filtered.body = body as Record<string, unknown> | FormData;
  return filtered;
};

/**
 * 从 payload 中提取 prompt 文本，兼容多种字段结构。
 */
export const extractPromptFromPayload = (value: SchemaGenerationPayload): string => {
  const prompt = value.prompt;
  if (typeof prompt === 'string' && prompt.trim().length > 0) {
    return prompt;
  }
  const input = value.input;
  if (typeof input === 'string' && input.trim().length > 0) {
    return input;
  }
  const body = value.body;
  if (body && !isFormDataLike(body) && typeof body === 'object') {
    const promptCandidate = readRecordValue(body, 'prompt');
    const inputCandidate = readRecordValue(body, 'input');
    const candidate = promptCandidate ?? inputCandidate;
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate;
    }
  }
  return '';
};

/**
 * 构建历史记录所需的参数快照，剔除内部字段。
 */
export const buildHistoryParameters = (payload: SchemaGenerationPayload): UnknownRecord => {
  const { meta, ...rest } = payload;
  const parameters: UnknownRecord = { ...rest };
  if (isRecord(meta)) {
    const metaCopy: UnknownRecord = { ...meta };
    Reflect.deleteProperty(metaCopy, '_tempTaskId');
    Reflect.deleteProperty(metaCopy, '_historyId');
    if (Object.keys(metaCopy).length > 0) {
      writeRecordValue(parameters, 'meta', metaCopy);
    }
  }
  return parameters;
};
