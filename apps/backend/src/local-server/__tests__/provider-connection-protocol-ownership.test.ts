import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  HUB_LOCAL_WRITE_TOKEN_ENV,
  HUB_LOCAL_WRITE_TOKEN_HEADER,
} from '@iart/contracts';
import { createRequestHandler } from '../router.cts';
import {
  clearCacheForTest as clearConnectionCache,
  createConnection,
  setConnectionCredential,
} from '../provider-connection/connection-store.cts';
import {
  clearCacheForTest as clearActiveRouteCache,
} from '../provider-connection/active-route-store.cts';
import { setCredentialForConnection } from '../provider-connection/credential-store.cts';

/**
 * 服务商连接的接入归属校验与「协议归属模型级」放行口径（spec 03 §6.1、§4.1）。
 *
 * 2026-09-26 起协议归属模型级：协议由模型记录自带（对话记录 `protocol_adapter_id` /
 * 生成记录 `family_adapter_id`），连接只承载地址与凭证（2026-09-29 起连接级
 * `protocol_adapter_id` 预选整体退役，连接不再承载接口类型）。归属校验
 * （describeConnectionOwnershipError）只看连接存在 / enabled / 有凭证——任何模型可挂任何
 * 连接；原 model-connection-compatibility 模块（跨族拒绝、409 切协议锁、读侧
 * capability_incompatible）已整体删除，本文件由 provider-connection-compatibility.test.ts
 * 改写而来：原「跨族拒绝」场景改为放行断言。
 *
 * 覆盖：①归属拒绝三态（连接不存在/未启用/无凭证）；②对话记录挂任意连接放行、生成记录挂
 * 任意连接放行（含跨族）。
 *
 * 2026-10-19 部署载体退场后，本文件删掉了原第③组（「已装包模型经 /api/model-deployments 接入
 * 任意连接放行、未知 model_id 与自建 model_id 被拒」）：那组断言的正是部署载体的写入路径，
 * 该路由已删除。它保护的行为——「连接不约束协议族、协议随模型走」——由第②组继续钉住，
 * 且现在的载体是模型记录本身，覆盖范围不减。包根环境变量随之删除（不再有按包识别族的路径）。
 */

process.env['IART_PUBLIC_UPLOAD_CLOUDFLARE_IMAGE_PUBLIC_URL_ENDPOINT'] = 'https://relay.example.invalid/upload';

const HUB_WRITE_TOKEN = 'c'.repeat(32);
const CHAT_MODEL_ID = 'my-llm';
const GENERATION_ADAPTER = 'openai-image-v1';
const CHAT_ADAPTER = 'gemini-chat-v1';
const CONNECTION_BASE_URL = 'https://byok.example.com/v1';
const CREDENTIAL_VALUE = 'sk-protocol-ownership-key';

type JsonValue = Record<string, unknown>;

const startServer = async (t: test.TestContext): Promise<string> => {
  const server = http.createServer(createRequestHandler());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  }));
  const address = server.address();
  if (address == null || typeof address === 'string') {
    throw new Error('protocol_ownership_test_server_address_unavailable');
  }
  return `http://127.0.0.1:${address.port}`;
};

/** 每个测试用独立临时存储根 + Hub 写令牌，隔离连接 / 模型记录 / active 路由。 */
const withIsolatedEnv = (t: test.TestContext): void => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'protocol-ownership-'));
  const previousToken = process.env[HUB_LOCAL_WRITE_TOKEN_ENV];
  const previousRoot = process.env['IART_STORAGE_ROOT'];
  process.env[HUB_LOCAL_WRITE_TOKEN_ENV] = HUB_WRITE_TOKEN;
  process.env['IART_STORAGE_ROOT'] = tempRoot;
  clearConnectionCache();
  clearActiveRouteCache();
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
    clearActiveRouteCache();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
};

