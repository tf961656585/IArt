import { isFormDataLike } from '../utils/http';
import type { ResponseTypeHint } from './clientTypes';
import { isSerializedFormData } from './formDataSerializer';

export const resolveTypedValue = async <T>(value: Promise<unknown>): Promise<T> => {
  return (await value) as T;
};

export async function parseJsonSafe(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

export function shouldAttachJsonHeader(
  body: unknown,
  headers: Record<string, string>,
  contentTypeDisabled: boolean
): boolean {
  if (contentTypeDisabled) return false;
  if (headers['Content-Type'] || headers['content-type']) return false;
  if (body === undefined || body === null) return false;
  if (typeof body === 'string' || body instanceof String) return false;
  if (isFormDataLike(body)) return false;
  if (isSerializedFormData(body)) return false;
  return true;
}

export function normalizeBody(body: unknown): BodyInit | undefined {
  if (body === undefined || body === null) {
    return undefined;
  }
  if (isFormDataLike(body)) {
    return body;
  }
  if (typeof body === 'string' || body instanceof String) {
    return body.toString();
  }
  return JSON.stringify(body);
}

export async function parseResponse(res: Response, hint: 'json' | 'auto'): Promise<unknown>;
export async function parseResponse(res: Response, hint: 'text'): Promise<string>;
export async function parseResponse(res: Response, hint: 'blob'): Promise<Blob>;
export async function parseResponse(res: Response, hint: 'arrayBuffer'): Promise<ArrayBuffer>;
export async function parseResponse(res: Response, hint: 'response'): Promise<Response>;
export async function parseResponse(res: Response, hint: ResponseTypeHint): Promise<unknown>;
export async function parseResponse(res: Response, hint: ResponseTypeHint): Promise<unknown> {
  switch (hint) {
    case 'json':
      return await res.json();
    case 'text':
      return await res.text();
    case 'blob':
      return await res.blob();
    case 'arrayBuffer':
      return await res.arrayBuffer();
    case 'response':
      return res;
    case 'auto':
    default: {
      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      if (contentType.includes('application/json')) {
        return await res.json();
      }
      return await res.text();
    }
  }
}
