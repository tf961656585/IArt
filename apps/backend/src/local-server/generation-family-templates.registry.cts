import {
  type FamilyTemplateParameterDescriptor,
  type GenerationMediaSlotId,
} from '@iart/contracts';
import * as loggingModule from './logging.cts';
import {
  collectMediaSlotOfficialFields,
  type GenerationFamilyTemplateBuilder,
  type GenerationFamilyTemplateOptions,
  type GenerationFamilyTemplateSources,
} from './generation-family-templates.cts';
import { composeInterfaceFormatSources } from './interface-format/compose.cts';
import {
  buildFormatParameterDescriptor,
  composeFormatSources,
  getInterfaceFormat,
  loadPresetFormats,
} from './interface-format/registry.cts';
import type { InterfaceFormat } from './interface-format/schema.cts';

/**
 * 生成族模板门面（**实体优先的唯一实现**，2026-10-26 切换）。
 *
 * 历史：本模块曾是「接口类型 → 一族一份 TypeScript 工厂」的静态注册表
 * （`generation-family-templates.<family>.cts`，8 个族文件）。本批把这些族的事实迁到
 * **接口格式实体注册表**（`interface-format/` 的随软件分发预设），本模块降级为**门面**：
 * 导出名与形状保持不变（既有消费方零改动），内部不再 import 任何族文件、也不再保留
 * 「实体优先、旧代码兜底」的双读路径——生产只有实体一条实现。旧族文件已于 2026-10-26 删除。
 *
 * 门面的职责只有「把实体的形状翻译回既有调用方期待的形状」：
 * - 注册条目：`familyAdapterId` / `status` / `supportsMediaSlots` / `requiredMediaSlots` /
 *   `mediaSlotFieldKeys` / `declaredEndpointKeys` 全部从预设派生（不手抄字面量，避免第二事实源）；
 * - 合成入口：委派 `composeFormatSources`（预设基础模板 → 素材位片段 → 参数覆盖 → 接口配方）；
 * - 描述符入口：委派 `buildFormatParameterDescriptor`，只补回描述符分发处统一的「素材位行 +
 *   格式能力字段」填充（实体层不填这两项：它服务于逐族等价矩阵，形状必须与族构建器一致）。
 *
 * 本模块是 Runtime Backend 内置资源：不进 contracts、不落任何安装目录。
 */

/**
 * 注册表条目的公共事实（就绪与否都要回答「支持哪些素材位」「用到哪些 endpoint 键」）。
 *
 * `familyAdapterId` 类型为 `string`：2026-10-26 起 id 值域由实体注册表裁定，
 * contracts 只约束形状（`InterfaceFormatIdSchema`），不再有封闭枚举类型可依赖。
 */
type GenerationFamilyTemplateEntryCommon = {
  familyAdapterId: string;
  /**
   * 该格式能表达的素材位（受控词表子集，值域 owner 是 contracts 的
   * `GENERATION_MEDIA_SLOT_IDS`）。写入侧守卫与创作面准入共用这一份。
   */
  supportsMediaSlots: readonly GenerationMediaSlotId[];
  /**
   * 该格式**协议强制必选**的素材位（必须是 `supportsMediaSlots` 的子集）。
   *
   * 与 `supportsMediaSlots` 的区别：后者是「这个格式能表达哪些位」（用户可选空间上限），前者是
   * 「每次提交都必须有哪一位」（用户没有选择空间）。两者都是格式能力事实，必须与预设同源。
   * 目前只有可灵图生视频格式有必选位：该端点每次提交都必须带首帧。
   */
  requiredMediaSlots: readonly GenerationMediaSlotId[];
  /**
   * 该格式「素材位 → 参数字段键」的完整映射（来自预设 `media.slots[*].field_key`）。
   *
   * 键集必须与该格式 `supportsMediaSlots` 完全一致（预设 schema 已钉住，测试再钉一次）：
   * 少一位说明能力事实漏登记，多一位说明登记了表达不了的位。`pending` 格式取空对象。
   */
  mediaSlotFieldKeys: Readonly<Partial<Record<GenerationMediaSlotId, string>>>;
  /**
   * 该格式用到的 endpoint 键（`transport.endpoints` 的键名，来自预设声明）。
   * 一致性门禁据此逐键核对模板内的实际 endpoint：模板不得引用未声明路径，
   * 声明的每个 endpoint 也必须在模板里真实出现。
   */
  declaredEndpointKeys: readonly string[];
};

