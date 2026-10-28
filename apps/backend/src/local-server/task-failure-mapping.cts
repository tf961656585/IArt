import type { RuntimeTaskFailure } from "@iart/contracts";
import { ERROR_CODES, cloneValue, toRecord } from "./task-engine-shared.cts";
import { readValueByPath } from "./task-engine-polling-utils.cts";
import { resolveHttpStatusUserMessage } from "./http-status-fallback-messages.cts";
import { normalizeString } from "./task-normalizer.cts";
import { evaluateRecipeCondition } from "./result-condition-evaluator.cts";

type OpenObject = object;

type BuildRemoteHttpFailureInput = {
  taskRecord: unknown;
  httpStatus: number;
  responseOk: boolean;
  responseBody: unknown;
  responseBodyType: string | null | undefined | undefined;
  contentType: string | null | undefined | undefined;
  defaultCode: string | undefined | undefined;
};

type MappingResult = {
  mappedError: OpenObject;
  mappedTargets: string[];
};

const isOpenObject = (value: unknown): value is OpenObject =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const hasOwn = (source: OpenObject, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(source, key);

const readField = (
  source: OpenObject | null | undefined,
  key: string,
): unknown => (source ? Reflect.get(source, key) : undefined);

const writeField = (target: OpenObject, key: string, value: unknown): void => {
  Reflect.set(target, key, value);
};

const readObjectField = (
  source: OpenObject | null | undefined,
  key: string,
): OpenObject | null => toOptionalObject(readField(source, key));

const readArrayField = (
  source: OpenObject | null | undefined,
  key: string,
): unknown[] => {
  const value = readField(source, key);
  return Array.isArray(value) ? value : [];
};

const toOptionalObject = (value: unknown): OpenObject | null =>
  isOpenObject(value) ? value : null;

const toScalarString = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return normalizeString(value) || null;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
};

const isEmptyValue = (value: unknown): boolean => {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return normalizeString(value).length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (isOpenObject(value)) return Object.keys(value).length === 0;
  return false;
};

const parseTargetPath = (targetPath: unknown): string[] =>
  normalizeString(targetPath)
    .replace(/^\/+/, "")
    .replace(/\[(\w+)\]/g, ".$1")
    .split(/[./]/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

const assignMappedValue = (
  target: OpenObject,
  targetPath: unknown,
  value: unknown,
): boolean => {
  const segments = parseTargetPath(targetPath);
  const first = segments[0];
  if (!first) return false;
  let current = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (!segment) return false;
    const existing = readField(current, segment);
    if (!isOpenObject(existing)) {
      const child: OpenObject = {};
      writeField(current, segment, child);
      current = child;
      continue;
    }
    current = existing;
  }
  const last = segments[segments.length - 1];
  if (!last) return false;
  writeField(current, last, value);
  return true;
};

// 条件树求值唯一实现在 result-condition-evaluator.cts；本函数保持既有导出名与签名，
// 供 HTTP 提交失败路径（failure_condition）继续使用，不得再维护第二套判定。
//
// 比较语义随求值器统一（2026-10-26 有意为之，非「仅扩展可表达语义」）：`eq / neq / in /
// not_in` 的相等比较忽略字符串大小写；任一侧是数字时，两侧都能转成有限数字才按数值比较
// （`1` 与 `"1"` 相等）——合并求值器前本路径的严格相等（`Object.is`）口径不再保留。
// 新增 `gt / gte / lt / lte` 在此基础上再扩展可表达的阈值语义。
const evaluateResultCondition = (
  conditionInput: unknown,
  responseBody: unknown,
): boolean => evaluateRecipeCondition(conditionInput, responseBody, null).matched;

const readResultRule = (taskRecord: unknown): OpenObject | null => {
  const metadata = toRecord(readField(toRecord(taskRecord), "metadata"));
  const taskExecutionPlan = readObjectField(metadata, "taskExecutionPlan");
  const resultRule = taskExecutionPlan
    ? readObjectField(taskExecutionPlan, "result_rule")
    : null;
  return resultRule && Object.keys(resultRule).length > 0 ? resultRule : null;
};

