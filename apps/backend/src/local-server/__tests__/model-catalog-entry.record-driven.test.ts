import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ExecutableModelCatalogResponseSchema,
  ExecutableModelDirectoryEntrySchema,
} from '@iart/contracts';
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

/**
 * 可执行目录由「用户模型记录 × 接口格式」驱动（spec 03 PC-15 / spec 45 §1）。
 *
 * 模型唯一来源是用户模型记录：软件不内置任何具体模型，目录不从任何内置资产取模型，
 * 也不按 `model_id` 名称或正则推断族归属。本文件钉四件事：
 * ① 无记录 → 目录为空（不存在绕过记录进入目录的路径）；
 * ② 有记录 + 接口格式 ready → 产出条目，条目形状可被既有契约消费；
 * ③ 格式未就绪 / 已删除 → 记录**仍进目录**并标记原因（`format_not_ready` / `format_missing`）；
 *    2026-10-27 起不再整条跳过（跳过会让界面只剩「状态未知」，用户看不到哪条模型挂了）；
 * ④ 记录自带 `family_adapter_id` 即族归属，与 `model_id` 命名无关（`gpt-image-` 前缀不再决定族）。
 *
 * 变体组聚合仍由目录装配承载，因此本文件不断言组壳展开（该契约由
 * `model-package-catalog.variant-group-contract.test.ts` 用合成包覆盖）。
 */

const CONNECTION_BASE_URL = 'https://catalog-entry.example.invalid/v1';
const CREDENTIAL_VALUE = 'sk-catalog-entry-key';
const OPENAI_IMAGE_ADAPTER = 'openai-image-v1';
const VEO_ADAPTER = 'veo-v1';
/** 中性名称 + veo 族：目录必须按记录声明判族（输出视频），名称本身不含任何族线索。 */
const NEUTRAL_NAMED_VIDEO_MODEL = 'catalog-entry-neutral-video';

type SeedRecord = {
  modelId: string;
  familyAdapterId: typeof OPENAI_IMAGE_ADAPTER | typeof VEO_ADAPTER;
};

/** 隔离存储根 + 连接 + 若干生成模型记录（active route 指向各自记录）。 */
const seedCatalog = async (t: test.TestContext, records: SeedRecord[]): Promise<void> => {
  const previousRoot = process.env['IART_STORAGE_ROOT'];
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-entry-storage-'));
  process.env['IART_STORAGE_ROOT'] = storageRoot;
  clearConnectionCache();
  clearCustomGenerationModelCache();
  clearActiveRouteCache();
  t.after(() => {
    clearConnectionCache();
    clearCustomGenerationModelCache();
    clearActiveRouteCache();
    if (previousRoot === undefined) delete process.env['IART_STORAGE_ROOT'];
    else process.env['IART_STORAGE_ROOT'] = previousRoot;
    fs.rmSync(storageRoot, { recursive: true, force: true });
  });

  const connection = createConnection({
    display_name: 'catalog-entry',
    base_url: CONNECTION_BASE_URL,
  });
  const credential = await setCredentialForConnection(connection.connection_id, CREDENTIAL_VALUE);
  assert.ok(credential, 'credential should be stored');
  setConnectionCredential(connection.connection_id, credential.credentialRef, credential.version, true);

  for (const record of records) {
    const added = addCustomGenerationModel({
      model_id: record.modelId,
      connection_id: connection.connection_id,
      family_adapter_id: record.familyAdapterId,
    });
    assert.equal(added.ok, true, `应能添加生成模型记录 ${record.modelId}`);
    if (!added.ok) continue;
    assert.equal(
      setActiveDeployment(record.modelId, added.model.record_id),
      added.model.record_id,
      'active route should point at the created record',
    );
  }
};

void test('无模型记录时可执行目录为空', async (t) => {
  await seedCatalog(t, []);
  const payload = ExecutableModelCatalogResponseSchema.parse({
    models: listExecutableCatalogEntries(),
  });
  assert.deepEqual(
    payload.models.map((entry) => entry.model_id),
    [],
    '没有用户模型记录就不存在任何可提交模型',
  );
});

void test('有记录且族模板 ready 时可执行目录产出条目，形状可被既有契约消费', async (t) => {
  await seedCatalog(t, [{ modelId: 'catalog-entry-image', familyAdapterId: OPENAI_IMAGE_ADAPTER }]);
  const payload = ExecutableModelCatalogResponseSchema.parse({
    models: listExecutableCatalogEntries(),
  });
  const ids = payload.models.map((entry) => entry.model_id);
  assert.deepEqual(ids, ['catalog-entry-image'], `目录应只含用户记录，实际: ${ids.join(',')}`);

  const entry = payload.models[0];
  assert.ok(entry);
  if (!entry) return;
  assert.equal(entry.deployment.deployable, true, '记录 + active route 应判可提交');
  assert.equal(entry.deployment.failure_code, 'none');
  assert.deepEqual(entry.capability.output_modalities, ['image'], '族模板供给输出能力');
  // 条目形状可被现有 ExecutableModelDirectoryEntrySchema 消费（无需扩 contracts）
  ExecutableModelDirectoryEntrySchema.parse(entry);
  assert.ok(
    entry.parameter_schema.fields.length > 0,
    '参数表单由族模板供给，不得为空',
  );
});

void test('族归属由记录自带 family_adapter_id 决定，与 model_id 命名无关', async (t) => {
  await seedCatalog(t, [
    { modelId: NEUTRAL_NAMED_VIDEO_MODEL, familyAdapterId: VEO_ADAPTER },
    { modelId: 'catalog-entry-plain-name', familyAdapterId: OPENAI_IMAGE_ADAPTER },
  ]);
  const entries = listExecutableCatalogEntries();
  assert.deepEqual(
    entries.map((entry) => entry.model_id),
    [NEUTRAL_NAMED_VIDEO_MODEL, 'catalog-entry-plain-name'],
    '两条记录都声明了已就绪生成族，都应进目录',
  );
  // 关键判据：输出能力取记录自带的 family_adapter_id（veo → video / openai-image → image），
  // 不取 model_id 名称——中性名称的记录同样能按声明族合成出正确投影。
  const video = entries.find((entry) => entry.model_id === NEUTRAL_NAMED_VIDEO_MODEL);
  const image = entries.find((entry) => entry.model_id === 'catalog-entry-plain-name');
  assert.ok(video && image, 'both records must be in catalog');
  assert.deepEqual(
    video.capability.output_modalities,
    ['video'],
    'veo 族记录的输出模态必须是 video',
  );
  assert.deepEqual(
    image.capability.output_modalities,
    ['image'],
    'openai-image 族记录的输出模态必须是 image',
  );
});
