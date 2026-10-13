import OpenAI, { type ClientOptions as OpenAIClientOptions } from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import type { ChatAdapterConfig, ChatRequestTrace } from './types.js';

type FetchImplementation = NonNullable<OpenAIClientOptions['fetch']>;
type FetchRequestInput = Parameters<FetchImplementation>[0];
type FetchRequestInit = Parameters<FetchImplementation>[1];

type ClientFactoryOverrides = {
  fetch: FetchImplementation | undefined;
};

const MAX_TRACE_TEXT_CHARS = 100_000;
const MAX_TRACE_HEADER_CHARS = 2_000;

type HeaderTraceItem = {
  name: string;
  value: string;
};

type TraceText = {
  text: string;
  charCount: number;
  truncated: boolean;
};

const truncateTraceText = (value: string, limit: number): TraceText => {
  if (value.length <= limit) {
    return {
      text: value,
      charCount: value.length,
      truncated: false,
    };
  }
  return {
    text: value.slice(0, limit),
    charCount: value.length,
    truncated: true,
  };
};

const isRequestInstance = (value: unknown): value is Request => {
  const RequestCtor = globalThis.Request;
  return typeof RequestCtor === 'function' && value instanceof RequestCtor;
};

const isUrlInstance = (value: unknown): value is URL =>
  value instanceof URL;

const normalizeRequestUrl = (input: FetchRequestInput): string => {
  if (typeof input === 'string') {
    return input;
  }
  if (isUrlInstance(input)) {
    return input.toString();
  }
  if (isRequestInstance(input)) {
    return input.url;
  }
  return String(input);
};

const normalizeRequestMethod = (
  input: FetchRequestInput,
  init: FetchRequestInit,
): string => {
  if (init !== undefined && typeof init.method === 'string' && init.method.trim()) {
    return init.method.toUpperCase();
  }
  if (isRequestInstance(input) && typeof input.method === 'string' && input.method.trim()) {
    return input.method.toUpperCase();
  }
  return 'GET';
};

const redactHeaderValue = (name: string, value: string): string => {
  const normalized = name.toLowerCase();
  if (
    normalized === 'authorization' ||
    normalized === 'cookie' ||
    normalized === 'set-cookie' ||
    normalized.includes('api-key') ||
    normalized.includes('apikey') ||
    normalized.includes('token')
  ) {
    if (value.length <= 16) {
      return '[redacted]';
    }
    return `${value.slice(0, 8)}...[redacted]`;
  }
  return truncateTraceText(value, MAX_TRACE_HEADER_CHARS).text;
};

const headerItemsFromHeaders = (headers: Headers): HeaderTraceItem[] => {
  const items: HeaderTraceItem[] = [];
  headers.forEach((value, name) => {
    items.push({
      name,
      value: redactHeaderValue(name, value),
    });
  });
  return items.sort((a, b) => a.name.localeCompare(b.name));
};

const collectRequestHeaders = (
  input: FetchRequestInput,
  init: FetchRequestInit,
): HeaderTraceItem[] => {
  const headers = new Headers();
  if (isRequestInstance(input)) {
    input.headers.forEach((value, name) => {
      headers.set(name, value);
    });
  }
  if (init !== undefined && init.headers !== undefined) {
    const initHeaders = new Headers(init.headers);
    initHeaders.forEach((value, name) => {
      headers.set(name, value);
    });
  }
  return headerItemsFromHeaders(headers);
};

const parseJsonText = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};

const summarizeStringBody = (bodyText: string): unknown => {
  const text = truncateTraceText(bodyText, MAX_TRACE_TEXT_CHARS);
  return {
    kind: 'string',
    text: text.text,
    charCount: text.charCount,
    truncated: text.truncated,
    json: text.truncated ? null : parseJsonText(bodyText),
  };
};

const summarizeFormData = (formData: FormData): unknown => {
  const fields: unknown[] = [];
  formData.forEach((value, key) => {
    if (typeof value === 'string') {
      const text = truncateTraceText(value, MAX_TRACE_TEXT_CHARS);
      fields.push({
        key,
        kind: 'string',
        text: text.text,
        charCount: text.charCount,
        truncated: text.truncated,
      });
      return;
    }
    fields.push({
      key,
      kind: 'blob',
      size: value.size,
      type: value.type,
      name: value.name,
    });
  });
  return {
    kind: 'form-data',
    fields,
  };
};

