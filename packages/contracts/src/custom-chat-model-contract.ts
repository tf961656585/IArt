import * as z from 'zod';

import { ThinkingTierSchema } from './thinking-tier-contract';
import { ChatProtocolAdapterIdSchema } from './provider-connection-contract';

/**
 * 用户自建对话模型契约（spec 37「对话模型的唯一来源」；2026-09-25 起记录为服务商作用域单实体）。
 *
 * 对话模型只有一个来源：用户自建。自 2026-09-25 起「声明 + 接入」两层合并为单记录
 * （spec 03 §6.1「Deployment 与自建模型记录」）：一条记录同时承载能力属性与接入归属
 * （`connection_id` + `remote_model_id`），用户在服务商详情内一次写入完成添加。
 * 模型不复用到另一条连接；需要同一模型接另一条连接时，在那条连接下再添加一条记录。
 *
 * 自建模型的边界（spec 37 禁止项，不要在本文件之外放宽）：
 * - **必须归属一条连接**：记录内嵌 `connection_id`；删除连接即级联删除其下全部自建记录，
 *   不存在无归属的自建模型。
 * - **自带协议（2026-09-26 起，协议归属模型级）**：「用哪种格式调用」由记录自身的
 *   `protocol_adapter_id` 决定（限对话族适配器），一条连接可承载任意协议族的模型；记录不得
 *   声明、覆盖或默认 endpoint / base URL / 凭证 / 服务商（这些仍由归属连接承载）。
 * - **能力按纯文本对话缺省**：用户声明「上下文窗口」与「最大输出 token」两个量（都照服务商文档填）；
 *   输入模态固定为文本、无媒体准备，因此不参与 public relay 路由，也不得被媒体准备链路当作
 *   可上传媒体的模型。
 * - `model_id` 是身份与唯一显示名，全局唯一：写入时不得与已装模型包重名、不得与自建生成模型
 *   记录重名，也不得落在生成族命名空间内（见 `packages/contracts/src/model-asset-contract/protocol-constants.ts`
 *   与后台 `model-family-registry` 的封闭族口径）。
 *
 * 本文件只承载跨边界 DTO 与共享常量；目录投影、执行链、存量迁移与级联清理由 Runtime Backend 承担。
 */

/**
 * 对话模型未声明上下文窗口时的缺省值（token）。
 *
 * Hub 的「添加模型」表单预填与 Runtime Backend 执行链的兜底共用本常量：两处若各写一个数字，
 * 界面承诺的窗口与运行时实际截断的窗口会静默分叉。
 */
export const DEFAULT_CHAT_CONTEXT_WINDOW_TOKENS = 128000;

/** 上下文窗口可接受范围（token）。下界避免填成个位数把历史全丢掉，上界拦住明显的误输入。 */
export const CHAT_CONTEXT_WINDOW_MIN_TOKENS = 1024;
export const CHAT_CONTEXT_WINDOW_MAX_TOKENS = 10_000_000;

/**
 * 最大输出 token 的可接受范围。
 *
 * 下界只拦住 0 与负数这类明显误输入，不设「够不够用」的门槛：多长算够由模型与服务商决定，
 * 用户照文档填即可。
 */
export const CHAT_MAX_OUTPUT_TOKENS_MIN = 1;
export const CHAT_MAX_OUTPUT_TOKENS_MAX = 1_000_000;

/**
 * 最大输出 token 的取值：正整数，或 `null` 表示不声明。
 *
 * 与上下文窗口不同，这里**没有缺省数值常量**：上下文窗口必须有一个数才能做截断，而输出上限
 * 的「不声明」是有意义的状态——执行链不发送该参数，由服务商决定（照旧是现在各协议的默认行为）。
 * 若在此处补一个缺省数字，等于给每个模型强加一道无人声明的输出上限。
 */
const MaxOutputTokensSchema = z
  .number()
  .int()
  .min(CHAT_MAX_OUTPUT_TOKENS_MIN)
  .max(CHAT_MAX_OUTPUT_TOKENS_MAX);

/**
 * 自建模型 `model_id` 的字符集。
 *
 * 限制为无空白、无引号的 ASCII 标识符：它既是全局唯一的身份与显示名，也会被放进
 * 日志、URL 路径（删除路由）与目录投影，允许任意字符会让这些都变成转义问题。
 */
