import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CustomGenerationModelListResponseSchema,
  CustomGenerationModelRemovalResponseSchema,
  CustomGenerationModelResponseSchema,
  FamilyTemplateParameterDescriptorSchema,
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
  clearCacheForTest as clearDeploymentCache,
  listDeployments,
} from '../provider-connection/deployment-store.cts';
import {
  clearCacheForTest as clearActiveRouteCache,
  getActiveDeploymentId,
} from '../provider-connection/active-route-store.cts';
import {
  addCustomChatModel,
  clearCacheForTest as clearCustomChatModelCache,
} from '../provider-connection/custom-chat-model-store.cts';
import {
  clearCacheForTest as clearCustomGenerationModelCache,
} from '../provider-connection/custom-generation-model-store.cts';
import { setCredentialForConnection } from '../provider-connection/credential-store.cts';

/**
 * 自建生成模型记录（spec 03 §6.1「Deployment 与自建模型记录」，2026-09-25 单记录形态，
 * 形态镜像对话侧 custom-chat-model.test）。
 *
 * 覆盖五条口径：① 一次写入完成能力属性与接入归属，立即成为当前使用（接缝：记录 × active
 * route × 目录一致）；② 查重三类拒绝（本域重名、对话记录重名、已装模型重名）；
 * ③ 命名空间护栏（命中其他生成族正则拒绝、命中本族 gpt-image-* 放行）与 Hub write token；
 * ④ 归属校验（连接存在、enabled、有凭证）——2026-09-26 起协议归属模型级，连接不再约束
 * 协议族，生成记录可挂任意连接；⑤ 删除级联清 active route，参数覆盖的落盘 round-trip 与
 * PUT 语义不变。
 */

const repoRoot = path.join(__dirname, '..', '..', '..', '..', '..');
const REAL_PACKAGES_DIR = path.join(repoRoot, '.model-assets', 'sources');
process.env['IART_MODEL_ASSET_PACKAGES_DIR'] = REAL_PACKAGES_DIR;
process.env['IART_PUBLIC_UPLOAD_CLOUDFLARE_IMAGE_PUBLIC_URL_ENDPOINT'] = 'https://relay.example.invalid/upload';

const HUB_WRITE_TOKEN = 'g'.repeat(32);
/* 已装生成模型的中性 id：不属于任何封闭生成族正则，用来验证「生成记录不得与已装模型重名」。
   查重走与对话侧同一份实现（findProjectionByModelIdOrAlias），这里用真实已装包钉住它。 */
const INSTALLED_GENERATION_MODEL_ID = 'z-image-turbo';
const OPENAI_IMAGE_ADAPTER = 'openai-image-v1';
const OTHER_FAMILY_ADAPTER = 'veo-v1';
const CHAT_ADAPTER = 'gemini-chat-v1';
const CONNECTION_BASE_URL = 'https://byok.example.com/v1';
const CREDENTIAL_VALUE = 'sk-custom-generation-model-key';
const CUSTOM_MODEL_ID = 'my-image';
const REFERENCE_IMAGE_MODEL_ID = 'my-image-ref';
const REMOTE_MODEL_ID = 'remote-my-image';

const startServer = async (t: test.TestContext): Promise<string> => {
  const server = http.createServer(createRequestHandler());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  }));
  const address = server.address();
  if (address == null || typeof address === 'string') {
    throw new Error('custom_generation_model_test_server_address_unavailable');
  }
  return `http://127.0.0.1:${address.port}`;
};

const clearAllCaches = (): void => {
  clearConnectionCache();
  clearDeploymentCache();
  clearActiveRouteCache();
  clearCustomChatModelCache();
  clearCustomGenerationModelCache();
};

const withIsolatedEnv = (t: test.TestContext): void => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-generation-model-'));
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
    display_name: `custom-generation-${protocolAdapterId}`,
    base_url: CONNECTION_BASE_URL,
  });
  if (withCredential) {
    const credential = await setCredentialForConnection(connection.connection_id, CREDENTIAL_VALUE);
    assert.ok(credential, 'credential should be stored');
    setConnectionCredential(connection.connection_id, credential.credentialRef, credential.version, true);
  }
  return connection.connection_id;
};

