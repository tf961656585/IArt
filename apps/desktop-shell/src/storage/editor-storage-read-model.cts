import type {
  RuntimeMediaAssetView,
  RuntimeTaskOutputRow,
  RuntimeTaskView,
  ProjectRecord,
  ProjectMediaAssets,
  UnifiedGenerationStatus,
  PackageAreaEntryView,
  PackageAreaMediaType,
  PackageAreaView,
  BatchIntentSnapshot,
  AgentMessageRecord,
  AgentSendRecord,
  AgentSessionRecord,
  AgentToolCallRecord,
} from '@iart/contracts';
import {
  AgentMessageRecordSchema,
  AgentSendRecordSchema,
  AgentSessionRecordSchema,
  AgentToolCallRecordSchema,
  BatchIntentSnapshotSchema,
  runtimeMediaAssetRowsToViews,
  runtimeMediaAssetViewsToProjectMediaAssets,
  runtimeTaskRowToView,
} from '@iart/contracts';
import type { ZodType } from 'zod';
import type { SqliteDatabase } from './sqlite-loader.cjs';
import { getPendingState } from './editor-storage-delta.cjs';

export type JsonObject = Record<string, unknown>;
type TaskRawRow = {
  taskId: string;
  status: UnifiedGenerationStatus;
  projectPath: string;
  sourceNodeId: string | null | undefined;
  targetNodeId: string | null | undefined;
  batchId: string | null | undefined;
  requestJson: string | null | undefined;
  metadataJson: string | null | undefined;
  remoteRequestId: string | null | undefined;
  progressPercent: number | null | undefined;
  progressMessage: string | null | undefined;
  progressPhase: string | null | undefined;
  errorMessage: string | null | undefined;
  errorCode: string | null | undefined;
  failureJson: string | null | undefined;
  createdAt: number;
  updatedAt: number;
};
type MediaAssetDbRow = {
  assetId: string;
  mediaType: string;
  payloadJson: string;
  createdAt: number | null | undefined;
  updatedAt: number | null | undefined;
};

export type ManifestRow = {
  version: number;
  name: string;
  nodeGraphId: string;
  createdAt: number;
  savedAt: number;
  source: string | null;
  stableProjectId: string | null;
};

export const asObject = (value: unknown): JsonObject =>
  typeof value === 'object' && value !== null ? (value as JsonObject) : {};

export const parseJsonObject = (payload: unknown): JsonObject => {
  if (typeof payload !== 'string' || !payload.trim()) return {};
  try {
    const parsed = JSON.parse(payload) as unknown;
    return asObject(parsed);
  } catch {
    return {};
  }
};

const normalizeNodeGraphPayload = (
  graphPayload: JsonObject,
  nodeGraphId: string,
): JsonObject => ({
  ...graphPayload,
  id: nodeGraphId,
});

const logHydrationIssue = (issue: unknown) => {
  console.warn('[editor-storage-read-model] runtime hydration issue', issue);
};

const hydrateTaskRow = (row: TaskRawRow | null): RuntimeTaskView | null =>
  row
    ? runtimeTaskRowToView(row, {
        now: undefined,
        onIssue: logHydrationIssue,
      })
    : null;

const hydrateMediaAssetRows = (rows: MediaAssetDbRow[]): RuntimeMediaAssetView[] =>
  runtimeMediaAssetRowsToViews(rows, {
    now: undefined,
    onIssue: logHydrationIssue,
  });

export const readTaskById = (db: SqliteDatabase, taskId: string): RuntimeTaskView | null => {
  const row = db.prepare('SELECT * FROM tasks WHERE taskId = ?').get(taskId) as TaskRawRow | undefined;
  return hydrateTaskRow(row ?? null);
};

type BatchDbRow = {
  batchId: string;
  payloadJson: string;
  createdAt: number | null | undefined;
  updatedAt: number | null | undefined;
};

/**
 * 按 batchId 读取 BatchIntentSnapshot（batches.payloadJson 是受理时冻结的不可变快照，
 * 无损持久化）。payload 损坏/不合规时返回 null 并留痕，不抛错（storage read 只投影不裁决）。
 */
