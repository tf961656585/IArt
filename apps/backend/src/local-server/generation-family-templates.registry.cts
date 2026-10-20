import {
  GenerationFamilyAdapterIdSchema,
  type FamilyTemplateParameterDescriptor,
  type GenerationFamilyAdapterId,
  type GenerationMediaSlotId,
} from '@iart/contracts';
import * as loggingModule from './logging.cts';
import {
  buildFamilyTemplateParameterDescriptorFromSources,
  type GenerationFamilyTemplateBuilder,
  type GenerationFamilyTemplateOptions,
  type GenerationFamilyTemplateSources,
} from './generation-family-templates.cts';
import {
  buildGeminiImageInteractionsV1BaseTemplateSources,
  buildGeminiImageInteractionsV1ParameterDescriptor,
  GEMINI_IMAGE_INTERACTIONS_V1_FAMILY_ADAPTER_ID,
  GEMINI_IMAGE_INTERACTIONS_V1_SUPPORTED_MEDIA_SLOTS,
} from './generation-family-templates.gemini-image.cts';
import {
  buildOpenAiImageV1BaseTemplateSources,
  buildOpenAiImageV1ParameterDescriptor,
  OPENAI_IMAGE_V1_FAMILY_ADAPTER_ID,
  OPENAI_IMAGE_V1_SUPPORTED_MEDIA_SLOTS,
} from './generation-family-templates.openai-image.cts';
import {
  buildSeedance20V1BaseTemplateSources,
  buildSeedance20V1ParameterDescriptor,
  SEEDANCE_2_0_V1_FAMILY_ADAPTER_ID,
  SEEDANCE_2_0_V1_SUPPORTED_MEDIA_SLOTS,
} from './generation-family-templates.seedance.cts';
import {
  buildVeoV1BaseTemplateSources,
  buildVeoV1ParameterDescriptor,
  VEO_V1_FAMILY_ADAPTER_ID,
  VEO_V1_SUPPORTED_MEDIA_SLOTS,
} from './generation-family-templates.veo.cts';
import {
  buildKlingText2VideoV1BaseTemplateSources,
  buildKlingText2VideoV1ParameterDescriptor,
  KLING_TEXT2VIDEO_V1_FAMILY_ADAPTER_ID,
  KLING_TEXT2VIDEO_V1_SUPPORTED_MEDIA_SLOTS,
} from './generation-family-templates.kling-text2video.cts';
import {
  buildKlingImage2VideoV1BaseTemplateSources,
  buildKlingImage2VideoV1ParameterDescriptor,
  KLING_IMAGE2VIDEO_V1_FAMILY_ADAPTER_ID,
  KLING_IMAGE2VIDEO_V1_SUPPORTED_MEDIA_SLOTS,
} from './generation-family-templates.kling-image2video.cts';
import {
  buildKlingOmniVideoV1BaseTemplateSources,
  buildKlingOmniVideoV1ParameterDescriptor,
  KLING_OMNI_VIDEO_V1_FAMILY_ADAPTER_ID,
  KLING_OMNI_VIDEO_V1_SUPPORTED_MEDIA_SLOTS,
} from './generation-family-templates.kling-omni-video.cts';
import { applyParameterOverrides, EMPTY_PARAMETER_OVERRIDES } from './generation-parameter-overrides.cts';

