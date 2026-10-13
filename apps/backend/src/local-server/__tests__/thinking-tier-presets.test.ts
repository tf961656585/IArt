import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ChatModelCatalogResponseSchema,
  HUB_LOCAL_WRITE_TOKEN_ENV,
  HUB_LOCAL_WRITE_TOKEN_HEADER,
  ThinkingTierPoolResponseSchema,
  ThinkingTierRemovalResponseSchema,
} from '@iart/contracts';
import { createRequestHandler } from '../router.cts';
import {
  clearCacheForTest as clearCustomChatModelCache,
  getCustomChatModel,
} from '../provider-connection/custom-chat-model-store.cts';
import {
  clearCacheForTest as clearConnectionCache,
  createConnection,
  setConnectionCredential,
} from '../provider-connection/connection-store.cts';
import {
  clearCacheForTest as clearActiveRouteCache,
} from '../provider-connection/active-route-store.cts';
import { setCredentialForConnection } from '../provider-connection/credential-store.cts';
import { clearCacheForTest as clearTierCache } from '../provider-connection/thinking-tier-store.cts';

/**
 * 思考档位预设池与启用关系（spec 37「思考档位」；2026-09-25 起档位随自建对话模型记录走）。
 *
 * 覆盖：①池子读写（内置档只读、自定义档增删、非法名被拒）；②启用关系的写入校验
 * （档位必须属于池子、自定义档在协议上可表达）——入口是 PUT /api/custom-chat-models/:modelId
 * （原 PUT /api/model-deployments/:id 的档位字段随声明层合并退役）；2026-09-26 起协议归属
 * 模型级：可表达性按**记录自带的协议**校验（2026-09-29 起连接不再承载接口类型预选）；
 * ③删除自定义档的级联清理；④对话模型目录只投影「已启用且当前协议可表达」的档位。
 */

const repoRoot = path.join(__dirname, '..', '..', '..', '..', '..');
process.env['IART_MODEL_ASSET_PACKAGES_DIR'] = path.join(repoRoot, '.model-assets', 'sources');
process.env['IART_PUBLIC_UPLOAD_CLOUDFLARE_IMAGE_PUBLIC_URL_ENDPOINT'] = 'https://relay.example.invalid/upload';

const HUB_WRITE_TOKEN = 't'.repeat(32);
const CHAT_MODEL_ID = 'my-llm';
const CHAT_MODEL_ID_B = 'my-llm-b';
/** 档位字段接受自由字符串的对话协议（自定义档位可表达）。 */
const OPENAI_CHAT_ADAPTER = 'openai-chat-completions-v1';
/** 档位字段是有限枚举的对话协议（自定义档位表达不了）。 */
const GEMINI_CHAT_ADAPTER = 'gemini-chat-v1';
const CONNECTION_BASE_URL = 'https://byok.example.com/v1';
const CREDENTIAL_VALUE = 'sk-thinking-tier-key';
const CUSTOM_TIER = 'ultra';

type JsonValue = Record<string, unknown>;

const startServer = async (t: test.TestContext): Promise<string> => {
  const server = http.createServer(createRequestHandler());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  }));
  const address = server.address();
  if (address == null || typeof address === 'string') {
    throw new Error('thinking_tier_test_server_address_unavailable');
  }
  return `http://127.0.0.1:${address.port}`;
};

const withIsolatedEnv = (t: test.TestContext): void => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'thinking-tier-'));
  const previousToken = process.env[HUB_LOCAL_WRITE_TOKEN_ENV];
  const previousRoot = process.env['IART_STORAGE_ROOT'];
  process.env[HUB_LOCAL_WRITE_TOKEN_ENV] = HUB_WRITE_TOKEN;
  process.env['IART_STORAGE_ROOT'] = tempRoot;
  clearConnectionCache();
  clearActiveRouteCache();
  clearTierCache();
  clearCustomChatModelCache();
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
    clearTierCache();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
};

const writeHeaders = (withToken = true): Record<string, string> => ({
  'content-type': 'application/json',
  ...(withToken ? { [HUB_LOCAL_WRITE_TOKEN_HEADER]: HUB_WRITE_TOKEN } : {}),
});

