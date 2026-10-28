import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CustomInterfaceFormatRemovalResponseSchema,
  CustomInterfaceFormatWriteResponseSchema,
  HUB_LOCAL_WRITE_TOKEN_ENV,
  HUB_LOCAL_WRITE_TOKEN_HEADER,
  InterfaceFormatDetailSchema,
  InterfaceFormatListResponseSchema,
  InterfaceRecipeListResponseSchema,
} from '@iart/contracts';
import { createRequestHandler } from '../router.cts';
import { loadAllFormats, loadPresetFormats } from '../interface-format/registry.cts';
import { clearCacheForTest as clearInterfaceFormatCache } from '../provider-connection/interface-format-store.cts';
import { clearCacheForTest as clearInterfaceRecipeCache } from '../provider-connection/interface-recipe-store.cts';
import {
  addCustomGenerationModel,
  clearCacheForTest as clearCustomGenerationModelCache,
} from '../provider-connection/custom-generation-model-store.cts';
import { clearCacheForTest as clearCustomChatModelCache } from '../provider-connection/custom-chat-model-store.cts';
import {
  clearCacheForTest as clearConnectionCache,
  createConnection,
  setConnectionCredential,
} from '../provider-connection/connection-store.cts';
import { setCredentialForConnection } from '../provider-connection/credential-store.cts';

/**
 * 接口格式写路由（2026-10-26 批次 B5a）。
 *
 * 覆盖：创建返回 format_id + recipe_id + detail、列表/详情能看到用户格式（预设仍 8 条）、
 * 更新（id 不可改、预设不可改、绑定配方同步改名）、删除后 404、写策略（无 token 403）、
 * 非法路径 400，以及记录写入对「自定义格式必须有同族配方」的拒绝。
 */

const HUB_WRITE_TOKEN = 'f'.repeat(32);
const BASE_URL = 'https://format-upstream.example.invalid';

type JsonRecord = Record<string, unknown>;

const startServer = async (t: test.TestContext): Promise<string> => {
  const server = http.createServer(createRequestHandler());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address();
  if (address == null || typeof address === 'string') {
    throw new Error('interface_format_write_routes_test_address_unavailable');
  }
  return `http://127.0.0.1:${address.port}`;
};

