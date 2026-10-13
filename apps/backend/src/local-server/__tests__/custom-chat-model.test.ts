import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ChatModelCatalogResponseSchema,
  CustomChatModelListResponseSchema,
  CustomChatModelRemovalResponseSchema,
  CustomChatModelResponseSchema,
  HUB_LOCAL_WRITE_TOKEN_ENV,
  HUB_LOCAL_WRITE_TOKEN_HEADER,
} from '@iart/contracts';
import { createRequestHandler } from '../router.cts';
import { __test_only__ as engineTestOnly } from '../chat-streaming-engine.cts';
import {
  clearCacheForTest as clearConnectionCache,
  createConnection,
  setConnectionCredential,
} from '../provider-connection/connection-store.cts';
import {
  clearCacheForTest as clearDeploymentCache,
  listDeployments,
} from '../provider-connection/deployment-store.cts';
import {
  clearCacheForTest as clearActiveRouteCache,
  getActiveDeploymentId,
  setActiveDeployment,
} from '../provider-connection/active-route-store.cts';
import {
  addCustomChatModel,
  clearCacheForTest as clearCustomModelCache,
} from '../provider-connection/custom-chat-model-store.cts';
import {
  addCustomGenerationModel,
  clearCacheForTest as clearCustomGenerationModelCache,
} from '../provider-connection/custom-generation-model-store.cts';
import { clearCacheForTest as clearTierCache } from '../provider-connection/thinking-tier-store.cts';
import { setCredentialForConnection } from '../provider-connection/credential-store.cts';

/**
 * 自建对话模型记录（spec 03 §6.1「Deployment 与自建模型记录」、spec 37 v4.0.0）。
 *
 * 2026-09-25 起「声明 + ModelDeployment 接入」两层合并为**服务商作用域单记录**：
 * 能力属性（窗口/输出上限/思考档位）与接入归属（connection_id + remote_model_id）一体，
 * 添加一次写入完成且立即成为当前使用（active route 由后端写入，保持「添加即可用」）。
 * 2026-09-26 起协议归属模型级：创建体必填 `protocol_adapter_id`（对话族），协议随记录走，
 * 连接只承载地址与凭证（连接级 `protocol_adapter_id` 已退役，2026-09-29 起连接不再承载接口类型）。
 *
 * 覆盖：① 一次写入的归属校验（连接存在、enabled、有凭证）与查重；② 档位随记录走
 * （PUT 整体替换 + 写入侧归一化，可表达性按记录自带协议）；③ 记录、active route 与目录投影
 * 三者一致（接缝）；④ 删除级联清 active route；⑤ 对话请求把记录的 remote_model_id 当线上模型名。
 */

const repoRoot = path.join(__dirname, '..', '..', '..', '..', '..');
const REAL_PACKAGES_DIR = path.join(repoRoot, '.model-assets', 'sources');
process.env['IART_MODEL_ASSET_PACKAGES_DIR'] = REAL_PACKAGES_DIR;
process.env['IART_PUBLIC_UPLOAD_CLOUDFLARE_IMAGE_PUBLIC_URL_ENDPOINT'] = 'https://relay.example.invalid/upload';

const HUB_WRITE_TOKEN = 't'.repeat(32);
/* 已装生成模型的中性 id：不属于任何封闭生成族，用来验证「自建模型不得与已装模型重名」。 */
const INSTALLED_GENERATION_MODEL_ID = 'z-image-turbo';
const CHAT_ADAPTER = 'openai-responses-v1';
const GENERATION_ADAPTER = 'openai-image-v1';
const CONNECTION_BASE_URL = 'https://byok.example.com/v1';
const CREDENTIAL_VALUE = 'sk-custom-chat-model-key';
const CUSTOM_MODEL_ID = 'my-llm';
const CUSTOM_MODEL_WINDOW = 300000;
const REMOTE_MODEL_ID = 'upstream-real-model';

type JsonValue = Record<string, unknown>;

const startServer = async (t: test.TestContext): Promise<string> => {
  const server = http.createServer(createRequestHandler());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  }));
  const address = server.address();
  if (address == null || typeof address === 'string') {
    throw new Error('custom_chat_model_test_server_address_unavailable');
  }
  return `http://127.0.0.1:${address.port}`;
};

const clearAllCaches = (): void => {
  clearConnectionCache();
  clearDeploymentCache();
  clearActiveRouteCache();
  clearCustomModelCache();
  clearCustomGenerationModelCache();
  clearTierCache();
};

