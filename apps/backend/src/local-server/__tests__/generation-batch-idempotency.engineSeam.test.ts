import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import * as http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  PromptDockBatchSubmitRequestSchema,
  PromptDockBatchSubmitResponseSchema,
  RuntimeTransactionResultSchema,
  type PromptDockBatchSubmitResponse,
  type RuntimeTransactionResult,
} from '@iart/contracts';
import { setBackendIpcTestHandler } from '../backend-ipc-sender.cts';
import {
  acceptGenerationBatch,
  dispatchAcceptedBatch,
  persistAcceptedBatch,
  resolveBatchReplayByClientRequestId,
} from '../business-actions/generation-batch.cts';
import { createProjectFolder } from '../project-store.cts';
import { removeProjectScope, syncProjectScope } from '../project-media-scope.cts';
import {
  clearCacheForTest as clearConnectionCache,
  createConnection,
  setConnectionCredential,
} from '../provider-connection/connection-store.cts';
import {
  clearCacheForTest as clearDeploymentCache,
  createDeployment,
} from '../provider-connection/deployment-store.cts';
import {
  clearCacheForTest as clearActiveRouteCache,
  setActiveDeployment,
} from '../provider-connection/active-route-store.cts';
import { setCredentialForConnection } from '../provider-connection/credential-store.cts';

/**
 * GenerationBatch 受理幂等键「受理 → 落库 → 重放」接缝测试
 *（spec docs/integrations/CLI与本地Agent集成.md §5.4 受理幂等键 / CLI-033）。
 *
 * 使命：验证**真实**链路「真实 HTTP 受理端点（createRequestHandler 全量真实路由）→ 真实
 * acceptGenerationBatch 组装受理 → 真实 persistAcceptedBatch 落库（真实 SQLite + 真实
 * editor-storage 迁移/写入/读取 dist 模块）→ 幂等键查重重放返回既有批次与任务身份」，以及
 * 不同幂等键正常新建批次、并发重复由唯一索引硬拒。
 *
 * 边界外的替身只有两处（与 agent-tool-lineage.engineSeam 同一 bargain）：
 * - Backend→Main IPC 在测试处理器内拦截，但处理器背后是**真实存储**（内存 SQLite + 真实
 *   desktop-shell dist 的 schema/writer/read-model——传输腿是注入点，存储零替身）；
 * - 假 HTTP 上游：globalThis.fetch 直接 reject（受理路径不触网；派发余波按失败结算，不影响断言）。
 *
 * 红→绿自证：本测试先在「无幂等键」旧实现上跑红（请求 schema 拒绝 client_request_id 或
 * 二次提交生成新批次），再随幂等键链路落地转绿。
 */

const GENERATION_MODEL_ID = 'gpt-image-seam-idem';
const GENERATION_CONNECTION_BASE_URL = 'https://seam-gen-upstream.example.invalid/v1';
const GENERATION_CREDENTIAL = 'sk-seam-gen-key';

const PROJECT_NAME = 'demo-batch-idem';

// ---------------------------------------------------------------------------
// 真实存储（desktop-shell dist 模块 + node ABI better-sqlite3）
// ---------------------------------------------------------------------------

const workspaceRoot = process.cwd();
// backend 测试按 commonjs 编译（apps/backend type: commonjs），用 __filename 建 require
// （沿 router.task-list-read.engineSeam.test.ts 同一加载口径）。
const requireDesktop = createRequire(__filename);
const schemaEntry = `${workspaceRoot}/apps/desktop-shell/dist/storage/editor-storage-schema.cjs`;
const runtimeWriterEntry = `${workspaceRoot}/apps/desktop-shell/dist/storage/editor-storage-runtime-writer.cjs`;
const readModelEntry = `${workspaceRoot}/apps/desktop-shell/dist/storage/editor-storage-read-model.cjs`;

