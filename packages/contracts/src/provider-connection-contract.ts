import * as z from 'zod';
import type { ChatAdapterId } from './chat-contract';
import { isBuiltinThinkingTier } from './thinking-tier-contract';
import { TaskSubmitMediaInputSchema } from './task-submit-media-input';

/**
 * Provider 连接、协议适配与模型接入契约（contracts 层）
 *
 * 归属与口径对齐：
 * - spec 主口径：`docs/custom-providers/03-Provider连接、协议适配与模型部署主口径.md`
 *   - §3 ProtocolAdapter：内置、不可变、版本化；Endpoint/鉴权/轮询/结果/错误由适配器声明
 *   - §4 ProviderConnection：全局本机、地址+凭证、Base URL 规范化、Credential lease
 *     （连接级 `protocol_adapter_id` 已退役，仅为存量迁移保留读取，2026-09-29 起）
 *   - §6 模型记录与 active route：接入目标只有模型记录 id 一种；单值 active（2026-10-19 起
 *     部署载体整体退场，见 §12 PC-14）
 *   - §7/§8 状态与快照：连接健康、ExecutionSnapshot 冻结
 * - spec 主口径：`docs/model-assets/45-PromptDock模型能力目录、Deployment与执行快照契约.md` v3
 *   - BatchIntentSnapshot（提交时）+ ExecutionSnapshot（派发时冻结）
 * - spec 主口径：`docs/provider-remote-apis/03-OpenAI-图像生成接口.md`
 * - 可执行契约 owner：packages/contracts
 */

// ---------------------------------------------------------------------------
// ProtocolAdapter
// ---------------------------------------------------------------------------

export const PROTOCOL_ADAPTER_IDS = [
  // 生成侧协议 id（8 个预设接口格式 id）。2026-10-27 起生成侧没有代码适配器，本节仅保留
  // **历史数据解析**：连接上的遗留 `protocol_adapter_id` 与已落库任务快照仍带这些值，
  // 缩小值域会让整条记录解析失败。现役生成传输事实源是接口格式实体。
  'openai-image-v1',
  // OpenAI 形状的视频接口格式（2026-10-24 新增）：OpenAI 官方视频服务已于 2026-09-24 关停，
  // 但 `POST /v1/videos` + job 对象这套**格式**仍被大量第三方 Provider 沿用。
  'openai-video-v1',
  'gemini-image-interactions-v1',
  'seedance-2-0-v1',
  'veo-v1',
  // 可灵按官方三个提交端点拆成三个接口格式（2026-10-19）：官方三个端点的请求体字段并不
  // 通用（图生视频的 settings 没有 aspect_ratio、omni 的 audio 多一个 original 取值），
  // 端点即模型身份。
  'kling-text2video-v1',
  'kling-image2video-v1',
  'kling-omni-video-v1',
  // 对话协议（2026-09-16 纳入）：作为 agent 形态的语言模型来源，不进 PromptDock 目录。
  // 2026-09-26 起协议归属模型级：自建模型记录自带协议声明（对话记录 `protocol_adapter_id` /
  // 生成记录 `family_adapter_id`）；连接级 `protocol_adapter_id` 已退役（2026-09-29 起，
  // 仅为存量迁移保留读取），不约束已接入模型（spec 03 §1、§4.1、§6.1）。
  'openai-chat-completions-v1',
  'openai-responses-v1',
  'anthropic-messages-v1',
  'gemini-chat-v1',
] as const;

export const ProtocolAdapterIdSchema = z.enum(PROTOCOL_ADAPTER_IDS);
export type ProtocolAdapterId = z.infer<typeof ProtocolAdapterIdSchema>;

/**
 * 适配器鉴权形态（spec 03 §3.1「鉴权策略及其注入位置」/ §4.3）。
 *
 * 判别联合表达不同官方协议的凭证注入方式，禁止用一组全可选字段覆盖所有形态：
 * - `bearer`：`Authorization: Bearer <secret>`（OpenAI Images、火山 Ark）
 * - `header_api_key`：`<header_name>: <secret>`，无 scheme（Google `x-goog-api-key`）
 * - `query_api_key`：`?<query_name>=<secret>`（用户自建接口格式的查询参数鉴权，2026-10-27 起）
 *
 * 用户连接只提交一个 API Key 明文；注入位置完全由适配器 / 接口格式声明，连接不得自行选择
 * Bearer / query / header 形状（spec 03 §4.3）。三种形态共用同一份连接凭证。
 */
