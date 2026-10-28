import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CustomInterfaceFormatDraftSchema } from '@iart/contracts';
import { buildInterfaceFormatFromDraft } from '../interface-format/draft-synthesis.cts';
import { listExecutableCatalogEntries } from '../model-catalog-entry.cts';
import {
  clearCacheForTest as clearActiveRouteCache,
  setActiveDeployment,
} from '../provider-connection/active-route-store.cts';
import {
  clearCacheForTest as clearConnectionCache,
  createConnection,
  setConnectionCredential,
} from '../provider-connection/connection-store.cts';
import { setCredentialForConnection } from '../provider-connection/credential-store.cts';
import {
  addCustomGenerationModel,
  clearCacheForTest as clearCustomGenerationModelCache,
} from '../provider-connection/custom-generation-model-store.cts';
import { buildExecutionSnapshot } from '../provider-connection/execution-snapshot.cts';
import {
  addInterfaceFormat,
  clearCacheForTest as clearInterfaceFormatCache,
  removeInterfaceFormat,
} from '../provider-connection/interface-format-store.cts';
import {
  addInterfaceRecipe,
  clearCacheForTest as clearInterfaceRecipeCache,
  removeInterfaceRecipe,
} from '../provider-connection/interface-recipe-store.cts';

/**
 * 用户自建接口格式模型的「可执行性 + 执行快照」（2026-10-27 生成侧适配器退场批次）。
 *
 * 钉四件事：
 * ① 自建格式（就绪 + 配方可解析）的模型判可提交，不再是 `adapter_missing`；
 * ② 执行快照冻结格式身份与**声明的鉴权形状**（含自定义 scheme），执行链不再查代码适配器；
 * ③ 配方被删后记录仍在目录里，状态是 `recipe_missing`，快照在派发前显式失败；
 * ④ 格式被删后记录仍在目录里，状态是 `format_missing`——不静默消失、不回落任何默认。
 */

const BASE_URL = 'https://user-format.example.invalid/v1';
const CREDENTIAL_VALUE = 'sk-user-format-key';
const FORMAT_ID = 'if_user_format_test';
const RECIPE_ID = 'ir_user_format_test';
const MODEL_ID = 'user-format-model';

const buildUserFormat = () => {
  const parsed = CustomInterfaceFormatDraftSchema.safeParse({
    display_name: '测试视频格式',
    submit: {
      path: '/v1/video/create',
      method: 'POST',
      payload_format: 'json',
      content_type: 'application/json',
      // 非 Bearer scheme：快照必须原样冻结，执行链不得硬编码 Bearer。
      auth: { kind: 'bearer', header_name: 'Authorization', prefix: 'Token' },
      headers: [],
      query: [],
      form_field_style: 'dotted',
      form_array_style: 'repeat',
    },
    prompt_binding: { location: 'body', path: 'prompt' },
    behavior: { result: { kind: 'direct_url', media_field_paths: ['url'], media_type: 'video' } },
  });
  assert.equal(parsed.success, true, parsed.success ? undefined : parsed.error.message);
  if (!parsed.success) throw new Error('unreachable');
  return buildInterfaceFormatFromDraft(parsed.data, { format_id: FORMAT_ID, order: 100 });
};

