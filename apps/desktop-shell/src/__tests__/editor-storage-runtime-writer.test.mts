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
const runtimeWriterEntry = `${workspaceRoot}/apps/desktop-shell/dist/storage/editor-storage-runtime-writer.cjs`;
const readModelEntry = `${workspaceRoot}/apps/desktop-shell/dist/storage/editor-storage-read-model.cjs`;

type StorageSchemaModule = {
  CURRENT_STORAGE_SCHEMA_ID: string;
  STORAGE_SCHEMA_META_KEY: string;
  initSchema: (db: unknown, options?: { projectPath?: string }) => void;
};

type RuntimeWriterModule = {
  executeRuntimeTransaction: (
    db: unknown,
    transaction: Record<string, unknown>,
  ) => { success: boolean; error?: string };
};

type ReadModelModule = {
  buildProjectRecord: (projectPath: string, db: unknown) => unknown;
  readTaskById: (
    db: unknown,
    taskId: string,
  ) => {
    progressPhase?: string;
    failure?: { code?: string; details?: unknown };
  } | null;
};

const loadStorageModules = () => ({
  schema: requireDesktop(schemaEntry) as StorageSchemaModule,
  runtimeWriter: requireDesktop(runtimeWriterEntry) as RuntimeWriterModule,
  readModel: requireDesktop(readModelEntry) as ReadModelModule,
});