/** 建 enabled 连接 + 凭证，返回 connection_id（连接不再承载接口类型，协议随模型记录走）。 */
const seedConnection = async (label: string): Promise<string> => {
  const connection = createConnection({
    display_name: `ownership-${label}`,
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

/** 通过自建对话模型路由创建记录（一次写入，归属校验在写入侧；协议由请求体自带）。 */
const createChatRecord = async (
  baseUrl: string,
  body: { model_id: string; connection_id: string; protocol_adapter_id?: string },
): Promise<{ status: number; payload: JsonValue }> => {
  const response = await fetch(`${baseUrl}/api/custom-chat-models`, {
    method: 'POST',
    headers: writeHeaders(),
    body: JSON.stringify({
      protocol_adapter_id: CHAT_ADAPTER,
      ...body,
    }),
  });
  return { status: response.status, payload: (await response.json()) as JsonValue };
};

const createGenerationRecord = async (
  baseUrl: string,
  body: { model_id: string; connection_id: string; family_adapter_id: string },
): Promise<{ status: number; payload: JsonValue }> => {
  const response = await fetch(`${baseUrl}/api/custom-generation-models`, {
    method: 'POST',
    headers: writeHeaders(),
    body: JSON.stringify(body),
  });
  return { status: response.status, payload: (await response.json()) as JsonValue };
};

void test('归属校验：连接不存在 / 未启用 / 无凭证仍然拒绝（协议族不再参与判定）', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await startServer(t);

  const missing = await createChatRecord(baseUrl, { model_id: 'model-missing-conn', connection_id: 'up_conn_nope' });
  assert.equal(missing.status, 400);
  assert.match(String(missing.payload['message']), /连接/);

  // disabled 连接被拒
  const disabledId = await seedConnection('disabled');
  await fetch(`${baseUrl}/api/provider-connections/${disabledId}/lifecycle`, {
    method: 'PUT',
    headers: writeHeaders(),
    body: JSON.stringify({ lifecycle: 'disabled' }),
  });
  const disabled = await createChatRecord(baseUrl, { model_id: 'model-disabled-conn', connection_id: disabledId });
  assert.equal(disabled.status, 400);
  assert.match(String(disabled.payload['message']), /启用/);

  // 无凭证连接被拒
  const noCredentialConnection = createConnection({
    display_name: 'ownership-no-credential',
    base_url: CONNECTION_BASE_URL,
  });
  const credentialless = await fetch(`${baseUrl}/api/custom-chat-models`, {
    method: 'POST',
    headers: writeHeaders(),
    body: JSON.stringify({
      model_id: 'model-no-cred',
      connection_id: noCredentialConnection.connection_id,
      protocol_adapter_id: CHAT_ADAPTER,
    }),
  });
  assert.equal(credentialless.status, 400);
  assert.match(String((await credentialless.json() as JsonValue)['message']), /密钥/);
});

void test('协议归属模型级：对话记录与生成记录可挂任意连接放行（连接不承载协议）', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await startServer(t);
  const generationConnectionId = await seedConnection('gen');
  const chatConnectionId = await seedConnection('chat');

  // 对话记录挂「生成用途」连接：归属校验只看连接状态，协议随记录走 → 放行
  const chatOnGeneration = await createChatRecord(baseUrl, {
    model_id: CHAT_MODEL_ID,
    connection_id: generationConnectionId,
    protocol_adapter_id: CHAT_ADAPTER,
  });
  assert.equal(chatOnGeneration.status, 200, '对话记录可挂在任意连接上（连接不再约束协议族）');
  const chatModel = chatOnGeneration.payload['model'] as JsonValue;
  assert.equal(chatModel['protocol_adapter_id'], CHAT_ADAPTER, '记录自带协议落库');

  // 生成记录挂「对话用途」连接：同理放行
  const generationOnChat = await createGenerationRecord(baseUrl, {
    model_id: 'my-image-cross-family',
    connection_id: chatConnectionId,
    family_adapter_id: GENERATION_ADAPTER,
  });
  assert.equal(generationOnChat.status, 200, '生成记录可挂在任意连接上（连接不再约束协议族）');
  const generationModel = generationOnChat.payload['model'] as JsonValue;
  assert.equal(generationModel['family_adapter_id'], GENERATION_ADAPTER);
});


