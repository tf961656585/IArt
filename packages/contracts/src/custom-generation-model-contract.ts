import * as z from 'zod';

import { CUSTOM_CHAT_MODEL_ID_PATTERN } from './custom-chat-model-contract';
import { InterfaceRecipeIdSchema } from './interface-recipe-contract';
import {
  InterfaceFormatJsonValueSchema,
  InterfaceFormatModelBindingSchema,
  InterfaceFormatNameValueSchema,
  InterfaceFormatPromptBindingSchema,
} from './interface-format-binding';

/**
 * 用户自建生成模型契约（spec 03 §6.1「模型记录的单一载体」；2026-09-25 起记录为
 * 服务商作用域单实体，2026-10-19 起为模型唯一来源）。
 *
 * 生成模型的**唯一来源**是用户在主窗口自建的生成模型记录（本文件；2026-10-19 拍板：软件只
 * 提供请求接口协议、不内置任何具体模型）。形态对齐对话侧先例
 * `custom-chat-model-contract.ts`（spec 37）：自 2026-09-25 起「声明 + 接入」两层合并为
 * 单记录，一条记录同时承载能力属性与接入归属（`connection_id` + `remote_model_id`），用户
 * 在服务商详情内一次写入完成添加；与该族模板在 Runtime Backend 内合成为内存态投影，进入
 * 目录投影管线。模型不复用到另一条连接；需要同一模型接另一条连接时，在那条连接下再添加
 * 一条记录。
 *
 * 自建生成模型的边界（spec 03 §3.2 与试点设计禁止项，不要在本文件之外放宽）：
 * - **必须归属一条连接**：记录内嵌 `connection_id`；删除连接即级联删除其下全部自建记录，
 *   不存在无归属的自建模型。
 * - **自带协议（2026-09-26 起，协议归属模型级）**：`family_adapter_id` 是该记录的协议/族
 *   归属声明，指向 Runtime Backend 内置的一个**接口格式**（2026-10-26 起由接口格式实体
 *   注册表裁定，`GENERATION_FAMILY_ADAPTER_IDS` 退化为预设清单快照）；一条连接可承载任意
 *   协议族的模型。记录不得声明、覆盖或默认 endpoint / base URL / 凭证 / 服务商（这些仍由
 *   归属连接承载）；执行语义由该接口格式决定。
 * - **参数表单与请求规则来自族模板**：request_strategy / api_defaults / parameter_schema /
 *   prompt_field 均由 Runtime Backend 内置的族模板承载（每族一份，与 `ProtocolAdapter`
 *   一一对应），不在本契约。参数覆盖是记录上的受控例外（docs/custom-providers/生成模型参数高级自定义-design.md
 *   §3.2，修订试点 C1/D5）：官方参数的启用/别名/枚举/预设/默认值覆盖与新增自定义参数；
 *   覆盖随该记录存储、不跨连接共享；协议字段、endpoint、鉴权、轮询/结果语义仍禁覆盖。
 * - `model_id` 是身份与唯一显示名（`AGENTS.md`「Model ID 唯一性与显示规则」），全局唯一：
 *   不得与对话侧自建记录重名，也不得占用任何已登记模型的标识；命中其他族正则的写入由
 *   Runtime Backend 拒绝（试点设计 §3.5 命名空间护栏）。本契约不承载别名字段——别名是
 *   包时代的兼容产物，`model_id` 已是唯一显示名。
 *
 * 本文件只承载跨边界 DTO；存储（config/custom-generation-models.json）、目录投影、执行链、
 * 存量迁移与级联清理由 Runtime Backend 承担。
 */

/**
 * 自建生成模型 `model_id` 的字符集与对话侧完全一致。
 *
 * 两个域的身份都全局唯一、都会进日志与 URL 路径（删除路由），字符集规则必须一致，
 * 因此直接复用对话侧常量（单一事实源，禁止在本域另写一份正则造成漂移）。
 */
export const CustomGenerationModelIdSchema = z.string().regex(CUSTOM_CHAT_MODEL_ID_PATTERN);

/**
 * 内置接口格式 id 的**预设清单快照**（不是记录值域，也不再是运行时校验域）。
 *
 * **顺序即界面下拉展示顺序**：同一服务商下添加模型时，用户先在这里选「接口类型」，
 * 再由接口格式给出该接口的参数表单与请求规则。可灵按官方三个提交端点拆成三个接口类型
 * （端点即模型身份：文生视频 / 图生视频 / 全模态视频三者的请求体字段并不通用）。
 *
 * 2026-10-26 起：生成族运行时已从「代码族模板注册表」切到**接口格式实体注册表**
 * （Runtime Backend 的 `interface-format/` 预设），本常量退化为一份快照，只服务两件事：
 * ① 本批 Hub 下拉选项（下一批改走接口格式列表 API）；② 测试枚举内置 8 条。
 * **记录写入的合法性由实体注册表裁定**（`family_adapter_id` 必须命中所分发预设且为 ready），
 * 因此不得再把本常量当作 schema 值域使用——预设增删时这里不跟着改也不会「静默放行非法值」，
 * 只会让下拉少一项。
 */
export const GENERATION_FAMILY_ADAPTER_IDS = [
  'openai-image-v1',
  'openai-video-v1',
  'gemini-image-interactions-v1',
  'seedance-2-0-v1',
  'veo-v1',
  'kling-text2video-v1',
  'kling-image2video-v1',
  'kling-omni-video-v1',
] as const;

