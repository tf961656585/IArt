import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  INTERFACE_RECIPE_ID_PATTERN,
  type InterfaceRecipe,
} from '@iart/contracts';
import { getStoragePaths } from '../storage.cts';
import {
  addInterfaceRecipe,
  clearCacheForTest,
  getInterfaceRecipe,
  listInterfaceRecipes,
  onInterfaceRecipesChanged,
  removeInterfaceRecipe,
  updateInterfaceRecipe,
} from '../provider-connection/interface-recipe-store.cts';

/**
 * 接口配方公共库 store（docs/custom-providers/接口配方-design.md §4/§7/§9）。
 *
 * 覆盖：CRUD 与 id 生成、`.strict()` 解析（未知键整条丢弃）、损坏条目录入丢弃、
 * 重复 id 丢弃、变更通知只代表落盘成功。
 */

const buildRecipe = (overrides: Partial<InterfaceRecipe> = {}): InterfaceRecipe => ({
  recipe_id: 'ir_test',
  name: '测试配方',
  family_adapter_id: 'openai-image-v1',
  success_when: { op: 'eq', path: 'status', value: 'succeeded' },
  result: { kind: 'direct_url', media_field_paths: ['data.0.url'], media_type: 'image' },
  requires_auth: false,
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(),
  ...overrides,
});

