import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createRequestHandler } from '../router.cts';
import {
  createConnection,
  setConnectionCredential,
  clearCacheForTest as clearConnectionCache,
} from '../provider-connection/connection-store.cts';
import {
  addCustomGenerationModel,
  clearCacheForTest as clearCustomGenerationModelCache,
} from '../provider-connection/custom-generation-model-store.cts';
import {
  setActiveDeployment,
  clearCacheForTest as clearActiveRouteCache,
} from '../provider-connection/active-route-store.cts';
import { releaseLease, setCredentialForConnection } from '../provider-connection/credential-store.cts';
import { __test_only__ as skillProxyTestOnly } from '../routes/skill-proxy-routes.cts';

/**
 * skill 代理的端点与鉴权来自「模型 active 接入目标的服务商连接」——与任务主链同源。
 *
 * 覆盖范围说明：`ProviderConnection.base_url` 被契约限定为 `https://`，而本测试环境没有
 * https mock（仓库无自签证书 fixture），所以转发链路（body 原样、multipart boundary 保留、
 * 上游状态原样回传）无法用真实连接覆盖；其代码路径本次只改了端点与鉴权头来源。
 * 因此这里覆盖：①解析逻辑本身；②鉴权与信任边界（Origin / 白名单 / 运行头缺失）；
 * ③未接入服务商时的阻断路径。
 */

type JsonValue = Record<string, unknown>;

const SKILL_MODEL_ID = 'gpt-image-2';
const CONNECTION_BASE_URL = 'https://byok.example.com/v1';
const CREDENTIAL_VALUE = 'sk-skill-proxy-key';

const startServer = async () => {
  const server = http.createServer(createRequestHandler());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address == null || typeof address === 'string') {
    throw new Error('skill_proxy_server_address_unavailable');
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
};

const resetStores = (): void => {
  clearConnectionCache();
  clearCustomGenerationModelCache();
  clearActiveRouteCache();
};

/** 每个测试用独立临时存储根，隔离服务商连接 / 模型记录 / active 路由。 */
const withIsolatedRoots = (t: test.TestContext): void => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-proxy-test-'));
  const previousRoot = process.env['IART_STORAGE_ROOT'];
  process.env['IART_STORAGE_ROOT'] = tempRoot;
  resetStores();
  t.after(() => {
    if (previousRoot === undefined) {
      delete process.env['IART_STORAGE_ROOT'];
    } else {
      process.env['IART_STORAGE_ROOT'] = previousRoot;
    }
    resetStores();
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // ignore cleanup failure
    }
  });
};

/**
 * 建 enabled 连接 + 凭证 + 该模型的用户记录，并设为 active。
 *
 * 2026-10-19 起模型只有用户记录一种载体（spec 03 §6.1 / PC-14）：不再有独立的接入对象可建，
 * 记录本身就是接入目标（`record_id`）。本测试断言的是「skill 代理从模型的 active 接入目标解析
 * 端点与鉴权」这条真实链路，换成记录播种后该语义不变。
 */
const seedActiveModelRecord = async (): Promise<void> => {
  const connection = createConnection({
    display_name: 'skill-proxy-test',
    base_url: CONNECTION_BASE_URL,
  });
  const credential = await setCredentialForConnection(connection.connection_id, CREDENTIAL_VALUE);
  assert.ok(credential, 'credential should be stored');
  setConnectionCredential(connection.connection_id, credential.credentialRef, credential.version, true);
  const record = addCustomGenerationModel({
    model_id: SKILL_MODEL_ID,
    connection_id: connection.connection_id,
    remote_model_id: SKILL_MODEL_ID,
    family_adapter_id: 'openai-image-v1',
  });
  assert.equal(record.ok, true, 'generation model record should be created');
  if (!record.ok) return;
  assert.equal(setActiveDeployment(SKILL_MODEL_ID, record.model.record_id), record.model.record_id);
};

const parseJson = async (response: FetchableResponse): Promise<JsonValue> => {
  return response.json() as Promise<JsonValue>;
};

type FetchableResponse = Response;

void test('skill-proxy: resolveSkillUpstream 从模型的服务商连接解析端点与鉴权头', async (t) => {
  withIsolatedRoots(t);
  await seedActiveModelRecord();

  const upstream = await skillProxyTestOnly.resolveSkillUpstream(SKILL_MODEL_ID);

  assert.ok(upstream, 'upstream should resolve from the active access target');
  assert.equal(upstream.baseUrl, CONNECTION_BASE_URL);
  assert.equal(upstream.authHeaderName.toLowerCase(), 'authorization');
  assert.match(upstream.authHeaderValue, new RegExp(CREDENTIAL_VALUE));
  releaseLease(upstream.leaseId);
});

void test('skill-proxy: resolveSkillUpstream 在未接入服务商时返回 null', async (t) => {
  withIsolatedRoots(t);

  assert.equal(await skillProxyTestOnly.resolveSkillUpstream(SKILL_MODEL_ID), null);
});

void test('skill-proxy: 未接入服务商时返回 503 而不是转发', async (t) => {
  withIsolatedRoots(t);
  const backend = await startServer();
  t.after(async () => {
    await new Promise<void>((resolve) => backend.server.close(() => resolve()));
  });

  const response = await fetch(`${backend.baseUrl}/api/skill/images/generations`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-iart-model-id': SKILL_MODEL_ID,
    },
    body: JSON.stringify({ model: SKILL_MODEL_ID, prompt: 'x' }),
  });

  assert.equal(response.status, 503);
});

void test('skill-proxy: 带非白名单模型返回 400', async (t) => {
  withIsolatedRoots(t);
  const backend = await startServer();
  t.after(async () => {
    await new Promise<void>((resolve) => backend.server.close(() => resolve()));
  });

  const response = await fetch(`${backend.baseUrl}/api/skill/images/generations`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-iart-model-id': 'gpt-image-3',
    },
    body: JSON.stringify({ model: 'gpt-image-3', prompt: 'x' }),
  });

  assert.equal(response.status, 400);
});

void test('skill-proxy: 缺少 x-iart-model-id 头返回 400', async (t) => {
  withIsolatedRoots(t);
  const backend = await startServer();
  t.after(async () => {
    await new Promise<void>((resolve) => backend.server.close(() => resolve()));
  });

  const response = await fetch(`${backend.baseUrl}/api/skill/images/generations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: SKILL_MODEL_ID, prompt: 'x' }),
  });

  assert.equal(response.status, 400);
});

void test('skill-proxy: 带 Origin 头的请求返回 403（掐断浏览器途经）', async (t) => {
  withIsolatedRoots(t);
  const backend = await startServer();
  t.after(async () => {
    await new Promise<void>((resolve) => backend.server.close(() => resolve()));
  });

  const response = await fetch(`${backend.baseUrl}/api/skill/images/generations`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-iart-model-id': SKILL_MODEL_ID,
      origin: 'https://evil.example.com',
    },
    body: JSON.stringify({ model: SKILL_MODEL_ID, prompt: 'x' }),
  });

  assert.equal(response.status, 403);
  await parseJson(response);
});