/** 预设清单快照的成员类型（仅供快照自身的类型收窄；记录字段用 `InterfaceFormatId`）。 */
export type GenerationFamilyAdapterId = (typeof GENERATION_FAMILY_ADAPTER_IDS)[number];

/**
 * 接口格式 id 的值域（生成模型记录 `family_adapter_id` 的**唯一** schema 事实源）。
 *
 * 记录里出现哪个 id 是**运行时事实**，由实体注册表（随软件分发的接口格式预设）裁定；
 * 本 schema 只约束形状：小写字母/数字开头，后续允许 `.` `_` `-`，最长 96。
 * 字符集与实体 schema 的 `format_id` 一致（id 会进预设文件、manifest、URL 段与投影命名空间）。
 *
 * 为什么不在这里写成封闭枚举：预设增删属于软件内置资源变化，契约若写死枚举，
 * 每加/删一个格式都要改 contracts 并连带重编下游，而运行时还需再查一次注册表——
 * 两处值域必然漂移。唯一判据放到实体注册表，「未知 / 未就绪」在写入侧给可读拒绝。
 */
export const InterfaceFormatIdSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);

export type InterfaceFormatId = z.infer<typeof InterfaceFormatIdSchema>;

/**
 * 生成模型可接受的**素材位**（受控词表，2026-10-19 拍板）。
 *
 * 各协议族实际开放的素材位不同：Seedance 2.0 有首帧/尾帧/参考图/参考视频/参考音频，
 * Veo 只有首帧与尾帧，可灵文生视频一个都没有、可灵全模态视频有五个。用户添加模型时逐项
 * 勾选该模型接受哪些素材，创作面只呈现勾选的素材位——避免「能选但一提交就失败」。
 *
 * 词表是封闭集合：新增素材位只能在这里加，记录侧与族模板侧共享同一份值域，不得另立
 * 并行的能力字段。中文注释是对用户可见含义的唯一说明（界面文案由 Hub 维护）。
 */
export const GENERATION_MEDIA_SLOT_IDS = [
  'reference_image', // 参考图（多）
  'first_frame', // 首帧（1）
  'last_frame', // 尾帧（1）
  'reference_video', // 参考视频（多）
  'reference_audio', // 参考音频（多）
  'feature_video', // 特征视频（1）
  'base_video', // 基础视频（1）
] as const;

export const GenerationMediaSlotIdSchema = z.enum(GENERATION_MEDIA_SLOT_IDS);

export type GenerationMediaSlotId = z.infer<typeof GenerationMediaSlotIdSchema>;

/**
 * 参数发出键名（wire name）的**请求体命名空间**字符集（生成模型参数高级自定义设计 §3.5）。
 *
 * 2026-10-27 起发出键名可以落到查询参数 / 请求头（字符集更宽，见 interface-format-binding），
 * 本常量只约束**新增自定义参数**（`CustomParameterFieldSchema`，仍只发请求体）；官方参数的
 * 别名覆盖放宽为通用字符串，按位置的合法性由 Runtime Backend 校验器用
 * `interface-format-binding.ts` 的判定函数裁决。「与模板已占用键、系统注入键查重」同属该校验器。
 */
export const GENERATION_WIRE_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * 参数覆盖值与默认值的统一值域。
 *
 * 参数面只承载这三种标量（数组/对象形态的参数不开放覆盖）；`null` 不在值域内——
 * 「清掉默认值」用省略字段表达，不引入第三态。
 */
export const ParameterOverridesValueSchema = z.union([z.string(), z.number(), z.boolean()]);

export type ParameterOverridesValue = z.infer<typeof ParameterOverridesValueSchema>;

/**
 * 对官方模板已有参数的一条覆盖，按 `field_key` 索引。
 *
 * 除 `field_key` 外全部可选：每条覆盖只表达「用户改了什么」，未提及的维度保持模板原样。
 * 各维度的适用性（select 类才接受 enum_options、imageSize 类才接受预设子集、素材位字段只接受
 * `wire_name` 与 `media_max_files`）与「field_key 必须命中模板已声明字段」都是运行期语义校验，
 * 由 Runtime Backend 保存/投影共用的校验器唯一实现（设计 §3.3/§3.5），schema 层只管形状。
 */
