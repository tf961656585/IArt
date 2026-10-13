import { UNIFIED_GENERATION_STATUS, UNIFIED_GENERATION_STATUS_SET } from '@iart/contracts';
import type { UnifiedGenerationStatus } from '@iart/contracts';
import * as constantsModule from './constants.cts';
import * as utilsModule from './utils.cts';

const {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_POLL_MAX_ATTEMPTS,
  DEFAULT_POLL_MAX_CONSECUTIVE_FAILURES,
} = constantsModule;
const { isPlainObject, normalizePositiveInt } = utilsModule;

const TASK_STATUS = UNIFIED_GENERATION_STATUS;

type DynamicTaskHeaders = {
  [key: string]: string;
};

type DynamicTaskMap = utilsModule.DynamicValueMap;

type RawTaskRequest = {
  url: unknown | undefined;
  method: unknown | undefined;
  headers: unknown | undefined;
  body: unknown | undefined;
};

type RawTaskPolling = {
  intervalMs: unknown | undefined;
  maxAttempts: unknown | undefined;
  maxConsecutiveFailures: unknown | undefined;
  successPath: unknown | undefined;
  successFieldPaths: unknown | undefined;
  successStatuses: unknown | undefined;
  progressFieldPath: unknown | undefined;
  progressPath: unknown | undefined;
  statusFieldPaths: unknown | undefined;
  failureStatuses: unknown | undefined;
  failureCodePaths: unknown | undefined;
  failureMessagePaths: unknown | undefined;
};

type RawTaskRecord = {
  id: unknown | undefined;
  createdAt: unknown | undefined;
  updatedAt: unknown | undefined;
  type: unknown | undefined;
  status: unknown | undefined;
  request: unknown | undefined;
  polling: unknown | undefined;
  response: unknown | undefined;
  error: unknown | undefined;
  metadata: unknown | undefined;
  progress: unknown | undefined;
  startedAt: unknown | undefined;
  finishedAt: unknown | undefined;
};

const normalizeString = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : '';

const normalizeStringArray = (value: unknown) => {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0);
};

const normalizeTaskType = (value: unknown) => {
  if (typeof value !== 'string') return 'http';
  const trimmed = value.trim();
  return trimmed ? trimmed : 'http';
};

const normalizeTaskStatus = (
  value: unknown,
  fallback: UnifiedGenerationStatus | '' = TASK_STATUS.SUBMITTING,
): UnifiedGenerationStatus | '' => {
  if (typeof value !== 'string') return fallback;
  const lowered = value.trim().toLowerCase();
  return UNIFIED_GENERATION_STATUS_SET.has(lowered) ? lowered as UnifiedGenerationStatus : fallback;
};

const normalizeTaskHeaders = (value: unknown) => {
  if (!isPlainObject(value)) return {};
  const result: DynamicTaskHeaders = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!key) continue;
    if (raw === undefined || raw === null) continue;
    result[key] = typeof raw === 'string' ? raw : String(raw);
  }
  return result;
};

const normalizeTaskTargetUrl = (value: unknown) => {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;

  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(raw);
  if (schemeMatch) {
    const matchedScheme = schemeMatch[1];
    const scheme = typeof matchedScheme === 'string' ? matchedScheme.toLowerCase() : '';
    if (scheme !== 'http' && scheme !== 'https') return null;
  }

  if (/^https?:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      return parsed.toString();
    } catch {
      return raw;
    }
  }

  // 新主链（GenerationBatch）在受理期只固化能力包相对 endpoint（快照 base_url 在派发前
  // 才解析并冻结于 ExecutionSnapshot；spec 45 §5.2）。相对路径以 "/" 开头且不含协议头，
  // 原样透传，派发时由 task-engine-http 拼接快照 base_url 的 origin。
  if (raw.startsWith("/") && !raw.startsWith("//")) {
    return raw;
  }

  return null;
};

const normalizeTaskRequest = (value: unknown) => {
  if (!isPlainObject(value)) return null;
  const rawRequest: RawTaskRequest = value as RawTaskRequest;
  const url = typeof rawRequest.url === 'string' ? rawRequest.url.trim() : '';
  if (!url) return null;
  const normalizedUrl = normalizeTaskTargetUrl(url);
  if (!normalizedUrl) return null;
  const hasBody = rawRequest.body !== undefined && rawRequest.body !== null;
  const method =
    typeof rawRequest.method === 'string' && rawRequest.method.trim()
      ? rawRequest.method.trim().toUpperCase()
      : hasBody
        ? 'POST'
        : 'GET';
  const headers = normalizeTaskHeaders(rawRequest.headers);
  const body = rawRequest.body;
  return { url: normalizedUrl, method, headers, body };
};

