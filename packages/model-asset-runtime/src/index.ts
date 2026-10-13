import { MODEL_ASSET_CONTENT_BLOCKS_OUTPUT_SHAPE, MODEL_ASSET_SUPPORTED_EXECUTION_DRIVERS, type ModelAssetExecutionDriver, type ModelAssetNodeProjectionRuntimeComputeOperator, type ModelAssetNodeProjectionRuntimeValueTransform } from "@iart/contracts/model-asset-contract";
import { validateMediaTargetShape } from "./media-target";

export const MODEL_ASSET_PROVIDER_ID_PATTERN = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;

export const MODEL_ASSET_SUPPORTED_RUNTIME_VALUE_TRANSFORM_LIST = ["trim", "toLowerCase", "toUpperCase", "toNumber", "ensureArray", "first", "extractUrls", "extractFirstUrl", "extractFirstBase64DataUrl", "extractFirstFile", "splitLines", "compactArray", "last", "shotListToTimeline", "timelineToScript", "firstUploadFile", "firstUploadFileOrUrl", "allUploadFiles"] as const satisfies readonly ModelAssetNodeProjectionRuntimeValueTransform[];

export const MODEL_ASSET_SUPPORTED_RUNTIME_COMPUTE_OPERATOR_LIST = ["coalesce", "concat", "join", "array", "compact_array", "object", "compact_object", "normalize_enum", "assert_non_empty", "assert_array_length", "parse_line_pairs", "scale_number", "clamp_number", "map_array", "build_content_blocks", "prepare_audio_url", "resolve_auto_audio_flag"] as const satisfies readonly ModelAssetNodeProjectionRuntimeComputeOperator[];

export type ModelAssetRuntimeValueTransform = (typeof MODEL_ASSET_SUPPORTED_RUNTIME_VALUE_TRANSFORM_LIST)[number];

export type ModelAssetRuntimeComputeOperator = (typeof MODEL_ASSET_SUPPORTED_RUNTIME_COMPUTE_OPERATOR_LIST)[number];

export const MODEL_ASSET_SUPPORTED_RUNTIME_VALUE_TRANSFORMS = new Set<string>(MODEL_ASSET_SUPPORTED_RUNTIME_VALUE_TRANSFORM_LIST);

export const MODEL_ASSET_SUPPORTED_RUNTIME_COMPUTE_OPERATORS = new Set<string>(MODEL_ASSET_SUPPORTED_RUNTIME_COMPUTE_OPERATOR_LIST);

export const MODEL_ASSET_EXECUTION_DRIVERS = new Set<string>(MODEL_ASSET_SUPPORTED_EXECUTION_DRIVERS);

export const normalizeString = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

export const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const hasOwn = (value: Record<string, unknown>, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

export const isModelAssetProviderId = (value: unknown): value is string => {
  const normalized = normalizeString(value);
  return MODEL_ASSET_PROVIDER_ID_PATTERN.test(normalized);
};

export const isModelAssetExecutionDriver = (value: unknown): value is ModelAssetExecutionDriver => {
  const normalized = normalizeString(value);
  return MODEL_ASSET_EXECUTION_DRIVERS.has(normalized);
};

export const assertLegacyKeyAbsent = (value: Record<string, unknown>, legacyKey: string, errorCode: string): void => {
  if (hasOwn(value, legacyKey)) {
    throw new Error(errorCode);
  }
};

export const validateTrimmedStringArray = (value: unknown, errorCode: string): void => {
  if (!Array.isArray(value)) {
    throw new Error(errorCode);
  }
  value.forEach((item) => {
    if (!normalizeString(item)) {
      throw new Error(errorCode);
    }
  });
};

export const normalizeTransforms = (value: unknown): ModelAssetRuntimeValueTransform[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const transforms = value.map((item) => normalizeString(item)).filter((item): item is ModelAssetRuntimeValueTransform => MODEL_ASSET_SUPPORTED_RUNTIME_VALUE_TRANSFORMS.has(item));
  return transforms.length > 0 ? transforms : undefined;
};

const validatePrimitiveArray = (value: unknown, errorCode: string): void => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(errorCode);
  }
  value.forEach((item) => {
    const type = typeof item;
    if (type !== "string" && type !== "number" && type !== "boolean") {
      throw new Error(errorCode);
    }
  });
};

const validatePositiveInteger = (value: unknown, errorCode: string): void => {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new Error(errorCode);
  }
};