const addGenerationModel = async (
  baseUrl: string,
  body: Record<string, unknown>,
  withToken = true,
): Promise<Response> =>
  fetch(`${baseUrl}/api/custom-generation-models`, {
    method: 'POST',
    headers: writeHeaders(withToken),
    body: JSON.stringify(body),
  });

const readErrorBody = async (response: Response): Promise<string> => {
  const body = (await response.json()) as { message?: unknown };
  return String(body.message ?? '');
};

void test('自建生成模型：一次写入完成归属与能力，立即成为当前使用（接缝：记录 × active route × 目录一致）', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await startServer(t);
  const connectionId = await seedConnection(OPENAI_IMAGE_ADAPTER);

  const empty = CustomGenerationModelListResponseSchema.parse(
    await (await fetch(`${baseUrl}/api/custom-generation-models`)).json(),
  );
  assert.deepEqual(empty.models, []);

  // 省略 remote_model_id：回落 model_id；省略 supports_reference_image：落库为 false（仅文生图）
  const created = await addGenerationModel(baseUrl, {
    model_id: CUSTOM_MODEL_ID,
    connection_id: connectionId,
    family_adapter_id: OPENAI_IMAGE_ADAPTER,
  });
  assert.equal(created.status, 200);
  const createdModel = CustomGenerationModelResponseSchema.parse(await created.json()).model;
  assert.equal(createdModel.model_id, CUSTOM_MODEL_ID);
  assert.equal(createdModel.connection_id, connectionId);
  assert.equal(createdModel.remote_model_id, CUSTOM_MODEL_ID, 'remote_model_id 缺省回落 model_id');
  assert.match(createdModel.record_id, /^up_dep_[a-z0-9][a-z0-9-_]*$/, 'record_id 用接入记录 id 空间');
  assert.equal(createdModel.family_adapter_id, OPENAI_IMAGE_ADAPTER);
  assert.equal(createdModel.supports_reference_image, false);

  // 接缝一致：active route 已指向该记录，目录投影标成可提交
  assert.equal(getActiveDeploymentId(CUSTOM_MODEL_ID), createdModel.record_id);
  const catalog: unknown = await (await fetch(`${baseUrl}/api/executable-model-catalog`)).json();
  const entry = (catalog as { models: Array<{ model_id: string; deployment: { deployable: boolean; active_deployment_id: string | null } }> })
    .models.find((item) => item.model_id === CUSTOM_MODEL_ID);
  assert.ok(entry, '自建生成模型应出现在可执行目录里');
  assert.equal(entry.deployment.deployable, true);
  assert.equal(entry.deployment.active_deployment_id, createdModel.record_id);

  // 落盘形状：记录文件 version 2，deployment store 不再产生自建链记录
  const storageRoot = process.env['IART_STORAGE_ROOT'];
  assert.ok(storageRoot);
  const onDisk: unknown = JSON.parse(
    fs.readFileSync(path.join(storageRoot, 'config', 'custom-generation-models.json'), 'utf-8'),
  );
  assert.equal((onDisk as { version: number }).version, 2);
  assert.deepEqual(listDeployments().filter((deployment) => deployment.model_id === CUSTOM_MODEL_ID), []);

  // 显式声明支持参考图
  const withReference = await addGenerationModel(baseUrl, {
    model_id: REFERENCE_IMAGE_MODEL_ID,
    connection_id: connectionId,
    family_adapter_id: OPENAI_IMAGE_ADAPTER,
    supports_reference_image: true,
    remote_model_id: REMOTE_MODEL_ID,
  });
  assert.equal(withReference.status, 200);
  assert.equal(
    CustomGenerationModelResponseSchema.parse(await withReference.json()).model.supports_reference_image,
    true,
  );

  const listed = CustomGenerationModelListResponseSchema.parse(
    await (await fetch(`${baseUrl}/api/custom-generation-models`)).json(),
  );
  assert.equal(listed.models.length, 2);

  // 非法输入 → 400（提示落在出错的那个字段上）
  assert.equal(
    (await addGenerationModel(baseUrl, { model_id: 'a b', connection_id: connectionId, family_adapter_id: OPENAI_IMAGE_ADAPTER })).status,
    400,
  );
  assert.equal(
    (await addGenerationModel(baseUrl, { model_id: 'bad-ref-model', connection_id: connectionId, family_adapter_id: OPENAI_IMAGE_ADAPTER, supports_reference_image: 'yes' }))
      .status,
    400,
  );
  assert.equal(
    (await addGenerationModel(baseUrl, { model_id: 'bad-family-model', connection_id: connectionId, family_adapter_id: 'not-a-family' })).status,
    400,
  );
  // 缺 connection_id → 400（归属必填）
  assert.equal(
    (await addGenerationModel(baseUrl, { model_id: 'no-connection-model', family_adapter_id: OPENAI_IMAGE_ADAPTER })).status,
    400,
  );
});