export const OfficialParameterOverrideSchema = z
  .object({
    /**
     * 族模板已声明字段的内部标识。
     *
     * 素材位字段**可覆盖，但只开放两个维度**：`wire_name`（服务商的字段名）与
     * `media_max_files`（最多几张）。启用与否不在此处——归属由记录上的
     * `accepted_media_slots` 管控；枚举/预设/默认值对素材位不适用。越界维度由 backend
     * 校验器拒绝并给可读原因，不在 schema 上写成 refine（历史文件一条不一致会被整条丢弃）。
     */
    field_key: z.string().min(1),
    /** `false` = 整体禁用：从面板、default_values 与 payload_rules 一并移除（合成规则第 1 步）。 */
    enabled: z.boolean().optional(),
    /**
     * 别名：改写该字段所有 payload_rule target 的发出键名（合成规则第 2 步）。
     *
     * 键名可以落到请求体 / 查询参数 / 请求头三个命名空间（2026-10-27 起），字符集因此按位置
     * 而不同（请求头允许大写与短横线、查询参数允许方括号），这里只约束长度与非空；
     * 按位置的合法性由 backend 校验器（`interface-format-binding.ts` 的判定函数）裁定。
     */
    wire_name: z.string().trim().min(1).max(120).optional(),
    /** 枚举替换/收窄（仅 select 类字段合法；替换后非空、默认值落在新合法集内由 backend 校验）。 */
    enum_options: z.array(ParameterOverridesValueSchema).optional(),
    /** 画幅分辨率预设显隐子集（仅 imageSize 类字段合法；空数组 = 全部隐藏）。 */
    resolution_preset_keys: z.array(z.string()).optional(),
    /** 比例预设显隐子集（仅 imageSize 类字段合法；空数组 = 全部隐藏）。 */
    aspect_preset_keys: z.array(z.string()).optional(),
    /** 默认值覆盖，必须落在替换后的合法集内（backend 校验）。 */
    default_value: ParameterOverridesValueSchema.optional(),
    /**
     * 素材位最多可放几张（**仅素材位字段合法**，backend 校验）。
     *
     * 只约束正整数，**产品侧不设上限**：真实上限由该服务商的接口决定，超限由上游拒绝，
     * 作为普通生成失败呈现。软件预先收紧会造出「服务端明明支持 9 张，界面却只让传 3 张」
     * 的死路，且每接一家服务商都要改一次常量。
     *
     * 该维度只影响表达面（表单可附件数、画布输入端口可连数），不改变族模板声明的载体与
     * 请求规则——`null`/缺省等于沿用族模板默认张数。
     */
    media_max_files: z.number().int().min(1).optional(),
  })
  .strict();

export type OfficialParameterOverride = z.infer<typeof OfficialParameterOverrideSchema>;

/**
 * 一条用户新增的自定义参数（服务商私有参数，合成规则第 4 步 append 到结果末尾）。
 *
 * 不设 `field_key` 字段：自定义参数在合成期直接以 `wire_name` 兼任内部标识（面板键、
 * default_values 键与 payload_rule 引用共用它），无需第二个名字。设计文档 §3.2 写有独立的
 * `field_key`，实现按此收敛（语义等价，由设计回写对齐）。
 *
 * 「`value_type='enum'` 时 `enum_options` 必填非空」是跨字段不变量，按仓库纪律不写成 schema
 * refine——历史文件里一条不一致会让整条记录在读取时被静默丢弃；由 Runtime Backend 校验器
 * 在保存/投影时拒绝并给可读原因。
 */
export const CustomParameterFieldSchema = z
  .object({
    /** 面板显示名。 */
    label: z.string().min(1),
    /** 发出键名；合成期同时作为该参数的内部标识（见上）。 */
    wire_name: z.string().regex(GENERATION_WIRE_NAME_PATTERN),
    /** 控件与值形态：enum → select、boolean → 开关、number → 数字输入、string → 文本输入。 */
    value_type: z.enum(['string', 'number', 'boolean', 'enum']),
    /** 枚举值列表；`value_type='enum'` 时必填非空（backend 校验，见上）。 */
    enum_options: z.array(ParameterOverridesValueSchema).optional(),
    /** 默认值；有默认值则恒随请求发送，未设则空值不发。 */
    default_value: ParameterOverridesValueSchema.optional(),
    /** `true` 时面板强制填写。给默认值是必需的：`.strict()` 读取缺键的历史文件会直接失败。 */
    required: z.boolean().default(false),
  })
  .strict();

export type CustomParameterField = z.infer<typeof CustomParameterFieldSchema>;

/**
 * 声明上的参数覆盖段：官方参数覆盖 + 自定义私有参数两个分区。
 *
 * 两个数组都给默认值：外层 `parameter_overrides` 的 `.default(空覆盖)` 物化的是本 schema
 * 的整体缺省；用户显式携带 `parameter_overrides` 但只写其中一个分区时，另一分区也要物化
 * 为空数组，不能让下游读出 undefined。
 */
export const ParameterOverridesSchema = z
  .object({
    official: z.array(OfficialParameterOverrideSchema).default([]),
    custom: z.array(CustomParameterFieldSchema).default([]),
  })
  .strict();

export type ParameterOverrides = z.infer<typeof ParameterOverridesSchema>;

