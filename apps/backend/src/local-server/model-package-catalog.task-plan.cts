import type {
  CatalogFormalTaskExecutionPlan,
  CatalogPreRequestDefinition,
  CatalogRawObject,
  CatalogTaskOutputMappingRule,
  CatalogTaskPollingHttpQueryEntry,
  CatalogTaskPollingHttpRequest,
  CatalogTaskPollingStrategy,
  CatalogTaskRequestStrategy,
  CatalogTaskResultAcquisitionStrategy,
  CatalogTaskResultCondition,
  CatalogTaskResultConditionValue,
  CatalogTaskResultIdentityPath,
  CatalogTaskResultOutputMapping,
  CatalogTaskResultRule,
  JsonPrimitive,
  JsonValue,
} from "./model-package-catalog.types.cts";
import * as loggingModule from './logging.cts';
import {
  isObjectRecord,
  normalizePositiveInteger,
  normalizeString,
  normalizeStringArray,
  notNullish,
  requireObjectRecord,
  setJsonValue,
} from "./model-package-catalog.shared.cts";

const normalizeTaskRequestStrategy = (
  value: unknown,
): CatalogTaskRequestStrategy => {
  const record = requireObjectRecord(
    value,
    "runtime_model.task_execution_plan_request_strategy_invalid",
  );
  // 请求头 / 查询参数 / 请求体的取值只有一棵规则树（`runtime.payload_rules`）；
  // 历史 `header_rules` / `body_rules` / `query_rules` 数组已从运行时形状删除，
  // 旧记录里的残留键在此按缺省忽略（不报错、不复制）。
  const strategy: CatalogTaskRequestStrategy = {
    request_stage: normalizeString(record.request_stage),
    protocol: normalizeString(record.protocol),
    endpoint: normalizeString(record.endpoint),
    method: normalizeString(record.method),
  };
  return strategy;
};

/** 固定请求头归一：对象与 `[{name,value}]` 两种声明形态都接受（实体 → 运行时的接缝）。 */
const normalizeFixedHeaderRecord = (value: unknown): Record<string, string> => {
  const result: Record<string, string> = {};
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isObjectRecord(item)) continue;
      const name = normalizeString(item.name);
      if (!name) continue;
      const rawValue = item.value;
      result[name] = typeof rawValue === "string" ? rawValue : normalizeString(rawValue);
    }
    return result;
  }
  if (!isObjectRecord(value)) return result;
  for (const [name, rawValue] of Object.entries(value)) {
    if (!name) continue;
    if (rawValue === undefined || rawValue === null) continue;
    result[name] = typeof rawValue === "string" ? rawValue : String(rawValue);
  }
  return result;
};

