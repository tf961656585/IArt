import type { ModelAssetNodeProjection } from "@iart/contracts/model-asset-contract";

import { buildModelConfigFromNodeProjection } from "@/client/config/modelAssetProjectionBridge";
import type { ModelConfigEntry } from "@/client/config/models.config";
import type { ModelResultExtractor } from "@/features/workspace/modelFormTypes";
import type { SchemaFormDefinition } from "@/features/workspace/schema/types";
import { cloneModelAssetFixtureValue } from "./projectionCloneFixtures";
import { projectFamilyModel } from "./familyTemplateProjectionFixtures";

/**
 * 按 model_id 取一份**真实投影**（族模板 × 真实投影管线）。
 *
 * 历史：本文件原从包目录读真实包。能力包退场、包目录删除后，改为按
 * 「这个 model_id 属于哪一族」投影出同语义的投影。`modelId` 原样作为声明身份传给投影，
 * 因此测试里按 model_id 取用与断言标题的写法完全不变。
 *
 * 未登记的 id 直接抛错（不做兜底投影）：静默造一个空投影会让断言变成恒真。
 */
const FAMILY_BY_MODEL_ID: Record<string, string> = {
  "gpt-image-2": "openai-image-v1",
  "gpt-image-2-edit": "openai-image-v1",
  "gemini-3-pro-image": "gemini-image-interactions-v1",
  "gemini-3.1-flash-image": "gemini-image-interactions-v1",
  "gemini-3.1-flash-lite-image": "gemini-image-interactions-v1",
  "veo-3.1-generate-preview": "veo-v1",
  "veo-3.1-fast-generate-preview": "veo-v1",
  "veo-3.1-lite-generate-preview": "veo-v1",
  "kling-v3-text2video": "kling-text2video-v1",
  "kling-v3-image2video": "kling-image2video-v1",
  "kling-v3-omni-video": "kling-omni-video-v1",
  "doubao-seedance-1-5-pro-251215": "seedance-2-0-v1",
  "doubao-seedance-2-0-260128": "seedance-2-0-v1",
  "doubao-seedance-2-0-fast-260128": "seedance-2-0-v1",
  "doubao-seedance-2-0-mini-260615": "seedance-2-0-v1",
};

const projectionCache = new Map<string, ModelAssetNodeProjection>();

const loadProjectionCache = (): void => {
  if (projectionCache.size > 0) {
    return;
  }
  for (const [modelId, familyAdapterId] of Object.entries(FAMILY_BY_MODEL_ID)) {
    projectionCache.set(
      modelId,
      projectFamilyModel({ familyAdapterId, modelId }).projection,
    );
  }
};

const requireProjection = (modelId: string): ModelAssetNodeProjection => {
  loadProjectionCache();
  const direct = projectionCache.get(modelId);
  if (direct) {
    return cloneModelAssetFixtureValue(direct);
  }
  throw new Error(
    `[test-fixture] projection not found for model_id=${modelId}（未在 FAMILY_BY_MODEL_ID 登记所属族）`,
  );
};

export const loadNodeProjectionFixture = (
  modelId: string,
): ModelAssetNodeProjection => requireProjection(modelId);

export const buildRuntimeProjectedConfigFixture = (
  modelId: string,
): ModelConfigEntry => {
  const projection = requireProjection(modelId);
  const config = buildModelConfigFromNodeProjection(projection);
  if (!config) {
    throw new Error(
      `[test-fixture] projection cannot map to model config: ${modelId}`,
    );
  }
  return config;
};

export const loadResultExtractorFixture = (
  modelId: string,
): ModelResultExtractor => {
  const config = buildRuntimeProjectedConfigFixture(modelId);
  const extractor = config.workspace?.resultExtractor;
  if (!extractor) {
    throw new Error(
      `[test-fixture] result extractor missing for model_id=${modelId}`,
    );
  }
  return cloneModelAssetFixtureValue(extractor);
};

export const loadSchemaFixtureFromProjection = async (
  modelId: string,
): Promise<SchemaFormDefinition<string>> => {
  const config = buildRuntimeProjectedConfigFixture(modelId);
  const form = config.workspace?.form;
  if (!form || form.kind !== "schema") {
    throw new Error(
      `[test-fixture] schema form missing for model_id=${modelId}`,
    );
  }

  const schemaModule = await form.load();
  const schema = ((
    schemaModule as {
      default?: SchemaFormDefinition<string>;
      schema?: SchemaFormDefinition<string>;
    }
  ).default ??
    (schemaModule as { schema?: SchemaFormDefinition<string> }).schema ??
    schemaModule) as SchemaFormDefinition<string>;
  return cloneModelAssetFixtureValue(schema);
};