/**
 * 生成族模板注册表（docs/custom-providers/生成模型自建声明试点-design.md §3.3/§3.4）。
 *
 * **一张表把「接口类型 → 族模板」的全部事实收在一处**：模板构建器、该族模板能表达哪些素材位、
 * 该族模板用到了适配器声明的哪几个 endpoint 键。三件事必须同源，否则会出现「契约放开了一个
 * 接口类型、界面能选、运行时没有对应模板」这类静默断链。
 *
 * - 7 个键**必须齐全**：注册表类型是 `Record<GenerationFamilyAdapterId, ...>`，值域 owner 是
 *   `packages/contracts` 的 `GENERATION_FAMILY_ADAPTER_IDS`。少写一个键 = 编译期 TypeScript
 *   报「Property '<id>' is missing」，不是运行时才发现的空模板。
 * - 就绪状态是显式的判别联合：`ready` 才有 `buildBaseSources`；`pending` 表示该族的模板规则
 *   尚未实现（后续批次逐族补齐）。**未知 id 与未就绪族必须可区分**——前者是非法输入（路由
 *   404），后者是合法接口类型但能力未上线（路由 501 + 日志留痕），不得混成一个 null。
 * - `supportsMediaSlots` 是本批新增的**一致性事实源**：记录上的 `accepted_media_slots` 必须是
 *   它的子集（写入侧守卫），创作面只呈现子集内的素材位——「能选但一提交就失败」的入口靠它
 *   在写入时就拦掉。pending 族的取值是 `[]`：模板未就绪时它确实一个素材位也表达不了，允许
 *   写入非空清单就是把失败推迟到运行时。
 * - `declaredEndpointKeys` 是适配器 `relative_endpoints` 的**键名**（不是路径字面量）：路径
 *   事实源仍在 `packages/contracts` ADAPTER_REGISTRY，注册表只声明「本族模板用到了哪几个」，
 *   一致性门禁据此逐键核对模板内的实际 endpoint，防止模板与适配器双向漂移。
 *
 * 本模块是 Runtime Backend 内置资源：不进 contracts、不落任何安装目录。
 */

/** 注册表条目的公共事实（就绪与否都要回答「支持哪些素材位」「用到哪些 endpoint 键」）。 */
type GenerationFamilyTemplateEntryCommon = {
  familyAdapterId: GenerationFamilyAdapterId;
  /**
   * 该族模板能表达的素材位（受控词表子集，值域 owner 是 contracts 的
   * `GENERATION_MEDIA_SLOT_IDS`）。写入侧守卫与创作面准入共用这一份。
   */
  supportsMediaSlots: readonly GenerationMediaSlotId[];
  /**
   * 该族**协议强制必选**的素材位（必须是 `supportsMediaSlots` 的子集）。
   *
   * 与 `supportsMediaSlots` 的区别：后者是「这个族能表达哪些位」（用户可选空间上限），前者是
   * 「这个族每次提交都必须有哪一位」（用户没有选择空间）。两者都是族能力事实，必须与模板实现
   * 同源——放到消费侧会立刻成为第二处事实源，改族时漏改一处就产生「能建但一提交就失败」的
   * 模型（本仓明令禁止的形态）。
   *
   * 目前只有可灵图生视频族有必选位：该端点每次提交都必须带首帧。
   */
  requiredMediaSlots: readonly GenerationMediaSlotId[];
  /**
   * 该族模板用到的适配器 endpoint 键（`ADAPTER_REGISTRY[id].relative_endpoints` 的键名）。
   * 一致性门禁要求：每个键在适配器里存在，且模板内的 endpoint 字面量恰好落在这些键的值里。
   */
  declaredEndpointKeys: readonly string[];
};

/** 一族模板的注册条目：就绪（可构建）或未就绪（显式 pending）。 */
export type GenerationFamilyTemplateEntry =
  | (GenerationFamilyTemplateEntryCommon & {
      status: 'ready';
      buildBaseSources: GenerationFamilyTemplateBuilder;
    })
  | (GenerationFamilyTemplateEntryCommon & {
      status: 'pending';
      /** 未就绪的内部原因码（仅日志；用户可见文案由消费方按场景拼，不直接上屏）。 */
      pendingReason: string;
    });

const PENDING_REASON_TEMPLATE_NOT_IMPLEMENTED = 'family_template_not_implemented';

