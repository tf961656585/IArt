import * as z from 'zod';

import { CUSTOM_CHAT_MODEL_ID_PATTERN } from './custom-chat-model-contract';

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
 *   归属声明，值域即 `GENERATION_FAMILY_ADAPTER_IDS`（每族与一个族模板、一个 ProtocolAdapter
 *   一一对应）；一条连接可承载任意协议族的模型。记录不得声明、覆盖或
 *   默认 endpoint / base URL / 凭证 / 服务商（这些仍由归属连接承载）；执行语义由该族模板决定。
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
 * 生成族适配器 id 的唯一值域（生成族接口类型的唯一事实源）。
 *
 * **顺序即界面下拉展示顺序**：同一服务商下添加模型时，用户先在这里选「接口类型」，
 * 再由族模板给出该接口的参数表单与请求规则。可灵按官方三个提交端点拆成三个接口类型
 * （端点即模型身份：文生视频 / 图生视频 / 全模态视频三者的请求体字段并不通用）。
 *
 * 声明实体、「添加模型」与「修改模型」请求体共用本 schema，避免多处各写一份枚举字面量
 * 造成漂移；Hub 的下拉选项直接由本常量派生，不得另列清单。
 */
export const GENERATION_FAMILY_ADAPTER_IDS = [
  'openai-image-v1',
  'gemini-image-interactions-v1',
  'seedance-2-0-v1',
  'veo-v1',
  'kling-text2video-v1',
  'kling-image2video-v1',
  'kling-omni-video-v1',
] as const;

export const GenerationFamilyAdapterIdSchema = z.enum(GENERATION_FAMILY_ADAPTER_IDS);

export type GenerationFamilyAdapterId = z.infer<typeof GenerationFamilyAdapterIdSchema>;

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
 * 参数发出键名（wire name）的字符集约束（生成模型参数高级自定义设计 §3.5 校验清单）。
 *
 * 覆盖别名与自定义参数的发出键名都受它约束：键名会直接进入服务商请求体，也会进日志与
 * 排查材料，只允许小写字母开头的 ASCII 标识符。这里只管形状；「与模板已占用键、系统注入
 * 键查重」是语义校验，唯一实现由 Runtime Backend 校验器承担（设计 §3.5），本常量被该校验器复用。
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
 * 各维度的适用性（select 类才接受 enum_options、imageSize 类才接受预设子集、媒体素材位字段
 * 不可覆盖）与「field_key 必须命中模板已声明字段」都是运行期语义校验，由 Runtime Backend
 * 保存/投影共用的校验器唯一实现（设计 §3.3/§3.5），schema 层只管形状。
 */
export const OfficialParameterOverrideSchema = z
  .object({
    /** 族模板已声明字段的内部标识；媒体素材位字段不可覆盖（素材位归属由记录上的 accepted_media_slots 管控）。 */
    field_key: z.string().min(1),
    /** `false` = 整体禁用：从面板、default_values 与 payload_rules 一并移除（合成规则第 1 步）。 */
    enabled: z.boolean().optional(),
    /** 别名：改写该字段所有 payload_rule target 的发出键名（合成规则第 2 步）。 */
    wire_name: z.string().regex(GENERATION_WIRE_NAME_PATTERN).optional(),
    /** 枚举替换/收窄（仅 select 类字段合法；替换后非空、默认值落在新合法集内由 backend 校验）。 */
    enum_options: z.array(ParameterOverridesValueSchema).optional(),
    /** 画幅分辨率预设显隐子集（仅 imageSize 类字段合法；空数组 = 全部隐藏）。 */
    resolution_preset_keys: z.array(z.string()).optional(),
    /** 比例预设显隐子集（仅 imageSize 类字段合法；空数组 = 全部隐藏）。 */
    aspect_preset_keys: z.array(z.string()).optional(),
    /** 默认值覆盖，必须落在替换后的合法集内（backend 校验）。 */
    default_value: ParameterOverridesValueSchema.optional(),
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
     * 值域见 `GENERATION_FAMILY_ADAPTER_IDS`（每族与一个族模板、一个 ProtocolAdapter 对应）；
     * 创建后不可变——换族等于换一个模型，走删除后重建。执行语义由该族模板决定：
     * endpoint、请求规则与参数表单全部来自该族模板，记录侧不得改写；与归属连接无关——
     * 连接只承载地址与凭证。
     */
    family_adapter_id: GenerationFamilyAdapterIdSchema,
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
 * 协议声明，不从连接继承）：写入侧校验「该族模板存在」，不在请求侧静默补默认族。
 *
 * `accepted_media_slots` 可省略，省略即「不接受任何素材」（与 schema 缺省同口径）。
 * `parameter_overrides` 可省略，省略即空覆盖（与 schema 缺省同口径）。
 */
export const CustomGenerationModelCreateBodySchema = z
  .object({
    model_id: CustomGenerationModelIdSchema,
    connection_id: z.string().min(1),
    remote_model_id: z.string().min(1).optional(),
    family_adapter_id: GenerationFamilyAdapterIdSchema,
    accepted_media_slots: z.array(GenerationMediaSlotIdSchema).optional(),
    parameter_overrides: ParameterOverridesSchema.optional(),
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
    required: z.boolean(),
    default_value: ParameterOverridesValueSchema.nullable(),
    enum_options: z.array(ParameterOverridesValueSchema),
    resolution_presets: z.array(FamilyTemplatePresetOptionSchema),
    aspect_presets: z.array(FamilyTemplatePresetOptionSchema),
  })
  .strict();

export type FamilyTemplateOfficialField = z.infer<typeof FamilyTemplateOfficialFieldSchema>;

/**
 * 族模板参数描述响应。
 *
 * `reserved_wire_names` 是模板各分支已占用的发出键名 + 系统注入键（`model`/`prompt`/`input`
 * 等），供编辑器对别名与自定义参数键名做即时提示；权威查重校验唯一实现在 Runtime Backend
 * 校验器（设计 §3.5），编辑器提示只是前置反馈，不是第二份校验事实源。
 */
export const FamilyTemplateParameterDescriptorSchema = z
  .object({
    family_adapter_id: z.string(),
    official_fields: z.array(FamilyTemplateOfficialFieldSchema),
    reserved_wire_names: z.array(z.string()),
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
