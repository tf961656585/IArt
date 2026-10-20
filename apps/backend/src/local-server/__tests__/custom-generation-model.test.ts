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
  GENERATION_FAMILY_ADAPTER_IDS,
  HUB_LOCAL_WRITE_TOKEN_ENV,
  HUB_LOCAL_WRITE_TOKEN_HEADER,
  type GenerationMediaSlotId,
} from '@iart/contracts';
import { createRequestHandler } from '../router.cts';
import {
  clearCacheForTest as clearConnectionCache,
  createConnection,
  setConnectionCredential,
} from '../provider-connection/connection-store.cts';
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
  getCustomGenerationModel,
} from '../provider-connection/custom-generation-model-store.cts';
import { GENERATION_FAMILY_TEMPLATE_REGISTRY } from '../generation-family-templates.registry.cts';
import { setCredentialForConnection } from '../provider-connection/credential-store.cts';

/**
 * 自建生成模型记录（spec 03 §6.1「Deployment 与自建模型记录」，2026-09-25 单记录形态，
 * 形态镜像对话侧 custom-chat-model.test）。
 *
 * 覆盖四类口径：① 一次写入完成能力属性与接入归属，立即成为当前使用（接缝：记录 × active
 * route × 目录一致）；② 查重两类拒绝（本域重名、对话记录重名）——2026-10-19 起「与已装模型包
 * 重名」随部署载体退场消失（软件不内置任何具体模型）；
 * ③ 族归属只由记录的 family_adapter_id 决定（名字长得像别族不再被拦）与 Hub write token；
 * ④ 归属校验（连接存在、enabled、有凭证）——2026-09-26 起协议归属模型级，连接不再约束
 * 协议族，生成记录可挂任意连接；⑤ 删除级联清 active route，参数覆盖的落盘 round-trip 与
 * PUT 语义不变。
 */

process.env['IART_PUBLIC_UPLOAD_CLOUDFLARE_IMAGE_PUBLIC_URL_ENDPOINT'] = 'https://relay.example.invalid/upload';