export const validateRuntimeCondition = (value: unknown): void => {
  if (!isRecord(value)) {
    throw new Error("runtime_model.runtime.payload_rules_condition_invalid");
  }

  const op = normalizeString(value["op"]).toLowerCase();
  if (!op) {
    throw new Error("runtime_model.runtime.payload_rules_condition_op_missing");
  }

  if (op === "and" || op === "or") {
    if (!Array.isArray(value["conditions"]) || value["conditions"].length === 0) {
      throw new Error("runtime_model.runtime.payload_rules_condition_children_missing");
    }
    value["conditions"].forEach((child) => validateRuntimeCondition(child));
    return;
  }

  if (op === "not") {
    validateRuntimeCondition(value["condition"]);
    return;
  }

  if (["eq", "ne", "gt", "gte", "lt", "lte", "includes", "excludes"].includes(op)) {
    if (!normalizeString(value["field"])) {
      throw new Error(`runtime_model.runtime.payload_rules_condition_field_missing:${op}`);
    }
    if (!hasOwn(value, "value")) {
      throw new Error(`runtime_model.runtime.payload_rules_condition_value_missing:${op}`);
    }
    return;
  }

  if (op === "truthy" || op === "falsy") {
    if (!normalizeString(value["field"])) {
      throw new Error(`runtime_model.runtime.payload_rules_condition_field_missing:${op}`);
    }
    return;
  }

  throw new Error(`runtime_model.runtime.payload_rules_condition_op_unknown:${op}`);
};

const MODEL_ASSET_CONTENT_BLOCKS_OUTPUT_SHAPES = new Set<string>(
  Object.values(MODEL_ASSET_CONTENT_BLOCKS_OUTPUT_SHAPE),
);

const validateBuildContentBlocksOptions = (value: unknown): void => {
  if (!isRecord(value)) {
    throw new Error("runtime_model.runtime.payload_rules_compute_build_content_blocks_options_invalid");
  }
  if (value["role"] !== undefined && !normalizeString(value["role"])) {
    throw new Error("runtime_model.runtime.payload_rules_compute_build_content_blocks_role_invalid");
  }
  if (value["output_shape"] !== undefined) {
    const outputShape = normalizeString(value["output_shape"]).toLowerCase();
    if (!MODEL_ASSET_CONTENT_BLOCKS_OUTPUT_SHAPES.has(outputShape)) {
      throw new Error(`runtime_model.runtime.payload_rules_compute_build_content_blocks_output_shape_unknown:${outputShape}`);
    }
  }
  if (!Array.isArray(value["parts"]) || value["parts"].length === 0) {
    throw new Error("runtime_model.runtime.payload_rules_compute_build_content_blocks_parts_missing");
  }
  value["parts"].forEach((part, index) => {
    if (!isRecord(part)) {
      throw new Error(`runtime_model.runtime.payload_rules_compute_build_content_blocks_part_invalid:${index}`);
    }
    const partKind = normalizeString(part["part_kind"]).toLowerCase();
    if (partKind !== "text" && partKind !== "inline_data") {
      throw new Error(`runtime_model.runtime.payload_rules_compute_build_content_blocks_part_kind_unknown:${partKind}`);
    }
    validateValueRule(part["value"]);
    if (partKind === "inline_data" && part["max_items"] !== undefined) {
      validatePositiveInteger(part["max_items"], "runtime_model.runtime.payload_rules_compute_build_content_blocks_max_items_invalid");
    }
  });
};

const validateOptionalValueRuleList = (value: unknown, errorCode: string): void => {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    throw new Error(errorCode);
  }
  value.forEach((item) => validateValueRule(item));
};

const validateMapArrayOptions = (value: unknown): void => {
  if (!isRecord(value)) {
    throw new Error("runtime_model.runtime.payload_rules_compute_map_array_options_invalid");
  }
  validateValueRule(value["source"]);
  validateValueRule(value["item"]);
  validateOptionalValueRuleList(value["prepend"], "runtime_model.runtime.payload_rules_compute_map_array_prepend_invalid");
  validateOptionalValueRuleList(value["append"], "runtime_model.runtime.payload_rules_compute_map_array_append_invalid");
  if (value["max_items"] !== undefined) {
    validatePositiveInteger(value["max_items"], "runtime_model.runtime.payload_rules_compute_map_array_max_items_invalid");
  }
  if (value["skip_if_empty"] !== undefined && typeof value["skip_if_empty"] !== "boolean") {
    throw new Error("runtime_model.runtime.payload_rules_compute_map_array_skip_if_empty_invalid");
  }
};