/** 一个格式的注册条目：就绪（可构建）或未就绪（显式 pending）。 */
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

/** 参数描述符基线用的合成模型 id（与实体描述符构建器同值，描述符不含 model_id）。 */
const DESCRIPTOR_BASELINE_MODEL_ID = 'descriptor-baseline';

/** 素材位 → 字段键映射：直接取自预设，不手抄字面量（值与键都由预设声明）。 */
const buildMediaSlotFieldKeys = (
  format: InterfaceFormat,
): Readonly<Partial<Record<GenerationMediaSlotId, string>>> => {
  const fieldKeys: Partial<Record<GenerationMediaSlotId, string>> = {};
  for (const [slotId, slot] of Object.entries(format.media.slots)) {
    fieldKeys[slotId as GenerationMediaSlotId] = slot.field_key;
  }
  return fieldKeys;
};

/**
 * 预设 → 注册条目。
 *
 * `pending` 格式的能力事实**必须是空清单**：格式未就绪时它确实一个素材位也表达不了，
 * 允许写入非空清单就是把失败推迟到运行时。字段键集合同理取空。
 */
const buildRegistryEntry = (format: InterfaceFormat): GenerationFamilyTemplateEntry => {
  const common = {
    familyAdapterId: format.format_id,
    declaredEndpointKeys: Object.keys(format.transport.endpoints),
  };
  if (format.status === 'pending') {
    return {
      ...common,
      status: 'pending',
      pendingReason: PENDING_REASON_TEMPLATE_NOT_IMPLEMENTED,
      supportsMediaSlots: [],
      requiredMediaSlots: [],
      mediaSlotFieldKeys: {},
    };
  }
  return {
    ...common,
    status: 'ready',
    supportsMediaSlots: format.media.supports,
    requiredMediaSlots: format.media.required,
    mediaSlotFieldKeys: buildMediaSlotFieldKeys(format),
    // 基础模板 = 格式基础 sources（**不应用**记录覆盖与配方）；覆盖与配方由合成入口统一应用。
    buildBaseSources: (modelId, options) =>
      composeInterfaceFormatSources({
        format,
        modelId,
        acceptedMediaSlots: options.acceptedMediaSlots,
      }),
  };
};

const buildRegistry = (): Readonly<Record<string, GenerationFamilyTemplateEntry>> => {
  const registry: Record<string, GenerationFamilyTemplateEntry> = {};
  for (const format of loadPresetFormats()) {
    registry[format.format_id] = buildRegistryEntry(format);
  }
  return registry;
};

/**
 * 格式注册表（键 = 预设 `format_id`，值 = 该格式的能力事实与基础构建器）。
 *
 * 键集来自 `loadPresetFormats()`（manifest + 预设 JSON 是唯一事实源），不是手写清单：
 * 新增格式只改预设与 manifest，本表自动跟随；某条预设加载失败会被 `loadPresetFormats`
 * 丢弃并留痕，这里也不会凭空多出一条。
 *
 * **本表只是预设快照**：用户自建格式在运行时由 `getFamilyTemplate` 动态补齐（见该函数），
 * 因此本表恒为 8 条预设，不随用户库增删变化——测试与一致性检查以此为基准。
 */
export const GENERATION_FAMILY_TEMPLATE_REGISTRY: Readonly<
  Record<string, GenerationFamilyTemplateEntry>
> = buildRegistry();