/**
 * 7 族注册表。
 *
 * 每族有一份独立文件承载模板规则（2026-10-19 起逐族落地；可灵三族与 veo 随后补齐）。条目仍
 * 保留 `pending` 形态：新增接口类型时先登记条目与能力事实（空清单），再由「逐族实现」批次把
 * `status` 改成 `ready` 并接上 `buildBaseSources` / 真实素材位 / endpoint 键——注册表与门禁
 * 无需改动。
 */
export const GENERATION_FAMILY_TEMPLATE_REGISTRY: Record<GenerationFamilyAdapterId, GenerationFamilyTemplateEntry> = {
  [OPENAI_IMAGE_V1_FAMILY_ADAPTER_ID]: {
    familyAdapterId: OPENAI_IMAGE_V1_FAMILY_ADAPTER_ID,
    status: 'ready',
    buildBaseSources: buildOpenAiImageV1BaseTemplateSources,
    supportsMediaSlots: OPENAI_IMAGE_V1_SUPPORTED_MEDIA_SLOTS,
    requiredMediaSlots: [],
    declaredEndpointKeys: ['generations', 'edits'],
  },
  'gemini-image-interactions-v1': {
    familyAdapterId: GEMINI_IMAGE_INTERACTIONS_V1_FAMILY_ADAPTER_ID,
    status: 'ready',
    buildBaseSources: buildGeminiImageInteractionsV1BaseTemplateSources,
    supportsMediaSlots: GEMINI_IMAGE_INTERACTIONS_V1_SUPPORTED_MEDIA_SLOTS,
    requiredMediaSlots: [],
    declaredEndpointKeys: ['interactions'],
  },
  'seedance-2-0-v1': {
    familyAdapterId: SEEDANCE_2_0_V1_FAMILY_ADAPTER_ID,
    status: 'ready',
    buildBaseSources: buildSeedance20V1BaseTemplateSources,
    supportsMediaSlots: SEEDANCE_2_0_V1_SUPPORTED_MEDIA_SLOTS,
    requiredMediaSlots: [],
    declaredEndpointKeys: ['tasks', 'taskById'],
  },
  'veo-v1': {
    familyAdapterId: VEO_V1_FAMILY_ADAPTER_ID,
    status: 'ready',
    buildBaseSources: buildVeoV1BaseTemplateSources,
    supportsMediaSlots: VEO_V1_SUPPORTED_MEDIA_SLOTS,
    requiredMediaSlots: [],
    declaredEndpointKeys: ['predictLongRunning', 'operation'],
  },
  'kling-text2video-v1': {
    familyAdapterId: KLING_TEXT2VIDEO_V1_FAMILY_ADAPTER_ID,
    status: 'ready',
    buildBaseSources: buildKlingText2VideoV1BaseTemplateSources,
    supportsMediaSlots: KLING_TEXT2VIDEO_V1_SUPPORTED_MEDIA_SLOTS,
    requiredMediaSlots: [],
    declaredEndpointKeys: ['textToVideo', 'taskById'],
  },
  'kling-image2video-v1': {
    familyAdapterId: KLING_IMAGE2VIDEO_V1_FAMILY_ADAPTER_ID,
    status: 'ready',
    buildBaseSources: buildKlingImage2VideoV1BaseTemplateSources,
    supportsMediaSlots: KLING_IMAGE2VIDEO_V1_SUPPORTED_MEDIA_SLOTS,
    requiredMediaSlots: ['first_frame'],
    declaredEndpointKeys: ['imageToVideo', 'taskById'],
  },
  'kling-omni-video-v1': {
    familyAdapterId: KLING_OMNI_VIDEO_V1_FAMILY_ADAPTER_ID,
    status: 'ready',
    buildBaseSources: buildKlingOmniVideoV1BaseTemplateSources,
    supportsMediaSlots: KLING_OMNI_VIDEO_V1_SUPPORTED_MEDIA_SLOTS,
    requiredMediaSlots: [],
    declaredEndpointKeys: ['omniVideo', 'taskById'],
  },
};

