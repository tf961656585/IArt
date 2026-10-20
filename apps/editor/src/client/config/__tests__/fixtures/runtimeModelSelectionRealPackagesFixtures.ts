import { expect } from "vitest";
import type { ModelAssetNodeProjection } from "@iart/contracts/model-asset-contract";
import { buildModelConfigsFromNodeProjections } from "../../modelAssetProjectionBridge";

/**
 * Editor 侧「投影 → 模型配置」链的共享测试助手。
 *
 * 历史：本文件原名 `runtimeModelSelectionRealPackagesFixtures.ts`，其中一半代码是从
 * 包目录读真实包拼 `ModelAssetNodeProjection`。2026-10-20 模型能力包
 * 退场、包目录删除后，那部分已删除——投影来源统一由 `familyTemplateProjectionFixtures`
 * （族模板 × 真实投影管线）提供。本文件只保留与数据来源无关的形态助手。
 */

type JsonRecord = Record<string, unknown>;

export const isJsonRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 把一份投影转成 Editor 运行时用的模型配置（缺配置即失败，不返回半成品）。 */
export const buildSingleConfig = (
  projection: ModelAssetNodeProjection | null | undefined,
) => {
  expect(projection).toBeTruthy();
  if (!projection) {
    throw new Error("missing_projection");
  }
  const [config] = buildModelConfigsFromNodeProjections([projection]);
  if (!config) {
    throw new Error("missing_model_config");
  }
  return config;
};

/** 读对象上的一个对象型属性（非对象/数组一律 undefined）。 */
export const readRecordProperty = (
  value: unknown,
  key: string,
): Record<string, unknown> | undefined => {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const candidate = (value as Record<string, unknown>)[key];
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return undefined;
  }
  return candidate as Record<string, unknown>;
};

export { buildModelConfigsFromNodeProjections };
