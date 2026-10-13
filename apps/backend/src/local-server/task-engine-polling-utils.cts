import {
  DEFAULT_FAILURE_MESSAGE_PATHS,
  DEFAULT_FAILURE_STATUSES,
  DEFAULT_STATUS_PATHS,
  isRecord,
  toRecord,
  type PlainObject,
} from "./task-engine-shared.cts";
import {
  normalizeString,
  normalizeStringArray,
} from "./task-normalizer.cts";
import { logDebug, logWarn } from "./logging.cts";

type ReadValueByPathOptions = {
  silent: boolean | undefined;
  parseJsonString: boolean | undefined;
};

const DEFAULT_READ_VALUE_BY_PATH_OPTIONS: ReadValueByPathOptions = {
  silent: undefined,
  parseJsonString: undefined,
};

type PollingRequestBuildReason =
  | "remote_request_id_missing"
  | "url_template_missing";

type PollingRequestBuildNotApplicable = {
  status: "not_applicable";
};

type PollingRequestBuildBlocked = {
  status: "blocked";
  reason: PollingRequestBuildReason;
  submitResponseIdPath: string;
  polling: PlainObject;
};

type PollingRequestBuildReady = {
  status: "ready";
  remoteRequestId: string;
  submitResponseIdPath: string;
  request: {
    url: string;
    method: string;
    headers: PlainObject;
    body: unknown;
  };
  polling: PlainObject;
};

type PollingRequestBuildResult =
  | PollingRequestBuildNotApplicable
  | PollingRequestBuildBlocked
  | PollingRequestBuildReady;

const toPathSegments = (rawPath: unknown): string[] => {
  if (!rawPath || typeof rawPath !== "string") return [];
  const normalized = rawPath.replace(/^\/+/, "").replace(/\[(\w+)\]/g, ".$1");
  return normalized
    .split(/[./]/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
};

const readValueByPath = (
  source: unknown,
  pathValue: unknown,
  options: ReadValueByPathOptions = DEFAULT_READ_VALUE_BY_PATH_OPTIONS,
) => {
  if (!pathValue) return undefined;
  const segments = toPathSegments(pathValue);
  if (segments.length === 0) return undefined;
  const { silent = false, parseJsonString = true } = options;
  let current = source;
  if (typeof current === "string" && parseJsonString) {
    try {
      current = JSON.parse(current);
    } catch (error) {
      if (!silent) {
        logWarn("readValueByPath: invalid json string", {
          path: pathValue,
          error: String(error),
        });
      }
      return undefined;
    }
  }
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        if (!silent) {
          logWarn("readValueByPath: invalid array segment", {
            path: pathValue,
            segment,
          });
        }
        return undefined;
      }
      current = current[index];
      continue;
    }
    if (!isRecord(current)) {
      if (!silent) {
        logWarn("readValueByPath: non-object segment", {
          path: pathValue,
          segment,
        });
      }
      return undefined;
    }
    { const _desc = Object.getOwnPropertyDescriptor(current, segment); current = _desc !== null && _desc !== undefined ? _desc.value : undefined; }
  }
  return current;
};

const toStringSafe = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const parseTaskProgress = (value: unknown) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    const clamped = Math.max(0, Math.min(100, value));
    return Math.floor(clamped);
  }
  const text = toStringSafe(value);
  if (!text) return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const normalized = trimmed.endsWith("%") ? trimmed.slice(0, -1) : trimmed;
  const parsed = Number.parseFloat(normalized);
  if (!Number.isFinite(parsed)) return undefined;
  if (parsed < 0) return 0;
  if (parsed > 100) return 100;
  return Math.round(parsed);
};

const pickStringByPaths = (source: unknown, paths: string[]) => {
  for (const pathValue of paths) {
    const raw = readValueByPath(source, pathValue, { silent: true, parseJsonString: undefined });
    const text = toStringSafe(raw);
    if (text && text.trim()) {
      return text.trim();
    }
  }
  return undefined;
};

