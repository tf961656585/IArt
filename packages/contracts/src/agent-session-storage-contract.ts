/**
 * Agent Session Storage Contract
 *
 * agent 会话域（Editor ↔ Main storage IPC，P 组通道）的入参 / 出参 schema。
 *
 * 语义事实源: docs/agent/03-会话存储与IPC契约.md、docs/agent/04-执行管道与WS协议.md。
 * 共享 DTO（会话 / 消息 / 留痕记录）由 agent-contract 承载，本文件只定义 storage IPC 边界形状。
 *
 * 路由约定:
 * - 所有项目作用域读取与写入都显式携带 `projectPath`：storage 层按项目库定位，
 *   不存在跨项目/全局会话读取语义（会话 1:1 从属项目内 Agent 节点）。
 * - 集合读取结果统一用命名字段包裹（与 H 组运行域读取一致），便于后续扩展而不破坏契约。
 */

import * as z from 'zod';
import {
  AgentMessageAppendParamsSchema,
  AgentMessageRecordSchema,
  AgentSendRecordSchema,
  AgentSessionRecordSchema,
  AgentToolCallAppendParamsSchema,
  AgentToolCallRecordSchema,
  AgentToolCallUpdateParamsSchema,
} from './agent-contract';

// ────────────────────────────────────────────
// 1. 会话读取 / 写入
// ────────────────────────────────────────────

/** 项目作用域会话列表（按画布过滤经节点归属推导，不经 graphId 二级归属）。 */
export const StorageReadAgentSessionsParamsSchema = z.object({
  projectPath: z.string(),
});

export const StorageReadAgentSessionsResultSchema = z.object({
  sessions: z.array(AgentSessionRecordSchema),
});

/** 按 Agent 节点读取会话（节点展开 / 续作入口）。未建立会话时 `session` 为 null。 */
export const StorageReadAgentSessionByNodeIdParamsSchema = z.object({
  projectPath: z.string(),
  nodeId: z.string(),
});

export const StorageReadAgentSessionByNodeIdResultSchema = z.object({
  session: AgentSessionRecordSchema.nullable(),
});

/** 会话 upsert（节点创建时创建会话、配置变更时更新）。返回落库后的完整记录。 */
export const StorageUpsertAgentSessionParamsSchema = z.object({
  projectPath: z.string(),
  session: AgentSessionRecordSchema,
});

export const StorageUpsertAgentSessionResultSchema = z.object({
  session: AgentSessionRecordSchema,
});

// ────────────────────────────────────────────
// 2. 消息读取 / 追加
// ────────────────────────────────────────────

/** 读取会话正式消息（按 seq 升序）。 */
export const StorageReadAgentMessagesParamsSchema = z.object({
  projectPath: z.string(),
  agentSessionId: z.string(),
});

export const StorageReadAgentMessagesResultSchema = z.object({
  messages: z.array(AgentMessageRecordSchema),
});

/** 追加正式消息；`seq` 由存储写入端分配，返回分配后的完整记录。 */
export const StorageAppendAgentMessageParamsSchema = z.object({
  projectPath: z.string(),
  message: AgentMessageAppendParamsSchema,
});

export const StorageAppendAgentMessageResultSchema = z.object({
  message: AgentMessageRecordSchema,
});

// ────────────────────────────────────────────
// 3. 本地发送留痕
// ────────────────────────────────────────────

/** 追加本地发送留痕（发送点击时写入，先于 Backend 受理可见）。 */
export const StorageAppendAgentSendRecordParamsSchema = z.object({
  projectPath: z.string(),
  sendRecord: AgentSendRecordSchema,
});

export const StorageAppendAgentSendRecordResultSchema = z.object({
  sendRecord: AgentSendRecordSchema,
});

export const StorageReadAgentSendRecordsParamsSchema = z.object({
  projectPath: z.string(),
  agentSessionId: z.string(),
});

export const StorageReadAgentSendRecordsResultSchema = z.object({
  sendRecords: z.array(AgentSendRecordSchema),
});

