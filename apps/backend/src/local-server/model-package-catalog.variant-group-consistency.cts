import type { CatalogProjection } from "./model-package-catalog.types.cts";

/**
 * 校验同组变体投影的结构一致性。
 * 检查 parameter_schema.fields 的 field_key 集合、component 类型、
 * ports.inputs/outputs 的 id 和 data_type、request_strategy 的 endpoint 是否完全一致。
 */
export const validateVariantGroupConsistency = (
  projections: CatalogProjection[],
): { consistent: boolean; mismatches: string[] } => {
  const mismatches: string[] = [];
  if (projections.length <= 1) {
    return { consistent: true, mismatches: [] };
  }
  const first = projections[0];
  if (first === undefined) {
    return { consistent: true, mismatches: [] };
  }

  // 1. parameter_schema.fields 的 field_key 集合和 component 类型
  const firstFieldKeys = first.parameter_schema.fields.map((f) => f.field_key);
  const firstFieldComponentMap = new Map<string, string>();
  for (const field of first.parameter_schema.fields) {
    firstFieldComponentMap.set(field.field_key, field.component);
  }

  for (let i = 1; i < projections.length; i++) {
    const current = projections[i];
    if (current === undefined) continue;
    const currentFieldKeys = current.parameter_schema.fields.map((f) => f.field_key);

    // field_key 集合一致
    if (firstFieldKeys.length !== currentFieldKeys.length) {
      mismatches.push(
        `field_key count mismatch for ${current.model_id}: expected ${firstFieldKeys.length}, got ${currentFieldKeys.length}`,
      );
    } else {
      for (const key of firstFieldKeys) {
        if (!currentFieldKeys.includes(key)) {
          mismatches.push(
            `field_key missing in ${current.model_id}: ${key}`,
          );
        }
      }
    }

    // component 类型一致
    for (const field of current.parameter_schema.fields) {
      const expectedComponent = firstFieldComponentMap.get(field.field_key);
      if (expectedComponent !== undefined && expectedComponent !== field.component) {
        mismatches.push(
          `component mismatch for field ${field.field_key} in ${current.model_id}: expected ${expectedComponent}, got ${field.component}`,
        );
      }
    }

    // 2. ports.inputs 的 id 集合和 data_type
    const firstInputIds = first.ports.inputs.map((p) => p.id);
    const firstInputDataTypeMap = new Map<string, string>();
    for (const port of first.ports.inputs) {
      firstInputDataTypeMap.set(port.id, port.data_type);
    }
    const currentInputIds = current.ports.inputs.map((p) => p.id);
    if (firstInputIds.length !== currentInputIds.length) {
      mismatches.push(
        `input port count mismatch for ${current.model_id}: expected ${firstInputIds.length}, got ${currentInputIds.length}`,
      );
    } else {
      for (const id of firstInputIds) {
        if (!currentInputIds.includes(id)) {
          mismatches.push(`input port missing in ${current.model_id}: ${id}`);
        }
      }
    }
    for (const port of current.ports.inputs) {
      const expectedDataType = firstInputDataTypeMap.get(port.id);
      if (expectedDataType !== undefined && expectedDataType !== port.data_type) {
        mismatches.push(
          `input port data_type mismatch for ${port.id} in ${current.model_id}: expected ${expectedDataType}, got ${port.data_type}`,
        );
      }
    }

    // 3. ports.outputs 的 id 集合和 data_type
    const firstOutputIds = first.ports.outputs.map((p) => p.id);
    const firstOutputDataTypeMap = new Map<string, string>();
    for (const port of first.ports.outputs) {
      firstOutputDataTypeMap.set(port.id, port.data_type);
    }
    const currentOutputIds = current.ports.outputs.map((p) => p.id);
    if (firstOutputIds.length !== currentOutputIds.length) {
      mismatches.push(
        `output port count mismatch for ${current.model_id}: expected ${firstOutputIds.length}, got ${currentOutputIds.length}`,
      );
    } else {
      for (const id of firstOutputIds) {
        if (!currentOutputIds.includes(id)) {
          mismatches.push(`output port missing in ${current.model_id}: ${id}`);
        }
      }
    }
    for (const port of current.ports.outputs) {
      const expectedDataType = firstOutputDataTypeMap.get(port.id);
      if (expectedDataType !== undefined && expectedDataType !== port.data_type) {
        mismatches.push(
          `output port data_type mismatch for ${port.id} in ${current.model_id}: expected ${expectedDataType}, got ${port.data_type}`,
        );
      }
    }

    // 4. request_strategy 的 endpoint 一致
    const firstEndpoint = first.task_execution_plan !== null
      ? first.task_execution_plan.request_strategy.endpoint
      : undefined;
    const currentEndpoint = current.task_execution_plan !== null
      ? current.task_execution_plan.request_strategy.endpoint
      : undefined;
    if (firstEndpoint !== currentEndpoint) {
      mismatches.push(
        `request_strategy endpoint mismatch for ${current.model_id}: expected ${String(firstEndpoint)}, got ${String(currentEndpoint)}`,
      );
    }
  }

  return { consistent: mismatches.length === 0, mismatches };
};