const normalizeFailureCode = (value: unknown) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    return value;
  }
  const text = toStringSafe(value);
  if (!text) return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return trimmed;
};

const isFailureCode = (value: unknown) => {
  if (value === undefined || value === null) return false;
  if (typeof value === "number") {
    return value !== 0;
  }
  const normalized = String(value).trim().toLowerCase();
  return (
    normalized !== "" &&
    normalized !== "0" &&
    normalized !== "ok" &&
    normalized !== "success"
  );
};

const pickFailureCodeByPaths = (source: unknown, paths: string[]) => {
  for (const pathValue of paths) {
    const raw = readValueByPath(source, pathValue, { silent: true, parseJsonString: undefined });
    const code = normalizeFailureCode(raw);
    if (code !== undefined) {
      return code;
    }
  }
  return undefined;
};

/**
 * 状态路径解析：body 优先，未命中时回落到响应头。
 *
 * 部分上游（如 3p-images 结果端点）只在响应头（如 `x-task-status`）携带任务状态，
 * body 无 status 字段；模型资产的 statusFieldPaths 允许直接声明响应头名。
 * Headers.get 大小写不敏感；body 风格路径（如 `/outputs/0/...`）在响应头上查询返回 null，无副作用。
 */
const pickStatusByPathsWithHeaders = (
  source: unknown,
  paths: string[],
  responseHeaders: Headers | null | undefined,
) => {
  const bodyValue = pickStringByPaths(source, paths);
  if (bodyValue) return bodyValue;
  if (!responseHeaders) return bodyValue;
  for (const pathValue of paths) {
    const headerValue = responseHeaders.get(pathValue);
    if (headerValue !== null && headerValue.trim() !== "") {
      return headerValue;
    }
  }
  return bodyValue;
};

const detectTaskFailure = (rawData: unknown, options: PlainObject = {} as PlainObject, responseHeaders?: Headers | null) => {
  const messagePaths = normalizeStringArray(options.failureMessagePaths);
  const effectiveMessagePaths =
    messagePaths.length > 0
      ? [...messagePaths, ...DEFAULT_FAILURE_MESSAGE_PATHS]
      : DEFAULT_FAILURE_MESSAGE_PATHS;
  const statusPaths = normalizeStringArray(options.statusFieldPaths);
  const effectiveStatusPaths =
    statusPaths.length > 0 ? statusPaths : DEFAULT_STATUS_PATHS;
  const statusValue = pickStatusByPathsWithHeaders(rawData, effectiveStatusPaths, responseHeaders);
  const failureCandidates = [
    ...DEFAULT_FAILURE_STATUSES,
    ...normalizeStringArray(options.failureStatuses),
  ];
  const failureSet = new Set(
    failureCandidates
      .map((item) => item.toLowerCase())
      .filter((item) => item.length > 0),
  );
  const normalizedStatus = statusValue ? statusValue.toLowerCase() : undefined;
  const codePaths = normalizeStringArray(options.failureCodePaths);
  const detectedCode =
    codePaths.length > 0
      ? pickFailureCodeByPaths(rawData, codePaths)
      : undefined;
  const failedByStatus = Boolean(
    normalizedStatus && failureSet.has(normalizedStatus),
  );
  const failedByCode = isFailureCode(detectedCode);
  if (failedByStatus || failedByCode) {
    const message = pickStringByPaths(rawData, effectiveMessagePaths);
    const fallbackMessage =
      detectedCode !== undefined
        ? `任务失败（错误码：${String(detectedCode)}）`
        : statusValue
          ? `任务状态：${statusValue}`
          : undefined;
    return {
      failed: true,
      status: statusValue,
      code: detectedCode,
      message: message || fallbackMessage,
    };
  }
  return { failed: false, status: statusValue, code: detectedCode };
};

const resolveExecutionPlanFromRecord = (record: unknown) => {
  const metadata = toRecord(toRecord(record).metadata);
  return metadata && isRecord(metadata.taskExecutionPlan)
    ? metadata.taskExecutionPlan
    : null;
};

