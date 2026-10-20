import assert from 'node:assert/strict';

import type { GenerationMediaSlotId } from '@iart/contracts';
import {
  declaredGenerationPackageId,
  type GenerationFamilyTemplateSources,
} from '../generation-family-templates.cts';
import type { GenerationFamilyTemplateEntry } from '../generation-family-templates.registry.cts';
import { buildProjectionFromPackageSources } from '../model-package-catalog.projection.cts';
import type { CatalogProjection } from '../model-package-catalog.types.cts';

/**
 * 族模板 → 目录投影的测试入口（包目录退场后，依赖真实包的测试统一改用它当夹具）。
 *
 * 背景：模型能力包退场后，`buildProjectionFromPackageSources` 仍是**唯一**把模型送进目录的
 * 通道——自建生成模型记录 × 族模板在内存里合成 sources，再经这条管线转成 `CatalogProjection`。
 * 因此投影管线必须继续有测试保护，但这些测试不能再拿仓库里的真实包目录当输入。
 *
 * 本 helper 提供「用族模板产出的真实 sources 当夹具」的两个入口：
 * - `projectFamilyTemplate`：单族单形态，等价于一次自建模型声明合成出来的投影；
 * - `projectAllReadyFamilies`：7 族逐族（每族带上自己的全部素材位）各投影一次。
 *
 * 之所以优先用族模板而不是 `mkdtemp` 自造最小包：族模板就是生产主链的输入形态，拿它当夹具
 * 测的是同一条真实管线和真实数据形状；自造包只能证明管线「能读」，证明不了模板产出的
 * sources 能过投影校验（本地化目标、字段键引用、媒体目标、端口推导）。
 */

/** 投影结果与本地化束（与 `buildProjectionFromPackageSources` 的返回同形）。 */
export type ProjectedFamilyTemplate = {
  projection: CatalogProjection;
  localizationBundle: ReturnType<
    typeof buildProjectionFromPackageSources
  >['localizationBundle'];
  packageId: string;
};

/** 单族投影的参数（`familyAdapterId` 决定虚拟包身份，其余决定模板形态）。 */
export type ProjectFamilyTemplateParams = {
  familyAdapterId: string;
  buildBaseSources: (
    modelId: string,
    options: { acceptedMediaSlots: readonly GenerationMediaSlotId[] },
  ) => GenerationFamilyTemplateSources;
  /** 该族模板能表达的素材位全量（通常直接取注册条目的 `supportsMediaSlots`）。 */
  supportsMediaSlots: readonly GenerationMediaSlotId[];
  /** 本次投影勾选的素材位；缺省为全量（覆盖素材位条件分支的真值一侧）。 */
  acceptedMediaSlots?: readonly GenerationMediaSlotId[];
  /** 声明侧 model_id；缺省按族派生，保证多族并存时不撞名。 */
  modelId?: string;
};

/**
 * 用某族模板的一份 sources 走真实投影路径。
 *
 * 失败即抛（本地化目标校验、字段键引用校验、媒体目标校验都在管线内），调用方据此判红。
 */
export const projectFamilyTemplateSources = ({
  familyAdapterId,
  modelId,
  sources,
}: {
  familyAdapterId: string;
  modelId: string;
  sources: GenerationFamilyTemplateSources;
}): ProjectedFamilyTemplate => {
  const packageId = declaredGenerationPackageId(
    familyAdapterId as Parameters<typeof declaredGenerationPackageId>[0],
  );
  const built = buildProjectionFromPackageSources({
    packageId,
    entryModelModelId: modelId,
    protocolFormat: undefined,
    runtimeModel: sources.runtimeModel,
    node: sources.node,
    localizationResources: sources.localizationResources,
  });
  assert.equal(
    built.projection.model_id,
    modelId,
    'projection.model_id 必须等于声明传入的 model_id',
  );
  return { ...built, packageId };
};

/**
 * 单族单形态：构建模板 → 投影。`acceptedMediaSlots` 缺省为该族模板能表达的全部素材位
 * （等价于用户把该族所有素材位都勾上，覆盖素材位条件分支的真值一侧）。
 */
export const projectFamilyTemplate = ({
  familyAdapterId,
  buildBaseSources,
  supportsMediaSlots,
  acceptedMediaSlots = supportsMediaSlots,
  modelId = `declared-${familyAdapterId}-test`,
}: ProjectFamilyTemplateParams): ProjectedFamilyTemplate =>
  projectFamilyTemplateSources({
    familyAdapterId,
    modelId,
    sources: buildBaseSources(modelId, { acceptedMediaSlots }),
  });

/**
 * 逐族投影全部 ready 族（每族带上自己的全部素材位）。
 *
 * 返回值按 `familyAdapterId` 索引，调用方可按族取用；断言「至少一族」防止注册表整体 pending
 * 时测试聚成空循环恒绿（包目录退场后，这种「夹具悄悄变空」的形态尤其要防）。
 */
export const projectAllReadyFamilies = (
  registry: Record<string, GenerationFamilyTemplateEntry>,
): Map<string, ProjectedFamilyTemplate> => {
  const projected = new Map<string, ProjectedFamilyTemplate>();
  for (const [familyAdapterId, entry] of Object.entries(registry)) {
    if (entry.status !== 'ready') continue;
    projected.set(
      familyAdapterId,
      projectFamilyTemplate({
        familyAdapterId,
        buildBaseSources: entry.buildBaseSources,
        supportsMediaSlots: entry.supportsMediaSlots,
      }),
    );
  }
  assert.ok(projected.size > 0, '至少要有 1 个 ready 族可供投影测试');
  return projected;
};
