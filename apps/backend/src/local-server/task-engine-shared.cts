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
  errors: unknown | undefined;
  errno: unknown | undefined;
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

/**
 * 网络失败分类的上下文。`phase` 取任务 progress.phase（或轮询等显式阶段标识），
 * `elapsedMs` 是本次请求在对应阶段内已经过的时长。
 */
type NetworkErrorContext = {
  phase?: unknown;
  elapsedMs?: unknown;
};

type NetworkErrorKind =
  | "dns"
  | "connection_refused"
  | "connection_unreachable"
  | "tls"
  | "connection_dropped"
  | "response_interrupted"
  | "request_failed";

type NetworkErrorClassification = {
  userMessage: string;
  // 仅作信息标记保留，不得驱动任何自动重试（docs/runtime/远端请求执行治理原则.md）。
  retryable: true;
  kind: NetworkErrorKind;
  causeCode: string | null;
};

const NETWORK_PHASE_LABELS = new Map<string, string>([
  ["uploading_input", "上传输入素材"],
  ["requesting", "提交请求"],
  ["downloading", "接收结果"],
  ["polling", "查询任务状态"],
]);

// 连接长时间保持后中断，与「一开始就连不上」分开表述。阈值只影响文案措辞，不参与任何重试决策。
const LONG_WAIT_THRESHOLD_MS = 10_000;
const MAX_CAUSE_DEPTH = 4;