const withIsolatedEnv = (t: test.TestContext): void => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-chat-model-'));
  const previousToken = process.env[HUB_LOCAL_WRITE_TOKEN_ENV];
  const previousRoot = process.env['IART_STORAGE_ROOT'];
  process.env[HUB_LOCAL_WRITE_TOKEN_ENV] = HUB_WRITE_TOKEN;
  process.env['IART_STORAGE_ROOT'] = tempRoot;
  clearAllCaches();
  t.after(() => {
    if (previousToken === undefined) delete process.env[HUB_LOCAL_WRITE_TOKEN_ENV];
    else process.env[HUB_LOCAL_WRITE_TOKEN_ENV] = previousToken;
    if (previousRoot === undefined) delete process.env['IART_STORAGE_ROOT'];
    else process.env['IART_STORAGE_ROOT'] = previousRoot;
    process.env['IART_MODEL_ASSET_PACKAGES_DIR'] = REAL_PACKAGES_DIR;
    clearAllCaches();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
};

const writeHeaders = (withToken = true): Record<string, string> => ({
  'content-type': 'application/json',
  ...(withToken ? { [HUB_LOCAL_WRITE_TOKEN_HEADER]: HUB_WRITE_TOKEN } : {}),
});

/** 建 enabled 连接 + 凭证，返回 connection_id。 */
const seedConnection = async (protocolAdapterId: string, withCredential = true): Promise<string> => {
  const connection = createConnection({
    display_name: `custom-model-provider-${protocolAdapterId}`,
    base_url: CONNECTION_BASE_URL,
  });
  if (withCredential) {
    const credential = await setCredentialForConnection(connection.connection_id, CREDENTIAL_VALUE);
    assert.ok(credential, 'credential should be stored');
    setConnectionCredential(connection.connection_id, credential.credentialRef, credential.version, true);
  }
  return connection.connection_id;
};

const addCustomModel = async (
  baseUrl: string,
  body: Record<string, unknown>,
  withToken = true,
): Promise<Response> =>
  fetch(`${baseUrl}/api/custom-chat-models`, {
    method: 'POST',
    headers: writeHeaders(withToken),
    body: JSON.stringify(body),
  });

const readChatCatalog = async (baseUrl: string) =>
  ChatModelCatalogResponseSchema.parse(await (await fetch(`${baseUrl}/api/chat-model-catalog`)).json());

void test('自建对话模型：一次写入完成归属与能力，立即成为当前使用（接缝：记录 × active route × 目录一致）', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await startServer(t);
  const connectionId = await seedConnection(CHAT_ADAPTER);

  const empty = CustomChatModelListResponseSchema.parse(
    await (await fetch(`${baseUrl}/api/custom-chat-models`)).json(),
  );
  assert.deepEqual(empty.models, []);

  // 省略 remote_model_id：回落 model_id；省略上下文窗口：落缺省常量；协议随记录必填
  const created = await addCustomModel(baseUrl, {
    model_id: CUSTOM_MODEL_ID,
    connection_id: connectionId,
    protocol_adapter_id: CHAT_ADAPTER,
    context_window_tokens: CUSTOM_MODEL_WINDOW,
  });
  assert.equal(created.status, 200);
  const createdModel = CustomChatModelResponseSchema.parse(await created.json()).model;
  assert.equal(createdModel.model_id, CUSTOM_MODEL_ID);
  assert.equal(createdModel.connection_id, connectionId);
  assert.equal(createdModel.protocol_adapter_id, CHAT_ADAPTER, '协议随记录落库');
  assert.equal(createdModel.remote_model_id, CUSTOM_MODEL_ID, 'remote_model_id 缺省回落 model_id');
  assert.match(createdModel.record_id, /^up_dep_[a-z0-9][a-z0-9-_]*$/, 'record_id 用接入记录 id 空间');
  assert.equal(createdModel.context_window_tokens, CUSTOM_MODEL_WINDOW);
  assert.equal(createdModel.max_output_tokens, null);
  assert.deepEqual(createdModel.enabled_thinking_tiers, []);
  assert.equal(createdModel.default_thinking_tier, null);

  // 接缝一致：active route 已指向该记录
  assert.equal(getActiveDeploymentId(CUSTOM_MODEL_ID), createdModel.record_id);
  // 接缝一致：目录投影把该模型标成可提交（无内置包 deployment 介入）
  const catalog = readChatCatalog(baseUrl);
  const entry = (await catalog).models.find((item) => item.model_id === CUSTOM_MODEL_ID);
  assert.ok(entry, '自建模型应出现在对话目录里');
  assert.equal(entry.deployment.deployable, true);
  assert.equal(entry.deployment.failure_code, 'none');
  assert.equal(entry.deployment.active_deployment_id, createdModel.record_id);
  assert.deepEqual(entry.capability.input_modalities, ['text']);
  assert.deepEqual(entry.capability.output_modalities, ['text']);
  assert.deepEqual(entry.parameter_schema.fields, []);

  // 落盘形状：模型记录文件 version 3（v3 起记录自带 protocol_adapter_id），deployment store 不再产生自建链记录
  const storageRoot = process.env['IART_STORAGE_ROOT'];
  assert.ok(storageRoot);
  const onDisk: unknown = JSON.parse(
    fs.readFileSync(path.join(storageRoot, 'config', 'custom-chat-models.json'), 'utf-8'),
  );
  assert.equal((onDisk as { version: number }).version, 3);
  assert.deepEqual(listDeployments().filter((deployment) => deployment.model_id === CUSTOM_MODEL_ID), []);

  // 重名（自己）→ 409
  assert.equal(
    (await addCustomModel(baseUrl, { model_id: CUSTOM_MODEL_ID, connection_id: connectionId, protocol_adapter_id: CHAT_ADAPTER })).status,
    409,
  );
  // 与已装模型重名 → 409（model_id 全局唯一，生成模型的名字同样不能占用）
  assert.equal(
    (await addCustomModel(baseUrl, { model_id: INSTALLED_GENERATION_MODEL_ID, connection_id: connectionId, protocol_adapter_id: CHAT_ADAPTER })).status,
    409,
  );
  // 落在生成族命名空间内 → 409（否则会被生成链路识别为生成模型）
  assert.equal(
    (await addCustomModel(baseUrl, { model_id: 'gpt-image-3', connection_id: connectionId, protocol_adapter_id: CHAT_ADAPTER })).status,
    409,
  );
  // 非法名 → 400
  assert.equal(
    (await addCustomModel(baseUrl, { model_id: 'a b', connection_id: connectionId, protocol_adapter_id: CHAT_ADAPTER })).status,
    400,
  );
  assert.equal((await addCustomModel(baseUrl, { model_id: '', protocol_adapter_id: CHAT_ADAPTER })).status, 400);
  // 缺 connection_id → 400（归属必填）
  assert.equal((await addCustomModel(baseUrl, { model_id: 'no-connection-model', protocol_adapter_id: CHAT_ADAPTER })).status, 400);
  // 缺 protocol_adapter_id → 400（协议随记录必填，2026-09-26 起协议归属模型级）
  assert.equal((await addCustomModel(baseUrl, { model_id: 'no-protocol-model', connection_id: connectionId })).status, 400);
});