export const ADAPTER_AUTH_KINDS = ['bearer', 'header_api_key', 'query_api_key'] as const;
export const AdapterAuthKindSchema = z.enum(ADAPTER_AUTH_KINDS);
export type AdapterAuthKind = z.infer<typeof AdapterAuthKindSchema>;

export const AdapterAuthSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('bearer'),
      header_name: z.string().min(1),
      /**
       * scheme 前缀，缺省 `Bearer`。
       *
       * 用户自建接口格式可以声明别的 scheme（`Token abc`），执行链必须按声明渲染；
       * 只认 `Bearer` 会让「用户声明了 A、实际发了 B」变成静默错误。
       */
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
      /** 凭证注入的查询参数名（如 `key`）；字符集由接口格式写入侧校验。 */
      query_name: z.string().min(1),
    })
    .strict(),
]);
export type AdapterAuth = z.infer<typeof AdapterAuthSchema>;

/**
 * 凭证注入位置：请求头或查询参数（`kind` 是注入位置，不是鉴权形态）。
 *
 * 执行链（提交、轮询、取结果）只应消费本结构：拿到 `{ kind:'header' }` 就设请求头，
 * 拿到 `{ kind:'query' }` 就拼查询参数。把「鉴权形态」与「注入位置」混在一起，
 * 会让查询参数鉴权被当成请求头写出去。
 */
export const AdapterAuthInjectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('header'), name: z.string().min(1), value: z.string() }).strict(),
  z.object({ kind: z.literal('query'), name: z.string().min(1), value: z.string() }).strict(),
]);
export type AdapterAuthInjection = z.infer<typeof AdapterAuthInjectionSchema>;

/**
 * 按接口格式声明的鉴权形态，把凭证明文渲染成最终注入位置与取值。
 *
 * 这是「凭证 → 线路注入」的**唯一实现点**：执行链必须调用本函数，不得各自硬编码
 * `Bearer` 前缀、header 名或 query 名。
 */
export const buildAdapterAuthInjection = (auth: AdapterAuth, secret: string): AdapterAuthInjection => {
  switch (auth.kind) {
    case 'bearer':
      return { kind: 'header', name: auth.header_name, value: `${auth.prefix ?? 'Bearer'} ${secret}` };
    case 'header_api_key':
      return { kind: 'header', name: auth.header_name, value: secret };
    case 'query_api_key':
      return { kind: 'query', name: auth.query_name, value: secret };
  }
};

/**
 * 适配器族（spec 03 §1）：生成能力进 PromptDock 可执行目录；对话能力只作为 agent 形态的
 * 语言模型来源、不进 PromptDock 目录。
 *
 * 2026-10-27 起 `generation` 只作历史标记存在：生成侧协议由接口格式实体声明，
 * 现役注册表（`ADAPTER_REGISTRY`）只剩对话族。
 */
export const PROTOCOL_ADAPTER_FAMILIES = ['generation', 'chat'] as const;
export const ProtocolAdapterFamilySchema = z.enum(PROTOCOL_ADAPTER_FAMILIES);
export type ProtocolAdapterFamily = z.infer<typeof ProtocolAdapterFamilySchema>;

/**
 * ProtocolAdapter：系统内置、不可变、版本化的**对话协议**执行规则（spec 03 §3）。
 *
 * `relative_endpoints` 是该协议唯一的 endpoint 事实源（键 = 语义化的 endpoint 名，
 * 值 = 相对路径模板，可含 `{model}` / `{id}` / `{operation_name}` 占位符）。
 *
 * 生成族的等价物是接口格式实体（`interface-format/` 预设 + 用户库）：传输规则由格式声明，
 * 执行链按声明执行，不再有代码适配器与预设的双份事实源（2026-10-27 退场）。
 */
export const ProtocolAdapterSchema = z
  .object({
    adapter_id: ProtocolAdapterIdSchema,
    version: z.string().min(1),
    display_name: z.string().min(1),
    /** 协议族：`chat` 是现役取值；`generation` 仅为历史数据解析保留 */
    family: ProtocolAdapterFamilySchema,
    auth: AdapterAuthSchema,
    relative_endpoints: z.record(z.string()).optional(),
    /**
     * 该协议能否承载**自定义**思考档位（spec 37「思考档位」）。
     *
     * 档位字段值域是自由字符串的协议（OpenAI 系 `reasoning_effort` / `reasoning.effort`）可以，
     * 值域为 token 预算或有限枚举的协议（Anthropic thinking budget、Gemini thinking config）不能。
     * 只影响自定义档位；内置档位由适配器翻译，与协议无关。
     */
    supports_custom_thinking_tiers: z.boolean().optional(),
    description: z.string().optional(),
  })
  .strict();