const withIsolatedEnv = (t: test.TestContext): void => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'interface-format-write-'));
  const previousToken = process.env[HUB_LOCAL_WRITE_TOKEN_ENV];
  const previousRoot = process.env['IART_STORAGE_ROOT'];
  process.env[HUB_LOCAL_WRITE_TOKEN_ENV] = HUB_WRITE_TOKEN;
  process.env['IART_STORAGE_ROOT'] = tempRoot;
  clearInterfaceFormatCache();
  clearInterfaceRecipeCache();
  clearCustomGenerationModelCache();
  clearCustomChatModelCache();
  clearConnectionCache();
  t.after(() => {
    if (previousToken === undefined) delete process.env[HUB_LOCAL_WRITE_TOKEN_ENV];
    else process.env[HUB_LOCAL_WRITE_TOKEN_ENV] = previousToken;
    if (previousRoot === undefined) delete process.env['IART_STORAGE_ROOT'];
    else process.env['IART_STORAGE_ROOT'] = previousRoot;
    clearInterfaceFormatCache();
    clearInterfaceRecipeCache();
    clearCustomGenerationModelCache();
    clearCustomChatModelCache();
    clearConnectionCache();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
};

const call = async (
  baseUrl: string,
  pathname: string,
  options: { method?: string; body?: unknown; withToken?: boolean } = {},
): Promise<{ status: number; body: JsonRecord }> => {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(options.withToken === false ? {} : { [HUB_LOCAL_WRITE_TOKEN_HEADER]: HUB_WRITE_TOKEN }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  const body = text ? (JSON.parse(text) as JsonRecord) : {};
  return { status: response.status, body };
};

const BASE_DRAFT: JsonRecord = {
  display_name: '我的图像接口',
  submit: {
    path: '/v1/generate',
    method: 'POST',
    payload_format: 'json',
    content_type: 'application/json',
    auth: { kind: 'bearer', header_name: 'Authorization', prefix: 'Bearer' },
    headers: [],
    query: [],
    form_field_style: 'dotted',
    form_array_style: 'repeat',
  },
  parameters: [
    { binding: { location: 'body', path: 'size' }, label: '画面尺寸', type: 'string', required: false },
  ],
  prompt_binding: { location: 'body', path: 'prompt' },
  behavior: {
    result: { kind: 'direct_url', media_field_paths: ['data.0.url'], media_type: 'image' },
  },
};

void test('routes: 创建 → 列表/详情可见 → 更新 → 删除后 404', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await startServer(t);

  // 写策略：没有 Hub write token 的创建请求被拒（403）。
  const unguarded = await call(baseUrl, '/api/interface-formats', {
    method: 'POST',
    body: BASE_DRAFT,
    withToken: false,
  });
  assert.equal(unguarded.status, 403);

  const created = await call(baseUrl, '/api/interface-formats', { method: 'POST', body: BASE_DRAFT });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const createdPayload = CustomInterfaceFormatWriteResponseSchema.parse(created.body);
  assert.match(createdPayload.format_id, /^if_/);
  assert.match(createdPayload.recipe_id, /^ir_/);
  assert.equal(createdPayload.detail.summary.display_name, '我的图像接口');
  assert.equal(createdPayload.detail.transport?.submit.path, '/v1/generate');
  assert.equal(createdPayload.detail.parameter_descriptor !== null, true);
  assert.equal(createdPayload.detail.used_by_model_count, 0);

  // 列表：预设 8 条 + 用户 1 条，用户格式在末尾（order 100 递增）。
  const listed = await call(baseUrl, '/api/interface-formats');
  assert.equal(listed.status, 200);
  const listedPayload = InterfaceFormatListResponseSchema.parse(listed.body);
  assert.equal(listedPayload.formats.length, 9);
  assert.equal(listedPayload.formats[8]?.format_id, createdPayload.format_id);
  assert.equal(loadPresetFormats().length, 8, '预设快照仍为 8 条');
  assert.equal(loadAllFormats().length, 9);

  // 详情。
  const detail = await call(baseUrl, `/api/interface-formats/${createdPayload.format_id}`);
  assert.equal(detail.status, 200);
  InterfaceFormatDetailSchema.parse(detail.body);

  // 配方：创建时生成的判定配方，族与格式同 id，名字带「判定」。
  const recipes = await call(baseUrl, '/api/interface-recipes');
  const recipePayload = InterfaceRecipeListResponseSchema.parse(recipes.body);
  assert.equal(recipePayload.recipes.length, 1);
  assert.equal(recipePayload.recipes[0]?.recipe_id, createdPayload.recipe_id);
  assert.equal(recipePayload.recipes[0]?.family_adapter_id, createdPayload.format_id);
  assert.equal(recipePayload.recipes[0]?.name, '我的图像接口 判定');

  // 更新：改显示名与参数；绑定配方同步更新。
  const updated = await call(baseUrl, `/api/interface-formats/${createdPayload.format_id}`, {
    method: 'PUT',
    body: {
      ...BASE_DRAFT,
      display_name: '改名后的接口',
      parameters: [
        {
          binding: { location: 'body', path: 'quality' },
          label: '画质',
          type: 'enum',
          required: true,
          enum_values: ['low', 'high'],
        },
      ],
    },
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  const updatedPayload = CustomInterfaceFormatWriteResponseSchema.parse(updated.body);
  assert.equal(updatedPayload.format_id, createdPayload.format_id);
  assert.equal(updatedPayload.recipe_id, createdPayload.recipe_id, '更新复用同一份配方');
  assert.equal(updatedPayload.detail.summary.display_name, '改名后的接口');
  // 参数内部键是合成的稳定键（p<序号>）；界面按显示名与发出名称识别这一行。
  const qualityField = updatedPayload.detail.parameter_descriptor?.official_fields.find(
    (field) => field.label === '画质',
  );
  assert.ok(qualityField);
  assert.equal(qualityField.wire_name, 'quality');
  assert.equal(qualityField.wire_location, 'body');
  assert.equal(qualityField.component, 'select');
  assert.deepEqual(qualityField.enum_options, ['low', 'high']);

  const recipesAfterUpdate = await call(baseUrl, '/api/interface-recipes');
  const recipeAfterUpdate = InterfaceRecipeListResponseSchema.parse(recipesAfterUpdate.body);
  assert.equal(recipeAfterUpdate.recipes[0]?.name, '改名后的接口 判定');

  // 更新时改 id → 409。
  const idChange = await call(baseUrl, `/api/interface-formats/${createdPayload.format_id}`, {
    method: 'PUT',
    body: { ...BASE_DRAFT, format_id: 'if_another_id' },
  });
  assert.equal(idChange.status, 409);

  // 更新预设 → 409。
  const presetUpdate = await call(baseUrl, '/api/interface-formats/openai-image-v1', {
    method: 'PUT',
    body: BASE_DRAFT,
  });
  assert.equal(presetUpdate.status, 409);

  // 删除：不级联删配方；删后详情 404。
  const removed = await call(baseUrl, `/api/interface-formats/${createdPayload.format_id}`, {
    method: 'DELETE',
  });
  assert.equal(removed.status, 200);
  assert.deepEqual(
    CustomInterfaceFormatRemovalResponseSchema.parse(removed.body),
    { removed_format_id: createdPayload.format_id },
  );
  const afterDelete = await call(baseUrl, `/api/interface-formats/${createdPayload.format_id}`);
  assert.equal(afterDelete.status, 404);
  const recipesAfterDelete = await call(baseUrl, '/api/interface-recipes');
  assert.equal(InterfaceRecipeListResponseSchema.parse(recipesAfterDelete.body).recipes.length, 1);

  // 删除预设 → 409。
  const presetDelete = await call(baseUrl, '/api/interface-formats/openai-image-v1', { method: 'DELETE' });
  assert.equal(presetDelete.status, 409);
});

void test('routes: 非法请求路径 / 重复 id 被拒，失败不留下半份格式或配方', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await startServer(t);

  const absolute = await call(baseUrl, '/api/interface-formats', {
    method: 'POST',
    body: { ...BASE_DRAFT, submit: { ...(BASE_DRAFT['submit'] as JsonRecord), path: 'https://api.example.com/x' } },
  });
  assert.equal(absolute.status, 400);
  assert.equal(loadAllFormats().length, 8, '校验失败不落格式');

  const explicitId = await call(baseUrl, '/api/interface-formats', {
    method: 'POST',
    body: { ...BASE_DRAFT, format_id: 'if_explicit_one' },
  });
  assert.equal(explicitId.status, 200);
  const duplicate = await call(baseUrl, '/api/interface-formats', {
    method: 'POST',
    body: { ...BASE_DRAFT, format_id: 'if_explicit_one' },
  });
  assert.equal(duplicate.status, 409);

  const presetId = await call(baseUrl, '/api/interface-formats', {
    method: 'POST',
    body: { ...BASE_DRAFT, format_id: 'openai-image-v1' },
  });
  assert.equal(presetId.status, 409);
});

void test('记录写入：自定义格式缺配方 / 错配配方 / 清除配方均被拒，配同族配方可写', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await startServer(t);

  const created = await call(baseUrl, '/api/interface-formats', { method: 'POST', body: BASE_DRAFT });
  assert.equal(created.status, 200);
  const createdPayload = CustomInterfaceFormatWriteResponseSchema.parse(created.body);

  const connection = createConnection({ display_name: 'format-test-connection', base_url: BASE_URL });
  const credential = await setCredentialForConnection(connection.connection_id, 'sk-format-test');
  assert.ok(credential);
  setConnectionCredential(connection.connection_id, credential.credentialRef, credential.version, true);

  const modelBody = (extra: JsonRecord = {}): JsonRecord => ({
    model_id: 'format-model',
    connection_id: connection.connection_id,
    family_adapter_id: createdPayload.format_id,
    ...extra,
  });

  // 缺配方：store 与路由都拒绝（路由先挡）。
  const noRecipe = await call(baseUrl, '/api/custom-generation-models', { method: 'POST', body: modelBody() });
  assert.equal(noRecipe.status, 400);
  assert.match(String(noRecipe.body['message'] ?? ''), /配方/);

  // store 侧同一份拒绝（纵深防御）。
  const storeNoRecipe = addCustomGenerationModel({
    model_id: 'format-model-direct',
    connection_id: connection.connection_id,
    family_adapter_id: createdPayload.format_id,
  });
  assert.equal(storeNoRecipe.ok, false);
  if (storeNoRecipe.ok) return;
  assert.equal(storeNoRecipe.reason, 'recipe_reference_invalid');
  assert.match(storeNoRecipe.message, /配方/);

  // 错配：拿一份预设格式的配方来引用。
  const presetRecipe = await call(baseUrl, '/api/interface-recipes', {
    method: 'POST',
    body: {
      name: '别的格式的配方',
      family_adapter_id: 'openai-image-v1',
      success_when: { op: 'eq', path: 'status', value: 'succeeded' },
      result: { kind: 'direct_url', media_field_paths: ['data.0.url'], media_type: 'image' },
    },
  });
  assert.equal(presetRecipe.status, 200);
  const presetRecipeId = String((presetRecipe.body['recipe'] as JsonRecord)['recipe_id']);
  const mismatched = await call(baseUrl, '/api/custom-generation-models', {
    method: 'POST',
    body: modelBody({ recipe_id: presetRecipeId }),
  });
  assert.equal(mismatched.status, 400);
  assert.match(String(mismatched.body['message'] ?? ''), /不一致/);

  // 正确引用：写入成功且目录条目可用（投影由真实合成链路构建）。
  const accepted = await call(baseUrl, '/api/custom-generation-models', {
    method: 'POST',
    body: modelBody({ recipe_id: createdPayload.recipe_id }),
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));

  // 清除配方（三态 null）被拒。
  const cleared = await call(baseUrl, '/api/custom-generation-models/format-model', {
    method: 'PUT',
    body: { accepted_media_slots: [], recipe_id: null },
  });
  assert.equal(cleared.status, 400);
  assert.match(String(cleared.body['message'] ?? ''), /不能清除/);
});
