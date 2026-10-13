import {
  MODEL_ASSET_SUPPORTED_RUNTIME_VALUE_TRANSFORMS,
  type ModelAssetNodeProjectionRuntimeComputeValueRule,
  type ModelAssetNodeProjectionRuntimeComputeOperator,
  type ModelAssetNodeProjectionRuntimeCondition,
  type ModelAssetMediaTargetShape,
  type ModelAssetMultipartArrayNaming,
  type ModelAssetNodeProjectionRuntimeValueRule,
  type ModelAssetNodeProjectionRuntimeValueTransform,
} from "@iart/contracts/model-asset-contract";
import { normalizeMediaTargetShape, normalizeMultipartArrayNaming } from "./media-target";

type RuntimeRuleRecord = object;
type RuntimeComputeRuleEntries = {
  [key: string]: ModelAssetNodeProjectionRuntimeValueRule | undefined;
};
type NormalizedRuntimeComputeRule = {
  kind: "compute";
  operator: ModelAssetNodeProjectionRuntimeComputeOperator;
  media_target: ModelAssetMediaTargetShape | undefined;
  multipart_array_naming: ModelAssetMultipartArrayNaming | undefined;
  cache_key: string | undefined;
  delimiter: string | undefined;
  args: ModelAssetNodeProjectionRuntimeValueRule[] | undefined;
  entries: RuntimeComputeRuleEntries | undefined;
  options: unknown | undefined;
};

const normalizeRuntimeString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const isRuntimeRuleRecord = (value: unknown): value is RuntimeRuleRecord =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const hasOwn = (value: RuntimeRuleRecord, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const readRuntimeRuleField = (value: RuntimeRuleRecord, key: string): unknown =>
  Reflect.get(value, key);

const normalizeValueTransforms = (
  value: unknown,
): ModelAssetNodeProjectionRuntimeValueTransform[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const transforms = value
    .map((item) => normalizeRuntimeString(item))
    .filter((item): item is ModelAssetNodeProjectionRuntimeValueTransform =>
      MODEL_ASSET_SUPPORTED_RUNTIME_VALUE_TRANSFORMS.includes(
        item as ModelAssetNodeProjectionRuntimeValueTransform,
      ),
    );
  return transforms.length > 0 ? transforms : undefined;
};

export const normalizeRuntimeConditionRule = (
  value: unknown,
): ModelAssetNodeProjectionRuntimeCondition => {
  if (!isRuntimeRuleRecord(value)) {
    throw new Error("runtime.payload_rules_condition_invalid");
  }
  const op = normalizeRuntimeString(
    readRuntimeRuleField(value, "op"),
  ).toLowerCase();
  if (op === "and" || op === "or") {
    const rawConditions = readRuntimeRuleField(value, "conditions");
    const conditions = Array.isArray(rawConditions)
      ? rawConditions.map((item) => normalizeRuntimeConditionRule(item))
      : [];
    if (conditions.length === 0) {
      throw new Error(`runtime.payload_rules_condition_invalid:${op}`);
    }
    return { op, conditions };
  }
  if (op === "not") {
    return {
      op: "not",
      condition: normalizeRuntimeConditionRule(
        readRuntimeRuleField(value, "condition"),
      ),
    };
  }
  if (
    ["eq", "ne", "gt", "gte", "lt", "lte", "includes", "excludes"].includes(op)
  ) {
    const field = normalizeRuntimeString(readRuntimeRuleField(value, "field"));
    if (!field || !hasOwn(value, "value")) {
      throw new Error(`runtime.payload_rules_condition_invalid:${op}`);
    }
    return {
      op: op as Extract<
        ModelAssetNodeProjectionRuntimeCondition,
        { value: unknown }
      >["op"],
      field,
      value: readRuntimeRuleField(value, "value"),
    };
  }
  if (op === "truthy" || op === "falsy") {
    const field = normalizeRuntimeString(readRuntimeRuleField(value, "field"));
    if (!field) {
      throw new Error(`runtime.payload_rules_condition_invalid:${op}`);
    }
    return { op, field };
  }
  throw new Error(`runtime.payload_rules_condition_unknown:${op}`);
};

const normalizeRuntimeStructuredValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeRuntimeStructuredValue(item));
  }
  if (!isRuntimeRuleRecord(value)) return value;
  if (normalizeRuntimeString(readRuntimeRuleField(value, "kind"))) {
    return normalizeRuntimeValueRule(value);
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, normalizeRuntimeStructuredValue(item)]),
  );
};

const normalizeRuntimeValueRuleList = (
  value: unknown,
): ModelAssetNodeProjectionRuntimeValueRule[] | undefined =>
  Array.isArray(value)
    ? value.map((item) => normalizeRuntimeValueRule(item))
    : undefined;