export type ProtocolAdapter = z.infer<typeof ProtocolAdapterSchema>;

export const CHAT_PROTOCOL_ADAPTER_IDS = [
  'openai-chat-completions-v1',
  'openai-responses-v1',
  'anthropic-messages-v1',
  'gemini-chat-v1',
] as const;

export const ChatProtocolAdapterIdSchema = z.enum(CHAT_PROTOCOL_ADAPTER_IDS);
export type ChatProtocolAdapterId = z.infer<typeof ChatProtocolAdapterIdSchema>;

/**
 * 现役适配器注册表（只剩对话族）。
 *
 * 生成族的传输定义 2026-10-26 起由接口格式实体承载；2026-10-27 执行链接管后本表不再保留
 * 生成条目——预设格式与代码适配器的双份声明一并退场，生成侧执行只认格式声明。
 * `PROTOCOL_ADAPTER_IDS` 仍保留 8 个预设 id，仅用于解析历史数据（连接遗留字段与历史任务快照）。
 */
export const ADAPTER_REGISTRY: Record<ChatProtocolAdapterId, ProtocolAdapter> = {
  'openai-chat-completions-v1': {
    adapter_id: 'openai-chat-completions-v1',
    version: '1.0.0',
    display_name: 'OpenAI Chat Completions',
    family: 'chat',
    auth: { kind: 'bearer', header_name: 'Authorization' },
    relative_endpoints: {
      chatCompletions: '/v1/chat/completions',
    },
    supports_custom_thinking_tiers: true,
    description: 'OpenAI Chat Completions API — streaming chat',
  },
  'openai-responses-v1': {
    adapter_id: 'openai-responses-v1',
    version: '1.0.0',
    display_name: 'OpenAI Responses',
    family: 'chat',
    auth: { kind: 'bearer', header_name: 'Authorization' },
    relative_endpoints: {
      responses: '/v1/responses',
    },
    supports_custom_thinking_tiers: true,
    description: 'OpenAI Responses API — streaming responses',
  },
  'anthropic-messages-v1': {
    adapter_id: 'anthropic-messages-v1',
    version: '1.0.0',
    display_name: 'Anthropic Messages',
    family: 'chat',
    auth: { kind: 'header_api_key', header_name: 'x-api-key' },
    relative_endpoints: {
      messages: '/v1/messages',
    },
    supports_custom_thinking_tiers: false,
    description: 'Anthropic Messages API — streaming messages',
  },
  'gemini-chat-v1': {
    adapter_id: 'gemini-chat-v1',
    version: '1.0.0',
    display_name: 'Gemini',
    family: 'chat',
    auth: { kind: 'header_api_key', header_name: 'x-goog-api-key' },
    relative_endpoints: {
      generateContent: '/v1beta/models/{model}:generateContent',
      streamGenerateContent: '/v1beta/models/{model}:streamGenerateContent',
    },
    supports_custom_thinking_tiers: false,
    description: 'Gemini generateContent API — streaming chat',
  },
};

/**
 * 协议族判定的唯一入口：按协议 id 判断是不是对话协议。
 *
 * Hub 弹层据此在「生成模型目录 / 对话模型目录」之间选择数据源；消费端不得另建 id 清单。
 * 生成侧协议 id 是接口格式 id（2026-10-27 起生成侧不再有代码适配器），恒返回 false。
 */
export const isChatProtocolAdapterId = (adapterId: ProtocolAdapterId): adapterId is ChatProtocolAdapterId =>
  ChatProtocolAdapterIdSchema.safeParse(adapterId).success;

/**
 * 该适配器能否承载某个思考档位（spec 37「思考档位」）。
 *
 * 内置档位由适配器翻译成各家参数，与协议字段值域无关；自定义档位要求该协议的档位字段
 * 接受自由字符串（`supports_custom_thinking_tiers`）。Hub 勾选、后端写入校验与目录投影
 * 共用本函数，避免三处各写一遍值域规则。
 */