/** 隔离存储根 + 连接 + 自建格式 + 配方 + 模型记录（active route 指向记录）。 */
const seed = async (t: test.TestContext): Promise<{ modelId: string }> => {
  const previousRoot = process.env['IART_STORAGE_ROOT'];
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'user-format-catalog-'));
  process.env['IART_STORAGE_ROOT'] = storageRoot;
  clearConnectionCache();
  clearCustomGenerationModelCache();
  clearActiveRouteCache();
  clearInterfaceFormatCache();
  clearInterfaceRecipeCache();
  t.after(() => {
    clearConnectionCache();
    clearCustomGenerationModelCache();
    clearActiveRouteCache();
    clearInterfaceFormatCache();
    clearInterfaceRecipeCache();
    if (previousRoot === undefined) delete process.env['IART_STORAGE_ROOT'];
    else process.env['IART_STORAGE_ROOT'] = previousRoot;
    fs.rmSync(storageRoot, { recursive: true, force: true });
  });

  const formatAdd = addInterfaceFormat(buildUserFormat());
  assert.equal(formatAdd.ok, true, formatAdd.ok ? undefined : formatAdd.reason);

  const recipeAdd = addInterfaceRecipe({
    recipe_id: RECIPE_ID,
    name: '测试判定',
    family_adapter_id: FORMAT_ID,
    success_when: { op: 'in', path: 'status', value: ['completed'] },
    result: { kind: 'direct_url', media_field_paths: ['url'], media_type: 'video' },
  });
  assert.equal(recipeAdd.ok, true, recipeAdd.ok ? undefined : recipeAdd.reason);

  const connection = createConnection({ display_name: 'user-format', base_url: BASE_URL });
  const credential = await setCredentialForConnection(connection.connection_id, CREDENTIAL_VALUE);
  assert.ok(credential, 'credential should be stored');
  setConnectionCredential(connection.connection_id, credential.credentialRef, credential.version, true);

  const added = addCustomGenerationModel({
    model_id: MODEL_ID,
    connection_id: connection.connection_id,
    remote_model_id: 'veo_3_1-fast',
    family_adapter_id: FORMAT_ID,
    recipe_id: RECIPE_ID,
  });
  assert.equal(added.ok, true, added.ok ? undefined : added.reason);
  if (!added.ok) throw new Error('unreachable');
  assert.equal(setActiveDeployment(MODEL_ID, added.model.record_id), added.model.record_id);

  return { modelId: MODEL_ID };
};

void test('自建格式（就绪 + 配方可解析）：可提交，且快照冻结格式与声明的鉴权形状', async (t) => {
  const { modelId } = await seed(t);

  const entry = listExecutableCatalogEntries().find((item) => item.model_id === modelId);
  assert.ok(entry, '自建格式的模型必须出现在可执行目录里');
  if (!entry) return;
  assert.equal(entry.deployment.deployable, true, '格式就绪 + 配方可解析应判可提交');
  assert.equal(entry.deployment.failure_code, 'none');
  assert.deepEqual(entry.capability.output_modalities, ['video']);

  const snapshotResult = buildExecutionSnapshot({ modelId });
  assert.equal(snapshotResult.ok, true, snapshotResult.ok ? undefined : snapshotResult.message);
  if (!snapshotResult.ok) return;
  const protocol = snapshotResult.snapshot.protocol;
  assert.ok(protocol, '新快照必须冻结协议身份');
  if (protocol?.kind !== 'generation_format') {
    assert.fail(`协议必须是接口格式，实际: ${protocol?.kind ?? 'missing'}`);
    return;
  }
  assert.equal(protocol.format_id, FORMAT_ID);
  assert.deepEqual(
    protocol.auth,
    { kind: 'bearer', header_name: 'Authorization', prefix: 'Token' },
    '鉴权形状必须原样冻结（不得硬编码 Bearer）',
  );
});

void test('配方被删除：记录仍在目录并标 recipe_missing，快照在派发前显式失败', async (t) => {
  const { modelId } = await seed(t);
  assert.equal(removeInterfaceRecipe(RECIPE_ID), true);

  const entry = listExecutableCatalogEntries().find((item) => item.model_id === modelId);
  assert.ok(entry, '配方失效不能让记录从目录里消失');
  if (!entry) return;
  assert.equal(entry.deployment.deployable, false);
  assert.equal(entry.deployment.failure_code, 'recipe_missing');

  const snapshotResult = buildExecutionSnapshot({ modelId });
  assert.equal(snapshotResult.ok, false);
  if (snapshotResult.ok) return;
  assert.equal(snapshotResult.code, 'recipe_missing');
});

void test('格式被删除：记录仍在目录并标 format_missing，不回落任何默认', async (t) => {
  const { modelId } = await seed(t);
  assert.equal(removeInterfaceFormat(FORMAT_ID), true);

  const entry = listExecutableCatalogEntries().find((item) => item.model_id === modelId);
  assert.ok(entry, '格式被删除不能让记录从目录里消失');
  if (!entry) return;
  assert.equal(entry.deployment.deployable, false);
  assert.equal(entry.deployment.failure_code, 'format_missing');

  const snapshotResult = buildExecutionSnapshot({ modelId });
  assert.equal(snapshotResult.ok, false);
  if (snapshotResult.ok) return;
  assert.equal(snapshotResult.code, 'format_missing');
});
