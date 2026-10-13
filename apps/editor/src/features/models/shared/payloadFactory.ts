import type { ApiRequestConfig } from "@/client/adapters/types";

import type { DynamicRecord } from '@/client/utils/typeGuards';
import type { SchemaGenerationPayload } from "@/client/types/generation";

export interface JsonPayloadOptions {
  endpoint: string;
  body: DynamicRecord | FormData | undefined;
  prompt: string | undefined;
  input: string | undefined;
  meta: DynamicRecord | undefined;
  method: string | undefined;
  contentType: string | null | undefined;
  includePromptAsInput: boolean | undefined;
  apiOverrides: Partial<ApiRequestConfig> | undefined;
}

type JsonPayloadMetaInput = DynamicRecord & {
  _tempTaskId: unknown | undefined;
  _historyId: unknown | undefined;
};

const removeUndefined = <T extends DynamicRecord>(source: T): T => {
  const next: DynamicRecord = {};
  Object.entries(source).forEach(([key, value]) => {
    if (value !== undefined) {
      next[key] = value;
    }
  });
  return next as T;
};

const normalizeSchemaGenerationMeta = (meta: DynamicRecord): SchemaGenerationPayload['meta'] => {
  const source: JsonPayloadMetaInput = {
    _tempTaskId: undefined,
    _historyId: undefined,
    ...meta,
  };
  return {
    ...meta,
    _tempTaskId: typeof source._tempTaskId === 'string' ? source._tempTaskId : undefined,
    _historyId: typeof source._historyId === 'string' ? source._historyId : undefined,
  };
};

export const createJsonGenerationPayload = (options: JsonPayloadOptions): SchemaGenerationPayload => {
  const {
    endpoint,
    body = {},
    prompt = "",
    input,
    meta,
    method = "POST",
    contentType = "application/json",
    includePromptAsInput = true,
    apiOverrides,
  } = options;

  const baseApi: ApiRequestConfig = removeUndefined({
    endpoint,
    method,
    contentType,
    headers: undefined,
    taskType: undefined,
    responseHandling: undefined,
  });

  const api: ApiRequestConfig = {
    ...baseApi,
    ...(apiOverrides ?? {}),
  };

  const resolvedInput = input ?? (includePromptAsInput ? prompt : undefined);

  const payload: SchemaGenerationPayload = {
    api,
    body,
    prompt,
    input: undefined,
    meta: undefined,
  };

  if (resolvedInput !== undefined) {
    payload.input = resolvedInput;
  }
  if (meta && Object.keys(meta).length > 0) {
    payload.meta = normalizeSchemaGenerationMeta(meta);
  }

  return payload;
};
