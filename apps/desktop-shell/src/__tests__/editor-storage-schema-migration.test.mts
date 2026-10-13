// @vitest-environment node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { beforeAll, describe, it } from 'vitest';

import Database from 'better-sqlite3';

const workspaceRoot = process.cwd();
const requireDesktop = createRequire(import.meta.url);
const schemaEntry = `${workspaceRoot}/apps/desktop-shell/dist/storage/editor-storage-schema.cjs`;

type StorageSchemaModule = {
  CURRENT_SCHEMA_VERSION: number;
  CURRENT_STORAGE_SCHEMA_ID: string;
  STORAGE_SCHEMA_META_KEY: string;
  STORAGE_SCHEMA_VERSION_KEY: string;
  initSchema: (db: unknown) => void;
};

const loadSchemaModule = (): StorageSchemaModule =>
  requireDesktop(schemaEntry) as StorageSchemaModule;

/**
 * v0 时代的旧库结构（meta + 早期业务表，无 storage_schema_version）。
 * 一次性裁断后不再支持迁移打开，仅用于验证旧库被拒绝。
 */
const LEGACY_DDL = `
  CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE project_manifest (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL,
    name TEXT NOT NULL,
    nodeGraphId TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    savedAt INTEGER NOT NULL,
    source TEXT,
    migratedAt INTEGER
  );
  CREATE TABLE graph (
    id TEXT PRIMARY KEY,
    payloadJson TEXT NOT NULL,
    updatedAt INTEGER NOT NULL
  );
  CREATE TABLE tasks (
    taskId TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    projectPath TEXT NOT NULL,
    createdAt INTEGER,
    updatedAt INTEGER
  );
`;

const tableNames = (db: InstanceType<typeof Database>): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
    .map((row) => row.name)
    .sort();

const columnNames = (db: InstanceType<typeof Database>, table: string): string[] =>
  (db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>)
    .map((col) => col.name);