const summarizeBody = (body: BodyInit | null | undefined): unknown => {
  if (body === null || body === undefined) {
    return null;
  }
  if (typeof body === 'string') {
    return summarizeStringBody(body);
  }
  if (body instanceof URLSearchParams) {
    return summarizeStringBody(body.toString());
  }
  const FormDataCtor = globalThis.FormData;
  if (typeof FormDataCtor === 'function' && body instanceof FormDataCtor) {
    return summarizeFormData(body);
  }
  const BlobCtor = globalThis.Blob;
  if (typeof BlobCtor === 'function' && body instanceof BlobCtor) {
    return {
      kind: 'blob',
      size: body.size,
      type: body.type,
    };
  }
  if (body instanceof ArrayBuffer) {
    return {
      kind: 'array-buffer',
      byteLength: body.byteLength,
    };
  }
  if (ArrayBuffer.isView(body)) {
    return {
      kind: 'array-buffer-view',
      byteLength: body.byteLength,
    };
  }
  return {
    kind: Object.prototype.toString.call(body),
  };
};

const summarizeRequestBody = (
  input: FetchRequestInput,
  init: FetchRequestInit,
): unknown => {
  if (init !== undefined && init.body !== undefined) {
    return summarizeBody(init.body);
  }
  if (isRequestInstance(input)) {
    return {
      kind: 'request-body',
      note: 'body-not-read-to-avoid-consuming-request-stream',
    };
  }
  return null;
};

const responseFinalUrl = (response: Response, requestUrl: string): string => {
  if (typeof response.url === 'string' && response.url.trim()) {
    return response.url;
  }
  return requestUrl;
};

const describeTraceError = (error: unknown): unknown => {
  if (error instanceof Error) {
    return {
      name: error.name || 'Error',
      message: error.message || String(error),
      stack: typeof error.stack === 'string' && error.stack.trim() ? error.stack : null,
    };
  }
  return {
    name: 'UnknownError',
    message: String(error),
    stack: null,
  };
};

const emitTrace = (
  trace: ChatRequestTrace,
  message: string,
  meta: unknown,
): void => {
  try {
    trace(message, meta);
  } catch {
    // Tracing must never affect remote request execution.
  }
};

const traceResponseBody = (
  trace: ChatRequestTrace,
  requestUrl: string,
  method: string,
  response: Response,
): void => {
  let responseClone: Response;
  try {
    responseClone = response.clone();
  } catch (error: unknown) {
    emitTrace(trace, 'chat adapter raw response body failed', {
      url: requestUrl,
      finalUrl: responseFinalUrl(response, requestUrl),
      method,
      status: response.status,
      error: describeTraceError(error),
    });
    return;
  }

  void responseClone.text()
    .then((bodyText) => {
      const text = truncateTraceText(bodyText, MAX_TRACE_TEXT_CHARS);
      emitTrace(trace, 'chat adapter raw response body', {
        url: requestUrl,
        finalUrl: responseFinalUrl(response, requestUrl),
        method,
        status: response.status,
        ok: response.ok,
        contentType: response.headers.get('content-type'),
        bodyText: text.text,
        bodyCharCount: text.charCount,
        truncated: text.truncated,
      });
    })
    .catch((error: unknown) => {
      emitTrace(trace, 'chat adapter raw response body failed', {
        url: requestUrl,
        finalUrl: responseFinalUrl(response, requestUrl),
        method,
        status: response.status,
        error: describeTraceError(error),
      });
    });
};

function resolveFetchImplementation(fetchImplementation: FetchImplementation | undefined): FetchImplementation {
  if (fetchImplementation !== undefined) {
    return fetchImplementation;
  }

  const defaultFetch = globalThis.fetch;
  if (typeof defaultFetch !== 'function') {
    throw new Error('Global fetch is unavailable for chat adapter SDK requests.');
  }
  return defaultFetch;
}

export function resolveOpenAICompatibleBaseURL(
  baseUrl: string | undefined,
): string | undefined {
  if (baseUrl === undefined) {
    return undefined;
  }

  const trimmedBaseUrl = baseUrl.trim();
  if (trimmedBaseUrl.length === 0) {
    return undefined;
  }

  try {
    const normalizedUrl = new URL(trimmedBaseUrl);
    const pathname = normalizedUrl.pathname;
    if (pathname === '' || pathname === '/') {
      normalizedUrl.pathname = '/v1';
    }
    return normalizedUrl.toString();
  } catch {
    return trimmedBaseUrl;
  }
}