/** 建 enabled 连接 + 凭证 + 该连接下的自建对话记录（一次写入，POST 内自动写 active route）。 */
const seedChatModel = async (baseUrl: string, protocolAdapterId: string, modelId: string): Promise<string> => {
  const connection = createConnection({
    display_name: `tier-${protocolAdapterId}-${modelId}`,
    base_url: CONNECTION_BASE_URL,
  });
  const credential = await setCredentialForConnection(connection.connection_id, CREDENTIAL_VALUE);
  assert.ok(credential, 'credential should be stored');
  setConnectionCredential(connection.connection_id, credential.credentialRef, credential.version, true);
  const created = await fetch(`${baseUrl}/api/custom-chat-models`, {
    method: 'POST',
    headers: writeHeaders(),
    body: JSON.stringify({
      model_id: modelId,
      connection_id: connection.connection_id,
      // 协议归属模型级：协议随记录走（连接不再承载接口类型，2026-09-29 起）
      protocol_adapter_id: protocolAdapterId,
    }),
  });
  assert.equal(created.status, 200, '自建对话记录应创建成功');
  return connection.connection_id;
};

const readPool = async (baseUrl: string): Promise<{ builtin: string[]; custom: Array<{ name: string; used_by_models: number }> }> => {
  const response = await fetch(`${baseUrl}/api/thinking-tiers`);
  assert.equal(response.status, 200);
  return ThinkingTierPoolResponseSchema.parse(await response.json()).pool;
};

const addCustomTier = async (baseUrl: string, name: string): Promise<Response> =>
  fetch(`${baseUrl}/api/thinking-tiers`, {
    method: 'POST',
    headers: writeHeaders(),
    body: JSON.stringify({ name }),
  });

/** 档位启用关系入口：PUT /api/custom-chat-models/:modelId（能力两字段 + 档位两字段整体替换）。 */
const setTiers = async (
  baseUrl: string,
  modelId: string,
  enabledThinkingTiers: string[],
  defaultThinkingTier: string | null = null,
): Promise<{ status: number; payload: JsonValue }> => {
  const response = await fetch(`${baseUrl}/api/custom-chat-models/${modelId}`, {
    method: 'PUT',
    headers: writeHeaders(),
    body: JSON.stringify({
      context_window_tokens: 128000,
      max_output_tokens: null,
      enabled_thinking_tiers: enabledThinkingTiers,
      default_thinking_tier: defaultThinkingTier,
    }),
  });
  return { status: response.status, payload: (await response.json()) as JsonValue };
};

void test('思考档位：池子内置档只读、自定义档可增删，非法名被拒', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await startServer(t);

  const initial = await readPool(baseUrl);
  assert.deepEqual(initial.builtin, ['minimal', 'low', 'medium', 'high']);
  assert.deepEqual(initial.custom, []);

  assert.equal((await addCustomTier(baseUrl, CUSTOM_TIER)).status, 200);
  const afterAdd = await readPool(baseUrl);
  assert.deepEqual(afterAdd.custom, [{ name: CUSTOM_TIER, used_by_models: 0 }]);

  // 重名 / 与内置档或「不思考」冲突 → 409
  assert.equal((await addCustomTier(baseUrl, CUSTOM_TIER)).status, 409);
  assert.equal((await addCustomTier(baseUrl, 'low')).status, 409);
  assert.equal((await addCustomTier(baseUrl, 'off')).status, 409);
  // 非法名（空、含空格、超长）→ 400
  assert.equal((await addCustomTier(baseUrl, '')).status, 400);
  assert.equal((await addCustomTier(baseUrl, 'a b')).status, 400);
  assert.equal((await addCustomTier(baseUrl, 'x'.repeat(33))).status, 400);

  const removal = await fetch(`${baseUrl}/api/thinking-tiers/${CUSTOM_TIER}`, {
    method: 'DELETE',
    headers: writeHeaders(),
  });
  assert.equal(removal.status, 200);
  assert.equal(ThinkingTierRemovalResponseSchema.parse(await removal.json()).removed_from_models, 0);
  assert.deepEqual((await readPool(baseUrl)).custom, []);
});

