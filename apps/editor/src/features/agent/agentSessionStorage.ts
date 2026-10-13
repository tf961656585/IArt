/**
 * Agent 会话存储封装 — Renderer 侧 IPC 调用层（P 组 7 通道）。
 *
 * 职责：调用 storage IPC 并用 contracts 的 params/result schema `.parse()` 校验输入输出，
 * 防止未校验数据流入 UI（仓库规范「IPC 边界用 Zod parse 不用 as」）。
 * 与 package-area/storage/backendPackageArea.ts 同范式：封装层解包 `{ sessions } / { session } / ...`
 * 包装形状后返回裸 DTO 供 store 消费。
 *
 * 会话 DTO / 消息 DTO / 留痕 DTO 的字段事实源是 packages/contracts（agent-contract），
 * 本文件只承载调用边界，不复制字段定义（AGENTS.md「共享契约与事实源」）。
 */

import {
  EDITOR_STORAGE_IPC_CHANNELS,
  StorageAppendAgentMessageParamsSchema,
  StorageAppendAgentMessageResultSchema,
  StorageAppendAgentSendRecordParamsSchema,
  StorageAppendAgentSendRecordResultSchema,
  StorageAppendAgentToolCallParamsSchema,
  StorageAppendAgentToolCallResultSchema,
  StorageReadAgentMessagesParamsSchema,
  StorageReadAgentMessagesResultSchema,
  StorageReadAgentSendRecordsParamsSchema,
  StorageReadAgentSendRecordsResultSchema,
  StorageReadAgentSessionByNodeIdParamsSchema,
  StorageReadAgentSessionByNodeIdResultSchema,
  StorageReadAgentSessionsParamsSchema,
  StorageReadAgentSessionsResultSchema,
  StorageReadAgentToolCallsParamsSchema,
  StorageReadAgentToolCallsResultSchema,
  StorageUpdateAgentToolCallParamsSchema,
  StorageUpdateAgentToolCallResultSchema,
  StorageUpsertAgentSessionParamsSchema,
  StorageUpsertAgentSessionResultSchema,
  type AgentMessageAppendParams,
  type AgentMessageRecord,
  type AgentSendRecord,
  type AgentSessionRecord,
  type AgentToolCallAppendParams,
  type AgentToolCallRecord,
  type AgentToolCallUpdateParams,
} from '@iart/contracts';
import { ipcInvoke } from '@/features/canvas/storage/backendCore';

/** 项目作用域会话元数据列表（不加载消息，spec 03「生命周期与 IPC」按需读取）。 */
export const readAgentSessions = async (
  projectPath: string,
): Promise<AgentSessionRecord[]> => {
  if (!projectPath) return [];
  const params = StorageReadAgentSessionsParamsSchema.parse({ projectPath });
  const result = StorageReadAgentSessionsResultSchema.parse(
    await ipcInvoke<unknown>(EDITOR_STORAGE_IPC_CHANNELS.READ_AGENT_SESSIONS, params),
  );
  return result.sessions;
};

/** 按 Agent 节点读取会话记录；未建立会话时返回 null。 */
export const readAgentSessionByNodeId = async (
  projectPath: string,
  nodeId: string,
): Promise<AgentSessionRecord | null> => {
  if (!projectPath || !nodeId) return null;
  const params = StorageReadAgentSessionByNodeIdParamsSchema.parse({ projectPath, nodeId });
  const result = StorageReadAgentSessionByNodeIdResultSchema.parse(
    await ipcInvoke<unknown>(EDITOR_STORAGE_IPC_CHANNELS.READ_AGENT_SESSION_BY_NODE_ID, params),
  );
  return result.session;
};

/** 会话 upsert（节点创建时建会话、配置变更时更新），返回落库后的完整记录。 */
export const upsertAgentSession = async (
  projectPath: string,
  session: AgentSessionRecord,
): Promise<AgentSessionRecord> => {
  const params = StorageUpsertAgentSessionParamsSchema.parse({ projectPath, session });
  const result = StorageUpsertAgentSessionResultSchema.parse(
    await ipcInvoke<unknown>(EDITOR_STORAGE_IPC_CHANNELS.UPSERT_AGENT_SESSION, params),
  );
  return result.session;
};

/** 读取会话正式消息（按 seq 升序）。 */
export const readAgentMessages = async (
  projectPath: string,
  agentSessionId: string,
): Promise<AgentMessageRecord[]> => {
  if (!projectPath || !agentSessionId) return [];
  const params = StorageReadAgentMessagesParamsSchema.parse({ projectPath, agentSessionId });
  const result = StorageReadAgentMessagesResultSchema.parse(
    await ipcInvoke<unknown>(EDITOR_STORAGE_IPC_CHANNELS.READ_AGENT_MESSAGES, params),
  );
  return result.messages;
};