/**
 * 按 id 取注册条目；未知 id 返回 null。
 *
 * 入参是路由路径里的任意字符串：直接查实体注册表（不过任何枚举收窄），
 * `getFamilyTemplate('kling-v1')` 这类已删掉的旧 id 与拼写错误都落到同一条「未知格式」分支。
 *
 * 查找顺序：预设快照 → 用户库（`getInterfaceFormat` 走 `loadAllFormats()`）。用户格式不预建
 * 条目：它可以在运行时创建/删除，静态快照会在第一次增删后变成假话。用户格式条目按需构建
 * （一次对象分配，无缓存），能力事实始终与用户库一致。
 */
export const getFamilyTemplate = (familyAdapterId: string): GenerationFamilyTemplateEntry | null => {
  if (Object.prototype.hasOwnProperty.call(GENERATION_FAMILY_TEMPLATE_REGISTRY, familyAdapterId)) {
    return GENERATION_FAMILY_TEMPLATE_REGISTRY[familyAdapterId] ?? null;
  }
  const lookup = getInterfaceFormat(familyAdapterId);
  if (lookup.kind !== 'ready') return null;
  return buildRegistryEntry(lookup.format);
};

/**
 * 按 id 取条目，未登记即抛（**测试与内部一致性检查用**）。
 *
 * 这些调用点的 id 来自预置清单或注册表自身的键集，缺失属于「清单与注册表漂移」的缺陷，
 * 应当立刻失败而不是静默跳过；生产消费方一律用 `getFamilyTemplate` 显式处理 null。
 */
export const requireFamilyTemplate = (familyAdapterId: string): GenerationFamilyTemplateEntry => {
  const entry = getFamilyTemplate(familyAdapterId);
  if (entry === null) {
    throw new Error(`generation_family_template_unknown: ${familyAdapterId}`);
  }
  return entry;
};

/**
 * 把记录声明的素材位收窄到该格式能表达的范围（**静默过滤 + debug 留痕**）。
 *
 * 合成入口用它吸收越界位：写入侧守卫已拒绝越界写入，这里兜的是守卫落地前的存量记录。
 * 越界位不阻断整条记录的合成（旧实现同样是「忽略表达不了的位」），但必须留痕，
 * 否则「某个素材位怎么都不生效」会变成只能人工追函数的谜题。
 */
const filterSlotsForEntry = (
  entry: GenerationFamilyTemplateEntryCommon,
  acceptedMediaSlots: readonly GenerationMediaSlotId[],
  modelId: string,
): readonly GenerationMediaSlotId[] => {
  const supported = new Set<string>(entry.supportsMediaSlots);
  const dropped = acceptedMediaSlots.filter((slotId) => !supported.has(slotId));
  if (dropped.length === 0) return acceptedMediaSlots;
  loggingModule.logDebug(
    '[generation-family-templates] dropped media slots the interface format cannot express',
    {
      modelId,
      familyAdapterId: entry.familyAdapterId,
      acceptedMediaSlots,
      droppedMediaSlots: dropped,
      supportsMediaSlots: entry.supportsMediaSlots,
    },
  );
  return acceptedMediaSlots.filter((slotId) => supported.has(slotId));
};

/** 格式基础 sources 的构建结果（不含记录覆盖；保存期覆盖校验的基线）。 */
export type GenerationFamilyBaseTemplateSourcesResult =
  | { kind: 'ready'; familyAdapterId: string; sources: GenerationFamilyTemplateSources }
  | { kind: 'pending'; familyAdapterId: string }
  | { kind: 'unknown' };

/**
 * 构建格式的**基础**模板（不应用记录覆盖与配方）。
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
    sources: entry.buildBaseSources(modelId, {
      acceptedMediaSlots: filterSlotsForEntry(entry, options.acceptedMediaSlots, modelId),
    }),
  };
};

/** 格式模板的合成结果：就绪给出 sources；未就绪/未知各自可区分（调用方必须显式处理）。 */
export type GenerationFamilyTemplateBuildResult =
  | { kind: 'ready'; familyAdapterId: string; sources: GenerationFamilyTemplateSources }
  | { kind: 'pending'; familyAdapterId: string }
  | { kind: 'unknown' };

