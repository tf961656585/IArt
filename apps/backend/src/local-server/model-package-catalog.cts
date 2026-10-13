import * as fs from "node:fs";
import * as path from "node:path";
import type { ModelAssetLocalizationBundle } from "@iart/contracts/model-asset-contract";
import * as loggingModule from "./logging.cts";
import type {
  CatalogProjection,
  CatalogVariantGroup,
  CatalogVariantGroupVariant,
  ModelPackageCatalog,
  VariantPayloadOverridesMap,
} from "./model-package-catalog.types.cts";
import {
  isObjectRecord,
  normalizeString,
  notNullish,
  safeReadJsonFile,
  uniq,
} from "./model-package-catalog.shared.cts";
import { buildProjectionFromPackage } from "./model-package-catalog.projection.cts";
import { listDeclaredGenerationProjections } from "./generation-declaration-projection.cts";
import { validateVariantGroupConsistency } from "./model-package-catalog.variant-group-consistency.cts";
import { validatePublicRelayRequirementsForCatalog } from "./public-relay-capability.cts";

const buildVariantShellModelId = (groupKey: string): string => `variant-group:${groupKey}`;

const resolveModelPackagesRoot = (
  options: { baseDir: string | undefined } = { baseDir: undefined },
) => {
  const runtimeProcess = process as NodeJS.Process & { resourcesPath: string | undefined };
  const resourcesPath = normalizeString(runtimeProcess.resourcesPath);
  const { IART_MODEL_ASSET_PACKAGES_DIR } = process.env;
  const envPath = normalizeString(IART_MODEL_ASSET_PACKAGES_DIR);
  if (envPath) {
    return path.resolve(envPath);
  }
  const baseDir = normalizeString(options.baseDir);
  const candidates = [];
  if (baseDir) {
    candidates.push(
      path.resolve(baseDir, "..", "..", "..", ".model-assets", "packages"),
    );
    candidates.push(
      path.resolve(baseDir, "..", "..", ".model-assets", "packages"),
    );
  }
  candidates.push(path.resolve(process.cwd(), ".model-assets", "packages"));
  if (resourcesPath) {
    candidates.push(path.join(resourcesPath, "model-assets"));
  }
  if (typeof process.execPath === "string" && process.execPath.trim()) {
    candidates.push(path.join(path.dirname(process.execPath), "model-assets"));
  }
  const deduped = uniq(candidates.map((candidate) => path.resolve(candidate)));
  for (const candidate of deduped) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {
      void 0;
    }
  }
  return deduped[0] || path.resolve(process.cwd(), ".model-assets", "packages");
};

/**
 * 聚合变体组：将同组投影收敛为组壳投影 + 完整模型列表。
 * - 无 variant_meta 的投影直接保留
 * - 一致性校验通过：选主投影，收敛变体列表
 * - 一致性校验失败：降级为独立展示，记录诊断
 */