const HUB_WRITE_TOKEN = 'g'.repeat(32);
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

  // 省略 remote_model_id：回落 model_id；省略 accepted_media_slots：落库为空清单（不接受任何素材）
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
  assert.deepEqual(createdModel.accepted_media_slots, []);

  // 接缝一致：active route 已指向该记录，目录投影标成可提交
  assert.equal(getActiveDeploymentId(CUSTOM_MODEL_ID), createdModel.record_id);
  const catalog: unknown = await (await fetch(`${baseUrl}/api/executable-model-catalog`)).json();
  const entry = (catalog as { models: Array<{ model_id: string; deployment: { deployable: boolean; active_deployment_id: string | null } }> })
    .models.find((item) => item.model_id === CUSTOM_MODEL_ID);
  assert.ok(entry, '自建生成模型应出现在可执行目录里');
  assert.equal(entry.deployment.deployable, true);
  assert.equal(entry.deployment.active_deployment_id, createdModel.record_id);

  // 落盘形状：记录文件 version 3，deployment store 不再产生自建链记录
  const storageRoot = process.env['IART_STORAGE_ROOT'];
  assert.ok(storageRoot);
  const onDisk: unknown = JSON.parse(
    fs.readFileSync(path.join(storageRoot, 'config', 'custom-generation-models.json'), 'utf-8'),
  );
  assert.equal((onDisk as { version: number }).version, 3);
  // 2026-10-19 起没有第二类接入载体可查：模型记录本身就是接入（原断言在这里再查一遍
  // deployment store 里没有自建链记录，那个 store 已整体删除）。
  assert.equal(getCustomGenerationModel(CUSTOM_MODEL_ID)?.record_id, createdModel.record_id);

  // 显式声明接受参考图素材位
  const withReference = await addGenerationModel(baseUrl, {
    model_id: REFERENCE_IMAGE_MODEL_ID,
    connection_id: connectionId,
    family_adapter_id: OPENAI_IMAGE_ADAPTER,
    accepted_media_slots: ['reference_image'],
    remote_model_id: REMOTE_MODEL_ID,
  });
  assert.equal(withReference.status, 200);
  assert.deepEqual(
    CustomGenerationModelResponseSchema.parse(await withReference.json()).model.accepted_media_slots,
    ['reference_image'],
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
    (await addGenerationModel(baseUrl, { model_id: 'bad-ref-model', connection_id: connectionId, family_adapter_id: OPENAI_IMAGE_ADAPTER, accepted_media_slots: 'yes' }))
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

void test('自建生成模型：查重两类拒绝（本域重名、对话记录重名）', async (t) => {
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
    new RegExp(`已经有「${CUSTOM_MODEL_ID}」这个模型了。换一个模型 ID，或在模型列表里先删除它再重新添加。`),
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

});

void test('自建生成模型：族归属只由记录的 family_adapter_id 决定，不再按 model_id 正则设护栏', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await startServer(t);
  const connectionId = await seedConnection(OPENAI_IMAGE_ADAPTER);

  // 2026-10-19 起模型来源唯一（软件不内置任何具体模型），「命中他族正则即拒」的命名空间护栏
  // 与「与已装包重名即拒」的查重一并退场——没有第二个来源可撞名，也不存在按名字冒名的对象。
  // 名字长得像哪一族与它实际属于哪一族无关：族只由记录自带的 family_adapter_id 声明。
  for (const nameLikeOtherFamily of ['veo-my-video', 'doubao-seedance-2-0-my-video', 'gemini-my-image-model', 'kling-v3-text2video']) {
    const response = await addGenerationModel(baseUrl, {
      model_id: nameLikeOtherFamily,
      connection_id: connectionId,
      family_adapter_id: OPENAI_IMAGE_ADAPTER,
    });
    assert.equal(response.status, 200, `${nameLikeOtherFamily} 的名字不应再被族正则拦下`);
  }
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
    body: JSON.stringify({ accepted_media_slots: ['reference_image'] }),
  });
  assert.equal(put.status, 403);
  const remove = await fetch(`${baseUrl}/api/custom-generation-models/${CUSTOM_MODEL_ID}`, {
    method: 'DELETE',
    headers: writeHeaders(false),
  });
  assert.equal(remove.status, 403);
});

