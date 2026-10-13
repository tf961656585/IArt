/**
 * Agent Contract
 *
 * Agent 域跨进程共享数据模型：会话、消息、规划、本地发送留痕、工具调用记录，
 * 以及 `agent:*` WebSocket 协议。
 *
 * 语义事实源:
 * - docs/agent/03-会话存储与IPC契约.md（会话归属、消息/规划/留痕持久化语义）
 * - docs/agent/04-执行管道与WS协议.md（`agent:*` 流式主链、工具集合投影与循环语义）
 *
 * 边界:
 * - 消息内容复用 chat 域语言推理底座共享类型 `ChatMessageContent`，不另立并列内容模型。
 * - `tool_call` / `tool_result` 消息体与工具调用记录自 2026-09-18 批次起产生数据；
 *   已存历史不含该两形状，无需迁移。
 */

import * as z from 'zod';
import { ChatMessageContentSchema, InternalToolCallSchema } from './chat-contract';
import { AgentToolKindSchema } from './agent-tools-contract';

// ────────────────────────────────────────────
// 1. 会话身份与默认配置
// ────────────────────────────────────────────

/** 审批规则（spec 05「审批规则」）：`confirm` 需用户确认后派发，`yolo` 有效即直接派发。 */
export const AgentApprovalModeSchema = z.enum(['confirm', 'yolo']);

export type AgentApprovalMode = z.infer<typeof AgentApprovalModeSchema>;

/**
 * agent 会话记录。
 *
 * - 会话 1:1 从属 Agent 节点（`nodeId` 锚点），`agentSessionId` 是会话稳定身份。
 * - 会话不经 `graphId` 二级归属（归属由节点推导），因此本记录不含 graphId。
 * - `modelId` 为语言模型 `model_id` 直显值；`thinkingTier` 用 `'off'` 表示不思考。
 * - `messageCount` 为会话正式消息条数投影，由存储写入端维护，调用方只读。
 * - `lastMessageAt` 为最后一条正式消息的时间（epoch ms），零消息会话为 null；
 *   由存储写入端维护（消息追加时同事务推进），调用方只读。
 *   语义即「最近一次对话发生在何时」——与 `updatedAt`（含配置变更）是两回事：
 *   改思考档位 / 审批规则会抬升 `updatedAt`，但不移动 `lastMessageAt`。
 */
export const AgentSessionRecordSchema = z.object({
  agentSessionId: z.string(),
  nodeId: z.string(),
  modelId: z.string(),
  thinkingTier: z.string(),
  approvalMode: AgentApprovalModeSchema,
  title: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  messageCount: z.number(),
  lastMessageAt: z.number().nullable(),
});

export type AgentSessionRecord = z.infer<typeof AgentSessionRecordSchema>;

// ────────────────────────────────────────────
// 2. 消息、规划与消息结构域
// ────────────────────────────────────────────

export const AgentMessageRoleSchema = z.enum(['user', 'assistant', 'system']);

export type AgentMessageRole = z.infer<typeof AgentMessageRoleSchema>;

/** 规划分步条目状态。 */
export const AgentPlanStepSchema = z.object({
  stepId: z.string(),
  order: z.number(),
  title: z.string(),
  status: z.enum(['pending', 'dispatching', 'done', 'failed', 'skipped']),
});

export type AgentPlanStep = z.infer<typeof AgentPlanStepSchema>;

/** 规划：随助手消息持久化，作为消息结构的独立域，不单列表。 */
export const AgentPlanSchema = z.object({
  steps: z.array(AgentPlanStepSchema),
});

export type AgentPlan = z.infer<typeof AgentPlanSchema>;

/**
 * 消息结构域判别联合（按 `kind` 判别）。
 *
 * - `chat`：对话内容，复用 `ChatMessageContent`（纯文本或多模态 part）。
 * - `tool_call`：工具调用提案（spec 04「工具调用编排」）。提案发出即写入；
 *   执行状态由工具调用记录承载，不在消息体内重复。
 * - `tool_result`：工具调用终态。`status: 'skipped'` 覆盖未执行结算（未勾选或未列入提交
 *   映射的条目、批级超时未提交、用户整轮驳回——来源经 `errorSummary` 区分）。
 */
