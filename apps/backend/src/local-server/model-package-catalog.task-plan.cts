import type {
  CatalogFormalTaskExecutionPlan,
  CatalogPreRequestDefinition,
  CatalogRawObject,
  CatalogTaskOutputMappingRule,
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
  isJsonValue,
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
  const strategy: CatalogTaskRequestStrategy = {
    request_stage: normalizeString(record.request_stage),
    protocol: normalizeString(record.protocol),
    endpoint: normalizeString(record.endpoint),
    method: normalizeString(record.method),
    header_rules: Array.isArray(record.header_rules)
      ? record.header_rules.filter(isJsonValue)
      : [],
    body_rules: Array.isArray(record.body_rules)
      ? record.body_rules.filter(isJsonValue)
      : [],
    query_rules: Array.isArray(record.query_rules)
      ? record.query_rules.filter(isJsonValue)
      : [],
  };
  return strategy;
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
  setJsonValue(normalizedRequest, "headers", request.headers);
  setJsonValue(normalizedRequest, "body", request.body);
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