void test('自建生成模型：归属校验——连接不存在 / 未启用 / 无凭证被拒；协议族不再约束（跨族连接放行）', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await startServer(t);

  const missing = await addGenerationModel(baseUrl, {
    model_id: 'model-missing-conn',
    connection_id: 'up_conn_nope',
    family_adapter_id: OPENAI_IMAGE_ADAPTER,
  });
  assert.equal(missing.status, 400);
  assert.match(await readErrorBody(missing), /连接/);

  const disabledId = await seedConnection(OPENAI_IMAGE_ADAPTER);
  await fetch(`${baseUrl}/api/provider-connections/${disabledId}/lifecycle`, {
    method: 'PUT',
    headers: writeHeaders(),
    body: JSON.stringify({ lifecycle: 'disabled' }),
  });
  assert.equal(
    (await addGenerationModel(baseUrl, { model_id: 'model-disabled-conn', connection_id: disabledId, family_adapter_id: OPENAI_IMAGE_ADAPTER })).status,
    400,
  );

  const noCredentialId = await seedConnection(OPENAI_IMAGE_ADAPTER, false);
  assert.equal(
    (await addGenerationModel(baseUrl, { model_id: 'model-no-cred', connection_id: noCredentialId, family_adapter_id: OPENAI_IMAGE_ADAPTER })).status,
    400,
  );

  // 其他生成族连接放行（2026-09-26 起协议归属模型级：连接不再约束协议族，协议随记录走）
  const veoConnectionId = await seedConnection(OTHER_FAMILY_ADAPTER);
  const otherFamily = await addGenerationModel(baseUrl, {
    model_id: 'model-other-family',
    connection_id: veoConnectionId,
    family_adapter_id: OPENAI_IMAGE_ADAPTER,
  });
  assert.equal(otherFamily.status, 200, 'openai-image 族记录可挂 veo 协议连接（连接不再约束协议族）');
  assert.equal(
    CustomGenerationModelResponseSchema.parse(await otherFamily.json()).model.family_adapter_id,
    OPENAI_IMAGE_ADAPTER,
  );

  // 对话协议连接同样放行
  const chatConnectionId = await seedConnection(CHAT_ADAPTER);
  const chatConnRecord = await addGenerationModel(baseUrl, {
    model_id: 'model-chat-conn',
    connection_id: chatConnectionId,
    family_adapter_id: OPENAI_IMAGE_ADAPTER,
  });
  assert.equal(chatConnRecord.status, 200, '生成记录可挂对话协议连接（连接不再约束协议族）');
});

