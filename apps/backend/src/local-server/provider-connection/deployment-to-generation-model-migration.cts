import type { GenerationFamilyAdapterId, GenerationMediaSlotId } from '@iart/contracts';

/**
 * 存量 `ModelDeployment` → 用户生成模型记录的一次性换算表（spec 03 §11「升级约束：一次性换轨」）。
 *
 * **存在的唯一理由**：deployment 只携带 `model_id + connection_id + remote_model_id`，而记录还
 * 必须回答两件 deployment 当初没有回答的事——`family_adapter_id`（族）与 `accepted_media_slots`
 * （这个模型接受哪些素材）。这两件事在升级前的真实答案散落在「已装模型能力包的
 * `node_definition.input_ports` × `runtime_model.capability`」里，而包要在**同一个版本内**删除；
 * 迁移若去读包，就把「数据迁移」与「删包」绑成时序依赖（先删包则迁移失败、先迁移则包还在时
 * 无人验证）。因此把那一刻的能力静态冻结成表。
 *
 * **这是历史数据，不是运行时事实源**（最重要的一条，别让它的存在被误读成第二套能力判据）：
 * - 不进任何运行时路径：写入（添加/修改模型）与读取（目录投影、执行快照、快照构建）都不查它；
 *   族与素材位的运行时事实源仍是记录本身 + 族模板注册表。
 * - 只服务「把旧数据搬到新形状」这一次动作，搬完即与线上无关；族模板注册表日后演进也不回写
 *   本表——本表描述的是**升级前那一刻**分发的包，历史不会跟着改。
 * - 表里没有的 model_id 一律 `null`，**不得**回落到正则族、族上限或任何猜出来的默认值：升级
 *   不改变协议语义，猜出来的能力等于给用户换了个模型（PC-15）。
 *
 * **与封闭族正则的关系（整段已随换轨退场）**：升级前「这个 model_id 属于哪一族、由哪个适配器
 * 执行」由 `model-family-registry.cts` 的 7 条正则判定；该注册表已随部署载体一并删除，运行时不
 * 再按 `model_id` 名称或正则推断协议（spec 03 §8、§12）。本表因此是那段历史能力的**唯一留存
 * 载体**：`familyAdapterId` 逐条等于升级前正则解析到的那一族，「迁移补齐的族」=「升级前实际
 * 执行所用的适配器」。表已冻结，不随族模板或适配器注册表演进——它描述的是升级前那一刻分发的包。
 *
 * **素材位的来源与收窄**：每个条目按该模型升级前包的输入端口折算（`first_frame` / `last_frame` /
 * `reference_image` / `reference_video` / `reference_audio` / `feature_video` / `base_video`
 * 七位词表），再收窄到该族模板 `supportsMediaSlots` 能表达的范围内——超出族能力的位既不进
 * 记录（写入侧守卫会拒），也不会在创作面出现（投影侧会过滤），留着只会制造「记录说支持、
 * 界面看不到」的矛盾，还会让用户下次编辑该模型时撞上一个保存不了的记录（修改请求会按族
 * 能力校验素材位）。典型例：Veo 包的协议层能表达参考图，但该族上限当前只开放首尾帧，
 * 因此三个 Veo 型号都只迁出首尾帧。
 *
 * **为什么精确到型号而不是按族取上限**：条目描述的是「升级前分发的那些包各自声明了什么」，
 * 逐型号写才与 `packages.config` 那个时点的包一致，也不会与一个会演进的活注册表绑定——若某族
 * 日后放开新素材位，按族取上限的迁移会对同一批旧 deployment 产出不同记录（同一条数据在不同
 * 软件版本上升级出不同结果）。老实说：**今天**同族各型号折算后恰好一致，所以按族取上限此刻
 * 会得到相同结果；选逐型号表是为了把「历史」冻住，而不是因为今天两者有差。
 *
 * **本表不进 contracts**：它不是跨进程 DTO，只在 Runtime Backend 的迁移分支内被读一次
 * （判定准则见 AGENTS.md「契约层级判定准则」）。
 */

/** 一条换算结果：该 model_id 在升级前实际可用的族与素材位。 */
export type LegacyDeploymentModelCapability = {
  /** 升级前该 model_id 由哪个适配器执行（即那段历史的封家族正则解析结果，表已冻结）。 */
  familyAdapterId: GenerationFamilyAdapterId;
  /** 升级前该模型实际可用的素材位（已收窄到族模板能表达的范围，顺序即词表顺序）。 */
  acceptedMediaSlots: readonly GenerationMediaSlotId[];
};

