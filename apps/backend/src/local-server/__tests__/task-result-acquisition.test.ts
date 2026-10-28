import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test, type TestContext } from 'node:test';

import {
  clearCacheForTest as clearConnectionCache,
  createConnection,
  setConnectionCredential,
} from '../provider-connection/connection-store.cts';
import { setCredentialForConnection } from '../provider-connection/credential-store.cts';
import {
  ACQUIRED_MEDIA_URL_PATH,
  maybeRunResultAcquisition,
} from '../task-result-acquisition.cts';

/**
 * 结果获取执行段（`docs/model-assets/08-异步最终结果获取策略.md`）。
 *
 * 走真实实现：真实策略读取 + 真实标识解析 + 真实请求（只挡 globalThis.fetch）+ 真实记录
 * patch（无 projectPath，不落库/不发 IPC）。覆盖：不适用、identity 未命中、json 再取一次、
 * binary 只构造地址、非 2xx 收口失败、requires_auth 的鉴权头与凭证缺失。
 */

type UpstreamCall = {
  url: string;
  method: string;
  authorization: string | null;
  headerApiKey: string | null;
};

type RecordOverrides = {
  id?: string;
  strategy?: Record<string, unknown> | null;
  body?: unknown;
  metadata?: Record<string, unknown>;
  requestUrl?: string;
};

const STRATEGY = {
  acquisition_mode: 'fetch_final_result',
  identity_source: 'query_response_path',
  identity_path: 'task.id',
  accept: 'json',
  requires_auth: false,
  request_strategy: {
    request_stage: 'acquisition',
    protocol: 'http',
    endpoint: '/v1/things/{id}/content',
    method: 'GET',
  },
};

const buildRecord = (overrides: RecordOverrides = {}) => {
  const id = overrides.id ?? 'task-acquisition-1';
  const strategy = overrides.strategy === undefined ? STRATEGY : overrides.strategy;
  return {
    id,
    taskId: id,
    status: 'polling',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    request: {
      url: overrides.requestUrl ?? 'https://provider.example/v1/poll/task-1',
      method: 'GET',
      headers: {},
    },
    metadata: {
      taskId: id,
      modelId: 'seam-generation-model',
      ...(overrides.metadata ?? {}),
      taskExecutionPlan: strategy === null ? {} : { result_acquisition_strategy: strategy },
    },
    response: {
      status: 200,
      ok: true,
      contentType: 'application/json',
      bodyType: 'json',
      body: overrides.body ?? { task: { id: 'job_42' }, status: 'succeeded' },
    },
  };
};

const stubFetch = (
  t: TestContext,
  responder: (call: UpstreamCall) => Response,
): { calls: UpstreamCall[] } => {
  const originalFetch = globalThis.fetch;
  const calls: UpstreamCall[] = [];
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    const call: UpstreamCall = {
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
      authorization: headers.get('authorization'),
      headerApiKey: headers.get('x-goog-api-key'),
    };
    calls.push(call);
    return responder(call);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return { calls };
};

const jsonResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });

let storageRoot = '';
let previousStorageRoot: string | undefined;
let connectionId = '';
let credentialRef = '';
let credentialVersion = 0;

before(async () => {
  previousStorageRoot = process.env['IART_STORAGE_ROOT'];
  storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task-acquisition-'));
  process.env['IART_STORAGE_ROOT'] = storageRoot;
  clearConnectionCache();
  const connection = createConnection({
    display_name: 'acquisition-upstream',
    base_url: 'https://provider.example',
  });
  connectionId = connection.connection_id;
  const credential = await setCredentialForConnection(connectionId, 'sk-acquisition-secret');
  assert.ok(credential, 'credential should be written');
  credentialRef = credential.credentialRef;
  credentialVersion = credential.version;
  setConnectionCredential(connectionId, credentialRef, credentialVersion, true);
});

after(() => {
  clearConnectionCache();
  if (previousStorageRoot === undefined) delete process.env['IART_STORAGE_ROOT'];
  else process.env['IART_STORAGE_ROOT'] = previousStorageRoot;
  fs.rmSync(storageRoot, { recursive: true, force: true });
});

const snapshotFor = () => ({
  snapshot_id: 'snap_acquisition_1',
  model_id: 'seam-generation-model',
  model_version: '1.0.0',
  deployment_id: 'up_dep_acquisition_1',
  connection_id: connectionId,
  connection_revision: 0,
  adapter_id: 'seedance-2-0-v1',
  adapter_version: '1.0.0',
  base_url: 'https://provider.example/v1',
  remote_model_id: 'remote-seam-model',
  credential_ref: credentialRef,
  credential_version: credentialVersion,
  resolved_endpoint: '/api/v3/contents/generations/tasks',
  created_at: new Date(0).toISOString(),
});

void test('acquisition: 无获取策略时不适用，且不发任何请求', async (t) => {
  const upstream = stubFetch(t, () => jsonResponse({}));
  const outcome = await maybeRunResultAcquisition(buildRecord({ strategy: null }));
  assert.equal(outcome.kind, 'not_applicable');
  assert.equal(upstream.calls.length, 0);
});

void test('acquisition: identity 路径未命中直接收口失败，不回退轮询', async (t) => {
  const upstream = stubFetch(t, () => jsonResponse({}));
  const outcome = await maybeRunResultAcquisition(buildRecord({ body: { task: {} } }));
  assert.equal(outcome.kind, 'failed');
  if (outcome.kind !== 'failed') throw new Error('expected failed');
  assert.equal(outcome.code, 'task_execution_failed');
  assert.match(outcome.message, /内容标识/);
  assert.equal(upstream.calls.length, 0, 'identity 未命中不得发起最终结果请求');
});

