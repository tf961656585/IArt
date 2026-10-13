/**
 * Agent Storage — 会话域写入器（P 组写入通道）
 *
 * 会话 / 消息 / 本地发送留痕的落库入口，全部按 action 分函数导出（与
 * editor-storage-package-area.cts 的命令式写入契约族同形）：
 * 每个函数消费 contracts 的 DTO，直接 db.prepare().run() 持久化，写入完成后
 * 回读并返回契约记录，入参已由 IPC handler 在边界 `.parse()` 校验。
 *
 * 写入语义（语义事实源 spec 03「会话存储与IPC契约」）：
 * - 会话身份 `agentSessionId` 稳定，节点归属 `nodeId` 1:1；upsert 只更新可变配置字段，
 *   不覆盖 `messageCount` / `createdAt` / `nodeId`。
 * - `messageCount` 由本层维护（调用方只读），按 agent_messages 实际行数重新投影，
 *   不用增量加减：增量在重复投递或补写历史消息时会漂移，且漂移不可自证。
 * - `seq` 由本层分配（会话内单调递增），调用方不提供。
 * - 本地发送留痕按 `recordId` 幂等（发送点击重试不产生重复留痕）；快照不可变，冲突不覆盖。
 *
 * 事务：本文件所有写入都在 `db.transaction` 内完成（语句级原子性由 better-sqlite3 提供，
 * 多语句组合必须显式成事务，否则中途失败会留下「消息已写、会话计数未更新」的半态）。
 */

import {
  AgentMessageAppendParamsSchema,
  AgentMessageRecordSchema,
  AgentSendRecordSchema,
  AgentSessionRecordSchema,
  AgentToolCallAppendParamsSchema,
  AgentToolCallRecordSchema,
  AgentToolCallUpdateParamsSchema,
} from '@iart/contracts';
import type {
  AgentMessageAppendParams,
  AgentMessageRecord,
  AgentSendRecord,
  AgentSessionRecord,
  AgentToolCallAppendParams,
  AgentToolCallRecord,
  AgentToolCallUpdateParams,
} from '@iart/contracts';
import type { SqliteDatabase } from './sqlite-loader.cjs';
import { agentSessionRowToRecord, readAgentSendRecords } from './editor-storage-read-model.cjs';

const AGENT_SESSION_COLUMNS =
  'agentSessionId, nodeId, modelId, thinkingTier, approvalMode, title, messageCount, createdAt, updatedAt, lastMessageAt';

const assertAgentSessionExists = (db: SqliteDatabase, agentSessionId: string): void => {
  const row = db
    .prepare('SELECT 1 AS present FROM agent_sessions WHERE agentSessionId = ? LIMIT 1')
    .get(agentSessionId) as { present: number } | undefined;
  if (row === undefined) {
    throw new Error(
      `AGENT_SESSION_NOT_FOUND: 会话 ${agentSessionId} 不存在（消息与留痕必须先建立会话）`,
    );
  }
};

/**
 * 会话 upsert：不存在则插入全量，已存在则只更新可变字段。
 *
 * - 插入时 `messageCount` 由本层按 agent_messages 实际行数投影（新会话为 0），
 *   不采信调用方传入的计数值，避免调用方与存储端各持一份计数。`lastMessageAt` 同理由本层
 *   维护（新会话没有消息，插入路径不写该列，保持 NULL）；两条都在 appendAgentMessage 里推进。
 * - 更新时只写 `modelId` / `thinkingTier` / `approvalMode` / `title` / `updatedAt`：
 *   `createdAt` 与 `nodeId` 是会话身份信息，`messageCount` 与 `lastMessageAt` 是消息表投影，
 *   均不得被覆盖（配置变更不是消息，不能移动「最近一次对话」的时间口径）。
 * - `nodeId` 有 UNIQUE 约束（会话 1:1 从属节点）。若同一节点已绑定另一个会话，
 *   显式拒绝并给出明确错误码，而不是让 SQLite 的唯一约束报出无法定位的原始错误——
 *   静默改绑会丢历史，必须由调用方先读会话（read-agent-session-by-node-id）并复用其 id。
 */
