import {
  MODEL_ASSET_URL_INPUT_UPLOAD_MODE,
  MODEL_ASSET_URL_INPUT_UPLOAD_TARGET_TYPE,
} from "@iart/contracts/model-asset-contract";
import * as loggingModule from './logging.cts';
import {
  isModelAssetExecutionDriver,
  isModelAssetProviderId,
  normalizeRuntimeValueRule as normalizeSharedRuntimeValueRule,
  validateMediaTargetRuleSet,
  validateValueRule as validateSharedValueRule,
} from "@iart/model-asset-runtime";
import type {
  CatalogApiDefaults,
  CatalogPreRequestDefinition,
  CatalogRawObject,
  CatalogRuntimeMeta,
  RuntimeValueRuleMap,
} from "./model-package-catalog.types.cts";
import {
  isObjectRecord,
  normalizeString,
  normalizeStringArray,
  setJsonValue,
} from "./model-package-catalog.shared.cts";
import { normalizeTaskPollingStrategy } from "./model-package-catalog.task-plan.cts";

const SUPPORTED_PAYLOAD_FORMATS = new Set(["json", "multipart", "stream"]);
const SUPPORTED_URL_INPUT_UPLOAD_MODES: Set<string> = new Set(
  Object.values(MODEL_ASSET_URL_INPUT_UPLOAD_MODE),
);
const SUPPORTED_URL_INPUT_UPLOAD_TARGET_TYPES: Set<string> = new Set(
  Object.values(MODEL_ASSET_URL_INPUT_UPLOAD_TARGET_TYPE),
);
const normalizeUrlInputUploadMode = (value: unknown, errorCode: string) => {
  const normalized = normalizeString(value);
  if (!normalized) {
    return undefined;
  }
  if (!SUPPORTED_URL_INPUT_UPLOAD_MODES.has(normalized)) {
    throw new Error(errorCode);
  }
  return normalized;
};
const normalizeUrlInputUploadTargetType = (
  value: unknown,
  errorCode: string,
) => {
  const normalized = normalizeString(value);
  if (!normalized) {
    return undefined;
  }
  if (!SUPPORTED_URL_INPUT_UPLOAD_TARGET_TYPES.has(normalized)) {
    throw new Error(errorCode);
  }
  return normalized;
};
export const validateRuntimeMeta = (value: unknown) => {
  if (!isObjectRecord(value)) {
    throw new Error("runtime_model.runtime_missing");
  }
  if (value.urlInputUploadMode !== undefined) {
    throw new Error(
      "runtime_model.runtime.url_input_upload_mode_legacy_key_not_allowed:urlInputUploadMode",
    );
  }
  if (value.urlInputUploadTargetType !== undefined) {
    throw new Error(
      "runtime_model.runtime.url_input_upload_target_type_legacy_key_not_allowed:urlInputUploadTargetType",
    );
  }
  const providerId =
    normalizeString(value.provider_id) || normalizeString(value.providerId);
  if (!providerId) {
    throw new Error("runtime_model.runtime.provider_id_missing");
  }
  if (!isModelAssetProviderId(providerId)) {
    throw new Error(`runtime_model.runtime.provider_id_invalid:${providerId}`);
  }
  if (value.adapter_key !== undefined || value.adapterKey !== undefined) {
    throw new Error("runtime_model.runtime.adapter_key_legacy_not_allowed");
  }
  const executionDriver = normalizeString(
    value.execution_driver || value.executionDriver,
  );
  if (!executionDriver) {
    throw new Error("runtime_model.runtime.execution_driver_missing");
  }
  if (!isModelAssetExecutionDriver(executionDriver)) {
    throw new Error(
      `runtime_model.runtime.execution_driver_unknown:${executionDriver}`,
    );
  }
  /* 对话模型（chat_streaming）已不再是能力包可声明的驱动：这一族只由用户自建声明承载，
     原来在这里跑的「模态 + 公网中转」对话专属校验随之一并移除。 */
  if (value.url_input_upload_mode !== undefined) {
    normalizeUrlInputUploadMode(
      value.url_input_upload_mode,
      `runtime_model.runtime.url_input_upload_mode_invalid:${String(value.url_input_upload_mode)}`,
    );
  }
  if (value.url_input_upload_target_type !== undefined) {
    normalizeUrlInputUploadTargetType(
      value.url_input_upload_target_type,
      `runtime_model.runtime.url_input_upload_target_type_invalid:${String(value.url_input_upload_target_type)}`,
    );
  }
  if (
    normalizeUrlInputUploadMode(
      value.url_input_upload_mode,
      "runtime_model.runtime.url_input_upload_mode_invalid",
    ) === MODEL_ASSET_URL_INPUT_UPLOAD_MODE.PUBLIC_RELAY &&
    !normalizeUrlInputUploadTargetType(
      value.url_input_upload_target_type,
      "runtime_model.runtime.url_input_upload_target_type_invalid",
    )
  ) {
    throw new Error(
      "runtime_model.runtime.url_input_upload_target_type_missing",
    );
  }
  const capabilities = value.capabilities;
  if (capabilities !== undefined) {
    if (!isObjectRecord(capabilities)) {
      throw new Error("runtime_model.runtime.capabilities_invalid");
    }
    if (capabilities.url_input_upload_mode !== undefined) {
      throw new Error(
        "runtime_model.runtime.url_input_upload_mode_wrong_location",
      );
    }
    if (capabilities.url_input_upload_target_type !== undefined) {
      throw new Error(
        "runtime_model.runtime.url_input_upload_target_type_wrong_location",
      );
    }
  }
  const payloadRules = value.payload_rules ?? value.payloadRules;
  if (payloadRules !== undefined) {
    if (!isObjectRecord(payloadRules)) {
      throw new Error("runtime_model.runtime.payload_rules_invalid");
    }
    Object.entries(payloadRules).forEach(([target, rule]) => {
      if (!normalizeString(target)) {
        throw new Error("runtime_model.runtime.payload_rules_target_empty");
      }
      validateSharedValueRule(rule);
    });
    validateMediaTargetRuleSet(payloadRules, {
      payloadFormat: normalizeString(value.payload_format) || "json",
      payloadFormatRule: value.payload_format_rule !== undefined ? value.payload_format_rule : undefined,
      urlInputUploadMode: normalizeString(value.url_input_upload_mode),
      urlInputUploadTargetType: normalizeString(
        value.url_input_upload_target_type,
      ),
      preRequests: Array.isArray(value.pre_requests) ? value.pre_requests as unknown[] : undefined,
    });
  }
  if (capabilities === undefined) {
    return;
  }
  const taskGroup =
    normalizeString(capabilities.task_group) ||
    normalizeString(capabilities.taskGroup);
  if (
    capabilities.task_group !== undefined ||
    capabilities.taskGroup !== undefined
  ) {
    if (!taskGroup) {
      throw new Error("runtime_model.runtime.capabilities_task_group_invalid");
    }
  }
  const mediaInputMode =
    normalizeString(capabilities.media_input_mode) ||
    normalizeString(capabilities.mediaInputMode);
  if (
    capabilities.media_input_mode !== undefined ||
    capabilities.mediaInputMode !== undefined
  ) {
    if (!mediaInputMode) {
      throw new Error(
        "runtime_model.runtime.capabilities_media_input_mode_invalid",
      );
    }
  }
  const uiGuards = capabilities.ui_guards ?? capabilities.uiGuards;
  if (uiGuards !== undefined) {
    if (!Array.isArray(uiGuards)) {
      throw new Error("runtime_model.runtime.capabilities_ui_guards_invalid");
    }
    uiGuards.forEach((item) => {
      if (!normalizeString(item)) {
        throw new Error("runtime_model.runtime.capabilities_ui_guards_invalid");
      }
    });
  }
  const executionTraits =
    capabilities.execution_traits ?? capabilities.executionTraits;
  if (executionTraits !== undefined) {
    if (!Array.isArray(executionTraits)) {
      throw new Error(
        "runtime_model.runtime.capabilities_execution_traits_invalid",
      );
    }
    executionTraits.forEach((item) => {
      if (!normalizeString(item)) {
        throw new Error(
          "runtime_model.runtime.capabilities_execution_traits_invalid",
        );
      }
    });
  }
};
const normalizeApiDefaults = (
  value: unknown,
): CatalogApiDefaults | undefined => {
  if (!isObjectRecord(value)) return undefined;
  const defaults: CatalogApiDefaults = {
    endpoint: undefined,
    method: undefined,
    contentType: undefined,
    headers: undefined,
  };
  const endpoint = normalizeString(value.endpoint);
  const method = normalizeString(value.method);
  if (endpoint) defaults.endpoint = endpoint;
  if (method) defaults.method = method;
  setJsonValue(defaults, "contentType", value.contentType);
  setJsonValue(defaults, "headers", value.headers);
  for (const forbiddenKey of ["timeoutMs", "retries", "retryDelayMs"]) {
    if (Object.prototype.hasOwnProperty.call(value, forbiddenKey)) {
      throw new Error(`runtime.api_defaults_remote_request_governance_forbidden:${forbiddenKey}`);
    }
  }
  return defaults;
};
const inferModeFromTaskType = (taskType: unknown) => {
  const normalized = normalizeString(taskType).toLowerCase();
  if (normalized === "video") return "video";
  if (normalized === "text" || normalized === "audio") return "text";
  return "image";
};

