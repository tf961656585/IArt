import { Buffer as NodeBuffer } from "node:buffer";
import { createRequire } from "node:module";
import path from "node:path";
import { TextEncoder as NodeTextEncoder } from "node:util";
import { fileURLToPath } from "node:url";
import { beforeAll } from "vitest";
import type {
  ModelAssetLocalizationBundle,
  ModelAssetNodeProjection,
} from "@iart/contracts/model-asset-contract";

/**
 * Editor 侧测试用的「模型投影」夹具（族模板 → 真实投影管线）。
 *
 * 背景：模型能力包退场后，Editor 的投影类测试不能再从包目录读 `runtime_model.json` /
 * `node_definition.json`。但投影管线（`buildProjectionFromPackageSources`）仍是**唯一**把模型
 * 送进目录的通道——自建生成模型记录 × 族模板在内配合成 sources，再经它转成投影。
 *
 * 因此本夹具改为：经 Backend 真实族模板产出 sources → 走 Backend 真实投影管线 → 得到
 * `ModelAssetNodeProjection`。测试断言的对象仍是真实投影产物，换的只是输入来源。
 *
 * 加载方式：Editor 测试跑在 vitest（vite 管线不转译 `.cts`），Backend 是 `.cts` 源码，故经
 * tsx 的作用域 CJS require 在进程内加载——与 `testing/integration/helpers/agentSessionSeamHarness.ts`
 * 同一手法（来源是 `apps/backend/src` 真实源码，不是 dist 产物）。
 *
 * jsdom 注意：esbuild 自检 `new TextEncoder().encode("") instanceof Uint8Array`，jsdom 的两个
 * 构造器属另一 realm 会让自检判假，故先把这两个全局换成 Node realm 实现。
 */

const HELPER_FILE_PATH = fileURLToPath(import.meta.url);
const sharedRequire = createRequire(
  path.join(process.cwd(), "testing/integration/__shared_require__.cjs"),
);

const resolveNodeUint8Array = (): Uint8ArrayConstructor => {
  const bufferPrototype: unknown = Object.getPrototypeOf(NodeBuffer.prototype);
  return (bufferPrototype as { constructor: Uint8ArrayConstructor }).constructor;
};

/** Editor 侧测试可用的族（登记表决定可用面，不在此复制族清单）。 */
type FamilyAdapterId = string;

type TemplateOptions = { acceptedMediaSlots: readonly string[] };

type FamilyTemplateSources = {
  runtimeModel: unknown;
  node: unknown;
  localizationResources: unknown;
};

type FamilyTemplateEntry =
  | {
      familyAdapterId: FamilyAdapterId;
      status: "ready";
      supportsMediaSlots: readonly string[];
      buildBaseSources: (
        modelId: string,
        options: TemplateOptions,
      ) => FamilyTemplateSources;
    }
  | {
      familyAdapterId: FamilyAdapterId;
      status: "pending";
      supportsMediaSlots: readonly string[];
    };

type BackendModules = {
  registry: { GENERATION_FAMILY_TEMPLATE_REGISTRY: Record<string, FamilyTemplateEntry> };
  projection: {
    buildProjectionFromPackageSources: (params: {
      packageId: string;
      entryModelModelId: string;
      protocolFormat: string | undefined;
      runtimeModel: unknown;
      node: unknown;
      localizationResources: unknown;
    }) => {
      projection: ModelAssetNodeProjection;
      localizationBundle: ModelAssetLocalizationBundle;
    };
  };
  templates: {
    declaredGenerationPackageId: (familyAdapterId: FamilyAdapterId) => string;
  };
};

let backendModules: BackendModules | null = null;

const loadBackendModules = (): BackendModules => {
  if (backendModules !== null) return backendModules;
  globalThis.Uint8Array = resolveNodeUint8Array();
  globalThis.TextEncoder = NodeTextEncoder;
  // Backend 的 logging / config 按 IART_STORAGE_ROOT 定位：指向仓库内的临时目录，
  // 不触真实用户数据目录（该目录由 .gitignore 忽略，测试结束不残留业务文件）。
  process.env["IART_STORAGE_ROOT"] = path.join(process.cwd(), ".tmp-model-projection-fixture");
  // 同步加载：多次 `import('tsx/cjs/api')` 在 vitest 的 transform 管线里会拿到不同实例，
  // 用 createRequire 的 CJS 入口可保证与 Backend 源码共用同一个转译注册表。
  const tsx = sharedRequire("tsx/cjs/api") as {
    register: (options: { namespace: string }) => {
      require: (specifier: string, parent: string) => unknown;
      unregister: () => void;
    };
  };
  const scoped = tsx.register({ namespace: "editor-model-projection-fixture" });
  try {
    const sourcePath = (...segments: string[]): string =>
      path.join(process.cwd(), "apps", "backend", "src", "local-server", ...segments);
    backendModules = {
      registry: scoped.require(
        sourcePath("generation-family-templates.registry.cts"),
        HELPER_FILE_PATH,
      ) as BackendModules["registry"],
      projection: scoped.require(
        sourcePath("model-package-catalog.projection.cts"),
        HELPER_FILE_PATH,
      ) as BackendModules["projection"],
      templates: scoped.require(
        sourcePath("generation-family-templates.cts"),
        HELPER_FILE_PATH,
      ) as BackendModules["templates"],
    };
  } finally {
    // 模块已进 require cache：注销钩子只影响后续 require，不影响本夹具已拿到的实现。
    scoped.unregister();
  }
  return backendModules;
};