async function fetchWithExplicitAbortOnly(
  fetchImplementation: FetchImplementation,
  url: RequestInfo,
  init: RequestInit | undefined,
  controller: AbortController,
): Promise<Response> {
  const requestInit: RequestInit = init === undefined ? {} : { ...init };
  const sourceSignal = requestInit.signal;
  const method = requestInit.method;
  const abort = (): void => {
    controller.abort();
  };
  let detachAbort = (): void => {};

  requestInit.signal = controller.signal;
  if (method !== undefined) {
    requestInit.method = method.toUpperCase();
  }

  if (sourceSignal !== undefined && sourceSignal !== null) {
    if (sourceSignal.aborted) {
      abort();
    } else {
      sourceSignal.addEventListener('abort', abort, { once: true });
      detachAbort = (): void => {
        sourceSignal.removeEventListener('abort', abort);
      };
    }
  }

  try {
    return await fetchImplementation.call(undefined, url, requestInit);
  } finally {
    detachAbort();
  }
}

class NoTimeoutOpenAI extends OpenAI {
  private readonly requestFetch: FetchImplementation;

  constructor(options: {
    apiKey: string;
    baseURL: string | undefined;
    fetch: FetchImplementation | undefined;
  }) {
    const requestFetch = resolveFetchImplementation(options.fetch);
    super({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      fetch: requestFetch,
    });
    this.requestFetch = requestFetch;
    this.timeout = 0;
    this.maxRetries = 0;
    this._options.timeout = 0;
    this._options.maxRetries = 0;
  }

  async fetchWithTimeout(
    url: RequestInfo,
    init: RequestInit | undefined,
    ms: number,
    controller: AbortController,
  ): Promise<Response> {
    void ms;
    return fetchWithExplicitAbortOnly(this.requestFetch, url, init, controller);
  }
}

class NoTimeoutAnthropic extends Anthropic {
  private readonly requestFetch: FetchImplementation;

  constructor(options: {
    apiKey: string;
    baseURL: string | undefined;
    fetch: FetchImplementation | undefined;
  }) {
    const requestFetch = resolveFetchImplementation(options.fetch);
    super({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      fetch: requestFetch,
    });
    this.requestFetch = requestFetch;
    this.timeout = 0;
    this.maxRetries = 0;
    this._options.timeout = 0;
    this._options.maxRetries = 0;
  }

  async fetchWithTimeout(
    url: RequestInfo,
    init: RequestInit | undefined,
    ms: number,
    controller: AbortController,
  ): Promise<Response> {
    void ms;
    return fetchWithExplicitAbortOnly(this.requestFetch, url, init, controller);
  }
}

export function createChatHttpTraceFetch(
  trace: ChatRequestTrace,
): FetchImplementation {
  const requestFetch = resolveFetchImplementation(undefined);

  return async (url: FetchRequestInput, init: FetchRequestInit): Promise<Response> => {
    const requestUrl = normalizeRequestUrl(url);
    const method = normalizeRequestMethod(url, init);
    emitTrace(trace, 'chat adapter raw request', {
      url: requestUrl,
      finalUrl: requestUrl,
      method,
      headers: collectRequestHeaders(url, init),
      body: summarizeRequestBody(url, init),
    });

    try {
      const response = await requestFetch.call(undefined, url, init);
      const finalUrl = responseFinalUrl(response, requestUrl);
      emitTrace(trace, 'chat adapter raw response', {
        url: requestUrl,
        finalUrl,
        method,
        status: response.status,
        ok: response.ok,
        statusText: response.statusText,
        headers: headerItemsFromHeaders(response.headers),
      });
      traceResponseBody(trace, requestUrl, method, response);
      return response;
    } catch (error: unknown) {
      emitTrace(trace, 'chat adapter raw response error', {
        url: requestUrl,
        finalUrl: requestUrl,
        method,
        error: describeTraceError(error),
      });
      throw error;
    }
  };
}

export function createOpenAIClient(
  apiConfig: ChatAdapterConfig,
  overrides: ClientFactoryOverrides | undefined = undefined,
): OpenAI {
  return new NoTimeoutOpenAI({
    apiKey: apiConfig.apiKey,
    baseURL: resolveOpenAICompatibleBaseURL(apiConfig.baseUrl),
    fetch: overrides === undefined ? undefined : overrides.fetch,
  });
}

export function createAnthropicClient(
  apiConfig: ChatAdapterConfig,
  overrides: ClientFactoryOverrides | undefined = undefined,
): Anthropic {
  return new NoTimeoutAnthropic({
    apiKey: apiConfig.apiKey,
    baseURL: apiConfig.baseUrl,
    fetch: overrides === undefined ? undefined : overrides.fetch,
  });
}
