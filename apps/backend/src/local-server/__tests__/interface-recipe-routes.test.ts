import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  HUB_LOCAL_WRITE_TOKEN_ENV,
  HUB_LOCAL_WRITE_TOKEN_HEADER,
  InterfaceRecipeListResponseSchema,
  InterfaceRecipeRemovalResponseSchema,
  InterfaceRecipeResponseSchema,
} from '@iart/contracts';
import { createRequestHandler } from '../router.cts';
import {
  addCustomGenerationModel,
  clearCacheForTest as clearCustomGenerationModelCache,
  getCustomGenerationModel,
} from '../provider-connection/custom-generation-model-store.cts';
import { clearCacheForTest as clearInterfaceRecipeCache } from '../provider-connection/interface-recipe-store.cts';

/**
 * 接口配方路由（docs/custom-providers/接口配方-design.md §7/§8）。
 *
 * 覆盖：CRUD 主路径与错误路径、试跑三态与产物抽取、路径发现、Hub write token 守卫，
 * 以及记录侧引用校验（存在且族一致）能拒绝非法引用。
 */

const HUB_WRITE_TOKEN = 'r'.repeat(32);

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
    throw new Error('interface_recipe_routes_test_address_unavailable');
  }
  return `http://127.0.0.1:${address.port}`;
};