void test('自建对话模型：归属校验——连接不存在 / 未启用 / 无凭证被拒；协议族不再约束（生成协议连接放行）', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await startServer(t);

  const missing = await addCustomModel(baseUrl, { model_id: 'model-missing-conn', connection_id: 'up_conn_nope', protocol_adapter_id: CHAT_ADAPTER });
  assert.equal(missing.status, 400);
  assert.match(String((await missing.json() as JsonValue)['message']), /连接/);

  // disabled 连接被拒
  const disabledId = await seedConnection(CHAT_ADAPTER);
  await fetch(`${baseUrl}/api/provider-connections/${disabledId}/lifecycle`, {
    method: 'PUT',
    headers: writeHeaders(),
    body: JSON.stringify({ lifecycle: 'disabled' }),
  });
  assert.equal(
    (await addCustomModel(baseUrl, { model_id: 'model-disabled-conn', connection_id: disabledId, protocol_adapter_id: CHAT_ADAPTER })).status,
    400,
  );

  // 无凭证连接被拒
  const noCredentialId = await seedConnection(CHAT_ADAPTER, false);
  assert.equal(
    (await addCustomModel(baseUrl, { model_id: 'model-no-cred', connection_id: noCredentialId, protocol_adapter_id: CHAT_ADAPTER })).status,
    400,
  );

  // 生成协议连接放行（2026-09-26 起协议归属模型级：连接不再约束协议族，协议随记录走）
  const generationConnectionId = await seedConnection(GENERATION_ADAPTER);
  const crossFamily = await addCustomModel(baseUrl, {
    model_id: 'model-cross-family',
    connection_id: generationConnectionId,
    protocol_adapter_id: CHAT_ADAPTER,
  });
  assert.equal(crossFamily.status, 200, '对话记录可挂在生成协议连接上（连接不再约束协议族）');
  assert.equal(
    CustomChatModelResponseSchema.parse(await crossFamily.json()).model.protocol_adapter_id,
    CHAT_ADAPTER,
    '记录自带协议落库',
  );
});