export const CUSTOM_CHAT_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const CustomChatModelIdSchema = z.string().regex(CUSTOM_CHAT_MODEL_ID_PATTERN);

export const CustomChatModelSchema = z
  .object({
    model_id: CustomChatModelIdSchema,
    /**
     * 接入记录 id（`up_dep_` 前缀）。active route 与 ExecutionSnapshot 的 `deployment_id`
     * 字段引用本 id；存量迁移时继承升级前那条接入的 id，既有 active-routes 数据因此零改动。
     * 由 Runtime Backend 生成，请求体不携带。
     */
    record_id: z.string().regex(/^up_dep_[a-z0-9][a-z0-9-_]*$/),
    /**
     * 该记录归属的服务商连接（spec 03 §6.1）。创建时必填，且必须指向存在、启用、有凭证的
     * 连接（校验由 Runtime Backend 写入侧执行；连接不再约束协议族，协议由记录自带声明）；
     * 归属不可变——换连接等于删除后在新连接下重建。
     */
    connection_id: z.string().min(1),
    /**
     * 该模型的接口协议（对话族适配器 id，2026-09-26 起协议归属模型级）。创建时必填，创建后
     * 不可变——换协议等于删除后重建（思考档位的启用关系与可表达性都绑定协议）。endpoint、
     * base URL、凭证仍由归属连接承载，记录不得声明或覆盖。
     */
    protocol_adapter_id: ChatProtocolAdapterIdSchema,
    /**
     * 服务商那边的模型名。创建请求体可省略（缺省回落 `model_id`，对话表单不暴露该字段），
     * 记录本体恒有值。
     */
    remote_model_id: z.string().min(1),
    /**
     * 该模型一次能读入多少内容（token），由用户按服务商文档填写。
     *
     * 给默认值是必需的：本 schema 是 `.strict()`，读取缺字段的历史文件会直接失败。
     */
    context_window_tokens: z
      .number()
      .int()
      .min(CHAT_CONTEXT_WINDOW_MIN_TOKENS)
      .max(CHAT_CONTEXT_WINDOW_MAX_TOKENS)
      .default(DEFAULT_CHAT_CONTEXT_WINDOW_TOKENS),
    /**
     * 该模型一次回复最多生成多少 token（含思考 token），由用户按服务商文档填写。
     *
     * 填小了会在生成中途被截断；`null` 表示不声明——执行链不发送该参数，由服务商决定。
     * 它是**模型**的属性（同上下文窗口），落在该模型记录上（2026-09-25 起记录即接入，
     * 不存在「同一个 model_id 接多条连接」的形态）。
     */
    max_output_tokens: MaxOutputTokensSchema.nullable().default(null),
    /**
     * 已启用思考档位（spec 37「思考档位」），**数组顺序即创作面的展示顺序**；空数组 =
     * 只有「不思考」可用。2026-09-25 起档位随对话模型记录走（此前落在独立的接入载体上，
     * 那个载体已随 2026-10-19 原子换轨整体退场）。
     */
    enabled_thinking_tiers: z.array(ThinkingTierSchema).default([]),
    /**
     * 默认思考档位（spec 37「思考档位」）：创作面为该模型初始化思考时用它；null = 没有默认，
     * 创作面按不思考处理。取值必须是 `enabled_thinking_tiers` 的成员——这条跨字段不变量由
     * 写入侧归一化保证（档位被删或被摘掉时一并清空），schema 不在此阻断整条记录：
     * 历史不一致不该让整条记录在读取时被丢弃。
     */
    default_thinking_tier: ThinkingTierSchema.nullable().default(null),
    created_at: z.string(),
  })
  .strict();

export type CustomChatModel = z.infer<typeof CustomChatModelSchema>;

// ---------------------------------------------------------------------------
// 跨边界 DTO（GET / POST /api/custom-chat-models、PUT/DELETE /api/custom-chat-models/:modelId）
// ---------------------------------------------------------------------------

export const CustomChatModelListResponseSchema = z
  .object({ models: z.array(CustomChatModelSchema) })
  .strict();

export type CustomChatModelListResponse = z.infer<typeof CustomChatModelListResponseSchema>;

