import {
  runtimeTaskRowToView,
  UNIFIED_GENERATION_STATUS_SET,
} from '@iart/contracts';
import type {
  RuntimeTaskFailure,
  RuntimeTaskRow,
  RuntimeTaskView,
  UnifiedGenerationStatus,
} from '@iart/contracts';
import {
  projectRuntimeTaskFailureSummary,
  projectRuntimeTaskMetadataSummary,
  projectRuntimeTaskRequestSummary,
} from './task-storage-summary-projector.cts';
import * as loggingModule from './logging.cts';

type PlainObject = Record<string, unknown>;
type RuntimeTaskStatus = UnifiedGenerationStatus;

interface RawTaskRecord {
  metadata: unknown | undefined;
  request: unknown | undefined;
  progress: unknown | undefined;
  error: unknown | undefined;
  projectPath: unknown | undefined;
  status: unknown | undefined;
  taskId: unknown | undefined;
  id: unknown | undefined;
  createdAt: unknown | undefined;
  updatedAt: unknown | undefined;
  startedAt: unknown | undefined;
  finishedAt: unknown | undefined;
}

interface RawTaskMetadata {
  sourceNodeId: unknown | undefined;
  targetNodeId: unknown | undefined;
  batchId: unknown | undefined;
  batch_id: unknown | undefined;
  projectPath: unknown | undefined;
  remoteRequestId: unknown | undefined;
  remote_request_id: unknown | undefined;
}

interface RawTaskProgress {
  percent: unknown | undefined;
  message: unknown | undefined;
  phase: unknown | undefined;
}

interface RawTaskError {
  message: unknown | undefined;
  code: unknown | undefined;
  userMessage: unknown | undefined;
  backendMessage: unknown | undefined;
  retryable: unknown | undefined;
  details: unknown | undefined;
  detail: unknown | undefined;
  cause: unknown | undefined;
}

interface RawTaskErrorCause {
  code: unknown | undefined;
}

type RuntimeTaskBuildOptions = {
  fallbackStatus: unknown | undefined;
  statusNormalizer: (status: unknown) => unknown | undefined;
  projectPathResolver: (metadata: RawTaskMetadata) => unknown | undefined;
};

const normalizeString = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

const normalizeRuntimeTaskNumber = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const isPlainObject = (value: unknown): value is PlainObject => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const asPlainObject = <T,>(value: unknown, fallback: T): T =>
  (isPlainObject(value) ? value : fallback) as T;

const normalizeRuntimeTaskStatus = (value: unknown, fallback: RuntimeTaskStatus): RuntimeTaskStatus => {
  const normalized = normalizeString(value);
  return UNIFIED_GENERATION_STATUS_SET.has(normalized) ? normalized as RuntimeTaskStatus : fallback;
};

const optionalString = (value: unknown) => normalizeString(value) || undefined;

const tryParseJson = (value: string): unknown | null => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
};

const pickNested = (source: unknown, path: string[]): unknown => {
  let current = source;
  for (const key of path) {
    if (!isPlainObject(current)) return undefined;
    current = current[key];
  }
  return current;
};

const pickStringByPaths = (source: unknown, paths: string[][]): string | null => {
  for (const path of paths) {
    const value = optionalString(pickNested(source, path));
    if (value) return value;
  }
  return null;
};

const collectReasonTags = (value: unknown, tags = new Set<string>()): string[] => {
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (normalized && normalized.length <= 80) tags.add(normalized);
    return [...tags];
  }
  if (Array.isArray(value)) {
    for (const item of value) collectReasonTags(item, tags);
    return [...tags];
  }
  if (!isPlainObject(value)) return [...tags];
  for (const key of ['failureReasons', 'failure_reasons', 'reasons', 'reason', 'label', 'labels']) {
    if (Object.prototype.hasOwnProperty.call(value, key)) collectReasonTags(value[key], tags);
  }
  return [...tags];
};

const extractJsonObjectFromText = (value: string): unknown | null => {
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return tryParseJson(value.slice(start, end + 1));
};

const resolveKnownUserMessage = (code: string | null, details: unknown): string | null => {
  const normalizedCode = normalizeString(code);
  if (normalizedCode === 'PUBLIC_ERROR_SEXUAL') return '内容安全策略拦截';
  const reasonTags = collectReasonTags(details).map((tag) => tag.toUpperCase());
  if (reasonTags.includes('NCII')) return '内容安全策略拦截';
  return null;
};

const normalizeRuntimeTaskFailure = (errorInput: unknown): RuntimeTaskFailure | null => {
  if (errorInput === null || errorInput === undefined) return null;
  if (typeof errorInput !== 'string' && !isPlainObject(errorInput)) return null;
  if (isPlainObject(errorInput) && Object.keys(errorInput).length === 0) return null;
  const error = asPlainObject<RawTaskError>(errorInput, {
    message: undefined,
    code: undefined,
    userMessage: undefined,
    backendMessage: undefined,
    retryable: undefined,
    details: undefined,
    detail: undefined,
    cause: undefined,
  });
  const cause = asPlainObject<RawTaskErrorCause>(error.cause, {
    code: undefined,
  });
  const causeCode = cause.code;
  const rawMessage = optionalString(error.message) ?? (typeof errorInput === 'string' ? normalizeString(errorInput) : '');
  const parsedFromMessage = rawMessage ? (tryParseJson(rawMessage) ?? extractJsonObjectFromText(rawMessage)) : null;
  const details = error.details ?? error.detail ?? parsedFromMessage ?? (isPlainObject(error.cause) || Array.isArray(error.cause) ? error.cause : null);
  const code =
    optionalString(error.code) ??
    optionalString(causeCode) ??
    pickStringByPaths(details, [
      ['code'],
      ['error', 'code'],
      ['data', 'code'],
      ['status', 'code'],
    ]) ??
    null;
  const knownUserMessage = resolveKnownUserMessage(code, details);
  const userMessage = optionalString(error.userMessage) ?? knownUserMessage;
  const detailMessage = pickStringByPaths(details, [
    ['message'],
    ['error', 'message'],
    ['data', 'message'],
    ['status', 'message'],
  ]);
  const message =
    userMessage ??
    detailMessage ??
    (rawMessage && rawMessage.length <= 240 && !rawMessage.includes('{') ? rawMessage : null) ??
    code ??
    '任务执行失败';
  const backendMessage = optionalString(error.backendMessage) ?? (rawMessage || null);
  const retryable = typeof error.retryable === 'boolean' ? error.retryable : null;
  if (!code && !message && !backendMessage && !details) return null;
  return {
    code,
    message,
    userMessage,
    backendMessage,
    retryable,
    details,
  };
};