export const validateTransforms = (value: unknown): void => {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    throw new Error("runtime_model.runtime.payload_rules_transforms_invalid");
  }
  value.forEach((item) => {
    const transform = normalizeString(item);
    if (!transform) {
      throw new Error("runtime_model.runtime.payload_rules_transforms_invalid");
    }
    if (!MODEL_ASSET_SUPPORTED_RUNTIME_VALUE_TRANSFORMS.has(transform)) {
      throw new Error(`runtime_model.runtime.payload_rules_transform_unknown:${transform}`);
    }
  });
};

export const validateValueRule = (value: unknown): void => {
  if (!isRecord(value)) {
    throw new Error("runtime_model.runtime.payload_rules_rule_invalid");
  }
  validateMediaTargetShape(value["media_target"]);
  const kind = normalizeString(value["kind"]).toLowerCase();
  if (!kind) {
    throw new Error("runtime_model.runtime.payload_rules_kind_missing");
  }

  if (kind === "literal") {
    if (!hasOwn(value, "value")) {
      throw new Error("runtime_model.runtime.payload_rules_literal_value_missing");
    }
    return;
  }

  if (kind === "field") {
    assertLegacyKeyAbsent(value, "fieldKey", "runtime_model.runtime.payload_rules_field_key_legacy_key_not_allowed:fieldKey");
    if (!normalizeString(value["field_key"])) {
      throw new Error("runtime_model.runtime.payload_rules_field_key_missing");
    }
    validateTransforms(value["transforms"]);
    if (value["fallback"] !== undefined) {
      validateValueRule(value["fallback"]);
    }
    return;
  }

  if (kind === "item") {
    if (value["path"] !== undefined && !normalizeString(value["path"])) {
      throw new Error("runtime_model.runtime.payload_rules_item_path_invalid");
    }
    return;
  }

  if (kind === "when") {
    validateRuntimeCondition(value["condition"]);
    validateValueRule(value["truthy"]);
    if (value["falsy"] !== undefined) {
      validateValueRule(value["falsy"]);
    }
    return;
  }

  if (kind === "pre_request_output") {
    if (!normalizeString(value["pre_request_id"])) {
      throw new Error("runtime_model.runtime.payload_rules_pre_request_id_missing");
    }
    if (!normalizeString(value["output_key"])) {
      throw new Error("runtime_model.runtime.payload_rules_pre_request_output_key_missing");
    }
    return;
  }

  if (kind !== "compute") {
    throw new Error(`runtime_model.runtime.payload_rules_kind_unknown:${kind}`);
  }

  const operator = normalizeString(value["operator"]).toLowerCase();
  if (!MODEL_ASSET_SUPPORTED_RUNTIME_COMPUTE_OPERATORS.has(operator)) {
    throw new Error(`runtime_model.runtime.payload_rules_compute_operator_unknown:${operator}`);
  }

  if (operator === "object" || operator === "compact_object") {
    if (!isRecord(value["entries"]) || Object.keys(value["entries"]).length === 0) {
      throw new Error("runtime_model.runtime.payload_rules_compute_entries_missing");
    }
    Object.values(value["entries"]).forEach((entry) => validateValueRule(entry));
    return;
  }

  if (operator === "normalize_enum") {
    if (!Array.isArray(value["args"]) || value["args"].length !== 1) {
      throw new Error("runtime_model.runtime.payload_rules_compute_args_missing");
    }
    value["args"].forEach((arg) => validateValueRule(arg));
    if (!isRecord(value["options"])) {
      throw new Error("runtime_model.runtime.payload_rules_compute_normalize_enum_options_invalid");
    }
    validatePrimitiveArray(value["options"]["allowed_values"], "runtime_model.runtime.payload_rules_compute_allowed_values_missing");
    return;
  }

  if (operator === "assert_non_empty") {
    if (!Array.isArray(value["args"]) || value["args"].length !== 1) {
      throw new Error("runtime_model.runtime.payload_rules_compute_args_missing");
    }
    value["args"].forEach((arg) => validateValueRule(arg));
    if (value["options"] !== undefined && !isRecord(value["options"])) {
      throw new Error("runtime_model.runtime.payload_rules_compute_assert_non_empty_options_invalid");
    }
    return;
  }

  if (operator === "assert_array_length") {
    if (!Array.isArray(value["args"]) || value["args"].length !== 1) {
      throw new Error("runtime_model.runtime.payload_rules_compute_args_missing");
    }
    value["args"].forEach((arg) => validateValueRule(arg));
    if (!isRecord(value["options"])) {
      throw new Error("runtime_model.runtime.payload_rules_compute_assert_array_length_options_invalid");
    }
    const hasMin = typeof value["options"]["min_items"] === "number" && Number.isFinite(value["options"]["min_items"]);
    const hasMax = typeof value["options"]["max_items"] === "number" && Number.isFinite(value["options"]["max_items"]);
    if (!hasMin && !hasMax) {
      throw new Error("runtime_model.runtime.payload_rules_compute_assert_array_length_bounds_missing");
    }
    return;
  }

  if (operator === "parse_line_pairs") {
    if (!Array.isArray(value["args"]) || value["args"].length !== 1) {
      throw new Error("runtime_model.runtime.payload_rules_compute_args_missing");
    }
    value["args"].forEach((arg) => validateValueRule(arg));
    if (!isRecord(value["options"])) {
      throw new Error("runtime_model.runtime.payload_rules_compute_parse_line_pairs_options_invalid");
    }
    if (!normalizeString(value["options"]["left_key"]) || !normalizeString(value["options"]["right_key"])) {
      throw new Error("runtime_model.runtime.payload_rules_compute_parse_line_pairs_keys_missing");
    }
    return;
  }

  if (operator === "scale_number" || operator === "clamp_number") {
    if (!Array.isArray(value["args"]) || value["args"].length !== 1) {
      throw new Error("runtime_model.runtime.payload_rules_compute_args_missing");
    }
    value["args"].forEach((arg) => validateValueRule(arg));
    if (!isRecord(value["options"])) {
      throw new Error(`runtime_model.runtime.payload_rules_compute_${operator}_options_invalid`);
    }
    if (operator === "scale_number" && (typeof value["options"]["factor"] !== "number" || !Number.isFinite(value["options"]["factor"]))) {
      throw new Error("runtime_model.runtime.payload_rules_compute_scale_number_factor_invalid");
    }
    return;
  }

  if (operator === "build_content_blocks") {
    validateBuildContentBlocksOptions(value["options"]);
    return;
  }
  if (operator === "map_array") {
    validateMapArrayOptions(value["options"]);
    return;
  }
  if (operator === "prepare_audio_url") {
    if (!isRecord(value["options"])) {
      throw new Error("runtime_model.runtime.payload_rules_compute_prepare_audio_url_options_invalid");
    }
    validateValueRule(value["options"]["source"]);
    if (value["options"]["allowed_mime_types"] !== undefined) {
      validateTrimmedStringArray(value["options"]["allowed_mime_types"], "runtime_model.runtime.payload_rules_compute_prepare_audio_url_mime_types_invalid");
    }
    if (value["options"]["allowed_extensions"] !== undefined) {
      validateTrimmedStringArray(value["options"]["allowed_extensions"], "runtime_model.runtime.payload_rules_compute_prepare_audio_url_extensions_invalid");
    }
    if (value["options"]["max_size_bytes"] !== undefined && (!Number.isFinite(Number(value["options"]["max_size_bytes"])) || Number(value["options"]["max_size_bytes"]) <= 0)) {
      throw new Error("runtime_model.runtime.payload_rules_compute_prepare_audio_url_max_size_invalid");
    }
    if (value["options"]["min_duration_seconds"] !== undefined && !Number.isFinite(Number(value["options"]["min_duration_seconds"]))) {
      throw new Error("runtime_model.runtime.payload_rules_compute_prepare_audio_url_min_duration_invalid");
    }
    if (value["options"]["max_duration_seconds"] !== undefined && !Number.isFinite(Number(value["options"]["max_duration_seconds"]))) {
      throw new Error("runtime_model.runtime.payload_rules_compute_prepare_audio_url_max_duration_invalid");
    }
    return;
  }
  if (operator === "resolve_auto_audio_flag") {
    if (!isRecord(value["options"])) {
      throw new Error("runtime_model.runtime.payload_rules_compute_resolve_auto_audio_flag_options_invalid");
    }
    validateValueRule(value["options"]["audio_source"]);
    if (value["options"]["auto_audio"] !== undefined) {
      validateValueRule(value["options"]["auto_audio"]);
    }
    return;
  }

  if (!Array.isArray(value["args"])) {
    throw new Error("runtime_model.runtime.payload_rules_compute_args_missing");
  }
  value["args"].forEach((arg) => validateValueRule(arg));
};

export * from "./runtime-utils";
export * from "./media-target";
export * from "./evaluator";
export * from "./normalizer";
// package-hash 不在 barrel export 中：它含 Node.js 专用 API（node:crypto/fs/path），
// 会被 editor 的浏览器构建拉入。需要它的消费者（发布脚本、desktop-shell）
// 通过子路径 @iart/model-asset-runtime/package-hash 引用。