export const AgentMessageBodySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('chat'),
    content: ChatMessageContentSchema,
  }),
  z.object({
    kind: z.literal('tool_call'),
    toolCallId: z.string(),
    toolName: z.string(),
    toolKind: AgentToolKindSchema,
    /** 目标生成模型；加工类工具为 null。 */
    modelId: z.string().nullable(),
    argsJson: z.string(),
  }),
  z.object({
    kind: z.literal('tool_result'),
    toolCallId: z.string(),
    /** 工具名（与会话内 tool_call 消息配对；历史投影为模型上下文 tool 消息的依据）。 */
    toolName: z.string(),
    status: z.enum(['succeeded', 'failed', 'skipped', 'cancelled']),
    summary: z.string(),
    assetIds: z.array(z.string()),
    errorSummary: z.string().nullable(),
  }),
]);

export type AgentMessageBody = z.infer<typeof AgentMessageBodySchema>;

/**
 * agent 正式消息记录（消息表行投影）。
 *
 * - `seq` 为会话内消息序号，由存储写入端分配，读取按 seq 升序。
 * - `requestId` 指向该消息所属发送请求；`system` 类消息无请求归属时为 null。
 * - `plan` 随助手消息持久化，非助手消息或未产出规划时为 null。
 * - `isPartial` 标记完成/中断分支落下的不完全消息。
 */
export const AgentMessageRecordSchema = z.object({
  agentSessionId: z.string(),
  seq: z.number(),
  role: AgentMessageRoleSchema,
  requestId: z.string().nullable(),
  body: AgentMessageBodySchema,
  plan: AgentPlanSchema.nullable(),
  createdAt: z.number(),
  isPartial: z.boolean(),
});

export type AgentMessageRecord = z.infer<typeof AgentMessageRecordSchema>;

/** 消息追加入参：正式记录去掉 `seq`（序号由存储写入端分配）。 */
export const AgentMessageAppendParamsSchema = AgentMessageRecordSchema.omit({ seq: true });

export type AgentMessageAppendParams = z.infer<typeof AgentMessageAppendParamsSchema>;

// ────────────────────────────────────────────
// 3. 本地发送留痕
// ────────────────────────────────────────────

/**
 * 该轮不可变请求快照（发送时冻结）。
 *
 * 语义事实源 spec 03「会话归属」：新发送/手动重试重新解析当前活动部署，
 * 历史快照不得被会话默认配置改写。
 */
export const AgentRequestSnapshotSchema = z.object({
  modelId: z.string(),
  thinkingTier: z.string(),
  approvalMode: AgentApprovalModeSchema,
  referenceAssetIds: z.array(z.string()),
  submittedAt: z.number(),
});

export type AgentRequestSnapshot = z.infer<typeof AgentRequestSnapshotSchema>;

/**
 * 本地发送留痕记录。
 *
 * 保护用户意图：先于 Backend 受理可见，不等同于正式消息历史；
 * 不复制正式消息事实源，恢复会话时按 agentSessionId 读取留痕。
 *
 * 生命周期故意独立于会话创建：留痕在受理之前写入（首条消息此时既无节点也无会话行），
 * 用于手动重试与恢复，因此不与会话共享外键级联语义——存储侧不得为该表建立指向会话的
 * 级联外键（否则首条消息留痕写入必然 FK 失败）。
 */
export const AgentSendRecordSchema = z.object({
  recordId: z.string(),
  agentSessionId: z.string(),
  /** 留痕宿主 Agent 节点；首条消息在受理前写入时为 null，受理创建节点后由后续留痕携带。 */
  nodeId: z.string().nullable(),
  requestId: z.string(),
  createdAt: z.number(),
  content: ChatMessageContentSchema,
  referenceAssetIds: z.array(z.string()),
  snapshot: AgentRequestSnapshotSchema,
});

export type AgentSendRecord = z.infer<typeof AgentSendRecordSchema>;

// ────────────────────────────────────────────
// 4. 工具调用记录
// ────────────────────────────────────────────