export const CustomGenerationModelSchema = z
  .object({
    model_id: CustomGenerationModelIdSchema,
    /**
     * 接入记录 id（`up_dep_` 前缀）。active route 与 ExecutionSnapshot 的 `deployment_id`
     * 字段引用本 id；存量迁移时继承升级前那条接入的 id，既有 active-routes 数据因此零改动。
     * 由 Runtime Backend 生成，请求体不携带。
     */
    record_id: z.string().regex(/^up_dep_[a-z0-9][a-z0-9-_]*$/),
    /**
     * 该记录归属的服务商连接（spec 03 §6.1）。创建时必填，且必须指向存在、启用、有凭证的
     * 连接（校验由 Runtime Backend 写入侧执行；连接不再约束协议族，协议由记录自带的
     * `family_adapter_id` 声明）；归属不可变——换连接等于删除后在新连接下重建。
     */
    connection_id: z.string().min(1),
    /**
     * 服务商那边的模型名。创建请求体可省略（缺省回落 `model_id`），记录本体恒有值。
     */
    remote_model_id: z.string().min(1),
    /**
     * 该模型所属协议族／接口类型，2026-09-26 起即该记录的协议声明（协议归属模型级）。
     *
     * 值域是**接口格式实体注册表里已就绪的格式 id**（Runtime Backend 随软件分发的预设）；
     * 本契约只约束 id 形状（`InterfaceFormatIdSchema`），「这个 id 是否存在且就绪」由写入侧
     * 查实体注册表裁定并给可读拒绝。创建后不可变——换族等于换一个模型，走删除后重建。
     * 执行语义由该接口格式决定：endpoint、请求规则与参数表单全部来自它，记录侧不得改写；
     * 与归属连接无关——连接只承载地址与凭证。
     */
    family_adapter_id: InterfaceFormatIdSchema,
    /**
     * 该模型接受的素材位清单（输入模态是模型属性，进记录——试点设计 C4，2026-10-19 放宽为
     * 受控素材位词表）。
     *
     * 词表见 `GENERATION_MEDIA_SLOT_IDS`：各族实际开放的素材位不同（Seedance 2.0 五个、
     * Veo 两个、可灵文生视频零个），用户添加模型时逐项勾选，创作面只呈现勾选的素材位。
     * 数组顺序不承载语义（不入业务判定），按用户勾选顺序原样保存，便于回填时保持勾选形态。
     *
     * 给默认值是必需的：本 schema 是 `.strict()`，读取缺字段的历史文件会直接失败。
     * 文生是基线能力恒有，缺省即「不接受任何素材」。
     */
    accepted_media_slots: z.array(GenerationMediaSlotIdSchema).default([]),
    /**
     * 参数覆盖（生成模型参数高级自定义设计 §3.2）：官方参数的启用/别名/枚举/预设/默认值
     * 覆盖与新增自定义参数。族模板仍是参数唯一来源，覆盖只是记录上的可选数据段，
     * 随该记录存储、不跨连接共享。
     *
     * 给默认值是必需的：本 schema 是 `.strict()`，读取缺该键的历史配置文件会整条解析失败
     * （等于数据丢失）。缺省物化为空覆盖，空覆盖与「无覆盖」行为完全一致。
     */
    parameter_overrides: ParameterOverridesSchema.default({ official: [], custom: [] }),
    /**
     * 引用的接口配方（`docs/custom-providers/接口配方-design.md`）。
     *
     * 缺省 = 使用该族模板的内置默认判定与结果形态（行为与引入配方前完全一致）。
     * 配方承载「怎么算成功/失败、产物以什么形式返回」；不承载 endpoint、请求方法与鉴权形态。
     * 引用时必须与该记录的 `family_adapter_id` 一致（写入侧校验）。
     *
     * 该键可缺省（不设 `.default`）：`.strict()` schema 对缺失的可选键照常解析，存量
     * 配置文件零迁移。
     */
    recipe_id: InterfaceRecipeIdSchema.optional(),
    created_at: z.string(),
  })
  .strict();

export type CustomGenerationModel = z.infer<typeof CustomGenerationModelSchema>;

// ---------------------------------------------------------------------------
// 跨边界 DTO（GET / POST /api/custom-generation-models、PUT/DELETE /api/custom-generation-models/:modelId）
// 形状对齐对话侧先例 custom-chat-model-contract.ts；本文件是这些 DTO 的唯一 owner。
// ---------------------------------------------------------------------------

export const CustomGenerationModelListResponseSchema = z
  .object({ models: z.array(CustomGenerationModelSchema) })
  .strict();

export type CustomGenerationModelListResponse = z.infer<typeof CustomGenerationModelListResponseSchema>;

export const CustomGenerationModelResponseSchema = z
  .object({ model: CustomGenerationModelSchema })
  .strict();

export type CustomGenerationModelResponse = z.infer<typeof CustomGenerationModelResponseSchema>;

/**
 * 添加自建生成模型请求体（服务商详情内一次写入：能力属性 + 接入归属）。
 *
 * `connection_id` 必填：归属校验（连接存在、启用、有凭证）由 Runtime Backend 在写入侧执行；
 * 连接不再约束协议族。
 *
 * `remote_model_id` 可省略，缺省回落 `model_id`。
 *
 * `family_adapter_id` 必填（试点设计 D1：记录显式携带族适配器 id；2026-09-26 起即记录的
 * 协议声明，不从连接继承）：写入侧校验「该接口格式存在且已就绪」，不在请求侧静默补默认族。
 *
 * `accepted_media_slots` 可省略，省略即「不接受任何素材」（与 schema 缺省同口径）。
 * `parameter_overrides` 可省略，省略即空覆盖（与 schema 缺省同口径）。
 * `recipe_id` 可省略，省略即使用该族内置默认判定（与 schema 同口径）。
 */
export const CustomGenerationModelCreateBodySchema = z
  .object({
    model_id: CustomGenerationModelIdSchema,
    connection_id: z.string().min(1),
    remote_model_id: z.string().min(1).optional(),
    family_adapter_id: InterfaceFormatIdSchema,
    accepted_media_slots: z.array(GenerationMediaSlotIdSchema).optional(),
    parameter_overrides: ParameterOverridesSchema.optional(),
    recipe_id: InterfaceRecipeIdSchema.optional(),
  })
  .strict();
export type CustomGenerationModelCreateBody = z.infer<typeof CustomGenerationModelCreateBodySchema>;

