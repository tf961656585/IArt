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
const writerEntry = `${workspaceRoot}/apps/desktop-shell/dist/storage/editor-storage-agent-writer.cjs`;
const readModelEntry = `${workspaceRoot}/apps/desktop-shell/dist/storage/editor-storage-read-model.cjs`;
const deltaEntry = `${workspaceRoot}/apps/desktop-shell/dist/storage/editor-storage-delta.cjs`;

type SqliteDb = InstanceType<typeof Database>;

type AgentSessionRecord = {
  agentSessionId: string;
  nodeId: string;
  modelId: string;
  thinkingTier: string;
  approvalMode: 'confirm' | 'yolo';
  title: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
  lastMessageAt: number | null;
};

type AgentMessageRecord = {
  agentSessionId: string;
  seq: number;
  role: 'user' | 'assistant' | 'system';
  requestId: string | null;
  body: unknown;
  plan: { steps: unknown[] } | null;
  createdAt: number;
  isPartial: boolean;
};

type AgentSendRecord = {
  recordId: string;
  agentSessionId: string;
  nodeId: string | null;
  requestId: string;
  createdAt: number;
  content: unknown;
  referenceAssetIds: string[];
  snapshot: {
    modelId: string;
    thinkingTier: string;
    approvalMode: 'confirm' | 'yolo';
    referenceAssetIds: string[];
    submittedAt: number;
  };
};

type SchemaModule = {
  CURRENT_SCHEMA_VERSION: number;
  CURRENT_STORAGE_SCHEMA_ID: string;
  STORAGE_SCHEMA_META_KEY: string;
  STORAGE_SCHEMA_VERSION_KEY: string;
  initSchema: (db: unknown, options?: { projectPath?: string }) => void;
};

type WriterModule = {
  upsertAgentSession: (db: unknown, session: AgentSessionRecord) => AgentSessionRecord;
  appendAgentMessage: (
    db: unknown,
    params: Omit<AgentMessageRecord, 'seq'>,
  ) => AgentMessageRecord;
  appendAgentSendRecord: (db: unknown, record: AgentSendRecord) => AgentSendRecord;
};

type ReadModelModule = {
  readAgentSessions: (db: unknown) => AgentSessionRecord[];
  readAgentSessionByNodeId: (db: unknown, nodeId: string) => AgentSessionRecord | null;
  readAgentMessages: (db: unknown, agentSessionId: string) => AgentMessageRecord[];
  readAgentSendRecords: (db: unknown, agentSessionId: string) => AgentSendRecord[];
};

type DeltaModule = {
  enqueueDelta: (db: unknown, delta: unknown) => void;
  flush: (db: unknown, projectPath: string | undefined) => Promise<void>;
};

const loadModules = () => ({
  schema: requireDesktop(schemaEntry) as SchemaModule,
  writer: requireDesktop(writerEntry) as WriterModule,
  readModel: requireDesktop(readModelEntry) as ReadModelModule,
  delta: requireDesktop(deltaEntry) as DeltaModule,
});

const createProjectDb = (schema: SchemaModule): SqliteDb => {
  const db = new Database(':memory:');
  // 与生产连接一致（editor-storage-service-impl.getDb）：外键开启，CASCADE 才会生效。
  db.pragma('foreign_keys = ON');
  schema.initSchema(db);
  return db;
};