const aggregateVariantGroups = (
  projections: CatalogProjection[],
  diagnostics: Array<{ package_id: string; code: string; message: string; model_id: string | undefined }>,
): CatalogProjection[] => {
  // 按 variant_meta.group_key 分组
  const groupMap = new Map<string, CatalogProjection[]>();
  const ungrouped: CatalogProjection[] = [];

  for (const projection of projections) {
    const groupKey = projection.variant_meta !== undefined
      ? projection.variant_meta.group_key
      : undefined;
    if (groupKey === undefined) {
      ungrouped.push(projection);
      continue;
    }
    const existing = groupMap.get(groupKey);
    if (existing !== undefined) {
      existing.push(projection);
    } else {
      groupMap.set(groupKey, [projection]);
    }
  }

  const result: CatalogProjection[] = [...ungrouped];

  for (const [groupKey, groupProjections] of groupMap.entries()) {
    const validation = validateVariantGroupConsistency(groupProjections);
    if (!validation.consistent) {
      // 降级为独立展示：保留所有投影，清空 variant_meta
      loggingModule.logWarn(
        "[model-package-catalog] variant group consistency check failed, degrading to independent display",
        { groupKey, mismatches: validation.mismatches.join("; ") },
      );
      diagnostics.push({
        package_id: groupProjections.map((p) => p.package_id).join(","),
        code: "variant_group_consistency_failed",
        message: `变体组 ${groupKey} 一致性校验失败: ${validation.mismatches.join("; ")}`,
        model_id: undefined,
      });
      for (const projection of groupProjections) {
        projection.variant_meta = undefined;
        result.push(projection);
      }
      continue;
    }

    const sortedProjections = [...groupProjections].sort((left, right) => {
      const leftOrder = left.variant_meta !== undefined ? left.variant_meta.order : 0;
      const rightOrder = right.variant_meta !== undefined ? right.variant_meta.order : 0;
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return left.model_id.localeCompare(right.model_id);
    });
    const confirmedMain = sortedProjections[0];
    if (confirmedMain === undefined) continue;
    const shellModelId = buildVariantShellModelId(groupKey);

    const variants: CatalogVariantGroupVariant[] = [];
    for (const p of sortedProjections) {
      if (p.variant_meta === undefined) continue;
      const hasOverrides = p.variant_meta.payload_overrides !== undefined
        && Object.keys(p.variant_meta.payload_overrides).length > 0;
      variants.push({
        model_id: p.model_id,
        shell_model_id: shellModelId,
        label: p.model_id,
        order: p.variant_meta.order,
        payload_overrides: hasOverrides ? p.variant_meta.payload_overrides : undefined,
      });
    }

    const variantGroup: CatalogVariantGroup = {
      group_key: groupKey,
      shell_model_id: shellModelId,
      default_model_id: confirmedMain.model_id,
      variants,
    };

    // 组壳投影沿用首项共享 schema/ports/runtime，但正式身份切到 shell_model_id
    confirmedMain.shell_model_id = shellModelId;
    confirmedMain.model_id = shellModelId;
    confirmedMain.display_label = groupKey;
    confirmedMain.variant_group = variantGroup;
    confirmedMain.variant_meta = undefined;

    result.push(confirmedMain);

    loggingModule.logDebug(
      "[model-package-catalog] aggregated variant group",
      { groupKey, shellModelId, defaultModelId: variantGroup.default_model_id, variants: variants.map((v) => v.model_id).join(",") },
    );
  }

  return result;
};

const buildReservedModelIds = (projections: CatalogProjection[]): Set<string> => {
  const reserved = new Set<string>();
  for (const projection of projections) {
    reserved.add(projection.model_id);
    if (projection.shell_model_id !== undefined) reserved.add(projection.shell_model_id);
    for (const alias of projection.runtime.aliases) reserved.add(alias);
    if (projection.variant_group !== undefined) {
      for (const variant of projection.variant_group.variants) {
        reserved.add(variant.model_id);
      }
    }
  }
  return reserved;
};