export const canAdapterExpressThinkingTier = (adapter: ProtocolAdapter, tier: string): boolean =>
  isBuiltinThinkingTier(tier) || adapter.supports_custom_thinking_tiers === true;

/**
 * 对话协议 → 执行层对话适配器（`ChatAdapterId`）的**唯一映射**（spec 03 §1）。
 *
 * 自建对话模型记录自带的 `protocol_adapter_id` 是对话协议的唯一声明，运行时据此选择
 * 流式对话实现；Hub、Runtime Backend 与 Editor 不得各自维护并列映射表。
 * 非对话协议返回 null——调用方按"协议不是对话协议"显式失败，不静默回退。
 */
const CHAT_PROTOCOL_TO_CHAT_ADAPTER: Partial<Record<ProtocolAdapterId, ChatAdapterId>> = {
  'openai-chat-completions-v1': 'openai_chat',
  'openai-responses-v1': 'openai_responses',
  'anthropic-messages-v1': 'anthropic_messages',
  'gemini-chat-v1': 'gemini',
};

export const resolveChatAdapterIdFromProtocolAdapter = (
  protocolAdapterId: ProtocolAdapterId,
): ChatAdapterId | null => CHAT_PROTOCOL_TO_CHAT_ADAPTER[protocolAdapterId] ?? null;

// ---------------------------------------------------------------------------
// ProviderConnection
// ---------------------------------------------------------------------------

export const ProviderConnectionLifecycleSchema = z.enum(['enabled', 'disabled', 'retired']);
export type ProviderConnectionLifecycle = z.infer<typeof ProviderConnectionLifecycleSchema>;

