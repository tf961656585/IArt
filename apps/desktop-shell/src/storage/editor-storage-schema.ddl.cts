/**
 * Editor Storage DDL — 表定义与校验元数据
 *
 * 承载 DDL 语句、列/索引校验期望值和辅助类型。
 * 被 editor-storage-schema.cts 消费，不直接对外导出业务逻辑。
 */

import { UNIFIED_GENERATION_STATUSES } from '@iart/contracts';

export const RUNTIME_TASK_STATUS_CHECK = UNIFIED_GENERATION_STATUSES
  .map((status) => `'${status}'`)
  .join(', ');

/**
 * P 组：agent 会话域的表与索引 DDL。
 *
 * 单独成组导出：新库建库（DDL_STATEMENTS）与 v14→v15 迁移（editor-storage-schema.cts）
 * 消费同一份语句文本，避免「迁移建出的表」与「新库建出的表」列定义漂移——
 * 这类漂移只会被 assertLatestSchema 告警，不会报红。
 * 全部语句为 IF NOT EXISTS，可重复执行（迁移必须幂等）。
 *
 * 会话不经 graphId 二级归属（项目与画布 1:1，归属由 nodeId 推导）。
 * 会话表不加指向 nodes(id) 的外键：节点写入与会话创建是两条异步通道，
 * 外键会在顺序竞态下拒绝合法写入；节点删除时的会话清理由
 * editor-storage-delta.cts 的节点删除咽喉在同一事务内显式完成。
 */
export const AGENT_SESSION_DDL_STATEMENTS = [
  // lastMessageAt：最后一条正式消息的时间（epoch ms），零消息会话为 NULL（null 即「还没有消息」）。
  // 由写入端维护（appendAgentMessage 同事务推进），与 updatedAt（含配置变更）是两个口径。
  // 旧库由 v16→v17 迁移补列并回填（见 editor-storage-schema.cts）。
  `CREATE TABLE IF NOT EXISTS agent_sessions (
    agentSessionId TEXT PRIMARY KEY,
    nodeId TEXT NOT NULL UNIQUE,
    modelId TEXT NOT NULL,
    thinkingTier TEXT NOT NULL,
    approvalMode TEXT NOT NULL,
    title TEXT NOT NULL,
    messageCount INTEGER NOT NULL DEFAULT 0,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL,
    lastMessageAt INTEGER
  )`,

  // 消息表无独立主键行：消息身份是 (agentSessionId, seq)，写入端分配 seq。
  `CREATE TABLE IF NOT EXISTS agent_messages (
    agentSessionId TEXT NOT NULL REFERENCES agent_sessions(agentSessionId) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL,
    requestId TEXT,
    bodyJson TEXT NOT NULL,
    planJson TEXT,
    createdAt INTEGER NOT NULL,
    isPartial INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (agentSessionId, seq)
  )`,

  // 工具调用记录（spec 03「消息、规划与工具调用记录」）：生成/加工两类工具共用一张表，
  // toolName / toolKind 标识工具，modelId 加工类为 NULL，batchId/taskIds 加工类为空。
  `CREATE TABLE IF NOT EXISTS agent_tool_calls (
    toolCallId TEXT PRIMARY KEY,
    agentSessionId TEXT NOT NULL REFERENCES agent_sessions(agentSessionId) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    toolName TEXT NOT NULL DEFAULT '',
    toolKind TEXT NOT NULL DEFAULT 'generation',
    modelId TEXT,
    status TEXT NOT NULL,
    batchId TEXT,
    taskIdsJson TEXT NOT NULL DEFAULT '[]',
    assetIdsJson TEXT NOT NULL DEFAULT '[]',
    errorSummary TEXT,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS agent_tool_calls_agentSessionId_seq_idx
    ON agent_tool_calls (agentSessionId, seq)`,

  // 本地发送留痕（发送点击即写，先于 Backend 受理可见）。
  //
  // 留痕生命周期**故意独立于会话创建**，故 agentSessionId 不建指向 agent_sessions 的外键：
  // 首条留痕必须在受理之前落库（「保护用户意图，先于受理可见」），而首条消息在受理前
  // 既无 Agent 节点也无会话行，外键会在用户第一次发送时就违约。
  // 同理 nodeId 可空：受理创建节点前写入的留痕没有节点宿主，由后续留痕携带节点 id。
  // 因此留痕的节点/会话清理不靠外键级联，而是由节点删除咽喉按 nodeId 与 agentSessionId 显式删除
  // （见 editor-storage-delta.cts）。
  `CREATE TABLE IF NOT EXISTS agent_send_records (
    recordId TEXT PRIMARY KEY,
    agentSessionId TEXT NOT NULL,
    nodeId TEXT,
    requestId TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    contentJson TEXT NOT NULL,
    referenceAssetIdsJson TEXT NOT NULL DEFAULT '[]',
    snapshotJson TEXT NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS agent_send_records_agentSessionId_createdAt_idx
    ON agent_send_records (agentSessionId, createdAt)`,

  // 节点删除清理按 nodeId 定位留痕（含受理前 nodeId 为 NULL 的行之外的全部留痕）。
  `CREATE INDEX IF NOT EXISTS agent_send_records_nodeId_idx
    ON agent_send_records (nodeId)`,
];