const loadModelPackageCatalog = (
  options: { baseDir: string | undefined; includeDeclared?: boolean } = {
    baseDir: undefined,
  },
): ModelPackageCatalog => {
  const packageRoot = resolveModelPackagesRoot(options);
  const diagnostics: Array<{
    package_id: string;
    code: string;
    message: string;
    model_id: string | undefined;
  }> = [];
  const projections: Array<CatalogProjection | null> = [];
  const localizationBundles: Array<ModelAssetLocalizationBundle | null> = [];
  const modelToPackage = new Map<string, string>();
  const projectionIndexByModelId = new Map<string, number>();
  const duplicateModelIds = new Set<string>();
  if (!fs.existsSync(packageRoot)) {
    diagnostics.push({
      package_id: "*",
      code: "packages_root_missing",
      message: `模型包目录不存在: ${packageRoot}`,
      model_id: undefined,
    });
    // 声明合成投影不依赖包目录：包目录缺失时仍进入目录（自建生成模型第二来源）。
    const declaredOnly = options.includeDeclared === true
      ? listDeclaredGenerationProjections(new Set())
      : { projections: [], localizationBundles: [], diagnostics: [] };
    diagnostics.push(...declaredOnly.diagnostics);
    return {
      loaded_at: new Date().toISOString(),
      package_root: packageRoot,
      projections: declaredOnly.projections,
      bindable_models: [],
      localization_bundles: declaredOnly.localizationBundles,
      diagnostics,
      variantModelToMain: new Map(),
    };
  }
  const packageDirs = fs
    .readdirSync(packageRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const packageDirName of packageDirs) {
    const packageDir = path.join(packageRoot, packageDirName);
    const manifestPath = path.join(packageDir, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
      diagnostics.push({
        package_id: packageDirName,
        code: "manifest_missing",
        message: "缺少 manifest.json，已跳过该包",
        model_id: undefined,
      });
      continue;
    }
    try {
      const manifest = safeReadJsonFile(manifestPath);
      if (!isObjectRecord(manifest)) {
        throw new Error("manifest_invalid");
      }
      const packageId = normalizeString(manifest.package_id);
      if (!packageId) {
        throw new Error("manifest.package_id_missing");
      }
      if (packageId !== packageDirName) {
        throw new Error("manifest.package_id_mismatch");
      }
      if (manifest.deprecated === true) {
        const replacedBy = normalizeString(manifest.replaced_by);
        diagnostics.push({
          package_id: packageId,
          code: "deprecated",
          message: `包已废弃${replacedBy ? `，已由 ${replacedBy} 替代` : ""}`,
          model_id: undefined,
        });
        continue;
      }
      const { projection, localizationBundle } = buildProjectionFromPackage({
        packageDir,
        packageId,
        manifest,
      });
      const publicRelayValidation = validatePublicRelayRequirementsForCatalog([
        projection,
      ]);
      if (publicRelayValidation.diagnostics.length > 0) {
        diagnostics.push(...publicRelayValidation.diagnostics);
        continue;
      }
      const duplicatedBy = modelToPackage.get(projection.model_id);
      if (duplicatedBy) {
        if (!duplicateModelIds.has(projection.model_id)) {
          const existingIndex = projectionIndexByModelId.get(
            projection.model_id,
          );
          if (typeof existingIndex === "number" && projections[existingIndex]) {
            const existingProjection = projections[existingIndex];
            if (
              existingProjection !== null &&
              existingProjection !== undefined
            ) {
              diagnostics.push({
                package_id: existingProjection.package_id,
                model_id: existingProjection.model_id,
                code: "duplicate_model_id",
                message: `模型标识重复，已与包 ${packageId} 冲突`,
              });
              projections[existingIndex] = null;
              localizationBundles[existingIndex] = null;
            }
          }
          duplicateModelIds.add(projection.model_id);
        }
        diagnostics.push({
          package_id: packageId,
          model_id: projection.model_id,
          code: "duplicate_model_id",
          message: `模型标识重复，已被包 ${duplicatedBy} 占用`,
        });
        continue;
      }
      modelToPackage.set(projection.model_id, packageId);
      projectionIndexByModelId.set(projection.model_id, projections.length);
      projections.push(projection);
      localizationBundles.push(localizationBundle);
    } catch (error) {
      diagnostics.push({
        package_id: packageDirName,
        code: "bad_package",
        message: error instanceof Error ? error.message : String(error),
        model_id: undefined,
      });
    }
  }
  const rawProjections = projections.filter(notNullish);
  const bindableModels = rawProjections.map((projection) => ({
    model_id: projection.model_id,
    package_id: projection.package_id,
    display_label: projection.model_id,
  }));
  const aggregatedProjections = aggregateVariantGroups(rawProjections, diagnostics);
  // 构建反向索引：variant model_id -> { 主投影, payload_overrides }
  const variantModelToMain = new Map<string, { projection: CatalogProjection; payload_overrides: VariantPayloadOverridesMap | undefined }>();
  for (const proj of aggregatedProjections) {
    if (proj.variant_group === undefined) continue;
    for (const variant of proj.variant_group.variants) {
      variantModelToMain.set(variant.model_id, {
        projection: proj,
        payload_overrides: variant.payload_overrides,
      });
    }
  }
  // 自建生成模型第二来源（生成模型自建声明试点 §3.6）：声明 × 族模板 → 内存态合成投影，
  // 并入目录投影与本地化束——目录条目、执行链投影解析、节点投影三个消费方共用同一份。
  // 与已装包身份（model_id / 别名 / 变体名）冲突的声明不合成（包优先），留诊断。
  // includeDeclared 只在请求期装载：可执行目录与投影解析按请求/按调用刷新，node-projections
  // 活快照见 createModelProjectionSnapshotCatalog（首个投影请求装配 + 声明变更失效单飞重建）。
  // 任何启动期急切装载都会把声明 store 的文件缓存冻结在进程起点，「先起服后写配置」的读取
  // 顺序会被冻结在空集（custom-generation-model 旧版文件回归测试依赖该顺序）。
  const declared = options.includeDeclared === true
    ? listDeclaredGenerationProjections(buildReservedModelIds(aggregatedProjections))
    : { projections: [], localizationBundles: [], diagnostics: [] };
  aggregatedProjections.push(...declared.projections);
  localizationBundles.push(...declared.localizationBundles);
  diagnostics.push(...declared.diagnostics);
  return {
    loaded_at: new Date().toISOString(),
    package_root: packageRoot,
    projections: aggregatedProjections,
    bindable_models: bindableModels,
    localization_bundles: localizationBundles.filter(notNullish),
    diagnostics,
    variantModelToMain,
  };
};
const listBindableModelProjections = (
  options: { baseDir: string | undefined } = { baseDir: undefined },
) => {
  // 每次调用都重新装载且并入自建生成模型合成投影（目录条目消费方按请求刷新）。
  const catalog = loadModelPackageCatalog({ ...options, includeDeclared: true });
  const projections = Array.isArray((catalog !== null && catalog !== undefined ? catalog.projections : undefined))
    ? catalog.projections
    : [];
  return projections
    .map((projection) => ({
      modelId: normalizeString((projection !== null && projection !== undefined ? projection.model_id : undefined)),
      label: normalizeString((projection !== null && projection !== undefined ? projection.model_id : undefined)),
      packageId: normalizeString((projection !== null && projection !== undefined ? projection.package_id : undefined)) || undefined,
      projection,
    }))
    .filter((item) => item.modelId);
};