export const upsertAgentSession = (
  db: SqliteDatabase,
  session: AgentSessionRecord,
): AgentSessionRecord => {
  const parsedSession = AgentSessionRecordSchema.parse(session);

  const run = db.transaction((input: AgentSessionRecord) => {
    const bound = db
      .prepare('SELECT agentSessionId FROM agent_sessions WHERE nodeId = ?')
      .get(input.nodeId) as { agentSessionId: string } | undefined;
    if (bound !== undefined && bound.agentSessionId !== input.agentSessionId) {
      throw new Error(
        `AGENT_SESSION_NODE_TAKEN: 节点 ${input.nodeId} 已绑定会话 ${bound.agentSessionId}，` +
          `拒绝用会话 ${input.agentSessionId} 覆盖（会话与节点 1:1）`,
      );
    }

    db.prepare(
      `INSERT INTO agent_sessions (
        agentSessionId,
        nodeId,
        modelId,
        thinkingTier,
        approvalMode,
        title,
        messageCount,
        createdAt,
        updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, (
        SELECT COUNT(*) FROM agent_messages WHERE agentSessionId = ?
      ), ?, ?)
      ON CONFLICT(agentSessionId) DO UPDATE SET
        modelId = excluded.modelId,
        thinkingTier = excluded.thinkingTier,
        approvalMode = excluded.approvalMode,
        title = excluded.title,
        updatedAt = excluded.updatedAt`,
    ).run(
      input.agentSessionId,
      input.nodeId,
      input.modelId,
      input.thinkingTier,
      input.approvalMode,
      input.title,
      input.agentSessionId,
      input.createdAt,
      input.updatedAt,
    );

    const row = db
      .prepare(`SELECT ${AGENT_SESSION_COLUMNS} FROM agent_sessions WHERE agentSessionId = ?`)
      .get(input.agentSessionId) as Parameters<typeof agentSessionRowToRecord>[0] | undefined;
    if (row === undefined) {
      throw new Error(`AGENT_SESSION_UPSERT_FAILED: 会话 ${input.agentSessionId} 落库后回读为空`);
    }
    return agentSessionRowToRecord(row);
  });

  return run(parsedSession);
};

/**
 * 追加正式消息：分配 seq、插入消息行，并在同一事务内重新投影会话的
 * `messageCount`、`updatedAt`（取单调更大值，补写历史消息不回退会话时间）与
 * `lastMessageAt`（最后一条正式消息的时间，同样取单调更大值）。
 *
 * `lastMessageAt` 只在本函数推进：它是「最近一次对话」的口径，配置变更（走 upsert 更新路径）
 * 不触碰。消息表为空时该列为 NULL——不用 `updatedAt` 或 0 兜底。
 */