const withIsolatedStore = (t: test.TestContext): { storageRoot: string } => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'interface-recipe-store-'));
  const previousRoot = process.env['IART_STORAGE_ROOT'];
  process.env['IART_STORAGE_ROOT'] = root;
  clearCacheForTest();
  t.after(() => {
    if (previousRoot === undefined) delete process.env['IART_STORAGE_ROOT'];
    else process.env['IART_STORAGE_ROOT'] = previousRoot;
    clearCacheForTest();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { storageRoot: root };
};

void test('store: CRUD round-trip with generated recipe_id', (t) => {
  withIsolatedStore(t);
  let notified = 0;
  const unsubscribe = onInterfaceRecipesChanged(() => {
    notified += 1;
  });
  t.after(unsubscribe);

  const added = addInterfaceRecipe({
    name: '直接返回链接',
    family_adapter_id: 'openai-image-v1',
    success_when: { op: 'eq', path: 'status', value: 'succeeded' },
    result: { kind: 'direct_url', media_field_paths: ['data.0.url'], media_type: 'image' },
  });
  assert.equal(added.ok, true);
  if (!added.ok) return;
  assert.match(added.recipe.recipe_id, INTERFACE_RECIPE_ID_PATTERN);
  assert.equal(added.recipe.requires_auth, false);
  assert.equal(notified, 1, 'one file commit = one change notification');

  // 显式 id + 可选段。
  const second = addInterfaceRecipe({
    recipe_id: 'ir_explicit',
    name: '需要再取一次',
    family_adapter_id: 'veo-v1',
    success_when: { op: 'eq', path: 'done', value: true },
    failure_when: { op: 'eq', path: 'status', value: 'failed' },
    result: {
      kind: 'needs_fetch',
      identity_field_path: 'name',
      content_url_template: '/v1/videos/{id}/content',
      accept: 'binary',
      media_type: 'video',
    },
    requires_auth: true,
  });
  assert.equal(second.ok, true);

  assert.equal(listInterfaceRecipes().length, 2);
  const fetched = getInterfaceRecipe('ir_explicit');
  assert.ok(fetched);
  assert.equal(fetched.requires_auth, true);
  assert.deepEqual(fetched.failure_when, { op: 'eq', path: 'status', value: 'failed' });

  const updated = updateInterfaceRecipe('ir_explicit', {
    name: '改名后的配方',
    success_when: { op: 'in', path: 'state', value: ['done', 'succeeded'] },
  });
  assert.equal(updated.ok, true);
  if (!updated.ok) return;
  assert.equal(updated.recipe.name, '改名后的配方');
  assert.equal(updated.recipe.family_adapter_id, 'veo-v1', 'family cannot be changed by update');
  assert.deepEqual(updated.recipe.success_when, { op: 'in', path: 'state', value: ['done', 'succeeded'] });
  assert.deepEqual(updated.recipe.failure_when, fetched.failure_when, 'omitted fields keep old value');

  assert.equal(removeInterfaceRecipe('ir_explicit'), true);
  assert.equal(getInterfaceRecipe('ir_explicit'), null);
  assert.equal(removeInterfaceRecipe('ir_explicit'), false);
  assert.equal(listInterfaceRecipes().length, 1);
  // 每次成功落盘一次通知（add ×2 + update ×1 + remove ×1）：投影失效链依赖它。
  assert.equal(notified, 4);
});

// 2026-10-26：新增可选 failure_reason（用户可读的失败原因）。
// 旧文件没有该字段必须照常解析（可选、无默认值），新字段能写入并能用 null 清除。
void test('store: optional failure_reason round-trip and legacy records still parse', (t) => {
  withIsolatedStore(t);
  const storagePaths = getStoragePaths();

  const added = addInterfaceRecipe({
    recipe_id: 'ir_reason',
    name: '带失败原因',
    family_adapter_id: 'openai-image-v1',
    success_when: { op: 'eq', path: 'status', value: 'succeeded' },
    failure_when: { op: 'eq', path: 'status', value: 'failed' },
    failure_reason: '服务商判定内容不合规，请修改提示词后重试。',
    result: { kind: 'direct_url', media_field_paths: ['url'], media_type: 'image' },
  });
  assert.equal(added.ok, true);
  if (!added.ok) return;
  assert.equal(added.recipe.failure_reason, '服务商判定内容不合规，请修改提示词后重试。');
  assert.equal(getInterfaceRecipe('ir_reason')?.failure_reason, '服务商判定内容不合规，请修改提示词后重试。');

  // null = 清除该键（与 failure_when 同口径），不写 null。
  const cleared = updateInterfaceRecipe('ir_reason', { failure_reason: null });
  assert.equal(cleared.ok, true);
  if (!cleared.ok) return;
  assert.equal(Object.prototype.hasOwnProperty.call(cleared.recipe, 'failure_reason'), false);

  // 旧文件没有该字段：整条照常解析，不因缺字段被丢弃。
  fs.mkdirSync(storagePaths.config, { recursive: true });
  fs.writeFileSync(
    storagePaths.interfaceRecipes,
    JSON.stringify({
      version: 1,
      updatedAt: new Date(0).toISOString(),
      recipes: [buildRecipe({ recipe_id: 'ir_legacy' })],
    }),
    'utf-8',
  );
  clearCacheForTest();
  const legacy = getInterfaceRecipe('ir_legacy');
  assert.ok(legacy, '旧记录缺 failure_reason 时必须保留');
  assert.equal(Object.prototype.hasOwnProperty.call(legacy, 'failure_reason'), false);
});

void test('store: duplicate recipe_id is rejected', (t) => {
  withIsolatedStore(t);
  const first = addInterfaceRecipe({
    recipe_id: 'ir_dup',
    name: '第一份',
    family_adapter_id: 'openai-image-v1',
    success_when: { op: 'eq', path: 'status', value: 'ok' },
    result: { kind: 'direct_url', media_field_paths: ['url'], media_type: 'image' },
  });
  assert.equal(first.ok, true);
  const duplicate = addInterfaceRecipe({
    recipe_id: 'ir_dup',
    name: '第二份',
    family_adapter_id: 'openai-image-v1',
    success_when: { op: 'eq', path: 'status', value: 'ok' },
    result: { kind: 'direct_url', media_field_paths: ['url'], media_type: 'image' },
  });
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.equal(duplicate.reason, 'already_exists');
  assert.equal(listInterfaceRecipes().length, 1);
});

void test('store: strict parse drops records with unknown keys, non-objects and duplicates', (t) => {
  withIsolatedStore(t);
  const storagePaths = getStoragePaths();
  fs.mkdirSync(storagePaths.config, { recursive: true });
  const valid = buildRecipe({ recipe_id: 'ir_valid' });
  const withUnknownKey = { ...buildRecipe({ recipe_id: 'ir_unknown' }), legacy_key: true };
  const duplicate = buildRecipe({ recipe_id: 'ir_valid', name: '重复' });
  const file = {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    recipes: [valid, withUnknownKey, duplicate, 42, null],
  };
  fs.writeFileSync(storagePaths.interfaceRecipes, JSON.stringify(file), 'utf-8');
  clearCacheForTest();

  const recipes = listInterfaceRecipes();
  assert.equal(recipes.length, 1, 'only the first valid record survives');
  assert.equal(recipes[0]?.recipe_id, 'ir_valid');
});

void test('store: unsupported file version is treated as an empty library', (t) => {
  withIsolatedStore(t);
  const storagePaths = getStoragePaths();
  fs.mkdirSync(storagePaths.config, { recursive: true });
  fs.writeFileSync(
    storagePaths.interfaceRecipes,
    JSON.stringify({ version: 999, updatedAt: new Date(0).toISOString(), recipes: [buildRecipe()] }),
    'utf-8',
  );
  clearCacheForTest();
  assert.deepEqual(listInterfaceRecipes(), []);
});

void test('store: missing file means empty library without error', (t) => {
  withIsolatedStore(t);
  assert.deepEqual(listInterfaceRecipes(), []);
  assert.equal(getInterfaceRecipe('ir_missing'), null);
  assert.equal(updateInterfaceRecipe('ir_missing', { name: 'x' }).ok, false);
  assert.equal(removeInterfaceRecipe('ir_missing'), false);
});