const OPENAI_IMAGE_SLOTS = ['reference_image'] as const satisfies readonly GenerationMediaSlotId[];
const GEMINI_IMAGE_SLOTS = ['reference_image'] as const satisfies readonly GenerationMediaSlotId[];
const SEEDANCE_SLOTS = [
  'first_frame',
  'last_frame',
  'reference_image',
  'reference_video',
  'reference_audio',
] as const satisfies readonly GenerationMediaSlotId[];
const VEO_SLOTS = ['first_frame', 'last_frame'] as const satisfies readonly GenerationMediaSlotId[];
const KLING_IMAGE2VIDEO_SLOTS = ['first_frame', 'last_frame'] as const satisfies readonly GenerationMediaSlotId[];
const KLING_OMNI_SLOTS = [
  'first_frame',
  'last_frame',
  'reference_image',
  'feature_video',
  'base_video',
] as const satisfies readonly GenerationMediaSlotId[];
/** 文生视频一个素材位都没有（官方纯文本提交）。 */
const NO_MEDIA_SLOTS = [] as const satisfies readonly GenerationMediaSlotId[];

/**
 * `model_id → 升级前能力` 静态表（2026-10-19 换轨时点的 15 个有族 model_id）。
 *
 * 键必须**逐字等于**升级前分发的 `model_id`（它们同时也是用户 deployment 里的 `model_id`，
 * 迁移按它精确查找，不做前缀/正则派生）。清单与那时分发的模型包一一对应：
 * 无族的三类（TTS / seedream / qwen / zimage）本就不在可提交目录里，**故意不入表**——它们
 * 没有可迁移的族，转化它们的唯一办法是编一个族，那等于凭空给用户添一个模型。
 */
export const LEGACY_DEPLOYMENT_MODEL_CAPABILITIES: Readonly<
  Record<string, LegacyDeploymentModelCapability>
> = {
  // ---- openai-image-v1（gpt-image 系列，参考图多值）----
  'gpt-image-2': { familyAdapterId: 'openai-image-v1', acceptedMediaSlots: OPENAI_IMAGE_SLOTS },
  'gpt-image-2.5-flare': { familyAdapterId: 'openai-image-v1', acceptedMediaSlots: OPENAI_IMAGE_SLOTS },
  'gpt-image-2.5-sunburst': { familyAdapterId: 'openai-image-v1', acceptedMediaSlots: OPENAI_IMAGE_SLOTS },

  // ---- gemini-image-interactions-v1（参考图多值）----
  'gemini-3-pro-image': { familyAdapterId: 'gemini-image-interactions-v1', acceptedMediaSlots: GEMINI_IMAGE_SLOTS },
  'gemini-3.1-flash-image': { familyAdapterId: 'gemini-image-interactions-v1', acceptedMediaSlots: GEMINI_IMAGE_SLOTS },
  'gemini-3.1-flash-lite-image': { familyAdapterId: 'gemini-image-interactions-v1', acceptedMediaSlots: GEMINI_IMAGE_SLOTS },

  // ---- seedance-2-0-v1（三个型号五素材位齐全）----
  'doubao-seedance-2-0-260128': { familyAdapterId: 'seedance-2-0-v1', acceptedMediaSlots: SEEDANCE_SLOTS },
  'doubao-seedance-2-0-fast-260128': { familyAdapterId: 'seedance-2-0-v1', acceptedMediaSlots: SEEDANCE_SLOTS },
  'doubao-seedance-2-0-mini-260615': { familyAdapterId: 'seedance-2-0-v1', acceptedMediaSlots: SEEDANCE_SLOTS },

  // ---- veo-v1（三个型号都只开放首尾帧：包的参考图端口超出该族上限）----
  'veo-3.1-generate-preview': { familyAdapterId: 'veo-v1', acceptedMediaSlots: VEO_SLOTS },
  'veo-3.1-fast-generate-preview': { familyAdapterId: 'veo-v1', acceptedMediaSlots: VEO_SLOTS },
  'veo-3.1-lite-generate-preview': { familyAdapterId: 'veo-v1', acceptedMediaSlots: VEO_SLOTS },

  // ---- 可灵三端点各一族（文生零素材位 / 图生首尾帧 / 全模态五位）----
  'kling-v3-text2video': { familyAdapterId: 'kling-text2video-v1', acceptedMediaSlots: NO_MEDIA_SLOTS },
  'kling-v3-image2video': { familyAdapterId: 'kling-image2video-v1', acceptedMediaSlots: KLING_IMAGE2VIDEO_SLOTS },
  'kling-v3-omni-video': { familyAdapterId: 'kling-omni-video-v1', acceptedMediaSlots: KLING_OMNI_SLOTS },
};

/**
 * 按 `model_id` 取升级前能力；表里没有就返回 `null`（**不回落、不猜族**）。
 *
 * 用 `Object.prototype.hasOwnProperty` 而不是直接下标读：`model_id` 是外部输入（旧 JSON 文件），
 * `constructor` / `toString` 这类键会从原型链上取到函数，把非法输入变成一条假能力。
 */
export const resolveLegacyDeploymentModelCapability = (
  modelId: string,
): LegacyDeploymentModelCapability | null => {
  const id = typeof modelId === 'string' ? modelId.trim() : '';
  if (!id) return null;
  if (!Object.prototype.hasOwnProperty.call(LEGACY_DEPLOYMENT_MODEL_CAPABILITIES, id)) return null;
  return LEGACY_DEPLOYMENT_MODEL_CAPABILITIES[id] ?? null;
};
