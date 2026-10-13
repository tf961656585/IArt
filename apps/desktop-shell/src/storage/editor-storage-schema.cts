/**
 * Editor Storage Service — SQLite Schema
 *
 * 项目级 KV 表 + 业务表。
 * 新库按当前 DDL 建库；已存在的库走裁断后迁移链（当前受支持 v11 → v15）自动幂等升级，
 * 版本低于受支持迁移起点的旧库（< v11）才拒绝打开（一次性裁断，见 memory/decisions.md；
 * 该裁断不构成先例，未来 DDL 变更仍须按迁移兼容追加迁移步骤）。
 */

import { randomUUID } from 'node:crypto';

import type { SqliteDatabase } from './sqlite-loader.cjs';
import {
  AGENT_SESSION_DDL_STATEMENTS,
  DDL_STATEMENTS,
  EXPECTED_TABLES,
} from './editor-storage-schema.ddl.cjs';
import type {
  ExpectedColumn,
  IndexInfoRow,
  TableInfoRow,
  TableNameRow,
} from './editor-storage-schema.ddl.cjs';
import {
  normalizeName,
  quoteIdentifier,
  readTableInfo,
} from './editor-storage-schema-helpers.cjs';

type InitSchemaOptions = {
  projectPath: string | undefined;
};

const CURRENT_STORAGE_SCHEMA_ID = 'storage-schema-v17-agent-last-message';
const STORAGE_SCHEMA_META_KEY = 'storage_schema_id';

const CURRENT_SCHEMA_VERSION = 17;
const STORAGE_SCHEMA_VERSION_KEY = 'storage_schema_version';

class ProjectSqliteSchemaMismatchError extends Error {
  readonly code = 'PROJECT_SQLITE_SCHEMA_MISMATCH';
  readonly details: string[];
  readonly projectPath: string | undefined;

  constructor(details: string[], options: InitSchemaOptions = { projectPath: undefined }) {
    const location = options.projectPath ? `项目路径：${options.projectPath}` : '项目路径：未提供';
    super(
      [
        'PROJECT_SQLITE_SCHEMA_MISMATCH',
        location,
        `结构差异：${details.join('; ')}`,
        '处理建议：该项目数据库由旧版本应用创建，当前版本不再支持迁移打开；请使用创建该项目时的应用版本打开，或新建项目。',
      ].join('\n'),
    );
    this.name = 'ProjectSqliteSchemaMismatchError';
    this.details = details;
    if (options.projectPath !== undefined) {
      this.projectPath = options.projectPath;
    }
  }
}

const isProjectSqliteSchemaMismatchError = (
  error: unknown,
): error is ProjectSqliteSchemaMismatchError =>
  error instanceof ProjectSqliteSchemaMismatchError ||
  (typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'PROJECT_SQLITE_SCHEMA_MISMATCH');

const normalizeType = (type: unknown): string =>
  typeof type === 'string' ? type.trim().toUpperCase() : '';

const isPrimaryKey = (value: unknown): boolean =>
  typeof value === 'number' ? value > 0 : Number(value) > 0;

const readIndexInfo = (db: SqliteDatabase, tableName: string): IndexInfoRow[] =>
  db.prepare(`PRAGMA index_list(${quoteIdentifier(tableName)})`).all() as IndexInfoRow[];

const readUserTableNames = (db: SqliteDatabase): string[] =>
  (db.prepare('PRAGMA table_list').all() as TableNameRow[])
    .filter((row) => normalizeName(row.type) === 'table')
    .map((row) => normalizeName(row.name))
    .filter((name) => name.length > 0 && !name.startsWith('sqlite_'))
    .sort((left, right) => left.localeCompare(right));

const readUserIndexNames = (db: SqliteDatabase): string[] =>
  EXPECTED_TABLES.flatMap((table) => readIndexInfo(db, table.name))
    .map((index) => normalizeName(index.name))
    .filter((name) => name.length > 0 && !name.startsWith('sqlite_'))
    .sort((left, right) => left.localeCompare(right));

