import assert from "node:assert/strict";
import test from "node:test";

import { GENERATION_FAMILY_TEMPLATE_REGISTRY } from "../local-server/generation-family-templates.registry.cts";
import { projectAllReadyFamilies } from "../local-server/__tests__/family-template-projection-test-helpers";

/**
 * 媒体字段判空必须用 `ne []`，不得用 `truthy`。
 *
 * DSL 的 `truthy` / `falsy` 沿用 JavaScript `Boolean` 语义（见
 * `packages/model-asset-runtime/__tests__/evaluator.test.ts`），而媒体字段的表单默认值是
 * 空数组，`Boolean([])` 恒为 true。用 `truthy` 判空会让「未选择任何图」被当成「已选择」：
 * 轻则请求体里出现无 url 的媒体块，重则条件分支永不可达。
 *
 * 2026-10-20 起样本来源改为**族模板产出的 sources**（模型能力包退场，包目录已删除）：
 * 族模板是现在唯一会把媒体字段写进 payload_rules 的地方，这条不变量对它比对照
 * 旧的真实包更要紧——模板一旦写错，所有自建生成模型都会踩同一个坑。
 *
 * 检查对象是投影后的形态（而非模板字面量）：投影会把媒体目标与 payload_format 规则规范化，
 * 覆盖面因此包含「模板字面量 → 消费形态」全链。
 */

type Offence = { modelId: string; field: string; path: string };

const collectTruthyOnArrayFields = (
  value: unknown,
  arrayFields: ReadonlySet<string>,
  trail: string,
  offences: Offence[],
  modelId: string,
): void => {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectTruthyOnArrayFields(item, arrayFields, `${trail}[${index}]`, offences, modelId),
    );
    return;
  }
  if (value === null || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const op = record["op"];
  const field = record["field"];
  if ((op === "truthy" || op === "falsy") && typeof field === "string" && arrayFields.has(field)) {
    offences.push({ modelId, field, path: trail });
  }
  for (const [key, child] of Object.entries(record)) {
    collectTruthyOnArrayFields(child, arrayFields, `${trail}.${key}`, offences, modelId);
  }
};

void test("媒体字段判空不得用 truthy/falsy，须用 ne []（族模板全族覆盖）", () => {
  const projected = projectAllReadyFamilies(GENERATION_FAMILY_TEMPLATE_REGISTRY);
  const offences: Offence[] = [];
  let checkedModels = 0;

  for (const { projection } of projected.values()) {
    // 「默认值是数组」的字段 = 媒体字段（多图/多素材位的表单默认值恒为空数组）。
    const arrayFields = new Set(
      projection.parameter_schema.fields
        .filter((field) => Array.isArray(field.default_value))
        .map((field) => field.field_key),
    );
    if (arrayFields.size === 0) continue;
    checkedModels += 1;
    collectTruthyOnArrayFields(
      projection.runtime.payload_rules ?? {},
      arrayFields,
      `${projection.model_id}/payload_rules`,
      offences,
      projection.model_id,
    );
  }

  // 至少有一个族带媒体字段，否则本用例退化成空循环恒绿。
  assert.ok(
    checkedModels > 0,
    "至少要有 1 个族模板产出数组默认值字段（否则本不变量没有被真正检查）",
  );
  assert.deepEqual(
    offences,
    [],
    `数组字段判空必须改用 ne []:${JSON.stringify(offences)}`,
  );
});