const normalizeTaskPolling = (value: unknown) => {
  if (!isPlainObject(value)) return null;
  const rawPolling: RawTaskPolling = value as RawTaskPolling;
  const intervalMs = normalizePositiveInt(rawPolling.intervalMs, DEFAULT_POLL_INTERVAL_MS);
  const maxAttempts = normalizePositiveInt(rawPolling.maxAttempts, DEFAULT_POLL_MAX_ATTEMPTS);
  const maxConsecutiveFailures = normalizePositiveInt(
    rawPolling.maxConsecutiveFailures,
    DEFAULT_POLL_MAX_CONSECUTIVE_FAILURES,
  );
  const successPath =
    typeof rawPolling.successPath === 'string' && rawPolling.successPath.trim()
      ? rawPolling.successPath.trim()
      : undefined;
  const successFieldPaths = normalizeStringArray(rawPolling.successFieldPaths);
  const successStatuses = normalizeStringArray(rawPolling.successStatuses);
  const progressFieldPath =
    typeof rawPolling.progressFieldPath === 'string' && rawPolling.progressFieldPath.trim()
      ? rawPolling.progressFieldPath.trim()
      : typeof rawPolling.progressPath === 'string' && rawPolling.progressPath.trim()
        ? rawPolling.progressPath.trim()
        : undefined;
  const statusFieldPaths = normalizeStringArray(rawPolling.statusFieldPaths);
  const failureStatuses = normalizeStringArray(rawPolling.failureStatuses);
  const failureCodePaths = normalizeStringArray(rawPolling.failureCodePaths);
  const failureMessagePaths = normalizeStringArray(rawPolling.failureMessagePaths);

  return {
    intervalMs,
    maxAttempts,
    maxConsecutiveFailures,
    successPath,
    successFieldPaths: successFieldPaths.length > 0 ? successFieldPaths : undefined,
    successStatuses: successStatuses.length > 0 ? successStatuses : undefined,
    progressFieldPath,
    statusFieldPaths: statusFieldPaths.length > 0 ? statusFieldPaths : undefined,
    failureStatuses: failureStatuses.length > 0 ? failureStatuses : undefined,
    failureCodePaths: failureCodePaths.length > 0 ? failureCodePaths : undefined,
    failureMessagePaths: failureMessagePaths.length > 0 ? failureMessagePaths : undefined,
  };
};

const normalizeDynamicTaskMap = (value: unknown) => {
  if (!isPlainObject(value)) return null;
  const normalized: DynamicTaskMap = {};
  for (const [key, raw] of Object.entries(value)) {
    normalized[key] = raw;
  }
  return normalized;
};

const normalizeFiniteNumber = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const normalizeOptionalFiniteNumber = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const normalizeTaskRecord = (raw: unknown, fallbackId: unknown) => {
  if (!isPlainObject(raw)) return null;
  const rawRecord: RawTaskRecord = raw as RawTaskRecord;
  const id =
    typeof rawRecord.id === 'string' && rawRecord.id.trim()
      ? rawRecord.id.trim()
      : fallbackId || null;
  if (!id) return null;
  const createdAt = normalizeFiniteNumber(rawRecord.createdAt, Date.now());
  const updatedAt = normalizeFiniteNumber(rawRecord.updatedAt, createdAt);
  const type = normalizeTaskType(rawRecord.type);
  const status = normalizeTaskStatus(rawRecord.status);
  const request = normalizeTaskRequest(rawRecord.request);
  const polling = normalizeTaskPolling(rawRecord.polling);
  const response = normalizeDynamicTaskMap(rawRecord.response);
  const error = normalizeDynamicTaskMap(rawRecord.error);
  const metadata = normalizeDynamicTaskMap(rawRecord.metadata);
  const progress = normalizeDynamicTaskMap(rawRecord.progress);
  const startedAt = normalizeOptionalFiniteNumber(rawRecord.startedAt);
  const finishedAt = normalizeOptionalFiniteNumber(rawRecord.finishedAt);
  return {
    id,
    type,
    status,
    createdAt,
    updatedAt,
    startedAt,
    finishedAt,
    request,
    polling,
    response,
    error,
    metadata,
    progress,
  };
};

export {
  normalizeString,
  normalizeStringArray,
  normalizeTaskType,
  normalizeTaskStatus,
  normalizeTaskHeaders,
  normalizeTaskTargetUrl,
  normalizeTaskRequest,
  normalizeTaskPolling,
  normalizeTaskRecord,
};