const hasAnyUserTable = (db: SqliteDatabase): boolean =>
  readUserTableNames(db).length > 0;

const describeMissingColumns = (
  tableName: string,
  expectedColumns: ExpectedColumn[],
  actualColumns: Map<string, TableInfoRow>,
): string | null => {
  const missing = expectedColumns
    .map((column) => column.name)
    .filter((columnName) => !actualColumns.has(columnName));
  return missing.length ? `${tableName} missing columns: ${missing.join(', ')}` : null;
};

const describeUnexpectedColumns = (
  tableName: string,
  expectedColumns: ExpectedColumn[],
  actualColumns: Map<string, TableInfoRow>,
): string | null => {
  const expectedColumnNames = new Set(expectedColumns.map((column) => column.name));
  const unexpected = Array.from(actualColumns.keys())
    .filter((columnName) => columnName && !expectedColumnNames.has(columnName));
  return unexpected.length ? `${tableName} unexpected columns: ${unexpected.join(', ')}` : null;
};

const describeColumnMismatches = (
  tableName: string,
  expectedColumns: ExpectedColumn[],
  actualColumns: Map<string, TableInfoRow>,
): string[] => {
  const mismatches: string[] = [];
  for (const expectedColumn of expectedColumns) {
    const actualColumn = actualColumns.get(expectedColumn.name);
    if (!actualColumn) continue;

    const actualType = normalizeType(actualColumn.type);
    if (actualType !== expectedColumn.type) {
      mismatches.push(
        `${tableName}.${expectedColumn.name} type ${actualType || '<empty>'} != ${expectedColumn.type}`,
      );
    }

    if (expectedColumn.primaryKey && !isPrimaryKey(actualColumn.pk)) {
      mismatches.push(`${tableName}.${expectedColumn.name} is not primary key`);
    }

    if (expectedColumn.notNull && !isPrimaryKey(actualColumn.pk) && !isPrimaryKey(actualColumn.notnull)) {
      mismatches.push(`${tableName}.${expectedColumn.name} is nullable`);
    }
  }
  return mismatches;
};

const describeMissingIndexes = (
  tableName: string,
  expectedIndexes: string[] | undefined,
  actualIndexes: IndexInfoRow[],
): string | null => {
  if (!(expectedIndexes !== null && expectedIndexes !== undefined ? expectedIndexes.length : undefined)) return null;
  const actualIndexNames = new Set(actualIndexes.map((index) => normalizeName(index.name)));
  const missing = (expectedIndexes as string[]).filter((indexName) => !actualIndexNames.has(indexName));
  return missing.length ? `${tableName} missing indexes: ${missing.join(', ')}` : null;
};

const collectSchemaMismatches = (db: SqliteDatabase): string[] => {
  const mismatches: string[] = [];
  const expectedTableNames = new Set(EXPECTED_TABLES.map((table) => table.name));
  const unexpectedTables = readUserTableNames(db)
    .filter((tableName) => !expectedTableNames.has(tableName));
  if (unexpectedTables.length > 0) {
    mismatches.push(`unexpected tables: ${unexpectedTables.join(', ')}`);
  }

  const expectedIndexNames = new Set(
    EXPECTED_TABLES.flatMap((table) => table.indexes ?? []),
  );
  const unexpectedIndexes = readUserIndexNames(db)
    .filter((indexName) => !expectedIndexNames.has(indexName));
  if (unexpectedIndexes.length > 0) {
    mismatches.push(`unexpected indexes: ${unexpectedIndexes.join(', ')}`);
  }

  for (const expectedTable of EXPECTED_TABLES) {
    const tableInfo = readTableInfo(db, expectedTable.name);
    if (tableInfo.length === 0) {
      mismatches.push(`missing table: ${expectedTable.name}`);
      continue;
    }

    const actualColumns = new Map(
      tableInfo.map((column) => [normalizeName(column.name), column]),
    );
    const missingColumns = describeMissingColumns(
      expectedTable.name,
      expectedTable.columns,
      actualColumns,
    );
    if (missingColumns) mismatches.push(missingColumns);
    const unexpectedColumns = describeUnexpectedColumns(
      expectedTable.name,
      expectedTable.columns,
      actualColumns,
    );
    if (unexpectedColumns) mismatches.push(unexpectedColumns);
    mismatches.push(
      ...describeColumnMismatches(expectedTable.name, expectedTable.columns, actualColumns),
    );

    const missingIndexes = describeMissingIndexes(
      expectedTable.name,
      expectedTable.indexes,
      readIndexInfo(db, expectedTable.name),
    );
    if (missingIndexes) mismatches.push(missingIndexes);
  }

  return mismatches;
};

