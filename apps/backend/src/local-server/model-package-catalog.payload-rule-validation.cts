import type { CatalogProjection } from "./model-package-catalog.types.cts";
import { isObjectRecord } from "./model-package-catalog.shared.cts";
import {
  analyzePayloadRuleTargets,
  collectPayloadRuleValidFieldKeys,
} from "./model-package-catalog.payload-rule-references.cts";

/**
 * 按组成部件校验 payload_rules 的字段键引用。
 *
 * 投影校验入口 `validatePayloadRuleFieldKeys` 消费完整 CatalogProjection；族模板参数覆盖
 * 的保存期/合成期校验（generation-parameter-overrides）只有「字段键集合 + payload_rules」
 * 两个部件，没有完整投影。两者必须共享同一份实现，不得各自复制一份收集逻辑——本函数是
 * 唯一校验入口，投影入口只是它的一个调用形态。
 *
 * 字段引用提取本身不在这里实现：唯一实现在
 * `model-package-catalog.payload-rule-references.cts`（保存期校验与合成期裁剪共用同一份）。
 * 本函数只做「取值引用的字段键必须存在」这一条判据。
 */
export const validatePayloadRuleFieldKeysForParts = (
  parameterFieldKeys: ReadonlyArray<unknown>,
  payloadRules: unknown,
): void => {
  const validFieldKeys = collectPayloadRuleValidFieldKeys(parameterFieldKeys);
  if (!isObjectRecord(payloadRules)) return;
  const errors: string[] = [];
  for (const [targetPath, analysis] of analyzePayloadRuleTargets(payloadRules)) {
    for (const ref of analysis.references) {
      // 条件引用的字段可以来自 schema_defaults（如按型号分支的 `model`），存在性由
      // 条件求值侧的字段表保证；这里沿用既有口径，只校验取值引用的字段键。
      if (ref.role !== "value") continue;
      if (!validFieldKeys.has(ref.field_key)) {
        errors.push(
          `payload_rules["${targetPath}"] references field_key "${ref.field_key}" but parameter_schema has no such field`,
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
