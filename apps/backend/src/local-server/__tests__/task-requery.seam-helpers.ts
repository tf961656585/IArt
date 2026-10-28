import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext } from 'node:test';

import {
  RuntimeTransactionResultSchema,
  type InterfaceRecipe,
  type TaskStateNotification,
} from '@iart/contracts';
import { setBackendIpcTestHandler } from '../backend-ipc-sender.cts';
import { submitFormalTaskExecutionPlan } from '../business-actions/formal-task.cts';
import { buildFamilyTemplateSources } from '../generation-family-templates.registry.cts';
import { normalizeFormalTaskExecutionPlan } from '../model-package-catalog.task-plan.cts';
import { clearRuntimeProjectScopesForTest } from '../project-media-scope.cts';
import {
  clearCacheForTest as clearActiveRouteCache,
  setActiveDeployment,
} from '../provider-connection/active-route-store.cts';
import {
  clearCacheForTest as clearConnectionCache,
  createConnection,
  setConnectionCredential,
} from '../provider-connection/connection-store.cts';
import { setCredentialForConnection } from '../provider-connection/credential-store.cts';
import {
  addCustomGenerationModel,
  clearCacheForTest as clearCustomGenerationModelCache,
} from '../provider-connection/custom-generation-model-store.cts';
import {
  addInterfaceRecipe,
  clearCacheForTest as clearInterfaceRecipeCache,
} from '../provider-connection/interface-recipe-store.cts';
import { readTaskArchiveEvents } from '../task-engine-archive.cts';
import { startTaskExecution } from '../task-executor.cts';

/**
 * 重新查询接缝的共用夹具（**测试专用**，不是测试入口文件）。
 *
 * 放入独立模块的原因：引擎接缝用例与路由资格矩阵用例共享同一套隔离存储、真实 SQLite
 * 存储读写、真实记录创建链路、真实模型/连接/配方播种与假 HTTP 上游；各写一份会在
 * 环境清理、任务身份与上游响应形状上漂移。
 *
 * 真实性边界：除 Backend→Main IPC 传输腿与远端 HTTP 外全部走生产实现；任务记录只由
 * `submitFormalTaskExecutionPlan`（真实受理动作）创建，计划由真实族模板 × 真实配方合成。
 */

export const MODEL_ID = 'seam-requery-video';
export const FAMILY_ADAPTER_ID = 'seedance-2-0-v1';
export const CONNECTION_BASE_URL = 'https://seam-requery.example.invalid';
export const CREDENTIAL_VALUE = 'sk-seam-requery-secret';
export const REMOTE_MODEL_ID = 'remote-seam-requery';
export const REMOTE_TASK_ID = 'remote-task-requery-1';
export const DOWNLOAD_URL = 'https://cdn.seam-requery.example.invalid/out.mp4';
export const RECIPE_ID = 'ir_seam_requery';
export const VIDEO_BYTES = Buffer.from('seam-requery-video-bytes');

const workspaceRoot = process.cwd();
const distStorageDir = path.join(workspaceRoot, 'apps/desktop-shell/dist/storage');
const schemaEntry = path.join(distStorageDir, 'editor-storage-schema.cjs');
const runtimeWriterEntry = path.join(distStorageDir, 'editor-storage-runtime-writer.cjs');
const readModelEntry = path.join(distStorageDir, 'editor-storage-read-model.cjs');

export type SqliteDb = {
  pragma: (statement: string) => unknown;
  prepare: (statement: string) => {
    run: (...params: unknown[]) => unknown;
    get: (...params: unknown[]) => unknown;
  };
  close: () => void;
};
export type SchemaModule = { initSchema: (db: unknown, options?: { projectPath?: string }) => void };
export type RuntimeWriterModule = {
  executeRuntimeTransaction: (db: unknown, payload: unknown) => { success?: unknown; error?: unknown };
};
export type TaskViewMetadataShape = {
  requeryCount?: unknown;
  requeryStartedAt?: unknown;
  remoteRequestId?: unknown;
  remote_request_id?: unknown;
  taskCancelRecord?: unknown;
  agentLineage?: unknown;
  executionSnapshot?: unknown;
  execution_snapshot?: unknown;
  taskExecutionPlan?: unknown;
};
export type TaskViewShape = {
  taskId?: unknown;
  status?: unknown;
  projectPath?: unknown;
  remoteRequestId?: unknown;
  failure?: { code?: unknown; stage?: unknown } | null | undefined;
  metadata?: TaskViewMetadataShape | null | undefined;
};
export type ReadModelModule = { readTaskById: (db: unknown, taskId: string) => TaskViewShape | null };
export type UpstreamCall = { url: string; method: string };
export type UpstreamStub = { calls: UpstreamCall[]; restore: () => void };