const readResponseIdByPaths = (body: unknown, paths: string[] = []) => {
  for (const pathValue of paths) {
    const value = readValueByPath(body, pathValue, { silent: true, parseJsonString: undefined });
    const normalized = normalizeString(value);
    if (normalized) return normalized;
  }
  return "";
};

const resolveSubmitResponseIdPathFromResultRule = (plan: unknown) => {
  const resultRule = toRecord(toRecord(plan).result_rule);
  return (
    normalizeString(resultRule.submit_response_id_path) ||
    normalizeString(resultRule.submitResponseIdPath)
  );
};

const resolveRemoteRequestIdForPolling = (
  record: unknown,
  responseBody: unknown,
  plan: unknown,
) => {
  const recordValue = toRecord(record);
  const metadata = toRecord(recordValue.metadata);
  const existing = normalizeString(
    metadata.remoteRequestId || metadata.remote_request_id,
  );
  const submitResponseIdPath = resolveSubmitResponseIdPathFromResultRule(plan);
  if (existing) {
    return { remoteRequestId: existing, submitResponseIdPath };
  }
  return {
    remoteRequestId: readResponseIdByPaths(
      responseBody,
      submitResponseIdPath ? [submitResponseIdPath] : [],
    ),
    submitResponseIdPath,
  };
};

const buildPollingRequestFromPlan = (
  record: unknown,
  responseBody: unknown,
): PollingRequestBuildResult => {
  const plan = resolveExecutionPlanFromRecord(record);
  const planValue = toRecord(plan);
  const polling = isRecord(planValue.polling_strategy)
    ? planValue.polling_strategy
    : null;
  if (!polling) {
    logDebug(
      "[task-engine] polling request not applicable: missing polling_strategy",
      undefined,
    );
    return { status: "not_applicable" };
  }
  const pollingRequest = toRecord(polling.request);
  const pollingPolicy = toRecord(polling.polling);
  const remoteRequestIdResolution = resolveRemoteRequestIdForPolling(
    record,
    responseBody,
    plan,
  );
  const { remoteRequestId, submitResponseIdPath } = remoteRequestIdResolution;
  if (!remoteRequestId) {
    logDebug("[task-engine] polling request blocked: missing remote id", {
      submitResponseIdPath,
    });
    return {
      status: "blocked",
      reason: "remote_request_id_missing",
      submitResponseIdPath,
      polling: pollingPolicy,
    };
  }
  const template =
    normalizeString(pollingRequest.url_template) ||
    normalizeString(pollingRequest.urlTemplate);
  if (!template) {
    logDebug(
      "[task-engine] polling request blocked: missing url template",
      { remoteRequestId },
    );
    return {
      status: "blocked",
      reason: "url_template_missing",
      submitResponseIdPath,
      polling: pollingPolicy,
    };
  }
  // 占位符覆盖两类上游查询形态：任务 ID 型（id/taskId/requestId）与
  // 长任务操作名型（operation_name，Google LRO：`/v1beta/{operation_name}`，
  // 取值即提交响应 `name`，形如 `models/x/operations/y`）。
  const url = template.replace(
    /\{(?:id|taskId|requestId|operation_name)\}/g,
    remoteRequestId,
  );
  return {
    status: "ready",
    remoteRequestId,
    submitResponseIdPath,
    request: {
      url,
      method: normalizeString(pollingRequest.method) || "GET",
      headers: isRecord(pollingRequest.headers) ? pollingRequest.headers : {} as PlainObject,
      body: pollingRequest.body,
    },
    polling: pollingPolicy,
  };
};

export {
  type PollingRequestBuildResult,
  readValueByPath,
  parseTaskProgress,
  detectTaskFailure,
  resolveSubmitResponseIdPathFromResultRule,
  resolveRemoteRequestIdForPolling,
  buildPollingRequestFromPlan,
};