const assertLatestSchema = (
  db: SqliteDatabase,
  options: InitSchemaOptions = { projectPath: undefined },
): void => {
  const mismatches = collectSchemaMismatches(db);
  if (mismatches.length > 0) {
    console.warn(
      `[editor-storage-schema] schema diagnostic: ${mismatches.join('; ')}` +
      (options.projectPath !== undefined ? ` (${options.projectPath})` : ''),
    );
  }
};

const writeSchemaMeta = (db: SqliteDatabase): void => {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
    STORAGE_SCHEMA_META_KEY,
    CURRENT_STORAGE_SCHEMA_ID,
  );
};

const readSchemaVersion = (db: SqliteDatabase): number => {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(
    STORAGE_SCHEMA_VERSION_KEY,
  ) as { value: string } | undefined;
  if (row === undefined) return 0;
  const parsed = Number(row.value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
};

const writeSchemaVersion = (db: SqliteDatabase, version: number): void => {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
    STORAGE_SCHEMA_VERSION_KEY,
    String(version),
  );
};

// ---------------------------------------------------------------------------
// 裁断后迁移链（AGENTS.md「数据库 Schema 规范」/ storage-schema.md schema_migration）
//
// 历史 v1–v11 迁移链已于 2026-07-29 一次性裁断移除：裁断前旧库（版本 < 11）一律拒绝打开。
// 本迁移链只承接裁断后的受支持版本（当前 v11 → v12 → … → v15），按顺序执行全部缺失迁移，幂等且
// 完成后写入最新版本号。未来 DDL 变更须在本链追加新步骤，不得绕过。
// ---------------------------------------------------------------------------

type MigrationStep = {
  fromVersion: number;
  toVersion: number;
  migrate: (db: SqliteDatabase) => void;
};

const readBatchesV11ColumnNames = (db: SqliteDatabase): Set<string> =>
  new Set(
    (readTableInfo(db, 'batches') as TableInfoRow[])
      .map((column) => normalizeName(column.name))
      .filter((name) => name.length > 0),
  );

/**
 * v11 → v12：batches 表由 until-x 形状（sourceNodeId / targetSuccessCount / cancelRequested）
 * 重建为 GenerationBatch 形状（batchId + payloadJson + createdAt/updatedAt）。
 *
 * 迁移语义（storage-schema.md runtime_domain.batches 审查规则）：
 * - 自动、幂等地保留既有批次身份（batchId）与安全的时间戳信息，不取消、不替换、不重启既有任务。
 * - 丢弃 targetSuccessCount / cancelRequested / sourceNodeId 的运行语义：成功目标、补位、追加与
 *   批次级取消请求元数据必须失去运行行为，迁移、读取与对账均不得据此创建任务。
 * - 旧行无法从 until-x 列重建 BatchIntentSnapshot（其含不可逆的模型/参数/任务成员快照，旧库无此
 *   事实源），故 payloadJson 置空字符串占位；Todo 4 的 GenerationBatch 受理链路写入真实快照。
 *   sourceNodeId 是旧模型节点概念，不迁移到新形状。
 */