/**
 * 修改自建生成模型请求体。
 *
 * 承载用户可改的模型属性：`accepted_media_slots` 与 `parameter_overrides`。
 * `model_id` 与接入归属（`connection_id` / `remote_model_id` / `family_adapter_id`）都不提供
 * 修改——改名、换连接或换族等于换一个模型，已建引用会指向不存在的对象，走删除后重建。
 *
 * `parameter_overrides` 的语义（钉死在此，不得实现侧另行解释）：**缺省 = 保持现有覆盖
 * 不变；出现 = 整体替换现有覆盖**（显式传空覆盖即清空全部覆盖）。整体替换口径与既有
 * `accepted_media_slots` 一致；允许缺省是参数覆盖后于该字段加入本请求体——不带
 * 覆盖的既有调用方继续工作。
 */
export const CustomGenerationModelUpdateBodySchema = z
  .object({
    accepted_media_slots: z.array(GenerationMediaSlotIdSchema),
    parameter_overrides: ParameterOverridesSchema.optional(),
    /**
     * 接口配方引用。语义（钉死在此）：**缺省 = 保持现有引用不变；`null` = 清除引用（回到
     * 该族内置默认）；字符串 = 改为引用该配方**。用三态而不是只给 optional，是因为
     * 「不改」与「清空」是两种不同意图，只给 optional 无法表达后者。
     */
    recipe_id: InterfaceRecipeIdSchema.nullable().optional(),
  })
  .strict();

export type CustomGenerationModelUpdateBody = z.infer<typeof CustomGenerationModelUpdateBodySchema>;

/** 删除自建生成模型的响应：模型已移除，其 active 接入（active route）一并清理。 */
export const CustomGenerationModelRemovalResponseSchema = z
  .object({
    model_id: CustomGenerationModelIdSchema,
  })
  .strict();

export type CustomGenerationModelRemovalResponse = z.infer<typeof CustomGenerationModelRemovalResponseSchema>;

// ---------------------------------------------------------------------------
// 族模板参数描述（GET /api/generation-family-templates/:familyAdapterId 响应契约）
//
// 只读投影：数据全部来自 Runtime Backend 内置族模板的 parameter_schema / payload_rules /
// default_values，模板仍是参数唯一事实源，本端点不构成第二事实源。它是 Hub 参数编辑器
// （生成模型参数高级自定义设计 §3.4）的数据源：编辑器据此渲染官方参数区并做即时提示。
// ---------------------------------------------------------------------------

/** 预设选项（分辨率档位/比例预设）的键与显示名；key 即覆盖侧 preset_keys 数组里的元素。 */
export const FamilyTemplatePresetOptionSchema = z
  .object({
    key: z.string(),
    label: z.string(),
  })
  .strict();

export type FamilyTemplatePresetOption = z.infer<typeof FamilyTemplatePresetOptionSchema>;

/**
 * 官方模板单个参数的描述（参数编辑器官方区一行的数据源）。
 *
 * `label` 由 backend 按 `runtime.i18n` 预先解析（读端拿到即可展示，编辑器不做翻译）；
 * `wire_name` 是该字段当前的发出键名（来自模板 payload_rules 的 `body.<键>` target）。
 * `enum_options` / `resolution_presets` / `aspect_presets` 按组件类型填充——select 类才有
 * 枚举、imageSize 类才有预设，不适用时恒为空数组：编辑器按空数组判定不可编辑维度，
 * 不另设能力标记字段。
 */
export const FamilyTemplateOfficialFieldSchema = z
  .object({
    field_key: z.string(),
    label: z.string(),
    component: z.string(),
    wire_name: z.string(),
    /**
     * 该字段的发出位置（来自模板 payload_rules 的 target 命名空间）：
     * `body` / `query` / `header`。别名覆盖与查重必须按同一个命名空间判定。
     *
     * 给默认值是必需的：本 schema 是 `.strict()`，读到没有该键的旧响应会整条解析失败。
     */
    wire_location: z.enum(['body', 'query', 'header']).default('body'),
    required: z.boolean(),
    default_value: ParameterOverridesValueSchema.nullable(),
    enum_options: z.array(ParameterOverridesValueSchema),
    resolution_presets: z.array(FamilyTemplatePresetOptionSchema),
    aspect_presets: z.array(FamilyTemplatePresetOptionSchema),
    /**
     * 该行是素材位字段时给出位标识（`GENERATION_MEDIA_SLOT_IDS` 的成员）；普通参数缺省。
     *
     * 素材位行的可编辑维度与普通参数不同：只有发送名称与最多几张（见
     * `OfficialParameterOverrideSchema.media_max_files`）。启用与否不在这里改——归属仍由
     * 记录的 `accepted_media_slots` 勾选清单管，两处都能改会造出二义。
     *
     * 可选键，`.strict()` 对缺失照常解析：没有素材位的族（可灵文生视频）与旧响应零影响。
     */
    media_slot_id: GenerationMediaSlotIdSchema.optional(),
    /** 素材位当前的默认张数（来自族模板 `component_props.maxFiles`）；普通参数缺省。 */
    media_max_files: z.number().int().min(1).optional(),
  })
  .strict();

export type FamilyTemplateOfficialField = z.infer<typeof FamilyTemplateOfficialFieldSchema>;

