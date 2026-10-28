import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { setBackendIpcTestHandler } from '../backend-ipc-sender.cts';
import { startTaskExecution } from '../task-executor.cts';
import {
  clearCacheForTest as clearActiveRouteCache,
  setActiveDeployment,
} from '../provider-connection/active-route-store.cts';
import {
  clearCacheForTest as clearConnectionCache,
  createConnection,
  setConnectionCredential,
} from '../provider-connection/connection-store.cts';
import {
  addCustomGenerationModel,
  clearCacheForTest as clearCustomGenerationModelCache,
} from '../provider-connection/custom-generation-model-store.cts';
import { setCredentialForConnection } from '../provider-connection/credential-store.cts';

// ============================================================================
// P0 回归：执行链已落库具体失败后，executor 的 catch 不得用提交时的旧记录覆盖。
//
// 主链（两端真实实现，只挡 IPC 传输层与远端 HTTP）：
//   真实 executeHttpTask（提交 + 轮询，假 HTTP 上游）
//   → 真实 executeTaskResultMaterialization（结果映射未命中 → 写入 result_mapping 失败后抛错）
//   → 真实 task-executor catch（重读当前记录）
//   → setBackendIpcTestHandler 接真实 better-sqlite3 + 真实 runtime writer / read model
//
// 旧行为：catch 用提交时的 submitting 记录再 patch 一次 task_execution_unexpected_error，
// 覆盖掉 result_output_mapping_missed 与已写入的远端任务号/执行快照。
// ============================================================================

const workspaceRoot = process.cwd();
const distStorageDir = path.join(workspaceRoot, 'apps/desktop-shell/dist/storage');
const schemaEntry = path.join(distStorageDir, 'editor-storage-schema.cjs');
const runtimeWriterEntry = path.join(distStorageDir, 'editor-storage-runtime-writer.cjs');
const readModelEntry = path.join(distStorageDir, 'editor-storage-read-model.cjs');

type SqliteDb = {
  pragma: (statement: string) => unknown;
  prepare: (statement: string) => { run: (...params: unknown[]) => unknown };
  close: () => void;
};

type SchemaModule = {
  initSchema: (db: unknown, options?: { projectPath?: string }) => void;
};

type RuntimeWriterModule = {
  executeRuntimeTransaction: (db: unknown, payload: unknown) => { success?: unknown; error?: unknown };
};

type RuntimeTaskViewShape = {
  taskId?: unknown;
  status?: unknown;
  remoteRequestId?: unknown;
  response?: unknown;
  metadata?: { executionSnapshot?: unknown } | null | undefined;
  failure?: { code?: unknown; stage?: unknown } | null | undefined;
  errorCode?: unknown;
};

type ReadModelModule = {
  readTaskById: (db: unknown, taskId: string) => RuntimeTaskViewShape | null;
};

const requireFromTest = createRequire(__filename);
const Database = requireFromTest('better-sqlite3') as new (filename: string) => SqliteDb;

const ensureDistStorage = () => {
  if (
    fs.existsSync(schemaEntry) &&
    fs.existsSync(runtimeWriterEntry) &&
    fs.existsSync(readModelEntry)
  ) {
    return;
  }
  execFileSync('pnpm', ['--filter', '@iart/desktop-shell', 'build'], {
    cwd: workspaceRoot,
    stdio: 'inherit',
  });
};

const loadDistModules = (): {
  schema: SchemaModule;
  runtimeWriter: RuntimeWriterModule;
  readModel: ReadModelModule;
} => {
  ensureDistStorage();
  return {
    schema: requireFromTest(schemaEntry) as SchemaModule,
    runtimeWriter: requireFromTest(runtimeWriterEntry) as RuntimeWriterModule,
    readModel: requireFromTest(readModelEntry) as ReadModelModule,
  };
};

const createProjectDb = (schema: SchemaModule): SqliteDb => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  schema.initSchema(db);
  return db;
};

const createProjectFolder = (rootDir: string) => {
  const projectPath = path.join(rootDir, 'failure-preservation.iartproj');
  fs.mkdirSync(path.join(projectPath, 'media'), { recursive: true });
  fs.writeFileSync(
    path.join(projectPath, 'manifest.json'),
    JSON.stringify({ version: 1, name: 'failure-preservation' }, null, 2),
    'utf-8',
  );
  return projectPath;
};

const restoreEnv = (name: string, previous: string | undefined) => {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
};

const seedActiveGenerationModel = async (modelId: string) => {
  const connection = createConnection({
    display_name: 'failure-preservation',
    base_url: 'https://snapshot.example.invalid/v1',
  });
  const credential = await setCredentialForConnection(
    connection.connection_id,
    'sk-failure-preservation',
  );
  assert.ok(credential, 'credential should be stored');
  if (!credential) throw new Error('credential setup failed');
  setConnectionCredential(
    connection.connection_id,
    credential.credentialRef,
    credential.version,
    true,
  );
  const record = addCustomGenerationModel({
    model_id: modelId,
    connection_id: connection.connection_id,
    family_adapter_id: 'openai-image-v1',
    remote_model_id: `remote-${modelId}`,
  });
  assert.equal(record.ok, true, 'generation model record should be created');
  if (!record.ok) throw new Error('model setup failed');
  assert.equal(
    setActiveDeployment(modelId, record.model.record_id),
    record.model.record_id,
    'active route should point at the seeded record',
  );
};