const readErrorMappingRules = (resultRule: OpenObject | null): unknown[] =>
  readArrayField(resultRule, "error_mapping_rules");

const applyErrorMappingRules = (
  rules: unknown[],
  responseBody: unknown,
): MappingResult => {
  const mappedError: OpenObject = {};
  const mappedTargets: string[] = [];
  for (const rawRule of rules) {
    const rule = toOptionalObject(rawRule);
    const source = readObjectField(rule, "source");
    const target = normalizeString(readField(rule, "target"));
    if (!rule || !source || !target) continue;
    const sourceKind = normalizeString(readField(source, "kind"));
    if (sourceKind && sourceKind !== "response") continue;
    let value = readValueByPath(responseBody, readField(source, "path"), {
      silent: true,
      parseJsonString: undefined,
    });
    if (isEmptyValue(value) && hasOwn(rule, "default_value")) {
      value = readField(rule, "default_value");
    }
    if (isEmptyValue(value)) continue;
    if (assignMappedValue(mappedError, target, value)) {
      mappedTargets.push(target);
    }
  }
  return { mappedError, mappedTargets };
};

const pickResponseString = (
  responseBody: unknown,
  paths: readonly string[],
): string | null => {
  for (const path of paths) {
    const value = readValueByPath(responseBody, path, { silent: true, parseJsonString: undefined });
    const normalized = toScalarString(value);
    if (normalized) return normalized;
  }
  return null;
};

const extractRemoteErrorObject = (responseBody: unknown): OpenObject | null => {
  const body = toOptionalObject(responseBody);
  if (!body) return null;
  const nestedError = readObjectField(body, "error");
  if (nestedError) return cloneValue(nestedError);
  const remote: OpenObject = {};
  for (const key of ["code", "message", "type", "param"]) {
    const value = readField(body, key);
    if (hasOwn(body, key) && !isEmptyValue(value)) {
      writeField(remote, key, cloneValue(value));
    }
  }
  return Object.keys(remote).length > 0 ? remote : null;
};

const readMappedErrorString = (
  mappedError: OpenObject,
  path: string,
): string | null =>
  toScalarString(readValueByPath(mappedError, path, { silent: true, parseJsonString: undefined }));

const buildRemoteDetails = (params: {
  httpStatus: number;
  responseBody: unknown;
  responseBodyType: string | null;
  contentType: string | null;
  mappedError: OpenObject;
  mappedCode: string | null;
  mappedMessage: string | null;
  failureConditionMatched: boolean;
  hasFailureCondition: boolean;
  mappedTargets: string[];
  ruleCount: number;
}): OpenObject => {
  const mappedDetails = readObjectField(params.mappedError, "details");
  const details: OpenObject = {
    httpStatus: params.httpStatus,
  };
  if (params.responseBodyType) {
    writeField(details, "responseBodyType", params.responseBodyType);
  }
  if (params.contentType) {
    writeField(details, "contentType", params.contentType);
  }
  if (mappedDetails) {
    for (const key of Object.keys(mappedDetails)) {
      const value = readField(mappedDetails, key);
      if (
        key === "httpStatus" ||
        key === "responseBodyType" ||
        key === "contentType" ||
        key === "remote"
      ) {
        continue;
      }
      writeField(details, key, cloneValue(value));
    }
  }

  const remote: OpenObject = {};
  const extractedRemote = extractRemoteErrorObject(params.responseBody);
  if (extractedRemote) {
    for (const key of Object.keys(extractedRemote)) {
      writeField(remote, key, cloneValue(readField(extractedRemote, key)));
    }
  }
  const mappedRemote = readObjectField(mappedDetails, "remote");
  if (mappedRemote) {
    for (const key of Object.keys(mappedRemote)) {
      writeField(remote, key, cloneValue(readField(mappedRemote, key)));
    }
  }
  if (params.mappedCode) writeField(remote, "code", params.mappedCode);
  if (params.mappedMessage) writeField(remote, "message", params.mappedMessage);
  if (Object.keys(remote).length > 0) {
    writeField(details, "remote", remote);
  }
  if (params.ruleCount > 0 || params.hasFailureCondition) {
    writeField(details, "mapping", {
      source: "model_asset_result_rule",
      failureConditionMatched: params.failureConditionMatched,
      mappedTargets: params.mappedTargets,
    });
  }
  return details;
};