/**
 * 族模板参数描述响应。
 *
 * `reserved_wire_names` 是模板各分支已占用的发出键名 + 系统注入键（`model`/`prompt`/`input`
 * 等），**按命名空间拆开**：请求体 / 查询参数 / 请求头各自的占用集合互不相干，同一个名字在
 * 两个位置上是两个不同的字段。供编辑器对别名与自定义参数键名做即时提示；权威查重校验唯一
 * 实现在 Runtime Backend 校验器（设计 §3.5），编辑器提示只是前置反馈，不是第二份校验事实源。
 */
export const FamilyTemplateReservedWireNamesSchema = z
  .object({
    body: z.array(z.string()).default([]),
    query: z.array(z.string()).default([]),
    header: z.array(z.string()).default([]),
  })
  .strict();

export type FamilyTemplateReservedWireNames = z.infer<typeof FamilyTemplateReservedWireNamesSchema>;

export const FamilyTemplateParameterDescriptorSchema = z
  .object({
    family_adapter_id: z.string(),
    official_fields: z.array(FamilyTemplateOfficialFieldSchema),
    /** 按命名空间拆分的已占用发出键名（见上）。 */
    reserved_wire_names: FamilyTemplateReservedWireNamesSchema,
    /**
     * 该接口类型的族模板能表达的素材位（`GENERATION_MEDIA_SLOT_IDS` 的子集，2026-10-19）。
     *
     * Hub 添加／修改模型时据此**逐项渲染**素材位勾选框：只呈现该族支持的那些位，用户勾中
     * 的清单即记录的 `accepted_media_slots`。0 位族（可灵文生视频）返回空数组，Hub 不渲染
     * 素材区块——空数组是「这族一个素材位都没有」的答案，不是「还没读到」。
     *
     * 给默认值是必需的：本 schema 是 `.strict()`，读到没有该键的旧响应会整条解析失败。
     * 数组顺序即界面呈现顺序（与族模板内的字段顺序同源）。
     */
    supports_media_slots: z.array(GenerationMediaSlotIdSchema).default([]),
    /**
     * 该接口类型**协议强制必选**的素材位（是 `supports_media_slots` 的子集）。
     *
     * 语义区分：`supports_media_slots` 是「这个族能表达哪些位」（用户可选空间上限），本字段是
     * 「这个族每次提交都必须有哪一位」（用户没有选择空间）。例：可灵图生视频端点每次提交都必须
     * 带首帧，用户不能声明一个「不接受首帧」的该族模型——那会得到一个永远成功不了的模型。
     *
     * 与 `supports_media_slots` 同源下发而不由消费侧各自维护：族能力事实只有一份（Runtime
     * Backend 的族注册表），消费侧另存一份就必然在改族时漏改一处。
     *
     * 给默认值是必需的：本 schema 是 `.strict()`，读到没有该键的旧响应会整条解析失败。
     */
    required_media_slots: z.array(GenerationMediaSlotIdSchema).default([]),
  })
  .strict();

export type FamilyTemplateParameterDescriptor = z.infer<typeof FamilyTemplateParameterDescriptorSchema>;

// ---------------------------------------------------------------------------
// 接口格式列表（跨进程 DTO：下一批 Hub 的「接口类型」下拉数据源）
//
// 本批只登记契约形状、不接任何消费方：Hub 的接口类型下拉仍读 `GENERATION_FAMILY_ADAPTER_IDS`
// 这份本地快照（下一批改为读列表端点，届时删掉那份快照）。数据来源是 Runtime Backend 的
// 接口格式实体注册表——预设文件是唯一事实源，本契约不构成第二事实源。
// ---------------------------------------------------------------------------

/**
 * 一个接口格式的列表条目（只读摘要）。
 *
 * 为什么单独一个摘要而不是直接下发完整实体：列表只回答「有哪些接口类型、各自能接受哪些
 * 素材位、是否可用」，完整实体包含传输/规则/文案等执行期细节，Hub 列表不需要，
 * 也不该让界面依赖执行期结构的形状。
 */
export const InterfaceFormatSummarySchema = z
  .object({
    format_id: InterfaceFormatIdSchema,
    display_name: z.string().min(1),
    /** 格式族：本批只有生成族（对话族不走生成模型记录）。 */
    family: z.literal('generation'),
    /** `pending` = 已登记但运行时规则未就绪；界面据此呈现为不可选而不是「不存在」。 */
    status: z.enum(['ready', 'pending']),
    /**
     * 该格式能表达的素材位（`GENERATION_MEDIA_SLOT_IDS` 的子集，顺序即界面呈现顺序）。
     * 0 位格式给空数组（不是缺键）：空数组是「这个格式一个素材位都没有」的答案。
     */
    supports_media_slots: z.array(GenerationMediaSlotIdSchema),
    /** 协议强制必选的素材位（`supports_media_slots` 的子集）。 */
    required_media_slots: z.array(GenerationMediaSlotIdSchema),
    /** 展示顺序（升序；由预设自己的 `order` 声明，不按 id 字典序）。 */
    order: z.number().int().nonnegative(),
    origin: z.enum(['preset', 'user']),
    version: z.string().min(1),
  })
  .strict();

export type InterfaceFormatSummary = z.infer<typeof InterfaceFormatSummarySchema>;

// ---------------------------------------------------------------------------
// 接口格式详情与路径发现（跨进程 DTO：Hub「接口格式」页的定义栏与验证面板）
//
// 只读投影：数据全部来自 Runtime Backend 的接口格式实体注册表（预设 JSON 是唯一事实源）
// 与生成模型记录 store（`used_by_model_count` 的计数口径）。本契约不构成第二事实源。
// ---------------------------------------------------------------------------

