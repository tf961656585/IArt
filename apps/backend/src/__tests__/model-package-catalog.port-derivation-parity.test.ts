import assert from "node:assert/strict";
import test from "node:test";

import { derivePortDataTypeFromComponent } from "@iart/contracts/model-asset-contract/port-data-type-mapping";
import { GENERATION_FAMILY_TEMPLATE_REGISTRY } from "../local-server/generation-family-templates.registry.cts";
import { isObjectRecord } from "../local-server/model-package-catalog.shared.cts";
import {
  projectAllReadyFamilies,
  projectFamilyTemplate,
  type ProjectedFamilyTemplate,
} from "../local-server/__tests__/family-template-projection-test-helpers";

/**
 * 端口推导等价性：`node_definition.input_ports` 与 `parameter_schema` 推导结果必须一致。
 *
 * 两条路径并存是历史事实——族的 `input_ports` 由模板逐位显式声明（多数族），而
 * `data_source` 为 `connection`/`both` 的字段还会再推导出一份端口。投影管线把两者合并，
 * 本用例钉住合并语义：
 *
 * 1. **覆盖**：显式 `input_ports` 的每个 `field_key` 都必须在投影端口里出现（模板写了端口
 *    却因字段缺失被静默丢掉，等于创作面少一个可接入位）；
 * 2. **上界**：投影端口数恰好等于 `显式集合 ∪ 可推导集合`（不许多推、也不许少推）；
 * 3. **推导规则**：走推导路径的端口，`data_type` / `required` / `multiple` / `id` 逐项符合
 *    `derivePortDataTypeFromComponent` 与字段声明。
 *
 * 2026-10-20 起样本来源由磁盘上的真实包改为**族模板产出的 sources**（模型能力包退场）：
 * 投影管线本身保留且仍是模型进目录的唯一通道，样本换成它现在的真实输入。
 */

interface RuntimeFieldRaw {
  field_key: string;
  data_source: string | undefined;
  component: string | undefined;
  required: boolean | undefined;
  max_files: number | undefined;
}

const toRuntimeField = (raw: unknown): RuntimeFieldRaw | undefined => {
  if (!isObjectRecord(raw)) return undefined;
  const fieldKey = raw["field_key"];
  if (typeof fieldKey !== "string" || fieldKey.length === 0) return undefined;
  const componentProps = isObjectRecord(raw["component_props"])
    ? raw["component_props"]
    : undefined;
  const maxFiles = componentProps?.["maxFiles"];
  return {
    field_key: fieldKey,
    data_source:
      typeof raw["data_source"] === "string" ? raw["data_source"] : undefined,
    component: typeof raw["component"] === "string" ? raw["component"] : undefined,
    required: typeof raw["required"] === "boolean" ? raw["required"] : undefined,
    max_files:
      typeof maxFiles === "number" && Number.isFinite(maxFiles)
        ? maxFiles
        : undefined,
  };
};

/** 读模板 sources 里显式声明的输入端口 field_key（未经投影的原始声明）。 */
const declaredInputPortFieldKeys = (sources: {
  node: Record<string, unknown>;
}): Set<string> => {
  const ports = sources.node["input_ports"];
  const keys = new Set<string>();
  if (!Array.isArray(ports)) return keys;
  for (const port of ports) {
    if (!isObjectRecord(port)) continue;
    const fieldKey = port["field_key"];
    if (typeof fieldKey === "string" && fieldKey.length > 0) keys.add(fieldKey);
  }
  return keys;
};

/** 读模板 sources 里 `parameter_schema.fields`（收窄为可判字段）。 */
const runtimeFieldsOf = (sources: { runtimeModel: Record<string, unknown> }): RuntimeFieldRaw[] => {
  const schema = sources.runtimeModel["parameter_schema"];
  if (!isObjectRecord(schema)) return [];
  const fields = schema["fields"];
  if (!Array.isArray(fields)) return [];
  const result: RuntimeFieldRaw[] = [];
  for (const field of fields) {
    const normalized = toRuntimeField(field);
    if (normalized !== undefined) result.push(normalized);
  }
  return result;
};

/**
 * 逐族核对一份投影的端口推导等价性。
 *
 * `declaredKeys` / `runtimeFields` 取自**模板 sources**（投影前的原始声明），投影取自管线，
 * 两侧对照才有意义——拿投影同时当输入与期望会退化成恒真。
 */
