import * as z from 'zod';
import type { ChatAdapterId } from './chat-contract';
import { isBuiltinThinkingTier } from './thinking-tier-contract';
import { TaskSubmitMediaInputSchema } from './task-submit-media-input';

/**
 * Provider 连接、协议适配与模型部署契约（contracts 层）
 *
 * 归属与口径对齐：
 * - spec 主口径：`docs/custom-providers/03-Provider连接、协议适配与模型部署主口径.md`
 *   - §3 ProtocolAdapter：内置、不可变、版本化；Endpoint/鉴权/轮询/结果/错误由适配器声明
 *   - §4 ProviderConnection：全局本机、地址+凭证、Base URL 规范化、Credential lease
 *     （连接级 `protocol_adapter_id` 已退役，仅为存量迁移保留读取，2026-09-29 起）
 *   - §6 ModelDeployment 与 active route：model_id + connection_id + remote_model_id；单值 active
 *   - §7/§8 状态与快照：连接/部署健康、ExecutionSnapshot 冻结
 * - spec 主口径：`docs/model-assets/45-PromptDock模型能力目录、Deployment与执行快照契约.md` v3
 *   - BatchIntentSnapshot（提交时）+ ExecutionSnapshot（派发时冻结）
 * - spec 主口径：`docs/provider-remote-apis/03-OpenAI-图像生成接口.md`
 * - 可执行契约 owner：packages/contracts
 */

// ---------------------------------------------------------------------------
// ProtocolAdapter
// ---------------------------------------------------------------------------

export const PROTOCOL_ADAPTER_IDS = [
  'openai-image-v1',
  'gemini-image-interactions-v1',
  'seedance-2-0-v1',
  'veo-v1',
  'kling-v1',
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
 *
 * 用户连接只提交一个 API Key 明文；注入位置完全由适配器声明，连接不得自行选择
 * Bearer / query / header 形状（spec 03 §4.3）。
 */
export const ADAPTER_AUTH_KINDS = ['bearer', 'header_api_key'] as const;
export const AdapterAuthKindSchema = z.enum(ADAPTER_AUTH_KINDS);
export type AdapterAuthKind = z.infer<typeof AdapterAuthKindSchema>;

export const AdapterAuthSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('bearer'),
      header_name: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('header_api_key'),
      header_name: z.string().min(1),
    })
    .strict(),
]);
export type AdapterAuth = z.infer<typeof AdapterAuthSchema>;

/**
 * 按适配器声明的鉴权形态，把凭证明文渲染成最终请求头。
 *
 * 这是「凭证 → 请求头」的唯一实现点：执行链（提交与轮询）必须调用本函数，
 * 不得各自硬编码 `Bearer` 前缀或 header 名。
 */
export const buildAdapterAuthHeader = (
  auth: AdapterAuth,
  secret: string,
): { name: string; value: string } =>
  auth.kind === 'bearer'
    ? { name: auth.header_name, value: `Bearer ${secret}` }
    : { name: auth.header_name, value: secret };

/**
 * 适配器族（spec 03 §1）：生成能力进 PromptDock 可执行目录；对话能力只作为 agent 形态的
 * 语言模型来源、不进 PromptDock 目录。协议族只由适配器自身声明，消费端不得按 id 硬编码。
 */
export const PROTOCOL_ADAPTER_FAMILIES = ['generation', 'chat'] as const;
export const ProtocolAdapterFamilySchema = z.enum(PROTOCOL_ADAPTER_FAMILIES);
export type ProtocolAdapterFamily = z.infer<typeof ProtocolAdapterFamilySchema>;

/**
 * ProtocolAdapter：系统内置、不可变、版本化的官方协议执行规则（spec 03 §3）。
 *
 * `relative_endpoints` 是该协议**唯一**的 endpoint 事实源（键 = 语义化的 endpoint 名，
 * 值 = 相对路径模板，可含 `{model}` / `{id}` / `{operation_name}` 占位符）。
 *
 * ⚠️ 未完成的收口（spec 03 验收 PC-02「最终 endpoint 只能由适配器相对路径构造」）：
 * 当前模型能力包仍在自己的 `api_defaults.endpoint` / `payload_rules["api.endpoint"]` /
 * `polling_strategy.request.url_template` 里重复声明这些相对路径，执行链消费的是包内的值，
 * 而非本表的派生结果（`adapter-registry.cts` 的 `buildRequestUrl` / `resolveRelativeEndpoint`
 * 在生产代码中零调用方）。因此本表目前是「声明 + 文档」，不是运行时事实源。
 * 待办：① 打包期校验「包内 endpoint 必须是本模型所属适配器声明的路径之一」；
 *       ② 把执行链的 endpoint 解析改为按 endpoint key 从本表派生。
 */
