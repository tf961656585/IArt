import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CustomInterfaceFormatWriteResponseSchema,
  HUB_LOCAL_WRITE_TOKEN_ENV,
  HUB_LOCAL_WRITE_TOKEN_HEADER,
} from '@iart/contracts';
import { createRequestHandler } from '../router.cts';
import { assembleGenerationTaskRequest } from '../request-assembler.cts';
import { buildDeclaredGenerationProjection } from '../generation-declaration-projection.cts';
import { listExecutableCatalogEntries } from '../model-catalog-entry.cts';
import { clearCacheForTest as clearInterfaceFormatCache } from '../provider-connection/interface-format-store.cts';
import { clearCacheForTest as clearInterfaceRecipeCache } from '../provider-connection/interface-recipe-store.cts';
import {
  clearCacheForTest as clearCustomGenerationModelCache,
  getCustomGenerationModel,
} from '../provider-connection/custom-generation-model-store.cts';
import { clearCacheForTest as clearCustomChatModelCache } from '../provider-connection/custom-chat-model-store.cts';
import {
  clearCacheForTest as clearActiveRouteCache,
} from '../provider-connection/active-route-store.cts';
import {
  clearCacheForTest as clearConnectionCache,
  createConnection,
  setConnectionCredential,
} from '../provider-connection/connection-store.cts';
import { setCredentialForConnection } from '../provider-connection/credential-store.cts';

/**
 * 用户自建接口格式主链接缝（2026-10-26 批次 B5a）。
 *
 * 使命：用真实实现把「Hub 提交草稿」到「模型目录条目可用」整条链跑一遍，只在最外层用假上游
 * 地址（不发任何请求）：
 * 1. 草稿经真实路由 `POST /api/interface-formats` → 真实 store 落盘 → 真实合成实体 + 配方；
 * 2. 模型记录经真实路由 `POST /api/custom-generation-models` 写入（必填配方由上一段生成）；
 * 3. 投影走真实 `buildDeclaredGenerationProjection`（提示词 / 参数 / 请求规则全部由实体合成）；
 * 4. 目录条目走真实 `listExecutableCatalogEntries`（准入判据 = 格式已就绪）。
 *
 * 覆盖的是「各层各自全绿但主链已断」那类裂缝：格式写入后能否真的被记录、投影与目录消费。
 */

const HUB_WRITE_TOKEN = 's'.repeat(32);
const UPSTREAM_BASE_URL = 'https://user-format-upstream.example.invalid';

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
    throw new Error('interface_format_seam_test_address_unavailable');
  }
  return `http://127.0.0.1:${address.port}`;
};

const withIsolatedEnv = (t: test.TestContext): void => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'interface-format-seam-'));
  const previousToken = process.env[HUB_LOCAL_WRITE_TOKEN_ENV];
  const previousRoot = process.env['IART_STORAGE_ROOT'];
  process.env[HUB_LOCAL_WRITE_TOKEN_ENV] = HUB_WRITE_TOKEN;
  process.env['IART_STORAGE_ROOT'] = tempRoot;
  clearInterfaceFormatCache();
  clearInterfaceRecipeCache();
  clearCustomGenerationModelCache();
  clearCustomChatModelCache();
  clearConnectionCache();
  clearActiveRouteCache();
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
    clearActiveRouteCache();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
};

const call = async (
  baseUrl: string,
  pathname: string,
  options: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: JsonRecord }> => {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      [HUB_LOCAL_WRITE_TOKEN_HEADER]: HUB_WRITE_TOKEN,
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  const body = text ? (JSON.parse(text) as JsonRecord) : {};
  return { status: response.status, body };
};

const readObject = (value: unknown, message: string): JsonRecord => {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), message);
  return value as JsonRecord;
};

