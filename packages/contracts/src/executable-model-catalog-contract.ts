import * as z from 'zod';
import { GenerationMediaSlotIdSchema } from './custom-generation-model-contract';
import { ThinkingTierSchema } from './thinking-tier-contract';

/**
 * 可执行模型目录契约（contracts 层）—— GET /api/executable-model-catalog 的跨边界响应 DTO。
 *
 * 归属与口径对齐：
 * - spec 主口径：`docs/model-assets/45-PromptDock模型能力目录、Deployment与执行快照契约.md` §1/§3
 *   （只投影已闭合且有唯一 ProtocolAdapter 的可执行模型；Seedance 2.5 契约闭合前不进可提交目录）
 * - spec 主口径：`docs/custom-providers/03-Provider连接、协议适配与模型部署主口径.md` §6/§7
 *   （每个 model_id 最多一个 active deployment；无 active / 连接禁用或退役 / 凭证缺失 /
 *     适配器缺失 / 能力不兼容 / remote_model_id 为空 => 确定性失效原因，不自动补选或 fallback）
 * - 可执行契约 owner：packages/contracts（跨边界 DTO 必须由 contracts 承载 Zod schema 与 .parse()）。
 *
 * 本文件只承载 HTTP 响应 DTO。模型能力字段（capability / parameter_schema）来自 Runtime Backend
 * 的模型能力包投影（CatalogProjection），不复制模型能力包原件字段事实源。
 *
 * 禁止项：
 * - 任何字段不得返回明文凭证；credential 只以 has_active / failure_code 语义呈现。
 * - Seedance 2.5（以及任何未闭合执行契约的模型）不得进入 models 列表。
 * - 失效原因只回稳定原因码，不回展示文案：同一原因码在 Hub 与 Editor 的措辞不同
 *   （Hub 说「去补密钥」，Editor 说「服务不可用」），由各自进程按原因码本地渲染，
 *   避免后端成为文案 owner、也避免两处各维护一套并列的原因码清单。
 */

// ---------------------------------------------------------------------------
// 失败原因码与可提交性
// ---------------------------------------------------------------------------

/**
 * 确定性失效原因码（spec 45 §3）。稳定、可测试；这是跨边界唯一的事实，展示文案由
 * 消费端（Hub / Editor）按码本地渲染，不随本契约传输。
 *
 * - none：可执行（deployable=true 时恒为 none）。
 * - no_active_deployment：model_id 没有 active deployment。
 * - connection_disabled / connection_retired：连接生命周期不可路由。
 * - connection_missing：active deployment 指向的连接不存在。
 * - credential_missing：凭证缺失或不可读。
 * - adapter_missing：ProtocolAdapter 未安装/未注册。
 * - remote_model_id_empty：Deployment 未配置 Provider 原生模型 ID。
 * - deployment_invalid：Deployment 本身不满足可执行前置条件（泛化兜底，优先给出更精确码）。
 */
export const EXECUTABLE_MODEL_FAILURE_CODES = [
  'none',
  'no_active_deployment',
  'connection_missing',
  'connection_disabled',
  'connection_retired',
  'credential_missing',
  'adapter_missing',
  'remote_model_id_empty',
  'deployment_invalid',
] as const;

export const ExecutableModelFailureCodeSchema = z.enum(EXECUTABLE_MODEL_FAILURE_CODES);
export type ExecutableModelFailureCode = z.infer<typeof ExecutableModelFailureCodeSchema>;

// ---------------------------------------------------------------------------
// 模型能力投影见 providers 字段事实源（本地投影，跨边界只传显式子集）。
// ---------------------------------------------------------------------------

export const ExecutableCatalogMediaTypeSchema = z.enum(['text', 'image', 'video', 'audio']);
export type ExecutableCatalogMediaType = z.infer<typeof ExecutableCatalogMediaTypeSchema>;