export const readBatchById = (db: SqliteDatabase, batchId: string): BatchIntentSnapshot | null => {
  const row = db
    .prepare('SELECT batchId, payloadJson, createdAt, updatedAt FROM batches WHERE batchId = ?')
    .get(batchId) as BatchDbRow | undefined;
  if (!row) return null;
  try {
    const parsed = BatchIntentSnapshotSchema.safeParse(JSON.parse(row.payloadJson) as unknown);
    if (parsed.success) return parsed.data;
    console.debug('[editor-storage-read-model] readBatchById: payload schema mismatch', {
      batchId: row.batchId,
      issue: parsed.error.message,
    });
  } catch (error) {
    console.debug('[editor-storage-read-model] readBatchById: payload parse failed', {
      batchId: row.batchId,
      error,
    });
  }
  return null;
};

export const readTaskOutputs = (db: SqliteDatabase, taskId: string): RuntimeTaskOutputRow[] => {
  return db.prepare('SELECT * FROM task_outputs WHERE taskId = ? ORDER BY sortOrder').all(taskId) as RuntimeTaskOutputRow[];
};

export const readMediaAssetsByTaskId = (db: SqliteDatabase, taskId: string): RuntimeMediaAssetView[] => {
  const rows = db.prepare(
    `SELECT ma.assetId, ma.mediaType, ma.payloadJson, ma.createdAt, ma.updatedAt
       FROM media_assets ma
       INNER JOIN task_outputs task_output ON task_output.assetId = ma.assetId
      WHERE task_output.taskId = ?
      ORDER BY task_output.sortOrder`,
  ).all(taskId) as MediaAssetDbRow[];
  return hydrateMediaAssetRows(rows);
};

export const readAllTasks = (db: SqliteDatabase, options: { status: UnifiedGenerationStatus | undefined; limit: number | undefined; offset: number | undefined } | undefined): RuntimeTaskView[] => {
  let sql = 'SELECT * FROM tasks';
  const params: unknown[] = [];

  if (options !== undefined && options.status !== undefined) {
    sql += ' WHERE status = ?';
    params.push(options.status);
  }

  sql += ' ORDER BY createdAt DESC';

  if (options !== undefined && options.limit !== undefined) {
    sql += ' LIMIT ?';
    params.push(options.limit);
  }

  if (options !== undefined && options.offset !== undefined) {
    sql += ' OFFSET ?';
    params.push(options.offset);
  }

  const rows = db.prepare(sql).all(...params) as TaskRawRow[];
  return rows
    .map((row) => hydrateTaskRow(row))
    .filter((row): row is RuntimeTaskView => row !== null);
};

export const readAllMediaAssets = (db: SqliteDatabase): RuntimeMediaAssetView[] => {
  const rows = db.prepare(
    `SELECT assetId, mediaType, payloadJson, createdAt, updatedAt
       FROM media_assets
      ORDER BY assetId ASC`,
  ).all() as MediaAssetDbRow[];
  return hydrateMediaAssetRows(rows);
};

export const readMediaAssetById = (db: SqliteDatabase, assetId: string): RuntimeMediaAssetView | null => {
  const row = db.prepare(
    `SELECT assetId, mediaType, payloadJson, createdAt, updatedAt
       FROM media_assets
      WHERE assetId = ?`,
  ).get(assetId) as MediaAssetDbRow | undefined;
  return row ? hydrateMediaAssetRows([row])[0] ?? null : null;
};

/**
 * 资产 → 产出它的任务标识索引（asset list 的「生成来源摘要」数据源，CLI 集成只读消费）。
 * 同一资产被多个任务产出时取最早写入的一条（rowid 序即写入顺序）；无产出入为 null 的行跳过。
 */
export const readTaskOutputAssetIndex = (db: SqliteDatabase): Map<string, string> => {
  const rows = db.prepare(
    `SELECT taskId, assetId
       FROM task_outputs
      WHERE assetId IS NOT NULL
      ORDER BY rowid ASC`,
  ).all() as Array<{ taskId: string; assetId: string }>;
  const index = new Map<string, string>();
  for (const row of rows) {
    if (!index.has(row.assetId)) {
      index.set(row.assetId, row.taskId);
    }
  }
  return index;
};

// ────────────────────────────────────────────
// 打包区 canonical 排序读取（含 isMissing 判定）
// ────────────────────────────────────────────
//
// spec「右侧工作区与打包区服务」要求 storage read 必须按正式排序 canonical 输出：
// 条目按 order ASC。
// isMissing 不持久化，只在此层判定（非三态：isMissing=true ⟺ mediaAsset=null）。

type PackageAreaEntryRow = {
  packageEntryId: string;
  graphId: string;
  order: number;
  assetId: string;
  mediaType: string;
  createdAt: number;
  updatedAt: number;
};