export const ProviderConnectionSchema = z
  .object({
    connection_id: z.string().regex(/^up_conn_[a-z0-9][a-z0-9-_]*$/),
    display_name: z.string().min(1),
    /**
     * 迁移兼容遗留字段（2026-09-29 起连接不再承载接口类型预选）：接口类型只在「添加模型」
     * 时随模型记录配置（对话记录 `protocol_adapter_id` / 生成记录 `family_adapter_id`）。
     * 本字段仅为存量对话模型文件 v1/v2→v3 迁移回填保留读取（协议事实源此前在连接上）；
     * 新代码禁止写入与运行时读取，新创建的连接不携带该字段。待存量迁移全量完成后
     * 一次性删除本字段。
     */
    protocol_adapter_id: ProtocolAdapterIdSchema.optional(),
    base_url: z.string().regex(/^https:\/\//),
    credential_ref: z.string().min(1).optional(),
    credential_version: z.number().int().nonnegative().optional(),
    has_credential: z.boolean(),
    lifecycle: ProviderConnectionLifecycleSchema,
    revision: z.number().int().nonnegative(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .strict();

export type ProviderConnection = z.infer<typeof ProviderConnectionSchema>;

// ---------------------------------------------------------------------------
// ActiveRouteMap
// ---------------------------------------------------------------------------

/**
 * active route：`model_id → 接入记录 id`（spec 03 §6.2）。值语义为「active 接入目标」，
 * 取值只能是该模型自己的记录 id（`up_dep_` 前缀）。2026-10-19 起部署载体整体退场，接入目标
 * 不存在第二种形态（spec 03 §12 PC-14）。
 */
export const ActiveRouteMapSchema = z.record(
  z.string().min(1),
  z.string().regex(/^up_dep_[a-z0-9][a-z0-9-_]*$/),
);
export type ActiveRouteMap = z.infer<typeof ActiveRouteMapSchema>;

// ---------------------------------------------------------------------------
// Health & Validity
// ---------------------------------------------------------------------------

export const CONNECTION_HEALTH_STATUSES = [
  'unknown',
  'reachable',
  'network_error',
  'auth_rejected',
  'protocol_mismatch',
  'rate_limited',
  'remote_failure',
] as const;

export const ConnectionHealthStatusSchema = z.enum(CONNECTION_HEALTH_STATUSES);
export type ConnectionHealthStatus = z.infer<typeof ConnectionHealthStatusSchema>;

export const ConnectionHealthSchema = z
  .object({
    connection_id: z.string().min(1),
    status: ConnectionHealthStatusSchema,
    checked_at: z.string().nullable(),
    message: z.string().optional(),
  })
  .strict();
export type ConnectionHealth = z.infer<typeof ConnectionHealthSchema>;

// ---------------------------------------------------------------------------
// Cross-boundary DTOs
// ---------------------------------------------------------------------------

export const ProviderConnectionListResponseSchema = z
  .object({ connections: z.array(ProviderConnectionSchema) })
  .strict();
export type ProviderConnectionListResponse = z.infer<typeof ProviderConnectionListResponseSchema>;

export const ProviderConnectionResponseSchema = z
  .object({ connection: ProviderConnectionSchema })
  .strict();
export type ProviderConnectionResponse = z.infer<typeof ProviderConnectionResponseSchema>;

export const ProviderConnectionCredentialResponseSchema = z
  .object({
    connection: ProviderConnectionSchema,
    has_credential: z.boolean(),
    credential_ref: z.string().min(1).optional(),
  })
  .strict();
export type ProviderConnectionCredentialResponse = z.infer<typeof ProviderConnectionCredentialResponseSchema>;

export const ActiveRouteMapResponseSchema = z
  .object({ active_routes: ActiveRouteMapSchema })
  .strict();
export type ActiveRouteMapResponse = z.infer<typeof ActiveRouteMapResponseSchema>;

export const ActiveRouteResponseSchema = z
  .object({ model_id: z.string().min(1), deployment_id: z.string().regex(/^up_dep_[a-z0-9][a-z0-9-_]*$/).nullable() })
  .strict();
export type ActiveRouteResponse = z.infer<typeof ActiveRouteResponseSchema>;

export const ProviderConnectionOkResponseSchema = z.object({ ok: z.literal(true) }).strict();
export type ProviderConnectionOkResponse = z.infer<typeof ProviderConnectionOkResponseSchema>;

// ---------------------------------------------------------------------------
// BatchIntentSnapshot & ExecutionSnapshot
// ---------------------------------------------------------------------------

/**
 * BatchIntentSnapshot：PromptDock 一次提交的不可变用户意图快照（spec 45 §5.1 / runtime spec）。
 *
 * - 只承载用户意图：model_id、prompt、当前有效参数（params）、已解析且兼容的媒体引用（media_refs）、
 *   固定任务数 N 与固定任务成员（task_count / task_ids）、模型能力与参数投影版本（model_version）。
 * - reference_asset_ids 为参考区引用的画布资产溯源 id（产品 spec「复用」段：复用回填参考区需要
 *   资产身份而非仅媒体内容）；旧批次快照无此字段，复用回填按 media_refs fileKey 反查兜底。
 * - 禁止承载 Provider、连接、Base URL、Key、remote_model_id、协议 Override 或任一任务的 ExecutionSnapshot。
 * - model_version 语义为「模型能力与参数投影版本」（capability version，参考 docs/runtime/固定任务数批次提交与投影语义.md 的快照定义），
 *   由模型能力包投影派生，不是产品模型版本号。
 * - media_refs 与既有 `task-submit-media-input.ts` 的 MediaInput 类型对齐（AGENTS.md：禁止 z.record(z.unknown()) 泛化弱类型）。
 * - task_ids 为该批次固定任务成员（spec §5.1 固定任务成员）；task_count 与其长度一致，保留为显式冗余（提交受理契约按 N 原子校验）。
 */
export const BatchIntentSnapshotSchema = z
  .object({
    batch_id: z.string().min(1),
    model_id: z.string().min(1),
    model_version: z.string().min(1),
    prompt: z.string(),
    params: z.record(z.unknown()),
    media_refs: z.array(TaskSubmitMediaInputSchema).optional(),
    reference_asset_ids: z.array(z.string().min(1)).optional(),
    task_count: z.number().int().min(1).max(10),
    task_ids: z.array(z.string().min(1)).min(1).max(10),
    created_at: z.string(),
  })
  .strict()
  .refine(
    (value) => value.task_ids.length === value.task_count,
    { message: 'task_ids length must equal task_count (fixed task members, spec 45 §5.1)' },
  );
export type BatchIntentSnapshot = z.infer<typeof BatchIntentSnapshotSchema>;

/**
 * 快照冻结的协议身份与鉴权形态（2026-10-27 起执行链的唯一来源）。
 *
 * - `generation_format`：生成侧协议由**接口格式实体**声明，快照冻结格式 id、格式版本与
 *   声明的鉴权形状。格式之后被编辑/删除不影响在跑任务（与预设升级同一冻结语义）。
 * - `chat_adapter`：对话侧仍是代码内置适配器（对话族不实体化），冻结适配器 id、版本与鉴权。
 *
 * 鉴权形状必须进快照：执行链在提交、轮询、结果获取三处注入凭证，若在执行时现查格式，
 * 用户删除或改写格式就会改变在跑任务的传输语义。
 */
export const ExecutionProtocolSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('generation_format'),
      format_id: z.string().min(1),
      format_version: z.string().min(1),
      auth: AdapterAuthSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('chat_adapter'),
      adapter_id: ProtocolAdapterIdSchema,
      adapter_version: z.string().min(1),
      auth: AdapterAuthSchema,
    })
    .strict(),
]);
export type ExecutionProtocol = z.infer<typeof ExecutionProtocolSchema>;