type StorageModules = {
  schema: { initSchema: (db: unknown, options?: { projectPath?: string }) => void };
  runtimeWriter: {
    executeRuntimeTransaction: (db: unknown, payload: Record<string, unknown>) => Record<string, unknown>;
    writeTaskEvent: (db: unknown, payload: Record<string, unknown>) => Record<string, unknown>;
  };
  readModel: {
    readBatchByClientRequestId: (db: unknown, clientRequestId: string) => unknown;
    readTasksByBatchId: (db: unknown, batchId: string) => unknown[];
    readBatchById: (db: unknown, batchId: string) => unknown;
  };
};

const loadStorageModules = (): StorageModules => ({
  schema: requireDesktop(schemaEntry) as StorageModules['schema'],
  runtimeWriter: requireDesktop(runtimeWriterEntry) as StorageModules['runtimeWriter'],
  readModel: requireDesktop(readModelEntry) as StorageModules['readModel'],
});

const ensureDesktopStorageBuilt = (): void => {
  if (fs.existsSync(schemaEntry) && fs.existsSync(runtimeWriterEntry) && fs.existsSync(readModelEntry)) return;
  execFileSync('pnpm', ['--filter', '@iart/desktop-shell', 'build'], { cwd: workspaceRoot, stdio: 'pipe' });
};

// ---------------------------------------------------------------------------
// 生成包夹具（沿 agent-tool-lineage.engineSeam 的最小可提交生成包）
// ---------------------------------------------------------------------------

const writeGenerationPackage = (packageRoot: string): void => {
  const packageDir = path.join(packageRoot, 'seam-idem-image-pkg');
  fs.mkdirSync(path.join(packageDir, 'locales'), { recursive: true });
  const writeJson = (filePath: string, value: unknown): void => {
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8');
  };
  writeJson(path.join(packageDir, 'manifest.json'), {
    package_id: 'seam-idem-image-pkg',
    entry_model: { model_id: GENERATION_MODEL_ID, relative_path: 'runtime_model.json' },
    node_definition: { relative_path: 'node_definition.json' },
    resources: [],
    locales: [
      { locale: 'zh-CN', relative_path: 'locales/zh-CN.json' },
      { locale: 'en', relative_path: 'locales/en.json' },
    ],
  });
  writeJson(path.join(packageDir, 'locales', 'zh-CN.json'), { Prompt: 'Prompt' });
  writeJson(path.join(packageDir, 'locales', 'en.json'), { Prompt: 'Prompt' });
  writeJson(path.join(packageDir, 'node_definition.json'), {
    node_type: 'model',
    group_key: 'seam-idem',
    input_ports: [],
    output_ports: [],
  });
  writeJson(path.join(packageDir, 'runtime_model.json'), {
    model_id: GENERATION_MODEL_ID,
    provider_id: 'openai',
    capability: {
      input_modalities: ['text'],
      output_modalities: ['image'],
      supports_async_task: false,
    },
    parameter_schema: {
      fields: [{ field_key: 'prompt', label: 'Prompt', component: 'textarea', required: true }],
      required_fields: [],
      default_values: {},
    },
    runtime: {
      provider_id: 'openai',
      execution_driver: 'http_formal_task',
      api_defaults: { endpoint: '/v1/test', method: 'POST', contentType: 'application/json' },
    },
    request_strategy: {
      request_stage: 'submit',
      protocol: 'http',
      endpoint: '/v1/test',
      method: 'POST',
      header_rules: [],
      body_rules: [],
      query_rules: [],
    },
    result_rule: { mode: 'sync', submit_response_id_path: '/id' },
    result_output_mapping: {
      response_mode: 'structured_payload',
      output_mapping_rules: [
        { target: 'output.image_url', source: { kind: 'response', path: 'data.0.url' }, required: false, default_value: null },
      ],
    },
  });
};

const createOpenedProject = (tempDir: string, projectName: string) => {
  const created = createProjectFolder(tempDir, projectName);
  if (!created || 'error' in created) {
    throw new Error('project_creation_failed');
  }
  const projectPath = created.projectPath;
  fs.writeFileSync(
    path.join(projectPath, 'manifest.json'),
    JSON.stringify({ version: 1, name: projectName }),
    'utf-8',
  );
  const stableProjectId = `spid_${crypto.randomBytes(12).toString('hex')}`;
  const projectRef = `prj_${crypto.randomBytes(16).toString('hex').slice(0, 32)}`;
  const synced = syncProjectScope({ stableProjectId, projectPath, projectRef });
  assert.ok(synced, 'project scope should be registered');
  return {
    projectPath,
    close: (): void => {
      removeProjectScope(stableProjectId);
    },
  };
};

