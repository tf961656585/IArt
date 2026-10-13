import type { CustomGenerationModel } from '@iart/contracts';
import type { ModelAssetLocalizationBundle } from '@iart/contracts/model-asset-contract';
import * as loggingModule from './logging.cts';
import { buildProjectionFromPackageSources } from './model-package-catalog.projection.cts';
import type { CatalogProjection } from './model-package-catalog.types.cts';
import {
  buildOpenAiImageV1TemplateSources,
  DECLARED_GENERATION_PACKAGE_ID,
} from './generation-family-templates.cts';
import { listCustomGenerationModels } from './provider-connection/custom-generation-model-store.cts';

/**
 * 自建生成模型的合成投影（docs/custom-providers/生成模型自建声明试点-design.md §3.1/§3.6）。
 *
 * **用户声明 × 族模板 → 内存态虚拟能力包投影**：声明只携带模型属性（model_id、族归属、
 * 是否支持参考图），协议语义与参数表单由族模板（generation-family-templates.cts）承载；
 * 二者合成为一份 CatalogProjection 形状的内存态投影，进入现有目录投影管线——PromptDock
 * 目录、提交链、执行链、结果物化零改动，所有消费方继续只说「能力包」这一种语言。
 *
 * - 纯内存态：禁止写入 .model-assets 安装目录（不与包分发链混淆）；声明本体仍由
 *   custom-generation-model-store 落 config/custom-generation-models.json。
 * - 本地化：合成源交给 buildProjectionFromPackageSources，走与已装包完全相同的
 *   validateLocalizationTargets + rewriteProjectionLocalizationKeys 路径，文案由模板 locales
 *   承载，投影处不硬编码任何语言。
 * - 冒名防御：声明 model_id 命中已装包身份（model_id / 别名 / 变体名）时不合成（包优先，
 *   声明视为过时残留），由调用方传入保留身份集合并留诊断。
 */

export type DeclaredGenerationProjection = {
  projection: CatalogProjection;
  localizationBundle: ModelAssetLocalizationBundle;
};

export type DeclaredGenerationProjectionDiagnostic = {
  package_id: string;
  code: string;
  message: string;
  model_id: string | undefined;
};

const buildDeclaredGenerationProjection = (
  declaration: CustomGenerationModel,
): DeclaredGenerationProjection | null => {
  // 试点单族：模板注册表按 family_adapter_id 分发；扩族时随族模板登记放宽。
  if (declaration.family_adapter_id !== 'openai-image-v1') {
    loggingModule.logDebug('[generation-declaration-projection] no family template for declared family', {
      modelId: declaration.model_id,
      familyAdapterId: declaration.family_adapter_id,
    });
    return null;
  }
  const sources = buildOpenAiImageV1TemplateSources(declaration.model_id, {
    supportsReferenceImage: declaration.supports_reference_image,
    parameterOverrides: declaration.parameter_overrides,
  });
  try {
    const { projection, localizationBundle } = buildProjectionFromPackageSources({
      packageId: DECLARED_GENERATION_PACKAGE_ID,
      entryModelModelId: declaration.model_id,
      protocolFormat: undefined,
      runtimeModel: sources.runtimeModel,
      node: sources.node,
      localizationResources: sources.localizationResources,
    });
    return { projection, localizationBundle };
  } catch (error) {
    loggingModule.logWarn('[generation-declaration-projection] synthetic projection build failed, declaration skipped', {
      modelId: declaration.model_id,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
};

export type DeclaredGenerationProjectionResult = {
  projections: CatalogProjection[];
  localizationBundles: ModelAssetLocalizationBundle[];
  diagnostics: DeclaredGenerationProjectionDiagnostic[];
};

/**
 * 从当前全部声明构建合成投影集合（目录投影的第二来源）。
 *
 * `reservedModelIds` 是已装包占用的全部身份（model_id / 别名 / 变体名 / 组壳 id）：命中的
 * 声明不合成——已装包优先，声明视为与包撞车的过时残留，留 debug 与诊断（AGENTS.md 条件跳过
 * 必须留痕）。投影构建失败同样跳过并留痕，不阻断其他模型。
 */
const listDeclaredGenerationProjections = (reservedModelIds: ReadonlySet<string>): DeclaredGenerationProjectionResult => {
  const projections: CatalogProjection[] = [];
  const localizationBundles: ModelAssetLocalizationBundle[] = [];
  const diagnostics: DeclaredGenerationProjectionDiagnostic[] = [];
  for (const declaration of listCustomGenerationModels()) {
    if (reservedModelIds.has(declaration.model_id)) {
      loggingModule.logDebug('[generation-declaration-projection] declared model_id collides with installed package identity, projection skipped', {
        modelId: declaration.model_id,
      });
      diagnostics.push({
        package_id: DECLARED_GENERATION_PACKAGE_ID,
        code: 'declared_model_id_collision',
        message: `自建模型 ${declaration.model_id} 与已装模型包身份冲突，声明投影已跳过`,
        model_id: declaration.model_id,
      });
      continue;
    }
    const built = buildDeclaredGenerationProjection(declaration);
    if (built === null) continue;
    projections.push(built.projection);
    localizationBundles.push(built.localizationBundle);
  }
  return { projections, localizationBundles, diagnostics };
};

export { buildDeclaredGenerationProjection, listDeclaredGenerationProjections };
