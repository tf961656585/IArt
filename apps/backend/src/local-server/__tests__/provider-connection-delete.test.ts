import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { HUB_LOCAL_WRITE_TOKEN_ENV, HUB_LOCAL_WRITE_TOKEN_HEADER } from '@iart/contracts';
import { createRequestHandler } from '../router.cts';
import {
  clearCacheForTest as clearConnectionCache,
  createConnection,
  getConnection,
  setConnectionCredential,
} from '../provider-connection/connection-store.cts';
import { clearCacheForTest as clearDeploymentCache } from '../provider-connection/deployment-store.cts';
import {
  clearCacheForTest as clearActiveRouteCache,
  getActiveDeploymentId,
} from '../provider-connection/active-route-store.cts';
import {
  acquireLease,
  releaseLease,
  setCredentialForConnection,
} from '../provider-connection/credential-store.cts';
import {
  getCustomChatModel,
  clearCacheForTest as clearCustomChatModelCache,
} from '../provider-connection/custom-chat-model-store.cts';
import {
  getCustomGenerationModel,
  clearCacheForTest as clearCustomGenerationModelCache,
} from '../provider-connection/custom-generation-model-store.cts';

/**
 * 删除服务商的级联语义（spec 03 §5.3 + §6.1，2026-09-18 拍板：删除即一并清理）。
 *
 * 覆盖：①还挂着接入的连接直接删成功，接入与 active 路由随连接级联清理——
 * 旧门槛「有接入必须先 retired 再删」在界面上是一条死路（Hub 没有任何地方能设 retired）；
 * ②删除连接级联删除其下全部自建记录（对话/生成两族）及其 active route——记录的接入归属
 * 内嵌 connection_id，连接不存在后无归属记录非法（spec 03 §6.1）；
 * ③有活跃凭证租约（有任务正在使用）时仍拒绝删除，租约释放后可删——任务保护门保留。
 */

const repoRoot = path.join(__dirname, '..', '..', '..', '..', '..');
process.env['IART_MODEL_ASSET_PACKAGES_DIR'] = path.join(repoRoot, '.model-assets', 'sources');
process.env['IART_PUBLIC_UPLOAD_CLOUDFLARE_IMAGE_PUBLIC_URL_ENDPOINT'] = 'https://relay.example.invalid/upload';

const HUB_WRITE_TOKEN = 'd'.repeat(32);
const CHAT_MODEL_ID = 'my-llm';
const GENERATION_MODEL_ID = 'gpt-image-my-cascade';
const CHAT_ADAPTER = 'gemini-chat-v1';
const GENERATION_ADAPTER = 'openai-image-v1';
const CONNECTION_BASE_URL = 'https://byok.example.com/v1';
const CREDENTIAL_VALUE = 'sk-delete-cascade-key';

type JsonValue = Record<string, unknown>;

const startServer = async (t: test.TestContext): Promise<string> => {
  const server = http.createServer(createRequestHandler());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  }));
  const address = server.address();
  if (address == null || typeof address === 'string') {
    throw new Error('delete_test_server_address_unavailable');
  }
  return `http://127.0.0.1:${address.port}`;
};

/** 每个测试用独立临时存储根 + Hub 写令牌，隔离连接 / 接入 / active 路由。 */
const withIsolatedEnv = (t: test.TestContext): void => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-delete-'));
  const previousToken = process.env[HUB_LOCAL_WRITE_TOKEN_ENV];
  const previousRoot = process.env['IART_STORAGE_ROOT'];
  process.env[HUB_LOCAL_WRITE_TOKEN_ENV] = HUB_WRITE_TOKEN;
  process.env['IART_STORAGE_ROOT'] = tempRoot;
  clearConnectionCache();
  clearDeploymentCache();
  clearActiveRouteCache();
  clearCustomChatModelCache();
  clearCustomGenerationModelCache();
  t.after(() => {
    if (previousToken === undefined) {
      delete process.env[HUB_LOCAL_WRITE_TOKEN_ENV];
    } else {
      process.env[HUB_LOCAL_WRITE_TOKEN_ENV] = previousToken;
    }
    if (previousRoot === undefined) {
      delete process.env['IART_STORAGE_ROOT'];
    } else {
      process.env['IART_STORAGE_ROOT'] = previousRoot;
    }
    clearConnectionCache();
    clearDeploymentCache();
    clearActiveRouteCache();
    clearCustomChatModelCache();
    clearCustomGenerationModelCache();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
};

/** 建 enabled 连接 + 凭证，返回 connection_id（连接不再承载接口类型）。 */
const seedConnection = async (label: string): Promise<string> => {
  const connection = createConnection({
    display_name: `delete-cascade-${label}`,
    base_url: CONNECTION_BASE_URL,
  });
  const credential = await setCredentialForConnection(connection.connection_id, CREDENTIAL_VALUE);
  assert.ok(credential, 'credential should be stored');
  setConnectionCredential(connection.connection_id, credential.credentialRef, credential.version, true);
  return connection.connection_id;
};

const writeHeaders = (): Record<string, string> => ({
  'content-type': 'application/json',
  [HUB_LOCAL_WRITE_TOKEN_HEADER]: HUB_WRITE_TOKEN,
});

void test('删除服务商：还挂着接入也直接删，接入与 active 路由级联清理', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await startServer(t);
  const connectionId = await seedConnection('chat');
  // 自建对话记录（一次写入，POST 内自动写 active route）
  const created = await fetch(`${baseUrl}/api/custom-chat-models`, {
    method: 'POST',
    headers: writeHeaders(),
    body: JSON.stringify({ model_id: CHAT_MODEL_ID, connection_id: connectionId, protocol_adapter_id: CHAT_ADAPTER }),
  });
  assert.equal(created.status, 200);
  assert.ok(getActiveDeploymentId(CHAT_MODEL_ID), '前置：记录创建即成为当前使用');

  const deleted = await fetch(`${baseUrl}/api/provider-connections/${connectionId}`, {
    method: 'DELETE',
    headers: writeHeaders(),
  });
  assert.equal(deleted.status, 200, '有接入也不该再要求先 retired');

  const gone = await fetch(`${baseUrl}/api/provider-connections/${connectionId}`);
  assert.equal(gone.status, 404);

  const remaining = await fetch(`${baseUrl}/api/model-deployments`);
  assert.equal(remaining.status, 200);
  const payload = (await remaining.json()) as { deployments: JsonValue[] };
  assert.equal(payload.deployments.length, 0, '接入应随连接级联清理');

  assert.equal(getActiveDeploymentId(CHAT_MODEL_ID), null, 'active 路由应随连接级联清理');
});