/** 接口格式列表响应（`GET /api/interface-formats`）。 */
export const InterfaceFormatListResponseSchema = z
  .object({ formats: z.array(InterfaceFormatSummarySchema) })
  .strict();

export type InterfaceFormatListResponse = z.infer<typeof InterfaceFormatListResponseSchema>;

/**
 * 传输段的鉴权形状（只声明凭证注入到哪里，不承载任何凭证）。
 *
 * `kind` 与实体 schema 共用 `ADAPTER_AUTH_KINDS`（值域 owner）；`prefix` 是 `bearer` 形态的
 * scheme 文本（如 `Bearer`），仅用于定义栏展示。查询参数鉴权只给 `query_name`——
 * 它没有请求头，给一个恒空的 `header_name` 会让界面把它画成请求头鉴权。
 */
export const InterfaceFormatTransportAuthViewSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('bearer'),
      header_name: z.string().min(1),
      prefix: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('header_api_key'),
      header_name: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('query_api_key'),
      query_name: z.string().min(1),
    })
    .strict(),
]);

export type InterfaceFormatTransportAuthView = z.infer<typeof InterfaceFormatTransportAuthViewSchema>;

/**
 * 提交段（定义栏展示用）。
 *
 * `path` 是预设 `transport.endpoints[endpoint_key]` 解析后的相对路径——界面不展示
 * `endpoint_key` 这层内部键名。`content_type` 可空：multipart 由运行时按边界生成。
 *
 * `headers` / `query` 是从请求规则里反推出的**固定常量**（只收字面量规则）；参数与提示词的
 * 动态落点不在其中。`form_*_style` 只对 `form` 形态有意义，其余形态按默认值展示。
 */
export const InterfaceFormatTransportSubmitViewSchema = z
  .object({
    method: z.string().min(1),
    path: z.string().min(1),
    content_type: z.string().min(1).nullable(),
    payload_format: z.enum(['json', 'multipart', 'form', 'text']),
    /** 固定请求头（提交 / 轮询 / 取结果共用）。 */
    headers: z.array(InterfaceFormatNameValueSchema).default([]),
    /** 固定查询参数（仅提交）。 */
    query: z.array(InterfaceFormatNameValueSchema).default([]),
    form_field_style: z.enum(['dotted', 'bracket']).default('dotted'),
    form_array_style: z.enum(['repeat', 'bracket', 'index']).default('repeat'),
  })
  .strict();

export type InterfaceFormatTransportSubmitView = z.infer<typeof InterfaceFormatTransportSubmitViewSchema>;

/**
 * 轮询节奏、地址与请求（地址同样已由 `endpoint_key` 解析成实际路径模板）。
 *
 * `headers` / `query` / `body` 是该格式为轮询请求声明的额外交付内容；字符串值里的
 * `{id}` / `{taskId}` / `{requestId}` / `{operation_name}` / `{taskType}` 占位由运行时替换。
 */
export const InterfaceFormatTransportPollingViewSchema = z
  .object({
    url_template: z.string().min(1),
    method: z.string().min(1),
    interval_ms: z.number().int().positive(),
    max_attempts: z.number().int().positive(),
    headers: z.array(InterfaceFormatNameValueSchema).default([]),
    query: z.array(InterfaceFormatNameValueSchema).default([]),
    /** 轮询请求体（只有 POST 轮询存在）。 */
    body: InterfaceFormatJsonValueSchema.optional(),
    body_format: z.enum(['json', 'form']).default('json'),
    content_type: z.string().min(1).nullable().default(null),
  })
  .strict();

export type InterfaceFormatTransportPollingView = z.infer<typeof InterfaceFormatTransportPollingViewSchema>;

/** 异步任务段：任务标识在响应里的路径 + 轮询规则。同步格式为 `null`。 */
export const InterfaceFormatTransportAsyncViewSchema = z
  .object({
    identity_path: z.string().min(1),
    polling: InterfaceFormatTransportPollingViewSchema,
  })
  .strict();

export type InterfaceFormatTransportAsyncView = z.infer<typeof InterfaceFormatTransportAsyncViewSchema>;

export const InterfaceFormatTransportViewSchema = z
  .object({
    auth: InterfaceFormatTransportAuthViewSchema,
    /** endpoint 键 → 相对路径（与预设同源，顺序即预设声明顺序）。 */
    endpoints: z.record(z.string(), z.string().min(1)),
    submit: InterfaceFormatTransportSubmitViewSchema,
    async: InterfaceFormatTransportAsyncViewSchema.nullable(),
    /**
     * 提示词的落点（从实体 `payload_rules` 反推）：请求体路径 / 查询参数 / 纯文本正文。
     * 只用于编辑用户格式时回填表单；判不出来给 `null`，不按名字猜。
     */
    prompt_binding: InterfaceFormatPromptBindingSchema.nullable(),
    /**
     * 产品 `model_id` 的落点：请求体路径 / 查询参数 / 地址路径（`{model}` 占位）。
     * 未声明或判不出来给 `null`。
     */
    model_binding: InterfaceFormatModelBindingSchema.nullable(),
  })
  .strict();

export type InterfaceFormatTransportView = z.infer<typeof InterfaceFormatTransportViewSchema>;

