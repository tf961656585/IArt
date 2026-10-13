import * as constantsModule from "./constants.cts";
import { cloneJsonValue, UNIFIED_GENERATION_STATUS } from "@iart/contracts";
import { normalizeString, normalizeTaskStatus } from "./task-normalizer.cts";

const {
  TASK_RESULT_INLINE_LIMIT,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_POLL_MAX_ATTEMPTS,
  DEFAULT_POLL_MAX_CONSECUTIVE_FAILURES,
  ERROR_CODES,
  DEFAULT_STATUS_PATHS,
  DEFAULT_FAILURE_STATUSES,
  DEFAULT_FAILURE_MESSAGE_PATHS,
} = constantsModule;

const TASK_STATUS = UNIFIED_GENERATION_STATUS;
const TASK_RESULT_REQUIRED_STATUSES = new Set<string>([
  TASK_STATUS.SUCCEEDED,
  TASK_STATUS.FAILED,
]);
const TASK_FINAL_STATUSES = new Set<string>([
  TASK_STATUS.SUCCEEDED,
  TASK_STATUS.FAILED,
  TASK_STATUS.CANCELLED,
]);
const PROGRESS_NOTIFY_INTERVAL_MS = 500;

type PlainObject = {
  __formData: unknown | undefined;
  attempt: unknown | undefined;
  body: unknown | undefined;
  bodyType: unknown | undefined;
  cause: unknown | undefined;
  code: unknown | undefined;
  contentType: unknown | undefined;
  continueToRequesting: unknown | undefined;
  consecutiveFailures: unknown | undefined;
  createdAt: unknown | undefined;
  contentLength: unknown | undefined;
  data: unknown | undefined;
  dataBase64: unknown | undefined;
  dispatcher: unknown | undefined;
  detail: unknown | undefined;
  error: unknown | undefined;
  errorCode: unknown | undefined;
  executionId: unknown | undefined;
  expectedSize: unknown | undefined;
  failureCodePaths: unknown | undefined;
  failureMessagePaths: unknown | undefined;
  failureStatuses: unknown | undefined;
  fieldPath: unknown | undefined;
  fields: unknown | undefined;
  file: unknown | undefined;
  filename: unknown | undefined;
  files: unknown | undefined;
  finishedAt: unknown | undefined;
  headers: unknown | undefined;
  id: unknown | undefined;
  intervalMs: unknown | undefined;
  executionSnapshot: unknown | undefined;
  execution_snapshot: unknown | undefined;
  credentialLeaseId: unknown | undefined;
  kind: unknown | undefined;
  limit: unknown | undefined;
  localOutput: unknown | undefined;
  localOutputs: unknown | undefined;
  maxAttempts: unknown | undefined;
  maxConsecutiveFailures: unknown | undefined;
  mediaDownload: unknown | undefined;
  message: unknown | undefined;
  metadata: unknown | undefined;
  method: unknown | undefined;
  percent: unknown | undefined;
  mimeType: unknown | undefined;
  mode: unknown | undefined;
  phase: unknown | undefined;
  policyTierKey: unknown | undefined;
  model_id: unknown | undefined;
  modelId: unknown | undefined;
  name: unknown | undefined;
  nodeGraphId: unknown | undefined;
  ok: unknown | undefined;
  path: unknown | undefined;
  polling: unknown | undefined;
  polling_strategy: unknown | undefined;
  pollingCompletion: unknown | undefined;
  progress: unknown | undefined;
  progressFieldPath: unknown | undefined;
  projectPath: unknown | undefined;
  providerOverride: unknown | undefined;
  overrideId: unknown | undefined;
  receivedAt: unknown | undefined;
  receivedBytes: unknown | undefined;
  record: unknown | undefined;
  remote_request_id: unknown | undefined;
  remoteRequestId: unknown | undefined;
  request: unknown | undefined;
  response: unknown | undefined;
  result: unknown | undefined;
  result_rule: unknown | undefined;
  size: unknown | undefined;
  snapshot: unknown | undefined;
  source: unknown | undefined;
  sourceKind: unknown | undefined;
  sourceMimeType: unknown | undefined;
  sourceNodeId: unknown | undefined;
  startedAt: unknown | undefined;
  status: unknown | undefined;
  statusFieldPaths: unknown | undefined;
  submit_response_id_path: unknown | undefined;
  submitResponseIdPath: unknown | undefined;
  successFieldPaths: unknown | undefined;
  successPath: unknown | undefined;
  successStatuses: unknown | undefined;
  task: unknown | undefined;
  taskExecutionPlan: unknown | undefined;
  taskId: unknown | undefined;
  targetType: unknown | undefined;
  token: unknown | undefined;
  totalBytes: unknown | undefined;
  type: unknown | undefined;
  updatedAt: unknown | undefined;
  url: unknown | undefined;
  url_template: unknown | undefined;
  urlTemplate: unknown | undefined;
  value: unknown | undefined;
};