const withIsolatedEnv = (t: test.TestContext): void => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'interface-recipe-routes-'));
  const previousToken = process.env[HUB_LOCAL_WRITE_TOKEN_ENV];
  const previousRoot = process.env['IART_STORAGE_ROOT'];
  process.env[HUB_LOCAL_WRITE_TOKEN_ENV] = HUB_WRITE_TOKEN;
  process.env['IART_STORAGE_ROOT'] = tempRoot;
  clearInterfaceRecipeCache();
  clearCustomGenerationModelCache();
  t.after(() => {
    if (previousToken === undefined) delete process.env[HUB_LOCAL_WRITE_TOKEN_ENV];
    else process.env[HUB_LOCAL_WRITE_TOKEN_ENV] = previousToken;
    if (previousRoot === undefined) delete process.env['IART_STORAGE_ROOT'];
    else process.env['IART_STORAGE_ROOT'] = previousRoot;
    clearInterfaceRecipeCache();
    clearCustomGenerationModelCache();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
};

const buildHeaders = (withToken: boolean): Record<string, string> => ({
  'content-type': 'application/json',
  ...(withToken ? { [HUB_LOCAL_WRITE_TOKEN_HEADER]: HUB_WRITE_TOKEN } : {}),
});

const call = async (
  baseUrl: string,
  pathname: string,
  options: { method?: string; body?: unknown; withToken?: boolean } = {},
): Promise<{ status: number; body: JsonRecord }> => {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method ?? 'GET',
    headers: buildHeaders(options.withToken ?? true),
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  const body = text ? (JSON.parse(text) as JsonRecord) : {};
  return { status: response.status, body };
};

const CREATE_BODY = {
  name: '直接返回链接',
  family_adapter_id: 'openai-image-v1',
  success_when: { op: 'eq', path: 'status', value: 'succeeded' },
  failure_when: { op: 'eq', path: 'status', value: 'failed' },
  result: { kind: 'direct_url', media_field_paths: ['data.0.url'], media_type: 'image' },
  requires_auth: false,
};

void test('routes: create -> list -> update -> dry-run -> path-discovery -> delete', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await startServer(t);

  // create
  const created = await call(baseUrl, '/api/interface-recipes', { method: 'POST', body: CREATE_BODY });
  assert.equal(created.status, 200);
  const createdPayload = InterfaceRecipeResponseSchema.parse(created.body);
  const recipeId = createdPayload.recipe.recipe_id;
  assert.match(recipeId, /^ir_/);

  // list
  const listed = await call(baseUrl, '/api/interface-recipes');
  assert.equal(listed.status, 200);
  const listedPayload = InterfaceRecipeListResponseSchema.parse(listed.body);
  assert.equal(listedPayload.recipes.length, 1);
  assert.equal(listedPayload.recipes[0]?.recipe_id, recipeId);

  // update（族不可改；只提交名字与判定）
  const updated = await call(baseUrl, `/api/interface-recipes/${recipeId}`, {
    method: 'PUT',
    body: {
      name: '改名后的配方',
      success_when: { op: 'in', path: 'status', value: ['succeeded', 'done'] },
    },
  });
  assert.equal(updated.status, 200);
  const updatedPayload = InterfaceRecipeResponseSchema.parse(updated.body);
  assert.equal(updatedPayload.recipe.name, '改名后的配方');
  assert.equal(updatedPayload.recipe.family_adapter_id, 'openai-image-v1');
  assert.deepEqual(updatedPayload.recipe.success_when, {
    op: 'in',
    path: 'status',
    value: ['succeeded', 'done'],
  });

  // dry-run: success（样本以 JSON 字符串形式粘入）
  const successSample = JSON.stringify({
    status: 'succeeded',
    data: [{ url: 'https://cdn.example.invalid/a.png' }],
  });
  const successRun = await call(baseUrl, '/api/interface-recipes/dry-run', {
    method: 'POST',
    body: { sample: successSample, draft: { recipe_id: recipeId } },
  });
  assert.equal(successRun.status, 200);
  assert.equal(successRun.body['verdict'], 'success');
  const matched = successRun.body['matched'];
  assert.ok(Array.isArray(matched));
  assert.ok((matched as { path: string }[]).some((item) => item.path === 'status'));
  const outputs = successRun.body['outputs'];
  assert.ok(Array.isArray(outputs));
  assert.deepEqual((outputs as { url?: string; media_type: string }[])[0], {
    media_type: 'image',
    url: 'https://cdn.example.invalid/a.png',
    source_path: 'data.0.url',
  });
  assert.ok(!(successRun.body['unseen_paths'] as string[]).includes('data.0.url'));

  // dry-run: failure
  const failureRun = await call(baseUrl, '/api/interface-recipes/dry-run', {
    method: 'POST',
    body: { sample: { status: 'failed' }, draft: { recipe_id: recipeId } },
  });
  assert.equal(failureRun.status, 200);
  assert.equal(failureRun.body['verdict'], 'failure');

  // dry-run: pending
  const pendingRun = await call(baseUrl, '/api/interface-recipes/dry-run', {
    method: 'POST',
    body: { sample: { status: 'running' }, draft: { recipe_id: recipeId } },
  });
  assert.equal(pendingRun.status, 200);
  assert.equal(pendingRun.body['verdict'], 'pending');
  assert.ok((pendingRun.body['unseen_paths'] as string[]).includes('data.0.url'));

  // path discovery（JSON 字符串样本）
  const discovery = await call(baseUrl, '/api/interface-recipes/path-discovery', {
    method: 'POST',
    body: { sample: successSample },
  });
  assert.equal(discovery.status, 200);
  const paths = discovery.body['paths'] as { path: string; value_kind: string }[];
  const byPath = new Map(paths.map((item) => [item.path, item.value_kind]));
  assert.equal(byPath.get('status'), 'string');
  assert.equal(byPath.get('data'), 'array');
  assert.equal(byPath.get('data.0'), 'object');
  assert.equal(byPath.get('data.0.url'), 'string');

  // delete
  const removed = await call(baseUrl, `/api/interface-recipes/${recipeId}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.deepEqual(InterfaceRecipeRemovalResponseSchema.parse(removed.body), {
    removed_recipe_id: recipeId,
  });
  const afterDelete = await call(baseUrl, '/api/interface-recipes');
  assert.deepEqual(InterfaceRecipeListResponseSchema.parse(afterDelete.body).recipes, []);
});

void test('routes: invalid recipe bodies are rejected with readable reasons', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await startServer(t);

  // needs_fetch 地址模板缺 {id}
  const invalid = await call(baseUrl, '/api/interface-recipes', {
    method: 'POST',
    body: {
      name: '缺占位符',
      family_adapter_id: 'veo-v1',
      success_when: { op: 'exists', path: 'done' },
      result: {
        kind: 'needs_fetch',
        identity_field_path: 'name',
        content_url_template: '/v1/operations/content',
        accept: 'binary',
        media_type: 'video',
      },
    },
  });
  assert.equal(invalid.status, 400);
  assert.ok(String(invalid.body['message']).includes('{id}'));

  // 成功与失败条件对同一路径同一取值
  const conflicting = await call(baseUrl, '/api/interface-recipes', {
    method: 'POST',
    body: {
      ...CREATE_BODY,
      success_when: { op: 'eq', path: 'status', value: 'done' },
      failure_when: { op: 'eq', path: 'status', value: 'done' },
    },
  });
  assert.equal(conflicting.status, 400);
  assert.ok(String(conflicting.body['message']).includes('互相矛盾'));

  // 未知族
  const unknownFamily = await call(baseUrl, '/api/interface-recipes', {
    method: 'POST',
    body: { ...CREATE_BODY, family_adapter_id: 'not-a-family' },
  });
  assert.equal(unknownFamily.status, 400);

  // 404 更新 / 删除
  const missingUpdate = await call(baseUrl, '/api/interface-recipes/ir_missing', {
    method: 'PUT',
    body: { name: 'x' },
  });
  assert.equal(missingUpdate.status, 404);
  const missingDelete = await call(baseUrl, '/api/interface-recipes/ir_missing', { method: 'DELETE' });
  assert.equal(missingDelete.status, 404);

  // 试跑缺完整配方
  const incompleteDryRun = await call(baseUrl, '/api/interface-recipes/dry-run', {
    method: 'POST',
    body: { sample: { status: 'ok' }, draft: { name: '只有名字' } },
  });
  assert.equal(incompleteDryRun.status, 400);
});

void test('routes: write routes reject requests without the Hub write token', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await startServer(t);

  const create = await call(baseUrl, '/api/interface-recipes', {
    method: 'POST',
    body: CREATE_BODY,
    withToken: false,
  });
  assert.equal(create.status, 403);
  const dryRun = await call(baseUrl, '/api/interface-recipes/dry-run', {
    method: 'POST',
    body: { sample: {}, draft: {} },
    withToken: false,
  });
  assert.equal(dryRun.status, 403);
  // GET 只读不加守卫
  const list = await call(baseUrl, '/api/interface-recipes', { withToken: false });
  assert.equal(list.status, 200);
});

void test('record side: referencing a missing or family-mismatched recipe is rejected', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await startServer(t);
  const created = await call(baseUrl, '/api/interface-recipes', { method: 'POST', body: CREATE_BODY });
  assert.equal(created.status, 200);
  const recipe = InterfaceRecipeResponseSchema.parse(created.body).recipe;

  // 配方不存在
  const missing = addCustomGenerationModel({
    model_id: 'recipe-missing-model',
    connection_id: 'conn-x',
    family_adapter_id: 'openai-image-v1',
    recipe_id: 'ir_does_not_exist',
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.reason, 'recipe_reference_invalid');
    assert.ok(missing.message.includes('不存在'));
  }

  // 族不一致（配方 = openai-image-v1，记录 = veo-v1）
  const mismatched = addCustomGenerationModel({
    model_id: 'recipe-mismatch-model',
    connection_id: 'conn-x',
    family_adapter_id: 'veo-v1',
    recipe_id: recipe.recipe_id,
  });
  assert.equal(mismatched.ok, false);
  if (!mismatched.ok) {
    assert.equal(mismatched.reason, 'recipe_reference_invalid');
    assert.ok(mismatched.message.includes('不一致'));
  }

  // 正常引用
  const accepted = addCustomGenerationModel({
    model_id: 'recipe-accepted-model',
    connection_id: 'conn-x',
    family_adapter_id: 'openai-image-v1',
    recipe_id: recipe.recipe_id,
  });
  assert.equal(accepted.ok, true);
  const stored = getCustomGenerationModel('recipe-accepted-model');
  assert.equal(stored?.recipe_id, recipe.recipe_id);
});

void test('routes: failure_reason is persisted on create and can be cleared with null', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await startServer(t);

  const created = await call(baseUrl, '/api/interface-recipes', {
    method: 'POST',
    body: {
      ...CREATE_BODY,
      failure_reason: '这段内容被服务商拒绝了，改一下提示词再试。',
    },
  });
  assert.equal(created.status, 200);
  const createdRecipe = InterfaceRecipeResponseSchema.parse(created.body).recipe;
  assert.equal(createdRecipe.failure_reason, '这段内容被服务商拒绝了，改一下提示词再试。');

  // 重新读盘：原因进入持久化文件，不是只在内存态。
  clearInterfaceRecipeCache();
  const listed = await call(baseUrl, '/api/interface-recipes');
  assert.equal(listed.status, 200);
  const persisted = InterfaceRecipeListResponseSchema.parse(listed.body).recipes[0];
  assert.ok(persisted);
  assert.equal(persisted.failure_reason, '这段内容被服务商拒绝了，改一下提示词再试。');

  const cleared = await call(baseUrl, `/api/interface-recipes/${createdRecipe.recipe_id}`, {
    method: 'PUT',
    body: { failure_reason: null },
  });
  assert.equal(cleared.status, 200);
  const clearedRecipe = InterfaceRecipeResponseSchema.parse(cleared.body).recipe;
  assert.equal(
    Object.prototype.hasOwnProperty.call(clearedRecipe, 'failure_reason'),
    false,
    'clear removes the key instead of storing null',
  );
});

void test('routes: PUT with failure_when: null clears the key and leaves success judgment intact', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await startServer(t);

  const created = await call(baseUrl, '/api/interface-recipes', { method: 'POST', body: CREATE_BODY });
  assert.equal(created.status, 200);
  const recipeId = InterfaceRecipeResponseSchema.parse(created.body).recipe.recipe_id;

  const cleared = await call(baseUrl, `/api/interface-recipes/${recipeId}`, {
    method: 'PUT',
    body: { failure_when: null },
  });
  assert.equal(cleared.status, 200);
  const clearedRecipe = InterfaceRecipeResponseSchema.parse(cleared.body).recipe;
  assert.equal(
    Object.prototype.hasOwnProperty.call(clearedRecipe, 'failure_when'),
    false,
    'clear removes the key instead of storing null',
  );
  assert.deepEqual(clearedRecipe.success_when, CREATE_BODY.success_when, 'success judgment untouched');

  // 重新读盘（清 store 缓存后从磁盘重建）：持久化文件里同样没有该键，不是只清了内存态。
  clearInterfaceRecipeCache();
  const listed = await call(baseUrl, '/api/interface-recipes');
  assert.equal(listed.status, 200);
  const fetched = InterfaceRecipeListResponseSchema.parse(listed.body).recipes[0];
  assert.ok(fetched);
  assert.equal(Object.prototype.hasOwnProperty.call(fetched, 'failure_when'), false);

  // 成功判定不受影响：命中成功条件仍判成功。
  const successRun = await call(baseUrl, '/api/interface-recipes/dry-run', {
    method: 'POST',
    body: { sample: { status: 'succeeded' }, draft: { recipe_id: recipeId } },
  });
  assert.equal(successRun.status, 200);
  assert.equal(successRun.body['verdict'], 'success');

  // 失败条件已清除：原先命中 failure_when 的样本现在退回「继续等待」。
  const failureRun = await call(baseUrl, '/api/interface-recipes/dry-run', {
    method: 'POST',
    body: { sample: { status: 'failed' }, draft: { recipe_id: recipeId } },
  });
  assert.equal(failureRun.status, 200);
  assert.equal(failureRun.body['verdict'], 'pending');
});
