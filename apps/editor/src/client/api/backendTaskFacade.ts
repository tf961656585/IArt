import { buildHeaders, getRemoteApiBase, hasLocalHubBaseHint, resolveLocalApiRequestTarget } from '../utils/apiConfig';
import { getRuntimeProjectPath } from '../store/runtimeStore';
import { getRuntimeAppVersion } from '../utils/appVersion';
import { normalizeHeaders, isFormDataLike } from '../utils/http';
import { emitBackendTaskAccepted } from '../utils/taskCreationEmitter';
import type { ApiError, BackendTaskPendingResult, DynamicPayload, RequestOptions, StreamMode, TaskMetadata } from './clientTypes';
import { asTypedValue, buildBackendTaskPendingResult } from './clientTypes';
import { isSerializedFormData, serializeFormDataForBusinessAction } from './formDataSerializer';
import { shouldAttachJsonHeader } from './responseParser';
import { request } from './transport';

export type BackendTaskDecisionReason =
  | 'not_hub_runtime'
  | 'explicit_disable'
  | 'stream_mode_enabled'
  | 'endpoint_unresolvable'
  | 'local_endpoint'
  | 'backend_task_required';

export type BackendTaskDecision = {
  useBackendTask: boolean;
  reason: BackendTaskDecisionReason;
  reasonText: string;
};

type RuntimeHttpTaskRequestPayload = {
  url: unknown | undefined;
  method: unknown | undefined;
  headers: unknown | undefined;
  body: unknown | undefined;
};

type RuntimeHttpTaskRequest = {
  request: RuntimeHttpTaskRequestPayload | undefined;
};

export const isDesktopRuntime = (): boolean => {
  if (typeof window === 'undefined') return false;
  return Boolean((window as Window & { electron: unknown | undefined }).electron);
};

export const isHubRuntime = (): boolean => {
  if (isDesktopRuntime()) return true;
  if (typeof window === 'undefined') return false;
  return hasLocalHubBaseHint();
};

export const normalizeMetaString = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

export const readTaskMetaString = (meta: DynamicPayload | undefined | null, key: string): string => {
  if (!meta) return '';
  return normalizeMetaString(meta[key]);
};

const shouldAutoAttachProjectPathToBackendTask = (taskMeta: DynamicPayload | undefined): boolean => {
  const scope = readTaskMetaString(taskMeta, 'scope').toLowerCase();
  if (scope === 'global') return false;
  if (readTaskMetaString(taskMeta, 'projectPath')) return false;
  return true;
};

const readProjectPathFromLocation = (): string | null => {
  const runtimeProjectPath = getRuntimeProjectPath();
  if (runtimeProjectPath) return runtimeProjectPath;
  if (typeof window === 'undefined') return null;
  try {
    const parsed = new URL(window.location.href);
    const projectPath = parsed.searchParams.get('projectPath');
    return projectPath && projectPath.trim() ? projectPath.trim() : null;
  } catch {
    return null;
  }
};

const getCachedProjectPathForBackendTask = async (): Promise<string | null> => {
  const fromLocation = readProjectPathFromLocation();
  if (fromLocation) return fromLocation;
  return null;
};

export const isLocalEndpoint = (endpoint: string): boolean => {
  if (!endpoint) return false;
  const trimmed = endpoint.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('data:') || trimmed.startsWith('blob:')) return true;
  if (trimmed.startsWith('/api/') || trimmed.startsWith('/files/') || trimmed === '/health') return true;
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      const host = url.hostname.toLowerCase();
      return host === 'localhost' || host === '127.0.0.1';
    } catch {
      return false;
    }
  }
  return false;
};

export const buildTaskTargetUrl = (endpoint: string, resolveEndpoint: boolean): string => {
  if (!resolveEndpoint) return endpoint;
  const trimmed = endpoint.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const base = getRemoteApiBase().replace(/\/$/, '');
  if (!base) return trimmed;
  if (trimmed.startsWith('/')) return `${base}${trimmed}`;
  return `${base}/${trimmed}`;
};

export const describeBackendTaskDecisionReason = (reason: BackendTaskDecisionReason): string => {
  switch (reason) {
    case 'not_hub_runtime': return '非 Hub 运行时';
    case 'explicit_disable': return '请求显式禁用 useBackendTask';
    case 'stream_mode_enabled': return '流式模式由直连/代理链路处理';
    case 'endpoint_unresolvable': return '端点未启用 resolveEndpoint 且不是绝对地址';
    case 'local_endpoint': return '本地端点（/api 或 localhost）';
    case 'backend_task_required': return 'Hub 远端请求，默认进入后端 task 提交';
    default: return '未知原因';
  }
};