/**
 * 工具调用记录：派生 GenerationBatch/task 引用、产物资产引用、状态与失败摘要投影。
 *
 * 只保存派生引用与摘要，不复制运行域任务/资产事实源。
 *
 * 状态语义（spec 04/05）：
 * - `proposed`：提案已发出，`confirm` 档进入批量审批面板等待提交 / `yolo` 档随即派发；
 * - `dispatching` / `running`：已决裁，派生批次受理中 / 执行中（含阻塞等待生成终态）；
 * - `succeeded` / `failed` / `cancelled`：执行终态；
 * - `skipped`：未执行结算（未勾选——`execute: false` 或未列入提交映射 / 批级超时未提交关闭 /
 *   用户整轮驳回——来源经 `errorSummary` 区分）。
 *
 * 生成类调用持 `batchId` + `taskIds`；加工类无派生批次（两者为空），产物资产走 `assetIds`。
 */
export const AGENT_TOOL_CALL_STATUSES = [
  'proposed',
  'dispatching',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'skipped',
] as const;

export const AgentToolCallStatusSchema = z.enum(AGENT_TOOL_CALL_STATUSES);

export type AgentToolCallStatus = z.infer<typeof AgentToolCallStatusSchema>;

export const AgentToolCallRecordSchema = z.object({
  toolCallId: z.string(),
  agentSessionId: z.string(),
  seq: z.number(),
  toolName: z.string(),
  toolKind: AgentToolKindSchema,
  /** 目标生成模型；加工类工具为 null。 */
  modelId: z.string().nullable(),
  status: AgentToolCallStatusSchema,
  batchId: z.string().nullable(),
  taskIds: z.array(z.string()),
  assetIds: z.array(z.string()),
  errorSummary: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type AgentToolCallRecord = z.infer<typeof AgentToolCallRecordSchema>;

/** 工具调用记录追加入参：`seq` 由存储写入端分配。 */
export const AgentToolCallAppendParamsSchema = AgentToolCallRecordSchema.omit({ seq: true });

export type AgentToolCallAppendParams = z.infer<typeof AgentToolCallAppendParamsSchema>;

/** 工具调用记录更新入参：按 `toolCallId` 定位，只允许改状态、派生引用与失败摘要（项目路由由 storage 包装层携带）。 */
export const AgentToolCallUpdateParamsSchema = z.object({
  agentSessionId: z.string(),
  toolCallId: z.string(),
  status: AgentToolCallStatusSchema,
  batchId: z.string().nullable().optional(),
  taskIds: z.array(z.string()).optional(),
  assetIds: z.array(z.string()).optional(),
  errorSummary: z.string().nullable().optional(),
});

export type AgentToolCallUpdateParams = z.infer<typeof AgentToolCallUpdateParamsSchema>;

// ────────────────────────────────────────────
// 5. WS 消息类型常量（agent 执行管道）
// ────────────────────────────────────────────

export const AGENT_WS_MESSAGE_TYPE = Object.freeze({
  // Client → Server
  SUBMIT_PROMPT: 'agent:submit_prompt',
  CANCEL: 'agent:cancel',
  TOOL_DECISION: 'agent:tool_decision',
  // Server → Client
  ACCEPTED: 'agent:accepted',
  TOKEN: 'agent:token',
  ASSISTANT_MESSAGE: 'agent:assistant_message',
  TOOL_CALL: 'agent:tool_call',
  TOOL_RESULT: 'agent:tool_result',
  COMPLETE: 'agent:complete',
  ERROR: 'agent:error',
} as const);

export type AgentWsMessageType = (typeof AGENT_WS_MESSAGE_TYPE)[keyof typeof AGENT_WS_MESSAGE_TYPE];

/**
 * agent 执行失败码。
 *
 * 保持通用（不绑定具体厂商/模型错误文案）：具体失败原因经 `message` 承载，
 * 且不得触发自动重试、自动补位或 fallback。
 */
export const AGENT_WS_ERROR_CODES = [
  'model_unavailable',
  'invalid_request',
  'execution_failed',
  'cancelled',
] as const;

export const AgentWsErrorCodeSchema = z.enum(AGENT_WS_ERROR_CODES);

export type AgentWsErrorCode = z.infer<typeof AgentWsErrorCodeSchema>;

// ────────────────────────────────────────────
// 6. Client → Server WS 消息 Schema
// ────────────────────────────────────────────

/**
 * 会话引用资产简报（Editor 从画布资产投影随提交携带）。
 *
 * 用途：Backend 拼进模型上下文的「会话资产清单」（模型据此以 `assetId` 引用资产）
 * + 工具参数 `reference_asset_ids` 解析为生成批次 `media_inputs` 的依据。
 * 只携带引用与展示所需的显式子集，不承载资产事实源（资产事实源仍在项目库）。
 */
export const AgentReferenceAssetBriefSchema = z.object({
  assetId: z.string(),
  mediaType: z.enum(['image', 'video', 'audio']),
  /** 资产原始媒体 URL（local-media 作用域地址），供媒体输入物化与加工工具定位源文件。 */
  url: z.string(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  durationMs: z.number().nullable(),
  /** Editor 侧一句话摘要（文件名/描述），进模型上下文资产清单。 */
  summary: z.string(),
});

export type AgentReferenceAssetBrief = z.infer<typeof AgentReferenceAssetBriefSchema>;

/**
 * `agent:submit_prompt` — Editor 发起一轮发送（首条创建节点由提交受理，续作绑定既有 agentSessionId）。
 *
 * `projectPath` 与 storage IPC / `runtime:read-agent-messages` 入参同口径：Backend 受理时据此
 * 定位项目库并加载该会话正式历史，禁止靠「唯一已打开项目」猜测归属。
 */
export const AgentSubmitPromptSchema = z.object({
  type: z.literal(AGENT_WS_MESSAGE_TYPE.SUBMIT_PROMPT),
  requestId: z.string(),
  agentSessionId: z.string(),
  projectPath: z.string(),
  modelId: z.string(),
  thinkingTier: z.string(),
  approvalMode: AgentApprovalModeSchema,
  content: ChatMessageContentSchema,
  referenceAssetIds: z.array(z.string()),
  /** 引用资产简报；旧版提交载荷无此字段，按空清单收敛。 */
  referenceAssets: z.array(AgentReferenceAssetBriefSchema).default([]),
});

export type AgentSubmitPrompt = z.infer<typeof AgentSubmitPromptSchema>;

/**
 * `agent:cancel` — 取消命令（spec 04「工具调用循环语义」、spec 05「Yolo 语义」）。
 *
 * `toolCallId` 为 null（缺省按 null 收敛，旧版载荷无此字段）表示整请求取消：中止当前请求，
 * 已受理 partial 按既有 partial 语义收口；携带 `toolCallId` 表示单条取消：只中止该条目的
 * 执行与派生任务（走生成任务取消），该条目以 `cancelled` 结算并回灌模型，同轮其余条目与
 * 整轮继续。单条取消只作用于在途执行条目，未命中时 Backend 留痕忽略。
 */
export const AgentCancelSchema = z.object({
  type: z.literal(AGENT_WS_MESSAGE_TYPE.CANCEL),
  agentSessionId: z.string(),
  requestId: z.string(),
  toolCallId: z.string().nullable().default(null),
});

export type AgentCancel = z.infer<typeof AgentCancelSchema>;

/**
 * `agent:tool_decision` — Editor 对 `confirm` 档提案**批**的决裁（spec 05「Confirm 决裁流程」）。
 *
 * 批量形态（2026-09-20 批次）：整批工具调用提案在审批面板上逐条勾选后以批为单位提交，
 * 一条消息承载本批决裁结果，两个变体按 `decision` 判别：
 * - `submit`：携带本批全部未决条目的执行/不执行映射 `decisions`（完整映射，非增量）——
 *   `execute: true` 的条目派发执行，`execute: false` 的条目与**未列入映射**的未决条目
 *   一律按不执行结算（`skipped`，`errorSummary` 区分来源）；
 * - `reject_round`：整轮驳回——Backend 按 `requestId` 一次性结算该批全部未决（未派发）条目，
 *   均按不执行结算；已派发/在途条目不受影响，不带 `decisions`。
 *
 * 跨字段不变量（未列出条目按不执行结算、条目 `toolCallId` 归属本会话本批）由 Backend
 * handler 在 `.parse()` 后校验并拒绝非法组合，schema 只保证形状。提案批超时由 Backend 侧
 * 裁定，整批以 `skipped` 状态结算（`errorSummary` 区分来源），不经本消息。
 * 编辑参数暂缺（spec 05 变更记录 2026-09-18）。
 */

/** 批量决裁中的单条决策条目：`execute: true` 派发执行，`false` 按不执行结算。 */
export const AgentToolDecisionItemSchema = z.object({
  toolCallId: z.string(),
  execute: z.boolean(),
});

export type AgentToolDecisionItem = z.infer<typeof AgentToolDecisionItemSchema>;

export const AgentToolDecisionSchema = z.discriminatedUnion('decision', [
  z.object({
    type: z.literal(AGENT_WS_MESSAGE_TYPE.TOOL_DECISION),
    requestId: z.string(),
    agentSessionId: z.string(),
    decision: z.literal('submit'),
    /** 本批全部未决条目的完整执行/不执行映射；未列出的未决条目按不执行结算。 */
    decisions: z.array(AgentToolDecisionItemSchema).min(1),
  }),
  z.object({
    type: z.literal(AGENT_WS_MESSAGE_TYPE.TOOL_DECISION),
    requestId: z.string(),
    agentSessionId: z.string(),
    decision: z.literal('reject_round'),
  }),
]);

export type AgentToolDecision = z.infer<typeof AgentToolDecisionSchema>;

/**
 * Client → Server 消息联合。
 *
 * 此处用 `z.union` 而非按 `type` 的 `z.discriminatedUnion`：`agent:tool_decision` 的
 * `submit` / `reject_round` 两个变体共享同一 `type` 字面量，而 zod 判别联合禁止判别值
 * 重复（重复即构造期抛错）。批内判别由 `AgentToolDecisionSchema` 按 `decision` 承担。
 */
export const AgentClientMessageSchema = z.union([
  AgentSubmitPromptSchema,
  AgentCancelSchema,
  AgentToolDecisionSchema,
]);

export type AgentClientMessage = z.infer<typeof AgentClientMessageSchema>;

// ────────────────────────────────────────────
// 7. Server → Client WS 消息 Schema
// ────────────────────────────────────────────

/** `agent:accepted` — Backend 受理该轮请求（user 消息据此进正式历史）。 */
export const AgentAcceptedSchema = z.object({
  type: z.literal(AGENT_WS_MESSAGE_TYPE.ACCEPTED),
  requestId: z.string(),
  agentSessionId: z.string(),
});

export type AgentAccepted = z.infer<typeof AgentAcceptedSchema>;

/** `agent:token` — 流式文本增量。 */
export const AgentTokenSchema = z.object({
  type: z.literal(AGENT_WS_MESSAGE_TYPE.TOKEN),
  requestId: z.string(),
  agentSessionId: z.string(),
  delta: z.string(),
});

export type AgentToken = z.infer<typeof AgentTokenSchema>;

/**
 * `agent:assistant_message` — 工具循环中间轮的助手消息定稿（spec 04「工具调用循环语义」）。
 *
 * 仅当该轮助手消息携带 toolCalls（中间轮）时发出，Editor 据此落一条带工具调用的 assistant
 * 消息；最后一轮仍由 `agent:complete` 承载（纯对话路径不产生本事件，协议向后兼容）。
 */
export const AgentAssistantMessageEventSchema = z.object({
  type: z.literal(AGENT_WS_MESSAGE_TYPE.ASSISTANT_MESSAGE),
  requestId: z.string(),
  agentSessionId: z.string(),
  content: ChatMessageContentSchema,
  toolCalls: z.array(InternalToolCallSchema),
});

export type AgentAssistantMessageEvent = z.infer<typeof AgentAssistantMessageEventSchema>;

/**
 * `agent:tool_call` — 工具调用提案与执行状态（spec 04「工具调用编排」）。
 *
 * 提案发出（`proposed`）即写入会话正式历史（Editor 据此落 `tool_call` 消息体与工具调用记录）；
 * `dispatching` / `running` 为执行中的状态推进。`proposalExpiresAt` 仅 `confirm` 档待决提案
 * 携带（超时裁定基准，epoch ms）；超时为**批级**——同一批内所有条目同值（整批共享一个
 * 截止时间，超时未提交即整批按不执行结算）；`yolo` 直派发为 null。
 */
export const AgentToolCallEventSchema = z.object({
  type: z.literal(AGENT_WS_MESSAGE_TYPE.TOOL_CALL),
  requestId: z.string(),
  agentSessionId: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  toolKind: AgentToolKindSchema,
  modelId: z.string().nullable(),
  argsJson: z.string(),
  status: z.enum(['proposed', 'dispatching', 'running']),
  proposalExpiresAt: z.number().nullable(),
});

export type AgentToolCallEvent = z.infer<typeof AgentToolCallEventSchema>;

/** 工具产物资产引用（终态随结果携带，供会话内产物卡片渲染；不复制资产事实源）。 */
export const AgentToolResultAssetSchema = z.object({
  assetId: z.string(),
  mediaType: z.enum(['image', 'video', 'audio']),
  url: z.string().nullable(),
  thumbnailUrl: z.string().nullable(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  durationMs: z.number().nullable(),
});

export type AgentToolResultAsset = z.infer<typeof AgentToolResultAssetSchema>;

/**
 * `agent:tool_result` — 工具调用终态（spec 04「工具调用循环语义」）。
 *
 * `status: 'skipped'` 覆盖全部未执行结算（未勾选或未列入提交映射、批级超时未提交、整轮驳回；
 * 来源经 `errorSummary` 区分）；
 * `batchId` / `taskIds` 为生成类派生引用（加工类为 null/空，Editor 据此补全工具调用记录）；
 * `assets` 与 `assetIds` 同序，前者供卡片渲染、后者为稳定引用。
 */
export const AgentToolResultEventSchema = z.object({
  type: z.literal(AGENT_WS_MESSAGE_TYPE.TOOL_RESULT),
  requestId: z.string(),
  agentSessionId: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  status: z.enum(['succeeded', 'failed', 'skipped', 'cancelled']),
  summary: z.string(),
  assetIds: z.array(z.string()),
  assets: z.array(AgentToolResultAssetSchema),
  batchId: z.string().nullable(),
  taskIds: z.array(z.string()),
  errorSummary: z.string().nullable(),
});

export type AgentToolResultEvent = z.infer<typeof AgentToolResultEventSchema>;

/** `agent:complete` — 助手消息终态定稿内容，Editor 以此落库。 */
export const AgentCompleteSchema = z.object({
  type: z.literal(AGENT_WS_MESSAGE_TYPE.COMPLETE),
  requestId: z.string(),
  agentSessionId: z.string(),
  content: ChatMessageContentSchema,
});

export type AgentComplete = z.infer<typeof AgentCompleteSchema>;

/**
 * `agent:error` — 该轮失败收口。
 *
 * `partialContent` 非空表示已有可用部分内容，Editor 以 `isPartial: true` 落库；
 * 为 null 表示该轮无内容可落（本地发送留痕保留，等待用户手动重试）。
 */
export const AgentErrorSchema = z.object({
  type: z.literal(AGENT_WS_MESSAGE_TYPE.ERROR),
  requestId: z.string(),
  agentSessionId: z.string(),
  code: AgentWsErrorCodeSchema,
  message: z.string(),
  partialContent: ChatMessageContentSchema.nullable(),
});

export type AgentError = z.infer<typeof AgentErrorSchema>;

export const AgentServerMessageSchema = z.discriminatedUnion('type', [
  AgentAcceptedSchema,
  AgentTokenSchema,
  AgentAssistantMessageEventSchema,
  AgentToolCallEventSchema,
  AgentToolResultEventSchema,
  AgentCompleteSchema,
  AgentErrorSchema,
]);

export type AgentServerMessage = z.infer<typeof AgentServerMessageSchema>;

// ────────────────────────────────────────────
// 8. 类型守卫
// ────────────────────────────────────────────

export function isAgentClientMessage(msg: unknown): msg is AgentClientMessage {
  return AgentClientMessageSchema.safeParse(msg).success;
}

export function isAgentServerMessage(msg: unknown): msg is AgentServerMessage {
  return AgentServerMessageSchema.safeParse(msg).success;
}