void test('自建对话模型：显式 remote_model_id 落库并在对话请求中充当线上模型名，能力取记录本身', async (t) => {
  withIsolatedEnv(t);
  const { resolveChatModelConfig, resolveChatModelCapability } = engineTestOnly;
  const connectionId = await seedConnection(CHAT_ADAPTER);

  const declared = addCustomChatModel({
    model_id: CUSTOM_MODEL_ID,
    connection_id: connectionId,
    protocol_adapter_id: CHAT_ADAPTER,
    remote_model_id: REMOTE_MODEL_ID,
    context_window_tokens: CUSTOM_MODEL_WINDOW,
    max_output_tokens: 4096,
  });
  assert.ok(declared.ok, 'record should be accepted by the real store');
  // store 直连不含路由编排：active route 按生产语义单独写入（路由 POST 内做同一步）
  assert.equal(setActiveDeployment(CUSTOM_MODEL_ID, declared.model.record_id), declared.model.record_id);
  const config = await resolveChatModelConfig(CUSTOM_MODEL_ID, undefined);
  assert.equal(config.apiModelName, REMOTE_MODEL_ID, '线上模型名取记录的 remote_model_id，不取产品 model_id');
  assert.equal(config.contextWindowTokens, CUSTOM_MODEL_WINDOW, '窗口取记录');
  assert.equal(config.maxOutputTokens, 4096, '输出上限取记录');

  // 记录未声明输出上限：null 在能力层收敛成 undefined（= 不发该参数）
  const declaredWithoutCap = addCustomChatModel({
    model_id: 'no-output-cap-model',
    connection_id: connectionId,
    protocol_adapter_id: CHAT_ADAPTER,
  });
  assert.ok(declaredWithoutCap.ok);
  assert.equal(
    setActiveDeployment('no-output-cap-model', declaredWithoutCap.model.record_id),
    declaredWithoutCap.model.record_id,
  );
  assert.equal((await resolveChatModelConfig('no-output-cap-model', undefined)).maxOutputTokens, undefined);

  // 没有记录即不是一个模型：显式失败，不按名称推断一份能力。
  assert.throws(() => resolveChatModelCapability('ghost-model'), /no declaration source/);
});

void test('自建对话模型：能力两字段 + 档位两字段整体替换；默认档位不落在启用档位内按写入侧归一化清空', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await startServer(t);
  const connectionId = await seedConnection(CHAT_ADAPTER);

  assert.equal(
    (await addCustomModel(baseUrl, { model_id: CUSTOM_MODEL_ID, connection_id: connectionId, protocol_adapter_id: CHAT_ADAPTER, max_output_tokens: 8192 })).status,
    200,
  );

  const put = (body: unknown): Promise<Response> =>
    fetch(`${baseUrl}/api/custom-chat-models/${CUSTOM_MODEL_ID}`, {
      method: 'PUT',
      headers: writeHeaders(),
      body: JSON.stringify(body),
    });
  const readModel = async (response: Response) =>
    CustomChatModelResponseSchema.parse(await response.json()).model;

  // 整体替换：能力两字段 + 档位两字段
  const updated = await put({
    context_window_tokens: 64000,
    max_output_tokens: 4096,
    enabled_thinking_tiers: ['low', 'high'],
    default_thinking_tier: 'high',
  });
  assert.equal(updated.status, 200);
  const updatedModel = await readModel(updated);
  assert.equal(updatedModel.context_window_tokens, 64000);
  assert.equal(updatedModel.max_output_tokens, 4096);
  assert.deepEqual(updatedModel.enabled_thinking_tiers, ['low', 'high']);
  assert.equal(updatedModel.default_thinking_tier, 'high');

  // 归一化：默认档位不在启用列表内 → 清空为 null（不拒绝整条）
  const normalized = await put({
    context_window_tokens: 64000,
    max_output_tokens: 4096,
    enabled_thinking_tiers: ['low'],
    default_thinking_tier: 'high',
  });
  assert.equal(normalized.status, 200);
  assert.equal((await readModel(normalized)).default_thinking_tier, null);

  // 清空输出上限：显式传 null
  assert.equal((await readModel(await put({
    context_window_tokens: 64000,
    max_output_tokens: null,
    enabled_thinking_tiers: [],
    default_thinking_tier: null,
  }))).max_output_tokens, null);

  // 漏字段 → 400（整体替换口径下「清空」与「不修改」必须可区分）
  assert.equal((await put({ context_window_tokens: 64000 })).status, 400);
  assert.equal(
    (await put({ context_window_tokens: 0, max_output_tokens: null, enabled_thinking_tiers: [], default_thinking_tier: null })).status,
    400,
  );
  assert.equal(
    (await fetch(`${baseUrl}/api/custom-chat-models/never-declared`, {
      method: 'PUT',
      headers: writeHeaders(),
      body: JSON.stringify({ context_window_tokens: 64000, max_output_tokens: null, enabled_thinking_tiers: [], default_thinking_tier: null }),
    })).status,
    404,
  );
});