const migrateV11ToV12 = (db: SqliteDatabase): void => {
  const v11Columns = readBatchesV11ColumnNames(db);
  const needsRebuild = v11Columns.has('sourceNodeId') || v11Columns.has('targetSuccessCount') || v11Columns.has('cancelRequested');
  const missingPayload = !v11Columns.has('payloadJson');

  // 已是 v12 形状（或空表），且无旧列残留 → 幂等跳过，不留痕。
  if (!needsRebuild && !missingPayload) {
    return;
  }

  const transaction = db.transaction(() => {
    const rows = db
      .prepare('SELECT batchId, createdAt, updatedAt FROM batches')
      .all() as { batchId: string; createdAt: number | null | undefined; updatedAt: number | null | undefined }[];

    db.exec('DROP TABLE batches');
    db.exec(`CREATE TABLE batches (
      batchId TEXT PRIMARY KEY,
      payloadJson TEXT NOT NULL,
      createdAt INTEGER,
      updatedAt INTEGER
    )`);

    const insert = db.prepare(
      'INSERT INTO batches (batchId, payloadJson, createdAt, updatedAt) VALUES (?, ?, ?, ?)',
    );
    for (const row of rows) {
      insert.run(
        row.batchId,
        '',
        row.createdAt ?? null,
        row.updatedAt ?? null,
      );
    }
  });
  transaction();
};

/**
 * v12 → v13：时间线三表（timeline / timeline_points / timeline_items）退役，
 * 替换为打包区单表 package_entries（spec「右侧工作区与打包区服务」）。
 *
 * 迁移语义（AGENTS.md「数据库 Schema 规范」：删除表必须评估用户数据保留或迁移）：
 * - 产品裁定（2026-09-04）：时间线整体改造为打包区，时间点/时间结构无新模型承载；
 *   媒体类时间节点（image/video/audio）按 canonical 顺序（时间点 timeMs ASC, order ASC →
 *   时间节点 order ASC）迁移为打包区条目，尽量保留用户归集成果。
 * - 纯文本时间节点与时间点结构（timeMs/title）无打包区对应语义，随表退役丢弃。
 * - 同一 graphId 内同一 assetId 去重保留首个（打包区条目按 assetId 唯一）。
 * - 幂等：package_entries 用 CREATE TABLE IF NOT EXISTS；timeline 表不存在时跳过迁移与删表。
 */
const migrateV12ToV13 = (db: SqliteDatabase): void => {
  db.exec(`CREATE TABLE IF NOT EXISTS package_entries (
    packageEntryId TEXT PRIMARY KEY,
    graphId TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    assetId TEXT NOT NULL,
    mediaType TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  )`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS package_entries_graphId_idx ON package_entries (graphId)`,
  );

  const tableNames = readUserTableNames(db);
  const hasTimelineTables =
    tableNames.includes('timeline') &&
    tableNames.includes('timeline_points') &&
    tableNames.includes('timeline_items');
  if (!hasTimelineTables) {
    return;
  }

  const transaction = db.transaction(() => {
    // media item 行按 canonical 顺序读出（points 按 timeMs/order，items 按 order）。
    const rows = db
      .prepare(
        `SELECT ti.payloadJson AS payloadJson, ti.kind AS kind, t.graphId AS graphId
           FROM timeline_items ti
           JOIN timeline_points tp ON tp.timelinePointId = ti.timelinePointId
           JOIN timeline t ON t.timelineId = tp.timelineId
          WHERE ti.kind IN ('image', 'video', 'audio')
          ORDER BY t.graphId ASC, tp.timeMs ASC, tp."order" ASC, ti."order" ASC`,
      )
      .all() as { payloadJson: string; kind: string; graphId: string }[];

    const now = Date.now();
    const insert = db.prepare(
      `INSERT INTO package_entries (packageEntryId, graphId, "order", assetId, mediaType, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    // 每个画布内 order 从 0 连续编号；同一画布同一 assetId 只保留首个条目。
    const nextOrderByGraph = new Map<string, number>();
    const seenAssetByGraph = new Set<string>();
    let migratedCount = 0;
    for (const row of rows) {
      let assetId: unknown;
      try {
        const payload = JSON.parse(row.payloadJson) as unknown;
        assetId =
          typeof payload === 'object' && payload !== null
            ? (payload as { assetId?: unknown }).assetId
            : undefined;
      } catch {
        assetId = undefined;
      }
      if (typeof assetId !== 'string' || assetId.length === 0) {
        console.debug('[editor-storage-schema] v12->v13: timeline media item missing assetId, skip', {
          kind: row.kind,
        });
        continue;
      }
      const dedupeKey = `${row.graphId}\u0000${assetId}`;
      if (seenAssetByGraph.has(dedupeKey)) continue;
      seenAssetByGraph.add(dedupeKey);
      const order = nextOrderByGraph.get(row.graphId) ?? 0;
      nextOrderByGraph.set(row.graphId, order + 1);
      insert.run(`pke_${randomUUID()}`, row.graphId, order, assetId, row.kind, now, now);
      migratedCount += 1;
    }
    if (migratedCount > 0) {
      console.info('[editor-storage-schema] v12->v13: migrated timeline media items to package entries', {
        migratedCount,
      });
    }

    db.exec('DROP TABLE timeline_items');
    db.exec('DROP TABLE timeline_points');
    db.exec('DROP TABLE timeline');
  });
  transaction();
};