export type Scenario = {
  db: SqliteDb;
  readModel: ReadModelModule;
  projectPath: string;
  connectionId: string;
  credentialRef: string;
  upstream: UpstreamStub;
  /** 提交响应 id 路径（来自执行计划声明，测试不手工假定）+ 查询响应终态。 */
  upstreamConfig: { submitIdPath: string; pollStatus: 'succeeded' | 'running' };
  /** 路由用例用它把真实记录派生成资格矩阵变体；缺省直接读真实存储。 */
  viewOverrides: Map<string, unknown>;
  notifications: TaskStateNotification[];
  restoreNotifications: () => void;
};

const requireFromTest = createRequire(__filename);
const Database = requireFromTest('better-sqlite3') as new (filename: string) => SqliteDb;

const ensureDistStorage = () => {
  if (fs.existsSync(schemaEntry) && fs.existsSync(runtimeWriterEntry) && fs.existsSync(readModelEntry)) return;
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

export const jsonResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });

export const installUpstream = (
  t: TestContext,
  handler: (call: UpstreamCall) => Response,
): UpstreamStub => {
  const originalFetch = globalThis.fetch;
  const calls: UpstreamCall[] = [];
  globalThis.fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    // 本机 HTTP 服务（路由用例起真实 server）透传给真实实现，只拦截远端上游。
    if (url.startsWith('http://127.0.0.1')) return originalFetch(input, init);
    const call: UpstreamCall = { url, method: (init?.method ?? 'GET').toUpperCase() };
    calls.push(call);
    return handler(call);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
};

export const installNotificationCapture = (): {
  notifications: TaskStateNotification[];
  restore: () => void;
} => {
  const original = process.send;
  const notifications: TaskStateNotification[] = [];
  process.send = (message: unknown): boolean => {
    const candidate = message as { type?: unknown } | null;
    if (candidate !== null && candidate !== undefined && candidate.type === 'task:state-changed') {
      notifications.push(message as TaskStateNotification);
    }
    return true;
  };
  return {
    notifications,
    restore: () => {
      if (original === undefined) {
        Reflect.deleteProperty(process, 'send');
        return;
      }
      process.send = original;
    },
  };
};

export const normalizeString = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : '';

/** 把值写到 `/a/b` 形状的路径上（提交响应形状跟随计划声明的 id 路径）。 */
export const buildIdPathResponse = (idPath: string, value: string): Record<string, unknown> => {
  const segments = idPath.replace(/^\/+/, '').split('/').filter(Boolean);
  const root: Record<string, unknown> = {};
  let cursor = root;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined) continue;
    if (index === segments.length - 1) {
      cursor[segment] = value;
      break;
    }
    const next: Record<string, unknown> = {};
    cursor[segment] = next;
    cursor = next;
  }
  return root;
};

export const readPersistedView = (
  readModel: ReadModelModule,
  db: SqliteDb,
  taskId: string,
): TaskViewShape => {
  const view = readModel.readTaskById(db, taskId);
  assert.ok(view, '任务行应当已落库');
  return view;
};

type CountRowShape = { total?: unknown };

export const countRows = (db: SqliteDb, table: string): number => {
  const row: unknown = db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get();
  const total = row !== null && typeof row === 'object' ? (row as CountRowShape).total : undefined;
  if (typeof total !== 'number') throw new Error(`row count for ${table} is not a number`);
  return total;
};

type ArchiveEventShape = { type?: unknown };
const asArchiveEventShape = (value: unknown): ArchiveEventShape =>
  value !== null && typeof value === 'object' ? (value as ArchiveEventShape) : {};

export const readArchiveEventTypes = (projectPath: string, taskId: string): string[] => {
  const events = readTaskArchiveEvents({ taskId, projectPath, metadata: undefined });
  return events.map((event) => normalizeString(asArchiveEventShape(event).type)).filter(Boolean);
};

export const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
  for (let attempt = 0; attempt < 800; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  throw new Error(`waitFor timed out: ${label}`);
};

export const createRecipe = (mediaFieldPaths: string[]): InterfaceRecipe => ({
  recipe_id: RECIPE_ID,
  name: '接缝重新查询配方',
  family_adapter_id: FAMILY_ADAPTER_ID,
  success_when: { op: 'eq', path: 'status', value: 'succeeded' },
  failure_when: { op: 'eq', path: 'status', value: 'failed' },
  result: { kind: 'direct_url', media_field_paths: mediaFieldPaths, media_type: 'video' },
  requires_auth: true,
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(),
});

