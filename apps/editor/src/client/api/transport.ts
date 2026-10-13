import { resolveApiEndpoint, buildHeaders } from '../utils/apiConfig';
import { isFormDataLike, normalizeHeaders } from '../utils/http';
import { getRuntimeOrigin } from '../utils/runtimeUrl';
import { emitBackendTaskNotice } from '../utils/hubMonitorNoticeEmitter';
import type { ApiError, DynamicPayload, RequestOptions, StreamMode } from './clientTypes';
import { isApiError } from './clientTypes';
import { buildTaskTargetUrl, executeBackendTaskRequest, isHubRuntime, isLocalEndpoint, logHubTaskDecision, readTaskMetaString, resolveBackendTaskDecision } from './backendTaskFacade';
import { normalizeBody, parseJsonSafe, parseResponse, resolveTypedValue, shouldAttachJsonHeader } from './responseParser';
import { consumeRequestStream } from './streamAdapter';

const determineCredentials = (targetUrl: string | undefined): RequestCredentials => {
  if (typeof window === 'undefined') return 'include';
  if (!targetUrl) return 'include';
  const isLocalHost = (origin: string): boolean => {
    try {
      const parsed = new URL(origin);
      const host = parsed.hostname.toLowerCase();
      return host === 'localhost' || host === '127.0.0.1';
    } catch {
      return false;
    }
  };
  try {
    const origin = getRuntimeOrigin();
    const target = new URL(targetUrl, origin);
    if (target.origin === origin) return 'include';
    if (isLocalHost(target.origin) && isLocalHost(origin)) return 'include';
    return 'omit';
  } catch {
    return 'omit';
  }
};

const findHeaderKey = (target: Record<string, string>, name: string): string | undefined => {
  const lower = name.toLowerCase();
  return Object.keys(target).find((key) => key.toLowerCase() === lower);
};

const removeHeader = (target: Record<string, string>, name: string): void => {
  const key = findHeaderKey(target, name);
  if (key) delete target[key];
};

const hasHeader = (target: Record<string, string>, name: string): boolean => Boolean(findHeaderKey(target, name));

const setHeaderIfAbsent = (target: Record<string, string>, name: string, value: string): void => {
  if (!hasHeader(target, name)) target[name] = value;
};

const buildRequestInit = (value: {
  method: string;
  headers: DynamicPayload | undefined;
  includeAuth: boolean;
  contentType: string | null | undefined;
  cache: RequestCache | undefined;
  body: unknown;
  credentialsUrl: string;
}): RequestInit => {
  const normalizedHeaderInput = normalizeHeaders(value.headers);
  const baseHeaders = value.includeAuth ? buildHeaders(normalizedHeaderInput) : { ...normalizedHeaderInput };
  const disableContentType = value.contentType === null;

  if (disableContentType) {
    removeHeader(baseHeaders, 'content-type');
  } else if (typeof value.contentType === 'string' && value.contentType.trim()) {
    setHeaderIfAbsent(baseHeaders, 'Content-Type', value.contentType.trim());
  }

  const init: RequestInit = {
    method: value.method,
    headers: baseHeaders,
    credentials: determineCredentials(value.credentialsUrl),
  };
  if (value.cache) init.cache = value.cache;

  if (value.body !== undefined && value.body !== null) {
    if (isFormDataLike(value.body)) {
      const headersForForm = { ...baseHeaders };
      removeHeader(headersForForm, 'content-type');
      init.headers = headersForForm;
      init.body = value.body;
    } else {
      const shouldAttachJson = shouldAttachJsonHeader(value.body, baseHeaders, disableContentType);
      init.headers = shouldAttachJson ? { ...baseHeaders, 'Content-Type': 'application/json' } : baseHeaders;
      const normalizedBody = normalizeBody(value.body);
      if (normalizedBody !== undefined) init.body = normalizedBody;
    }
  }

  return init;
};

const parseErrorBody = async (resp: Response): Promise<unknown> => {
  const parsed = await parseJsonSafe(resp);
  if (parsed !== undefined) return parsed;
  try {
    return await resp.text();
  } catch {
    return undefined;
  }
};

const executeHttpRequest = async <T>(value: {
  targetEndpoint: string;
  opts: RequestOptions;
  effectiveStreamMode: StreamMode;
}): Promise<T> => {
  const { opts, effectiveStreamMode, targetEndpoint } = value;
  const {
    method = 'GET',
    headers,
    body,
    responseType = 'auto',
    includeAuth = true,
    resolveEndpoint = true,
    cache,
    contentType,
    onStream,
  } = opts;
  const url = resolveEndpoint ? resolveApiEndpoint(targetEndpoint) : targetEndpoint;
  try {
    const init = buildRequestInit({ method, headers, includeAuth, contentType, cache, body, credentialsUrl: url });
    const resp = await fetch(url, init);
    if (!resp.ok) {
      throw { message: `HTTP ${resp.status}`, status: resp.status, body: await parseErrorBody(resp) } as ApiError;
    }
    if (effectiveStreamMode !== 'disabled') return await consumeRequestStream<T>(resp, onStream);
    return await resolveTypedValue<T>(parseResponse(resp, responseType));
  } catch (error) {
    if (isApiError(error)) throw error;
    const message = error instanceof Error ? error.message : 'Network error';
    throw { message, body: null } as ApiError;
  }
};