const DNS_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_NONAME",
  "EAI_FAIL",
  "EAI_NODATA",
  "ERR_NAME_NOT_RESOLVED",
  "ERR_NAME_RESOLUTION_FAILED",
]);
const CONNECTION_REFUSED_CODES = new Set(["ECONNREFUSED", "ERR_CONNECTION_REFUSED"]);
const CONNECTION_UNREACHABLE_CODES = new Set([
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "UND_ERR_CONNECT_TIMEOUT",
  "ERR_ADDRESS_UNREACHABLE",
  "ERR_INTERNET_DISCONNECTED",
]);
const TLS_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_REVOKED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_DECRYPT_CERT_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_SSL_WRONG_VERSION_NUMBER",
  "ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE",
  "ERR_TLS_HANDSHAKE_TIMEOUT",
  "EPROTO",
]);
const CONNECTION_DROPPED_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
  "ERR_STREAM_PREMATURE_CLOSE",
]);
const RESPONSE_INTERRUPTED_CODES = new Set(["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);

const isErrorLike = (value: unknown) =>
  Boolean(value) && (typeof value === "object" || typeof value === "function");

const collectNetworkErrorCodes = (
  value: unknown,
  depth = 0,
  codes = new Set<string>(),
): Set<string> => {
  if (!isErrorLike(value) || depth > MAX_CAUSE_DEPTH) return codes;
  const record = value as PlainObject;
  for (const candidate of [record.code, record.errno]) {
    if (typeof candidate === "string" && candidate.trim()) {
      codes.add(candidate.trim().toUpperCase());
    }
  }
  if (Array.isArray(record.errors)) {
    for (const item of record.errors) {
      collectNetworkErrorCodes(item, depth + 1, codes);
    }
  }
  if (record.cause !== undefined && record.cause !== value) {
    collectNetworkErrorCodes(record.cause, depth + 1, codes);
  }
  return codes;
};

const collectNetworkErrorText = (
  value: unknown,
  depth = 0,
  messages: string[] = [],
): string[] => {
  if (value === null || value === undefined || depth > MAX_CAUSE_DEPTH) return messages;
  if (typeof value === "string") {
    if (value.trim()) messages.push(value.trim());
    return messages;
  }
  if (!isErrorLike(value)) return messages;
  const record = value as PlainObject;
  if (typeof record.message === "string" && record.message.trim()) {
    messages.push(record.message.trim());
  }
  if (Array.isArray(record.errors)) {
    for (const item of record.errors) {
      collectNetworkErrorText(item, depth + 1, messages);
    }
  }
  if (record.cause !== undefined && record.cause !== value) {
    collectNetworkErrorText(record.cause, depth + 1, messages);
  }
  return messages;
};

const hasAnyCode = (codes: Set<string>, candidates: ReadonlySet<string>) => {
  for (const code of candidates) {
    if (codes.has(code)) return true;
  }
  return false;
};

const pickCauseCode = (codes: Set<string>): string | null => {
  const known = [
    ...DNS_CODES,
    ...CONNECTION_REFUSED_CODES,
    ...CONNECTION_UNREACHABLE_CODES,
    ...TLS_CODES,
    ...CONNECTION_DROPPED_CODES,
    ...RESPONSE_INTERRUPTED_CODES,
  ];
  for (const code of known) {
    if (codes.has(code)) return code;
  }
  const first = codes.values().next();
  return first.done ? null : first.value;
};

const resolveNetworkPhaseLabel = (phase: unknown): string | null => {
  if (typeof phase !== "string") return null;
  return NETWORK_PHASE_LABELS.get(phase.trim().toLowerCase()) ?? null;
};

const resolveElapsedMs = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
};

const formatElapsedSeconds = (elapsedMs: number) =>
  String(Math.max(1, Math.round(elapsedMs / 1000)));

const buildPhaseSuffix = (phaseLabel: string | null) =>
  phaseLabel ? `（阶段：${phaseLabel}）` : "";

const buildPhaseClause = (phaseLabel: string | null) =>
  phaseLabel ? `在「${phaseLabel}」阶段` : "";

const buildSizeSuggestion =
  "若反复出现，可尝试降低图片尺寸或参考图数量后重新提交";

const buildConnectionDroppedMessage = (
  kind: "connection_dropped" | "response_interrupted",
  phaseLabel: string | null,
  elapsedMs: number | null,
): string => {
  const seconds = elapsedMs !== null ? formatElapsedSeconds(elapsedMs) : null;
  const longWait = elapsedMs !== null && elapsedMs >= LONG_WAIT_THRESHOLD_MS;
  if (kind === "response_interrupted") {
    if (seconds !== null) {
      return `服务商在等待 ${seconds} 秒后仍未返回结果，连接已中断${buildPhaseSuffix(phaseLabel)}。${buildSizeSuggestion}`;
    }
    return `服务商长时间未返回结果，连接已中断${buildPhaseSuffix(phaseLabel)}。${buildSizeSuggestion}`;
  }
  if (phaseLabel === "接收结果") {
    if (seconds !== null) {
      return `服务商在返回结果时断开了连接（已等待 ${seconds} 秒）。${buildSizeSuggestion}`;
    }
    return `服务商在返回结果时断开了连接。${buildSizeSuggestion}`;
  }
  if (longWait && seconds !== null) {
    return `服务商在等待 ${seconds} 秒后断开了连接${buildPhaseSuffix(phaseLabel)}。${buildSizeSuggestion}`;
  }
  return `服务商${buildPhaseClause(phaseLabel)}断开了连接。${buildSizeSuggestion}`;
};

/**
 * 把 fetch/undici/Node 的网络错误归一为用户可读分类。
 *
 * - 先读 error.cause 链上的错误码（undici 的 `fetch failed` 只有 cause 携带真实原因），
 *   再退回 message 子串匹配；`AggregateError.errors` 也会被遍历。
 * - 结合任务阶段与阶段耗时区分「连不上服务商」与「连接建立后等待响应期间中断」。
 * - 返回的 retryable 仅为信息标记，调用方不得据此自动重试。
 */
const classifyNetworkError = (
  error: unknown,
  context: NetworkErrorContext = {},
): NetworkErrorClassification | null => {
  if (!isErrorLike(error) || isAbortError(error)) return null;
  const codes = collectNetworkErrorCodes(error);
  const text = collectNetworkErrorText(error).join(" ").toLowerCase();
  if (codes.size === 0 && !text) return null;
  const phaseLabel = resolveNetworkPhaseLabel(context.phase);
  const elapsedMs = resolveElapsedMs(context.elapsedMs);
  const causeCode = pickCauseCode(codes);
  const matches = (needles: readonly string[]) =>
    needles.some((needle) => text.includes(needle));

  if (
    hasAnyCode(codes, TLS_CODES) ||
    matches([
      "certificate",
      "self signed",
      "self-signed",
      "unable to verify",
      "ssl routines",
      "tls handshake",
    ])
  ) {
    return {
      userMessage:
        "与服务商的加密连接未通过校验，请检查服务商地址或代理设置后重新提交",
      retryable: true,
      kind: "tls",
      causeCode,
    };
  }
  if (
    hasAnyCode(codes, DNS_CODES) ||
    matches(["enotfound", "eai_again", "eai_noname", "name not resolved", "getaddrinfo"])
  ) {
    return {
      userMessage: "找不到服务商地址，请检查地址是否正确、网络是否可用后重新提交",
      retryable: true,
      kind: "dns",
      causeCode,
    };
  }
  if (
    hasAnyCode(codes, CONNECTION_REFUSED_CODES) ||
    matches(["econnrefused", "connection refused"])
  ) {
    return {
      userMessage: "服务商地址拒绝连接，请检查地址与端口是否正确后重新提交",
      retryable: true,
      kind: "connection_refused",
      causeCode,
    };
  }
  if (
    hasAnyCode(codes, CONNECTION_UNREACHABLE_CODES) ||
    matches([
      "etimedout",
      "ehostunreach",
      "enetunreach",
      "enetdown",
      "und_err_connect_timeout",
      "address unreachable",
    ])
  ) {
    return {
      userMessage:
        "连接服务商耗时过长后中断，请检查网络、代理与服务商地址后重新提交",
      retryable: true,
      kind: "connection_unreachable",
      causeCode,
    };
  }
  if (hasAnyCode(codes, RESPONSE_INTERRUPTED_CODES)) {
    return {
      userMessage: buildConnectionDroppedMessage("response_interrupted", phaseLabel, elapsedMs),
      retryable: true,
      kind: "response_interrupted",
      causeCode,
    };
  }
  if (
    hasAnyCode(codes, CONNECTION_DROPPED_CODES) ||
    matches([
      "socket hang up",
      "other side closed",
      "terminated",
      "premature close",
      "econnreset",
      "epipe",
      "und_err_socket",
      "und_err_closed",
      "connection reset",
    ])
  ) {
    return {
      userMessage: buildConnectionDroppedMessage("connection_dropped", phaseLabel, elapsedMs),
      retryable: true,
      kind: "connection_dropped",
      causeCode,
    };
  }
  if (matches(["fetch failed", "network error", "networkerror"])) {
    return {
      userMessage: phaseLabel
        ? `没能连接到服务商${buildPhaseSuffix(phaseLabel)}，请检查网络、代理与服务商地址后重新提交`
        : "没能连接到服务商，请检查网络、代理与服务商地址后重新提交",
      retryable: true,
      kind: "request_failed",
      causeCode,
    };
  }
  return null;
};

export {
  type PlainObject,
  type NetworkErrorClassification,
  type NetworkErrorContext,
  type NetworkErrorKind,
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