void test('思考档位：创建记录时携带档位一次落库（POST 请求体承载档位）', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await startServer(t);
  assert.equal((await addCustomTier(baseUrl, CUSTOM_TIER)).status, 200);
  const openaiConnectionId = await seedChatModel(baseUrl, OPENAI_CHAT_ADAPTER, CHAT_MODEL_ID);

  // 创建时显式携带档位：随记录一次落库，目录立即投影（添加即可用含档位维度）
  const created = await fetch(`${baseUrl}/api/custom-chat-models`, {
    method: 'POST',
    headers: writeHeaders(),
    body: JSON.stringify({
      model_id: CHAT_MODEL_ID_B,
      connection_id: openaiConnectionId,
      protocol_adapter_id: OPENAI_CHAT_ADAPTER,
      enabled_thinking_tiers: ['low', CUSTOM_TIER],
      default_thinking_tier: CUSTOM_TIER,
    }),
  });
  assert.equal(created.status, 200);
  const record = getCustomChatModel(CHAT_MODEL_ID_B);
  assert.ok(record);
  assert.deepEqual(record.enabled_thinking_tiers, ['low', CUSTOM_TIER]);
  assert.equal(record.default_thinking_tier, CUSTOM_TIER);
  const catalog = ChatModelCatalogResponseSchema.parse(
    await (await fetch(`${baseUrl}/api/chat-model-catalog`)).json(),
  );
  const entry = catalog.models.find((item) => item.model_id === CHAT_MODEL_ID_B);
  assert.ok(entry);
  assert.deepEqual(entry.thinking_tiers, ['low', CUSTOM_TIER]);
  assert.equal(entry.default_thinking_tier, CUSTOM_TIER);
});

void test('思考档位：写路由受 Hub write token 保护', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await startServer(t);

  const response = await fetch(`${baseUrl}/api/thinking-tiers`, {
    method: 'POST',
    headers: writeHeaders(false),
    body: JSON.stringify({ name: CUSTOM_TIER }),
  });
  assert.equal(response.status, 403);
});

void test('思考档位：启用关系写入校验——未知档位、协议表达不了的自定义档位被拒', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await startServer(t);
  await seedChatModel(baseUrl, OPENAI_CHAT_ADAPTER, CHAT_MODEL_ID);
  await seedChatModel(baseUrl, GEMINI_CHAT_ADAPTER, CHAT_MODEL_ID_B);

  // 内置档位：可用
  const builtin = await setTiers(baseUrl, CHAT_MODEL_ID, ['low', 'high']);
  assert.equal(builtin.status, 200);
  assert.deepEqual(
    (builtin.payload['model'] as JsonValue)['enabled_thinking_tiers'],
    ['low', 'high'],
  );

  // 池子里没有的档位：拒绝
  const unknown = await setTiers(baseUrl, CHAT_MODEL_ID, ['definitely-not-a-tier']);
  assert.equal(unknown.status, 400);
  assert.match(String(unknown.payload['message']), /思考档位/);

  // 记录自带协议（gemini）的档位字段是有限枚举，自定义档位表达不了：拒绝
  assert.equal((await addCustomTier(baseUrl, CUSTOM_TIER)).status, 200);
  const inexpressible = await setTiers(baseUrl, CHAT_MODEL_ID_B, [CUSTOM_TIER]);
  assert.equal(inexpressible.status, 400);
  assert.match(String(inexpressible.payload['message']), /表达不了/);

  // 同一自定义档位在 OpenAI 系协议上可用
  const expressible = await setTiers(baseUrl, CHAT_MODEL_ID, [CUSTOM_TIER]);
  assert.equal(expressible.status, 200);
  assert.deepEqual(
    (expressible.payload['model'] as JsonValue)['enabled_thinking_tiers'],
    [CUSTOM_TIER],
  );
});