const executeProxyRequest = async <T>(value: {
  targetEndpoint: string;
  opts: RequestOptions;
  effectiveStreamMode: StreamMode;
}): Promise<T> => {
  const { opts, effectiveStreamMode, targetEndpoint } = value;
  const { method = 'GET', headers, body, responseType = 'auto', includeAuth = true, resolveEndpoint = true, cache, contentType, onStream } = opts;
  const proxyBase = resolveApiEndpoint('/api/http-proxy');
  const init = buildRequestInit({ method, headers, includeAuth, contentType, cache, body, credentialsUrl: proxyBase });
  const resolvedTarget = buildTaskTargetUrl(targetEndpoint, resolveEndpoint);
  const proxyEndpoint = resolveApiEndpoint(`/api/http-proxy?url=${encodeURIComponent(resolvedTarget)}`);
  const resp = await fetch(proxyEndpoint, init);

  if (!resp.ok) {
    throw { message: `HTTP ${resp.status}`, status: resp.status, body: await parseErrorBody(resp) } as ApiError;
  }
  if (effectiveStreamMode !== 'disabled') return await consumeRequestStream<T>(resp, onStream);
  return await resolveTypedValue<T>(parseResponse(resp, responseType));
};

export async function request<T = unknown>(opts: RequestOptions): Promise<T> {
  const { endpoint, streamMode = 'disabled', onStream, taskMeta } = opts;
  const effectiveStreamMode: StreamMode = streamMode === 'disabled' && typeof onStream === 'function' ? 'auto' : streamMode;
  const backendTaskDecision = resolveBackendTaskDecision(opts, effectiveStreamMode);
  const useBackendTaskFlag = backendTaskDecision.useBackendTask;
  const hubRuntime = isHubRuntime();
  const localEndpoint = isLocalEndpoint(endpoint);
  const shouldProxyStream = hubRuntime && !localEndpoint && effectiveStreamMode !== 'disabled';
  const taskScope = readTaskMetaString(taskMeta, 'scope') || 'unknown';
  const backendTaskProjectPath = readTaskMetaString(taskMeta, 'projectPath') || null;
  const backendTaskId = readTaskMetaString(taskMeta, 'taskId') || null;

  if (hubRuntime && !localEndpoint && !useBackendTaskFlag && !shouldProxyStream) {
    logHubTaskDecision({ taskCreateDecision: 'bypass_backend_task', useBackendTask: false, taskId: null, taskScope, projectPath: backendTaskProjectPath, reasonCode: backendTaskDecision.reason, reasonText: backendTaskDecision.reasonText });
    throw { message: 'Hub 模式下禁止前端直连远程接口，请通过后端 Task 执行请求', status: 400, body: null } as ApiError;
  }

  if (hubRuntime && !useBackendTaskFlag && taskMeta && typeof taskMeta === 'object') {
    logHubTaskDecision({ taskCreateDecision: 'bypass_backend_task', useBackendTask: false, taskId: null, taskScope, projectPath: backendTaskProjectPath, reasonCode: backendTaskDecision.reason, reasonText: backendTaskDecision.reasonText });
    emitBackendTaskNotice({ type: 'backend_task_bypassed', reasonCode: backendTaskDecision.reason, reasonText: backendTaskDecision.reasonText, endpoint, useBackendTask: false, taskCreateDecision: 'bypass_backend_task', taskScope, projectPath: backendTaskProjectPath, taskId: backendTaskId });
  }

  if (useBackendTaskFlag) return await executeBackendTaskRequest<T>(opts);
  const executor = shouldProxyStream ? executeProxyRequest<T> : executeHttpRequest<T>;

  return await executor({ targetEndpoint: endpoint, opts, effectiveStreamMode });
}

export async function backendRequest<T = unknown>(opts: RequestOptions): Promise<T> {
  if (!isHubRuntime()) return request<T>({ ...opts, useBackendTask: false });
  return executeBackendTaskRequest<T>({ ...opts, useBackendTask: true });
}

export async function getJson<T = unknown>(endpoint: string, opts: Partial<RequestOptions> | undefined) {
  return request<T>({ method: 'GET', endpoint, ...(opts || {}), responseType: (opts !== null && opts !== undefined ? opts.responseType : undefined) ?? 'json' });
}

export async function postJson<T = unknown>(endpoint: string, body: unknown | undefined, opts: Partial<RequestOptions> | undefined) {
  return request<T>({ method: 'POST', endpoint, body, ...(opts || {}), responseType: (opts !== null && opts !== undefined ? opts.responseType : undefined) ?? 'json' });
}

export async function postForm<T = unknown>(endpoint: string, form: FormData, opts: Partial<RequestOptions> | undefined) {
  return request<T>({ method: 'POST', endpoint, body: form, ...(opts || {}), responseType: (opts !== null && opts !== undefined ? opts.responseType : undefined) ?? 'json' });
}