export const CustomChatModelResponseSchema = z.object({ model: CustomChatModelSchema }).strict();

export type CustomChatModelResponse = z.infer<typeof CustomChatModelResponseSchema>;

/**
 * 添加自建对话模型请求体（服务商详情内一次写入：能力属性 + 思考档位 + 接入归属 + 协议）。
 *
 * `connection_id` 必填：归属校验（连接存在、启用、有凭证）由 Runtime Backend 在写入侧执行，
 * schema 只管形状；连接不再约束协议族。
 *
 * `protocol_adapter_id` 必填（2026-09-26 起协议归属模型级）：对话族适配器 id，写入侧校验
 * 合法性；不从连接继承、创建后不可变。
 *
 * `remote_model_id` 可省略，缺省回落 `model_id`（对话表单不暴露该字段；直接调用方可显式指定）。
 *
 * 思考档位两字段可省略（spec 37「思考档位」创建写入路径）：省略即空档位（只有「不思考」）
 * 与无默认档位；显式携带时与档位启用关系同一次落库，不留「刚加好的模型没有档位」的中间态。
 *
 * `context_window_tokens` 可省略，省略时按 `DEFAULT_CHAT_CONTEXT_WINDOW_TOKENS` 落库
 * （Hub 表单会预填同一个值，所以省略只发生在直接调用方）。
 *
 * `max_output_tokens` 可省略也可显式传 `null`，两者都表示不声明——新建时没有「清空」与
 * 「不修改」之分，所以这里用宽松形态；修改请求体的口径不同，见下。
 */
export const CustomChatModelCreateBodySchema = z
  .object({
    model_id: CustomChatModelIdSchema,
    connection_id: z.string().min(1),
    protocol_adapter_id: ChatProtocolAdapterIdSchema,
    remote_model_id: z.string().min(1).optional(),
    context_window_tokens: z
      .number()
      .int()
      .min(CHAT_CONTEXT_WINDOW_MIN_TOKENS)
      .max(CHAT_CONTEXT_WINDOW_MAX_TOKENS)
      .optional(),
    max_output_tokens: MaxOutputTokensSchema.nullable().optional(),
    enabled_thinking_tiers: z.array(ThinkingTierSchema).optional(),
    default_thinking_tier: ThinkingTierSchema.nullable().optional(),
  })
  .strict();

export type CustomChatModelCreateBody = z.infer<typeof CustomChatModelCreateBodySchema>;

/**
 * 修改自建对话模型请求体。
 *
 * 只承载用户可改的模型属性；`model_id` 与接入归属（`connection_id` / `remote_model_id`）
 * 都不提供修改——改名或换连接等于换一个模型，会让已建的会话与档位启用关系指向一个
 * 不存在的对象，走删除后重建。
 *
 * 本请求体是**整体替换**：能力两字段 + 档位两字段都必填，`max_output_tokens` 传 `null`
 * 才表示「清空为不声明」；`enabled_thinking_tiers` 传空数组即清空启用档位（只剩「不思考」）、
 * `default_thinking_tier` 传 `null` 即无默认。若把任一字段写成可省略，「清空」与「不修改」
 * 在 body 上无法区分，用户想清空时会静默保留旧值。
 */
export const CustomChatModelUpdateBodySchema = z
  .object({
    context_window_tokens: z
      .number()
      .int()
      .min(CHAT_CONTEXT_WINDOW_MIN_TOKENS)
      .max(CHAT_CONTEXT_WINDOW_MAX_TOKENS),
    max_output_tokens: MaxOutputTokensSchema.nullable(),
    enabled_thinking_tiers: z.array(ThinkingTierSchema),
    default_thinking_tier: ThinkingTierSchema.nullable(),
  })
  .strict();

export type CustomChatModelUpdateBody = z.infer<typeof CustomChatModelUpdateBodySchema>;

/** 删除自建模型的响应：模型已移除，其 active 接入（active route）一并清理。 */
export const CustomChatModelRemovalResponseSchema = z
  .object({
    model_id: CustomChatModelIdSchema,
  })
  .strict();

export type CustomChatModelRemovalResponse = z.infer<typeof CustomChatModelRemovalResponseSchema>;