const buildTaskRecord = (modelId: string, projectPath: string) => ({
  id: 'task-p0-failure-preservation',
  taskId: 'task-p0-failure-preservation',
  projectPath,
  type: 'http',
  status: 'submitting',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  request: {
    url: 'https://snapshot.example.invalid/v1/images/generations',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { prompt: 'a cat on a skateboard' },
  },
  metadata: {
    modelId,
    model_id: modelId,
    taskId: 'task-p0-failure-preservation',
    projectPath,
    taskExecutionPlan: {
      polling_strategy: {
        request: {
          url_template: 'https://snapshot.example.invalid/v1/polling/{id}',
          method: 'GET',
        },
        polling: {
          intervalMs: 1,
          maxAttempts: 3,
          successFieldPaths: ['data.result.url'],
          successStatuses: ['succeeded'],
          statusFieldPaths: ['data.status'],
        },
      },
      result_rule: {
        mode: 'async',
        submit_response_id_path: '/data/task_id',
      },
      result_output_mapping: {
        response_mode: 'structured_payload',
        output_mapping_rules: [
          {
            target: 'output.video_url',
            source: { kind: 'response', path: 'data.missing_outputs' },
            required: false,
            default_value: null,
          },
        ],
      },
    },
  },
});

void test('P0: 物化已落库 result_mapping 失败后，executor catch 不得覆盖为通用错误', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-executor-p0-'));
  const projectPath = createProjectFolder(tempDir);
  const storageRoot = path.join(tempDir, 'storage');
  fs.mkdirSync(storageRoot, { recursive: true });
  const previousStorageRoot = process.env['IART_STORAGE_ROOT'];
  process.env['IART_STORAGE_ROOT'] = storageRoot;
  clearConnectionCache();
  clearActiveRouteCache();
  clearCustomGenerationModelCache();

  const { schema, runtimeWriter, readModel } = loadDistModules();
  const db = createProjectDb(schema);

  setBackendIpcTestHandler(async (message) => {
    if (message.type === 'runtime:execute-transaction') {
      const result = runtimeWriter.executeRuntimeTransaction(db, message);
      return {
        type: 'runtime:transaction-result',
        transactionId: message.transactionId,
        success: result.success === true,
        ...(result.error === undefined ? {} : { error: String(result.error) }),
      };
    }
    if (message.type === 'runtime:read-task-by-id') {
      return {
        type: 'runtime:transaction-result',
        transactionId: message.transactionId,
        success: true,
        data: readModel.readTaskById(db, message.taskId),
      };
    }
    if (message.type === 'runtime:write-task-event') {
      return {
        type: 'runtime:transaction-result',
        transactionId: message.transactionId,
        success: true,
      };
    }
    return {
      type: 'runtime:transaction-result',
      transactionId: message.transactionId,
      success: false,
      error: `unexpected message type: ${message.type}`,
    };
  });

  const originalFetch = globalThis.fetch;
  const fetchUrls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    fetchUrls.push(url);
    if (url.includes('/images/generations')) {
      return new Response(
        JSON.stringify({ code: 0, data: { task_id: 'remote-123', status: 'submitted' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.includes('/polling/remote-123')) {
      return new Response(
        JSON.stringify({
          data: {
            status: 'succeeded',
            result: { url: 'https://cdn.example.com/generated-video.mp4' },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
    setBackendIpcTestHandler(null);
    clearConnectionCache();
    clearActiveRouteCache();
    clearCustomGenerationModelCache();
    restoreEnv('IART_STORAGE_ROOT', previousStorageRoot);
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const modelId = 'model-p0-failure-preservation';
  await seedActiveGenerationModel(modelId);

  const settled = await startTaskExecution(buildTaskRecord(modelId, projectPath)).then(
    (record) => ({ ok: true as const, record }),
    (error: unknown) => ({ ok: false as const, error }),
  );

  // 断言 1：库里的最终失败必须是物化阶段写入的具体失败，而不是 catch 的通用错误。
  const persisted = readModel.readTaskById(db, 'task-p0-failure-preservation');
  assert.ok(persisted, '任务行应当已落库');
  assert.equal(persisted?.status, 'failed');
  assert.equal(
    persisted?.failure?.code,
    'result_output_mapping_missed',
    `最终失败 code 应保持物化阶段写入的具体失败，实际为: ${String(persisted?.failure?.code)}`,
  );
  assert.equal(
    persisted?.failure?.stage,
    'result_mapping',
    `失败阶段应随 failureJson 落库，实际为: ${String(persisted?.failure?.stage)}`,
  );
  assert.equal(
    persisted?.remoteRequestId,
    'remote-123',
    'catch 不得丢失已落库的远端任务号',
  );
  assert.equal(
    typeof persisted?.metadata?.executionSnapshot,
    'object',
    'catch 不得丢失已落库的执行快照',
  );

  // 断言 2：executor 返回的当前记录就是库里的失败记录（不 patch、不 rethrow 通用错误）。
  assert.equal(settled.ok, true, '已落库具体失败时 executor 应返回当前记录而不是抛错');
  if (settled.ok) {
    const returned = settled.record as RuntimeTaskViewShape;
    assert.equal(returned.status, 'failed');
    assert.equal(returned.failure?.code, 'result_output_mapping_missed');
    assert.equal(returned.remoteRequestId, 'remote-123');
  }

  // 断言 3：确实走到了提交 + 轮询两段真实 HTTP（证明场景不是被前置阻断短路出来的）。
  assert.ok(
    fetchUrls.some((url) => url.includes('/images/generations')),
    '应真实发起提交请求',
  );
  assert.ok(
    fetchUrls.some((url) => url.includes('/polling/remote-123')),
    '应真实发起轮询请求',
  );
});