/**
 * 按 id 取注册条目；未知 id 返回 null（**只返回 null 给「不是已登记的接口类型」**）。
 *
 * 入参是路由路径里的任意字符串，先过契约 enum 收窄再查表：这样 `getFamilyTemplate('kling-v1')`
 * 这类已删掉的旧 id 与拼写错误都落到同一条「未知族」分支，不会因为下标访问拿到原型上的属性。
 */
export const getFamilyTemplate = (familyAdapterId: string): GenerationFamilyTemplateEntry | null => {
  const parsed = GenerationFamilyAdapterIdSchema.safeParse(familyAdapterId);
  if (!parsed.success) return null;
  return GENERATION_FAMILY_TEMPLATE_REGISTRY[parsed.data];
};

/** 族模板基础 sources 的构建结果（不含记录覆盖；保存期覆盖校验的基线）。 */
export type GenerationFamilyBaseTemplateSourcesResult =
  | { kind: 'ready'; familyAdapterId: GenerationFamilyAdapterId; sources: GenerationFamilyTemplateSources }
  | { kind: 'pending'; familyAdapterId: GenerationFamilyAdapterId }
  | { kind: 'unknown' };

/**
 * 构建族的**基础**模板（不应用记录覆盖）。
 *
 * 保存期的参数覆盖校验必须在未应用覆盖的模板上运行（设计 §3.3「校验唯一实现」）：以覆盖后的
 * 模板做基线会把用户的改动当既有事实，非法覆盖就有机会自证合法。
 */
export const buildFamilyTemplateBaseSources = (
  familyAdapterId: string,
  modelId: string,
  options: GenerationFamilyTemplateOptions,
): GenerationFamilyBaseTemplateSourcesResult => {
  const entry = getFamilyTemplate(familyAdapterId);
  if (entry === null) return { kind: 'unknown' };
  if (entry.status === 'pending') return { kind: 'pending', familyAdapterId: entry.familyAdapterId };
  return {
    kind: 'ready',
    familyAdapterId: entry.familyAdapterId,
    sources: entry.buildBaseSources(modelId, options),
  };
};

/** 族模板的合成结果：就绪族给出 sources；未就绪/未知族各自可区分（调用方必须显式处理）。 */
export type GenerationFamilyTemplateBuildResult =
  | { kind: 'ready'; familyAdapterId: GenerationFamilyAdapterId; sources: GenerationFamilyTemplateSources }
  | { kind: 'pending'; familyAdapterId: GenerationFamilyAdapterId }
  | { kind: 'unknown' };

/**
 * 族模板合成唯一入口（基础模板 × 记录参数覆盖 → 合成 sources）。
 *
 * 覆盖应用与校验的唯一实现在 generation-parameter-overrides.cts（设计 §3.3）；空覆盖快速路径
 * 原样返回基础模板（同一引用），保证无覆盖记录与模板基线完全一致（S8）。
 *
 * 未就绪族**不回落**到任何已实现族的模板：返回 `pending` 让调用方显式失败并留痕。回落会让
 * 用户以为模型可用，实际请求打到别的协议的端点上——这是本模块最需要避免的静默失败。
 */
export const buildFamilyTemplateSources = (
  familyAdapterId: string,
  modelId: string,
  options: GenerationFamilyTemplateOptions,
): GenerationFamilyTemplateBuildResult => {
  const entry = getFamilyTemplate(familyAdapterId);
  if (entry === null) return { kind: 'unknown' };
  if (entry.status === 'pending') return { kind: 'pending', familyAdapterId: entry.familyAdapterId };
  return {
    kind: 'ready',
    familyAdapterId: entry.familyAdapterId,
    sources: applyParameterOverrides(
      entry.buildBaseSources(modelId, options),
      options.parameterOverrides ?? EMPTY_PARAMETER_OVERRIDES,
    ),
  };
};