/**
 * ExecutionSnapshot：Runtime Backend 在任务实际派发前按 active 接入目标解析并冻结的不可变快照
 * （spec 03 §8 / spec 45 §5.2 / runtime spec）。
 *
 * - 冻结连接身份与配置修订、协议身份与版本、鉴权形状、Base URL、remote_model_id、凭证版本引用、已解析 endpoint 与参数。
 * - `deployment_id` 语义为「active 接入记录 id」：其值即该模型的记录 id（2026-10-19 起部署载体退场，字段名沿用）。
 * - credential_lease 关联（spec 03 §5.3 Credential lease）：远端已受理后租约保留到任务终态；
 *   lease_state: 'active'（持有中）/ 'released'（任务终态后释放）。credential_ref 只承载不可逆引用，不承载明文 Key。
 * - 远端请求开始后，连接编辑、Key 轮换、接入切换或 Provider 退役不得改写本快照。
 */
export const ExecutionSnapshotSchema = z
  .object({
    snapshot_id: z.string().min(1),
    model_id: z.string().min(1),
    model_version: z.string().min(1),
    deployment_id: z.string().regex(/^up_dep_[a-z0-9][a-z0-9-_]*$/),
    connection_id: z.string().regex(/^up_conn_[a-z0-9][a-z0-9-_]*$/),
    connection_revision: z.number().int().nonnegative(),
    /** 协议身份与鉴权形状；2026-10-27 起新快照恒有值，缺省只出现在历史记录里 */
    protocol: ExecutionProtocolSchema.optional(),
    /**
     * @deprecated 历史快照的协议身份（生成 = 预设格式 id，对话 = 协议适配器 id）。
     *
     * 仅为读取已落库任务记录保留：新快照写 `protocol`，不再写本字段。读取侧通过
     * `resolveSnapshotProtocol` 统一回退，禁止在调用点各写一份。
     */
    adapter_id: ProtocolAdapterIdSchema.optional(),
    /** @deprecated 历史快照的适配器版本；与 `adapter_id` 同批保留，原因同上。 */
    adapter_version: z.string().min(1).optional(),
    base_url: z.string().regex(/^https:\/\//),
    remote_model_id: z.string().min(1),
    credential_ref: z.string().min(1).optional(),
    credential_version: z.number().int().nonnegative().optional(),
    credential_lease: z
      .object({
        lease_state: z.enum(['active', 'released']),
        connection_revision: z.number().int().nonnegative(),
        credential_version: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    resolved_endpoint: z.string().min(1),
    resolved_params: z.record(z.unknown()).optional(),
    created_at: z.string(),
  })
  .strict();
export type ExecutionSnapshot = z.infer<typeof ExecutionSnapshotSchema>;

// ---------------------------------------------------------------------------
// @deprecated 兼容导出（spec 03 废止字段的过渡保留）
// ---------------------------------------------------------------------------

/**
 * @deprecated TaskProviderOverride（{ providerId, keyId }）已随 spec 03 废止（PC-08）。
 * 原承载于 task-submit-request.ts，随「删除 override/until-x 双线传输字段」重构迁移至此
 * 仅为过渡兼容保留：backend task-submit-helpers.cts 的旧 until-x append 路径仍在消费。
 * 新链路以 BatchIntentSnapshot（提交时）+ ExecutionSnapshot（派发时）为准，禁止透传覆盖字段。
 * 待 Todo 6（Editor 旧主链替换）退役后与 task-submit-request.ts 一并删除。
 */
export const TaskProviderOverrideSchema = z
  .object({
    providerId: z.string(),
    keyId: z.string(),
  })
  .strict();
export type TaskProviderOverride = z.infer<typeof TaskProviderOverrideSchema>;