export const ProtocolAdapterSchema = z
  .object({
    adapter_id: ProtocolAdapterIdSchema,
    version: z.string().min(1),
    display_name: z.string().min(1),
    /** 协议族：generation = 生成能力（进 PromptDock 目录）；chat = 对话能力（不进目录） */
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

export const ADAPTER_REGISTRY: Record<ProtocolAdapterId, ProtocolAdapter> = {
  'openai-image-v1': {
    adapter_id: 'openai-image-v1',
    version: '1.0.0',
    display_name: 'OpenAI Image',
    family: 'generation',
    auth: { kind: 'bearer', header_name: 'Authorization' },
    relative_endpoints: {
      generations: '/v1/images/generations',
      edits: '/v1/images/edits',
    },
    description: 'OpenAI Images API (gpt-image series) — sync generations/edits',
  },
  'gemini-image-interactions-v1': {
    adapter_id: 'gemini-image-interactions-v1',
    version: '1.0.0',
    display_name: 'Gemini Image',
    family: 'generation',
    auth: { kind: 'header_api_key', header_name: 'x-goog-api-key' },
    relative_endpoints: {
      interactions: '/v1beta/interactions',
    },
    description: 'Gemini Image (Interactions API) — sync image generation/editing',
  },
  'seedance-2-0-v1': {
    adapter_id: 'seedance-2-0-v1',
    version: '1.0.0',
    display_name: 'Seedance 2.0',
    family: 'generation',
    auth: { kind: 'bearer', header_name: 'Authorization' },
    relative_endpoints: {
      tasks: '/api/v3/contents/generations/tasks',
      taskById: '/api/v3/contents/generations/tasks/{id}',
    },
    description: 'Seedance 2.0 video generation (async polling)',
  },
  'veo-v1': {
    adapter_id: 'veo-v1',
    version: '1.0.0',
    display_name: 'Veo',
    family: 'generation',
    auth: { kind: 'header_api_key', header_name: 'x-goog-api-key' },
    relative_endpoints: {
      predictLongRunning: '/v1beta/models/{model}:predictLongRunning',
      operation: '/v1beta/{operation_name}',
    },
    description: 'Veo video generation (LRO async)',
  },
  'kling-v1': {
    adapter_id: 'kling-v1',
    version: '1.0.0',
    display_name: 'Kling',
    family: 'generation',
    auth: { kind: 'bearer', header_name: 'Authorization' },
    relative_endpoints: {
      // 官方「新设计标准」（版本在 path，官方推荐）：无 /v1 前缀，模型版本是 path 的一段。
      // 与旧设计标准（/v1/videos/text2video + body.model_name）互斥，本适配器只承载新标准。
      // spec：docs/provider-remote-apis/07-Kling-视频生成接口.md §5。
      textToVideo: '/text-to-video/kling-3.0',
      imageToVideo: '/image-to-video/kling-3.0',
      omniVideo: '/omni-video/kling-3.0-omni',
      // 新标准统一异步查询端点：task_ids / external_task_ids 二选一，批量以英文逗号分隔。
      taskById: '/tasks?task_ids={id}',
      taskByExternalId: '/tasks?external_task_ids={id}',
    },
    description: 'Kling AI video generation (new design standard, async task query)',
  },
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
 * 协议族判定的唯一入口：按适配器 id 判断是不是对话协议。
 *
 * Hub 弹层据此在「生成模型目录 / 对话模型目录」之间选择数据源；消费端不得另建 id 清单。
 */
export const isChatProtocolAdapterId = (adapterId: ProtocolAdapterId): boolean =>
  ADAPTER_REGISTRY[adapterId].family === 'chat';

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
 * 对话协议适配器 id 清单与 schema：自建对话模型记录 `protocol_adapter_id` 的值域
 * （2026-09-26 起协议归属模型级）。
 *
 * 与下方 `CHAT_PROTOCOL_TO_CHAT_ADAPTER` 的键集必须一致（一致性由 contracts 测试钉住）；
 * 消费端不得各自另列对话协议清单。
 */
export const CHAT_PROTOCOL_ADAPTER_IDS = [
  'openai-chat-completions-v1',
  'openai-responses-v1',
  'anthropic-messages-v1',
  'gemini-chat-v1',
] as const;

export const ChatProtocolAdapterIdSchema = z.enum(CHAT_PROTOCOL_ADAPTER_IDS);
export type ChatProtocolAdapterId = z.infer<typeof ChatProtocolAdapterIdSchema>;

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
// ModelDeployment & ActiveRouteMap
// ---------------------------------------------------------------------------

/**
 * ModelDeployment：一个**已装能力包**产品 `model_id` 在某个服务商连接下的一次接入
 * （spec 03 §6.1「Deployment 与自建模型记录」）。
 *
 * 自建模型（对话 / 生成）不走本实体：它们是服务商作用域单记录（能力属性与接入归属一体，
 * 见 `custom-chat-model-contract.ts` / `custom-generation-model-contract.ts`），不再产生
 * Deployment。本实体只服务已装能力包模型的接入。
 *
 * 2026-09-25 起 `enabled_thinking_tiers` / `default_thinking_tier` 已从本实体退役
 * （对话族没有内置包，档位只随自建对话模型记录走，spec 37 v4.0.0）。
 */
export const ModelDeploymentSchema = z
  .object({
    deployment_id: z.string().regex(/^up_dep_[a-z0-9][a-z0-9-_]*$/),
    model_id: z.string().min(1),
    connection_id: z.string().min(1),
    remote_model_id: z.string().min(1),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .strict();

export type ModelDeployment = z.infer<typeof ModelDeploymentSchema>;

/**
 * active route：`model_id → 接入记录 id`（spec 03 §6.2）。值语义为「active 接入目标」——
 * 已装包模型指向其 ModelDeployment，自建模型指向其模型记录（两类 id 同用 `up_dep_` 前缀，
 * 因此解析侧按 model_id 在两族接入记录中定位目标）。
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

export const DEPLOYMENT_VALIDITY_STATUSES = ['valid', 'invalid'] as const;
export const DeploymentValidityStatusSchema = z.enum(DEPLOYMENT_VALIDITY_STATUSES);
export type DeploymentValidityStatus = z.infer<typeof DeploymentValidityStatusSchema>;

export const DeploymentValiditySchema = z
  .object({
    deployment_id: z.string().min(1),
    status: DeploymentValidityStatusSchema,
    reason: z.string().optional(),
    checked_at: z.string(),
  })
  .strict();
export type DeploymentValidity = z.infer<typeof DeploymentValiditySchema>;

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

export const ModelDeploymentListResponseSchema = z
  .object({ deployments: z.array(ModelDeploymentSchema) })
  .strict();
export type ModelDeploymentListResponse = z.infer<typeof ModelDeploymentListResponseSchema>;

export const ModelDeploymentResponseSchema = z
  .object({ deployment: ModelDeploymentSchema })
  .strict();
export type ModelDeploymentResponse = z.infer<typeof ModelDeploymentResponseSchema>;

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

export const ModelDeploymentOkResponseSchema = z.object({ ok: z.literal(true) }).strict();
export type ModelDeploymentOkResponse = z.infer<typeof ModelDeploymentOkResponseSchema>;

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
 * ExecutionSnapshot：Runtime Backend 在任务实际派发前按 active 接入目标解析并冻结的不可变快照
 * （spec 03 §8 / spec 45 §5.2 / runtime spec）。
 *
 * - 冻结连接身份与配置修订、适配器身份与版本、Base URL、remote_model_id、鉴权策略与凭证版本引用、已解析 endpoint 与参数。
 * - `deployment_id` 语义为「active 接入记录 id」：已装包模型为 ModelDeployment id，自建模型为其模型记录 id（两类 id 同用 `up_dep_` 前缀）。
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
    adapter_id: ProtocolAdapterIdSchema,
    adapter_version: z.string().min(1),
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