const PACKAGE_AREA_MEDIA_TYPES: ReadonlySet<string> = new Set(['image', 'video', 'audio']);

export const readPackageAreaByGraphId = (
  db: SqliteDatabase,
  graphId: string,
): PackageAreaView => {
  const entryRows = db
    .prepare(
      `SELECT packageEntryId, graphId, "order", assetId, mediaType, createdAt, updatedAt
         FROM package_entries
        WHERE graphId = ?
        ORDER BY "order" ASC`,
    )
    .all(graphId) as PackageAreaEntryRow[];

  const entries: PackageAreaEntryView[] = entryRows.map((row) => {
    const mediaTypeKey = PACKAGE_AREA_MEDIA_TYPES.has(row.mediaType)
      ? (row.mediaType as PackageAreaMediaType)
      : 'image';
    const mediaAsset = readMediaAssetById(db, row.assetId);
    if (mediaAsset === null) {
      console.debug('[editor-storage-read-model] readPackageArea: media asset not found', {
        packageEntryId: row.packageEntryId,
        assetId: row.assetId,
      });
      return {
        packageEntryId: row.packageEntryId,
        graphId: row.graphId,
        order: row.order,
        assetId: row.assetId,
        mediaType: mediaTypeKey,
        createdAt: row.createdAt,
        asset: { assetId: row.assetId, mediaType: mediaTypeKey, isMissing: true, mediaAsset: null },
      };
    }
    return {
      packageEntryId: row.packageEntryId,
      graphId: row.graphId,
      order: row.order,
      assetId: row.assetId,
      mediaType: mediaTypeKey,
      createdAt: row.createdAt,
      asset: { assetId: row.assetId, mediaType: mediaTypeKey, isMissing: false, mediaAsset },
    };
  });

  return { graphId, entries };
};

export const readNodeGraphFromDb = (
  db: SqliteDatabase,
  nodeGraphId: string,
): JsonObject | null => {
  const graphRow = db
    .prepare('SELECT payloadJson FROM graph WHERE id = ? LIMIT 1')
    .get(nodeGraphId) as
    | { payloadJson: string }
    | undefined;
  if (!graphRow) return null;
  const graphPayload = normalizeNodeGraphPayload(
    parseJsonObject(graphRow.payloadJson),
    nodeGraphId,
  );

  const nodeRows = db.prepare('SELECT id, payloadJson FROM nodes').all() as Array<{
    id: string;
    payloadJson: string;
  }>;
  const nodes = nodeRows.map((r) => parseJsonObject(r.payloadJson));

  return { ...graphPayload, nodes };
};

export const readMediaAssetsFromDb = (db: SqliteDatabase): ProjectMediaAssets => {
  const rows = db.prepare(
    `SELECT assetId, mediaType, payloadJson, createdAt, updatedAt
       FROM media_assets
      ORDER BY assetId ASC`,
  ).all() as MediaAssetDbRow[];
  return runtimeMediaAssetViewsToProjectMediaAssets(hydrateMediaAssetRows(rows));
};

export const readManifestFromDb = (db: SqliteDatabase): ManifestRow | null => {
  const row = db.prepare('SELECT version, name, nodeGraphId, createdAt, savedAt, source, stableProjectId FROM project_manifest WHERE id = 1').get() as
    | ManifestRow
    | undefined;
  return row || null;
};

export const buildProjectRecord = (projectPath: string, db: SqliteDatabase): ProjectRecord | null => {
  const manifest = readManifestFromDb(db);
  if (!manifest) return null;

  const nodeGraph = readNodeGraphFromDb(db, manifest.nodeGraphId);
  if (!nodeGraph) return null;
  const mediaAssets = readMediaAssetsFromDb(db);
  const pendingState = getPendingState(db);

  return {
    name: manifest.name,
    nodeGraph,
    mediaAssets,
    savedAt: manifest.savedAt,
    createdAt: manifest.createdAt,
    hasUnsavedChanges: pendingState.hasPendingWrite,
    path: projectPath,
    nodeGraphId: manifest.nodeGraphId,
  };
};