export const ExecutableCatalogParameterFieldSchema = z
  .object({
    fieldKey: z.string().min(1),
    label: z.string(),
    component: z.string().min(1),
    required: z.boolean(),
    defaultValue: z.unknown().optional(),
    description: z.string().optional(),
    enumOptions: z
      .array(
        z.object({
          value: z.union([z.string(), z.number(), z.boolean()]),
          label: z.string().optional(),
        }),
      )
      .optional(),
    dataSource: z.enum(['connection', 'form', 'both']).optional(),
    /** 组件呈现属性（如 imageSize 的档位/比例/约束），由模型能力包投影透传；Editor 参数表单按 component 解释 */
    componentProps: z.record(z.unknown()).optional(),
    visibleWhen: z.record(z.unknown()).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

export type ExecutableCatalogParameterField = z.infer<typeof ExecutableCatalogParameterFieldSchema>;

export const ExecutableCatalogModelCapabilitySchema = z
  .object({
    input_modalities: z.array(ExecutableCatalogMediaTypeSchema),
    output_modalities: z.array(ExecutableCatalogMediaTypeSchema),
    supports_multi_image: z.boolean().optional(),
    supports_reference_media: z.boolean().optional(),
  })
  .strict();

export type ExecutableCatalogModelCapability = z.infer<typeof ExecutableCatalogModelCapabilitySchema>;

export const ExecutableCatalogParameterSchemaSchema = z
  .object({
    fields: z.array(ExecutableCatalogParameterFieldSchema),
    required_fields: z.array(z.string().min(1)),
    default_values: z.record(z.unknown()).optional(),
  })
  .strict();

export type ExecutableCatalogParameterSchema = z.infer<typeof ExecutableCatalogParameterSchemaSchema>;

// ---------------------------------------------------------------------------
// Deployment 可执行性判定
// ---------------------------------------------------------------------------

export const ExecutableCatalogDeploymentSchema = z
  .object({
    /** 是否存在 active deployment（模型级单值，spec 03 §6.2） */
    has_active_deployment: z.boolean(),
    /** 当前 active deployment_id；无 active 时为 null */
    active_deployment_id: z.string().nullable(),
    /** 该模型当前是否可提交（has_active && 全部可执行前置条件通过） */
    deployable: z.boolean(),
    /**
     * 确定性失效原因码；deployable=true 时为 'none'。
     * 跨边界只承载原因码，展示文案由 Hub / Editor 各自按码渲染（见文件头说明）。
     */
    failure_code: ExecutableModelFailureCodeSchema,
  })
  .strict();

export type ExecutableCatalogDeployment = z.infer<typeof ExecutableCatalogDeploymentSchema>;

// ---------------------------------------------------------------------------
// 可执行模型目录条目与响应
// ---------------------------------------------------------------------------

/** 单个媒体素材位：模型当前记录实际启用的某个「放媒体的位置」（首帧 / 尾帧 / 参考图 …）。 */
export const ExecutableCatalogMediaSlotSchema = z
  .object({
    /** 素材位标识，复用记录契约的生成媒体位枚举（reference_image / first_frame / last_frame …） */
    slotId: GenerationMediaSlotIdSchema,
    /** 该素材位对应的参数字段键（如 firstFrameImage）；Editor 据此把用途映射到提交字段。
     *  命名与同文件 `ExecutableCatalogParameterFieldSchema.fieldKey` 保持一致。 */
    fieldKey: z.string().min(1),
    /** 该位是否必填（与 parameter_schema.required_fields 必须同口径） */
    required: z.boolean(),
    /** 该位可放几张 */
    maxFiles: z.number().int().min(1),
    /** 该位接受的媒体类型 */
    mediaKind: z.enum(['image', 'video', 'audio']),
    /** 中文展示名（来自族模板本地化资源；缺失时为空串，消费端回退到 fieldKey） */
    label: z.string(),
  })
  .strict();

export type ExecutableCatalogMediaSlot = z.infer<typeof ExecutableCatalogMediaSlotSchema>;

export const ExecutableModelDirectoryEntrySchema = z
  .object({
    model_id: z.string().min(1),
    model_version: z.string().min(1),
    /**
     * 模型默认任务类型（运行时资产 `runtime.default_task_type` 的投影，如 image / video / text）。
     * 用途：Hub 模型绑定页按用户能理解的用途分组，不靠消费端从模态反推。
     * 资产未声明时为空串，消费端按「其他」归组。
     */
    default_task_type: z.string(),
    /**
     * 模型展示排序权重（运行时资产 `display.order` 的投影）。
     * 资产未声明时缺省，消费端保持目录返回顺序。
     */
    display_order: z.number().optional(),
    capability: ExecutableCatalogModelCapabilitySchema,
    /**
     * 该模型当前记录实际启用的媒体素材位；无素材位的族为空数组。
     *
     * **可选而不是 `.default([])`**：Zod 的 `.default()` 会让**输出**类型变成必填，所有手工
     * 构造本 DTO 的消费方（含大量测试夹具）都要为一个它们不关心的字段补值。本字段是
     * 「有素材位才需要」的补充信息，缺省等价于无素材位——消费端按 `?? []` 读。
     *
     * 生产侧（Runtime Backend 的目录投影）恒写该字段，不会省略。
     */
    media_slots: z.array(ExecutableCatalogMediaSlotSchema).optional(),
    parameter_schema: ExecutableCatalogParameterSchemaSchema,
    deployment: ExecutableCatalogDeploymentSchema,
  })
  .strict();

export type ExecutableModelDirectoryEntry = z.infer<typeof ExecutableModelDirectoryEntrySchema>;

export const ExecutableModelCatalogResponseSchema = z
  .object({
    models: z.array(ExecutableModelDirectoryEntrySchema),
  })
  .strict();

export type ExecutableModelCatalogResponse = z.infer<typeof ExecutableModelCatalogResponseSchema>;

// ---------------------------------------------------------------------------
// 对话模型目录（GET /api/chat-model-catalog）
// ---------------------------------------------------------------------------

/**
 * 对话模型目录条目：可执行模型目录条目的投影形状 + 创作面需要的思考档位投影。
 *
 * 为什么单独一个端点：对话模型（用户自建声明的 LLM）不进 PromptDock 目录
 * （spec 03 §1「对话能力不进 PromptDock 目录」/ spec 06「生成式形态的模型目录」）。把它并进
 * 可执行目录会让 PromptDock 出现不可生成的模型，因此这里只做同一投影形状的独立出口。
 *
 * 字段语义与 ExecutableModelDirectoryEntry 一致：对话模型没有生成参数，parameter_schema 为
 * 无字段集合；deployment 仍表达「是否已有 active 部署且可提交」，由 active 部署判定。
 *
 * `thinking_tiers` 是该模型当前**可被选择的档位**（spec 06「服务行的「思考」只列该模型在主窗口
 * 被启用的档位加「不思考」」）：由有效部署的启用关系与该模型协议的可表达性共同决定，创作面只消费、
 * 不再自行过滤；「不思考」（`off`）恒定可用，不出现在本字段里。
 */
export const ChatModelDirectoryEntrySchema = ExecutableModelDirectoryEntrySchema.extend({
  thinking_tiers: z.array(ThinkingTierSchema),
  /**
   * 该接入声明的默认档位（spec 37「思考档位」），创作面据此初始化该模型的思考选择。
   * 只投影**当前可被选择的档位**之内的默认值：默认档位落在协议表达不了的档位上、或已不在启用列表里时
   * 投影为 null，避免创作面预选一个发不出去的档位。
   */
  default_thinking_tier: ThinkingTierSchema.nullable(),
});
export type ChatModelDirectoryEntry = z.infer<typeof ChatModelDirectoryEntrySchema>;

export const ChatModelCatalogResponseSchema = z
  .object({
    models: z.array(ChatModelDirectoryEntrySchema),
  })
  .strict();

export type ChatModelCatalogResponse = z.infer<typeof ChatModelCatalogResponseSchema>;