const normalizePollingQuery = (value: unknown): CatalogTaskPollingHttpQueryEntry[] => {
  if (!Array.isArray(value)) return [];
  const entries: CatalogTaskPollingHttpQueryEntry[] = [];
  for (const item of value) {
    if (!isObjectRecord(item)) continue;
    const name = normalizeString(item.name);
    if (!name) {
      loggingModule.logDebug("[catalog.task-plan] polling query entry missing name, skipped", undefined);
      continue;
    }
    const rawValue = item.value;
    entries.push({
      name,
      value: typeof rawValue === "string" ? rawValue : rawValue === undefined || rawValue === null ? "" : String(rawValue),
    });
  }
  return entries;
};
export const normalizeTaskPollingStrategy = (
  value: unknown,
): CatalogTaskPollingStrategy => {
  const record = requireObjectRecord(
    value,
    "runtime_model.task_execution_plan_polling_strategy_invalid",
  );
  const request = requireObjectRecord(
    record.request,
    "runtime_model.task_execution_plan_polling_strategy_request_invalid",
  );
  const polling = requireObjectRecord(
    record.polling,
    "runtime_model.task_execution_plan_polling_strategy_policy_invalid",
  );
  const normalizedRequest = {} as CatalogTaskPollingHttpRequest;
  normalizedRequest.url_template = normalizeString(request.url_template);
  normalizedRequest.method = normalizeString(request.method);
  normalizedRequest.headers = normalizeFixedHeaderRecord(request.headers);
  normalizedRequest.query = normalizePollingQuery(request.query);
  setJsonValue(normalizedRequest, "body", request.body);
  normalizedRequest.body_format = normalizeString(request.body_format) === "form" ? "form" : "json";
  normalizedRequest.content_type = normalizeString(request.content_type) || null;
  return {
    request: normalizedRequest,
    polling: {
      intervalMs: normalizePositiveInteger(polling.intervalMs) ?? 0,
      maxAttempts: normalizePositiveInteger(polling.maxAttempts) ?? 0,
      successPath: normalizeString(polling.successPath) || undefined,
      successFieldPaths: normalizeStringArray(polling.successFieldPaths) || [],
      successStatuses: normalizeStringArray(polling.successStatuses) || [],
      statusFieldPaths: normalizeStringArray(polling.statusFieldPaths) || [],
      failureStatuses: normalizeStringArray(polling.failureStatuses) || [],
      failureCodePaths: normalizeStringArray(polling.failureCodePaths) || [],
      failureMessagePaths:
        normalizeStringArray(polling.failureMessagePaths) || [],
    },
  };
};
const normalizeTaskResultRule = (value: unknown): CatalogTaskResultRule => {
  const record = requireObjectRecord(
    value,
    "runtime_model.task_execution_plan_result_rule_invalid",
  );
  const rule = {} as CatalogTaskResultRule;
  rule.mode = normalizeString(record.mode);
  rule.submit_response_id_path = normalizeString(record.submit_response_id_path);
  rule.error_mapping_rules = Array.isArray(record.error_mapping_rules)
      ? record.error_mapping_rules
          .map((mappingRule) => normalizeTaskOutputMappingRule(mappingRule))
          .filter(notNullish)
      : [];
  const submitAcceptCondition = normalizeTaskResultCondition(
    record.submit_accept_condition,
  );
  if (submitAcceptCondition !== undefined) {
    rule.submit_accept_condition = submitAcceptCondition;
  }
  const successCondition = normalizeTaskResultCondition(
    record.success_condition,
  );
  if (successCondition !== undefined) rule.success_condition = successCondition;
  const failureCondition = normalizeTaskResultCondition(
    record.failure_condition,
  );
  if (failureCondition !== undefined) rule.failure_condition = failureCondition;
  const failureReason = normalizeString(record.failure_reason);
  if (failureReason) rule.failure_reason = failureReason;
  const note = normalizeString(record.note);
  if (note) rule.note = note;
  return rule;
};
const normalizeTaskOutputMappingRule = (
  value: unknown,
): CatalogTaskOutputMappingRule | null => {
  if (!isObjectRecord(value) || !isObjectRecord(value.source)) return null;
  const target = normalizeString(value.target);
  const sourceKind = normalizeString(value.source.kind);
  const sourcePath = normalizeString(value.source.path);
  if (!target || !sourceKind || !sourcePath) return null;
  const rule = {} as CatalogTaskOutputMappingRule;
  rule.target = target;
  rule.source = {
      kind: sourceKind,
      path: sourcePath,
  };
  rule.required = typeof value.required === 'boolean' ? value.required : false;
  if (Object.prototype.hasOwnProperty.call(value, "default_value")) {
    rule.default_value = value.default_value;
  }
  return rule;
};
const normalizeTaskResultIdentityPath = (
  value: JsonValue | undefined,
): CatalogTaskResultIdentityPath | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const pathValue = normalizeString(value);
  if (pathValue) return pathValue;
  const pathSegments = normalizeStringArray(value);
  return pathSegments ?? undefined;
};
const isJsonPrimitive = (value: JsonValue): value is JsonPrimitive =>
  value === null ||
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean";
const normalizeTaskResultConditionValue = (
  value: JsonValue | undefined,
): CatalogTaskResultConditionValue | undefined => {
  if (value === undefined) return undefined;
  if (isJsonPrimitive(value)) return value;
  if (!Array.isArray(value)) return undefined;
  const values: JsonPrimitive[] = [];
  value.forEach((item) => {
    if (isJsonPrimitive(item)) {
      values.push(item);
    }
  });
  return values.length > 0 ? values : undefined;
};
const normalizeTaskResultCondition = (
  value: JsonValue | undefined,
): CatalogTaskResultCondition | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!isObjectRecord(value)) return undefined;
  const op = normalizeString(value.op);
  if (!op) return undefined;
  const condition = {} as CatalogTaskResultCondition;
  condition.op = op;
  const pathValue = normalizeString(value.path);
  if (pathValue) condition.path = pathValue;
  const fieldValue = normalizeString(value.field);
  if (fieldValue) condition.field = fieldValue;
  const conditionValue = normalizeTaskResultConditionValue(value.value);
  if (conditionValue !== undefined) condition.value = conditionValue;
  if (Array.isArray(value.children)) {
    const children = value.children
      .map((child) => normalizeTaskResultCondition(child))
      .filter(notNullish);
    if (children.length > 0) condition.children = children;
  }
  const nestedCondition = normalizeTaskResultCondition(value.condition);
  if (nestedCondition) condition.condition = nestedCondition;
  return condition;
};
const normalizeTaskResultAcquisitionStrategy = (
  value: unknown,
): CatalogTaskResultAcquisitionStrategy => {
  const record = requireObjectRecord(
    value,
    "runtime_model.task_execution_plan_result_acquisition_strategy_invalid",
  );
  const strategy = {} as CatalogTaskResultAcquisitionStrategy;
  strategy.acquisition_mode = normalizeString(record.acquisition_mode);
  strategy.identity_source = normalizeString(record.identity_source);
  const identityPath = normalizeTaskResultIdentityPath(record.identity_path);
  if (identityPath !== undefined) strategy.identity_path = identityPath;
  strategy.accept = normalizeString(record.accept) || undefined;
  strategy.media_type = normalizeString(record.media_type) || undefined;
  // 结果获取请求的固定请求头（由格式 `api.headers.*` 字面量派生并随策略冻结）。
  strategy.request_headers = normalizeFixedHeaderRecord(record.request_headers);
  if (record.request_strategy === null) {
    strategy.request_strategy = null;
  } else if (record.request_strategy !== undefined) {
    strategy.request_strategy = normalizeTaskRequestStrategy(
      record.request_strategy,
    );
  }
  const successCondition = normalizeTaskResultCondition(
    record.success_condition,
  );
  if (successCondition !== undefined)
    strategy.success_condition = successCondition;
  const failureCondition = normalizeTaskResultCondition(
    record.failure_condition,
  );
  if (failureCondition !== undefined)
    strategy.failure_condition = failureCondition;
  strategy.requires_auth =
    typeof record.requires_auth === "boolean" ? record.requires_auth : false;
  const note = normalizeString(record.note);
  if (note) strategy.note = note;
  return strategy;
};
const normalizeTaskResultOutputMapping = (
  value: unknown,
): CatalogTaskResultOutputMapping => {
  const record = requireObjectRecord(
    value,
    "runtime_model.task_execution_plan_result_output_mapping_invalid",
  );
  const mapping = {} as CatalogTaskResultOutputMapping;
  mapping.response_mode = normalizeString(record.response_mode);
  mapping.output_mapping_rules = Array.isArray(record.output_mapping_rules)
      ? record.output_mapping_rules
          .map((rule) => normalizeTaskOutputMappingRule(rule))
          .filter(notNullish)
      : [];
  mapping.requires_auth =
    typeof record.requires_auth === "boolean" ? record.requires_auth : false;
  const downloadRequiredCondition = normalizeTaskResultCondition(
    record.download_required_condition,
  );
  if (downloadRequiredCondition !== undefined) {
    mapping.download_required_condition = downloadRequiredCondition;
  }
  const note = normalizeString(record.note);
  if (note) mapping.note = note;
  return mapping;
};
const normalizePreRequest = (
  value: unknown,
): CatalogPreRequestDefinition | null => {
  if (!isObjectRecord(value)) return null;
  const id = normalizeString(value.id);
  const endpoint = normalizeString(value.endpoint);
  const method = normalizeString(value.method);
  if (!id || !endpoint || !method) {
    loggingModule.logDebug("[catalog.task-plan] normalizePreRequest: missing id/endpoint/method, skipping", undefined);
    return null;
  }
  const bodyRaw = value.body;
  const body = isObjectRecord(bodyRaw) ? bodyRaw as CatalogRawObject : {} as CatalogRawObject;
  const outputMappingRaw = value.output_mapping;
  const outputMapping: Record<string, string> = isObjectRecord(outputMappingRaw)
    ? Object.fromEntries(
        Object.entries(outputMappingRaw as CatalogRawObject).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      )
    : {};
  const pollingRaw = value.polling;
  const polling = pollingRaw
    ? normalizeTaskPollingStrategy(pollingRaw)
    : null;
  const submit_response_id_path = normalizeString(value.submit_response_id_path) || null;
  return {
    id,
    endpoint,
    method,
    body,
    output_mapping: outputMapping,
    polling,
    submit_response_id_path,
  };
};