type BindableModelProjectionItem = {
  modelId: string;
  label: string;
  packageId: string | undefined;
  projection: CatalogProjection;
};

/**
 * 聚合后目录的平铺成员视图：把变体组壳展开为成员 model_id 条目（AGENTS.md「Variant group
 * 内具体型号选择统一显示 model_id」）。
 *
 * 组壳身份（variant-group:<group_key>）只服务组语义消费方（画布节点目录桥等）；平铺枚举
 * 消费方（可执行目录）需要具体型号条目。成员身份取自 variant_group.variants——聚合产物
 * 的唯一组成员结构，不在此重复组成员查找；投影复用组壳共享投影（组一致性校验已保证组内
 * schema/能力/endpoint 用户可感知语义一致）。展开后组壳自身不再出现在结果里。
 */
const expandVariantGroupMembers = <Item extends BindableModelProjectionItem>(
  items: Item[],
): Item[] => {
  const expanded: Item[] = [];
  for (const item of items) {
    const variantGroup = item.projection.variant_group;
    if (variantGroup === undefined || variantGroup.variants.length === 0) {
      expanded.push(item);
      continue;
    }
    for (const variant of variantGroup.variants) {
      const memberModelId = normalizeString(variant.model_id);
      if (!memberModelId) {
        loggingModule.logDebug(
          "[model-package-catalog] skip variant member with empty model_id",
          { groupKey: variantGroup.group_key, shellModelId: variantGroup.shell_model_id },
        );
        continue;
      }
      expanded.push({ ...item, modelId: memberModelId, label: memberModelId });
    }
  }
  return expanded;
};
const listBindableModelsForApiKeyPolicy = (
  options: { baseDir: string | undefined } = { baseDir: undefined },
) => {
  const catalog = loadModelPackageCatalog(options);
  const bindableModels = Array.isArray(catalog.bindable_models)
    ? catalog.bindable_models
    : [];
  return bindableModels
    .map((item) => ({
      modelId: normalizeString((item !== null && item !== undefined ? item.model_id : undefined)),
      label: normalizeString((item !== null && item !== undefined ? item.display_label : undefined)),
      packageId: normalizeString((item !== null && item !== undefined ? item.package_id : undefined)) || undefined,
    }))
    .filter((item) => item.modelId);
};
type FindProjectionResult = {
  projection: CatalogProjection;
  payload_overrides: VariantPayloadOverridesMap | undefined;
};