/** 族模板参数描述的读取结果：未知族（404）与未就绪族（501）必须可区分。 */
export type FamilyTemplateParameterDescriptorResult =
  | { kind: 'ready'; familyAdapterId: GenerationFamilyAdapterId; descriptor: FamilyTemplateParameterDescriptor }
  | { kind: 'pending'; familyAdapterId: GenerationFamilyAdapterId }
  | { kind: 'unknown' };

/**
 * 族模板参数描述（GET /api/generation-family-templates/:familyAdapterId 的数据构建）。
 *
 * 逐族分发：已就绪族优先用自己的专属描述构建器（openai 族在 openai-image 文件里、gemini
 * 族在 gemini-image 文件里、seedance 族在 seedance 文件里——它们需要把「声明可能接受素材位」
 * 那一支的 payload_rules 并入保留键），没有专属构建器的就地从基础模板（不带任何素材位）推导：
 * 素材位字段会被通用构建过滤掉，其余字段与保留键完全来自该族模板本身。未就绪族按 pending 返回。
 * 未知 id 返回 unknown——路由据此落 404，未就绪族落 501，两者不共用一条错误文案。
 */
const FAMILY_PARAMETER_DESCRIPTOR_BUILDERS: ReadonlyMap<
  GenerationFamilyAdapterId,
  () => FamilyTemplateParameterDescriptor
> = new Map([
  [OPENAI_IMAGE_V1_FAMILY_ADAPTER_ID, buildOpenAiImageV1ParameterDescriptor],
  [GEMINI_IMAGE_INTERACTIONS_V1_FAMILY_ADAPTER_ID, buildGeminiImageInteractionsV1ParameterDescriptor],
  [SEEDANCE_2_0_V1_FAMILY_ADAPTER_ID, buildSeedance20V1ParameterDescriptor],
  [VEO_V1_FAMILY_ADAPTER_ID, buildVeoV1ParameterDescriptor],
  [KLING_TEXT2VIDEO_V1_FAMILY_ADAPTER_ID, buildKlingText2VideoV1ParameterDescriptor],
  [KLING_IMAGE2VIDEO_V1_FAMILY_ADAPTER_ID, buildKlingImage2VideoV1ParameterDescriptor],
  [KLING_OMNI_VIDEO_V1_FAMILY_ADAPTER_ID, buildKlingOmniVideoV1ParameterDescriptor],
]);

export const buildFamilyTemplateParameterDescriptor = (
  familyAdapterId: string,
): FamilyTemplateParameterDescriptorResult => {
  const entry = getFamilyTemplate(familyAdapterId);
  if (entry === null) return { kind: 'unknown' };
  if (entry.status === 'pending') {
    loggingModule.logDebug('[generation-family-templates] parameter descriptor unavailable: family template pending', {
      familyAdapterId: entry.familyAdapterId,
      pendingReason: entry.pendingReason,
    });
    return { kind: 'pending', familyAdapterId: entry.familyAdapterId };
  }
  const dedicatedBuilder = FAMILY_PARAMETER_DESCRIPTOR_BUILDERS.get(entry.familyAdapterId);
  const descriptor =
    dedicatedBuilder !== undefined
      ? dedicatedBuilder()
      : buildFamilyTemplateParameterDescriptorFromSources({
          familyAdapterId: entry.familyAdapterId,
          baselineSources: entry.buildBaseSources('descriptor-baseline', { acceptedMediaSlots: [] }),
        });
  // 素材位能力只在这里填：各族描述构建器产出的 `supports_media_slots` / `required_media_slots`
  // 恒为空数组（它们不掌握族能力事实），注册表条目才是唯一来源。填在分发处而不是各构建器里，
  // 族数量增长时不会漏填；消费侧因此不需要各自维护一份「哪族支持哪些位 / 哪一点必选」。
  return {
    kind: 'ready',
    familyAdapterId: entry.familyAdapterId,
    descriptor: {
      ...descriptor,
      supports_media_slots: [...entry.supportsMediaSlots],
      required_media_slots: [...entry.requiredMediaSlots],
    },
  };
};

