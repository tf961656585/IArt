import { MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY } from "@iart/contracts/model-asset-contract/protocol-constants";
import type { CatalogProjection } from "./model-package-catalog.types.cts";
import { isObjectRecord } from "./model-package-catalog.shared.cts";

/**
 * payload_rules 值规则的宽松结构形态。
 *
 * 字段键收集只读 kind 分派与嵌套槽位，不依赖完整契约类型；用 unknown + 运行时收窄
 * 取代类型断言，让「投影规范化后的规则」与「族模板原始 JSON 规则」走同一份收集实现。
 */
type RuntimeValueRuleLike = {
  kind?: unknown;
  field_key?: unknown;
  fallback?: unknown;
  truthy?: unknown;
  falsy?: unknown;
  args?: unknown;
  entries?: unknown;
  options?: unknown;
};

/**
 * 递归收集 RuntimeValueRule 中所有 kind="field" 的 field_key。
 * 规范化后的 compute 规则统一使用 args/entries/options 三个字段承载嵌套规则。
 */
const collectFieldKeysFromRule = (
  rule: unknown,
): string[] => {
  if (!isObjectRecord(rule)) return [];
  const ruleLike: RuntimeValueRuleLike = rule;
  if (ruleLike.kind === "field") {
    const keys: string[] = [];
    if (typeof ruleLike.field_key === "string") {
      keys.push(ruleLike.field_key);
    }
    if (ruleLike.fallback !== undefined && ruleLike.fallback !== null) {
      keys.push(...collectFieldKeysFromRule(ruleLike.fallback));
    }
    return keys;
  }
  if (ruleLike.kind === "when") {
    const keys: string[] = [];
    keys.push(...collectFieldKeysFromRule(ruleLike.truthy));
    if (ruleLike.falsy !== undefined && ruleLike.falsy !== null) {
      keys.push(...collectFieldKeysFromRule(ruleLike.falsy));
    }
    return keys;
  }
  if (ruleLike.kind === "compute") {
    const keys: string[] = [];
    // args: 大部分 compute 操作符的子规则列表
    const args = ruleLike.args;
    if (Array.isArray(args)) {
      for (const arg of args) {
        if (arg !== undefined && arg !== null && typeof arg === "object" && "kind" in arg) {
          keys.push(...collectFieldKeysFromRule(arg));
        }
      }
    }
    // entries: object/compact_object 的键值对
    const entries = ruleLike.entries;
    if (entries !== undefined && entries !== null && isObjectRecord(entries)) {
      for (const entryRule of Object.values(entries)) {
        if (entryRule !== undefined && entryRule !== null && typeof entryRule === "object" && "kind" in entryRule) {
          keys.push(...collectFieldKeysFromRule(entryRule));
        }
      }
    }
    // options: 部分操作符在 options 内嵌套子规则（source/item/parts 等）
    const options = ruleLike.options;
    if (options !== undefined && options !== null && typeof options === "object") {
      keys.push(...collectFieldKeysFromStructuredValue(options));
    }
    return keys;
  }
  return [];
};

/**
 * 从规范化后的结构化值中递归收集所有 kind="field" 的 field_key。
 * options 内部可能包含嵌套的 RuntimeValueRule。
 */
const collectFieldKeysFromStructuredValue = (value: unknown): string[] => {
  if (value === undefined || value === null) return [];
  if (isObjectRecord(value) && value.kind === "field") {
    return collectFieldKeysFromRule(value);
  }
  if (Array.isArray(value)) {
    const keys: string[] = [];
    for (const item of value) {
      keys.push(...collectFieldKeysFromStructuredValue(item));
    }
    return keys;
  }
  if (isObjectRecord(value)) {
    const keys: string[] = [];
    for (const v of Object.values(value)) {
      keys.push(...collectFieldKeysFromStructuredValue(v));
    }
    return keys;
  }
  return [];
};

/**
 * 按组成部件校验 payload_rules 的字段键引用（校验唯一实现的真实载体）。
 *
 * 投影校验入口 `validatePayloadRuleFieldKeys` 消费完整 CatalogProjection；族模板参数覆盖
 * 的保存期/合成期校验（generation-parameter-overrides）只有「字段键集合 + payload_rules」
 * 两个部件，没有完整投影。两者必须共享同一份实现，不得各自复制一份收集逻辑——本函数是
 * 唯一实现，投影入口只是它的一个调用形态。
 */
export const validatePayloadRuleFieldKeysForParts = (
  parameterFieldKeys: ReadonlyArray<unknown>,
  payloadRules: unknown,
): void => {
  const validFieldKeys = new Set<string>();
  for (const fieldKey of parameterFieldKeys) {
    if (typeof fieldKey === "string") {
      validFieldKeys.add(fieldKey);
    }
  }
  validFieldKeys.add(MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY);
  if (!isObjectRecord(payloadRules)) return;
  const errors: string[] = [];
  for (const [targetPath, rule] of Object.entries(payloadRules)) {
    if (rule === undefined || rule === null) continue;
    const fieldKeys = collectFieldKeysFromRule(rule);
    for (const fk of fieldKeys) {
      if (!validFieldKeys.has(fk)) {
        errors.push(
          `payload_rules["${targetPath}"] references field_key "${fk}" but parameter_schema has no such field`,
        );
      }
    }
  }
  if (errors.length > 0) {
    throw new Error(
      `invalid_payload_rule_field_key: ${errors.join("; ")}`,
    );
  }
};

/**
 * 校验 payload_rules 中所有 kind="field" 的 field_key 必须在 parameter_schema.fields 中存在，
 * 或命中提示词保留键（`__prompt`，不进参数表单）。
 * 包括 build_content_blocks 的 parts[].value 中引用的 field_key。
 */
export const validatePayloadRuleFieldKeys = (projection: CatalogProjection): void => {
  validatePayloadRuleFieldKeysForParts(
    projection.parameter_schema.fields.map((f) => f.field_key),
    projection.runtime.payload_rules,
  );
};