/**
 * v13→v14：edges 表随画布连线退役删除（spec：docs/runtime/已退场对象与术语.md）。
 * 画布不再承载连线，该表无读写方；残留行直接丢弃，不做迁移。
 * 幂等：表不存在时跳过。
 */
const migrateV13ToV14 = (db: SqliteDatabase): void => {
  const tableNames = readUserTableNames(db);
  if (!tableNames.includes('edges')) return;
  db.exec('DROP TABLE edges');
};

/**
 * v14→v15：新增 agent 会话域四表（agent_sessions / agent_messages / agent_tool_calls /
 * agent_send_records）与按读通道查询形状建立的索引（spec：docs/agent/03-会话存储与IPC契约.md）。
 *
 * 纯新增结构，不改动任何既有表与既有行，无数据迁移。
 * 幂等：语句全部为 IF NOT EXISTS，与建库共用同一份 DDL（AGENT_SESSION_DDL_STATEMENTS），
 * 避免迁移建表与新建库建表的列定义漂移。
 */
const migrateV14ToV15 = (db: SqliteDatabase): void => {
  for (const ddl of AGENT_SESSION_DDL_STATEMENTS) {
    db.exec(ddl);
  }
};

/**
 * v15→v16：agent_tool_calls 扩形（spec 03 变更记录 2026-09-18，工具层落地）。
 *
 * - 新增 `toolName` / `toolKind` 列（默认 '' / 'generation'，兼容既有行——全部是生成类调用）；
 * - `modelId` 转可空（加工类工具无目标模型）。
 * SQLite 不能直接改列可空性，按标准重建表流程迁移；记录级数据逐行拷贝，不丢历史。
 * 幂等：表不存在时跳过（跟随建库 DDL 的库已是新形）。
 */
