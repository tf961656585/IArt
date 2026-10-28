import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import type { InterfaceRecipe } from '@iart/contracts';
import { RuntimeTransactionResultSchema } from '@iart/contracts';
import { setBackendIpcTestHandler } from '../backend-ipc-sender.cts';
import { buildFamilyTemplateSources } from '../generation-family-templates.registry.cts';
import { normalizeFormalTaskExecutionPlan } from '../model-package-catalog.task-plan.cts';
import {
  clearCacheForTest as clearConnectionCache,
  createConnection,
  setConnectionCredential,
} from '../provider-connection/connection-store.cts';
import { setCredentialForConnection } from '../provider-connection/credential-store.cts';
import { clearRuntimeProjectScopesForTest } from '../project-media-scope.cts';
import { executePollingTask } from '../task-engine-polling.cts';
import { executeTaskResultMaterialization } from '../task-result-materializer.cts';
import { ACQUIRED_MEDIA_URL_PATH } from '../task-result-acquisition.cts';

/**
 * 结果获取 × 物化接缝测试（`docs/model-assets/08-异步最终结果获取策略.md`）。
 *
 * 使命：用**真实族模板**（seedance）＋**真实协议适配器**（ADAPTER_REGISTRY/凭据租约）＋
 * 假 HTTP 上游，跑通两条完整路径：
 * - `accept = binary`：轮询终态只给 id → 获取阶段构造内容地址 → 既有下载链路（带鉴权）
 *   → 落盘 → `task_outputs` / `media_assets` 绑定 → 一次事务写 succeeded；
 * - `accept = json`：轮询终态只给 id → 获取阶段二次 GET → 映射 `after` 路径 → 下载
 *   → 同样收口 succeeded。
 *
 * 假 HTTP 上游用替换 `globalThis.fetch` 实现：连接 base_url 在 store 层被约束为 https，
 * 本机 http 无法通过真实 host 闸门（沿 agent-tool-loop.engineSeam 的既有做法）。
 * 除网络与 Backend→Main IPC 传输腿外，全部走生产实现。
 */

const MODEL_ID = 'seam-acquisition-model';
const BASE_URL = 'https://seam-acquisition.example.invalid/v1';
const CREDENTIAL = 'sk-seam-acquisition-secret';
const FAMILY_ADAPTER_ID = 'seedance-2-0-v1';

type UpstreamCall = {
  url: string;
  method: string;
  authorization: string | null;
};

type UpstreamStub = {
  calls: UpstreamCall[];
  restore: () => void;
};

const binaryPayload = Buffer.from('seam-video-bytes');
const DOWNLOAD_URL = 'https://cdn.seam-acquisition.example.invalid/out.mp4';

const binaryResponse = (): Response =>
  new Response(binaryPayload, {
    status: 200,
    headers: {
      'content-type': 'video/mp4',
      'content-length': String(binaryPayload.length),
    },
  });

const jsonResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const installUpstream = (
  t: TestContext,
  handler: (call: UpstreamCall) => Response,
): UpstreamStub => {
  const originalFetch = globalThis.fetch;
  const calls: UpstreamCall[] = [];
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    const call: UpstreamCall = {
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
      authorization: headers.get('authorization'),
    };
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

const buildRecipe = (result: InterfaceRecipe['result']): InterfaceRecipe => ({
  recipe_id: 'ir_seam_acquisition',
  name: '接缝配方',
  family_adapter_id: FAMILY_ADAPTER_ID,
  success_when: { op: 'eq', path: 'status', value: 'succeeded' },
  result,
  requires_auth: true,
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(),
});

const buildPlan = (result: InterfaceRecipe['result']) => {
  const recipe = buildRecipe(result);
  const built = buildFamilyTemplateSources(FAMILY_ADAPTER_ID, MODEL_ID, {
    acceptedMediaSlots: [],
    recipe,
  });
  assert.equal(built.kind, 'ready', 'seedance family template should be ready');
  if (built.kind !== 'ready') throw new Error('family template not ready');
  const plan = normalizeFormalTaskExecutionPlan(built.sources.runtimeModel);
  assert.ok(plan, 'execution plan should normalize');
  return plan;
};

type SeamContext = {
  projectPath: string;
  snapshot: Record<string, unknown>;
};

const setupContext = async (t: TestContext, scenario: string): Promise<SeamContext> => {
  const previousRoot = process.env['IART_STORAGE_ROOT'];
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), `acquisition-seam-storage-${scenario}-`));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), `acquisition-seam-project-${scenario}-`));
  const projectPath = path.join(projectRoot, 'seam-project.iartproj');
  fs.mkdirSync(path.join(projectPath, 'media'), { recursive: true });
  fs.writeFileSync(
    path.join(projectPath, 'manifest.json'),
    JSON.stringify({ version: 1, name: `seam-${scenario}` }),
    'utf-8',
  );
  process.env['IART_STORAGE_ROOT'] = storageRoot;
  clearConnectionCache();
  clearRuntimeProjectScopesForTest();

  const connection = createConnection({
    display_name: `acquisition-upstream-${scenario}`,
    base_url: BASE_URL,
  });
  const credential = await setCredentialForConnection(connection.connection_id, CREDENTIAL);
  assert.ok(credential, 'credential should be written');
  setConnectionCredential(connection.connection_id, credential.credentialRef, credential.version, true);

  t.after(() => {
    setBackendIpcTestHandler(null);
    clearConnectionCache();
    clearRuntimeProjectScopesForTest();
    if (previousRoot === undefined) delete process.env['IART_STORAGE_ROOT'];
    else process.env['IART_STORAGE_ROOT'] = previousRoot;
    fs.rmSync(storageRoot, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  return {
    projectPath,
    snapshot: {
      snapshot_id: `snap_acquisition_${scenario}`,
      model_id: MODEL_ID,
      model_version: '1.0.0',
      deployment_id: `up_dep_acquisition_${scenario}`,
      connection_id: connection.connection_id,
      connection_revision: 0,
      adapter_id: FAMILY_ADAPTER_ID,
      adapter_version: '1.0.0',
      base_url: BASE_URL,
      remote_model_id: 'remote-seam-acquisition',
      credential_ref: credential.credentialRef,
      credential_version: credential.version,
      resolved_endpoint: '/api/v3/contents/generations/tasks',
      created_at: new Date(0).toISOString(),
    },
  };
};

type CapturedTransaction = {
  tasks: Array<{ status: string }>;
  taskOutputs: Array<{ assetId: string | null; mediaType: string }>;
  mediaAssets: Array<{ assetId: string; payloadJson: string }>;
};

const isFinalTransaction = (value: unknown): value is CapturedTransaction => {
  if (value === null || typeof value !== 'object') return false;
  const outputs: unknown = Reflect.get(value, 'taskOutputs');
  return (
    Reflect.get(value, 'type') === 'runtime:execute-transaction' &&
    Array.isArray(outputs) &&
    outputs.length > 0
  );
};

const installIpcCapture = (captured: unknown[]): void => {
  setBackendIpcTestHandler(async (message) => {
    captured.push(message);
    return RuntimeTransactionResultSchema.parse({
      type: 'runtime:transaction-result',
      transactionId: message.transactionId,
      success: true,
      data: {},
    });
  });
};

const runPolling = async (
  context: SeamContext,
  plan: NonNullable<ReturnType<typeof buildPlan>>,
  taskId: string,
) => {
  const pollingStrategy = plan.polling_strategy;
  assert.ok(pollingStrategy, 'seedance plan should carry polling strategy');
  const record = {
    id: taskId,
    taskId,
    status: 'submitting',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    projectPath: context.projectPath,
    request: {
      url: `${BASE_URL}${plan.request_strategy.endpoint}`,
      method: 'POST',
      headers: {},
    },
    metadata: {
      taskId,
      projectPath: context.projectPath,
      modelId: MODEL_ID,
      taskExecutionPlan: plan,
      executionSnapshot: context.snapshot,
    },
  };
  return await executePollingTask(record, new AbortController(), {
    request: {
      url: pollingStrategy.request.url_template,
      method: 'GET',
      headers: {},
    },
    polling: {
      ...pollingStrategy.polling,
      intervalMs: 1,
      maxAttempts: 3,
    },
  });
};

const readResponseBody = (record: unknown): unknown => {
  if (record === null || typeof record !== 'object') return undefined;
  const response: unknown = Reflect.get(record, 'response');
  if (response === null || typeof response !== 'object') return undefined;
  return Reflect.get(response, 'body');
};

void test('接缝：binary 内容端点 → 获取阶段构造地址 → 带鉴权下载 → media_assets 绑定 → succeeded', async (t) => {
  const context = await setupContext(t, 'binary');
  const captured: unknown[] = [];
  installIpcCapture(captured);
  const upstream = installUpstream(t, (call) => {
    if (call.url.includes('/things/job_binary_1/content')) return binaryResponse();
    return jsonResponse({ status: 'succeeded', task: { id: 'job_binary_1' } });
  });

  const plan = buildPlan({
    kind: 'needs_fetch',
    identity_field_path: 'task.id',
    content_url_template: '/things/{id}/content',
    accept: 'binary',
    media_type: 'video',
  });

  const polled = await runPolling(context, plan, 'task-seam-binary');
  t.after(() => upstream.restore());

  // 获取阶段只构造地址，不下载字节：轮询命中后上游只被调用过一次。
  assert.equal(upstream.calls.length, 1, 'binary 不应在获取阶段额外发请求');
  assert.match(upstream.calls[0]?.url ?? '', /\/api\/v3\/contents\/generations\/tasks\//);
  const body = readResponseBody(polled);
  assert.equal(
    body !== null && typeof body === 'object'
      ? Reflect.get(body, ACQUIRED_MEDIA_URL_PATH)
      : undefined,
    `${BASE_URL}/things/job_binary_1/content`,
    '获取阶段把内容地址写入保留路径',
  );

  await executeTaskResultMaterialization(polled, undefined);

  assert.equal(upstream.calls.length, 2, '落盘阶段才下载字节');
  assert.equal(upstream.calls[1]?.url, `${BASE_URL}/things/job_binary_1/content`);
  assert.equal(upstream.calls[1]?.authorization, `Bearer ${CREDENTIAL}`, '下载链路带同源鉴权');

  const finalTransaction = captured.filter(isFinalTransaction)[0];
  assert.ok(finalTransaction, 'succeeded 事务应携带产物');
  assert.equal(finalTransaction.tasks[0]?.status, 'succeeded');
  assert.equal(finalTransaction.taskOutputs.length, 1);
  assert.equal(finalTransaction.taskOutputs[0]?.mediaType, 'video');
  assert.equal(finalTransaction.mediaAssets.length, 1);
  assert.equal(finalTransaction.taskOutputs[0]?.assetId, finalTransaction.mediaAssets[0]?.assetId);

  const payload = JSON.parse(finalTransaction.mediaAssets[0]?.payloadJson ?? '{}') as {
    original?: { fileKey?: unknown; sourceUrl?: unknown };
  };
  const fileKey = String(payload.original?.fileKey ?? '');
  assert.ok(fileKey, 'media asset payload should carry fileKey');
  assert.equal(fs.existsSync(path.join(context.projectPath, 'media', fileKey)), true, '媒体应已落盘');
  assert.equal(payload.original?.sourceUrl, `${BASE_URL}/things/job_binary_1/content`);
  assert.equal(JSON.stringify(captured).includes(CREDENTIAL), false, '凭证明文不得进入任务记录/事务');
});

void test('接缝：json 再取一次 → after 映射 → 带鉴权下载 → succeeded', async (t) => {
  const context = await setupContext(t, 'json');
  const captured: unknown[] = [];
  installIpcCapture(captured);
  const upstream = installUpstream(t, (call) => {
    if (call.url.includes('/things/job_json_1/content')) {
      return jsonResponse({ data: [{ url: DOWNLOAD_URL }] });
    }
    if (call.url === DOWNLOAD_URL) return binaryResponse();
    return jsonResponse({ status: 'succeeded', task: { id: 'job_json_1' } });
  });

  const plan = buildPlan({
    kind: 'needs_fetch',
    identity_field_path: 'task.id',
    content_url_template: '/things/{id}/content',
    accept: 'json',
    after: {
      kind: 'direct_url',
      media_field_paths: ['data.0.url'],
      media_type: 'video',
    },
  });

  const polled = await runPolling(context, plan, 'task-seam-json');
  t.after(() => upstream.restore());

  assert.equal(upstream.calls.length, 2, '轮询 + 最终结果 GET（下载尚未发生）');
  assert.equal(upstream.calls[0]?.authorization, `Bearer ${CREDENTIAL}`, '轮询与提交同源鉴权');
  assert.equal(upstream.calls[1]?.url, `${BASE_URL}/things/job_json_1/content`);
  assert.equal(upstream.calls[1]?.method, 'GET');
  assert.equal(upstream.calls[1]?.authorization, `Bearer ${CREDENTIAL}`, '最终结果请求带同源鉴权');
  assert.deepEqual(readResponseBody(polled), { data: [{ url: DOWNLOAD_URL }] });

  await executeTaskResultMaterialization(polled, undefined);

  assert.equal(upstream.calls.length, 3, '落盘阶段再下载媒体');
  assert.equal(upstream.calls[2]?.url, DOWNLOAD_URL);
  assert.equal(upstream.calls[2]?.authorization, `Bearer ${CREDENTIAL}`, '媒体下载同样带鉴权');

  const finalTransaction = captured.filter(isFinalTransaction)[0];
  assert.ok(finalTransaction, 'succeeded 事务应携带产物');
  assert.equal(finalTransaction.tasks[0]?.status, 'succeeded');
  assert.equal(finalTransaction.taskOutputs[0]?.mediaType, 'video');
  assert.equal(finalTransaction.taskOutputs[0]?.assetId, finalTransaction.mediaAssets[0]?.assetId);
  assert.equal(JSON.stringify(captured).includes(CREDENTIAL), false, '凭证明文不得进入任务记录/事务');
});