const DEFAULT_BUILD_OPTIONS: RuntimeTaskBuildOptions = {
  fallbackStatus: undefined,
  statusNormalizer: () => undefined,
  projectPathResolver: () => undefined,
};

const buildRuntimeTaskRow = (record: unknown, options: RuntimeTaskBuildOptions = DEFAULT_BUILD_OPTIONS): RuntimeTaskRow => {
  const recordObject = asPlainObject<RawTaskRecord>(record, {
    metadata: undefined,
    request: undefined,
    progress: undefined,
    error: undefined,
    projectPath: undefined,
    status: undefined,
    taskId: undefined,
    id: undefined,
    createdAt: undefined,
    updatedAt: undefined,
    startedAt: undefined,
    finishedAt: undefined,
  });
  const metadata = asPlainObject<RawTaskMetadata>(recordObject.metadata, {
    sourceNodeId: undefined,
    targetNodeId: undefined,
    batchId: undefined,
    batch_id: undefined,
    projectPath: undefined,
    remoteRequestId: undefined,
    remote_request_id: undefined,
  });
  const request = isPlainObject(recordObject.request) ? recordObject.request : null;
  const progress = asPlainObject<RawTaskProgress>(recordObject.progress, {
    percent: undefined,
    message: undefined,
    phase: undefined,
  });
  const projectPath =
    normalizeString(recordObject.projectPath) ||
    normalizeString((options.projectPathResolver !== null && options.projectPathResolver !== undefined ? options.projectPathResolver(metadata) : undefined)) ||
    normalizeString(metadata.projectPath);
  const fallbackStatus = normalizeRuntimeTaskStatus(options.fallbackStatus, 'submitting');
  const normalizedStatus = normalizeRuntimeTaskStatus(
    (options.statusNormalizer !== null && options.statusNormalizer !== undefined ? options.statusNormalizer(recordObject.status) : undefined) || recordObject.status,
    fallbackStatus,
  );

  const row: RuntimeTaskRow = {
    taskId: normalizeString(recordObject.taskId || recordObject.id),
    status: normalizedStatus,
    projectPath,
    createdAt: normalizeRuntimeTaskNumber(recordObject.createdAt) ?? Date.now(),
    updatedAt: normalizeRuntimeTaskNumber(recordObject.updatedAt) ?? Date.now(),
  };

  row.sourceNodeId = optionalString(metadata.sourceNodeId) ?? null;
  row.targetNodeId = optionalString(metadata.targetNodeId) ?? null;
  row.batchId = optionalString(metadata.batchId || metadata.batch_id) ?? null;
  const requestSummary = request ? projectRuntimeTaskRequestSummary(request, recordObject.metadata) : null;
  const metadataSummary = isPlainObject(recordObject.metadata)
    ? projectRuntimeTaskMetadataSummary(recordObject.metadata, request)
    : null;
  row.requestJson = requestSummary ? JSON.stringify(requestSummary) : null;
  row.metadataJson = metadataSummary ? JSON.stringify(metadataSummary) : null;
  row.remoteRequestId = optionalString(metadata.remoteRequestId || metadata.remote_request_id) ?? null;
  row.progressPercent = normalizeRuntimeTaskNumber(progress.percent);
  row.progressMessage = optionalString(progress.message) ?? null;
  row.progressPhase = optionalString(progress.phase) ?? null;
  const failure = normalizeRuntimeTaskFailure(recordObject.error);
  row.errorMessage = (failure !== null && failure !== undefined ? failure.message : undefined) ?? null;
  row.errorCode = (failure !== null && failure !== undefined ? failure.code : undefined) ?? null;
  row.failureJson = failure ? JSON.stringify(projectRuntimeTaskFailureSummary(failure)) : null;
  // 执行真实开始/结束时刻投影（v19 tasks 新列）：缺省输出 null 而非 undefined，与同侧行为对齐，
  // 避免契约漂移；createdAt（受理时刻）/updatedAt（最后回写时刻）不互替执行时刻。
  row.startedAt = normalizeRuntimeTaskNumber(recordObject.startedAt);
  row.finishedAt = normalizeRuntimeTaskNumber(recordObject.finishedAt);

  return row;
};

const buildRuntimeTaskView = (record: unknown, options: RuntimeTaskBuildOptions = DEFAULT_BUILD_OPTIONS): RuntimeTaskView => {
  const row = buildRuntimeTaskRow(record, options);
  const view = runtimeTaskRowToView(row, {
    now: undefined,
    onIssue: (issue) => {
      loggingModule.logWarn('[runtime-task-projector] failed to hydrate runtime task row', { issue });
    },
  });
  if (!view) {
    throw new Error(`Failed to hydrate runtime task row: ${row.taskId}`);
  }
  return view;
};

export {
  buildRuntimeTaskRow,
  buildRuntimeTaskView,
  normalizeRuntimeTaskFailure,
};