export const setupRequeryScenario = async (
  t: TestContext,
  scenario: string,
  options: { mediaFieldPaths: string[] },
): Promise<Scenario> => {
  const previousRoot = process.env['IART_STORAGE_ROOT'];
  const previousPackagesDir = process.env['IART_MODEL_ASSET_PACKAGES_DIR'];
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), `requery-seam-storage-${scenario}-`));
  const packagesDir = fs.mkdtempSync(path.join(os.tmpdir(), `requery-seam-packages-${scenario}-`));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), `requery-seam-project-${scenario}-`));
  const projectPath = path.join(projectRoot, 'requery-seam.iartproj');
  fs.mkdirSync(path.join(projectPath, 'media'), { recursive: true });
  fs.writeFileSync(
    path.join(projectPath, 'manifest.json'),
    JSON.stringify({ version: 1, name: `requery-${scenario}` }, null, 2),
    'utf-8',
  );
  process.env['IART_STORAGE_ROOT'] = storageRoot;
  process.env['IART_MODEL_ASSET_PACKAGES_DIR'] = packagesDir;
  clearConnectionCache();
  clearActiveRouteCache();
  clearCustomGenerationModelCache();
  clearInterfaceRecipeCache();
  clearRuntimeProjectScopesForTest();

  const { schema, runtimeWriter, readModel } = loadDistModules();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  schema.initSchema(db);
  const viewOverrides = new Map<string, unknown>();

  setBackendIpcTestHandler(async (message) => {
    if (message.type === 'runtime:execute-transaction') {
      const result = runtimeWriter.executeRuntimeTransaction(db, message);
      return RuntimeTransactionResultSchema.parse({
        type: 'runtime:transaction-result',
        transactionId: message.transactionId,
        success: result.success === true,
        ...(result.error === undefined ? {} : { error: String(result.error) }),
      });
    }
    if (message.type === 'runtime:read-task-by-id') {
      const override = viewOverrides.get(message.taskId);
      return RuntimeTransactionResultSchema.parse({
        type: 'runtime:transaction-result',
        transactionId: message.transactionId,
        success: true,
        data: override ?? readModel.readTaskById(db, message.taskId),
      });
    }
    if (message.type === 'runtime:write-task-event') {
      return RuntimeTransactionResultSchema.parse({
        type: 'runtime:transaction-result',
        transactionId: message.transactionId,
        success: true,
      });
    }
    throw new Error(`unexpected IPC message type: ${message.type}`);
  });

  const connection = createConnection({
    display_name: `requery-${scenario}`,
    base_url: CONNECTION_BASE_URL,
  });
  const credential = await setCredentialForConnection(connection.connection_id, CREDENTIAL_VALUE);
  assert.ok(credential, 'credential should be stored');
  if (!credential) throw new Error('credential setup failed');
  setConnectionCredential(connection.connection_id, credential.credentialRef, credential.version, true);
  const addedRecipe = addInterfaceRecipe({
    recipe_id: RECIPE_ID,
    name: '接缝重新查询配方',
    family_adapter_id: FAMILY_ADAPTER_ID,
    success_when: { op: 'eq', path: 'status', value: 'succeeded' },
    failure_when: { op: 'eq', path: 'status', value: 'failed' },
    result: { kind: 'direct_url', media_field_paths: options.mediaFieldPaths, media_type: 'video' },
    requires_auth: true,
  });
  assert.equal(addedRecipe.ok, true, 'recipe should be accepted by the real store');
  const addedModel = addCustomGenerationModel({
    model_id: MODEL_ID,
    connection_id: connection.connection_id,
    family_adapter_id: FAMILY_ADAPTER_ID,
    remote_model_id: REMOTE_MODEL_ID,
    recipe_id: RECIPE_ID,
  });
  assert.equal(addedModel.ok, true, 'model record should be accepted by the real store');
  if (!addedModel.ok) throw new Error('model setup failed');
  assert.equal(
    setActiveDeployment(MODEL_ID, addedModel.model.record_id),
    addedModel.model.record_id,
    'active route should point at the seeded record',
  );

  const notifications = installNotificationCapture();
  const upstreamConfig: Scenario['upstreamConfig'] = { submitIdPath: '/id', pollStatus: 'succeeded' };
  const upstream = installUpstream(t, (call) => {
    if (call.method === 'POST' && call.url.endsWith('/api/v3/contents/generations/tasks')) {
      // 提交响应形状跟随当前执行计划声明的 submit_response_id_path，不手工写死一个「理想」响应。
      return jsonResponse(buildIdPathResponse(upstreamConfig.submitIdPath, REMOTE_TASK_ID));
    }
    if (call.url.includes(`/api/v3/contents/generations/tasks/${REMOTE_TASK_ID}`)) {
      if (upstreamConfig.pollStatus === 'running') return jsonResponse({ status: 'running' });
      // 上游只给 video_url：旧配方读 `url` → 映射未命中；改成 video_url 后命中。
      return jsonResponse({ status: 'succeeded', video_url: DOWNLOAD_URL });
    }
    if (call.url === DOWNLOAD_URL) {
      return new Response(VIDEO_BYTES, {
        status: 200,
        headers: { 'content-type': 'video/mp4', 'content-length': String(VIDEO_BYTES.length) },
      });
    }
    throw new Error(`unexpected upstream request: ${call.method} ${call.url}`);
  });

  t.after(() => {
    upstream.restore();
    notifications.restore();
    setBackendIpcTestHandler(null);
    clearConnectionCache();
    clearActiveRouteCache();
    clearCustomGenerationModelCache();
    clearInterfaceRecipeCache();
    clearRuntimeProjectScopesForTest();
    if (previousRoot === undefined) delete process.env['IART_STORAGE_ROOT'];
    else process.env['IART_STORAGE_ROOT'] = previousRoot;
    if (previousPackagesDir === undefined) delete process.env['IART_MODEL_ASSET_PACKAGES_DIR'];
    else process.env['IART_MODEL_ASSET_PACKAGES_DIR'] = previousPackagesDir;
    db.close();
    fs.rmSync(storageRoot, { recursive: true, force: true });
    fs.rmSync(packagesDir, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  return {
    db,
    readModel,
    projectPath,
    connectionId: connection.connection_id,
    credentialRef: credential.credentialRef,
    upstream,
    upstreamConfig,
    viewOverrides,
    notifications: notifications.notifications,
    restoreNotifications: notifications.restore,
  };
};

/**
 * 用真实创建链路产出一个停在 `result_mapping` 的失败任务：
 * 受理动作 → 提交 + 轮询（假上游只给 video_url）→ 旧配方读 `url` → 映射未命中。
 */
export const submitAndFailAtResultMapping = async (
  scenario: Scenario,
): Promise<{ taskId: string; remoteRequestId: string }> => {
  const built = buildFamilyTemplateSources(FAMILY_ADAPTER_ID, MODEL_ID, {
    acceptedMediaSlots: [],
    recipe: createRecipe(['url']),
  });
  assert.equal(built.kind, 'ready', 'family template should be ready');
  if (built.kind !== 'ready') throw new Error('family template not ready');
  const plan = normalizeFormalTaskExecutionPlan(built.sources.runtimeModel);
  assert.ok(plan, 'execution plan should normalize');
  if (!plan) throw new Error('plan missing');
  const submitIdPath = normalizeString(plan.result_rule.submit_response_id_path);
  assert.ok(submitIdPath, 'plan should declare submit_response_id_path');
  scenario.upstreamConfig.submitIdPath = submitIdPath;
  const submission = await submitFormalTaskExecutionPlan({
    metadata: { modelId: MODEL_ID, projectPath: scenario.projectPath },
    submit_request: {
      url: `${CONNECTION_BASE_URL}${plan.request_strategy.endpoint}`,
      method: plan.request_strategy.method,
      headers: { 'content-type': 'application/json' },
      body: { model: REMOTE_MODEL_ID, content: [{ type: 'text', text: 'seam requery' }] },
    },
    polling_strategy: plan.polling_strategy,
    result_rule: plan.result_rule,
    result_acquisition_strategy: plan.result_acquisition_strategy,
    result_output_mapping: plan.result_output_mapping,
    auto_start: false,
  });
  assert.equal(submission.ok, true, 'task record should be created by the real submit action');
  if (!submission.ok) throw new Error('submission failed');
  const taskId = normalizeString((submission.record as { id?: unknown }).id);
  assert.ok(taskId, 'submitted record should carry a taskId');

  const executed = await startTaskExecution(submission.record);
  const executedView = readPersistedView(scenario.readModel, scenario.db, taskId);
  assert.equal(
    executedView.status,
    'failed',
    `首次执行应停在失败（实际 error=${JSON.stringify(executedView.failure)}，fetches=${scenario.upstream.calls.map((c) => c.url).join(' | ')}）`,
  );
  assert.equal(executedView.failure?.code, 'result_output_mapping_missed');
  assert.equal(executedView.failure?.stage, 'result_mapping');
  assert.equal(executedView.remoteRequestId, REMOTE_TASK_ID);
  assert.ok(executed, 'executor should resolve (failure is persisted, not thrown)');
  return { taskId, remoteRequestId: REMOTE_TASK_ID };
};