// ---------------------------------------------------------------------------
// 环境搭建：真实引擎 + 真实存储 + 真实 HTTP 路由
// ---------------------------------------------------------------------------

type SeamHandle = {
  projectPath: string;
  baseUrl: string;
  submitBatch: (body: Record<string, unknown>) => Promise<{ status: number; payload: unknown }>;
  db: unknown;
  storage: StorageModules;
  close: () => void;
};

const setupSeam = async (t: TestContext): Promise<SeamHandle> => {
  ensureDesktopStorageBuilt();
  const storage = loadStorageModules();

  const previousRoot = process.env['IART_STORAGE_ROOT'];
  const previousPackagesDir = process.env['IART_MODEL_ASSET_PACKAGES_DIR'];
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-idem-seam-storage-'));
  const packagesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-idem-seam-packages-'));
  writeGenerationPackage(packagesDir);
  process.env['IART_STORAGE_ROOT'] = storageRoot;
  process.env['IART_MODEL_ASSET_PACKAGES_DIR'] = packagesDir;
  const clearCaches = (): void => {
    clearConnectionCache();
    clearDeploymentCache();
    clearActiveRouteCache();
  };
  clearCaches();
  const project = createOpenedProject(storageRoot, PROJECT_NAME);

  // 真实 SQLite 项目库（node ABI better-sqlite3，与 desktop-shell 存储测试同一加载口径）：
  // 真实 DDL/迁移 + 真实 writer/read-model。
  const Database = requireDesktop('better-sqlite3') as new (filename: string) => BetterSqliteDb;
  const db = new Database(':memory:');
  storage.schema.initSchema(db, { projectPath: project.projectPath });

  // Backend→Main IPC 测试处理器：传输腿是注入点，背后全部真实存储。
  // 结果统一经 RuntimeTransactionResultSchema parse（接缝纪律：真实响应喂消费端同一份契约 schema）。
  const successResult = (transactionId: string, data: unknown): RuntimeTransactionResult =>
    RuntimeTransactionResultSchema.parse({
      type: 'runtime:transaction-result',
      transactionId,
      success: true,
      data,
    });
  setBackendIpcTestHandler(async (message) => {
    const msg = message as Record<string, unknown> & { type: string; transactionId: string };
    if (msg.type === 'runtime:execute-transaction') {
      return RuntimeTransactionResultSchema.parse(storage.runtimeWriter.executeRuntimeTransaction(db, msg));
    }
    if (msg.type === 'runtime:write-task-event') {
      return RuntimeTransactionResultSchema.parse(storage.runtimeWriter.writeTaskEvent(db, msg));
    }
    if (msg.type === 'runtime:read-batch-by-client-request-id') {
      const batch = storage.readModel.readBatchByClientRequestId(db, msg.clientRequestId as string);
      return successResult(msg.transactionId, { batch });
    }
    if (msg.type === 'runtime:read-agent-messages') {
      return successResult(msg.transactionId, []);
    }
    throw new Error(`unexpected IPC message type in idempotency seam: ${msg.type}`);
  });

  // 生成链路种子：连接 → 凭证 → 部署 → active route（组装受理用，真实 store）。
  const generationConnection = createConnection({
    display_name: 'seam-gen-upstream',
    base_url: GENERATION_CONNECTION_BASE_URL,
  });
  const generationCredential = await setCredentialForConnection(generationConnection.connection_id, GENERATION_CREDENTIAL);
  assert.ok(generationCredential, 'generation credential should be written');
  setConnectionCredential(generationConnection.connection_id, generationCredential.credentialRef, generationCredential.version, true);
  const generationDeployment = createDeployment({
    model_id: GENERATION_MODEL_ID,
    connection_id: generationConnection.connection_id,
    remote_model_id: 'remote-seam-image',
  });
  assert.equal(setActiveDeployment(GENERATION_MODEL_ID, generationDeployment.deployment_id), generationDeployment.deployment_id);

  // 假 HTTP 上游：受理路径不触网；仅拦截远端请求（本机 127.0.0.1 是真实被测服务器，
  // 原样放行），远端请求立即拒绝 → 派发余波（setImmediate startTaskExecution）失败结算。
  const originalFetch = globalThis.fetch;
  const isLocalSeamServer = (url: string): boolean =>
    url.startsWith("http://127.0.0.1:") || url.startsWith("http://localhost:");
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (isLocalSeamServer(url)) return originalFetch(input, init);
    throw new Error("seam: network disabled for idempotency test");
  }) as typeof fetch;

  // 真实 HTTP 服务器（全量真实路由注册）。
  const { createRequestHandler } = await import('../router.cts');
  const handler = createRequestHandler({ baseDir: workspaceRoot });
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object', 'server address should be available');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const submitBatch = async (body: Record<string, unknown>): Promise<{ status: number; payload: unknown }> => {
    const response = await fetch(`${baseUrl}/api/generation-batches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let payload: unknown = null;
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      payload = text;
    }
    return { status: response.status, payload };
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
    setBackendIpcTestHandler(null);
    server.close();
    project.close();
    db.close();
    clearCaches();
    if (previousRoot === undefined) delete process.env['IART_STORAGE_ROOT'];
    else process.env['IART_STORAGE_ROOT'] = previousRoot;
    if (previousPackagesDir === undefined) delete process.env['IART_MODEL_ASSET_PACKAGES_DIR'];
    else process.env['IART_MODEL_ASSET_PACKAGES_DIR'] = previousPackagesDir;
    fs.rmSync(storageRoot, { recursive: true, force: true });
    fs.rmSync(packagesDir, { recursive: true, force: true });
  });

  return {
    projectPath: project.projectPath,
    baseUrl,
    submitBatch,
    db,
    storage,
    close: () => undefined,
  };
};

type BetterSqliteDb = {
  prepare: (sql: string) => { get: (...params: unknown[]) => unknown; all: (...params: unknown[]) => unknown[] };
  close: () => void;
};

const buildSubmitBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  model_id: GENERATION_MODEL_ID,
  model_version: '1.0.0',
  prompt: '一只猫在窗台',
  arguments: {},
  task_count: 2,
  project_path: '',
  ...overrides,
});

const parseAcceptance = (payload: unknown): PromptDockBatchSubmitResponse =>
  PromptDockBatchSubmitResponseSchema.parse(payload);

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

void test('接缝：受理幂等键——真实 HTTP 受理落库后同键重提幂等重放（同批次同任务、replayed: true）', async (t) => {
  const seam = await setupSeam(t);
  const clientRequestId = 'req-idem-seam-1';

  // 第一次受理：全新受理（replayed: false），批次与任务身份落库且幂等键持久化。
  const first = await seam.submitBatch(
    buildSubmitBody({ project_path: seam.projectPath, client_request_id: clientRequestId }),
  );
  assert.equal(first.status, 200, JSON.stringify(first.payload));
  const firstAcceptance = parseAcceptance(first.payload);
  assert.equal(firstAcceptance.replayed, false, 'first acceptance must not be replayed');
  const firstTaskIds = firstAcceptance.tasks.map((task) => task.task_id);
  assert.equal(firstTaskIds.length, 2);

  // 落库侧证据：batches.clientRequestId 已持久化（真实存储行读取）。
  const row = (seam.db as BetterSqliteDb)
    .prepare('SELECT batchId, clientRequestId FROM batches WHERE batchId = ?')
    .get(firstAcceptance.batch_id) as { batchId: string; clientRequestId: string | null } | undefined;
  assert.ok(row !== undefined, 'batch row should be persisted');
  assert.equal(row.clientRequestId, clientRequestId, 'client request id must be persisted on the batch row');

  // 第二次同键提交（模拟崩溃后重提）：幂等重放——同一批次、同一任务身份、replayed: true。
  const second = await seam.submitBatch(
    buildSubmitBody({ project_path: seam.projectPath, client_request_id: clientRequestId }),
  );
  assert.equal(second.status, 200, JSON.stringify(second.payload));
  const replayAcceptance = parseAcceptance(second.payload);
  assert.equal(replayAcceptance.replayed, true, 'duplicate submission must replay');
  assert.equal(replayAcceptance.batch_id, firstAcceptance.batch_id, 'replay must return the original batch id');
  assert.deepEqual(
    replayAcceptance.tasks.map((task) => task.task_id),
    firstTaskIds,
    'replay must return the original task identities',
  );
  // 重放不新增批次行、不新增任务行。
  const batchCount = (seam.db as BetterSqliteDb)
    .prepare('SELECT COUNT(*) AS n FROM batches')
    .get() as { n: number };
  assert.equal(batchCount.n, 1, 'no extra batch row may be created by replay');
  const taskCount = (seam.db as BetterSqliteDb)
    .prepare('SELECT COUNT(*) AS n FROM tasks')
    .get() as { n: number };
  assert.equal(taskCount.n, 2, 'no extra task rows may be created by replay');
});

void test('接缝：不同幂等键正常新建批次；无幂等键提交不持久化幂等键', async (t) => {
  const seam = await setupSeam(t);

  const first = parseAcceptance(
    (await seam.submitBatch(buildSubmitBody({ project_path: seam.projectPath, client_request_id: 'req-idem-A' })))
      .payload,
  );
  const second = parseAcceptance(
    (await seam.submitBatch(buildSubmitBody({ project_path: seam.projectPath, client_request_id: 'req-idem-B' })))
      .payload,
  );
  assert.notEqual(second.batch_id, first.batch_id, 'different client request id must create a new batch');
  assert.equal(second.replayed, false);

  const noKey = parseAcceptance(
    (await seam.submitBatch(buildSubmitBody({ project_path: seam.projectPath }))).payload,
  );
  assert.equal(noKey.replayed, false);
  const row = (seam.db as BetterSqliteDb)
    .prepare('SELECT clientRequestId FROM batches WHERE batchId = ?')
    .get(noKey.batch_id) as { clientRequestId: string | null } | undefined;
  assert.ok(row !== undefined);
  assert.equal(row.clientRequestId, null, 'submission without idempotency key must not persist one');
});

void test('接缝：业务动作层 resolveBatchReplayByClientRequestId 直证查重读取（命中/未命中/IPC 失败降级）', async (t) => {
  const seam = await setupSeam(t);
  const clientRequestId = 'req-idem-seam-2';

  const before = await resolveBatchReplayByClientRequestId({ projectPath: seam.projectPath, clientRequestId });
  assert.equal(before, null, 'no batch before acceptance');

  const accepted = await acceptGenerationBatch({
    body: PromptDockBatchSubmitRequestSchema.parse(
      buildSubmitBody({ project_path: seam.projectPath, client_request_id: clientRequestId }),
    ),
    baseDir: null,
  });
  assert.ok(accepted.ok, 'acceptance should succeed');
  if (!accepted.ok) return;
  const persisted = await persistAcceptedBatch({
    projectPath: seam.projectPath,
    intentSnapshot: accepted.intentSnapshot,
    tasks: accepted.tasks,
    clientRequestId,
  });
  assert.ok(persisted.ok, 'persistence should succeed');

  const replayed = await resolveBatchReplayByClientRequestId({ projectPath: seam.projectPath, clientRequestId });
  assert.ok(replayed !== null, 'replay lookup must hit after acceptance');
  assert.equal(replayed.batch_id, accepted.batchId, 'replay snapshot must carry the original batch id');
  assert.deepEqual(replayed.task_ids, accepted.intentSnapshot.task_ids, 'replay snapshot must carry original task ids');

  // 派发余波照常可执行（dispatch 在重放路径不发生；这里验证导出面可用）。
  assert.equal(typeof dispatchAcceptedBatch, 'function');
});