const normalizePreRequestsFromRuntime = (
  runtime: CatalogRawObject,
): CatalogPreRequestDefinition[] | undefined => {
  const raw = runtime.pre_requests;
  if (!Array.isArray(raw)) return undefined;
  const results: CatalogPreRequestDefinition[] = [];
  for (const item of raw) {
    if (item === null || item === undefined || typeof item !== 'object') continue;
    const record = item as CatalogRawObject;
    const id = normalizeString(record.id);
    const endpoint = normalizeString(record.endpoint);
    const method = normalizeString(record.method);
    if (!id || !endpoint || !method) {
      loggingModule.logDebug("[catalog.runtime] normalizePreRequestsFromRuntime: skipping pre_request with missing id/endpoint/method", undefined);
      continue;
    }
    const bodyRaw = record.body;
    const body = isObjectRecord(bodyRaw) ? bodyRaw as CatalogRawObject : {} as CatalogRawObject;
    const outputMappingRaw = record.output_mapping;
    const outputMapping: Record<string, string> = isObjectRecord(outputMappingRaw)
      ? Object.fromEntries(
          Object.entries(outputMappingRaw as CatalogRawObject).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        )
      : {};
    const pollingRaw = record.polling;
    const polling = pollingRaw
      ? normalizeTaskPollingStrategy(pollingRaw)
      : null;
    const submit_response_id_path = normalizeString(record.submit_response_id_path) || null;
    results.push({ id, endpoint, method, body, output_mapping: outputMapping, polling, submit_response_id_path });
  }
  return results.length > 0 ? results : undefined;
};

