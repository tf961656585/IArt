import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { setBackendIpcTestHandler } from '../backend-ipc-sender.cts';
import { createRequestHandler } from '../router.cts';
import { buildRuntimeTaskRow } from '../task-payload-builder.cts';

// ============================================================================
// 任务列表读取接缝测试（docs/hub/任务监控.md §数据源）。
//
// 主链：真实 better-sqlite3 项目库（initSchema 建表 + executeRuntimeTransaction 真实写入行）
//   → 真实 readAllTasks 水合为 RuntimeTaskView（Main 侧真实形状）
//   → setBackendIpcTestHandler 只挡 IPC 传输层
//   → 真实 backend 路由 handleTaskList（createRequestHandler + 真实 HTTP）。
// 两侧真实实现，只挡 IPC 传输层；test handler 内不手写假数据。
//
// dist 缺失时自动构建 desktop-shell（本测试消费其 storage 编译产物）。
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
  executeRuntimeTransaction: (db: unknown, payload: unknown) => unknown;
};

type ReadModelModule = {
  readAllTasks: (
    db: unknown,
    options: { status?: string | undefined; limit?: number | undefined; offset?: number | undefined } | undefined,
  ) => unknown[];
  readTaskById: (db: unknown, taskId: string) => unknown;
};

// backend 测试按 commonjs 编译（apps/backend type: commonjs），用 __filename 建 require。
const requireFromTest = createRequire(__filename);
type BetterSqlite3 = new (filename: string) => SqliteDb;
const Database = requireFromTest('better-sqlite3') as BetterSqlite3;

const loadDistModules = () => ({
  schema: requireFromTest(schemaEntry) as SchemaModule,
  runtimeWriter: requireFromTest(runtimeWriterEntry) as RuntimeWriterModule,
  readModel: requireFromTest(readModelEntry) as ReadModelModule,
});

const createProjectDb = (schema: SchemaModule): SqliteDb => {
  const db = new Database(':memory:');
  // 与生产连接一致（editor-storage-service-impl.getDb）：外键开启。
  db.pragma('foreign_keys = ON');
  schema.initSchema(db);
  return db;
};

/** 写侧真实形状：经 buildRuntimeTaskRow（backend 真实任务行构建器）产出 RuntimeTaskRow。 */
const buildSeedTaskRow = (params: {
  taskId: string;
  projectPath: string;
  status: string;
  withModelAndProgress: boolean;
}) =>
  buildRuntimeTaskRow(
    {
      taskId: params.taskId,
      status: params.status,
      projectPath: params.projectPath,
      createdAt: 1_000,
      updatedAt: 2_000,
      ...(params.withModelAndProgress
        ? {
            metadata: {
              modelId: 'gpt-image-2',
              model_id: 'gpt-image-2',
              projectPath: params.projectPath,
            },
            request: {
              method: 'POST',
              url: 'https://example.invalid/v1/images',
              headers: { 'content-type': 'application/json' },
              body: { prompt: 'a cat on a skateboard' },
            },
            progress: { percent: 42, message: '生成中', phase: 'generating' },
          }
        : { metadata: {} }),
    },
    {
      fallbackStatus: 'submitting',
      statusNormalizer: (status: unknown) => status,
      projectPathResolver: () => undefined,
    },
  );

const seedTaskRows = (
  db: SqliteDb,
  runtimeWriter: RuntimeWriterModule,
  projectPath: string,
): void => {
  const result = runtimeWriter.executeRuntimeTransaction(db, {
    projectPath,
    transactionId: 'txn_task_list_seam_seed',
    tasks: [
      buildSeedTaskRow({ taskId: 'task-seam-full', projectPath, status: 'generating', withModelAndProgress: true }),
      buildSeedTaskRow({ taskId: 'task-seam-minimal', projectPath, status: 'succeeded', withModelAndProgress: false }),
    ],
  }) as { success?: unknown; error?: unknown };
  assert.equal(
    result.success,
    true,
    `seam: 种子任务行经真实 executeRuntimeTransaction 写入失败: ${String(result.error)}`,
  );
};

const startServer = async (): Promise<{ server: http.Server; baseUrl: string }> => {
  const server = http.createServer(createRequestHandler());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('router_task_list_seam_server_address_unavailable');
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
};