void test('seam: 草稿 → 创建 → 记录写入 → 合成投影 → 目录条目可用', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await startServer(t);

  const created = await call(baseUrl, '/api/interface-formats', {
    method: 'POST',
    body: {
      display_name: '接缝自定义图像接口',
      submit: {
        path: '/v1/custom/generate',
        method: 'POST',
        payload_format: 'json',
        content_type: 'application/json',
        auth: { kind: 'bearer', header_name: 'Authorization', prefix: 'Bearer' },
        headers: [],
        query: [],
        form_field_style: 'dotted',
        form_array_style: 'repeat',
      },
      model_binding: { location: 'body', path: 'model' },
      parameters: [
        {
          binding: { location: 'body', path: 'size' },
          label: '画面尺寸',
          type: 'string',
          required: false,
          default_value: '1024x1024',
        },
        {
          binding: { location: 'body', path: 'quality' },
          label: '画质',
          type: 'enum',
          required: true,
          enum_values: ['low', 'high'],
        },
      ],
      prompt_binding: { location: 'body', path: 'prompt' },
      behavior: {
        failure_when: { op: 'not_empty', path: 'error.message' },
        failure_reason: '接口返回了错误',
        result: { kind: 'direct_url', media_field_paths: ['data.0.url'], media_type: 'image' },
      },
    },
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const formatPayload = CustomInterfaceFormatWriteResponseSchema.parse(created.body);

  const connection = createConnection({ display_name: 'seam-user-format-connection', base_url: UPSTREAM_BASE_URL });
  const credential = await setCredentialForConnection(connection.connection_id, 'sk-seam-user-format');
  assert.ok(credential);
  setConnectionCredential(connection.connection_id, credential.credentialRef, credential.version, true);

  const modelResponse = await call(baseUrl, '/api/custom-generation-models', {
    method: 'POST',
    body: {
      model_id: 'seam-user-format-model',
      connection_id: connection.connection_id,
      family_adapter_id: formatPayload.format_id,
      recipe_id: formatPayload.recipe_id,
    },
  });
  assert.equal(modelResponse.status, 200, JSON.stringify(modelResponse.body));

  const record = getCustomGenerationModel('seam-user-format-model');
  assert.ok(record, '记录应已落盘');
  assert.equal(record.family_adapter_id, formatPayload.format_id);
  assert.equal(record.recipe_id, formatPayload.recipe_id);

  // 合成投影（真实链路：格式 → sources → 配方 → CatalogProjection）。
  const built = buildDeclaredGenerationProjection(record);
  assert.ok(built, '自定义格式的投影必须能构建');
  const projection = built.projection;
  assert.equal(projection.group_key, 'custom');
  assert.equal(projection.execution_profile.task_type, 'image');
  const runtime = readObject(projection.runtime, 'projection runtime');
  assert.equal(runtime['provider_id'], 'custom');
  assert.equal(runtime['default_task_type'], 'image');
  assert.deepEqual(Object.keys(readObject(runtime['payload_rules'], 'payload rules')).sort(), [
    'api.contentType',
    'api.endpoint',
    'api.method',
    'body.model',
    'body.prompt',
    'body.quality',
    'body.size',
  ]);
  const rules = readObject(runtime['payload_rules'], 'payload rules');
  assert.deepEqual(rules['api.endpoint'], { kind: 'literal', value: '/v1/custom/generate' });
  assert.deepEqual(rules['api.method'], { kind: 'literal', value: 'POST' });
  assert.deepEqual(rules['api.contentType'], { kind: 'literal', value: 'application/json' });
  assert.deepEqual(rules['body.model'], { kind: 'literal', value: 'seam-user-format-model' });
  const promptRule = readObject(rules['body.prompt'], 'prompt rule');
  assert.equal(promptRule['kind'], 'field');
  assert.equal(promptRule['field_key'], '__prompt');
  assert.deepEqual(promptRule['transforms'], ['trim']);
  // 参数内部键是合成稳定键（p<序号>）：binding 的请求体路径不是参数身份。
  assert.equal(readObject(rules['body.size'], 'size rule')['field_key'], 'p0');
  assert.equal(readObject(rules['body.quality'], 'quality rule')['field_key'], 'p1');
  assert.deepEqual(projection.prompt_field, {
    field_key: '__prompt',
    required: true,
    validation_rules: [],
  });
  assert.deepEqual(
    projection.parameter_schema.fields.map((field) => field.field_key),
    ['p0', 'p1'],
  );
  assert.deepEqual(projection.parameter_schema.required_fields, ['p1']);
  assert.equal(projection.task_execution_plan?.request_strategy.endpoint, '/v1/custom/generate');
  // 判定来自创建的配方，而不是格式内置默认（自定义格式没有内置行为）。
  assert.deepEqual(projection.task_execution_plan?.result_rule.success_condition, {
    op: 'exists',
    path: 'data.0.url',
  });
  const mappingRules = projection.task_execution_plan?.result_output_mapping?.output_mapping_rules ?? [];
  assert.equal(mappingRules.length > 0, true, '结果映射必须由配方提供');

  // 目录条目：准入判据是「格式已就绪」，用户格式与预设走同一条路径。
  const entries = listExecutableCatalogEntries();
  const entry = entries.find((item) => item.model_id === 'seam-user-format-model');
  assert.ok(entry, '写入记录后目录条目必须可用');
  assert.equal(entry.default_task_type, 'image');
  assert.deepEqual(entry.capability.output_modalities, ['image']);
  assert.equal(entry.parameter_schema.fields.some((field) => field.fieldKey === 'p1'), true);
  assert.equal(
    entry.parameter_schema.fields.some((field) => field.fieldKey === '__prompt'),
    false,
    '提示词不是参数，目录参数表不能出现保留键',
  );
  assert.equal(entry.deployment.has_active_deployment, true);

  // 历史草稿可能把保留键当参数存下来；运行时只接受顶层 prompt，不能让它从 arguments 漏出去。
  const staleArguments = { __prompt: '旧参数里的提示词', p0: '1024x1024', p1: 'high' };
  const assembledWithEmptyPrompt = await assembleGenerationTaskRequest(
    { model_id: 'seam-user-format-model', prompt: '', arguments: staleArguments },
    { projectPath: null, baseDir: null },
  );
  const emptyPromptBody = (assembledWithEmptyPrompt as {
    executionPlan: { submit_request: { body: JsonRecord } };
  }).executionPlan.submit_request.body;
  assert.equal('prompt' in emptyPromptBody, false, '文字区为空时不能发送参数里的旧 __prompt');

  const assembledWithPrompt = await assembleGenerationTaskRequest(
    { model_id: 'seam-user-format-model', prompt: '新的提示词', arguments: staleArguments },
    { projectPath: null, baseDir: null },
  );
  const promptBody = (assembledWithPrompt as {
    executionPlan: { submit_request: { body: JsonRecord } };
  }).executionPlan.submit_request.body;
  assert.equal(promptBody['prompt'], '新的提示词', '顶层 prompt 必须是唯一提示词来源');
});