export const resolveBackendTaskDecision = (
  opts: RequestOptions,
  effectiveStreamMode: StreamMode,
): BackendTaskDecision => {
  if (!isHubRuntime()) {
    return { useBackendTask: false, reason: 'not_hub_runtime', reasonText: describeBackendTaskDecisionReason('not_hub_runtime') };
  }
  if (opts.useBackendTask === false) {
    return { useBackendTask: false, reason: 'explicit_disable', reasonText: describeBackendTaskDecisionReason('explicit_disable') };
  }
  if (effectiveStreamMode !== 'disabled') {
    return { useBackendTask: false, reason: 'stream_mode_enabled', reasonText: describeBackendTaskDecisionReason('stream_mode_enabled') };
  }
  const endpointTrimmed = opts.endpoint.trim();
  const isAbsolute = /^https?:\/\//i.test(endpointTrimmed);
  const resolveEndpoint = opts.resolveEndpoint !== false;
  if (!resolveEndpoint && !isAbsolute) {
    return { useBackendTask: false, reason: 'endpoint_unresolvable', reasonText: describeBackendTaskDecisionReason('endpoint_unresolvable') };
  }
  if (isLocalEndpoint(opts.endpoint)) {
    return { useBackendTask: false, reason: 'local_endpoint', reasonText: describeBackendTaskDecisionReason('local_endpoint') };
  }
  return { useBackendTask: true, reason: 'backend_task_required', reasonText: describeBackendTaskDecisionReason('backend_task_required') };
};

export const logHubTaskDecision = (payload: {
  taskCreateDecision: 'create_backend_task' | 'bypass_backend_task';
  useBackendTask: boolean;
  taskId: string | null;
  taskScope: string;
  projectPath: string | null;
  reasonCode: BackendTaskDecisionReason;
  reasonText: string;
}) => {
  try {
    console.info('[request][hub-task-decision]', payload);
  } catch {
    // ignore
  }
};

const buildTaskRequestHeaders = (
  baseHeaders: Record<string, string>,
  contentType: string | null | undefined,
  body: unknown,
): Record<string, string> => {
  const headers = { ...baseHeaders };
  if (isFormDataLike(body) || isSerializedFormData(body)) {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'content-type') delete headers[key];
    }
    return headers;
  }
  const disableContentType = contentType === null;
  if (disableContentType) {
    if (headers['Content-Type']) delete headers['Content-Type'];
    if (headers['content-type']) delete headers['content-type'];
    return headers;
  }
  if (typeof contentType === 'string' && contentType.trim()) {
    headers['Content-Type'] = contentType.trim();
    return headers;
  }
  if (shouldAttachJsonHeader(body, headers, false)) headers['Content-Type'] = 'application/json';
  return headers;
};

const normalizeTaskIdFromHttpPayload = (payload: unknown): string | null => {
  if (!payload || typeof payload !== 'object') return null;
  const value = (payload as { taskId: unknown | undefined }).taskId;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
};

const readContentTypeFromHeaders = (headers: Record<string, string>): unknown => {
  return headers['Content-Type'] ?? headers['content-type'];
};

const createBackendTaskViaRuntimeHttp = async (
  taskRequest: DynamicPayload,
  metadata: TaskMetadata,
): Promise<{ taskId: string }> => {
  const projectPath = typeof metadata.projectPath === 'string' ? metadata.projectPath.trim() : '';
  if (!projectPath) throw new Error('Business action submit requires projectPath');
  const modelId = readTaskMetaString(metadata, 'modelId') || readTaskMetaString(metadata, 'model_id');
  if (!modelId) throw new Error('HTTP task submit requires modelId');
  const taskRequestView = taskRequest as RuntimeHttpTaskRequest;
  const rawRequestPayload = taskRequestView.request;
  const requestPayload: RuntimeHttpTaskRequestPayload = rawRequestPayload && typeof rawRequestPayload === 'object'
    ? rawRequestPayload
    : { url: undefined, method: undefined, headers: undefined, body: undefined };
  const requestHeaders = requestPayload.headers && typeof requestPayload.headers === 'object'
    ? requestPayload.headers as Record<string, string>
    : {};
  const taskTarget = await resolveLocalApiRequestTarget('/api/tasks', {
    allowRelativeFallback: true,
    allowStoredFallback: undefined,
  });
  const response = await fetch(taskTarget.endpoint, {
    method: 'POST',
    headers: buildHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      model_id: modelId,
      prebuilt_payload: {
        api: {
          endpoint: requestPayload.url,
          method: requestPayload.method,
          headers: requestHeaders,
          contentType: readContentTypeFromHeaders(requestHeaders),
        },
        body: requestPayload.body,
      },
      metadata,
      projectPath,
    }),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && typeof (payload as { message: unknown | undefined }).message === 'string'
      ? (payload as { message: string }).message
      : `HTTP ${response.status}`;
    throw { message, status: response.status, body: payload } as ApiError;
  }
  const taskId = normalizeTaskIdFromHttpPayload(payload);
  if (!taskId) {
    throw { message: '任务没能提交成功，请重试。', status: 502, body: payload } as ApiError;
  }
  return { taskId };
};

