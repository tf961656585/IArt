import { HUB_LOCAL_WRITE_TOKEN_HEADER } from '@iart/contracts';
import type { ZodType, ZodTypeDef } from 'zod';
import type { HubHttpClient, HubRequestJsonOptions } from '../types';

const DEFAULT_HEADERS = {
  'content-type': 'application/json',
};

const extractMessage = (payload: unknown): string => {
  if (!payload || typeof payload !== 'object') return '';
  const record = payload as Record<string, unknown>;
  const message = typeof record['message'] === 'string' ? record['message'].trim() : '';
  if (message) return message;
  const error = typeof record['error'] === 'string' ? record['error'].trim() : '';
  return error;
};

export class HubHttpError extends Error {
  status: number;
  payload: unknown;

  constructor(message: string, status: number, payload: unknown) {
    super(message);
    this.name = 'HubHttpError';
    this.status = status;
    this.payload = payload;
  }
}

const readJson = async (response: Response): Promise<unknown> => {
  return response.json().catch(() => null);
};

const isWriteMethod = (value: string | undefined) => {
  const method = typeof value === 'string' && value.trim() ? value.trim().toUpperCase() : 'GET';
  return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
};

const toFetchOptions = <TBody>(
  options: HubRequestJsonOptions<TBody> | undefined,
  hubWriteToken: string | undefined,
): RequestInit => {
  if (!options) return {};
  const init: RequestInit = {
    ...(options.method !== undefined ? { method: options.method } : {}),
    ...(options.cache !== undefined ? { cache: options.cache } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  };
  const writeHeaders = isWriteMethod(options.method) && typeof hubWriteToken === 'string' && hubWriteToken.trim()
    ? { [HUB_LOCAL_WRITE_TOKEN_HEADER]: hubWriteToken }
    : undefined;
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
    init.headers = {
      ...DEFAULT_HEADERS,
      ...(options.headers ?? {}),
      ...(writeHeaders ?? {}),
    };
  } else if (options.headers || writeHeaders) {
    init.headers = {
      ...(options.headers ?? {}),
      ...(writeHeaders ?? {}),
    };
  }
  return init;
};

export const createHubHttpClient = (baseUrl: string, hubWriteToken: string | undefined): HubHttpClient => {
  return {
    async requestJson<TResponse, TBody = unknown>(
      path: string,
      options: HubRequestJsonOptions<TBody> & { responseSchema: ZodType<TResponse, ZodTypeDef, unknown> },
    ): Promise<TResponse> {
      const response = await fetch(baseUrl + path, toFetchOptions(options, hubWriteToken));
      const payload = await readJson(response);
      if (!response.ok) {
        throw new HubHttpError(extractMessage(payload) || `http-${response.status}`, response.status, payload);
      }
      return options.responseSchema.parse(payload);
    },
    async requestVoid<TBody = unknown>(path: string, options: HubRequestJsonOptions<TBody> | undefined) {
      const response = await fetch(baseUrl + path, toFetchOptions(options, hubWriteToken));
      const payload = await readJson(response);
      if (!response.ok) {
        throw new HubHttpError(extractMessage(payload) || `http-${response.status}`, response.status, payload);
      }
    },
  };
};