const buildSession = (overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord => ({
  agentSessionId: 'as_1',
  nodeId: 'node-1',
  modelId: 'gpt-image-2',
  thinkingTier: 'off',
  approvalMode: 'confirm',
  title: '会话标题',
  messageCount: 0,
  createdAt: 1_000,
  updatedAt: 1_000,
  // 新会话没有消息：lastMessageAt 为 null（存储写入端在 appendAgentMessage 里推进）
  lastMessageAt: null,
  ...overrides,
});

const buildMessage = (
  overrides: Partial<Omit<AgentMessageRecord, 'seq'>> = {},
): Omit<AgentMessageRecord, 'seq'> => ({
  agentSessionId: 'as_1',
  role: 'user',
  requestId: 'req-1',
  body: { kind: 'chat', content: '你好' },
  plan: null,
  createdAt: 2_000,
  isPartial: false,
  ...overrides,
});

const buildSendRecord = (overrides: Partial<AgentSendRecord> = {}): AgentSendRecord => ({
  recordId: 'asr_1',
  agentSessionId: 'as_1',
  nodeId: 'node-1',
  requestId: 'req-1',
  createdAt: 2_000,
  content: '你好',
  referenceAssetIds: ['asset-1'],
  snapshot: {
    modelId: 'gpt-image-2',
    thinkingTier: 'off',
    approvalMode: 'confirm',
    referenceAssetIds: ['asset-1'],
    submittedAt: 2_000,
  },
  ...overrides,
});

const insertToolCallRow = (db: SqliteDb, params: { toolCallId: string; agentSessionId: string }): void => {
  db.prepare(
    `INSERT INTO agent_tool_calls (
      toolCallId, agentSessionId, seq, modelId, status, batchId,
      taskIdsJson, assetIdsJson, errorSummary, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    params.toolCallId,
    params.agentSessionId,
    1,
    'gpt-image-2',
    'succeeded',
    null,
    JSON.stringify(['task-1']),
    JSON.stringify(['asset-1']),
    null,
    2_000,
    2_000,
  );
};

const countRows = (db: SqliteDb, table: string, where: string, param: string): number =>
  (db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where} = ?`).get(param) as {
    count: number;
  }).count;

describe('editor storage agent sessions', () => {
  beforeAll(() => {
    if (
      !existsSync(schemaEntry) ||
      !existsSync(writerEntry) ||
      !existsSync(readModelEntry) ||
      !existsSync(deltaEntry)
    ) {
      execFileSync('pnpm', ['--filter', '@iart/desktop-shell', 'build'], {
        cwd: workspaceRoot,
        stdio: 'pipe',
      });
    }
  });

  it('upsert：新会话落库后按会话与按节点读回一致', () => {
    const { schema, writer, readModel } = loadModules();
    const db = createProjectDb(schema);
    try {
      const session = buildSession();
      const written = writer.upsertAgentSession(db, session);

      assert.deepEqual(written, session);
      assert.deepEqual(readModel.readAgentSessions(db), [session]);
      assert.deepEqual(readModel.readAgentSessionByNodeId(db, 'node-1'), session);
      assert.equal(readModel.readAgentSessionByNodeId(db, 'node-missing'), null);
    } finally {
      db.close();
    }
  });

  it('upsert：二次写入只改可变字段，不覆盖 messageCount / createdAt / nodeId', () => {
    const { schema, writer, readModel } = loadModules();
    const db = createProjectDb(schema);
    try {
      writer.upsertAgentSession(db, buildSession());
      writer.appendAgentMessage(db, buildMessage());
      writer.appendAgentMessage(
        db,
        buildMessage({ role: 'assistant', requestId: 'req-1', createdAt: 3_000 }),
      );
      assert.equal(readModel.readAgentSessionByNodeId(db, 'node-1')?.messageCount, 2);

      // 二次 upsert 夹带被篡改的投影/身份字段（调用方只读字段），必须被忽略。
      const rewritten = writer.upsertAgentSession(
        db,
        buildSession({
          nodeId: 'node-other',
          messageCount: 99,
          lastMessageAt: 9_999,
          createdAt: 7,
          modelId: 'model-next',
          thinkingTier: 'high',
          approvalMode: 'yolo',
          title: '改名后',
          updatedAt: 5_000,
        }),
      );

      assert.deepEqual(rewritten, {
        agentSessionId: 'as_1',
        nodeId: 'node-1',
        modelId: 'model-next',
        thinkingTier: 'high',
        approvalMode: 'yolo',
        title: '改名后',
        messageCount: 2,
        createdAt: 1_000,
        updatedAt: 5_000,
        // 消息表投影：配置 upsert 不覆盖（夹带的 0 被忽略）
        lastMessageAt: 3_000,
      });
      // 会话仍是 1 行，且未按被篡改的 nodeId 建出第二行。
      assert.equal(readModel.readAgentSessions(db).length, 1);
      assert.equal(readModel.readAgentSessionByNodeId(db, 'node-other'), null);
    } finally {
      db.close();
    }
  });

  it('upsert：同一节点已绑定另一会话时显式拒绝，不静默改绑', () => {
    const { schema, writer } = loadModules();
    const db = createProjectDb(schema);
    try {
      writer.upsertAgentSession(db, buildSession());
      assert.throws(
        () =>
          writer.upsertAgentSession(
            db,
            buildSession({ agentSessionId: 'as_2', nodeId: 'node-1' }),
          ),
        /AGENT_SESSION_NODE_TAKEN/,
      );
    } finally {
      db.close();
    }
  });

  it('appendAgentMessage：seq 在交替角色下单调分配，messageCount 与 updatedAt 同步', () => {
    const { schema, writer, readModel } = loadModules();
    const db = createProjectDb(schema);
    try {
      writer.upsertAgentSession(db, buildSession());

      const first = writer.appendAgentMessage(db, buildMessage({ createdAt: 2_000 }));
      const second = writer.appendAgentMessage(
        db,
        buildMessage({ role: 'assistant', createdAt: 3_000 }),
      );
      const third = writer.appendAgentMessage(db, buildMessage({ role: 'user', createdAt: 4_000 }));
      const fourth = writer.appendAgentMessage(
        db,
        buildMessage({ role: 'assistant', createdAt: 5_000 }),
      );

      assert.deepEqual([first.seq, second.seq, third.seq, fourth.seq], [1, 2, 3, 4]);
      assert.equal(first.role, 'user');
      assert.equal(second.role, 'assistant');
      assert.equal(first.agentSessionId, 'as_1');
      assert.equal(first.requestId, 'req-1');
      assert.equal(first.isPartial, false);

      const messages = readModel.readAgentMessages(db, 'as_1');
      assert.deepEqual(
        messages.map((message) => [message.seq, message.role]),
        [
          [1, 'user'],
          [2, 'assistant'],
          [3, 'user'],
          [4, 'assistant'],
        ],
      );

      const session = readModel.readAgentSessionByNodeId(db, 'node-1');
      assert.equal(session?.messageCount, 4);
      assert.equal(session?.updatedAt, 5_000);
      // lastMessageAt = 最后一条消息时间（不是会话创建时间，也不是配置更新时间）
      assert.equal(session?.lastMessageAt, 5_000);

      // 补写历史消息（时间戳更早）不回退会话 updatedAt 与 lastMessageAt，
      // messageCount 以实际行数重新投影。
      writer.appendAgentMessage(db, buildMessage({ createdAt: 1_500, requestId: null }));
      const after = readModel.readAgentSessionByNodeId(db, 'node-1');
      assert.equal(after?.messageCount, 5);
      assert.equal(after?.updatedAt, 5_000);
      assert.equal(after?.lastMessageAt, 5_000);
      assert.equal(readModel.readAgentMessages(db, 'as_1').length, 5);
    } finally {
      db.close();
    }
  });

  it('appendAgentMessage：plan 随助手消息持久化，非助手消息为 null；会话不存在时拒绝写入', () => {
    const { schema, writer, readModel } = loadModules();
    const db = createProjectDb(schema);
    try {
      writer.upsertAgentSession(db, buildSession());
      writer.appendAgentMessage(
        db,
        buildMessage({
          role: 'assistant',
          plan: {
            steps: [{ stepId: 'step-1', order: 0, title: '第一步', status: 'pending' }],
          },
        }),
      );

      const messages = readModel.readAgentMessages(db, 'as_1');
      assert.deepEqual(messages[0]?.plan, {
        steps: [{ stepId: 'step-1', order: 0, title: '第一步', status: 'pending' }],
      });

      assert.throws(
        () => writer.appendAgentMessage(db, buildMessage({ agentSessionId: 'as_missing' })),
        /AGENT_SESSION_NOT_FOUND/,
      );
    } finally {
      db.close();
    }
  });

  it('appendAgentSendRecord：追加后读回，重复 recordId 幂等保留首条留痕', () => {
    const { schema, writer, readModel } = loadModules();
    const db = createProjectDb(schema);
    try {
      writer.upsertAgentSession(db, buildSession());
      const record = buildSendRecord();
      const written = writer.appendAgentSendRecord(db, record);
      assert.deepEqual(written, record);
      assert.deepEqual(readModel.readAgentSendRecords(db, 'as_1'), [record]);

      // 同 recordId 重投（发送点击重试）：保留首条，不覆盖快照。
      const duplicate = writer.appendAgentSendRecord(
        db,
        buildSendRecord({ content: '重试内容', createdAt: 9_000 }),
      );
      assert.deepEqual(duplicate, record);
      assert.deepEqual(readModel.readAgentSendRecords(db, 'as_1'), [record]);

      // 留痕不参与正式消息计数（messageCount 只投影 agent_messages）。
      assert.equal(readModel.readAgentSessionByNodeId(db, 'node-1')?.messageCount, 0);
    } finally {
      db.close();
    }
  });

  it('appendAgentSendRecord：首条留痕在会话行尚不存在且 nodeId 为 null 时也能写入', () => {
    const { schema, writer, readModel } = loadModules();
    const db = createProjectDb(schema);
    try {
      // 受理之前：无 Agent 节点、无会话行，留痕仍必须先落库（保护用户意图）。
      const first = buildSendRecord({ recordId: 'asr_first', nodeId: null });
      const written = writer.appendAgentSendRecord(db, first);

      assert.deepEqual(written, first);
      assert.equal(written.nodeId, null);
      assert.deepEqual(readModel.readAgentSendRecords(db, 'as_1'), [first]);
      assert.equal(readModel.readAgentSessionByNodeId(db, 'node-1'), null);

      // 受理后：同一会话的后续留痕携带节点 id，两类留痕按 createdAt 升序共存。
      writer.upsertAgentSession(db, buildSession());
      const second = buildSendRecord({ recordId: 'asr_second', createdAt: 3_000, nodeId: 'node-1' });
      writer.appendAgentSendRecord(db, second);
      assert.deepEqual(
        readModel.readAgentSendRecords(db, 'as_1').map((record) => [record.recordId, record.nodeId]),
        [
          ['asr_first', null],
          ['asr_second', 'node-1'],
        ],
      );
    } finally {
      db.close();
    }
  });

  it('节点删除（真实 delta + flush 路径）：会话与其消息 / 工具调用 / 留痕一并消失', async () => {
    const { schema, writer, readModel, delta } = loadModules();
    const db = createProjectDb(schema);
    try {
      writer.upsertAgentSession(db, buildSession({ agentSessionId: 'as_1', nodeId: 'node-1' }));
      writer.upsertAgentSession(db, buildSession({ agentSessionId: 'as_2', nodeId: 'node-2' }));
      writer.appendAgentMessage(db, buildMessage({ agentSessionId: 'as_1' }));
      insertToolCallRow(db, { toolCallId: 'tc_1', agentSessionId: 'as_1' });
      // 受理后留痕（带 nodeId）+ 受理前留痕（nodeId 为 null，只能按 agentSessionId 归属清理）。
      writer.appendAgentSendRecord(db, buildSendRecord({ agentSessionId: 'as_1' }));
      writer.appendAgentSendRecord(
        db,
        buildSendRecord({ recordId: 'asr_pre', agentSessionId: 'as_1', nodeId: null }),
      );
      writer.appendAgentMessage(db, buildMessage({ agentSessionId: 'as_2' }));
      writer.appendAgentSendRecord(
        db,
        buildSendRecord({ recordId: 'asr_keep', agentSessionId: 'as_2', nodeId: 'node-2' }),
      );

      // 先让两个节点真实存在于 nodes 表。
      delta.enqueueDelta(db, {
        nodeGraphId: 'graph-1',
        nodes: {
          upsert: [
            { id: 'node-1', data: { nodeType: 'agent' } },
            { id: 'node-2', data: { nodeType: 'agent' } },
          ],
          remove: [],
        },
      });
      await delta.flush(db, undefined);

      // 走节点的唯一删除咽喉：保存 delta（remove）→ flush。
      delta.enqueueDelta(db, {
        nodeGraphId: 'graph-1',
        nodes: { upsert: [], remove: ['node-1'] },
      });
      await delta.flush(db, undefined);

      assert.equal((db.prepare('SELECT COUNT(*) AS count FROM nodes').get() as { count: number }).count, 1);
      assert.equal(readModel.readAgentSessionByNodeId(db, 'node-1'), null);
      assert.equal(readModel.readAgentMessages(db, 'as_1').length, 0);
      assert.equal(readModel.readAgentSendRecords(db, 'as_1').length, 0);
      assert.equal(countRows(db, 'agent_tool_calls', 'agentSessionId', 'as_1'), 0);
      assert.equal(countRows(db, 'agent_send_records', 'agentSessionId', 'as_1'), 0);

      // 未被删除节点的会话与留痕不受影响。
      assert.equal(readModel.readAgentSessionByNodeId(db, 'node-2')?.agentSessionId, 'as_2');
      assert.equal(readModel.readAgentMessages(db, 'as_2').length, 1);
      assert.deepEqual(
        readModel.readAgentSendRecords(db, 'as_2').map((record) => record.recordId),
        ['asr_keep'],
      );
    } finally {
      db.close();
    }
  });

  it('全量替换（fullReplace）：未再出现节点的会话与留痕被清理，仍在图中的保留', async () => {
    const { schema, writer, readModel, delta } = loadModules();
    const db = createProjectDb(schema);
    try {
      writer.upsertAgentSession(db, buildSession({ agentSessionId: 'as_keep', nodeId: 'node-keep' }));
      writer.upsertAgentSession(db, buildSession({ agentSessionId: 'as_gone', nodeId: 'node-gone' }));
      writer.appendAgentMessage(db, buildMessage({ agentSessionId: 'as_keep' }));
      writer.appendAgentMessage(db, buildMessage({ agentSessionId: 'as_gone' }));
      writer.appendAgentSendRecord(
        db,
        buildSendRecord({ recordId: 'asr_keep', agentSessionId: 'as_keep', nodeId: 'node-keep' }),
      );
      writer.appendAgentSendRecord(
        db,
        buildSendRecord({ recordId: 'asr_gone', agentSessionId: 'as_gone', nodeId: 'node-gone' }),
      );
      writer.appendAgentSendRecord(
        db,
        buildSendRecord({ recordId: 'asr_gone_pre', agentSessionId: 'as_gone', nodeId: null }),
      );

      delta.enqueueDelta(db, {
        nodeGraphId: 'graph-1',
        nodes: {
          upsert: [{ id: 'node-keep', data: {} }, { id: 'node-gone', data: {} }],
          remove: [],
        },
      });
      await delta.flush(db, undefined);

      delta.enqueueDelta(db, {
        nodeGraphId: 'graph-1',
        fullReplace: true,
        nodes: { upsert: [{ id: 'node-keep', data: {} }], remove: [] },
      });
      await delta.flush(db, undefined);

      assert.deepEqual(
        (db.prepare('SELECT id FROM nodes ORDER BY id').all() as Array<{ id: string }>).map(
          (row) => row.id,
        ),
        ['node-keep'],
      );
      assert.equal(readModel.readAgentSessionByNodeId(db, 'node-gone'), null);
      assert.equal(readModel.readAgentMessages(db, 'as_gone').length, 0);
      assert.equal(readModel.readAgentSendRecords(db, 'as_gone').length, 0);
      assert.equal(readModel.readAgentSessionByNodeId(db, 'node-keep')?.agentSessionId, 'as_keep');
      assert.equal(readModel.readAgentMessages(db, 'as_keep').length, 1);
      assert.deepEqual(
        readModel.readAgentSendRecords(db, 'as_keep').map((record) => record.recordId),
        ['asr_keep'],
      );
    } finally {
      db.close();
    }
  });

  it('v14→v15 迁移：建出 agent 四表与索引，重复执行幂等', () => {
    const { schema } = loadModules();
    const db = createProjectDb(schema);
    try {
      // 构造 v14 库：当前库去掉 agent 域结构并把版本号回退到 14。
      db.exec('DROP TABLE agent_messages');
      db.exec('DROP TABLE agent_tool_calls');
      db.exec('DROP TABLE agent_send_records');
      db.exec('DROP TABLE agent_sessions');
      db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(
        '14',
        schema.STORAGE_SCHEMA_VERSION_KEY,
      );
      // v14 库里的 agent 会话数据本就不存在（旧版本没有该域），迁移后应为空。
      schema.initSchema(db);

      const names = (
        db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index')").all() as Array<{
          name: string;
        }>
      ).map((row) => row.name);
      for (const expected of [
        'agent_sessions',
        'agent_messages',
        'agent_tool_calls',
        'agent_send_records',
        'agent_tool_calls_agentSessionId_seq_idx',
        'agent_send_records_agentSessionId_createdAt_idx',
        'agent_send_records_nodeId_idx',
      ]) {
        assert.ok(names.includes(expected), `${expected} should exist after v14->v15 migration`);
      }

      const versionRow = db
        .prepare('SELECT value FROM meta WHERE key = ?')
        .get(schema.STORAGE_SCHEMA_VERSION_KEY) as { value: string } | undefined;
      assert.equal(Number(versionRow?.value), schema.CURRENT_SCHEMA_VERSION);
      const idRow = db
        .prepare('SELECT value FROM meta WHERE key = ?')
        .get(schema.STORAGE_SCHEMA_META_KEY) as { value: string } | undefined;
      assert.equal(idRow?.value, schema.CURRENT_STORAGE_SCHEMA_ID);

      // 重复执行不报错、结构与版本号不变。
      schema.initSchema(db);
      schema.initSchema(db);
      const versionAfter = db
        .prepare('SELECT value FROM meta WHERE key = ?')
        .get(schema.STORAGE_SCHEMA_VERSION_KEY) as { value: string } | undefined;
      assert.equal(versionAfter?.value, versionRow?.value);
      assert.equal(
        (db.prepare('SELECT COUNT(*) AS count FROM agent_sessions').get() as { count: number }).count,
        0,
      );
    } finally {
      db.close();
    }
  });

  it('读取：JSON 列损坏时抛错暴露，而不是静默丢行', () => {
    const { schema, writer, readModel } = loadModules();
    const db = createProjectDb(schema);
    try {
      writer.upsertAgentSession(db, buildSession());
      writer.appendAgentMessage(db, buildMessage());
      db.prepare('UPDATE agent_messages SET bodyJson = ? WHERE agentSessionId = ?').run(
        '{not-json',
        'as_1',
      );

      assert.throws(
        () => readModel.readAgentMessages(db, 'as_1'),
        /AGENT_STORAGE_JSON_COLUMN_INVALID/,
      );
    } finally {
      db.close();
    }
  });
});