void test('acquisition: accept=json 真发起第二次 GET 并覆盖 response.body', async (t) => {
  const upstream = stubFetch(t, () =>
    jsonResponse({ data: [{ url: 'https://cdn.example.com/out.mp4' }] }),
  );
  const record = buildRecord();
  const outcome = await maybeRunResultAcquisition(record);
  assert.equal(outcome.kind, 'acquired');
  if (outcome.kind !== 'acquired') throw new Error('expected acquired');
  const acquired = outcome.record as {
    response: { body: unknown; bodyType: unknown; status: unknown };
  };
  assert.deepEqual(acquired.response.body, {
    data: [{ url: 'https://cdn.example.com/out.mp4' }],
  });
  assert.equal(acquired.response.bodyType, 'json');
  assert.equal(acquired.response.status, 200, '原轮询响应元信息保留');
  assert.equal(upstream.calls.length, 1);
  assert.equal(upstream.calls[0]?.url, 'https://provider.example/v1/things/job_42/content');
  assert.equal(upstream.calls[0]?.method, 'GET');
  assert.equal(upstream.calls[0]?.authorization, null, 'requires_auth=false 时不带鉴权头');
});

void test('acquisition: accept=binary 只构造地址，不发请求', async (t) => {
  const upstream = stubFetch(t, () => jsonResponse({}));
  const record = buildRecord({
    strategy: {
      ...STRATEGY,
      accept: 'binary',
      media_type: 'video',
      identity_path: 'task.id',
    },
  });
  const outcome = await maybeRunResultAcquisition(record);
  assert.equal(outcome.kind, 'acquired');
  if (outcome.kind !== 'acquired') throw new Error('expected acquired');
  const acquired = outcome.record as { response: { body: Record<string, unknown> } };
  assert.equal(
    acquired.response.body[ACQUIRED_MEDIA_URL_PATH],
    'https://provider.example/v1/things/job_42/content',
  );
  assert.deepEqual(acquired.response.body['task'], { id: 'job_42' }, '原响应体字段保留');
  assert.equal(upstream.calls.length, 0, 'binary 不在获取阶段下载字节');
});

void test('acquisition: 非 2xx 收口失败并带 HTTP 状态', async (t) => {
  stubFetch(t, () => jsonResponse({ error: 'boom' }, 500));
  const outcome = await maybeRunResultAcquisition(buildRecord());
  assert.equal(outcome.kind, 'failed');
  if (outcome.kind !== 'failed') throw new Error('expected failed');
  assert.equal(outcome.code, 'task_execution_failed');
  assert.match(outcome.message, /HTTP 500/);
});

void test('acquisition: 返回非 JSON 内容收口为 invalid_json', async (t) => {
  stubFetch(t, () => new Response('not-json', { status: 200, headers: { 'content-type': 'text/plain' } }));
  const outcome = await maybeRunResultAcquisition(buildRecord());
  assert.equal(outcome.kind, 'failed');
  if (outcome.kind !== 'failed') throw new Error('expected failed');
  assert.equal(outcome.code, 'invalid_json');
});

void test('acquisition: requires_auth 按适配器声明注入 Bearer，明文不出现在记录里', async (t) => {
  const upstream = stubFetch(t, () => jsonResponse({ url: 'https://cdn.example.com/a.png' }));
  const record = buildRecord({
    strategy: {
      ...STRATEGY,
      requires_auth: true,
      identity_path: 'task.id',
    },
    metadata: { executionSnapshot: snapshotFor() },
  });
  const outcome = await maybeRunResultAcquisition(record);
  assert.equal(outcome.kind, 'acquired');
  assert.equal(upstream.calls.length, 1);
  assert.equal(upstream.calls[0]?.authorization, 'Bearer sk-acquisition-secret');
  const serialized = JSON.stringify(outcome);
  assert.equal(serialized.includes('sk-acquisition-secret'), false, '明文不得进入记录');
});

void test('acquisition: requires_auth 但凭证不可读时按可读错误收口失败', async (t) => {
  stubFetch(t, () => jsonResponse({}));
  const record = buildRecord({
    strategy: {
      ...STRATEGY,
      requires_auth: true,
      identity_path: 'task.id',
    },
    metadata: {
      executionSnapshot: {
        ...snapshotFor(),
        credential_ref: 'cred_does_not_exist',
      },
    },
  });
  const outcome = await maybeRunResultAcquisition(record);
  assert.equal(outcome.kind, 'failed');
  if (outcome.kind !== 'failed') throw new Error('expected failed');
  assert.equal(outcome.code, 'credential_missing');
  assert.match(outcome.message, /鉴权/);
});

void test('acquisition: identity_source=remote_request_id 从 metadata 读取标识', async (t) => {
  const upstream = stubFetch(t, () => jsonResponse({ ok: true }));
  const record = buildRecord({
    strategy: {
      ...STRATEGY,
      identity_source: 'remote_request_id',
      identity_path: undefined,
    },
    metadata: { remoteRequestId: 'remote_99' },
  });
  const outcome = await maybeRunResultAcquisition(record);
  assert.equal(outcome.kind, 'acquired');
  assert.equal(upstream.calls[0]?.url, 'https://provider.example/v1/things/remote_99/content');
});