const shouldUseCanvasPushManagedTask = (taskMeta: RequestOptions['taskMeta']): boolean => {
  if (!taskMeta || typeof taskMeta !== 'object') return false;
  const scope = readTaskMetaString(taskMeta, 'scope').toLowerCase();
  return scope === 'canvas' && taskMeta.canvasPushManaged === true;
};

export const executeBackendTaskRequest = async <T>(opts: RequestOptions): Promise<T> => {
  const { method = 'GET', endpoint, headers, body, includeAuth = true, resolveEndpoint = true, contentType, taskMeta, onTaskAccepted } = opts;
  const normalizedHeaderInput = normalizeHeaders(headers as DynamicPayload | undefined);
  const canvasPushManaged = shouldUseCanvasPushManagedTask(taskMeta);
  const baseHeaders = includeAuth ? buildHeaders(normalizedHeaderInput) : { ...normalizedHeaderInput };
  let taskBody: unknown = body;

  if (isFormDataLike(body)) {
    try {
      taskBody = await serializeFormDataForBusinessAction(body);
    } catch (error) {
      console.warn('[request] FormData 序列化失败，回退前端直连', error);
      if (isHubRuntime()) {
        throw { message: '当前上传方式无法完成，请换一种上传方式，或重新打开项目后重试。', status: 400, body: null } as ApiError;
      }
      return request<T>({ ...opts, useBackendTask: false });
    }
  }

  const taskRequestHeaders = buildTaskRequestHeaders(baseHeaders, contentType, taskBody);
  const targetUrl = buildTaskTargetUrl(endpoint, resolveEndpoint);
  const executeOnce = async (target: string): Promise<T> => {
    const metadata: TaskMetadata = { ...(taskMeta ?? {}), source: 'renderer', createdAt: new Date().toISOString(), endpoint: target };
    if (shouldAutoAttachProjectPathToBackendTask(taskMeta)) {
      const inferredProjectPath = await getCachedProjectPathForBackendTask();
      if (inferredProjectPath && !readTaskMetaString(metadata, 'projectPath')) metadata.projectPath = inferredProjectPath;
      if (inferredProjectPath && !readTaskMetaString(metadata, 'scope')) metadata.scope = 'project';
    }
    const runtimeAppVersion = getRuntimeAppVersion();
    if (runtimeAppVersion && !('appVersion' in metadata)) metadata.appVersion = runtimeAppVersion;
    const taskPayload = {
      type: 'http',
      request: { url: target, method, headers: taskRequestHeaders, body: taskBody },
      metadata,
    } as DynamicPayload;

    const taskAck = await createBackendTaskViaRuntimeHttp(taskPayload, metadata);
    const backendTaskId = taskAck.taskId;
    logHubTaskDecision({
      taskCreateDecision: 'create_backend_task',
      useBackendTask: true,
      taskId: null,
      taskScope: readTaskMetaString(metadata, 'scope') || 'unknown',
      projectPath: readTaskMetaString(metadata, 'projectPath') || null,
      reasonCode: 'backend_task_required',
      reasonText: describeBackendTaskDecisionReason('backend_task_required'),
    });

    if (onTaskAccepted && backendTaskId) {
      try {
        onTaskAccepted(backendTaskId);
      } catch (e) {
        console.warn('[executeBackendTaskRequest] onTaskAccepted callback failed:', e);
      }
    }

    if (backendTaskId) {
      const creationMeta: TaskMetadata = { ...metadata };
      delete creationMeta.taskId;
      emitBackendTaskAccepted(backendTaskId, { ...creationMeta, taskId: backendTaskId, taskType: 'http', targetUrl: target });
    }

    const pendingResult: BackendTaskPendingResult = buildBackendTaskPendingResult(backendTaskId);
    if (canvasPushManaged) return asTypedValue<T>(pendingResult);
    return asTypedValue<T>(pendingResult);
  };

  return await executeOnce(targetUrl);
};