void test('自建对话模型：档位启用校验——池外档位与协议表达不了的自定义档位被拒（按记录自带协议）', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await startServer(t);
  // 档位字段是有限枚举的对话协议（自定义档位表达不了）；协议随记录必填
  const geminiConnectionId = await seedConnection('gemini-chat-v1');
  assert.equal(
    (await addCustomModel(baseUrl, { model_id: CUSTOM_MODEL_ID, connection_id: geminiConnectionId, protocol_adapter_id: 'gemini-chat-v1' })).status,
    200,
  );

  const put = (tiers: string[], defaultTier: string | null): Promise<Response> =>
    fetch(`${baseUrl}/api/custom-chat-models/${CUSTOM_MODEL_ID}`, {
      method: 'PUT',
      headers: writeHeaders(),
      body: JSON.stringify({
        context_window_tokens: 64000,
        max_output_tokens: null,
        enabled_thinking_tiers: tiers,
        default_thinking_tier: defaultTier,
      }),
    });

  // 池子里没有的档位：拒绝
  const unknown = await put(['definitely-not-a-tier'], null);
  assert.equal(unknown.status, 400);
  assert.match(String((await unknown.json() as JsonValue)['message']), /档位/);

  // 自定义档位在枚举值域协议上表达不了：拒绝
  const addTier = await fetch(`${baseUrl}/api/thinking-tiers`, {
    method: 'POST',
    headers: writeHeaders(),
    body: JSON.stringify({ name: 'ultra' }),
  });
  assert.equal(addTier.status, 200);
  const inexpressible = await put(['ultra'], null);
  assert.equal(inexpressible.status, 400);
  assert.match(String((await inexpressible.json() as JsonValue)['message']), /表达/);
});

void test('自建对话模型：与生成侧自建记录重名被拒（model_id 全局唯一，两个域互斥）', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await startServer(t);
  const connectionId = await seedConnection(CHAT_ADAPTER);

  // 生成侧先记录同一个名字；对称方向（对话先记录、生成侧被拒）由 custom-generation-model.test 覆盖
  const generationRecorded = addCustomGenerationModel({
    model_id: CUSTOM_MODEL_ID,
    connection_id: await seedConnection(GENERATION_ADAPTER),
    family_adapter_id: GENERATION_ADAPTER,
  });
  assert.ok(generationRecorded.ok, '生成侧记录应先建立');

  // 对话侧再用同一个名字 → 409，提示指认冲突来源是生成模型
  const response = await addCustomModel(baseUrl, { model_id: CUSTOM_MODEL_ID, connection_id: connectionId, protocol_adapter_id: CHAT_ADAPTER });
  assert.equal(response.status, 409);
  const body = (await response.json()) as { message?: unknown };
  assert.match(String(body.message), /生成模型/);
});