describe('editor storage schema（裁断后迁移：v11 → v15 自动升级，低于起点拒绝打开）', () => {
  beforeAll(() => {
    if (!existsSync(schemaEntry)) {
      execFileSync('pnpm', ['--filter', '@iart/desktop-shell', 'build'], {
        cwd: workspaceRoot,
        stdio: 'pipe',
      });
    }
  });

  it('空库初始化：写入当前版本号与 schema 标识', () => {
    const schema = loadSchemaModule();
    const db = new Database(':memory:');
    try {
      schema.initSchema(db);

      const versionRow = db.prepare('SELECT value FROM meta WHERE key = ?').get(
        schema.STORAGE_SCHEMA_VERSION_KEY,
      ) as { value: string } | undefined;
      assert.ok(versionRow !== undefined, 'storage_schema_version should exist in meta');
      assert.equal(Number(versionRow.value), schema.CURRENT_SCHEMA_VERSION);

      const idRow = db.prepare('SELECT value FROM meta WHERE key = ?').get(
        schema.STORAGE_SCHEMA_META_KEY,
      ) as { value: string } | undefined;
      assert.equal(idRow?.value, schema.CURRENT_STORAGE_SCHEMA_ID);
    } finally {
      db.close();
    }
  });

  it('空库初始化：按当前 DDL 建出全部表（含历史迁移产物合入当前 DDL 的结构）', () => {
    const schema = loadSchemaModule();
    const db = new Database(':memory:');
    try {
      schema.initSchema(db);

      const tables = tableNames(db);
      for (const expected of [
        'meta',
        'project_manifest',
        'graph',
        'nodes',
        'media_assets',
        'tasks',
        'task_outputs',
        'task_events',
        'batches',
        'chat_sessions',
        'chat_messages',
        'chat_send_records',
        'package_entries',
        'agent_sessions',
        'agent_messages',
        'agent_tool_calls',
        'agent_send_records',
      ]) {
        assert.ok(tables.includes(expected), `table ${expected} should exist`);
      }

      // 当前 chat_sessions 归属画布级（graphId），无历史 nodeId 列，含 title/titleAutoNamed。
      const sessionCols = columnNames(db, 'chat_sessions');
      assert.ok(sessionCols.includes('graphId'), 'chat_sessions.graphId should exist');
      assert.ok(sessionCols.includes('title'), 'chat_sessions.title should exist');
      assert.ok(sessionCols.includes('titleAutoNamed'), 'chat_sessions.titleAutoNamed should exist');
      assert.ok(!sessionCols.includes('nodeId'), 'chat_sessions.nodeId should not exist');

      // 当前 tasks 不含已废弃的 requestBodyJson。
      const taskCols = columnNames(db, 'tasks');
      assert.ok(taskCols.includes('failureJson'), 'tasks.failureJson should exist');
      assert.ok(taskCols.includes('progressPhase'), 'tasks.progressPhase should exist');
      assert.ok(!taskCols.includes('requestBodyJson'), 'tasks.requestBodyJson should not exist');

      // project_manifest 含 stableProjectId。
      assert.ok(
        columnNames(db, 'project_manifest').includes('stableProjectId'),
        'project_manifest.stableProjectId should exist',
      );
    } finally {
      db.close();
    }
  });

  it('当前版本库重复打开幂等：版本号不变、不报错', () => {
    const schema = loadSchemaModule();
    const db = new Database(':memory:');
    try {
      schema.initSchema(db);

      const versionBefore = db.prepare('SELECT value FROM meta WHERE key = ?').get(
        schema.STORAGE_SCHEMA_VERSION_KEY,
      ) as { value: string } | undefined;
      assert.ok(versionBefore !== undefined);

      schema.initSchema(db);

      const versionAfter = db.prepare('SELECT value FROM meta WHERE key = ?').get(
        schema.STORAGE_SCHEMA_VERSION_KEY,
      ) as { value: string } | undefined;
      assert.ok(versionAfter !== undefined);
      assert.equal(versionAfter.value, versionBefore.value, 'version should not change');
    } finally {
      db.close();
    }
  });

  it('v0 旧库（无版本号）打开时明确报错拒绝，不迁移、不改库', () => {
    const schema = loadSchemaModule();
    const db = new Database(':memory:');
    try {
      db.exec(LEGACY_DDL);

      assert.throws(
        () => schema.initSchema(db),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /PROJECT_SQLITE_SCHEMA_MISMATCH/);
          assert.match(error.message, /不再支持迁移打开/);
          return true;
        },
      );

      // 库内容未被改动：没有补建 chat_sessions，也没有写入版本号。
      assert.ok(!tableNames(db).includes('chat_sessions'), 'legacy db should not gain new tables');
      const versionRow = db.prepare('SELECT value FROM meta WHERE key = ?').get(
        schema.STORAGE_SCHEMA_VERSION_KEY,
      ) as { value: string } | undefined;
      assert.equal(versionRow, undefined, 'version should not be written on rejection');
    } finally {
      db.close();
    }
  });

  it('v11 until-x 库打开时自动沿链迁移到当前版本（batches 重建为 GenerationBatch 形状）', () => {
    const schema = loadSchemaModule();
    const db = new Database(':memory:');
    try {
      // 构造一个 v11 库：meta 表写入 storage_schema_version=11 + 旧的 until-x batches 表。
      db.exec(`
        CREATE TABLE meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        INSERT INTO meta (key, value) VALUES ('storage_schema_version', '11');
        CREATE TABLE batches (
          batchId TEXT PRIMARY KEY,
          sourceNodeId TEXT,
          targetSuccessCount INTEGER NOT NULL,
          cancelRequested INTEGER,
          createdAt INTEGER,
          updatedAt INTEGER
        );
        INSERT INTO batches (batchId, sourceNodeId, targetSuccessCount, cancelRequested, createdAt, updatedAt)
          VALUES ('batch-legacy-1', 'source-1', 3, 1, 1000, 2000);
      `);

      schema.initSchema(db);

      // 版本号沿迁移链迁到当前版本（v11 → v12 → v13 → v14）
      const versionRow = db.prepare('SELECT value FROM meta WHERE key = ?').get(
        schema.STORAGE_SCHEMA_VERSION_KEY,
      ) as { value: string } | undefined;
      assert.equal(versionRow !== undefined ? Number(versionRow.value) : null, schema.CURRENT_SCHEMA_VERSION, 'version should migrate to current');

      // batches 表重建：无 until-x 列，有 payloadJson
      const batchCols = columnNames(db, 'batches');
      assert.ok(batchCols.includes('batchId'), 'batches.batchId should exist');
      assert.ok(batchCols.includes('payloadJson'), 'batches.payloadJson should exist');
      assert.ok(!batchCols.includes('sourceNodeId'), 'batches.sourceNodeId should be dropped');
      assert.ok(!batchCols.includes('targetSuccessCount'), 'batches.targetSuccessCount should be dropped');
      assert.ok(!batchCols.includes('cancelRequested'), 'batches.cancelRequested should be dropped');

      // 既有批次身份与时间戳保留，payloadJson 为空字符串占位（旧库无快照事实源）
      const row = db.prepare('SELECT batchId, payloadJson, createdAt, updatedAt FROM batches WHERE batchId = ?').get('batch-legacy-1') as {
        batchId: string;
        payloadJson: string;
        createdAt: number;
        updatedAt: number;
      };
      assert.equal(row.batchId, 'batch-legacy-1');
      assert.equal(row.payloadJson, '');
      assert.equal(row.createdAt, 1000);
      assert.equal(row.updatedAt, 2000);
    } finally {
      db.close();
    }
  });

  it('v12 空库重复打开幂等：版本号不变、不报错', () => {
    const schema = loadSchemaModule();
    const db = new Database(':memory:');
    try {
      schema.initSchema(db);
      schema.initSchema(db);

      const versionRow = db.prepare('SELECT value FROM meta WHERE key = ?').get(
        schema.STORAGE_SCHEMA_VERSION_KEY,
      ) as { value: string } | undefined;
      assert.equal(versionRow !== undefined ? Number(versionRow.value) : null, schema.CURRENT_SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it('v12 库打开时自动迁移到当前版本（timeline 媒体条目迁入 package_entries，三表退役）', () => {
    const schema = loadSchemaModule();
    const db = new Database(':memory:');
    try {
      // 构造一个 v12 库：timeline 三表 + 媒体/文本时间节点 + 跨时间点重复资产。
      db.exec(`
        CREATE TABLE meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        INSERT INTO meta (key, value) VALUES ('storage_schema_version', '12');
        CREATE TABLE timeline (
          timelineId TEXT PRIMARY KEY,
          graphId TEXT NOT NULL,
          createdAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL
        );
        CREATE TABLE timeline_points (
          timelinePointId TEXT PRIMARY KEY,
          timelineId TEXT NOT NULL REFERENCES timeline(timelineId) ON DELETE CASCADE,
          timeMs INTEGER NOT NULL,
          "order" INTEGER NOT NULL,
          title TEXT,
          createdAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL
        );
        CREATE TABLE timeline_items (
          timelineItemId TEXT PRIMARY KEY,
          timelinePointId TEXT NOT NULL REFERENCES timeline_points(timelinePointId) ON DELETE CASCADE,
          "order" INTEGER NOT NULL,
          kind TEXT NOT NULL,
          payloadJson TEXT NOT NULL,
          createdAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL
        );
        INSERT INTO timeline (timelineId, graphId, createdAt, updatedAt) VALUES ('tl_1', 'graph_1', 1, 2);
        INSERT INTO timeline (timelineId, graphId, createdAt, updatedAt) VALUES ('tl_2', 'graph_2', 1, 2);
        INSERT INTO timeline_points (timelinePointId, timelineId, timeMs, "order", title, createdAt, updatedAt)
          VALUES ('tlp_1', 'tl_1', 0, 0, NULL, 1, 2);
        INSERT INTO timeline_points (timelinePointId, timelineId, timeMs, "order", title, createdAt, updatedAt)
          VALUES ('tlp_2', 'tl_1', 5000, 1, '第二点', 1, 2);
        INSERT INTO timeline_points (timelinePointId, timelineId, timeMs, "order", title, createdAt, updatedAt)
          VALUES ('tlp_3', 'tl_2', 0, 0, NULL, 1, 2);
        INSERT INTO timeline_items (timelineItemId, timelinePointId, "order", kind, payloadJson, createdAt, updatedAt)
          VALUES ('tli_1', 'tlp_1', 0, 'text', '{"text":"纯文本不迁移"}', 1, 2);
        INSERT INTO timeline_items (timelineItemId, timelinePointId, "order", kind, payloadJson, createdAt, updatedAt)
          VALUES ('tli_2', 'tlp_1', 1, 'image', '{"assetId":"asset-a"}', 1, 2);
        INSERT INTO timeline_items (timelineItemId, timelinePointId, "order", kind, payloadJson, createdAt, updatedAt)
          VALUES ('tli_3', 'tlp_2', 0, 'video', '{"assetId":"asset-b"}', 1, 2);
        INSERT INTO timeline_items (timelineItemId, timelinePointId, "order", kind, payloadJson, createdAt, updatedAt)
          VALUES ('tli_4', 'tlp_2', 1, 'image', '{"assetId":"asset-a"}', 1, 2);
        INSERT INTO timeline_items (timelineItemId, timelinePointId, "order", kind, payloadJson, createdAt, updatedAt)
          VALUES ('tli_5', 'tlp_3', 0, 'audio', '{"assetId":"asset-c"}', 1, 2);
      `);

      schema.initSchema(db);

      const versionRow = db.prepare('SELECT value FROM meta WHERE key = ?').get(
        schema.STORAGE_SCHEMA_VERSION_KEY,
      ) as { value: string } | undefined;
      assert.equal(versionRow !== undefined ? Number(versionRow.value) : null, schema.CURRENT_SCHEMA_VERSION, 'version should migrate to current');

      // timeline 三表退役
      const tables = tableNames(db);
      assert.ok(!tables.includes('timeline'), 'timeline should be dropped');
      assert.ok(!tables.includes('timeline_points'), 'timeline_points should be dropped');
      assert.ok(!tables.includes('timeline_items'), 'timeline_items should be dropped');
      assert.ok(tables.includes('package_entries'), 'package_entries should exist');

      // 媒体条目按 canonical 顺序迁入；纯文本丢弃；同画布同资产去重
      const rows = db.prepare(
        'SELECT graphId, "order", assetId, mediaType FROM package_entries ORDER BY graphId, "order"',
      ).all() as Array<{ graphId: string; order: number; assetId: string; mediaType: string }>;
      assert.deepEqual(rows, [
        { graphId: 'graph_1', order: 0, assetId: 'asset-a', mediaType: 'image' },
        { graphId: 'graph_1', order: 1, assetId: 'asset-b', mediaType: 'video' },
        { graphId: 'graph_2', order: 0, assetId: 'asset-c', mediaType: 'audio' },
      ]);
    } finally {
      db.close();
    }
  });

  it('v13 库打开时自动迁移到 v14：edges 表随画布连线退役删除，残留行不做迁移', () => {
    const schema = loadSchemaModule();
    const db = new Database(':memory:');
    try {
      // 构造一个 v13 库：当前 DDL 结构 + 残留 edges 行。
      db.exec(`
        CREATE TABLE meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        INSERT INTO meta (key, value) VALUES ('storage_schema_version', '13');
        CREATE TABLE nodes (
          nodeId TEXT PRIMARY KEY,
          graphId TEXT NOT NULL,
          payloadJson TEXT NOT NULL,
          updatedAt INTEGER NOT NULL
        );
        CREATE TABLE edges (
          id TEXT PRIMARY KEY,
          payloadJson TEXT NOT NULL,
          updatedAt INTEGER NOT NULL
        );
        INSERT INTO edges (id, payloadJson, updatedAt) VALUES ('edge-legacy-1', '{}', 1000);
      `);

      schema.initSchema(db);

      const versionRow = db.prepare('SELECT value FROM meta WHERE key = ?').get(
        schema.STORAGE_SCHEMA_VERSION_KEY,
      ) as { value: string } | undefined;
      assert.equal(versionRow !== undefined ? Number(versionRow.value) : null, schema.CURRENT_SCHEMA_VERSION, 'version should migrate to current');

      // edges 表退役：无读写方，残留行直接丢弃
      const tables = tableNames(db);
      assert.ok(!tables.includes('edges'), 'edges should be dropped');
    } finally {
      db.close();
    }
  });

  it('v15 库打开时自动迁移到 v16：agent_tool_calls 扩列（toolName/toolKind，modelId 转可空），存量行保真', () => {
    const schema = loadSchemaModule();
    const db = new Database(':memory:');
    try {
      // 构造一个 v15 库：meta 写版本 15 + 旧形 agent_tool_calls（无 toolName/toolKind，modelId NOT NULL）。
      db.exec(`
        CREATE TABLE meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        INSERT INTO meta (key, value) VALUES ('storage_schema_version', '15');
        CREATE TABLE agent_sessions (
          agentSessionId TEXT PRIMARY KEY,
          nodeId TEXT NOT NULL UNIQUE,
          modelId TEXT NOT NULL,
          thinkingTier TEXT NOT NULL,
          approvalMode TEXT NOT NULL,
          title TEXT NOT NULL,
          messageCount INTEGER NOT NULL DEFAULT 0,
          createdAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL
        );
        INSERT INTO agent_sessions (agentSessionId, nodeId, modelId, thinkingTier, approvalMode, title, messageCount, createdAt, updatedAt)
          VALUES ('sess-legacy-1', 'node-legacy-1', 'llm-1', 'off', 'confirm', '旧会话', 0, 1000, 2000);
        CREATE TABLE agent_tool_calls (
          toolCallId TEXT PRIMARY KEY,
          agentSessionId TEXT NOT NULL REFERENCES agent_sessions(agentSessionId) ON DELETE CASCADE,
          seq INTEGER NOT NULL,
          modelId TEXT NOT NULL,
          status TEXT NOT NULL,
          batchId TEXT,
          taskIdsJson TEXT NOT NULL DEFAULT '[]',
          assetIdsJson TEXT NOT NULL DEFAULT '[]',
          errorSummary TEXT,
          createdAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL
        );
        INSERT INTO agent_tool_calls (toolCallId, agentSessionId, seq, modelId, status, batchId, taskIdsJson, assetIdsJson, errorSummary, createdAt, updatedAt)
          VALUES ('tool-legacy-1', 'sess-legacy-1', 1, 'gpt-image-2', 'succeeded', 'batch-1', '["task-1"]', '["asset-9"]', NULL, 1000, 2000);
      `);

      schema.initSchema(db);

      const versionRow = db.prepare('SELECT value FROM meta WHERE key = ?').get(
        schema.STORAGE_SCHEMA_VERSION_KEY,
      ) as { value: string } | undefined;
      assert.equal(versionRow !== undefined ? Number(versionRow.value) : null, schema.CURRENT_SCHEMA_VERSION, 'version should migrate to current');

      // 新列就位；modelId 转可空（加工类工具无目标模型）。
      const toolCallCols = columnNames(db, 'agent_tool_calls');
      assert.ok(toolCallCols.includes('toolName'), 'agent_tool_calls.toolName should exist');
      assert.ok(toolCallCols.includes('toolKind'), 'agent_tool_calls.toolKind should exist');
      const modelIdCol = db
        .prepare(`PRAGMA table_info('agent_tool_calls')`)
        .all()
        .find((col: { name: string }) => col.name === 'modelId') as { notnull: number };
      assert.equal(modelIdCol.notnull, 0, 'modelId should be nullable');

      // 存量行保真：既有调用按生成类收敛（toolName 空串 / toolKind generation），引用不丢。
      const migrated = db
        .prepare('SELECT toolCallId, toolName, toolKind, modelId, status, batchId, taskIdsJson, assetIdsJson FROM agent_tool_calls WHERE toolCallId = ?')
        .get('tool-legacy-1') as
        | { toolCallId: string; toolName: string; toolKind: string; modelId: string | null; status: string; batchId: string | null; taskIdsJson: string; assetIdsJson: string }
        | undefined;
      assert.ok(migrated !== undefined, 'legacy tool call row should survive migration');
      assert.equal(migrated.toolName, '');
      assert.equal(migrated.toolKind, 'generation');
      assert.equal(migrated.modelId, 'gpt-image-2');
      assert.equal(migrated.status, 'succeeded');
      assert.equal(migrated.batchId, 'batch-1');
      assert.equal(migrated.taskIdsJson, '["task-1"]');
      assert.equal(migrated.assetIdsJson, '["asset-9"]');
    } finally {
      db.close();
    }
  });

  it('v16 库打开时自动迁移到 v17：agent_sessions 补 lastMessageAt 并按消息回填（零消息会话保持 NULL）', () => {
    const schema = loadSchemaModule();
    const db = new Database(':memory:');
    try {
      // 构造一个 v16 库：agent_sessions 无 lastMessageAt 列，两个会话分别有 / 没有正式消息。
      db.exec(`
        CREATE TABLE meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        INSERT INTO meta (key, value) VALUES ('storage_schema_version', '16');
        CREATE TABLE agent_sessions (
          agentSessionId TEXT PRIMARY KEY,
          nodeId TEXT NOT NULL UNIQUE,
          modelId TEXT NOT NULL,
          thinkingTier TEXT NOT NULL,
          approvalMode TEXT NOT NULL,
          title TEXT NOT NULL,
          messageCount INTEGER NOT NULL DEFAULT 0,
          createdAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL
        );
        INSERT INTO agent_sessions (agentSessionId, nodeId, modelId, thinkingTier, approvalMode, title, messageCount, createdAt, updatedAt)
          VALUES ('sess-with-messages', 'node-1', 'llm-1', 'off', 'confirm', '有消息的会话', 2, 1000, 9000),
                 ('sess-empty', 'node-2', 'llm-1', 'off', 'confirm', '空会话', 0, 1000, 8000);
        CREATE TABLE agent_messages (
          agentSessionId TEXT NOT NULL REFERENCES agent_sessions(agentSessionId) ON DELETE CASCADE,
          seq INTEGER NOT NULL,
          role TEXT NOT NULL,
          requestId TEXT,
          bodyJson TEXT NOT NULL,
          planJson TEXT,
          createdAt INTEGER NOT NULL,
          isPartial INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (agentSessionId, seq)
        );
        INSERT INTO agent_messages (agentSessionId, seq, role, requestId, bodyJson, planJson, createdAt, isPartial)
          VALUES ('sess-with-messages', 1, 'user', 'req-1', '{"kind":"chat","content":"你好"}', NULL, 3000, 0),
                 ('sess-with-messages', 2, 'assistant', 'req-1', '{"kind":"chat","content":"在"}', NULL, 7000, 0);
      `);

      schema.initSchema(db);

      const versionRow = db.prepare('SELECT value FROM meta WHERE key = ?').get(
        schema.STORAGE_SCHEMA_VERSION_KEY,
      ) as { value: string } | undefined;
      assert.equal(
        versionRow !== undefined ? Number(versionRow.value) : null,
        schema.CURRENT_SCHEMA_VERSION,
        'version should migrate to current',
      );
      assert.ok(columnNames(db, 'agent_sessions').includes('lastMessageAt'), 'lastMessageAt should exist');

      // 回填 = 该会话最后一条正式消息时间（不是 createdAt / updatedAt）。
      const withMessages = db
        .prepare('SELECT lastMessageAt FROM agent_sessions WHERE agentSessionId = ?')
        .get('sess-with-messages') as { lastMessageAt: number | null } | undefined;
      assert.equal(withMessages?.lastMessageAt, 7000);
      // 零消息会话保持 NULL（null 即「还没有消息」，不用 0 或 updatedAt 兜底）。
      const empty = db
        .prepare('SELECT lastMessageAt FROM agent_sessions WHERE agentSessionId = ?')
        .get('sess-empty') as { lastMessageAt: number | null } | undefined;
      assert.equal(empty?.lastMessageAt, null);

      // 幂等：重复执行 initSchema 不改动既有值。
      schema.initSchema(db);
      const reRun = db
        .prepare('SELECT lastMessageAt FROM agent_sessions WHERE agentSessionId = ?')
        .get('sess-with-messages') as { lastMessageAt: number | null } | undefined;
      assert.equal(reRun?.lastMessageAt, 7000);
    } finally {
      db.close();
    }
  });
});