const findProjectionByModelIdOrAlias = (
  modelId: string,
  options: { baseDir: string | undefined } = { baseDir: undefined },
): FindProjectionResult | undefined => {
  // 投影解析按需并入自建生成模型合成投影（请求组装/输入准备等执行链
  // 消费方按调用刷新）；已装包身份优先（directMatch 与变体查找都在声明投影之前）。
  const catalog = loadModelPackageCatalog({ ...options, includeDeclared: true });
  const projections = Array.isArray(catalog.projections)
    ? catalog.projections
    : [];
  // 主查找：直接匹配 model_id 或 alias
  const directMatch = projections.find((p) => {
    if (p.model_id === modelId) return true;
    if (p.shell_model_id === modelId) return true;
    const aliases = p.runtime.aliases;
    return Array.isArray(aliases) && aliases.includes(modelId);
  });
  if (directMatch !== undefined) {
    return { projection: directMatch, payload_overrides: undefined };
  }
  // 变体查找：从反向索引中查找
  const variantEntry = catalog.variantModelToMain.get(modelId);
  if (variantEntry !== undefined) {
    return {
      projection: variantEntry.projection,
      payload_overrides: variantEntry.payload_overrides,
    };
  }
  return undefined;
};
type ModelProjectionSnapshotHooks = {
  /** 每次快照重建完成后回调（测试用：钉「一次失效只重建一次」）。 */
  onRebuild?: () => void;
};

/**
 * `/api/model-assets/node-projections`（Editor 节点投影与本地化束来源）的活快照。
 *
 * 机制（失效 + 单飞重建，非每请求全量装配）：
 * - 创建时**不装配**——启动期不读声明 store、不扫描包目录，不恢复「store 首读冻结文件缓存」
 *   回归（includeDeclared 保持按需装载）；
 * - 首个投影请求装配一次（includeDeclared: true，会话前已存在的声明同样进入投影/本地化束）；
 * - 声明变更经 `invalidate()` 失效（装配方在 store 写入成功回调里触发），下一次请求重建。
 *   重建是同步装载，并发请求天然只重建一次；多次失效合并为一次重建。
 * - 复用 loadModelPackageCatalog 单一装配函数（不建第二套装配逻辑）；已装包变更不接失效
 *   （包安装链不受本机制影响）。
 *
 * 返回的 `catalog` 是 ModelPackageCatalog 形状的活视图：属性读取按需重建后取当前快照，
 * 单个请求内的同步读取始终消费同一份快照。
 */
const createModelProjectionSnapshotCatalog = (
  options: { baseDir: string | undefined },
  hooks: ModelProjectionSnapshotHooks = {},
): { catalog: ModelPackageCatalog; invalidate: () => void } => {
  let current: ModelPackageCatalog | null = null;
  let dirty = true;
  const ensure = (): ModelPackageCatalog => {
    if (current === null || dirty) {
      const next = loadModelPackageCatalog({ ...options, includeDeclared: true });
      current = next;
      dirty = false;
      hooks.onRebuild?.();
      return next;
    }
    return current;
  };
  return {
    catalog: {
      get loaded_at() {
        return ensure().loaded_at;
      },
      get package_root() {
        return ensure().package_root;
      },
      get projections() {
        return ensure().projections;
      },
      get bindable_models() {
        return ensure().bindable_models;
      },
      get localization_bundles() {
        return ensure().localization_bundles;
      },
      get diagnostics() {
        return ensure().diagnostics;
      },
      get variantModelToMain() {
        return ensure().variantModelToMain;
      },
    },
    invalidate: () => {
      dirty = true;
    },
  };
};

export {
  resolveModelPackagesRoot,
  loadModelPackageCatalog,
  createModelProjectionSnapshotCatalog,
  listBindableModelProjections,
  listBindableModelsForApiKeyPolicy,
  findProjectionByModelIdOrAlias,
  expandVariantGroupMembers,
};
export type { FindProjectionResult };