void test('自建生成模型：查重三类拒绝（本域重名、对话记录重名、已装模型重名）', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await startServer(t);
  const connectionId = await seedConnection(OPENAI_IMAGE_ADAPTER);

  assert.equal(
    (await addGenerationModel(baseUrl, { model_id: CUSTOM_MODEL_ID, connection_id: connectionId, family_adapter_id: OPENAI_IMAGE_ADAPTER })).status,
    200,
  );

  // 本域重名 → 409（出路是换一个模型 ID，或先删除同名记录再重新添加）
  const ownDuplicate = await addGenerationModel(baseUrl, { model_id: CUSTOM_MODEL_ID, connection_id: connectionId, family_adapter_id: OPENAI_IMAGE_ADAPTER });
  assert.equal(ownDuplicate.status, 409);
  assert.match(
    await readErrorBody(ownDuplicate),
    new RegExp(`软件里已经添加过「${CUSTOM_MODEL_ID}」了。换一个模型 ID，或在模型列表里先删除它再重新添加。`),
  );

  // 与对话侧自建记录重名 → 409（model_id 全局唯一，两个域不能各占一份）
  const chatRecorded = addCustomChatModel({
    model_id: 'my-chat-model',
    connection_id: await seedConnection(CHAT_ADAPTER),
    protocol_adapter_id: CHAT_ADAPTER,
  });
  assert.equal(chatRecorded.ok, true, '应能添加自建对话模型');
  const chatCollision = await addGenerationModel(baseUrl, { model_id: 'my-chat-model', connection_id: connectionId, family_adapter_id: OPENAI_IMAGE_ADAPTER });
  assert.equal(chatCollision.status, 409);
  assert.match(await readErrorBody(chatCollision), /对话模型/);

  // 与已装模型包重名（model_id / 别名 / 变体名共用一份查重实现）→ 409
  const installedCollision = await addGenerationModel(baseUrl, { model_id: INSTALLED_GENERATION_MODEL_ID, connection_id: connectionId, family_adapter_id: OPENAI_IMAGE_ADAPTER });
  assert.equal(installedCollision.status, 409);
  assert.match(await readErrorBody(installedCollision), /换一个模型 ID/);
});

void test('自建生成模型：命名空间护栏拒绝他族正则、放行本族正则', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await startServer(t);
  const connectionId = await seedConnection(OPENAI_IMAGE_ADAPTER);

  // 命中其他生成族正则 → 409（D2：防冒名与未来装包撞车）
  for (const foreignId of ['veo-my-video', 'doubao-seedance-2-0-my-video', 'gemini-my-image-model', 'kling-v3-text2video']) {
    const response = await addGenerationModel(baseUrl, { model_id: foreignId, connection_id: connectionId, family_adapter_id: OPENAI_IMAGE_ADAPTER });
    assert.equal(response.status, 409, `${foreignId} 应命中他族命名空间护栏`);
    assert.match(await readErrorBody(response), /其他类型的生成模型/);
  }

  // 命中本族正则（gpt-image-*，且未与已装包重名）→ 放行
  const ownFamily = await addGenerationModel(baseUrl, { model_id: 'gpt-image-my-custom', connection_id: connectionId, family_adapter_id: OPENAI_IMAGE_ADAPTER });
  assert.equal(ownFamily.status, 200, '命中本族正则的未装名字应放行');
});

void test('自建生成模型：写路由受 Hub write token 保护', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await startServer(t);
  const connectionId = await seedConnection(OPENAI_IMAGE_ADAPTER);

  const post = await addGenerationModel(baseUrl, { model_id: CUSTOM_MODEL_ID, connection_id: connectionId, family_adapter_id: OPENAI_IMAGE_ADAPTER }, false);
  assert.equal(post.status, 403);
  const put = await fetch(`${baseUrl}/api/custom-generation-models/${CUSTOM_MODEL_ID}`, {
    method: 'PUT',
    headers: writeHeaders(false),
    body: JSON.stringify({ supports_reference_image: true }),
  });
  assert.equal(put.status, 403);
  const remove = await fetch(`${baseUrl}/api/custom-generation-models/${CUSTOM_MODEL_ID}`, {
    method: 'DELETE',
    headers: writeHeaders(false),
  });
  assert.equal(remove.status, 403);
});