/** 素材位越界检查结果：ok = 全部落在该族模板可表达范围内。 */
export type FamilyMediaSlotSupportResult =
  | { kind: 'ok'; familyAdapterId: GenerationFamilyAdapterId; supportsMediaSlots: readonly GenerationMediaSlotId[] }
  /** 接口类型未登记（契约 enum 之外）：写入侧理论上不可达，按非法输入处理。 */
  | { kind: 'unknown_family' }
  /**
   * 该族模板表达不了这些素材位。`supportsMediaSlots` 为空数组时即「该族模板尚未就绪，
   * 一个素材位也表达不了」——调用方据此区分「这族不支持这一位」与「这族模板还没做」。
   */
  | {
      kind: 'unsupported';
      familyAdapterId: GenerationFamilyAdapterId;
      supportsMediaSlots: readonly GenerationMediaSlotId[];
      unsupportedMediaSlots: readonly GenerationMediaSlotId[];
    };

/**
 * 素材位 ↔ 族能力的一致性检查（写入侧守卫的唯一实现）。
 *
 * 批次 2 遗留风险：契约只保证素材位在受控词表内，不保证「这个族的模板能表达这个素材位」——
 * 于是可以给文生视频族勾上首帧图，记录写得进去、创作面也照勾选呈现，直到提交才失败。
 * 本函数把该判断收在注册表的能力事实上：记录的素材位必须是 `supportsMediaSlots` 的子集。
 */
export const checkFamilyMediaSlotSupport = (
  familyAdapterId: string,
  acceptedMediaSlots: readonly GenerationMediaSlotId[],
): FamilyMediaSlotSupportResult => {
  const entry = getFamilyTemplate(familyAdapterId);
  if (entry === null) return { kind: 'unknown_family' };
  const supported = new Set<string>(entry.supportsMediaSlots);
  const unsupportedMediaSlots = acceptedMediaSlots.filter((slot) => !supported.has(slot));
  if (unsupportedMediaSlots.length === 0) {
    return { kind: 'ok', familyAdapterId: entry.familyAdapterId, supportsMediaSlots: entry.supportsMediaSlots };
  }
  return {
    kind: 'unsupported',
    familyAdapterId: entry.familyAdapterId,
    supportsMediaSlots: entry.supportsMediaSlots,
    unsupportedMediaSlots,
  };
};

/**
 * 把记录的素材位清单收窄到该族模板能表达的范围内（投影侧的防御口径）。
 *
 * 写入侧守卫已经拒绝越界写入，但存量文件里的记录可能是在守卫落地前写的（批次 2 期间放行的
 * 数据）。投影侧不因越界而丢掉整条记录，而是按能力过滤并留痕——越界位在创作面不存在，
 * 其余能力照常可用。
 */
export const filterAcceptedMediaSlotsForFamily = (
  familyAdapterId: GenerationFamilyAdapterId,
  acceptedMediaSlots: readonly GenerationMediaSlotId[],
  modelId: string,
): readonly GenerationMediaSlotId[] => {
  const entry = GENERATION_FAMILY_TEMPLATE_REGISTRY[familyAdapterId];
  const supported = new Set<string>(entry.supportsMediaSlots);
  const filtered = acceptedMediaSlots.filter((slot) => supported.has(slot));
  if (filtered.length !== acceptedMediaSlots.length) {
    loggingModule.logDebug('[generation-family-templates] dropped media slots not expressible by the family template', {
      modelId,
      familyAdapterId,
      acceptedMediaSlots,
      supportedMediaSlots: entry.supportsMediaSlots,
    });
  }
  return filtered;
};

export { PENDING_REASON_TEMPLATE_NOT_IMPLEMENTED };