/** 单族的投影结果（投影 + 本地化束，均为真实管线产物）。 */
export type FamilyProjection = {
  familyAdapterId: FamilyAdapterId;
  packageId: string;
  projection: ModelAssetNodeProjection;
  localizationBundle: ModelAssetLocalizationBundle;
};

/**
 * 用某族模板投影出一个模型（`acceptedMediaSlots` 决定形态：空 = 该族的最小形态）。
 *
 * `modelId` 由调用方按用例语义给出（它只是被声明并写进投影的身份），便于测试直接按 id 找。
 */
export const projectFamilyModel = ({
  familyAdapterId,
  modelId,
  acceptedMediaSlots,
}: {
  familyAdapterId: FamilyAdapterId;
  modelId: string;
  acceptedMediaSlots?: readonly string[];
}): FamilyProjection => {
  const modules = loadBackendModules();
  const entry = modules.registry.GENERATION_FAMILY_TEMPLATE_REGISTRY[familyAdapterId];
  if (entry === undefined) {
    throw new Error(`unknown family adapter id: ${familyAdapterId}`);
  }
  if (entry.status !== "ready") {
    throw new Error(`family template not ready: ${familyAdapterId}`);
  }
  const slots = acceptedMediaSlots ?? entry.supportsMediaSlots;
  const sources = entry.buildBaseSources(modelId, { acceptedMediaSlots: slots });
  const packageId = modules.templates.declaredGenerationPackageId(familyAdapterId);
  const built = modules.projection.buildProjectionFromPackageSources({
    packageId,
    entryModelModelId: modelId,
    protocolFormat: undefined,
    runtimeModel: sources.runtimeModel,
    node: sources.node,
    localizationResources: sources.localizationResources,
  });
  return { familyAdapterId, packageId, ...built };
};

/** 全部 ready 族各投影一个模型（每族带自己的全部素材位）。 */
export const projectAllReadyFamilyModels = (
  modelIdOf: (familyAdapterId: FamilyAdapterId) => string,
): FamilyProjection[] => {
  const modules = loadBackendModules();
  const result: FamilyProjection[] = [];
  for (const [familyAdapterId, entry] of Object.entries(
    modules.registry.GENERATION_FAMILY_TEMPLATE_REGISTRY,
  )) {
    if (entry.status !== "ready") continue;
    result.push(projectFamilyModel({ familyAdapterId, modelId: modelIdOf(familyAdapterId) }));
  }
  if (result.length === 0) {
    throw new Error("no ready family template available for projection fixtures");
  }
  return result;
};

/**
 * 取某族的「最小形态」与「全素材位形态」两投影（覆盖条件分支两侧）。
 *
 * 投影管线对同一族的两种形态各自校验；空形态是「文生 X」路径，全形态是「参考/条件」路径。
 */
export const projectFamilyModelBothShapes = ({
  familyAdapterId,
  modelIdPrefix,
}: {
  familyAdapterId: FamilyAdapterId;
  modelIdPrefix: string;
}): { minimal: FamilyProjection; full: FamilyProjection } => ({
  minimal: projectFamilyModel({
    familyAdapterId,
    modelId: `${modelIdPrefix}-minimal`,
    acceptedMediaSlots: [],
  }),
  full: projectFamilyModel({
    familyAdapterId,
    modelId: `${modelIdPrefix}-full`,
  }),
});

/**
 * 加载 Backend 模块（供需要直接读注册表能力的测试使用，例如取某族的素材位清单）。
 *
 * 暴露它的唯一理由是让测试断言「族能力事实」而不是在测试里硬编码同一份清单。
 */
export const loadFamilyTemplateRegistry = (): Record<string, FamilyTemplateEntry> =>
  loadBackendModules().registry.GENERATION_FAMILY_TEMPLATE_REGISTRY;

/** 取某族能表达的素材位（族能力事实源）。 */
export const supportedMediaSlotsOf = (familyAdapterId: FamilyAdapterId): readonly string[] => {
  const entry = loadFamilyTemplateRegistry()[familyAdapterId];
  if (entry === undefined) throw new Error(`unknown family adapter id: ${familyAdapterId}`);
  return entry.supportsMediaSlots;
};

// 首次导入即预热（测试文件顶层若在 describe 里同步调用夹具，beforeAll 时序来不及）。
beforeAll(() => {
  loadBackendModules();
});