// ────────────────────────────────────────────
// agent 会话域读取（P 组）
// ────────────────────────────────────────────
//
// 行 → 契约记录的投影规则：
// - 标量列直接按 contracts 记录的字段名投影，整体经 AgentSessionRecordSchema /
//   AgentMessageRecordSchema / AgentSendRecordSchema `.parse()` 校验（AGENTS.md：
//   数据库读取属外部输入，消费端必须运行时校验，不得用 `as` 断言）。
// - JSON 列（bodyJson / planJson / contentJson / snapshotJson / 引用 id 数组列）整体
//   JSON.parse 后再做 schema 校验，不做列级拆解（数据库规范禁止脱水/水合）。
//
// 解析或校验失败**直接抛错**，不返回空值也不跳过该行：这些列只由本仓库写入端从契约对象
// 序列化产出，损坏即不变量已被破坏；而消息历史是模型输入，静默丢行会让会话出现无人察觉的
// 缺口（条数与真实行数一致，缺口只体现在内容连续性上），故失败必须暴露给调用方。

type AgentSessionDbRow = {
  agentSessionId: string;
  nodeId: string;
  modelId: string;
  thinkingTier: string;
  approvalMode: string;
  title: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
  /** 最后一条正式消息时间（epoch ms）。零消息会话为 NULL；旧库缺列时读回 undefined。 */
  lastMessageAt: number | null | undefined;
};

type AgentMessageDbRow = {
  agentSessionId: string;
  seq: number;
  role: string;
  requestId: string | null | undefined;
  bodyJson: string;
  planJson: string | null | undefined;
  createdAt: number;
  isPartial: number;
};

type AgentSendRecordDbRow = {
  recordId: string;
  agentSessionId: string;
  nodeId: string | null | undefined;
  requestId: string;
  createdAt: number;
  contentJson: string;
  referenceAssetIdsJson: string;
  snapshotJson: string;
};

const AGENT_SESSION_COLUMNS =
  'agentSessionId, nodeId, modelId, thinkingTier, approvalMode, title, messageCount, createdAt, updatedAt, lastMessageAt';

const parseJsonColumn = (raw: unknown, identity: string): unknown => {
  if (typeof raw !== 'string') {
    throw new Error(`AGENT_STORAGE_JSON_COLUMN_MISSING: ${identity} 不是字符串列值`);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`AGENT_STORAGE_JSON_COLUMN_INVALID: ${identity} 不是合法 JSON（${reason}）`);
  }
};

const parseContract = <T,>(value: unknown, identity: string, schema: ZodType<T>): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`AGENT_STORAGE_RECORD_INVALID: ${identity} 不符合契约（${parsed.error.message}）`);
  }
  return parsed.data;
};

/**
 * 会话行 → 契约记录。`lastMessageAt` 显式收敛：零消息会话与旧库缺列都是「没有消息时间」，
 * 一律读作 null（调用方不得用 `?? updatedAt` 之类的第二兜底源补值）。
 */
export const agentSessionRowToRecord = (row: AgentSessionDbRow): AgentSessionRecord =>
  parseContract(
    { ...row, lastMessageAt: row.lastMessageAt ?? null },
    `agent_sessions[${row.agentSessionId}]`,
    AgentSessionRecordSchema,
  );

const agentMessageRowToRecord = (row: AgentMessageDbRow): AgentMessageRecord =>
  parseContract(
    {
      agentSessionId: row.agentSessionId,
      seq: row.seq,
      role: row.role,
      requestId: row.requestId ?? null,
      body: parseJsonColumn(
        row.bodyJson,
        `agent_messages[${row.agentSessionId}#${row.seq}].bodyJson`,
      ),
      plan:
        row.planJson === null || row.planJson === undefined
          ? null
          : parseJsonColumn(
              row.planJson,
              `agent_messages[${row.agentSessionId}#${row.seq}].planJson`,
            ),
      createdAt: row.createdAt,
      isPartial: row.isPartial !== 0,
    },
    `agent_messages[${row.agentSessionId}#${row.seq}]`,
    AgentMessageRecordSchema,
  );

const agentSendRecordRowToRecord = (row: AgentSendRecordDbRow): AgentSendRecord =>
  parseContract(
    {
      recordId: row.recordId,
      agentSessionId: row.agentSessionId,
      nodeId: row.nodeId ?? null,
      requestId: row.requestId,
      createdAt: row.createdAt,
      content: parseJsonColumn(
        row.contentJson,
        `agent_send_records[${row.recordId}].contentJson`,
      ),
      referenceAssetIds: parseJsonColumn(
        row.referenceAssetIdsJson,
        `agent_send_records[${row.recordId}].referenceAssetIdsJson`,
      ),
      snapshot: parseJsonColumn(row.snapshotJson, `agent_send_records[${row.recordId}].snapshotJson`),
    },
    `agent_send_records[${row.recordId}]`,
    AgentSendRecordSchema,
  );