/** 追加正式消息（`seq` 由存储写入端分配），返回分配后的完整记录。 */
export const appendAgentMessage = async (
  projectPath: string,
  message: AgentMessageAppendParams,
): Promise<AgentMessageRecord> => {
  const params = StorageAppendAgentMessageParamsSchema.parse({ projectPath, message });
  const result = StorageAppendAgentMessageResultSchema.parse(
    await ipcInvoke<unknown>(EDITOR_STORAGE_IPC_CHANNELS.APPEND_AGENT_MESSAGE, params),
  );
  return result.message;
};

/** 追加本地发送留痕（发送点击即写，先于 Backend 受理可见）。 */
export const appendAgentSendRecord = async (
  projectPath: string,
  sendRecord: AgentSendRecord,
): Promise<AgentSendRecord> => {
  const params = StorageAppendAgentSendRecordParamsSchema.parse({ projectPath, sendRecord });
  const result = StorageAppendAgentSendRecordResultSchema.parse(
    await ipcInvoke<unknown>(EDITOR_STORAGE_IPC_CHANNELS.APPEND_AGENT_SEND_RECORD, params),
  );
  return result.sendRecord;
};

/** 读取会话本地发送留痕（恢复顺序：正式历史之后）。 */
export const readAgentSendRecords = async (
  projectPath: string,
  agentSessionId: string,
): Promise<AgentSendRecord[]> => {
  if (!projectPath || !agentSessionId) return [];
  const params = StorageReadAgentSendRecordsParamsSchema.parse({ projectPath, agentSessionId });
  const result = StorageReadAgentSendRecordsResultSchema.parse(
    await ipcInvoke<unknown>(EDITOR_STORAGE_IPC_CHANNELS.READ_AGENT_SEND_RECORDS, params),
  );
  return result.sendRecords;
};

/** 读取会话工具调用记录（按 seq 升序；会话视图恢复提案卡片状态的数据来源）。 */
export const readAgentToolCalls = async (
  projectPath: string,
  agentSessionId: string,
): Promise<AgentToolCallRecord[]> => {
  if (!projectPath || !agentSessionId) return [];
  const params = StorageReadAgentToolCallsParamsSchema.parse({ projectPath, agentSessionId });
  const result = StorageReadAgentToolCallsResultSchema.parse(
    await ipcInvoke<unknown>(EDITOR_STORAGE_IPC_CHANNELS.READ_AGENT_TOOL_CALLS, params),
  );
  return result.toolCalls;
};

/** 追加工具调用记录（提案发出时写入；`seq` 由存储写入端分配）。 */
export const appendAgentToolCall = async (
  projectPath: string,
  toolCall: AgentToolCallAppendParams,
): Promise<AgentToolCallRecord> => {
  const params = StorageAppendAgentToolCallParamsSchema.parse({ projectPath, toolCall });
  const result = StorageAppendAgentToolCallResultSchema.parse(
    await ipcInvoke<unknown>(EDITOR_STORAGE_IPC_CHANNELS.APPEND_AGENT_TOOL_CALL, params),
  );
  return result.toolCall;
};

/** 更新工具调用记录（决裁 / 执行状态 / 终态推进），返回更新后的完整记录。 */
export const updateAgentToolCall = async (
  projectPath: string,
  update: AgentToolCallUpdateParams,
): Promise<AgentToolCallRecord | null> => {
  const params = StorageUpdateAgentToolCallParamsSchema.parse({ projectPath, update });
  const result = StorageUpdateAgentToolCallResultSchema.parse(
    await ipcInvoke<unknown>(EDITOR_STORAGE_IPC_CHANNELS.UPDATE_AGENT_TOOL_CALL, params),
  );
  return result.toolCall;
};

/** 存储依赖接口（测试注入用；生产实现即上述函数）。 */
export type AgentSessionStorage = {
  readAgentSessions: typeof readAgentSessions;
  readAgentSessionByNodeId: typeof readAgentSessionByNodeId;
  upsertAgentSession: typeof upsertAgentSession;
  readAgentMessages: typeof readAgentMessages;
  appendAgentMessage: typeof appendAgentMessage;
  appendAgentSendRecord: typeof appendAgentSendRecord;
  readAgentSendRecords: typeof readAgentSendRecords;
  readAgentToolCalls: typeof readAgentToolCalls;
  appendAgentToolCall: typeof appendAgentToolCall;
  updateAgentToolCall: typeof updateAgentToolCall;
};

export const agentSessionStorage: AgentSessionStorage = {
  readAgentSessions,
  readAgentSessionByNodeId,
  upsertAgentSession,
  readAgentMessages,
  appendAgentMessage,
  appendAgentSendRecord,
  readAgentSendRecords,
  readAgentToolCalls,
  appendAgentToolCall,
  updateAgentToolCall,
};
