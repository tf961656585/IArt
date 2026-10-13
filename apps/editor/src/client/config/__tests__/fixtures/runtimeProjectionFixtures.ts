import type { ModelAssetNodeProjection } from "@iart/contracts/model-asset-contract";

import { buildModelConfigFromNodeProjection } from "@/client/config/modelAssetProjectionBridge";
import type { ModelConfigEntry } from "@/client/config/models.config";
import type { ModelResultExtractor } from "@/features/workspace/modelFormTypes";
import type { SchemaFormDefinition } from "@/features/workspace/schema/types";
import {
  cloneModelAssetFixtureValue,
  loadModelAssetPackageCatalogFixture,
} from "./modelAssetPackageProjectionFixtures";

const projectionCache = new Map<string, ModelAssetNodeProjection>();
const aliasToMainCache = new Map<string, string>();

const loadProjectionCache = (): void => {
  if (projectionCache.size > 0) {
    return;
  }

  const catalog = loadModelAssetPackageCatalogFixture();
  catalog.projections.forEach((projection) => {
    projectionCache.set(projection.model_id, projection);
    // 索引 alias → main model_id，模拟 Editor 运行时 buildLookup 的 alias 解析行为
    const aliases = projection.runtime?.aliases;
    if (Array.isArray(aliases)) {
      for (const alias of aliases) {
        if (typeof alias === "string" && alias && !aliasToMainCache.has(alias)) {
          aliasToMainCache.set(alias, projection.model_id);
        }
      }
    }
  });
};

const requireProjection = (modelId: string): ModelAssetNodeProjection => {
  loadProjectionCache();
  // 先按主 model_id 直接查找
  const direct = projectionCache.get(modelId);
  if (direct) {
    return cloneModelAssetFixtureValue(direct);
  }
  // 再按 alias 查找（用于合并包兼容场景，如 gpt-image-2-edit → gpt-image-2）
  const mainModelId = aliasToMainCache.get(modelId);
  if (mainModelId) {
    const viaAlias = projectionCache.get(mainModelId);
    if (viaAlias) {
      return cloneModelAssetFixtureValue(viaAlias);
    }
  }
  throw new Error(
    `[test-fixture] projection not found for model_id=${modelId}`,
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