/**
 * 全项目会话记录（元数据）。
 *
 * 会话归属画布经节点推导（项目与画布 1:1），无跨项目/全局会话读取语义，
 * 故此处即「该项目全部会话」，按 createdAt 升序（会话创建顺序，稳定且与 updatedAt 无关）。
 */
export const readAgentSessions = (db: SqliteDatabase): AgentSessionRecord[] => {
  const rows = db
    .prepare(
      `SELECT ${AGENT_SESSION_COLUMNS}
         FROM agent_sessions
        ORDER BY createdAt ASC, agentSessionId ASC`,
    )
    .all() as AgentSessionDbRow[];
  return rows.map(agentSessionRowToRecord);
};

/** 按 Agent 节点读取会话；未建立会话时返回 null（nodeId 有 UNIQUE 约束，至多一行）。 */
export const readAgentSessionByNodeId = (
  db: SqliteDatabase,
  nodeId: string,
): AgentSessionRecord | null => {
  const row = db
    .prepare(`SELECT ${AGENT_SESSION_COLUMNS} FROM agent_sessions WHERE nodeId = ?`)
    .get(nodeId) as AgentSessionDbRow | undefined;
  return row === undefined ? null : agentSessionRowToRecord(row);
};

/** 会话正式消息，按 seq 升序（seq 由写入端单调分配，读取顺序即会话内顺序）。 */
export const readAgentMessages = (
  db: SqliteDatabase,
  agentSessionId: string,
): AgentMessageRecord[] => {
  const rows = db
    .prepare(
      `SELECT agentSessionId, seq, role, requestId, bodyJson, planJson, createdAt, isPartial
         FROM agent_messages
        WHERE agentSessionId = ?
        ORDER BY seq ASC`,
    )
    .all(agentSessionId) as AgentMessageDbRow[];
  return rows.map(agentMessageRowToRecord);
};

/** 本地发送留痕，按 createdAt 升序（发送发生顺序；同一毫秒内按 recordId 兜底稳定排序）。 */
export const readAgentSendRecords = (
  db: SqliteDatabase,
  agentSessionId: string,
): AgentSendRecord[] => {
  const rows = db
    .prepare(
      `SELECT recordId, agentSessionId, nodeId, requestId, createdAt,
              contentJson, referenceAssetIdsJson, snapshotJson
         FROM agent_send_records
        WHERE agentSessionId = ?
        ORDER BY createdAt ASC, recordId ASC`,
    )
    .all(agentSessionId) as AgentSendRecordDbRow[];
  return rows.map(agentSendRecordRowToRecord);
};

type AgentToolCallDbRow = {
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

const agentToolCallRowToRecord = (row: AgentToolCallDbRow): AgentToolCallRecord =>
  parseContract(
    {
      toolCallId: row.toolCallId,
      agentSessionId: row.agentSessionId,
      seq: row.seq,
      toolName: row.toolName,
      toolKind: row.toolKind,
      modelId: row.modelId,
      status: row.status,
      batchId: row.batchId,
      taskIds: parseJsonColumn(row.taskIdsJson, `agent_tool_calls[${row.toolCallId}].taskIdsJson`),
      assetIds: parseJsonColumn(row.assetIdsJson, `agent_tool_calls[${row.toolCallId}].assetIdsJson`),
      errorSummary: row.errorSummary,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    `agent_tool_calls[${row.toolCallId}]`,
    AgentToolCallRecordSchema,
  );

/** 会话工具调用记录，按 seq 升序（seq 由写入端单调分配，与消息 seq 独立计数）。 */
export const readAgentToolCalls = (
  db: SqliteDatabase,
  agentSessionId: string,
): AgentToolCallRecord[] => {
  const rows = db
    .prepare(
      `SELECT toolCallId, agentSessionId, seq, toolName, toolKind, modelId, status,
              batchId, taskIdsJson, assetIdsJson, errorSummary, createdAt, updatedAt
         FROM agent_tool_calls
        WHERE agentSessionId = ?
        ORDER BY seq ASC`,
    )
    .all(agentSessionId) as AgentToolCallDbRow[];
  return rows.map(agentToolCallRowToRecord);
};