void test('自建对话模型：创建请求体携带档位一次落库，默认档位不落在启用列表内归一化清空', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await startServer(t);
  const connectionId = await seedConnection(CHAT_ADAPTER);
  assert.equal((await addCustomTier(baseUrl, 'ultra')).status, 200);

  // 创建时显式携带档位：随记录一次落库（spec 37「思考档位」），无需再发一次 PUT
  const created = await addCustomModel(baseUrl, {
    model_id: CUSTOM_MODEL_ID,
    connection_id: connectionId,
    protocol_adapter_id: CHAT_ADAPTER,
    enabled_thinking_tiers: ['low', 'ultra'],
    default_thinking_tier: 'ultra',
  });
  assert.equal(created.status, 200);
  const createdModel = CustomChatModelResponseSchema.parse(await created.json()).model;
  assert.deepEqual(createdModel.enabled_thinking_tiers, ['low', 'ultra']);
  assert.equal(createdModel.default_thinking_tier, 'ultra');
  // 目录投影立即反映创建时的档位（添加即可用含档位维度）
  const entry = (await readChatCatalog(baseUrl)).models.find((item) => item.model_id === CUSTOM_MODEL_ID);
  assert.ok(entry);
  assert.deepEqual(entry.thinking_tiers, ['low', 'ultra']);

  // 默认档位不落在启用列表内 → 写入侧归一化清空为 null（不拒绝整条，与 PUT 同规则）
  const normalized = await addCustomModel(baseUrl, {
    model_id: 'tier-default-mismatch',
    connection_id: connectionId,
    protocol_adapter_id: CHAT_ADAPTER,
    enabled_thinking_tiers: ['low'],
    default_thinking_tier: 'ultra',
  });
  assert.equal(normalized.status, 200);
  const normalizedModel = CustomChatModelResponseSchema.parse(await normalized.json()).model;
  assert.deepEqual(normalizedModel.enabled_thinking_tiers, ['low']);
  assert.equal(normalizedModel.default_thinking_tier, null);

  // 省略档位 = 只有「不思考」可用（与契约缺省同口径）
  const omitted = await addCustomModel(baseUrl, {
    model_id: 'tier-omitted',
    connection_id: connectionId,
    protocol_adapter_id: CHAT_ADAPTER,
  });
  assert.equal(omitted.status, 200);
  const omittedModel = CustomChatModelResponseSchema.parse(await omitted.json()).model;
  assert.deepEqual(omittedModel.enabled_thinking_tiers, []);
  assert.equal(omittedModel.default_thinking_tier, null);

  // 创建时携带池外档位 → 400（与 PUT 同一写入校验）
  const unknownTier = await addCustomModel(baseUrl, {
    model_id: 'tier-unknown',
    connection_id: connectionId,
    protocol_adapter_id: CHAT_ADAPTER,
    enabled_thinking_tiers: ['definitely-not-a-tier'],
  });
  assert.equal(unknownTier.status, 400);
});

const addCustomTier = async (baseUrl: string, name: string): Promise<Response> =>
  fetch(`${baseUrl}/api/thinking-tiers`, {
    method: 'POST',
    headers: writeHeaders(),
    body: JSON.stringify({ name }),
  });

void test('自建对话模型：写路由受 Hub write token 保护', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await startServer(t);
  const connectionId = await seedConnection(CHAT_ADAPTER);

  const response = await addCustomModel(baseUrl, { model_id: CUSTOM_MODEL_ID, connection_id: connectionId, protocol_adapter_id: CHAT_ADAPTER }, false);
  assert.equal(response.status, 403);
});

void test('自建对话模型：删除级联清 active route，响应只剩 model_id', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await startServer(t);
  const connectionId = await seedConnection(CHAT_ADAPTER);

  const created = await addCustomModel(baseUrl, { model_id: CUSTOM_MODEL_ID, connection_id: connectionId, protocol_adapter_id: CHAT_ADAPTER });
  assert.equal(created.status, 200);
  assert.ok((await readChatCatalog(baseUrl)).models.some((entry) => entry.model_id === CUSTOM_MODEL_ID));

  const removal = await fetch(`${baseUrl}/api/custom-chat-models/${CUSTOM_MODEL_ID}`, {
    method: 'DELETE',
    headers: writeHeaders(),
  });
  assert.equal(removal.status, 200);
  assert.deepEqual(
    CustomChatModelRemovalResponseSchema.parse(await removal.json()),
    { model_id: CUSTOM_MODEL_ID },
    '删除响应只剩 model_id（旧 removed_deployments 计数随声明层退役）',
  );
  assert.equal(getActiveDeploymentId(CUSTOM_MODEL_ID), null, 'active route 随删除清理');
  assert.equal(
    (await readChatCatalog(baseUrl)).models.some((entry) => entry.model_id === CUSTOM_MODEL_ID),
    false,
  );
  assert.equal(
    (await fetch(`${baseUrl}/api/custom-chat-models/${CUSTOM_MODEL_ID}`, {
      method: 'DELETE',
      headers: writeHeaders(),
    })).status,
    404,
  );
});
