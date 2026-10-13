/**
 * Agent Session Storage IPC Handler Registration（P 组）
 *
 * agent 会话域 10 个通道：会话读取 / 按节点读取 / upsert、消息读取 / 追加、
 * 本地发送留痕追加 / 读取、工具调用记录读取 / 追加 / 更新。
 * IPC 边界使用 Zod schema 严格 parse 入参与出参（项目规范「IPC 边界用 Zod parse 不用 as」）。
 * 与打包区组（O 组）、系统提示词组（N 组）一致：从 editor-storage-ipc.cts 提取为独立文件。
 *
 * 项目库定位（契约路由约定：所有入参都显式携带 `projectPath`）：
 * - 读通道用 getExistingDb：项目库不存在时返回空结果（null 会话 / 空数组），不隐式建库。
 * - 写通道用 getWritableDb：与 storage:save-delta / storage:upsert-media-asset 一致，
 *   由 DB 层负责建库与 schema 初始化，写入不因项目尚未打开而静默丢弃用户输入。
 */

import { ipcMain } from 'electron';
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
} from '@iart/contracts';
import type { SqliteDatabase } from './sqlite-loader.cjs';
import {
  readAgentMessages,
  readAgentSendRecords,
  readAgentSessionByNodeId,
  readAgentSessions,
  readAgentToolCalls,
} from './editor-storage-read-model.cjs';
import {
  appendAgentMessage,
  appendAgentSendRecord,
  appendAgentToolCall,
  updateAgentToolCall,
  upsertAgentSession,
} from './editor-storage-agent-writer.cjs';

const CH = EDITOR_STORAGE_IPC_CHANNELS;

/**
 * registerAgentSessionStorageIpcHandlers 需要两个 projectPath → db 的解析函数。
 * 由主 ipc.cts 注入（读用 getDbForExistingProject，写用 getDb），
 * 避免本模块直接依赖 service-impl 的连接池。
 */
export function registerAgentSessionStorageIpcHandlers(deps: {
  getExistingDb: (projectPath: string) => SqliteDatabase | null;
  getWritableDb: (projectPath: string) => SqliteDatabase;
}): void {
  // ── 会话读取：全项目会话（元数据）──
  ipcMain.handle(CH.READ_AGENT_SESSIONS, (_event, args: unknown) => {
    const params = StorageReadAgentSessionsParamsSchema.parse(args);
    const db = deps.getExistingDb(params.projectPath);
    return StorageReadAgentSessionsResultSchema.parse({
      sessions: db ? readAgentSessions(db) : [],
    });
  });

  // ── 会话读取：按 Agent 节点（节点展开 / 续作入口）──
  ipcMain.handle(CH.READ_AGENT_SESSION_BY_NODE_ID, (_event, args: unknown) => {
    const params = StorageReadAgentSessionByNodeIdParamsSchema.parse(args);
    const db = deps.getExistingDb(params.projectPath);
    return StorageReadAgentSessionByNodeIdResultSchema.parse({
      session: db ? readAgentSessionByNodeId(db, params.nodeId) : null,
    });
  });

  // ── 会话 upsert（节点创建时创建会话、配置变更时更新）──
  ipcMain.handle(CH.UPSERT_AGENT_SESSION, (_event, args: unknown) => {
    const params = StorageUpsertAgentSessionParamsSchema.parse(args);
    const db = deps.getWritableDb(params.projectPath);
    return StorageUpsertAgentSessionResultSchema.parse({
      session: upsertAgentSession(db, params.session),
    });
  });

  // ── 消息读取（按 seq 升序）──
  ipcMain.handle(CH.READ_AGENT_MESSAGES, (_event, args: unknown) => {
    const params = StorageReadAgentMessagesParamsSchema.parse(args);
    const db = deps.getExistingDb(params.projectPath);
    return StorageReadAgentMessagesResultSchema.parse({
      messages: db ? readAgentMessages(db, params.agentSessionId) : [],
    });
  });

  // ── 消息追加（seq 由存储写入端分配）──
  ipcMain.handle(CH.APPEND_AGENT_MESSAGE, (_event, args: unknown) => {
    const params = StorageAppendAgentMessageParamsSchema.parse(args);
    const db = deps.getWritableDb(params.projectPath);
    return StorageAppendAgentMessageResultSchema.parse({
      message: appendAgentMessage(db, params.message),
    });
  });

  // ── 本地发送留痕追加（发送点击即写，先于 Backend 受理可见）──
  ipcMain.handle(CH.APPEND_AGENT_SEND_RECORD, (_event, args: unknown) => {
    const params = StorageAppendAgentSendRecordParamsSchema.parse(args);
    const db = deps.getWritableDb(params.projectPath);
    return StorageAppendAgentSendRecordResultSchema.parse({
      sendRecord: appendAgentSendRecord(db, params.sendRecord),
    });
  });

  // ── 本地发送留痕读取（会话恢复）──
  ipcMain.handle(CH.READ_AGENT_SEND_RECORDS, (_event, args: unknown) => {
    const params = StorageReadAgentSendRecordsParamsSchema.parse(args);
    const db = deps.getExistingDb(params.projectPath);
    return StorageReadAgentSendRecordsResultSchema.parse({
      sendRecords: db ? readAgentSendRecords(db, params.agentSessionId) : [],
    });
  });

  // ── 工具调用记录读取（会话视图恢复提案卡片状态）──
  ipcMain.handle(CH.READ_AGENT_TOOL_CALLS, (_event, args: unknown) => {
    const params = StorageReadAgentToolCallsParamsSchema.parse(args);
    const db = deps.getExistingDb(params.projectPath);
    return StorageReadAgentToolCallsResultSchema.parse({
      toolCalls: db ? readAgentToolCalls(db, params.agentSessionId) : [],
    });
  });

  // ── 工具调用记录追加（提案发出即写，seq 由存储写入端分配）──
  ipcMain.handle(CH.APPEND_AGENT_TOOL_CALL, (_event, args: unknown) => {
    const params = StorageAppendAgentToolCallParamsSchema.parse(args);
    const db = deps.getWritableDb(params.projectPath);
    return StorageAppendAgentToolCallResultSchema.parse({
      toolCall: appendAgentToolCall(db, params.toolCall),
    });
  });

  // ── 工具调用记录更新（决裁 / 执行状态 / 终态推进）──
  ipcMain.handle(CH.UPDATE_AGENT_TOOL_CALL, (_event, args: unknown) => {
    const params = StorageUpdateAgentToolCallParamsSchema.parse(args);
    const db = deps.getWritableDb(params.projectPath);
    return StorageUpdateAgentToolCallResultSchema.parse({
      toolCall: updateAgentToolCall(db, params.update),
    });
  });
}
