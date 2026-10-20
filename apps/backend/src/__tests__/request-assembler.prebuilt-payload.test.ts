import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  clearCacheForTest as clearActiveRouteCache,
  setActiveDeployment,
} from '../local-server/provider-connection/active-route-store.cts';
import {
  clearCacheForTest as clearConnectionCache,
  createConnection,
  setConnectionCredential,
} from '../local-server/provider-connection/connection-store.cts';
import { setCredentialForConnection } from '../local-server/provider-connection/credential-store.cts';
import {
  addCustomGenerationModel,
  clearCacheForTest as clearCustomGenerationModelCache,
} from '../local-server/provider-connection/custom-generation-model-store.cts';

/**
 * 请求组装的两条本地失败/直通路径。
 *
 * 模型唯一来源是用户模型记录（spec 03 PC-15）：本文件不依赖任何内置资产文件，
 * 而是按需在隔离存储根里建一条生成模型记录（记录自带 `family_adapter_id`，参数表单与请求规则
 * 由该族模板供给）。这样「模型可用与否」只由记录决定，测试与包目录内容无关。
 */

const CONNECTION_BASE_URL = 'https://assembler.example.invalid/v1';
const CREDENTIAL_VALUE = 'sk-assembler-prebuilt-key';
const IMAGE_MODEL_ID = 'assembler-prebuilt-image';
const VIDEO_MODEL_ID = 'assembler-prebuilt-video';

/** 隔离存储根 + 一条连接 + 一条生成模型记录（active route 指向该记录）。 */
const seedGenerationModel = async (
  t: test.TestContext,
  params: { modelId: string; familyAdapterId: 'openai-image-v1' | 'kling-text2video-v1' },
): Promise<void> => {
  const previousRoot = process.env['IART_STORAGE_ROOT'];
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'assembler-prebuilt-storage-'));
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
    display_name: 'assembler-prebuilt',
    base_url: CONNECTION_BASE_URL,
  });
  const credential = await setCredentialForConnection(connection.connection_id, CREDENTIAL_VALUE);
  assert.ok(credential, 'credential should be stored');
  setConnectionCredential(connection.connection_id, credential.credentialRef, credential.version, true);
  const record = addCustomGenerationModel({
    model_id: params.modelId,
    connection_id: connection.connection_id,
    family_adapter_id: params.familyAdapterId,
  });
  assert.equal(record.ok, true, `应能添加生成模型记录 ${params.modelId}`);
  if (!record.ok) return;
  assert.equal(
    setActiveDeployment(params.modelId, record.model.record_id),
    record.model.record_id,
    'active route should point at the created record',
  );
};

void test('assembleExecutionPlanFromPrebuiltPayload: multipart payload 不再重放 extractFirstFile transform', async (t) => {
  await seedGenerationModel(t, { modelId: IMAGE_MODEL_ID, familyAdapterId: 'openai-image-v1' });
  const { assembleExecutionPlanFromPrebuiltPayload } = await import('../local-server/request-assembler.cts');

  const serializedFormData = {
    __formData: {
      fields: [
        { name: 'model', value: IMAGE_MODEL_ID },
        { name: 'prompt', value: 'hello world' },
        { name: 'size', value: '1024x1024' },
      ],
      files: [
        {
          name: 'image',
          filename: 'reference.png',
          contentType: 'image/png',
          dataBase64: Buffer.from('mock-image').toString('base64'),
        },
      ],
    },
  };

  const assembled = await assembleExecutionPlanFromPrebuiltPayload(
    {
      model_id: IMAGE_MODEL_ID,
      payload: {
        body: serializedFormData,
        api: {
          endpoint: '/v1/images/edits',
          method: 'POST',
          contentType: null,
        },
      },
    },
    {
      projectPath: null,
      baseDir: process.cwd(),
    },
  );

  assert.equal(assembled.executionPlan.model_id, IMAGE_MODEL_ID);
  assert.equal(assembled.executionPlan.submit_request.method, 'POST');
  assert.equal(assembled.executionPlan.submit_request.headers['content-type'], undefined);
  assert.deepEqual(assembled.executionPlan.submit_request.body, serializedFormData);
  assert.match(assembled.executionPlan.submit_request.url, /\/v1\/images\/edits$/);
});

void test('assembleGenerationTaskRequest: 可灵文生视频记录缺 prompt 时本地失败', async (t) => {
  await seedGenerationModel(t, { modelId: VIDEO_MODEL_ID, familyAdapterId: 'kling-text2video-v1' });
  const { assembleGenerationTaskRequest } = await import('../local-server/request-assembler.cts');

  await assert.rejects(
    () =>
      assembleGenerationTaskRequest(
        {
          model_id: VIDEO_MODEL_ID,
          arguments: {},
        },
        {
          projectPath: null,
          baseDir: process.cwd(),
        },
      ),
    /请填写提示词。/,
  );
});