void test('思考档位：删除自定义档位会级联清掉引用它的记录启用关系', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await startServer(t);
  await seedChatModel(baseUrl, OPENAI_CHAT_ADAPTER, CHAT_MODEL_ID);
  assert.equal((await addCustomTier(baseUrl, CUSTOM_TIER)).status, 200);

  const bound = await setTiers(baseUrl, CHAT_MODEL_ID, ['low', CUSTOM_TIER], CUSTOM_TIER);
  assert.equal(bound.status, 200);

  const poolBeforeRemoval = await readPool(baseUrl);
  assert.equal(poolBeforeRemoval.custom[0]?.used_by_models, 1);

  const removal = await fetch(`${baseUrl}/api/thinking-tiers/${CUSTOM_TIER}`, {
    method: 'DELETE',
    headers: writeHeaders(),
  });
  assert.equal(removal.status, 200);
  assert.equal(ThinkingTierRemovalResponseSchema.parse(await removal.json()).removed_from_models, 1);

  const record = getCustomChatModel(CHAT_MODEL_ID);
  assert.ok(record, 'record should still exist');
  assert.deepEqual(record.enabled_thinking_tiers, ['low'], '只摘掉被删除的档位，其余保留');
  assert.equal(record.default_thinking_tier, null, '默认档位指向被删除的档位时一并清空');
});

/**
 * 池子的 `used_by_models` 与删除回执的 `removed_from_models` 都是**模型数**。
 *
 * 启用关系随自建对话模型记录走（spec 37 v4.0.0）：每个记录的 model_id 全局唯一，
 * 记录数即模型数。界面说的是「几个模型会失去这个档位」。
 */
void test('思考档位：影响面按模型数计——两个记录各启用同一档位记 2', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await startServer(t);
  await seedChatModel(baseUrl, OPENAI_CHAT_ADAPTER, CHAT_MODEL_ID);
  await seedChatModel(baseUrl, OPENAI_CHAT_ADAPTER, CHAT_MODEL_ID_B);
  assert.equal((await addCustomTier(baseUrl, CUSTOM_TIER)).status, 200);

  assert.equal((await setTiers(baseUrl, CHAT_MODEL_ID, [CUSTOM_TIER])).status, 200);
  assert.equal((await setTiers(baseUrl, CHAT_MODEL_ID_B, [CUSTOM_TIER])).status, 200);

  assert.equal(
    (await readPool(baseUrl)).custom[0]?.used_by_models,
    2,
    '两个模型各启用一次，池子按模型数计',
  );

  const removal = await fetch(`${baseUrl}/api/thinking-tiers/${CUSTOM_TIER}`, {
    method: 'DELETE',
    headers: writeHeaders(),
  });
  assert.equal(removal.status, 200);
  assert.equal(ThinkingTierRemovalResponseSchema.parse(await removal.json()).removed_from_models, 2);
});

void test('思考档位：默认档位必须落在启用列表里，写入侧归一化', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await startServer(t);
  await seedChatModel(baseUrl, OPENAI_CHAT_ADAPTER, CHAT_MODEL_ID);

  // 默认档位不在启用列表 → 清空（不报错、不留下一条指向未启用档位的默认）
  const mismatched = await setTiers(baseUrl, CHAT_MODEL_ID, ['low'], 'high');
  assert.equal(mismatched.status, 200);
  assert.equal((mismatched.payload['model'] as JsonValue)['default_thinking_tier'], null);

  // 更新：把默认档位设进启用列表
  const setDefault = await setTiers(baseUrl, CHAT_MODEL_ID, ['low', 'high'], 'high');
  assert.equal(setDefault.status, 200);
  assert.equal(getCustomChatModel(CHAT_MODEL_ID)?.default_thinking_tier, 'high');

  // 更新：把默认档位移出启用列表 → 跟着清空
  const dropTier = await setTiers(baseUrl, CHAT_MODEL_ID, ['low']);
  assert.equal(dropTier.status, 200);
  assert.equal(getCustomChatModel(CHAT_MODEL_ID)?.default_thinking_tier, null, '档位被摘掉后默认不再指向它');

  // 更新：显式传 null = 取消默认
  const clearDefault = await setTiers(baseUrl, CHAT_MODEL_ID, ['low'], null);
  assert.equal(clearDefault.status, 200);
  assert.equal(getCustomChatModel(CHAT_MODEL_ID)?.default_thinking_tier, null);
});