const migrateV15ToV16 = (db: SqliteDatabase): void => {
  const tableNames = readUserTableNames(db);
  if (!tableNames.includes('agent_tool_calls')) return;
  // v15 库存在两种形状：跟随旧 DDL 建的表（无 toolName/toolKind，modelId NOT NULL）与
  // v14→v15 迁移新 DDL 建出的新形表（本批起共用 DDL 已是新形）。按实际列形取数，两种都幂等。
  const existingColumns = new Set(readTableInfo(db, 'agent_tool_calls').map((row) => normalizeName(row.name)));
  const toolNameSource = existingColumns.has('toolName') ? 'toolName' : "''";
  const toolKindSource = existingColumns.has('toolKind') ? 'toolKind' : "'generation'";
  const rebuild = db.transaction(() => {
    db.exec(`CREATE TABLE agent_tool_calls_v16 (
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
    )`);
    db.exec(`INSERT INTO agent_tool_calls_v16 (
      toolCallId, agentSessionId, seq, toolName, toolKind, modelId, status,
      batchId, taskIdsJson, assetIdsJson, errorSummary, createdAt, updatedAt
    ) SELECT
      toolCallId, agentSessionId, seq, ${toolNameSource}, ${toolKindSource}, modelId, status,
      batchId, taskIdsJson, assetIdsJson, errorSummary, createdAt, updatedAt
    FROM agent_tool_calls`);
    db.exec('DROP TABLE agent_tool_calls');
    db.exec('ALTER TABLE agent_tool_calls_v16 RENAME TO agent_tool_calls');
    db.exec(`CREATE INDEX IF NOT EXISTS agent_tool_calls_agentSessionId_seq_idx
      ON agent_tool_calls (agentSessionId, seq)`);
  });
  rebuild();
};

/**
 * v16→v17：agent_sessions 新增 `lastMessageAt`（最后一条正式消息时间，epoch ms）。
 *
 * 用途（spec 02「节点身份与数据」/ spec 03「生命周期与 IPC」）：节点副行与「最近一次对话」
 * 口径一律取该列——`updatedAt` 会被配置变更（思考档位 / 审批规则）抬升，不能代表消息时间。
 *
 * - 加列：`ADD COLUMN`（可空、无默认值），已存在的库列形与新建库 DDL 一致；
 * - 回填：已有消息的会话取 `MAX(agent_messages.createdAt)`；零消息会话保持 NULL
 *   （NULL 即「还没有消息」，不用 0 或 updatedAt 兜底）；
 * - 幂等：列已存在时跳过加列；回填条件带 `lastMessageAt IS NULL AND EXISTS(...)`，
 *   重复执行不改动已有非空值、也不改写零消息会话。
 */
const migrateV16ToV17 = (db: SqliteDatabase): void => {
  const tableNames = readUserTableNames(db);
  if (!tableNames.includes('agent_sessions')) {
    // 条件跳过必须留痕：v15 之前的库没有会话域表，本迁移无事可做。
    console.debug('[editor-storage-schema] v16->v17: agent_sessions 不存在，跳过 lastMessageAt 迁移');
    return;
  }
  const existingColumns = new Set(
    readTableInfo(db, 'agent_sessions').map((row) => normalizeName(row.name)),
  );
  if (!existingColumns.has('lastMessageAt')) {
    db.exec('ALTER TABLE agent_sessions ADD COLUMN lastMessageAt INTEGER');
  }
  if (!tableNames.includes('agent_messages')) {
    // 没有消息表即没有消息可回填：全部会话保持 NULL。
    console.debug('[editor-storage-schema] v16->v17: agent_messages 不存在，无消息可回填');
    return;
  }
  const backfilled = db
    .prepare(
      `UPDATE agent_sessions
          SET lastMessageAt = (
            SELECT MAX(createdAt) FROM agent_messages
             WHERE agent_messages.agentSessionId = agent_sessions.agentSessionId
          )
        WHERE lastMessageAt IS NULL
          AND EXISTS (
            SELECT 1 FROM agent_messages
             WHERE agent_messages.agentSessionId = agent_sessions.agentSessionId
          )`,
    )
    .run() as { changes: number };
  if (backfilled.changes > 0) {
    console.info('[editor-storage-schema] v16->v17: backfilled agent_sessions.lastMessageAt', {
      backfilledCount: backfilled.changes,
    });
  }
};