export const DDL_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS project_manifest (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL,
    name TEXT NOT NULL,
    nodeGraphId TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    savedAt INTEGER NOT NULL,
    source TEXT,
    migratedAt INTEGER,
    stableProjectId TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS graph (
    id TEXT PRIMARY KEY,
    payloadJson TEXT NOT NULL,
    updatedAt INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    payloadJson TEXT NOT NULL,
    updatedAt INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS media_assets (
    assetId TEXT PRIMARY KEY,
    mediaType TEXT NOT NULL,
    payloadJson TEXT NOT NULL,
    createdAt INTEGER,
    updatedAt INTEGER
  )`,

  `CREATE TABLE IF NOT EXISTS project_pending_deltas (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    payloadJson TEXT NOT NULL,
    createdAt INTEGER NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS project_pending_deltas_createdAt_idx
    ON project_pending_deltas (createdAt)`,

  `CREATE TABLE IF NOT EXISTS tasks (
    taskId TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN (${RUNTIME_TASK_STATUS_CHECK})),
    projectPath TEXT NOT NULL,
    sourceNodeId TEXT,
    targetNodeId TEXT,
    batchId TEXT,
    requestJson TEXT,
    metadataJson TEXT,
    remoteRequestId TEXT,
    progressPercent INTEGER,
    progressMessage TEXT,
    progressPhase TEXT,
    errorMessage TEXT,
    errorCode TEXT,
    failureJson TEXT,
    createdAt INTEGER,
    updatedAt INTEGER,
    startedAt INTEGER,
    finishedAt INTEGER
  )`,

  // 读通道查询形状索引（v19 起）：readTasksByBatchId 按 batchId、readAllTasks 按 status 过滤 /
  // createdAt 排序（spec storage-schema.md runtime_domain.tasks）。
  `CREATE INDEX IF NOT EXISTS tasks_batchId_idx
    ON tasks (batchId)`,

  `CREATE INDEX IF NOT EXISTS tasks_status_idx
    ON tasks (status)`,

  `CREATE INDEX IF NOT EXISTS tasks_createdAt_idx
    ON tasks (createdAt)`,

  `CREATE TABLE IF NOT EXISTS task_outputs (
    outputId TEXT PRIMARY KEY,
    taskId TEXT NOT NULL,
    assetId TEXT,
    mediaType TEXT NOT NULL,
    textValue TEXT,
    sortOrder INTEGER,
    FOREIGN KEY (taskId) REFERENCES tasks(taskId),
    FOREIGN KEY (assetId) REFERENCES media_assets(assetId)
  )`,

  `CREATE INDEX IF NOT EXISTS task_outputs_taskId_idx
    ON task_outputs (taskId)`,

  // 资产 → 任务反查（readMediaAssetsByTaskId 的 assetId join 与 readTaskOutputAssetIndex 扫描）。
  `CREATE INDEX IF NOT EXISTS task_outputs_assetId_idx
    ON task_outputs (assetId)`,

  `CREATE TABLE IF NOT EXISTS task_events (
    eventId INTEGER PRIMARY KEY AUTOINCREMENT,
    taskId TEXT NOT NULL,
    eventType TEXT NOT NULL,
    payload TEXT,
    createdAt INTEGER,
    FOREIGN KEY (taskId) REFERENCES tasks(taskId)
  )`,

  `CREATE INDEX IF NOT EXISTS task_events_taskId_idx
    ON task_events (taskId)`,

  // clientRequestId：客户端受理幂等键（spec docs/integrations/CLI与本地Agent集成.md §5.4 受理幂等键，
  // 2026-10-14 v0.6.8 新增）。可空：界面提交不携带幂等键；SQLite 唯一索引对 NULL 不去重，
  // 多个无幂等键批次可并存；非空值唯一 → 同 request_id 重复受理在写入层硬拒（去重读取的兜底防线）。
  `CREATE TABLE IF NOT EXISTS batches (
    batchId TEXT PRIMARY KEY,
    payloadJson TEXT NOT NULL,
    clientRequestId TEXT,
    createdAt INTEGER,
    updatedAt INTEGER
  )`,

  `CREATE UNIQUE INDEX IF NOT EXISTS batches_clientRequestId_idx
    ON batches (clientRequestId)`,

  `CREATE TABLE IF NOT EXISTS chat_sessions (
    sessionId TEXT PRIMARY KEY,
    graphId TEXT NOT NULL,
    modelId TEXT NOT NULL,
    title TEXT NOT NULL,
    titleAutoNamed INTEGER NOT NULL DEFAULT 1,
    systemPromptId TEXT,
    parameterOverridesJson TEXT,
    contextWindowTokens INTEGER NOT NULL,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS chat_sessions_graphId_idx
    ON chat_sessions (graphId)`,

  `CREATE TABLE IF NOT EXISTS chat_messages (
    messageId TEXT PRIMARY KEY,
    sessionId TEXT NOT NULL REFERENCES chat_sessions(sessionId) ON DELETE CASCADE,
    role TEXT NOT NULL,
    contentJson TEXT NOT NULL,
    tokenCount INTEGER,
    isPartial INTEGER NOT NULL DEFAULT 0,
    createdAt INTEGER NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS chat_messages_sessionId_idx
    ON chat_messages (sessionId)`,

  `CREATE TABLE IF NOT EXISTS chat_send_records (
    messageId TEXT PRIMARY KEY,
    sessionId TEXT NOT NULL REFERENCES chat_sessions(sessionId) ON DELETE CASCADE,
    role TEXT NOT NULL,
    contentJson TEXT NOT NULL,
    status TEXT NOT NULL,
    systemPromptId TEXT,
    parameterOverridesJson TEXT,
    errorText TEXT,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS chat_send_records_sessionId_idx
    ON chat_send_records (sessionId)`,

  `CREATE TABLE IF NOT EXISTS package_entries (
    packageEntryId TEXT PRIMARY KEY,
    graphId TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    assetId TEXT NOT NULL,
    mediaType TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS package_entries_graphId_idx
    ON package_entries (graphId)`,

  // P 组：agent 会话域（表与索引 DDL 见 AGENT_SESSION_DDL_STATEMENTS）
  ...AGENT_SESSION_DDL_STATEMENTS,
];

export type ExpectedColumn = {
  name: string;
  type: string;
  notNull: boolean | undefined;
  primaryKey: boolean | undefined;
};

export type ExpectedTable = {
  name: string;
  columns: ExpectedColumn[];
  indexes: string[] | undefined;
};

export type TableInfoRow = {
  name: unknown;
  type: unknown;
  notnull: unknown;
  pk: unknown;
};

export type IndexInfoRow = {
  name: unknown;
};

export type TableNameRow = {
  name: unknown;
  type: unknown | undefined;
};

export const EXPECTED_TABLES: ExpectedTable[] = [
  {
    name: 'meta',
    columns: [
      { name: 'key', type: 'TEXT', notNull: true, primaryKey: true },
      { name: 'value', type: 'TEXT', notNull: true, primaryKey: false },
    ],
    indexes: undefined,
  },
  {
    name: 'project_manifest',
    columns: [
      { name: 'id', type: 'INTEGER', notNull: true, primaryKey: true },
      { name: 'version', type: 'INTEGER', notNull: true, primaryKey: false },
      { name: 'name', type: 'TEXT', notNull: true, primaryKey: false },
      { name: 'nodeGraphId', type: 'TEXT', notNull: true, primaryKey: false },
      { name: 'createdAt', type: 'INTEGER', notNull: true, primaryKey: false },
      { name: 'savedAt', type: 'INTEGER', notNull: true, primaryKey: false },
      { name: 'source', type: 'TEXT', notNull: false, primaryKey: false },
      { name: 'migratedAt', type: 'INTEGER', notNull: false, primaryKey: false },
      { name: 'stableProjectId', type: 'TEXT', notNull: false, primaryKey: false },
    ],
    indexes: undefined,
  },
  {
    name: 'graph',
    columns: [
      { name: 'id', type: 'TEXT', notNull: true, primaryKey: true },
      { name: 'payloadJson', type: 'TEXT', notNull: true, primaryKey: false },
      { name: 'updatedAt', type: 'INTEGER', notNull: true, primaryKey: false },
    ],
    indexes: undefined,
  },
  {
    name: 'nodes',
    columns: [
      { name: 'id', type: 'TEXT', notNull: true, primaryKey: true },
      { name: 'payloadJson', type: 'TEXT', notNull: true, primaryKey: false },
      { name: 'updatedAt', type: 'INTEGER', notNull: true, primaryKey: false },
    ],
    indexes: undefined,
  },
  {
    name: 'media_assets',
    columns: [
      { name: 'assetId', type: 'TEXT', notNull: true, primaryKey: true },
      { name: 'mediaType', type: 'TEXT', notNull: true, primaryKey: false },
      { name: 'payloadJson', type: 'TEXT', notNull: true, primaryKey: false },
      { name: 'createdAt', type: 'INTEGER', notNull: false, primaryKey: false },
      { name: 'updatedAt', type: 'INTEGER', notNull: false, primaryKey: false },
    ],
    indexes: undefined,
  },
  {
    name: 'project_pending_deltas',
    columns: [
      { name: 'seq', type: 'INTEGER', notNull: true, primaryKey: true },
      { name: 'payloadJson', type: 'TEXT', notNull: true, primaryKey: false },
      { name: 'createdAt', type: 'INTEGER', notNull: true, primaryKey: false },
    ],
    indexes: ['project_pending_deltas_createdAt_idx'],
  },
  {
    name: 'tasks',
    columns: [
      { name: 'taskId', type: 'TEXT', notNull: true, primaryKey: true },
      { name: 'status', type: 'TEXT', notNull: true, primaryKey: false },
      { name: 'projectPath', type: 'TEXT', notNull: true, primaryKey: false },
      { name: 'sourceNodeId', type: 'TEXT', notNull: false, primaryKey: false },
      { name: 'targetNodeId', type: 'TEXT', notNull: false, primaryKey: false },
      { name: 'batchId', type: 'TEXT', notNull: false, primaryKey: false },
      { name: 'requestJson', type: 'TEXT', notNull: false, primaryKey: false },
      { name: 'metadataJson', type: 'TEXT', notNull: false, primaryKey: false },
      { name: 'remoteRequestId', type: 'TEXT', notNull: false, primaryKey: false },
      { name: 'progressPercent', type: 'INTEGER', notNull: false, primaryKey: false },
      { name: 'progressMessage', type: 'TEXT', notNull: false, primaryKey: false },
      { name: 'progressPhase', type: 'TEXT', notNull: false, primaryKey: false },
      { name: 'errorMessage', type: 'TEXT', notNull: false, primaryKey: false },
      { name: 'errorCode', type: 'TEXT', notNull: false, primaryKey: false },
      { name: 'failureJson', type: 'TEXT', notNull: false, primaryKey: false },
      { name: 'createdAt', type: 'INTEGER', notNull: false, primaryKey: false },
      { name: 'updatedAt', type: 'INTEGER', notNull: false, primaryKey: false },
      { name: 'startedAt', type: 'INTEGER', notNull: false, primaryKey: false },
      { name: 'finishedAt', type: 'INTEGER', notNull: false, primaryKey: false },
    ],
    indexes: [
      'tasks_batchId_idx',
      'tasks_status_idx',
      'tasks_createdAt_idx',
    ],
  },
  {
    name: 'task_outputs',
    columns: [
      { name: 'outputId', type: 'TEXT', notNull: true, primaryKey: true },
      { name: 'taskId', type: 'TEXT', notNull: true, primaryKey: false },
      { name: 'assetId', type: 'TEXT', notNull: false, primaryKey: false },
      { name: 'mediaType', type: 'TEXT', notNull: true, primaryKey: false },
      { name: 'textValue', type: 'TEXT', notNull: false, primaryKey: false },
      { name: 'sortOrder', type: 'INTEGER', notNull: false, primaryKey: false },
    ],
    indexes: ['task_outputs_taskId_idx', 'task_outputs_assetId_idx'],
  },
  {
    name: 'task_events',
    columns: [
      { name: 'eventId', type: 'INTEGER', notNull: true, primaryKey: true },
      { name: 'taskId', type: 'TEXT', notNull: true, primaryKey: false },
      { name: 'eventType', type: 'TEXT', notNull: true, primaryKey: false },
      { name: 'payload', type: 'TEXT', notNull: false, primaryKey: false },
      { name: 'createdAt', type: 'INTEGER', notNull: false, primaryKey: false },
    ],
    indexes: ['task_events_taskId_idx'],
  },
  {
    name: 'batches',
    columns: [
      { name: 'batchId', type: 'TEXT', notNull: true, primaryKey: true },
      { name: 'payloadJson', type: 'TEXT', notNull: true, primaryKey: false },
      { name: 'clientRequestId', type: 'TEXT', notNull: false, primaryKey: false },
      { name: 'createdAt', type: 'INTEGER', notNull: false, primaryKey: false },
      { name: 'updatedAt', type: 'INTEGER', notNull: false, primaryKey: false },
    ],
    indexes: ['batches_clientRequestId_idx'],
  },
  {
    name: 'chat_sessions',
    columns: [
      { name: 'sessionId', type: 'TEXT', notNull: true, primaryKey: true },
      { name: 'graphId', type: 'TEXT', notNull: true, primaryKey: false },
      { name: 'modelId', type: 'TEXT', notNull: true, primaryKey: false },
      { name: 'title', type: 'TEXT', notNull: true, primaryKey: false },
      { name: 'titleAutoNamed', type: 'INTEGER', notNull: true, primaryKey: false },
      { name: 'systemPromptId', type: 'TEXT', notNull: false, primaryKey: false },
      { name: 'parameterOverridesJson', type: 'TEXT', notNull: false, primaryKey: false },
      { name: 'contextWindowTokens', type: 'INTEGER', notNull: true, primaryKey: false },
      { name: 'createdAt', type: 'INTEGER', notNull: true, primaryKey: false },
      { name: 'updatedAt', type: 'INTEGER', notNull: true, primaryKey: false },
    ],
    indexes: ['chat_sessions_graphId_idx'],
  },
  {
    name: 'chat_messages',
    columns: [
      { name: 'messageId', type: 'TEXT', notNull: true, primaryKey: true },
      { name: 'sessionId', type: 'TEXT', notNull: true, primaryKey: false },
      { name: 'role', type: 'TEXT', notNull: true, primaryKey: false },
      { name: 'contentJson', type: 'TEXT', notNull: true, primaryKey: false },
      { name: 'tokenCount', type: 'INTEGER', notNull: false, primaryKey: false },
      { name: 'isPartial', type: 'INTEGER', notNull: true, primaryKey: false },
      { name: 'createdAt', type: 'INTEGER', notNull: true, primaryKey: false },
    ],
    indexes: ['chat_messages_sessionId_idx'],
  },
  {
    name: 'chat_send_records',
    columns: [
      { name: 'messageId', type: 'TEXT', notNull: true, primaryKey: true },
      { name: 'sessionId', type: 'TEXT', notNull: true, primaryKey: false },
      { name: 'role', type: 'TEXT', notNull: true, primaryKey: false },
      { name: 'contentJson', type: 'TEXT', notNull: true, primaryKey: false },
      { name: 'status', type: 'TEXT', notNull: true, primaryKey: false },
      { name: 'systemPromptId', type: 'TEXT', notNull: false, primaryKey: false },
      { name: 'parameterOverridesJson', type: 'TEXT', notNull: false, primaryKey: false },
      { name: 'errorText', type: 'TEXT', notNull: false, primaryKey: false },
      { name: 'createdAt', type: 'INTEGER', notNull: true, primaryKey: false },
      { name: 'updatedAt', type: 'INTEGER', notNull: true, primaryKey: false },
    ],
    indexes: ['chat_send_records_sessionId_idx'],
  },
  {
    name: 'package_entries',
    columns: [
      { name: 'packageEntryId', type: 'TEXT', notNull: true, primaryKey: true },
      { name: 'graphId', type: 'TEXT', notNull: true, primaryKey: false },
      { name: 'order', type: 'INTEGER', notNull: true, primaryKey: false },
      { name: 'assetId', type: 'TEXT', notNull: true, primaryKey: false },
      { name: 'mediaType', type: 'TEXT', notNull: true, primaryKey: false },
      { name: 'createdAt', type: 'INTEGER', notNull: true, primaryKey: false },
      { name: 'updatedAt', type: 'INTEGER', notNull: true, primaryKey: false },
    ],
    indexes: ['package_entries_graphId_idx'],
  },
  {
    name: 'agent_sessions',
    columns: [
      { name: 'agentSessionId', type: 'TEXT', notNull: true, primaryKey: true },
      { name: 'nodeId', type: 'TEXT', notNull: true, primaryKey: false },
      { name: 'modelId', type: 'TEXT', notNull: true, primaryKey: false },
      { name: 'thinkingTier', type: 'TEXT', notNull: true, primaryKey: false },
      { name: 'approvalMode', type: 'TEXT', notNull: true, primaryKey: false },
      { name: 'title', type: 'TEXT', notNull: true, primaryKey: false },
      { name: 'messageCount', type: 'INTEGER', notNull: true, primaryKey: false },
      { name: 'createdAt', type: 'INTEGER', notNull: true, primaryKey: false },
      { name: 'updatedAt', type: 'INTEGER', notNull: true, primaryKey: false },
      { name: 'lastMessageAt', type: 'INTEGER', notNull: false, primaryKey: false },
    ],
    // nodeId 的 UNIQUE 约束已提供按节点查询的隐式索引，不另建重复索引。
    indexes: undefined,
  },
  {
    name: 'agent_messages',
    columns: [
      { name: 'agentSessionId', type: 'TEXT', notNull: true, primaryKey: true },
      { name: 'seq', type: 'INTEGER', notNull: true, primaryKey: true },
      { name: 'role', type: 'TEXT', notNull: true, primaryKey: false },
      { name: 'requestId', type: 'TEXT', notNull: false, primaryKey: false },
      { name: 'bodyJson', type: 'TEXT', notNull: true, primaryKey: false },
      { name: 'planJson', type: 'TEXT', notNull: false, primaryKey: false },
      { name: 'createdAt', type: 'INTEGER', notNull: true, primaryKey: false },
      { name: 'isPartial', type: 'INTEGER', notNull: true, primaryKey: false },
    ],
    // 复合主键 (agentSessionId, seq) 即读取/级联删除的索引，不另建重复索引。
    indexes: undefined,
  },
  {
    name: 'agent_tool_calls',
    columns: [
      { name: 'toolCallId', type: 'TEXT', notNull: true, primaryKey: true },
      { name: 'agentSessionId', type: 'TEXT', notNull: true, primaryKey: false },
      { name: 'seq', type: 'INTEGER', notNull: true, primaryKey: false },
      { name: 'toolName', type: 'TEXT', notNull: true, primaryKey: false },
      { name: 'toolKind', type: 'TEXT', notNull: true, primaryKey: false },
      { name: 'modelId', type: 'TEXT', notNull: false, primaryKey: false },
      { name: 'status', type: 'TEXT', notNull: true, primaryKey: false },
      { name: 'batchId', type: 'TEXT', notNull: false, primaryKey: false },
      { name: 'taskIdsJson', type: 'TEXT', notNull: true, primaryKey: false },
      { name: 'assetIdsJson', type: 'TEXT', notNull: true, primaryKey: false },
      { name: 'errorSummary', type: 'TEXT', notNull: false, primaryKey: false },
      { name: 'createdAt', type: 'INTEGER', notNull: true, primaryKey: false },
      { name: 'updatedAt', type: 'INTEGER', notNull: true, primaryKey: false },
    ],
    indexes: ['agent_tool_calls_agentSessionId_seq_idx'],
  },
  {
    name: 'agent_send_records',
    columns: [
      { name: 'recordId', type: 'TEXT', notNull: true, primaryKey: true },
      { name: 'agentSessionId', type: 'TEXT', notNull: true, primaryKey: false },
      { name: 'nodeId', type: 'TEXT', notNull: false, primaryKey: false },
      { name: 'requestId', type: 'TEXT', notNull: true, primaryKey: false },
      { name: 'createdAt', type: 'INTEGER', notNull: true, primaryKey: false },
      { name: 'contentJson', type: 'TEXT', notNull: true, primaryKey: false },
      { name: 'referenceAssetIdsJson', type: 'TEXT', notNull: true, primaryKey: false },
      { name: 'snapshotJson', type: 'TEXT', notNull: true, primaryKey: false },
    ],
    indexes: [
      'agent_send_records_agentSessionId_createdAt_idx',
      'agent_send_records_nodeId_idx',
    ],
  },
];
