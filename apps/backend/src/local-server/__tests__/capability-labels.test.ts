// @spec: OF-12, OF-13, OF-14
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CAPABILITY_LABELS_MAX_COUNT,
  CustomGenerationModelSchema,
  CustomInterfaceFormatSubmitDraftSchema,
} from '@iart/contracts';
import {
  clearCacheForTest as clearConnectionCache,
  createConnection,
  setConnectionCredential,
} from '../provider-connection/connection-store.cts';
import { setCredentialForConnection } from '../provider-connection/credential-store.cts';
import {
  addCustomGenerationModel,
  clearCacheForTest as clearModelCache,
  getCustomGenerationModel,
  updateCustomGenerationModel,
} from '../provider-connection/custom-generation-model-store.cts';

/**
 * 能力标签的写入侧契约（spec 48 §4/§5）。
 *
 * 钉四件事：
 * ① 归属唯一（OF-12）：模型记录承载标签；接口格式草稿是 strict schema，带该键直接解析失败，
 *    证明格式侧无法承载/派生同一事实；
 * ② 约束（OF-13）：最多 10 条、单条去首尾空白后 1–12 个字符、空串与换行被拒；
 * ③ 修改语义（OF-14）：缺省保持现有、出现即整体替换、空数组清空；
 * ④ 去重：完全相同去重、保留首次出现顺序，不做大小写或同义归一。
 */

const CONNECTION_BASE_URL = 'https://capability-labels.example.invalid/v1';
const CREDENTIAL_VALUE = 'sk-capability-labels-key';
const FAMILY_ADAPTER_ID = 'openai-image-v1';

type Store = {
  connectionId: string;
};

/** 隔离存储根 + 一条可用连接（标签测试不碰接口格式内容，只要族就绪即可）。 */
const seedStore = async (t: test.TestContext): Promise<Store> => {
  const previousRoot = process.env['IART_STORAGE_ROOT'];
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-labels-storage-'));
  process.env['IART_STORAGE_ROOT'] = storageRoot;
  clearConnectionCache();
  clearModelCache();
  t.after(() => {
    clearConnectionCache();
    clearModelCache();
    if (previousRoot === undefined) delete process.env['IART_STORAGE_ROOT'];
    else process.env['IART_STORAGE_ROOT'] = previousRoot;
    fs.rmSync(storageRoot, { recursive: true, force: true });
  });

  const connection = createConnection({
    display_name: 'capability-labels',
    base_url: CONNECTION_BASE_URL,
  });
  const credential = await setCredentialForConnection(connection.connection_id, CREDENTIAL_VALUE);
  assert.ok(credential, 'credential should be stored');
  setConnectionCredential(connection.connection_id, credential.credentialRef, credential.version, true);
  return { connectionId: connection.connection_id };
};

const addModel = (
  store: Store,
  modelId: string,
  labels?: string[],
): void => {
  const added = addCustomGenerationModel({
    model_id: modelId,
    connection_id: store.connectionId,
    family_adapter_id: FAMILY_ADAPTER_ID,
    ...(labels === undefined ? {} : { capability_labels: labels }),
  });
  assert.equal(added.ok, true, `应能添加生成模型记录 ${modelId}`);
};

void test('接口格式草稿不承载能力标签：带该键的草稿解析失败（OF-12）', () => {
  const parsed = CustomInterfaceFormatSubmitDraftSchema.safeParse({
    display_name: '携带标签的格式',
    submit: {
      path: '/v1/images',
      method: 'POST',
      payload_format: 'json',
      content_type: 'application/json',
      auth: { kind: 'bearer' },
    },
    prompt_binding: { location: 'body', path: 'prompt' },
    behavior: { kind: 'sync' },
    capability_labels: ['静态图'],
  });
  assert.equal(parsed.success, false, '接口格式草稿是 strict schema，能力标签只能归模型记录');
});

void test('创建时原样保存标签，重复项去重且保留首次顺序（OF-13）', async (t) => {
  const store = await seedStore(t);
  addModel(store, 'labels-created', ['静态图', '动图', '静态图']);
  const record = getCustomGenerationModel('labels-created');
  assert.ok(record);
  assert.deepEqual(record.capability_labels, ['静态图', '动图']);
});

void test('不填标签时记录为未标注（空数组），旧配置缺键同样能读（OF-14）', async (t) => {
  const store = await seedStore(t);
  addModel(store, 'labels-absent');
  const record = getCustomGenerationModel('labels-absent');
  assert.ok(record);
  assert.deepEqual(record.capability_labels, []);
  // `.strict()` + `.default([])`：历史配置文件没有该键时也不该整条解析失败。
  const parsed = CustomGenerationModelSchema.parse({ ...record, capability_labels: undefined });
  assert.deepEqual(parsed.capability_labels, []);
});

void test('标签约束在写入侧拒绝：超量、超长、空串、换行（OF-13）', () => {
  const base = {
    model_id: 'labels-invalid',
    record_id: 'up_dep_labels_invalid',
    connection_id: 'conn-1',
    remote_model_id: 'labels-invalid',
    family_adapter_id: FAMILY_ADAPTER_ID,
    accepted_media_slots: [],
    parameter_overrides: { official: [], custom: [] },
    created_at: new Date(0).toISOString(),
  };
  const tooMany = Array.from({ length: CAPABILITY_LABELS_MAX_COUNT + 1 }, (_, index) => `标签${index}`);
  assert.equal(CustomGenerationModelSchema.safeParse({ ...base, capability_labels: tooMany }).success, false);
  assert.equal(CustomGenerationModelSchema.safeParse({ ...base, capability_labels: ['这是一个超过十二个字的标签内容'] }).success, false);
  assert.equal(CustomGenerationModelSchema.safeParse({ ...base, capability_labels: ['   '] }).success, false);
  assert.equal(CustomGenerationModelSchema.safeParse({ ...base, capability_labels: ['第一行\n第二行'] }).success, false);
  // 恰好 10 条、恰好 12 字：边界内可用。
  assert.equal(
    CustomGenerationModelSchema.safeParse({
      ...base,
      capability_labels: Array.from({ length: CAPABILITY_LABELS_MAX_COUNT }, (_, index) => `第${index}条标签`),
    }).success,
    true,
  );
  assert.equal(CustomGenerationModelSchema.safeParse({ ...base, capability_labels: ['十二个字的标签正常'] }).success, true);
});

void test('修改语义：缺省保持、出现即整体替换、空数组清空（OF-14）', async (t) => {
  const store = await seedStore(t);
  addModel(store, 'labels-updated', ['静态图']);

  // 缺省（不传该键）：保持现有标签不变。
  const kept = updateCustomGenerationModel('labels-updated', { accepted_media_slots: [] });
  assert.equal(kept.ok, true);
  if (!kept.ok) return;
  assert.deepEqual(kept.model.capability_labels, ['静态图']);

  // 出现：整体替换。
  const replaced = updateCustomGenerationModel('labels-updated', {
    accepted_media_slots: [],
    capability_labels: ['动图', '矢量图', '动图'],
  });
  assert.equal(replaced.ok, true);
  if (!replaced.ok) return;
  assert.deepEqual(replaced.model.capability_labels, ['动图', '矢量图']);

  // 空数组：清空为未标注。
  const cleared = updateCustomGenerationModel('labels-updated', {
    accepted_media_slots: [],
    capability_labels: [],
  });
  assert.equal(cleared.ok, true);
  if (!cleared.ok) return;
  assert.deepEqual(cleared.model.capability_labels, []);
});