export const normalizeRuntimeValueRule = (
  value: unknown,
): ModelAssetNodeProjectionRuntimeValueRule => {
  if (!isRuntimeRuleRecord(value)) {
    throw new Error("runtime.payload_rules_rule_invalid");
  }
  const kind = normalizeRuntimeString(
    readRuntimeRuleField(value, "kind"),
  ).toLowerCase();
  if (kind === "literal") {
    if (!hasOwn(value, "value")) {
      throw new Error("runtime.payload_rules_literal_value_missing");
    }
    return { kind, value: readRuntimeRuleField(value, "value") };
  }
  if (kind === "field") {
    const fieldKey = normalizeRuntimeString(
      readRuntimeRuleField(value, "field_key"),
    );
    if (!fieldKey) {
      throw new Error("runtime.payload_rules_field_key_missing");
    }
    const mediaTarget = normalizeMediaTargetShape(
      readRuntimeRuleField(value, "media_target"),
    );
    const multipartArrayNaming = normalizeMultipartArrayNaming(
      readRuntimeRuleField(value, "multipart_array_naming"),
    );
    const transforms = normalizeValueTransforms(
      readRuntimeRuleField(value, "transforms"),
    );
    const fallbackRaw = readRuntimeRuleField(value, "fallback");
    return {
      kind,
      field_key: fieldKey,
      media_target: mediaTarget ?? undefined,
      multipart_array_naming: multipartArrayNaming ?? undefined,
      transforms: transforms ?? undefined,
      fallback: fallbackRaw !== undefined
        ? normalizeRuntimeValueRule(fallbackRaw)
        : undefined,
    };
  }
  if (kind === "item") {
    const itemPath = normalizeRuntimeString(
      readRuntimeRuleField(value, "path"),
    );
    return {
      kind,
      path: itemPath ?? undefined,
    };
  }
  if (kind === "when") {
    const falsyRaw = readRuntimeRuleField(value, "falsy");
    return {
      kind,
      condition: normalizeRuntimeConditionRule(
        readRuntimeRuleField(value, "condition"),
      ),
      truthy: normalizeRuntimeValueRule(readRuntimeRuleField(value, "truthy")),
      falsy: falsyRaw !== undefined
        ? normalizeRuntimeValueRule(falsyRaw)
        : undefined,
    };
  }
  if (kind === "pre_request_output") {
    const preRequestId = normalizeRuntimeString(
      readRuntimeRuleField(value, "pre_request_id"),
    );
    const outputKey = normalizeRuntimeString(
      readRuntimeRuleField(value, "output_key"),
    );
    if (!preRequestId) {
      throw new Error("runtime.payload_rules_pre_request_id_missing");
    }
    if (!outputKey) {
      throw new Error("runtime.payload_rules_pre_request_output_key_missing");
    }
    return {
      kind,
      pre_request_id: preRequestId,
      output_key: outputKey,
    };
  }
  if (kind !== "compute") {
    throw new Error(`runtime.payload_rules_kind_unknown:${kind}`);
  }

  const operator = normalizeRuntimeString(
    readRuntimeRuleField(value, "operator"),
  ).toLowerCase() as ModelAssetNodeProjectionRuntimeComputeOperator;
  const normalizedRule: NormalizedRuntimeComputeRule = {
    kind: "compute",
    operator,
    media_target: undefined,
    multipart_array_naming: undefined,
    cache_key: undefined,
    delimiter: undefined,
    args: undefined,
    entries: undefined,
    options: undefined,
  };
  const mediaTarget = normalizeMediaTargetShape(
    readRuntimeRuleField(value, "media_target"),
  );
  if (mediaTarget) normalizedRule.media_target = mediaTarget;
  const multipartArrayNaming = normalizeMultipartArrayNaming(
    readRuntimeRuleField(value, "multipart_array_naming"),
  );
  if (multipartArrayNaming) normalizedRule.multipart_array_naming = multipartArrayNaming;
  const cacheKey = normalizeRuntimeString(
    readRuntimeRuleField(value, "cache_key"),
  );
  const delimiter = normalizeRuntimeString(
    readRuntimeRuleField(value, "delimiter"),
  );
  if (cacheKey) normalizedRule.cache_key = cacheKey;
  if (delimiter) normalizedRule.delimiter = delimiter;
  const args = normalizeRuntimeValueRuleList(
    readRuntimeRuleField(value, "args"),
  );
  if (args) normalizedRule.args = args;
  const entries = readRuntimeRuleField(value, "entries");
  if (isRuntimeRuleRecord(entries)) {
    normalizedRule.entries = Object.fromEntries(
      Object.entries(entries)
        .filter(([key]) => normalizeRuntimeString(key))
        .map(([key, item]) => [key, normalizeRuntimeValueRule(item)]),
    );
  }
  const options = readRuntimeRuleField(value, "options");
  if (isRuntimeRuleRecord(options)) {
    normalizedRule.options = normalizeRuntimeStructuredValue(options);
  }
  return normalizedRule as ModelAssetNodeProjectionRuntimeComputeValueRule;
};