void test('自建生成模型：改参考图支持、删除级联清 active route（响应只剩 model_id）', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await startServer(t);
  const connectionId = await seedConnection(OPENAI_IMAGE_ADAPTER);

  assert.equal(
    (await addGenerationModel(baseUrl, { model_id: CUSTOM_MODEL_ID, connection_id: connectionId, family_adapter_id: OPENAI_IMAGE_ADAPTER })).status,
    200,
  );

  // 改参考图支持（可改属性的整体替换；model_id 与接入归属不提供修改）
  const updated = await fetch(`${baseUrl}/api/custom-generation-models/${CUSTOM_MODEL_ID}`, {
    method: 'PUT',
    headers: writeHeaders(),
    body: JSON.stringify({ supports_reference_image: true }),
  });
  assert.equal(updated.status, 200);
  assert.equal(CustomGenerationModelResponseSchema.parse(await updated.json()).model.supports_reference_image, true);
  assert.equal(
    (await fetch(`${baseUrl}/api/custom-generation-models/${CUSTOM_MODEL_ID}`, {
      method: 'PUT',
      headers: writeHeaders(),
      body: JSON.stringify({ supports_reference_image: 'yes' }),
    })).status,
    400,
  );
  assert.equal(
    (await fetch(`${baseUrl}/api/custom-generation-models/never-declared`, {
      method: 'PUT',
      headers: writeHeaders(),
      body: JSON.stringify({ supports_reference_image: true }),
    })).status,
    404,
  );

  // 删除：active route 一并清理，响应只剩 model_id
  const removal = await fetch(`${baseUrl}/api/custom-generation-models/${CUSTOM_MODEL_ID}`, {
    method: 'DELETE',
    headers: writeHeaders(),
  });
  assert.equal(removal.status, 200);
  assert.deepEqual(
    CustomGenerationModelRemovalResponseSchema.parse(await removal.json()),
    { model_id: CUSTOM_MODEL_ID },
  );
  assert.equal(getActiveDeploymentId(CUSTOM_MODEL_ID), null);
  assert.equal(
    (await fetch(`${baseUrl}/api/custom-generation-models/${CUSTOM_MODEL_ID}`, {
      method: 'DELETE',
      headers: writeHeaders(),
    })).status,
    404,
  );
});

const SAMPLE_OVERRIDES = {
  official: [
    { field_key: 'format', wire_name: 'img_format', default_value: 'png' },
    { field_key: 'moderation', enabled: false },
  ],
  custom: [
    { label: '水印', wire_name: 'my_watermark', value_type: 'enum', enum_options: ['on', 'off'], default_value: 'on', required: true },
  ],
} as const;