describe('editor storage runtime writer', () => {
  beforeAll(() => {
    if (!existsSync(schemaEntry) || !existsSync(runtimeWriterEntry) || !existsSync(readModelEntry)) {
      execFileSync('pnpm', ['--filter', '@iart/desktop-shell', 'build'], {
        cwd: workspaceRoot,
        stdio: 'pipe',
      });
    }
  });

  it('storage schema: 新空库初始化后写入当前 schema 标识并包含运行域最新列', () => {
    const { schema } = loadStorageModules();
    const db = new Database(':memory:');
    try {
      schema.initSchema(db);

      const schemaMeta = db
        .prepare('SELECT value FROM meta WHERE key = ?')
        .get(schema.STORAGE_SCHEMA_META_KEY) as { value: string } | undefined;
      assert.equal(schemaMeta?.value, schema.CURRENT_STORAGE_SCHEMA_ID);

      const taskColumns = new Set(
        (
          db.prepare('PRAGMA table_info(tasks)').all() as Array<{
            name: string;
          }>
        ).map((column) => column.name),
      );
      assert.equal(taskColumns.has('failureJson'), true);
      assert.equal(taskColumns.has('progressPhase'), true);
      // 新建空库的 tasks 表不得包含历史完整请求体列。
      assert.equal(taskColumns.has('requestBodyJson'), false);
    } finally {
      db.close();
    }
  });

  it('storage schema: 旧版本库（缺 failureJson 的无版本号旧库）打开时明确报错拒绝，不再自动迁移', () => {
    const { schema } = loadStorageModules();
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE tasks (
          taskId TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          projectPath TEXT NOT NULL,
          createdAt INTEGER,
          updatedAt INTEGER
        );
      `);

      assert.throws(
        () => schema.initSchema(db, { projectPath: '/tmp/old-project.iartproj' }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /PROJECT_SQLITE_SCHEMA_MISMATCH/);
          assert.match(error.message, /不再支持迁移打开/);
          return true;
        },
      );

      // 不迁移：旧表结构保持原样，不补列、不写版本号。
      const tasksColumns = db.prepare("PRAGMA table_info('tasks')").all() as Array<{ name: string }>;
      const columnNames = tasksColumns.map((col) => col.name);
      assert.ok(!columnNames.includes('failureJson'), 'legacy db must not gain failureJson column');
    } finally {
      db.close();
    }
  });

  it('runtime writer: 同一事务先写 media_assets 再写 task_outputs，避免外键失败', () => {
    const { schema, runtimeWriter, readModel } = loadStorageModules();
    const db = new Database(':memory:');
    try {
      db.pragma('foreign_keys = ON');
      schema.initSchema(db);

      const result = runtimeWriter.executeRuntimeTransaction(db, {
        type: 'runtime:execute-transaction',
        projectPath: '/tmp/iart-runtime-writer-test',
        transactionId: 'tx-runtime-writer-fk-order',
        tasks: [
          {
            taskId: 'task-1',
            status: 'succeeded',
            projectPath: '/tmp/iart-runtime-writer-test',
            sourceNodeId: 'source-1',
            targetNodeId: 'target-1',
            batchId: 'batch-1',
            progressPhase: 'localizing',
            createdAt: 1,
            updatedAt: 2,
          },
        ],
        mediaAssets: [
          {
            assetId: 'asset-1',
            mediaType: 'image',
            payloadJson: '{"url":"/files/out.png"}',
            createdAt: 1,
            updatedAt: 2,
          },
        ],
        taskOutputs: [
          {
            outputId: 'output-1',
            taskId: 'task-1',
            assetId: 'asset-1',
            mediaType: 'image',
            sortOrder: 0,
          },
        ],
        batches: [
          {
            batchId: 'batch-1',
            payloadJson: JSON.stringify({ batch_id: 'batch-1', task_count: 1, task_ids: ['task-1'] }),
            createdAt: 1,
            updatedAt: 2,
          },
        ],
      });

      assert.equal(result.success, true, result.error);
      const task = readModel.readTaskById(db, 'task-1');
      assert.equal(task?.progressPhase, 'localizing');
      assert.equal(
        (db.prepare('SELECT COUNT(*) AS count FROM task_outputs').get() as { count: number }).count,
        1,
      );
    } finally {
      db.close();
    }
  });

  it('runtime writer: failureJson 作为整体 JSON 写入并由 read model 水合为 failure', () => {
    const { schema, runtimeWriter, readModel } = loadStorageModules();
    const db = new Database(':memory:');
    try {
      schema.initSchema(db);
      const failure = {
        code: 'PUBLIC_ERROR_SEXUAL',
        message: '内容安全策略拦截',
        userMessage: '内容安全策略拦截',
        backendMessage: 'check status failed: {...}',
        retryable: false,
        details: { failureReasons: ['NCII'] },
      };
      const result = runtimeWriter.executeRuntimeTransaction(db, {
        type: 'runtime:execute-transaction',
        projectPath: '/tmp/iart-runtime-writer-test',
        transactionId: 'tx-runtime-writer-failure',
        tasks: [
          {
            taskId: 'task-failed-1',
            status: 'failed',
            projectPath: '/tmp/iart-runtime-writer-test',
            failureJson: JSON.stringify(failure),
            createdAt: 1,
            updatedAt: 2,
          },
        ],
      });

      assert.equal(result.success, true, result.error);
      const row = db.prepare('SELECT failureJson FROM tasks WHERE taskId = ?').get('task-failed-1') as { failureJson: string };
      assert.equal(row.failureJson, JSON.stringify(failure));
      const task = readModel.readTaskById(db, 'task-failed-1');
      assert.equal(task?.failure?.code, 'PUBLIC_ERROR_SEXUAL');
      assert.deepEqual(task?.failure?.details, { failureReasons: ['NCII'] });
    } finally {
      db.close();
    }
  });

  it('read model: nodeGraph.id 以 manifest.nodeGraphId 为唯一事实源', () => {
    const { schema, readModel } = loadStorageModules();
    const db = new Database(':memory:');
    try {
      schema.initSchema(db);
      db.prepare(
        `INSERT INTO project_manifest (id, version, name, nodeGraphId, createdAt, savedAt)
         VALUES (1, 1, 'demo', 'graph_1', 1, 2)`,
      ).run();
      db.prepare(
        'INSERT INTO graph (id, payloadJson, updatedAt) VALUES (?, ?, ?)',
      ).run('graph_1', JSON.stringify({ id: 'ng_legacy', zoom: 2 }), 3);
      db.prepare(
        'INSERT INTO graph (id, payloadJson, updatedAt) VALUES (?, ?, ?)',
      ).run('ng_legacy', JSON.stringify({ id: 'ng_legacy', zoom: 9 }), 4);

      const project = readModel.buildProjectRecord('/tmp/project', db) as {
        nodeGraph?: { id?: string; zoom?: number };
      } | null;
      assert.equal(project?.nodeGraph?.id, 'graph_1');
      assert.equal(project?.nodeGraph?.zoom, 2);
    } finally {
      db.close();
    }
  });

  it('read model: manifest 指向的 graph 缺失时阻断 project record 构建', () => {
    const { schema, readModel } = loadStorageModules();
    const db = new Database(':memory:');
    try {
      schema.initSchema(db);
      db.prepare(
        `INSERT INTO project_manifest (id, version, name, nodeGraphId, createdAt, savedAt)
         VALUES (1, 1, 'demo', 'graph_missing', 1, 2)`,
      ).run();

      assert.equal(readModel.buildProjectRecord('/tmp/project', db), null);
    } finally {
      db.close();
    }
  });
});