const isRecord = (value: unknown): value is PlainObject =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const emptyPlainObject: PlainObject = {} as PlainObject;

const toRecord = (value: unknown): PlainObject =>
  isRecord(value) ? value : emptyPlainObject;

const hasOwnField = (source: PlainObject, key: keyof PlainObject) =>
  Object.prototype.hasOwnProperty.call(source, key);

const cloneValue = <T,>(value: T): T => {
  if (value === null || value === undefined) return value;
  return cloneJsonValue(value);
};

const getErrorCause = (error: unknown): unknown => {
  if (!isRecord(error)) return null;
  return Object.prototype.hasOwnProperty.call(error, "cause")
    ? error.cause
    : null;
};

const isAbortError = (error: unknown) =>
  isRecord(error) && normalizeString(error.name) === "AbortError";

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const isTaskFinalStatus = (value: unknown) => {
  const normalized = normalizeTaskStatus(value, "");
  return TASK_FINAL_STATUSES.has(normalized);
};

const isTaskResultRequiredStatus = (value: unknown) => {
  const normalized = normalizeTaskStatus(value, "");
  return TASK_RESULT_REQUIRED_STATUSES.has(normalized);
};

type NetworkErrorClassification = {
  userMessage: string;
  retryable: true;
};

const classifyNetworkError = (
  error: unknown,
): NetworkErrorClassification | null => {
  const message = getErrorMessage(error).toLowerCase();
  if (message.includes("terminated")) {
    return { userMessage: "网络连接波动，请重试", retryable: true };
  }
  if (message.includes("fetch failed")) {
    return { userMessage: "网络连接失败，请检查网络后重试", retryable: true };
  }
  if (message.includes("econnreset")) {
    return { userMessage: "网络连接中断，请重试", retryable: true };
  }
  if (message.includes("econnrefused")) {
    return { userMessage: "服务暂时不可用，请稍后重试", retryable: true };
  }
  if (message.includes("etimedout")) {
    return { userMessage: "网络连接超时，请重试", retryable: true };
  }
  if (message.includes("enotfound")) {
    return { userMessage: "网络连接失败，请检查网络后重试", retryable: true };
  }
  if (message.includes("socket hang up")) {
    return { userMessage: "网络连接中断，请重试", retryable: true };
  }
  if (message.includes("und_err_connect_timeout")) {
    return { userMessage: "网络连接超时，请重试", retryable: true };
  }
  if (message.includes("und_err_socket")) {
    return { userMessage: "网络连接异常，请重试", retryable: true };
  }
  return null;
};

export {
  type PlainObject,
  type NetworkErrorClassification,
  TASK_STATUS,
  TASK_RESULT_INLINE_LIMIT,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_POLL_MAX_ATTEMPTS,
  DEFAULT_POLL_MAX_CONSECUTIVE_FAILURES,
  ERROR_CODES,
  DEFAULT_STATUS_PATHS,
  DEFAULT_FAILURE_STATUSES,
  DEFAULT_FAILURE_MESSAGE_PATHS,
  PROGRESS_NOTIFY_INTERVAL_MS,
  isRecord,
  toRecord,
  hasOwnField,
  cloneValue,
  getErrorCause,
  isAbortError,
  getErrorMessage,
  isTaskFinalStatus,
  isTaskResultRequiredStatus,
  classifyNetworkError,
};