const MIGRATION_STEPS: MigrationStep[] = [
  { fromVersion: 11, toVersion: 12, migrate: migrateV11ToV12 },
  { fromVersion: 12, toVersion: 13, migrate: migrateV12ToV13 },
  { fromVersion: 13, toVersion: 14, migrate: migrateV13ToV14 },
  { fromVersion: 14, toVersion: 15, migrate: migrateV14ToV15 },
  { fromVersion: 15, toVersion: 16, migrate: migrateV15ToV16 },
  { fromVersion: 16, toVersion: 17, migrate: migrateV16ToV17 },
];

const runPendingMigrations = (db: SqliteDatabase, fromVersion: number, options: InitSchemaOptions): void => {
  let currentVersion = fromVersion;
  for (const step of MIGRATION_STEPS) {
    if (currentVersion < step.fromVersion) {
      // 缺失的中间版本：只支持从已登记迁移的 fromVersion 起迁移，否则视为不受支持旧库。
      throw new ProjectSqliteSchemaMismatchError(
        [
          `storage_schema_version=${currentVersion} 低于受支持迁移起点 ${step.fromVersion}`,
          '该项目数据库由旧版本应用创建，当前版本不再支持迁移打开',
        ],
        options,
      );
    }
    if (currentVersion >= step.toVersion) continue;
    try {
      step.migrate(db);
    } catch (error) {
      const migrationError = error instanceof Error ? error.message : String(error);
      throw new ProjectSqliteSchemaMismatchError(
        [
          `storage_schema_version ${step.fromVersion} → ${step.toVersion} 迁移失败: ${migrationError}`,
          ...collectSchemaMismatches(db),
        ],
        options,
      );
    }
    currentVersion = step.toVersion;
  }
  writeSchemaVersion(db, currentVersion);
  writeSchemaMeta(db);
};

function initSchema(db: SqliteDatabase, options: InitSchemaOptions = { projectPath: undefined }): void {
  if (!hasAnyUserTable(db)) {
    try {
      for (const ddl of DDL_STATEMENTS) {
        db.exec(ddl);
      }
    } catch (error) {
      const ddlError = error instanceof Error ? error.message : String(error);
      throw new ProjectSqliteSchemaMismatchError(
        [...collectSchemaMismatches(db), `DDL failed: ${ddlError}`],
        options,
      );
    }
    writeSchemaVersion(db, CURRENT_SCHEMA_VERSION);
    writeSchemaMeta(db);
    return;
  }

  // 裁断后迁移链：对裁断后受支持版本按顺序执行全部缺失迁移，幂等且完成后写入最新版本号；
  // 裁断前旧库（版本 < 11）仍明确拒绝打开（保持现有 throw 行为与旧测试）。
  const currentVersion = readSchemaVersion(db);
  if (currentVersion < 11) {
    throw new ProjectSqliteSchemaMismatchError(
      [
        `storage_schema_version=${currentVersion} 与当前版本 ${CURRENT_SCHEMA_VERSION} 不一致`,
        '该项目数据库由旧版本应用创建，当前版本不再支持迁移打开',
      ],
      options,
    );
  }
  if (currentVersion > CURRENT_SCHEMA_VERSION) {
    // 防御性兜底：低版本应用不得打开高版本应用创建的库（无可用的回退迁移）。
    throw new ProjectSqliteSchemaMismatchError(
      [
        `storage_schema_version=${currentVersion} 高于当前版本 ${CURRENT_SCHEMA_VERSION}`,
        '该项目数据库由更高版本应用创建，请升级应用后再打开',
      ],
      options,
    );
  }
  if (currentVersion !== CURRENT_SCHEMA_VERSION) {
    runPendingMigrations(db, currentVersion, options);
    assertLatestSchema(db, options);
    return;
  }

  assertLatestSchema(db, options);
}

export {
  CURRENT_SCHEMA_VERSION,
  CURRENT_STORAGE_SCHEMA_ID,
  STORAGE_SCHEMA_META_KEY,
  STORAGE_SCHEMA_VERSION_KEY,
  ProjectSqliteSchemaMismatchError,
  assertLatestSchema,
  initSchema,
  isProjectSqliteSchemaMismatchError,
};