const installReadTasksHandler = (
  readModel: ReadModelModule,
  db: SqliteDb,
  overrides: { forceFailure?: boolean } = {},
): void => {
  setBackendIpcTestHandler(async (message) => {
    if (message.type !== 'runtime:read-tasks') {
      return {
        type: 'runtime:transaction-result',
        transactionId: message.transactionId,
        success: false,
        error: `unexpected message type: ${message.type}`,
      };
    }
    if (overrides.forceFailure) {
      return {
        type: 'runtime:transaction-result',
        transactionId: message.transactionId,
        success: false,
        error: 'project db unavailable',
      };
    }
    const views = readModel.readAllTasks(db, {
      status: message.status,
      limit: message.limit,
      offset: message.offset,
    });
    return {
      type: 'runtime:transaction-result',
      transactionId: message.transactionId,
      success: true,
      data: views,
    };
  });
};

type TaskListPayload = {
  total?: unknown;
  tasks?: Array<Record<string, unknown>>;
};

void test('seam: /api/tasks 用真实项目库任务行返回非空列表并投影 modelId/progress', async (t) => {
  if (!fs.existsSync(schemaEntry) || !fs.existsSync(runtimeWriterEntry) || !fs.existsSync(readModelEntry)) {
    execFileSync('pnpm', ['--filter', '@iart/desktop-shell', 'build'], {
      cwd: workspaceRoot,
      stdio: 'pipe',
    });
  }
  const { schema, runtimeWriter, readModel } = loadDistModules();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-task-list-seam-'));
  const projectPath = path.join(tempDir, 'demo.iartproj');
  fs.mkdirSync(projectPath, { recursive: true });
  const db = createProjectDb(schema);
  seedTaskRows(db, runtimeWriter, projectPath);
  installReadTasksHandler(readModel, db);

  const { server, baseUrl } = await startServer();
  t.after(async () => {
    setBackendIpcTestHandler(null);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const response = await fetch(`${baseUrl}/api/tasks?projectPath=${encodeURIComponent(projectPath)}`);
  assert.equal(response.status, 200);
  const payload = (await response.json()) as TaskListPayload;
  const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
  assert.ok(
    tasks.length >= 1,
    `seam: 真实项目库有 ${tasks.length} 条任务行时 /api/tasks 应返回非空列表（回归前每行被 RuntimeTaskRowSchema 丢弃）`,
  );
  assert.equal(payload.total, 2);

  const full = tasks.find((task) => task.taskId === 'task-seam-full');
  assert.ok(full, 'seam: 含 modelId/progress 的任务行应出现在列表中');
  assert.equal(full.modelId, 'gpt-image-2');
  assert.equal(full.progress, 42);
  assert.equal(full.status, 'generating');
  assert.equal(full.sourceNodeId, null);
  assert.equal(full.errorMessage, null);

  const minimal = tasks.find((task) => task.taskId === 'task-seam-minimal');
  assert.ok(minimal, 'seam: 无 modelId/progress 的任务行也应出现且留空');
  assert.equal(minimal.modelId, null);
  assert.equal(minimal.progress, null);
  assert.equal(minimal.status, 'succeeded');
});

void test('seam: Main 侧读取失败时 /api/tasks 返回 HTTP 错误而非 200 空列表', async (t) => {
  const { schema, readModel } = loadDistModules();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-task-list-seam-fail-'));
  const projectPath = path.join(tempDir, 'demo.iartproj');
  fs.mkdirSync(projectPath, { recursive: true });
  const db = createProjectDb(schema);
  installReadTasksHandler(readModel, db, { forceFailure: true });

  const { server, baseUrl } = await startServer();
  t.after(async () => {
    setBackendIpcTestHandler(null);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const response = await fetch(`${baseUrl}/api/tasks?projectPath=${encodeURIComponent(projectPath)}`);
  assert.notEqual(
    response.status,
    200,
    'seam: Main 回包 success:false 不得伪装成 200 空列表',
  );
  const payload = (await response.json()) as { code?: unknown; message?: unknown };
  assert.ok(typeof payload.code === 'string' && payload.code, 'seam: 错误响应应携带 code');
  assert.ok(typeof payload.message === 'string' && payload.message, 'seam: 错误响应应携带 message');
});

void test('seam: /api/tasks 的 status 过滤参数在真实读取链路上生效', async (t) => {
  const { schema, runtimeWriter, readModel } = loadDistModules();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-task-list-seam-filter-'));
  const projectPath = path.join(tempDir, 'demo.iartproj');
  fs.mkdirSync(projectPath, { recursive: true });
  const db = createProjectDb(schema);
  seedTaskRows(db, runtimeWriter, projectPath);
  installReadTasksHandler(readModel, db);

  const { server, baseUrl } = await startServer();
  t.after(async () => {
    setBackendIpcTestHandler(null);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const generatingResponse = await fetch(
    `${baseUrl}/api/tasks?projectPath=${encodeURIComponent(projectPath)}&status=generating`,
  );
  assert.equal(generatingResponse.status, 200);
  const generatingPayload = (await generatingResponse.json()) as TaskListPayload;
  const generatingTasks = Array.isArray(generatingPayload.tasks) ? generatingPayload.tasks : [];
  assert.equal(
    generatingTasks.length,
    1,
    'seam: status=generating 过滤应只命中 1 条 generating 任务',
  );
  assert.equal(generatingTasks[0]?.taskId, 'task-seam-full');

  const succeededResponse = await fetch(
    `${baseUrl}/api/tasks?projectPath=${encodeURIComponent(projectPath)}&status=succeeded`,
  );
  assert.equal(succeededResponse.status, 200);
  const succeededPayload = (await succeededResponse.json()) as TaskListPayload;
  const succeededTasks = Array.isArray(succeededPayload.tasks) ? succeededPayload.tasks : [];
  assert.equal(succeededTasks.length, 1, 'seam: status=succeeded 过滤应只命中 1 条 succeeded 任务');
  assert.equal(succeededTasks[0]?.taskId, 'task-seam-minimal');

  const invalidResponse = await fetch(
    `${baseUrl}/api/tasks?projectPath=${encodeURIComponent(projectPath)}&status=not-a-status`,
  );
  assert.equal(invalidResponse.status, 400, 'seam: 非法 status 参数应返回 400');
});

void test('seam: /api/tasks/:id 对历史失败行归一 progressPhase=null', async (t) => {
  const { schema, runtimeWriter, readModel } = loadDistModules();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-task-get-phase-'));
  const projectPath = path.join(tempDir, 'demo.iartproj');
  fs.mkdirSync(projectPath, { recursive: true });
  const db = createProjectDb(schema);
  seedTaskRows(db, runtimeWriter, projectPath);
  // 模拟写侧归一上线前落库的历史行：failed 仍残留 requesting。
  db.prepare("UPDATE tasks SET status = 'failed', progressPhase = 'requesting' WHERE taskId = ?").run(
    'task-seam-full',
  );

  setBackendIpcTestHandler(async (message) => {
    if (message.type !== 'runtime:read-task-by-id') {
      return {
        type: 'runtime:transaction-result',
        transactionId: message.transactionId,
        success: false,
        error: `unexpected message type: ${message.type}`,
      };
    }
    return {
      type: 'runtime:transaction-result',
      transactionId: message.transactionId,
      success: true,
      data: readModel.readTaskById(db, message.taskId),
    };
  });

  const { server, baseUrl } = await startServer();
  t.after(async () => {
    setBackendIpcTestHandler(null);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const views = readModel.readAllTasks(db, {
    status: undefined,
    limit: undefined,
    offset: undefined,
  }) as Array<{ taskId?: unknown; status?: unknown; progressPhase?: unknown }>;
  const failedView = views.find((view) => view.taskId === 'task-seam-full');
  assert.equal(failedView?.status, 'failed');
  assert.equal(
    failedView?.progressPhase,
    null,
    'readAllTasks 水合的历史 failed 行 progressPhase 必须为 null（共享投影归一）',
  );

  const response = await fetch(
    `${baseUrl}/api/tasks/task-seam-full?projectPath=${encodeURIComponent(projectPath)}`,
  );
  assert.equal(response.status, 200);
  const payload = (await response.json()) as {
    task?: { status?: unknown; progressPhase?: unknown };
  };
  assert.equal(payload.task?.status, 'failed');
  assert.equal(
    payload.task?.progressPhase,
    null,
    'failed 任务读取视图的 progressPhase 必须归零（历史行读侧兜底）',
  );
});
