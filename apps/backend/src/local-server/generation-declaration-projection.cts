import type { CustomGenerationModel } from '@iart/contracts';
import type { ModelAssetLocalizationBundle } from '@iart/contracts/model-asset-contract';
import * as loggingModule from './logging.cts';
import { buildProjectionFromPackageSources } from './model-package-catalog.projection.cts';
import type { CatalogProjection } from './model-package-catalog.types.cts';
import { declaredGenerationPackageId } from './generation-family-templates.cts';
import {
  buildFamilyTemplateSources,
  filterAcceptedMediaSlotsForFamily,
} from './generation-family-templates.registry.cts';
import { listCustomGenerationModels } from './provider-connection/custom-generation-model-store.cts';

/**
 * 自建生成模型的合成投影（docs/custom-providers/生成模型自建声明试点-design.md §3.1/§3.6）。
 *
 * **用户声明 × 族模板 → 内存态虚拟能力包投影**：声明只携带模型属性（model_id、族归属、
 * 是否支持参考图），协议语义与参数表单由族模板（generation-family-templates.cts）承载；
 * 二者合成为一份 CatalogProjection 形状的内存态投影，进入现有目录投影管线——PromptDock
 * 目录、提交链、执行链、结果物化零改动，所有消费方继续只说「能力包」这一种语言。
 *
 * - 纯内存态：禁止写入任何安装目录（不与分发包链混淆）；声明本体仍由
 *   custom-generation-model-store 落 config/custom-generation-models.json。
 * - 本地化：合成源交给 buildProjectionFromPackageSources，走与已装包完全相同的
 *   validateLocalizationTargets + rewriteProjectionLocalizationKeys 路径，文案由模板 locales
 *   承载，投影处不硬编码任何语言。
 * - 没有「冒名防御」：模型来源唯一（spec 03 PC-15），不存在另一类载体占用 model_id 身份，
 *   记录即模型。任何「与已装包撞名则跳过」的判据在包退场后恒假，不得重新引入。
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
  // 族模板按 family_adapter_id 查注册表分发：未登记 = 非法/已删族；pending = 该族模板未就绪。
  // 两者都不合成投影，但留痕要能分清「记录非法」与「这一族还没做」，否则扩族期排查会误判。
  const built = buildFamilyTemplateSources(
    declaration.family_adapter_id,
    declaration.model_id,
    {
      // 投影侧按该族模板能表达的素材位收窄：写入侧已拒绝越界写入，这里兜的是守卫落地前的
      // 存量记录（越界位被过滤并留痕，记录本身不丢）。
      acceptedMediaSlots: filterAcceptedMediaSlotsForFamily(
        declaration.family_adapter_id,
        declaration.accepted_media_slots,
        declaration.model_id,
      ),
      parameterOverrides: declaration.parameter_overrides,
    },
  );
  if (built.kind === 'unknown') {
    loggingModule.logDebug('[generation-declaration-projection] unknown family adapter id, declaration skipped', {
      modelId: declaration.model_id,
      familyAdapterId: declaration.family_adapter_id,
    });
    return null;
  }
  if (built.kind === 'pending') {
    loggingModule.logDebug('[generation-declaration-projection] family template pending, declaration skipped', {
      modelId: declaration.model_id,
      familyAdapterId: built.familyAdapterId,
      reason: 'family_template_not_implemented',
    });
    return null;
  }
  const sources = built.sources;
  try {
    const { projection, localizationBundle } = buildProjectionFromPackageSources({
      packageId: declaredGenerationPackageId(declaration.family_adapter_id),
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
      familyAdapterId: declaration.family_adapter_id,
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
 * 从当前全部用户模型记录构建合成投影集合。
 *
 * 模型来源唯一（spec 03 PC-15）：没有第二类载体可以与记录「撞名」，因此这里不存在保留身份集、
 * 也不存在「包优先」跳过——原冒名防御依赖「已装包占用某身份」这一事实，包退场后它恒假，
 * 留着只会让一条合法记录被静默跳过。投影构建失败仍逐个跳过并留痕，不阻断其他模型。
 */
const listDeclaredGenerationProjections = (): DeclaredGenerationProjectionResult => {
  const projections: CatalogProjection[] = [];
  const localizationBundles: ModelAssetLocalizationBundle[] = [];
  const diagnostics: DeclaredGenerationProjectionDiagnostic[] = [];
  for (const declaration of listCustomGenerationModels()) {
    const built = buildDeclaredGenerationProjection(declaration);
    if (built === null) continue;
    projections.push(built.projection);
    localizationBundles.push(built.localizationBundle);
  }
  return { projections, localizationBundles, diagnostics };
};

export { buildDeclaredGenerationProjection, listDeclaredGenerationProjections };