/** 定义栏的素材位一行：位标识 + 参数字段键 + 是否协议强制必选 + 默认张数。 */
export const InterfaceFormatMediaSlotViewSchema = z
  .object({
    slot_id: GenerationMediaSlotIdSchema,
    field_key: z.string().min(1),
    required: z.boolean(),
    /** 预设声明的默认张数；未声明即缺键（界面按 1 张呈现）。 */
    max_files: z.number().int().min(1).optional(),
    /** 输入载体（从请求规则反推）；判不出来给 `null`（预设的规则常带宏，不按名字猜）。 */
    carrier: z.enum(['multipart_file', 'public_url', 'inline_data']).nullable(),
  })
  .strict();

export type InterfaceFormatMediaSlotView = z.infer<typeof InterfaceFormatMediaSlotViewSchema>;

/**
 * 结果的三种形态（与接口配方的 `RecipeResultForm.kind` 同词表）。
 *
 * 这里只作为**内置行为默认**的只读摘要出现：真实判定与结果形态由记录引用的配方决定
 * （配方存在时覆盖本段），本字段回答「没有配方时这个格式默认怎么做」。
 */
export const INTERFACE_FORMAT_RESULT_FORMS = ['direct_url', 'inline_media', 'needs_fetch'] as const;

export const InterfaceFormatResultFormSchema = z.enum(INTERFACE_FORMAT_RESULT_FORMS);

export type InterfaceFormatResultForm = z.infer<typeof InterfaceFormatResultFormSchema>;

/**
 * 预设内置行为的只读摘要（没有内置行为段时为 `null`）。
 *
 * `result_form` 可为 `null`：内置映射只声明「产物从响应的哪些字段取」，从这份映射的静态
 * 形态无法可靠区分「字段里是链接」与「字段里是内联内容」（Gemini Interactions 的
 * `structured_payload` 就是内联块）。Runtime Backend 只在能判出来时给出值，判不出来给
 * `null`，不按格式名或路径猜。
 */
export const InterfaceFormatBuiltinBehaviorViewSchema = z
  .object({
    has_success_condition: z.boolean(),
    result_form: InterfaceFormatResultFormSchema.nullable(),
    requires_auth: z.boolean(),
    failure_reason_present: z.boolean(),
  })
  .strict();

export type InterfaceFormatBuiltinBehaviorView = z.infer<typeof InterfaceFormatBuiltinBehaviorViewSchema>;

/**
 * 接口格式详情（`GET /api/interface-formats/:formatId`）。
 *
 * `summary` 恒有值（未就绪格式也能回答身份与状态）。其余段落按可用性可空/可空数组：
 * - `transport` / `parameter_descriptor`：未就绪（`status = 'pending'`）时为 `null`——运行时
 *   规则尚未就绪，给一份半成品形状会让界面把不可用格式显示成可用。
 * - `media_slots`：未就绪时空数组（与 `summary` 的素材位口径一致）。
 * - `builtin_behavior`：预设没有内置行为段、或摘要判不出来时为 `null`。
 *
 * `parameter_descriptor` 复用参数编辑器同一份契约（`FamilyTemplateParameterDescriptorSchema`），
 * 不另立字段事实源。
 */
export const InterfaceFormatDetailSchema = z
  .object({
    summary: InterfaceFormatSummarySchema,
    transport: InterfaceFormatTransportViewSchema.nullable(),
    media_slots: z.array(InterfaceFormatMediaSlotViewSchema),
    parameter_descriptor: FamilyTemplateParameterDescriptorSchema.nullable(),
    builtin_behavior: InterfaceFormatBuiltinBehaviorViewSchema.nullable(),
    /** 当前引用该格式的生成模型记录条数（`family_adapter_id` 命中计数）。 */
    used_by_model_count: z.number().int().nonnegative(),
    recipe_id: z.string().min(1).nullable(),
  })
  .strict();

export type InterfaceFormatDetail = z.infer<typeof InterfaceFormatDetailSchema>;

/**
 * 格式侧路径发现的请求体（`POST /api/interface-formats/:formatId/path-discovery`）。
 *
 * 响应**复用**配方侧的 `InterfaceRecipePathDiscoveryResponseSchema`（同一份展开结果，不复制
 * 第二份）。请求体不能复用配方侧那份：那份是 `.strict()` 的 `{sample}`，而格式页的样本面板
 * 允许附响应头（旅程设计 §4「必要时附响应头」），多一个键就会整条被拒。
 */
export const InterfaceFormatPathDiscoveryBodySchema = z
  .object({
    /**
     * 样本响应体（JSON 值；允许用户贴字符串形式，由实现侧统一解析）。
     *
     * `z.unknown()` 本身把缺键解析成 `undefined`，等于放行一个「什么都没贴」的请求。这里用
     * 存在性检查把它变成必填：路径发现没有样本就没有任何可用输出，静默返回空列表会被界面
     * 读成「这段样本里没有字段」。
     */
    sample: z.unknown(),
    /** 可选：样本响应头（键不区分大小写，由实现侧归一化）。 */
    headers: z.record(z.string()).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!Object.prototype.hasOwnProperty.call(value, 'sample')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sample'], message: 'sample_required' });
    }
  });

export type InterfaceFormatPathDiscoveryBody = z.infer<typeof InterfaceFormatPathDiscoveryBodySchema>;