const assertPortDerivationParity = ({
  familyAdapterId,
  projected,
  declaredKeys,
  runtimeFields,
}: {
  familyAdapterId: string;
  projected: ProjectedFamilyTemplate;
  declaredKeys: ReadonlySet<string>;
  runtimeFields: RuntimeFieldRaw[];
}): void => {
  const { projection } = projected;
  const modelId = projection.model_id;
  const fieldByKey = new Map(runtimeFields.map((field) => [field.field_key, field]));
  const derivedKeys = new Set(
    runtimeFields
      .filter(
        (field) =>
          field.data_source === "connection" || field.data_source === "both",
      )
      .map((field) => field.field_key),
  );

  const projectionFieldKeys = new Set(
    projection.ports.inputs.map((port) => port.field_key),
  );

  // 1. 覆盖：显式声明的每个 field_key 都必须在投影结果里
  for (const declaredKey of declaredKeys) {
    assert.ok(
      projectionFieldKeys.has(declaredKey),
      `declared_input_port_missing_in_projection:${familyAdapterId}:${declaredKey}`,
    );
  }

  // 2. 上界：投影端口集合 = 显式集合 ∪ 可推导集合
  const expectedKeys = new Set<string>(declaredKeys);
  for (const key of derivedKeys) expectedKeys.add(key);
  assert.equal(
    projection.ports.inputs.length,
    expectedKeys.size,
    `port_count_mismatch:${familyAdapterId}:${modelId} actual=${String(projection.ports.inputs.length)} expected=${String(expectedKeys.size)}`,
  );

  // 3. 推导规则：走推导路径的端口逐项符合字段声明
  for (const port of projection.ports.inputs) {
    if (!derivedKeys.has(port.field_key)) {
      // 走显式声明路径的端口，跳过推导规则断言
      continue;
    }
    const field = fieldByKey.get(port.field_key);
    assert.ok(
      field !== undefined,
      `derived_port_field_missing:${familyAdapterId}:${port.field_key}`,
    );
    if (field.component !== undefined) {
      assert.equal(
        port.data_type,
        derivePortDataTypeFromComponent(field.component),
        `derived_data_type_mismatch:${familyAdapterId}:${port.field_key}`,
      );
    }
    assert.equal(
      port.required,
      field.required === true,
      `derived_required_mismatch:${familyAdapterId}:${port.field_key}`,
    );
    assert.equal(
      port.multiple,
      field.max_files !== undefined && field.max_files > 1,
      `derived_multiple_mismatch:${familyAdapterId}:${port.field_key}`,
    );
    assert.equal(
      port.id,
      port.field_key,
      `derived_port_id_should_equal_field_key:${familyAdapterId}:${port.field_key}`,
    );
  }
};

void test("逐族验证：族模板产出的 input_ports 与推导规则一致，且覆盖显式声明集合", () => {
  const registry = GENERATION_FAMILY_TEMPLATE_REGISTRY;
  let comparedFamilies = 0;
  // 「有素材位字段」的族计数：这些族的端口集合非空，推导语义才真正被检查到。
  let familiesWithPorts = 0;

  for (const [familyAdapterId, entry] of Object.entries(registry)) {
    if (entry.status !== "ready") continue;

    // 每族各跑两种形态：不接受任何素材位（空端口侧）与接受全部素材位（满端口侧）。
    // 只跑满形态会漏掉「模板无条件声明端口、但素材位不该有」这类错误。
    for (const acceptedMediaSlots of [[], entry.supportsMediaSlots]) {
      const sources = entry.buildBaseSources(`declared-${familyAdapterId}-parity`, {
        acceptedMediaSlots,
      });
      const projected = projectFamilyTemplate({
        familyAdapterId,
        buildBaseSources: entry.buildBaseSources,
        supportsMediaSlots: entry.supportsMediaSlots,
        acceptedMediaSlots,
      });
      assertPortDerivationParity({
        familyAdapterId,
        projected,
        declaredKeys: declaredInputPortFieldKeys(sources),
        runtimeFields: runtimeFieldsOf(sources),
      });
      comparedFamilies += 1;
      if (projected.projection.ports.inputs.length > 0) familiesWithPorts += 1;
    }
  }

  assert.ok(comparedFamilies > 0, "至少要有 1 个 ready 族参与端口等价性核对");
  // 全族都没有输入端口时，「覆盖显式声明集合」退化成空集合恒真——必须至少有一次非空。
  assert.ok(
    familiesWithPorts > 0,
    "至少要有 1 个族产出非空输入端口（否则端口等价性没有被真正检查）",
  );
});

void test("全部 ready 族逐族投影：端口推导等价性全族覆盖", () => {
  const projected = projectAllReadyFamilies(GENERATION_FAMILY_TEMPLATE_REGISTRY);
  assert.equal(
    projected.size,
    Object.values(GENERATION_FAMILY_TEMPLATE_REGISTRY).filter(
      (entry) => entry.status === "ready",
    ).length,
    "投影结果必须覆盖全部 ready 族",
  );
  for (const [familyAdapterId, built] of projected) {
    assert.equal(
      built.packageId,
      `declared-${familyAdapterId}`,
      "虚拟包身份必须按族派生（本地化命名空间不撞车）",
    );
    assert.equal(
      built.localizationBundle.namespace,
      `model-asset/${built.packageId}`,
      "本地化命名空间必须与虚拟包身份同源",
    );
    // 每个投影端口都必须能在参数表单里找到同名 field_key（投影管线的一致性校验已强制，
    // 这里再钉一次是因为端口是创作面可接入位的唯一来源）。
    const fieldKeys = new Set(
      built.projection.parameter_schema.fields.map((field) => field.field_key),
    );
    for (const port of built.projection.ports.inputs) {
      assert.ok(
        fieldKeys.has(port.field_key),
        `port_field_key_not_in_parameter_schema:${familyAdapterId}:${port.field_key}`,
      );
    }
  }
});