void test('自建生成模型：改接受的素材位、删除级联清 active route（响应只剩 model_id）', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await startServer(t);
  const connectionId = await seedConnection(OPENAI_IMAGE_ADAPTER);

  assert.equal(
    (await addGenerationModel(baseUrl, { model_id: CUSTOM_MODEL_ID, connection_id: connectionId, family_adapter_id: OPENAI_IMAGE_ADAPTER })).status,
    200,
  );

  // 改接受的素材位（可改属性的整体替换；model_id 与接入归属不提供修改）
  const updated = await fetch(`${baseUrl}/api/custom-generation-models/${CUSTOM_MODEL_ID}`, {
    method: 'PUT',
    headers: writeHeaders(),
    body: JSON.stringify({ accepted_media_slots: ['reference_image'] }),
  });
  assert.equal(updated.status, 200);
  assert.deepEqual(
    CustomGenerationModelResponseSchema.parse(await updated.json()).model.accepted_media_slots,
    ['reference_image'],
  );
  // 素材位 × 族能力守卫：openai-image-v1 的模板表达不了首帧图，越界位在写入侧就被拒
  const outOfFamily = await fetch(`${baseUrl}/api/custom-generation-models/${CUSTOM_MODEL_ID}`, {
    method: 'PUT',
    headers: writeHeaders(),
    body: JSON.stringify({ accepted_media_slots: ['reference_image', 'first_frame'] }),
  });
  assert.equal(outOfFamily.status, 400, '族模板表达不了的素材位必须在保存时被拒');
  assert.match(await readErrorBody(outOfFamily), /first_frame/);
  // 被拒的这次写入不改变已存记录（整体替换语义下不留半截状态）
  const afterReject = CustomGenerationModelListResponseSchema.parse(
    await (await fetch(`${baseUrl}/api/custom-generation-models`)).json(),
  );
  assert.deepEqual(
    afterReject.models.find((model) => model.model_id === CUSTOM_MODEL_ID)?.accepted_media_slots,
    ['reference_image'],
  );
  // 素材位词表是封闭集合：词表外的取值被拒
  assert.equal(
    (await fetch(`${baseUrl}/api/custom-generation-models/${CUSTOM_MODEL_ID}`, {
      method: 'PUT',
      headers: writeHeaders(),
      body: JSON.stringify({ accepted_media_slots: ['not_a_slot'] }),
    })).status,
    400,
  );
  assert.equal(
    (await fetch(`${baseUrl}/api/custom-generation-models/never-declared`, {
      method: 'PUT',
      headers: writeHeaders(),
      body: JSON.stringify({ accepted_media_slots: ['reference_image'] }),
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
    body: JSON.stringify({ accepted_media_slots: ['reference_image'] }),
  });
  assert.equal(keptPut.status, 200);
  const keptModel = CustomGenerationModelResponseSchema.parse(await keptPut.json()).model;
  assert.deepEqual(keptModel.accepted_media_slots, ['reference_image']);
  assert.equal(keptModel.parameter_overrides.custom.length, 1, 'absent overrides must keep existing ones');

  // PUT 出现 = 整体替换；显式空覆盖即清空。
  const clearedPut = await fetch(`${baseUrl}/api/custom-generation-models/${CUSTOM_MODEL_ID}`, {
    method: 'PUT',
    headers: writeHeaders(),
    body: JSON.stringify({ accepted_media_slots: ['reference_image'], parameter_overrides: { official: [], custom: [] } }),
  });
  assert.equal(clearedPut.status, 200);
  const clearedModel = CustomGenerationModelResponseSchema.parse(await clearedPut.json()).model;
  assert.deepEqual(clearedModel.parameter_overrides, { official: [], custom: [] });

  // PUT 非法覆盖（别名撞保留键）→ 400 + 可读原因。
  const illegalPut = await fetch(`${baseUrl}/api/custom-generation-models/${CUSTOM_MODEL_ID}`, {
    method: 'PUT',
    headers: writeHeaders(),
    body: JSON.stringify({
      accepted_media_slots: ['reference_image'],
      parameter_overrides: { official: [{ field_key: 'size', wire_name: 'model' }], custom: [] },
    }),
  });
  assert.equal(illegalPut.status, 400);
  assert.match(await readErrorBody(illegalPut), /重名/);

  // PUT 非法覆盖（禁用素材位字段）→ 400 + 指认它是模型自带的素材输入。
  const imagePut = await fetch(`${baseUrl}/api/custom-generation-models/${CUSTOM_MODEL_ID}`, {
    method: 'PUT',
    headers: writeHeaders(),
    body: JSON.stringify({
      accepted_media_slots: ['reference_image'],
      parameter_overrides: { official: [{ field_key: 'image', enabled: false }], custom: [] },
    }),
  });
  assert.equal(imagePut.status, 400);
  assert.match(await readErrorBody(imagePut), /素材输入/);

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

void test('接口类型值域 7 个全部可写入记录：素材位按该族模板能力收口（不再人人可勾满）', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await startServer(t);
  const connectionId = await seedConnection(OPENAI_IMAGE_ADAPTER);

  // 契约值域即界面下拉顺序（顺序变化是界面行为变化，故逐值断言）
  assert.deepEqual([...GENERATION_FAMILY_ADAPTER_IDS], [
    'openai-image-v1',
    'gemini-image-interactions-v1',
    'seedance-2-0-v1',
    'veo-v1',
    'kling-text2video-v1',
    'kling-image2video-v1',
    'kling-omni-video-v1',
  ]);

  for (const familyAdapterId of GENERATION_FAMILY_ADAPTER_IDS) {
    // ① 接口类型本身全部可写入记录（值域扩容的事实不变）。
    const modelId = `adapter-${familyAdapterId}`;
    const response = await addGenerationModel(baseUrl, {
      model_id: modelId,
      connection_id: connectionId,
      family_adapter_id: familyAdapterId,
    });
    assert.equal(response.status, 200, `${familyAdapterId} 应可作为接口类型写入记录`);
    const created = CustomGenerationModelResponseSchema.parse(await response.json()).model;
    assert.equal(created.family_adapter_id, familyAdapterId);
    assert.deepEqual(created.accepted_media_slots, [], '不声明素材位即不接受任何素材');

    // ② 素材位要过族能力守卫：只有该族模板 `supportsMediaSlots` 里的素材位才放行，其余
    //    （含未就绪族的任何非空清单）一律拒绝——批次 2 曾放行任意词表内组合，正是本批要堵的洞。
    //    期望值从注册表派生，不手写「哪族支持哪几位」：逐族实现批次让支持面持续变化。
    const requestedSlots: GenerationMediaSlotId[] = ['reference_image', 'first_frame'];
    const supportedSlots = GENERATION_FAMILY_TEMPLATE_REGISTRY[familyAdapterId].supportsMediaSlots;
    const allRequestedSupported = requestedSlots.every((slot) => supportedSlots.includes(slot));
    const withSlots = await addGenerationModel(baseUrl, {
      model_id: `${modelId}-slots`,
      connection_id: connectionId,
      family_adapter_id: familyAdapterId,
      accepted_media_slots: requestedSlots,
    });
    if (allRequestedSupported) {
      assert.equal(
        withSlots.status,
        200,
        `${familyAdapterId} 的模板能表达 ${requestedSlots.join('、')}，必须放行`,
      );
    } else {
      assert.equal(
        withSlots.status,
        400,
        `${familyAdapterId} 表达不了 ${requestedSlots.filter((slot) => !supportedSlots.includes(slot)).join('、')}，必须拒绝`,
      );
    }

    // ③ 该族能力范围内的素材位必须放行（例如已就绪图像族/视频族的参考图）。
    const supportsReferenceImage = supportedSlots.includes('reference_image');
    const supported = await addGenerationModel(baseUrl, {
      model_id: `${modelId}-ref`,
      connection_id: connectionId,
      family_adapter_id: familyAdapterId,
      accepted_media_slots: ['reference_image'],
    });
    if (supportsReferenceImage) {
      assert.equal(supported.status, 200, `${familyAdapterId} 的模板能表达参考图，必须放行`);
    } else {
      assert.equal(supported.status, 400, `${familyAdapterId} 的模板表达不了参考图，必须拒绝`);
    }
  }

  // 已删除的旧 id（kling-v1）不再被接受：拆分是删名而非别名兼容
  assert.equal(
    (await addGenerationModel(baseUrl, {
      model_id: 'legacy-kling-model',
      connection_id: connectionId,
      family_adapter_id: 'kling-v1',
    })).status,
    400,
  );
});

void test('素材位 × 族能力守卫：文生视频族勾首帧被拒、openai 族勾参考图放行（批次 2 遗留风险）', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await startServer(t);
  const connectionId = await seedConnection(OPENAI_IMAGE_ADAPTER);

  // ① 可灵文生视频族：官方该端点没有任何素材输入，勾首帧必须被显式拒绝并给可读原因。
  const klingText = await addGenerationModel(baseUrl, {
    model_id: 'kling-text2video-with-frame',
    connection_id: connectionId,
    family_adapter_id: 'kling-text2video-v1',
    accepted_media_slots: ['first_frame'],
  });
  assert.equal(klingText.status, 400, '文生视频族不接受首帧图');
  // 该族模板尚未实现（注册表 pending），拒绝文案说清是「素材输入」这一类不允许，而不是笼统失败：
  // 逐族实现批次把该族转 ready 后，文案会随支持清单改成逐位指认（openai 族的用例即该形态）。
  assert.match(await readErrorBody(klingText), /素材/);
  // 记录没有落库（拒绝不是「写进去再悄悄忽略」）
  const listedAfterReject = CustomGenerationModelListResponseSchema.parse(
    await (await fetch(`${baseUrl}/api/custom-generation-models`)).json(),
  );
  assert.equal(
    listedAfterReject.models.some((model) => model.model_id === 'kling-text2video-with-frame'),
    false,
    '被拒的写入不得落库',
  );

  // ② openai-image-v1 族勾参考图必须通过（它确实是该族模板能表达的素材位）。
  const openaiRef = await addGenerationModel(baseUrl, {
    model_id: 'openai-with-reference-image',
    connection_id: connectionId,
    family_adapter_id: OPENAI_IMAGE_ADAPTER,
    accepted_media_slots: ['reference_image'],
  });
  assert.equal(openaiRef.status, 200, 'openai-image-v1 接受参考图素材位');
  assert.deepEqual(
    CustomGenerationModelResponseSchema.parse(await openaiRef.json()).model.accepted_media_slots,
    ['reference_image'],
  );

  // ③ 已就绪族的越界位同样被拒（不是「只要族 ready 就任意勾」）。
  const openaiOutOfFamily = await addGenerationModel(baseUrl, {
    model_id: 'openai-with-first-frame',
    connection_id: connectionId,
    family_adapter_id: OPENAI_IMAGE_ADAPTER,
    accepted_media_slots: ['first_frame'],
  });
  assert.equal(openaiOutOfFamily.status, 400, 'openai-image-v1 表达不了首帧图');
  assert.match(await readErrorBody(openaiOutOfFamily), /first_frame/, '已就绪族的越界位要逐位指认');
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

  // 素材位能力随描述符下发给 Hub（界面据此逐项渲染勾选框；0 位族给空数组而不是缺键）
  assert.deepEqual(
    descriptor.supports_media_slots,
    ['reference_image'],
    'openai-image-v1 只能表达参考图，描述符必须如实下发该族能力',
  );

  const missing = await fetch(`${baseUrl}/api/generation-family-templates/not-a-family`);
  assert.equal(missing.status, 404);

  // 未就绪族与未知族必须可区分：合法的接口类型但模板尚未实现 → 501（不是 404「没有这类模型」）。
  // pending 清单从注册表派生（逐族实现批次逐个转 ready，测试不手写「只有 openai 就绪」）。
  // 全部 7 族转 ready 后 pending 清单为空：此时逐个断言描述符端点可用（501 分支的覆盖由
  // 「将来新增接口类型仍先登记 pending」保证，测试不写死某族必须 pending）。
  const pendingFamilyAdapterIds = GENERATION_FAMILY_ADAPTER_IDS.filter(
    (id) => GENERATION_FAMILY_TEMPLATE_REGISTRY[id].status === 'pending',
  );
  for (const pendingFamilyAdapterId of pendingFamilyAdapterIds) {
    const pending = await fetch(
      `${baseUrl}/api/generation-family-templates/${encodeURIComponent(pendingFamilyAdapterId)}`,
    );
    assert.equal(
      pending.status,
      501,
      `${pendingFamilyAdapterId} 是合法接口类型但族模板未就绪，必须给 501 而不是 404`,
    );
  }
  const readyFamilyAdapterIds = GENERATION_FAMILY_ADAPTER_IDS.filter(
    (id) => GENERATION_FAMILY_TEMPLATE_REGISTRY[id].status === 'ready',
  );
  assert.ok(readyFamilyAdapterIds.length > 0, '至少有一个族必须已就绪');
  for (const readyFamilyAdapterId of readyFamilyAdapterIds) {
    const ready = await fetch(
      `${baseUrl}/api/generation-family-templates/${encodeURIComponent(readyFamilyAdapterId)}`,
    );
    assert.equal(ready.status, 200, `${readyFamilyAdapterId} 已就绪，描述符端点必须给 200`);
    const readyDescriptor = FamilyTemplateParameterDescriptorSchema.parse(await ready.json());
    // 描述符的素材位必须与注册表条目的能力逐位一致（单源：注册表是唯一能力事实）
    assert.deepEqual(
      readyDescriptor.supports_media_slots,
      [...GENERATION_FAMILY_TEMPLATE_REGISTRY[readyFamilyAdapterId].supportsMediaSlots],
      `${readyFamilyAdapterId} 描述符的素材位必须等于注册表条目声明的能力`,
    );
  }
});