const buildBackendMessage = (
  httpMessage: string,
  remoteSummary: string | null,
): string => {
  if (!remoteSummary || remoteSummary === httpMessage) return httpMessage;
  return `${httpMessage}\n${remoteSummary}`;
};

const buildRemoteHttpFailurePayload = (
  params: BuildRemoteHttpFailureInput,
): RuntimeTaskFailure | null => {
  const resultRule = readResultRule(params.taskRecord);
  const failureCondition = readField(resultRule, "failure_condition");
  const hasFailureCondition = failureCondition !== undefined && failureCondition !== null;
  const failureConditionMatched = hasFailureCondition
    ? evaluateResultCondition(failureCondition, params.responseBody)
    : false;
  if (params.responseOk && !failureConditionMatched) return null;

  // 配方声明的失败原因只在该条件树命中时生效：它解释的是「这条失败判定为什么算失败」，
  // 不参与传输层错误的归因（HTTP 5xx、网络异常的文案仍走既有链）。
  const recipeFailureReason = failureConditionMatched
    ? toScalarString(readField(resultRule, "failure_reason"))
    : null;

  const httpStatus = Number.isFinite(params.httpStatus)
    ? params.httpStatus
    : 0;
  const httpFallbackUserMessage = resolveHttpStatusUserMessage(httpStatus);
  const httpMessage = `HTTP ${httpStatus}`;
  const rules = readErrorMappingRules(resultRule);
  const { mappedError, mappedTargets } = applyErrorMappingRules(
    rules,
    params.responseBody,
  );
  const mappedCode = readMappedErrorString(mappedError, "code");
  const mappedMessage = readMappedErrorString(mappedError, "message");
  const mappedUserMessage = readMappedErrorString(mappedError, "userMessage");
  const mappedBackendMessage = readMappedErrorString(
    mappedError,
    "backendMessage",
  );
  const genericRemoteMessage = pickResponseString(params.responseBody, [
    "error.message",
    "message",
  ]);
  const genericRemoteCode = pickResponseString(params.responseBody, [
    "error.code",
    "code",
  ]);
  const genericRemoteType = pickResponseString(params.responseBody, [
    "error.type",
    "type",
  ]);
  const remoteSummary =
    mappedBackendMessage ??
    mappedMessage ??
    mappedUserMessage ??
    genericRemoteMessage ??
    genericRemoteCode ??
    genericRemoteType;
  const message =
    recipeFailureReason ??
    mappedUserMessage ??
    mappedMessage ??
    genericRemoteMessage ??
    httpMessage;
  const details = buildRemoteDetails({
    httpStatus,
    responseBody: params.responseBody,
    responseBodyType: normalizeString(params.responseBodyType) || null,
    contentType: normalizeString(params.contentType) || null,
    mappedError,
    mappedCode,
    mappedMessage: mappedMessage ?? mappedUserMessage,
    failureConditionMatched,
    hasFailureCondition,
    mappedTargets,
    ruleCount: rules.length,
  });
  const retryableValue = readField(mappedError, "retryable");
  return {
    code: mappedCode ?? params.defaultCode ?? ERROR_CODES.TASK_EXECUTION_FAILED,
    message,
    userMessage: recipeFailureReason ?? mappedUserMessage ?? httpFallbackUserMessage,
    backendMessage: buildBackendMessage(httpMessage, remoteSummary),
    retryable: typeof retryableValue === "boolean" ? retryableValue : null,
    details,
  };
};

export {
  buildRemoteHttpFailurePayload,
  evaluateResultCondition,
  readResultRule,
};