export const appendAgentMessage = (
  db: SqliteDatabase,
  params: AgentMessageAppendParams,
): AgentMessageRecord => {
  const parsedParams = AgentMessageAppendParamsSchema.parse(params);

  const run = db.transaction((input: AgentMessageAppendParams) => {
    assertAgentSessionExists(db, input.agentSessionId);

    const seqRow = db
      .prepare(
        'SELECT COALESCE(MAX(seq), 0) + 1 AS nextSeq FROM agent_messages WHERE agentSessionId = ?',
      )
      .get(input.agentSessionId) as { nextSeq: number } | undefined;
    const seq = seqRow === undefined ? 1 : seqRow.nextSeq;

    db.prepare(
      `INSERT INTO agent_messages (
        agentSessionId,
        seq,
        role,
        requestId,
        bodyJson,
        planJson,
        createdAt,
        isPartial
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.agentSessionId,
      seq,
      input.role,
      input.requestId,
      JSON.stringify(input.body),
      input.plan === null ? null : JSON.stringify(input.plan),
      input.createdAt,
      input.isPartial ? 1 : 0,
    );

    const countRow = db
      .prepare('SELECT COUNT(*) AS count FROM agent_messages WHERE agentSessionId = ?')
      .get(input.agentSessionId) as { count: number } | undefined;
    db.prepare(
      `UPDATE agent_sessions
          SET messageCount = ?,
              updatedAt = MAX(updatedAt, ?),
              lastMessageAt = MAX(COALESCE(lastMessageAt, ?), ?)
        WHERE agentSessionId = ?`,
    ).run(
      countRow === undefined ? 0 : countRow.count,
      input.createdAt,
      input.createdAt,
      input.createdAt,
      input.agentSessionId,
    );

    return AgentMessageRecordSchema.parse({ ...input, seq });
  });

  return run(parsedParams);
};

/**
 * 追加本地发送留痕（发送点击即写，先于 Backend 受理可见）。
 *
 * 留痕生命周期故意独立于会话创建：**首条留痕必须能在会话行尚不存在时写入**
 * （受理创建 Agent 节点与会话之前就落库），因此本函数不校验会话存在性，表中也不建
 * 指向 agent_sessions 的外键；`nodeId` 同理可为 null（受理前无节点宿主）。
 * 留痕的节点/会话清理由节点删除咽喉显式完成（见 editor-storage-delta.cts）。
 *
 * 按 `recordId` 幂等：同一发送重试只保留首条留痕（快照在发送时冻结、不可变），
 * 命中已存在行时留 debug 痕迹（条件跳过必须留痕），返回值统一回读库内实际记录。
 */
export const appendAgentSendRecord = (
  db: SqliteDatabase,
  record: AgentSendRecord,
): AgentSendRecord => {
  const parsedRecord = AgentSendRecordSchema.parse(record);

  const run = db.transaction((input: AgentSendRecord) => {
    const result = db
      .prepare(
        `INSERT INTO agent_send_records (
          recordId,
          agentSessionId,
          nodeId,
          requestId,
          createdAt,
          contentJson,
          referenceAssetIdsJson,
          snapshotJson
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(recordId) DO NOTHING`,
      )
      .run(
        input.recordId,
        input.agentSessionId,
        input.nodeId,
        input.requestId,
        input.createdAt,
        JSON.stringify(input.content),
        JSON.stringify(input.referenceAssetIds),
        JSON.stringify(input.snapshot),
      ) as { changes: number };

    if (result.changes === 0) {
      console.debug(
        '[editor-storage-agent-writer] appendAgentSendRecord: recordId 已存在，保留首条留痕',
        { recordId: input.recordId, agentSessionId: input.agentSessionId },
      );
    }

    // 回读库内实际记录（而非回传入参）：重复 recordId 时返回的是首条留痕，
    // 与调用方本次提交的内容可能不同，必须让返回值代表存储事实。
    const persisted = readAgentSendRecords(db, input.agentSessionId).find(
      (record) => record.recordId === input.recordId,
    );
    if (persisted === undefined) {
      throw new Error(`AGENT_SEND_RECORD_APPEND_FAILED: 留痕 ${input.recordId} 落库后回读为空`);
    }
    return persisted;
  });

  return run(parsedRecord);
};

// ────────────────────────────────────────────
// 工具调用记录（spec 03「消息、规划与工具调用记录」）
// ────────────────────────────────────────────

const TOOL_CALL_COLUMNS =
  'toolCallId, agentSessionId, seq, toolName, toolKind, modelId, status, batchId, taskIdsJson, assetIdsJson, errorSummary, createdAt, updatedAt';

type AgentToolCallRow = {
  toolCallId: string;
  agentSessionId: string;
  seq: number;
  toolName: string;
  toolKind: string;
  modelId: string | null;
  status: string;
  batchId: string | null;
  taskIdsJson: string;
  assetIdsJson: string;
  errorSummary: string | null;
  createdAt: number;
  updatedAt: number;
};

/** 行 → 契约记录（taskIds/assetIds 整列 JSON，读取失败按空数组收敛并留痕）。 */
const agentToolCallRowToRecord = (row: AgentToolCallRow): AgentToolCallRecord => {
  const readIds = (json: string): string[] => {
    try {
      const parsed: unknown = JSON.parse(json);
      return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
    } catch {
      console.debug('[editor-storage-agent-writer] tool call ids column unreadable, treated as empty', {
        toolCallId: row.toolCallId,
      });
      return [];
    }
  };
  return AgentToolCallRecordSchema.parse({
    toolCallId: row.toolCallId,
    agentSessionId: row.agentSessionId,
    seq: row.seq,
    toolName: row.toolName,
    toolKind: row.toolKind,
    modelId: row.modelId,
    status: row.status,
    batchId: row.batchId,
    taskIds: readIds(row.taskIdsJson),
    assetIds: readIds(row.assetIdsJson),
    errorSummary: row.errorSummary,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
};

/**
 * 追加工具调用记录：分配 seq（会话内单调递增，与消息 seq 独立计数），插入后回读契约记录。
 * 提案发出即写入（`proposed`）；后续状态经 updateAgentToolCall 推进，不重复追加。
 */
export const appendAgentToolCall = (
  db: SqliteDatabase,
  params: AgentToolCallAppendParams,
): AgentToolCallRecord => {
  const parsed = AgentToolCallAppendParamsSchema.parse(params);

  const run = db.transaction((input: AgentToolCallAppendParams) => {
    assertAgentSessionExists(db, input.agentSessionId);

    const seqRow = db
      .prepare(
        'SELECT COALESCE(MAX(seq), 0) + 1 AS nextSeq FROM agent_tool_calls WHERE agentSessionId = ?',
      )
      .get(input.agentSessionId) as { nextSeq: number } | undefined;
    const seq = seqRow === undefined ? 1 : seqRow.nextSeq;

    db.prepare(
      `INSERT INTO agent_tool_calls (
        toolCallId, agentSessionId, seq, toolName, toolKind, modelId, status,
        batchId, taskIdsJson, assetIdsJson, errorSummary, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.toolCallId,
      input.agentSessionId,
      seq,
      input.toolName,
      input.toolKind,
      input.modelId,
      input.status,
      input.batchId,
      JSON.stringify(input.taskIds),
      JSON.stringify(input.assetIds),
      input.errorSummary,
      input.createdAt,
      input.updatedAt,
    );

    const row = db
      .prepare(`SELECT ${TOOL_CALL_COLUMNS} FROM agent_tool_calls WHERE toolCallId = ?`)
      .get(input.toolCallId) as AgentToolCallRow | undefined;
    if (row === undefined) {
      throw new Error(`AGENT_TOOL_CALL_APPEND_FAILED: 工具调用 ${input.toolCallId} 落库后回读为空`);
    }
    return agentToolCallRowToRecord(row);
  });

  return run(parsed);
};

/**
 * 更新工具调用记录（决裁 / 执行状态 / 终态推进）：按 toolCallId 定位，只写显式携带的字段；
 * `updatedAt` 由本层维护。记录不存在返回 null（迟到的状态推进不报错，由调用方留痕）。
 */
export const updateAgentToolCall = (
  db: SqliteDatabase,
  params: AgentToolCallUpdateParams,
): AgentToolCallRecord | null => {
  const parsed = AgentToolCallUpdateParamsSchema.parse(params);

  const run = db.transaction((input: AgentToolCallUpdateParams) => {
    const existing = db
      .prepare(`SELECT ${TOOL_CALL_COLUMNS} FROM agent_tool_calls WHERE toolCallId = ?`)
      .get(input.toolCallId) as AgentToolCallRow | undefined;
    if (existing === undefined) return null;

    const current = agentToolCallRowToRecord(existing);
    if (input.agentSessionId !== current.agentSessionId) {
      throw new Error(
        `AGENT_TOOL_CALL_SESSION_MISMATCH: 工具调用 ${input.toolCallId} 不属于会话 ${input.agentSessionId}`,
      );
    }
    const nextTaskIds = input.taskIds ?? current.taskIds;
    const nextAssetIds = input.assetIds ?? current.assetIds;
    db.prepare(
      `UPDATE agent_tool_calls SET
        status = ?,
        batchId = ?,
        taskIdsJson = ?,
        assetIdsJson = ?,
        errorSummary = ?,
        updatedAt = ?
      WHERE toolCallId = ?`,
    ).run(
      input.status,
      input.batchId === undefined ? current.batchId : input.batchId,
      JSON.stringify(nextTaskIds),
      JSON.stringify(nextAssetIds),
      input.errorSummary === undefined ? current.errorSummary : input.errorSummary,
      Date.now(),
      input.toolCallId,
    );

    const row = db
      .prepare(`SELECT ${TOOL_CALL_COLUMNS} FROM agent_tool_calls WHERE toolCallId = ?`)
      .get(input.toolCallId) as AgentToolCallRow | undefined;
    if (row === undefined) return null;
    return agentToolCallRowToRecord(row);
  });

  return run(parsed);
};