export const normalizeRuntimeMeta = (
  runtimeValue: unknown,
  fallback: { providerId: string | undefined; modelId: string | undefined; taskType: string | undefined },
): CatalogRuntimeMeta => {
  validateRuntimeMeta(runtimeValue);
  if (!isObjectRecord(runtimeValue)) {
    throw new Error("runtime_model.runtime_missing");
  }
  const runtime = runtimeValue;
  const providerId = normalizeString(runtime.provider_id || runtime.providerId);
  const defaultTaskType =
    normalizeString(runtime.default_task_type || runtime.defaultTaskType) ||
    normalizeString(fallback.taskType) ||
    "image";
  const mode =
    normalizeString(runtime.mode) || inferModeFromTaskType(defaultTaskType);
  const executionDriver = normalizeString(
    runtime.execution_driver || runtime.executionDriver,
  );
  if (!isModelAssetExecutionDriver(executionDriver)) {
    throw new Error(
      `runtime_model.runtime.execution_driver_unknown:${executionDriver}`,
    );
  }
  const aliases = Array.isArray(runtime.aliases)
    ? runtime.aliases
        .map((item) => normalizeString(item))
        .filter((item) => item.length > 0)
    : [];
  const workspaceSource = isObjectRecord(runtime.workspace)
    ? runtime.workspace
    : null;
  const taskQueueSource =
    workspaceSource && isObjectRecord(workspaceSource.task_queue)
      ? workspaceSource.task_queue
      : workspaceSource && isObjectRecord(workspaceSource.taskQueue)
        ? workspaceSource.taskQueue
        : null;
  const maxConcurrentSource = taskQueueSource
    ? Number(taskQueueSource.max_concurrent || taskQueueSource.maxConcurrent)
    : NaN;
  const workspace = workspaceSource
    ? {
        task_list_position:
          normalizeString(
            workspaceSource.task_list_position ||
              workspaceSource.taskListPosition,
          ) || undefined,
        task_queue: taskQueueSource
          ? {
              enabled: taskQueueSource.enabled !== false,
              max_concurrent: Number.isFinite(maxConcurrentSource)
                ? maxConcurrentSource
                : undefined,
            }
          : undefined,
      }
    : undefined;
  const payloadRulesRecord = isObjectRecord(
    runtime.payload_rules || runtime.payloadRules,
  )
    ? runtime.payload_rules || runtime.payloadRules
    : null;
  const payloadRules = payloadRulesRecord
    ? Object.entries(payloadRulesRecord).reduce<RuntimeValueRuleMap>(
        (acc, [target, value]) => {
          acc[target] = normalizeSharedRuntimeValueRule(
            value,
          );
          return acc;
        },
        {},
      )
    : undefined;
  const apiDefaultsSource = runtime.api_defaults || runtime.apiDefaults;
  const apiDefaults = normalizeApiDefaults(apiDefaultsSource);
  const payloadFormat = normalizeString(runtime.payload_format) || undefined;
  if (normalizeString(runtime.payloadFormat)) {
    throw new Error(
      "runtime.payload_format_legacy_key_not_allowed:payloadFormat",
    );
  }
  if (
    payloadFormat &&
    !SUPPORTED_PAYLOAD_FORMATS.has(payloadFormat.toLowerCase())
  ) {
    throw new Error(`runtime.payload_format_unknown:${payloadFormat}`);
  }
  // payload_format_rule: 运行时条件求值的 payload_format（与 payload_format 互斥）。
  // 用于单节点承载多种远端接口语义的场景（如文生图 + 图生图合并节点）。
  const payloadFormatRule = runtime.payload_format_rule;
  if (payloadFormatRule !== undefined) {
    if (payloadFormat) {
      throw new Error(
        "runtime.payload_format_and_rule_mutually_exclusive",
      );
    }
    validateSharedValueRule(payloadFormatRule);
  }
  const urlInputUploadMode = normalizeUrlInputUploadMode(
    runtime.url_input_upload_mode,
    `runtime.url_input_upload_mode_invalid:${String(runtime.url_input_upload_mode)}`,
  );
  const urlInputUploadTargetType = normalizeUrlInputUploadTargetType(
    runtime.url_input_upload_target_type,
    `runtime.url_input_upload_target_type_invalid:${String(runtime.url_input_upload_target_type)}`,
  );
  if (
    urlInputUploadMode === MODEL_ASSET_URL_INPUT_UPLOAD_MODE.PUBLIC_RELAY &&
    !urlInputUploadTargetType
  ) {
    throw new Error("runtime.url_input_upload_target_type_missing");
  }
  validateMediaTargetRuleSet(payloadRules, {
    payloadFormat: payloadFormat || "json",
    payloadFormatRule: payloadFormatRule !== undefined ? payloadFormatRule : undefined,
    urlInputUploadMode,
    urlInputUploadTargetType,
    preRequests: Array.isArray(runtime.pre_requests) ? runtime.pre_requests as unknown[] : undefined,
  });
  const capabilityFlags = (() => {
    if (!isObjectRecord(runtime.capabilities)) return undefined;
    const runtimeCapabilities = runtime.capabilities;
    const uiGuardsSource =
      runtimeCapabilities.ui_guards || runtimeCapabilities.uiGuards;
    const executionTraitsSource =
      runtimeCapabilities.execution_traits ||
      runtimeCapabilities.executionTraits;
    return {
      task_group:
        normalizeString(
          runtimeCapabilities.task_group || runtimeCapabilities.taskGroup,
        ) || undefined,
      media_input_mode:
        normalizeString(
          runtimeCapabilities.media_input_mode ||
            runtimeCapabilities.mediaInputMode,
        ) || undefined,
      ui_guards: normalizeStringArray(uiGuardsSource),
      execution_traits: normalizeStringArray(executionTraitsSource),
    };
  })();
  const normalizedPayloadFormatRule =
    payloadFormatRule !== undefined
      ? normalizeSharedRuntimeValueRule(payloadFormatRule)
      : undefined;
  return {
    provider_id: providerId,
    default_task_type: defaultTaskType,
    mode,
    execution_driver: executionDriver,
    aliases,
    route_segment:
      normalizeString(runtime.route_segment || runtime.routeSegment) ||
      undefined,
    workspace,
    payload_format: payloadFormat,
    payload_format_rule: normalizedPayloadFormatRule,
    url_input_upload_mode: urlInputUploadMode,
    url_input_upload_target_type: urlInputUploadTargetType,
    api_defaults: apiDefaults,
    payload_rules: payloadRules,
    pre_requests: normalizePreRequestsFromRuntime(runtime),
    capabilities: capabilityFlags,
  };
};