void test('删除服务商：级联删除其下全部自建记录（对话与生成两族）及其 active route', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await startServer(t);
  const chatConnectionId = await seedConnection('chat');
  const generationConnectionId = await seedConnection('gen');

  const chatCreated = await fetch(`${baseUrl}/api/custom-chat-models`, {
    method: 'POST',
    headers: writeHeaders(),
    body: JSON.stringify({ model_id: CHAT_MODEL_ID, connection_id: chatConnectionId, protocol_adapter_id: CHAT_ADAPTER }),
  });
  assert.equal(chatCreated.status, 200);
  const generationCreated = await fetch(`${baseUrl}/api/custom-generation-models`, {
    method: 'POST',
    headers: writeHeaders(),
    body: JSON.stringify({
      model_id: GENERATION_MODEL_ID,
      connection_id: generationConnectionId,
      family_adapter_id: GENERATION_ADAPTER,
    }),
  });
  assert.equal(generationCreated.status, 200);
  assert.ok(getActiveDeploymentId(CHAT_MODEL_ID), '前置：对话记录已成为当前使用');
  assert.ok(getActiveDeploymentId(GENERATION_MODEL_ID), '前置：生成记录已成为当前使用');

  // 删生成连接：其下的生成记录与 active route 级联清理，对话记录（挂在另一条连接）不动
  const deleteGeneration = await fetch(`${baseUrl}/api/provider-connections/${generationConnectionId}`, {
    method: 'DELETE',
    headers: writeHeaders(),
  });
  assert.equal(deleteGeneration.status, 200);
  assert.equal(getCustomGenerationModel(GENERATION_MODEL_ID), null, '该连接下的自建生成记录随连接删除');
  assert.equal(getActiveDeploymentId(GENERATION_MODEL_ID), null, '生成记录的 active route 随连接清理');
  assert.ok(getCustomChatModel(CHAT_MODEL_ID), '其他连接下的自建对话记录不受影响');
  assert.ok(getActiveDeploymentId(CHAT_MODEL_ID), '其他连接下的 active route 不受影响');

  // 删对话连接：其下的对话记录与 active route 级联清理
  const deleteChat = await fetch(`${baseUrl}/api/provider-connections/${chatConnectionId}`, {
    method: 'DELETE',
    headers: writeHeaders(),
  });
  assert.equal(deleteChat.status, 200);
  assert.equal(getCustomChatModel(CHAT_MODEL_ID), null, '该连接下的自建对话记录随连接删除');
  assert.equal(getActiveDeploymentId(CHAT_MODEL_ID), null, '对话记录的 active route 随连接清理');
});

void test('删除服务商：有任务正在使用（活跃租约）时先拒绝，租约释放后可删', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await startServer(t);
  const connectionId = await seedConnection('chat');
  const created = await fetch(`${baseUrl}/api/custom-chat-models`, {
    method: 'POST',
    headers: writeHeaders(),
    body: JSON.stringify({ model_id: CHAT_MODEL_ID, connection_id: connectionId, protocol_adapter_id: CHAT_ADAPTER }),
  });
  assert.equal(created.status, 200);

  // 直接在凭证存储上建一条活跃租约，模拟「有任务正在使用这个服务商」
  const connection = getConnection(connectionId);
  assert.ok(connection, 'connection should exist');
  assert.ok(connection.credential_ref, 'credential ref should be set');
  const lease = await acquireLease({
    connectionId,
    credentialRef: connection.credential_ref,
    credentialVersion: connection.credential_version ?? 0,
    connectionRevision: connection.revision,
  });
  assert.ok(lease, 'lease should be acquired');

  const blocked = await fetch(`${baseUrl}/api/provider-connections/${connectionId}`, {
    method: 'DELETE',
    headers: writeHeaders(),
  });
  assert.equal(blocked.status, 409, '租约未释放前物理删除必须被阻断');

  assert.equal(releaseLease(lease.lease.leaseId), true, '模拟任务终态释放租约');

  const deleted = await fetch(`${baseUrl}/api/provider-connections/${connectionId}`, {
    method: 'DELETE',
    headers: writeHeaders(),
  });
  assert.equal(deleted.status, 200, '租约释放后删除应放行');
});
