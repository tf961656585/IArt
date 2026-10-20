import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ChatModelCatalogResponseSchema,
  ExecutableModelCatalogResponseSchema,
} from '@iart/contracts';
import { createRequestHandler } from '../router.cts';
import {
  addCustomChatModel,
  clearCacheForTest as clearCustomModelCache,
} from '../provider-connection/custom-chat-model-store.cts';
import { addCustomGenerationModel } from '../provider-connection/custom-generation-model-store.cts';
import {
  createConnection,
  clearCacheForTest as clearConnectionCache,
  setConnectionCredential,
} from '../provider-connection/connection-store.cts';
import { setCredentialForConnection } from '../provider-connection/credential-store.cts';

/**
 * 目录端点分流（spec 03 §1 / spec 45 §1）：
 * - GET /api/chat-model-catalog 只返回用户自建声明的对话模型；
 * - GET /api/executable-model-catalog 只返回用户自建声明的生成模型（对话模型不进 PromptDock 目录）。
 *
 * 模型唯一来源是用户模型记录（spec 03 PC-15）：两个目录的入口都只认记录，不从任何内置资产取模型。
 * 因此本用例在临时存储根内自行声明对话与生成两类记录，目录内容与仓库磁盘状态无关。
 */

process.env['IART_PUBLIC_UPLOAD_CLOUDFLARE_IMAGE_PUBLIC_URL_ENDPOINT'] = 'https://relay.example.invalid/upload';

/** 自建对话模型（唯一来源），验收对象。 */
const CHAT_MODEL_IDS = ['my-llm-a', 'my-llm-b'] as const;
/** 自建生成模型：确认可执行目录由记录驱动，且生成模型不会窜进对话目录。 */
const GENERATION_MODEL_ID = 'catalog-endpoint-image';
const GENERATION_ADAPTER = 'openai-image-v1';
const CHAT_ADAPTER = 'openai-responses-v1';
const CONNECTION_BASE_URL = 'https://byok.example.com/v1';
const CREDENTIAL_VALUE = 'sk-chat-catalog-endpoint-key';

const startServer = async (t: test.TestContext): Promise<string> => {
  const server = http.createServer(createRequestHandler());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  }));
  const address = server.address();
  if (address == null || typeof address === 'string') {
    throw new Error('chat_model_catalog_route_server_address_unavailable');
  }
  return `http://127.0.0.1:${address.port}`;
};

void test('目录端点分流：对话模型只进 /api/chat-model-catalog，不进 /api/executable-model-catalog', async (t) => {
  const baseUrl = await startServer(t);
  const previousRoot = process.env['IART_STORAGE_ROOT'];
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-catalog-endpoint-'));
  process.env['IART_STORAGE_ROOT'] = tempRoot;
  clearCustomModelCache();
  clearConnectionCache();
  t.after(() => {
    if (previousRoot === undefined) delete process.env['IART_STORAGE_ROOT'];
    else process.env['IART_STORAGE_ROOT'] = previousRoot;
    clearCustomModelCache();
    clearConnectionCache();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
  // 一次写入口径：记录必须归属一条对话协议连接（连接存在 + enabled + 有凭证）
  const connection = createConnection({
    display_name: 'chat-catalog-endpoint',
    base_url: CONNECTION_BASE_URL,
  });
  const credential = await setCredentialForConnection(connection.connection_id, CREDENTIAL_VALUE);
  assert.ok(credential, 'credential should be stored');
  setConnectionCredential(connection.connection_id, credential.credentialRef, credential.version, true);
  for (const modelId of CHAT_MODEL_IDS) {
    assert.equal(
      addCustomChatModel({ model_id: modelId, connection_id: connection.connection_id, protocol_adapter_id: CHAT_ADAPTER }).ok,
      true,
      `应能添加自建模型 ${modelId}`,
    );
  }
  assert.equal(
    addCustomGenerationModel({
      model_id: GENERATION_MODEL_ID,
      connection_id: connection.connection_id,
      family_adapter_id: GENERATION_ADAPTER,
    }).ok,
    true,
    `应能添加自建生成模型 ${GENERATION_MODEL_ID}`,
  );

  const chatResponse = await fetch(`${baseUrl}/api/chat-model-catalog`);
  assert.equal(chatResponse.status, 200);
  const chatPayload = ChatModelCatalogResponseSchema.parse(await chatResponse.json());
  const chatIds = chatPayload.models.map((entry) => entry.model_id);
  for (const modelId of CHAT_MODEL_IDS) {
    assert.ok(chatIds.includes(modelId), `对话目录应包含自建对话模型 ${modelId}`);
  }
  assert.ok(!chatIds.includes(GENERATION_MODEL_ID), '生成族模型不得出现在对话目录');
  for (const entry of chatPayload.models) {
    // 对话模型没有生成参数：条目复用可执行目录形状，但参数集合为空。
    assert.deepEqual(entry.parameter_schema.fields, []);
    assert.deepEqual(entry.parameter_schema.required_fields, []);
  }

  const executableResponse = await fetch(`${baseUrl}/api/executable-model-catalog`);
  assert.equal(executableResponse.status, 200);
  const executablePayload = ExecutableModelCatalogResponseSchema.parse(await executableResponse.json());
  const executableIds = executablePayload.models.map((entry) => entry.model_id);
  for (const modelId of CHAT_MODEL_IDS) {
    assert.ok(!executableIds.includes(modelId), `可执行目录不得包含对话模型 ${modelId}`);
  }
  // 可执行目录由用户记录驱动：已声明的生成记录必须出现。
  assert.ok(executableIds.includes(GENERATION_MODEL_ID), `可执行目录应包含自建生成模型 ${GENERATION_MODEL_ID}`);
});