export const normalizeFormalTaskExecutionPlan = (
  runtimeModel: unknown,
): CatalogFormalTaskExecutionPlan | null => {
  if (!isObjectRecord(runtimeModel)) return null;
  const runtimeRecord = isObjectRecord(runtimeModel.runtime) ? runtimeModel.runtime : null;
  if (!isObjectRecord(runtimeModel.request_strategy)) {
    throw new Error(
      "runtime_model.task_execution_plan_request_strategy_missing",
    );
  }
  if (!isObjectRecord(runtimeModel.result_rule)) {
    throw new Error("runtime_model.result_rule_missing");
  }
  const preRequestsRaw = Array.isArray(runtimeRecord !== null ? runtimeRecord.pre_requests : undefined)
    ? (runtimeRecord !== null ? runtimeRecord.pre_requests : undefined) as unknown[]
    : [];
  const preRequests = preRequestsRaw
    .map((item) => normalizePreRequest(item))
    .filter(notNullish);
  return {
    request_strategy: normalizeTaskRequestStrategy(
      runtimeModel.request_strategy,
    ),
    polling_strategy:
      runtimeModel.polling_strategy === undefined ||
      runtimeModel.polling_strategy === null
        ? null
        : normalizeTaskPollingStrategy(runtimeModel.polling_strategy),
    result_rule: normalizeTaskResultRule(runtimeModel.result_rule),
    result_acquisition_strategy:
      runtimeModel.result_acquisition_strategy === undefined ||
      runtimeModel.result_acquisition_strategy === null
        ? null
        : normalizeTaskResultAcquisitionStrategy(
            runtimeModel.result_acquisition_strategy,
          ),
    result_output_mapping:
      runtimeModel.result_output_mapping === undefined ||
      runtimeModel.result_output_mapping === null
        ? null
        : normalizeTaskResultOutputMapping(runtimeModel.result_output_mapping),
    pre_requests: preRequests.length > 0 ? preRequests : null,
  };
};