void test('参数覆盖：POST 携带、落盘 round-trip、PUT 缺省不变/出现整体替换、非法覆盖保存被拒', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await startServer(t);
  const connectionId = await seedConnection(OPENAI_IMAGE_ADAPTER);

  // POST 携带 parameter_overrides → 落库并回显。
  const created = await addGenerationModel(baseUrl, {
    model_id: CUSTOM_MODEL_ID,
    connection_id: connectionId,
    family_adapter_id: OPENAI_IMAGE_ADAPTER,
    parameter_overrides: SAMPLE_OVERRIDES,
  });
  assert.equal(created.status, 200);
  const createdModel = CustomGenerationModelResponseSchema.parse(await created.json()).model;
  assert.deepEqual(createdModel.parameter_overrides.official, [
    { field_key: 'format', wire_name: 'img_format', default_value: 'png' },
    { field_key: 'moderation', enabled: false },
  ]);
  assert.equal(createdModel.parameter_overrides.custom.length, 1);
  assert.equal(createdModel.parameter_overrides.custom[0]?.wire_name, 'my_watermark');

  // 落盘 round-trip：记录 JSON 里 parameter_overrides 完整保留（读取侧 schema 缺省不吞它）。
  const storageRoot = process.env['IART_STORAGE_ROOT'];
  assert.ok(storageRoot, 'isolated storage root should be set');
  const onDisk: unknown = JSON.parse(
    fs.readFileSync(path.join(storageRoot, 'config', 'custom-generation-models.json'), 'utf-8'),
  );
  const diskModel = (onDisk as { models: Array<{ model_id: string; parameter_overrides?: unknown }> }).models
    .find((item) => item.model_id === CUSTOM_MODEL_ID);
  assert.ok(diskModel, 'declared model must be persisted');
  assert.deepEqual(diskModel.parameter_overrides, SAMPLE_OVERRIDES, 'overrides must survive the disk round-trip');

  // PUT 缺省 parameter_overrides = 保持现有覆盖不变。
  const keptPut = await fetch(`${baseUrl}/api/custom-generation-models/${CUSTOM_MODEL_ID}`, {
    method: 'PUT',
    headers: writeHeaders(),
    body: JSON.stringify({ supports_reference_image: true }),
  });
  assert.equal(keptPut.status, 200);
  const keptModel = CustomGenerationModelResponseSchema.parse(await keptPut.json()).model;
  assert.equal(keptModel.supports_reference_image, true);
  assert.equal(keptModel.parameter_overrides.custom.length, 1, 'absent overrides must keep existing ones');

  // PUT 出现 = 整体替换；显式空覆盖即清空。
  const clearedPut = await fetch(`${baseUrl}/api/custom-generation-models/${CUSTOM_MODEL_ID}`, {
    method: 'PUT',
    headers: writeHeaders(),
    body: JSON.stringify({ supports_reference_image: true, parameter_overrides: { official: [], custom: [] } }),
  });
  assert.equal(clearedPut.status, 200);
  const clearedModel = CustomGenerationModelResponseSchema.parse(await clearedPut.json()).model;
  assert.deepEqual(clearedModel.parameter_overrides, { official: [], custom: [] });

  // PUT 非法覆盖（别名撞保留键）→ 400 + 可读原因。
  const illegalPut = await fetch(`${baseUrl}/api/custom-generation-models/${CUSTOM_MODEL_ID}`, {
    method: 'PUT',
    headers: writeHeaders(),
    body: JSON.stringify({
      supports_reference_image: true,
      parameter_overrides: { official: [{ field_key: 'size', wire_name: 'model' }], custom: [] },
    }),
  });
  assert.equal(illegalPut.status, 400);
  assert.match(await readErrorBody(illegalPut), /重名/);

  // PUT 非法覆盖（禁用 image）→ 400。
  const imagePut = await fetch(`${baseUrl}/api/custom-generation-models/${CUSTOM_MODEL_ID}`, {
    method: 'PUT',
    headers: writeHeaders(),
    body: JSON.stringify({
      supports_reference_image: true,
      parameter_overrides: { official: [{ field_key: 'image', enabled: false }], custom: [] },
    }),
  });
  assert.equal(imagePut.status, 400);
  assert.match(await readErrorBody(imagePut), /参考图/);

  // POST 非法覆盖同样被拒。
  const illegalPost = await addGenerationModel(baseUrl, {
    model_id: 'my-image-bad-overrides',
    connection_id: connectionId,
    family_adapter_id: OPENAI_IMAGE_ADAPTER,
    parameter_overrides: { official: [{ field_key: 'nope' }], custom: [] },
  });
  assert.equal(illegalPost.status, 400);
  assert.match(await readErrorBody(illegalPost), /nope/);
});

void test('族模板参数描述端点：openai-image-v1 返回官方参数与保留键，未知族 404', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await startServer(t);

  const response = await fetch(`${baseUrl}/api/generation-family-templates/openai-image-v1`);
  assert.equal(response.status, 200);
  const descriptor = FamilyTemplateParameterDescriptorSchema.parse(await response.json());
  assert.equal(descriptor.family_adapter_id, OPENAI_IMAGE_ADAPTER);
  assert.deepEqual(
    descriptor.official_fields.map((field) => field.field_key),
    ['size', 'quality', 'format', 'moderation'],
    'descriptor must exclude the image system-modality field',
  );
  const format = descriptor.official_fields.find((field) => field.field_key === 'format');
  assert.ok(format, 'format field must be described');
  assert.equal(format.wire_name, 'output_format');
  assert.ok(descriptor.reserved_wire_names.includes('output_format'));

  const missing = await fetch(`${baseUrl}/api/generation-family-templates/not-a-family`);
  assert.equal(missing.status, 404);
});