/**
 * 格式模板合成唯一入口（格式基础模板 × 记录参数覆盖 × 接口配方 → 合成 sources）。
 *
 * 委派实体层的 `composeFormatSources`：覆盖应用与校验的唯一实现仍在
 * generation-parameter-overrides.cts，配方应用在 interface-recipe-apply.cts，
 * 本门面不重复实现任何一步。未就绪格式**不回落**到任何已就绪格式，返回 `pending`
 * 让调用方显式失败并留痕。
 */
export const buildFamilyTemplateSources = (
  familyAdapterId: string,
  modelId: string,
  options: GenerationFamilyTemplateOptions,
): GenerationFamilyTemplateBuildResult => {
  const entry = getFamilyTemplate(familyAdapterId);
  if (entry === null) return { kind: 'unknown' };
  if (entry.status === 'pending') return { kind: 'pending', familyAdapterId: entry.familyAdapterId };
  // 素材位先按能力收窄再合成：实体层对越界位是显式拒绝（unsupported_media_slots），
  // 而门面的既有语义是「忽略表达不了的位并留痕」，两者在这里对齐。
  const acceptedMediaSlots = filterSlotsForEntry(entry, options.acceptedMediaSlots, modelId);
  const composed = composeFormatSources(entry.familyAdapterId, modelId, {
    acceptedMediaSlots,
    ...(options.parameterOverrides === undefined
      ? {}
      : { parameterOverrides: options.parameterOverrides }),
    ...(options.recipe === undefined ? {} : { recipe: options.recipe }),
  });
  if (composed.kind === 'ready') {
    return { kind: 'ready', familyAdapterId: entry.familyAdapterId, sources: composed.sources };
  }
  // 同一份注册表刚刚命中过该 id，因此这里只可能是「合成期拒绝」（理论不可达）。
  // 不回落任何其它格式，按显式失败处理并留痕。
  loggingModule.logDebug(
    '[generation-family-templates] interface format compose did not produce sources',
    { modelId, familyAdapterId: entry.familyAdapterId, resultKind: composed.kind },
  );
  return composed.kind === 'pending'
    ? { kind: 'pending', familyAdapterId: entry.familyAdapterId }
    : { kind: 'unknown' };
};

/** 格式参数描述的读取结果：未知格式（404）与未就绪格式（501）必须可区分。 */
export type FamilyTemplateParameterDescriptorResult =
  | { kind: 'ready'; familyAdapterId: string; descriptor: FamilyTemplateParameterDescriptor }
  | { kind: 'pending'; familyAdapterId: string }
  | { kind: 'unknown' };

/**
 * 格式参数描述（GET /api/generation-family-templates/:familyAdapterId 的数据构建）。
 *
 * 委派实体层的 `buildFormatParameterDescriptor`（字段、保留键、文案解析口径只有一份实现）。
 * 实体层产出的描述符**不含**素材位行与格式能力字段（它的形状要与逐族构建器一致：两者都是
 * 「不接受任何素材位」的基线）；这两项历来由本分发处统一补填，避免各格式各自声明一份：
 * - 素材位行从「该格式全部素材位同时接受」的 sources 上取，反向映射用条目的
 *   `mediaSlotFieldKeys`（唯一出口）；
 * - `supports_media_slots` / `required_media_slots` 取条目的能力事实。
 * 这里给的是**格式能力全量**，不是某条记录的勾选结果；消费端按当前勾选清单过滤后渲染。
 */