// ────────────────────────────────────────────
// 4. 工具调用记录（spec 03「消息、规划与工具调用记录」）
// ────────────────────────────────────────────

/** 读取会话工具调用记录（按 seq 升序；会话视图恢复提案卡片状态的数据来源）。 */
export const StorageReadAgentToolCallsParamsSchema = z.object({
  projectPath: z.string(),
  agentSessionId: z.string(),
});

export const StorageReadAgentToolCallsResultSchema = z.object({
  toolCalls: z.array(AgentToolCallRecordSchema),
});

/** 追加工具调用记录（提案发出时写入）；`seq` 由存储写入端分配，返回分配后的完整记录。 */
export const StorageAppendAgentToolCallParamsSchema = z.object({
  projectPath: z.string(),
  toolCall: AgentToolCallAppendParamsSchema,
});

export const StorageAppendAgentToolCallResultSchema = z.object({
  toolCall: AgentToolCallRecordSchema,
});

/** 更新工具调用记录（决裁/执行状态/终态推进）；按 `toolCallId` 定位，返回更新后的完整记录。 */
export const StorageUpdateAgentToolCallParamsSchema = z.object({
  projectPath: z.string(),
  update: AgentToolCallUpdateParamsSchema,
});

export const StorageUpdateAgentToolCallResultSchema = z.object({
  toolCall: AgentToolCallRecordSchema.nullable(),
});

// ────────────────────────────────────────────
// 5. 导出类型
// ────────────────────────────────────────────

export type StorageReadAgentSessionsParams = z.infer<typeof StorageReadAgentSessionsParamsSchema>;
export type StorageReadAgentSessionsResult = z.infer<typeof StorageReadAgentSessionsResultSchema>;
export type StorageReadAgentSessionByNodeIdParams = z.infer<
  typeof StorageReadAgentSessionByNodeIdParamsSchema
>;
export type StorageReadAgentSessionByNodeIdResult = z.infer<
  typeof StorageReadAgentSessionByNodeIdResultSchema
>;
export type StorageUpsertAgentSessionParams = z.infer<typeof StorageUpsertAgentSessionParamsSchema>;
export type StorageUpsertAgentSessionResult = z.infer<typeof StorageUpsertAgentSessionResultSchema>;
export type StorageReadAgentMessagesParams = z.infer<typeof StorageReadAgentMessagesParamsSchema>;
export type StorageReadAgentMessagesResult = z.infer<typeof StorageReadAgentMessagesResultSchema>;
export type StorageAppendAgentMessageParams = z.infer<typeof StorageAppendAgentMessageParamsSchema>;
export type StorageAppendAgentMessageResult = z.infer<typeof StorageAppendAgentMessageResultSchema>;
export type StorageAppendAgentSendRecordParams = z.infer<
  typeof StorageAppendAgentSendRecordParamsSchema
>;
export type StorageAppendAgentSendRecordResult = z.infer<
  typeof StorageAppendAgentSendRecordResultSchema
>;
export type StorageReadAgentSendRecordsParams = z.infer<
  typeof StorageReadAgentSendRecordsParamsSchema
>;
export type StorageReadAgentSendRecordsResult = z.infer<
  typeof StorageReadAgentSendRecordsResultSchema
>;
export type StorageReadAgentToolCallsParams = z.infer<
  typeof StorageReadAgentToolCallsParamsSchema
>;
export type StorageReadAgentToolCallsResult = z.infer<
  typeof StorageReadAgentToolCallsResultSchema
>;
export type StorageAppendAgentToolCallParams = z.infer<
  typeof StorageAppendAgentToolCallParamsSchema
>;
export type StorageAppendAgentToolCallResult = z.infer<
  typeof StorageAppendAgentToolCallResultSchema
>;
export type StorageUpdateAgentToolCallParams = z.infer<
  typeof StorageUpdateAgentToolCallParamsSchema
>;
export type StorageUpdateAgentToolCallResult = z.infer<
  typeof StorageUpdateAgentToolCallResultSchema
>;