void test('思考档位：对话目录只投影该记录已启用且当前协议（记录自带）可表达的档位', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await startServer(t);
  await seedChatModel(baseUrl, OPENAI_CHAT_ADAPTER, CHAT_MODEL_ID);
  await seedChatModel(baseUrl, GEMINI_CHAT_ADAPTER, CHAT_MODEL_ID_B);
  assert.equal((await addCustomTier(baseUrl, CUSTOM_TIER)).status, 200);

  // 尚未启用任何档位时没有可选档位
  const beforeBinding = ChatModelCatalogResponseSchema.parse(
    await (await fetch(`${baseUrl}/api/chat-model-catalog`)).json(),
  );
  const beforeEntry = beforeBinding.models.find((entry) => entry.model_id === CHAT_MODEL_ID);
  assert.ok(beforeEntry, 'chat catalog should contain the custom chat model');
  assert.deepEqual(beforeEntry.thinking_tiers, []);

  const bound = await setTiers(baseUrl, CHAT_MODEL_ID, ['low', CUSTOM_TIER]);
  assert.equal(bound.status, 200);

  const enabledCatalog = ChatModelCatalogResponseSchema.parse(
    await (await fetch(`${baseUrl}/api/chat-model-catalog`)).json(),
  );
  const enabledEntry = enabledCatalog.models.find((entry) => entry.model_id === CHAT_MODEL_ID);
  assert.ok(enabledEntry);
  assert.deepEqual(enabledEntry.thinking_tiers, ['low', CUSTOM_TIER]);
  assert.equal(enabledEntry.default_thinking_tier, null, '没设默认时投影 null');

  // 记录自带协议是枚举值域协议（gemini）时，自定义档位写不进去，目录里也只投影内置档
  const geminiBound = await setTiers(baseUrl, CHAT_MODEL_ID_B, [CUSTOM_TIER]);
  assert.equal(geminiBound.status, 400, 'gemini 协议的记录表达不了自定义档位（写入侧按记录协议拒绝）');
  const geminiEntry = (await ChatModelCatalogResponseSchema.parse(
    await (await fetch(`${baseUrl}/api/chat-model-catalog`)).json(),
  )).models.find((entry) => entry.model_id === CHAT_MODEL_ID_B);
  assert.ok(geminiEntry);
  assert.deepEqual(geminiEntry.thinking_tiers, [], 'gemini 记录未启用任何可表达档位，目录为空');

  // 默认档位落在协议表达不了的档位上时按写入侧归一化清空：创作面不会预选一个发不出去的档位
  const asCustom = await setTiers(baseUrl, CHAT_MODEL_ID, ['low'], CUSTOM_TIER);
  assert.equal(asCustom.status, 200, '启用列表里只有可表达的内置档位，写入放行');
  assert.equal(getCustomChatModel(CHAT_MODEL_ID)?.default_thinking_tier, null, '默认档位不落在启用列表内时被归一化清空');
});

void test('思考档位：默认档位随目录投影，且只投影当前可选的档位', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await startServer(t);
  await seedChatModel(baseUrl, OPENAI_CHAT_ADAPTER, CHAT_MODEL_ID);

  const bound = await setTiers(baseUrl, CHAT_MODEL_ID, ['low', 'high'], 'high');
  assert.equal(bound.status, 200);

  const projected = ChatModelCatalogResponseSchema.parse(
    await (await fetch(`${baseUrl}/api/chat-model-catalog`)).json(),
  );
  const entry = projected.models.find((item) => item.model_id === CHAT_MODEL_ID);
  assert.ok(entry);
  assert.deepEqual(entry.thinking_tiers, ['low', 'high']);
  assert.equal(entry.default_thinking_tier, 'high');

  // 默认档位被移出启用列表后，目录里也不再有它
  await setTiers(baseUrl, CHAT_MODEL_ID, ['low']);
  const after = ChatModelCatalogResponseSchema.parse(
    await (await fetch(`${baseUrl}/api/chat-model-catalog`)).json(),
  );
  const afterEntry = after.models.find((item) => item.model_id === CHAT_MODEL_ID);
  assert.ok(afterEntry);
  assert.equal(afterEntry.default_thinking_tier, null);
});