export const buildFamilyTemplateParameterDescriptor = (
  familyAdapterId: string,
): FamilyTemplateParameterDescriptorResult => {
  const entry = getFamilyTemplate(familyAdapterId);
  if (entry === null) return { kind: 'unknown' };
  if (entry.status === 'pending') {
    loggingModule.logDebug(
      '[generation-family-templates] parameter descriptor unavailable: interface format pending',
      { familyAdapterId: entry.familyAdapterId, pendingReason: entry.pendingReason },
    );
    return { kind: 'pending', familyAdapterId: entry.familyAdapterId };
  }
  const result = buildFormatParameterDescriptor(entry.familyAdapterId);
  if (result.kind !== 'ready') {
    loggingModule.logDebug(
      '[generation-family-templates] parameter descriptor unavailable: interface format not ready',
      { familyAdapterId: entry.familyAdapterId, resultKind: result.kind },
    );
    return result.kind === 'pending'
      ? { kind: 'pending', familyAdapterId: entry.familyAdapterId }
      : { kind: 'unknown' };
  }
  const mediaSlotFields = collectMediaSlotOfficialFields(
    entry.buildBaseSources(DESCRIPTOR_BASELINE_MODEL_ID, {
      acceptedMediaSlots: entry.supportsMediaSlots,
    }),
    entry.mediaSlotFieldKeys,
  );
  return {
    kind: 'ready',
    familyAdapterId: entry.familyAdapterId,
    descriptor: {
      ...result.descriptor,
      official_fields: [...mediaSlotFields, ...result.descriptor.official_fields],
      supports_media_slots: [...entry.supportsMediaSlots],
      required_media_slots: [...entry.requiredMediaSlots],
    },
  };
};

/** 素材位越界检查结果：ok = 全部落在该格式能表达范围内。 */
export type FamilyMediaSlotSupportResult =
  | { kind: 'ok'; familyAdapterId: string; supportsMediaSlots: readonly GenerationMediaSlotId[] }
  /** 格式未登记（实体注册表里不存在）：写入侧理论上不可达，按非法输入处理。 */
  | { kind: 'unknown_family' }
  /**
   * 该格式表达不了这些素材位。`supportsMediaSlots` 为空数组时即「该格式尚未就绪，
   * 一个素材位也表达不了」——调用方据此区分「这格式不支持这一位」与「这格式还没做」。
   */
  | {
      kind: 'unsupported';
      familyAdapterId: string;
      supportsMediaSlots: readonly GenerationMediaSlotId[];
      unsupportedMediaSlots: readonly GenerationMediaSlotId[];
    };

/**
 * 素材位 ↔ 格式能力的一致性检查（写入侧守卫的唯一实现）。
 *
 * 契约只保证素材位在受控词表内，不保证「这个格式能表达这个素材位」——于是可以给文生视频
 * 格式勾上首帧图：记录写得进去、创作面也照勾选呈现，直到提交才失败。本函数把该判断收在
 * 格式的能力事实上：记录的素材位必须是 `supportsMediaSlots` 的子集。
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
 * 把记录的素材位清单收窄到该格式能表达的范围内（投影侧的防御口径）。
 *
 * 写入侧守卫已经拒绝越界写入，但存量文件里的记录可能是在守卫落地前写的。投影侧不因越界而
 * 丢掉整条记录，而是按能力过滤并留痕——越界位在创作面不存在，其余能力照常可用。
 * 未登记格式返回空清单（该记录本身也进不了目录，见 model-catalog-entry 的准入判据）。
 */
export const filterAcceptedMediaSlotsForFamily = (
  familyAdapterId: string,
  acceptedMediaSlots: readonly GenerationMediaSlotId[],
  modelId: string,
): readonly GenerationMediaSlotId[] => {
  const entry = getFamilyTemplate(familyAdapterId);
  if (entry === null) {
    loggingModule.logDebug(
      '[generation-family-templates] media slots dropped: interface format not registered',
      { modelId, familyAdapterId, acceptedMediaSlots },
    );
    return [];
  }
  return filterSlotsForEntry(entry, acceptedMediaSlots, modelId);
};

export { PENDING_REASON_TEMPLATE_NOT_IMPLEMENTED };
