import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  GENERATION_FAMILY_ADAPTER_IDS,
  InterfaceFormatDetailSchema,
  InterfaceFormatListResponseSchema,
  InterfaceRecipePathDiscoveryResponseSchema,
} from '@iart/contracts';
import { createRequestHandler } from '../router.cts';
import { loadPresetFormats } from '../interface-format/registry.cts';
import type { InterfaceFormat } from '../interface-format/schema.cts';
import {
  buildInterfaceFormatDetail,
  buildInterfaceFormatSummary,
} from '../routes/interface-format-routes.cts';
import {
  addCustomGenerationModel,
  clearCacheForTest as clearCustomGenerationModelCache,
} from '../provider-connection/custom-generation-model-store.cts';
import { clearCacheForTest as clearCustomChatModelCache } from '../provider-connection/custom-chat-model-store.cts';

/**
 * 接口格式只读路由（Hub「接口格式」页数据源，旅程设计 §1.2 / §4）。
 *
 * 覆盖：列表顺序、详情字段（同步/异步两种传输段）、未知 id 404、路径发现（响应体 + 响应头）、
 * used_by_model_count 计数口径，以及未就绪格式的投影（纯函数层；当前 8 条预设全部 ready，
 * 经 HTTP 无法构造 pending 分支——本文件末尾有一条断言钉住这个前提）。
 */

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
    throw new Error('interface_format_routes_test_address_unavailable');
  }
  return `http://127.0.0.1:${address.port}`;
};

const withIsolatedEnv = (t: test.TestContext): void => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'interface-format-routes-'));
  const previousRoot = process.env['IART_STORAGE_ROOT'];
  process.env['IART_STORAGE_ROOT'] = tempRoot;
  clearCustomGenerationModelCache();
  clearCustomChatModelCache();
  t.after(() => {
    if (previousRoot === undefined) delete process.env['IART_STORAGE_ROOT'];
    else process.env['IART_STORAGE_ROOT'] = previousRoot;
    clearCustomGenerationModelCache();
    clearCustomChatModelCache();
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
    headers: { 'content-type': 'application/json' },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  const body = text ? (JSON.parse(text) as JsonRecord) : {};
  return { status: response.status, body };
};

void test('接口格式列表：8 条、按 order 升序、每项可被 Summary 契约解析', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await startServer(t);

  const listed = await call(baseUrl, '/api/interface-formats');
  assert.equal(listed.status, 200);
  const payload = InterfaceFormatListResponseSchema.parse(listed.body);

  assert.equal(payload.formats.length, 8);
  const orders = payload.formats.map((format) => format.order);
  assert.deepEqual(orders, [...orders].sort((left, right) => left - right));
  // 预设清单快照就是界面的展示顺序；实体 order 必须与它同序。
  assert.deepEqual(
    payload.formats.map((format) => format.format_id),
    [...GENERATION_FAMILY_ADAPTER_IDS],
  );
});

void test('接口格式详情：同步格式的传输/素材位/参数/内置行为摘要', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await startServer(t);

  const response = await call(baseUrl, '/api/interface-formats/openai-image-v1');
  assert.equal(response.status, 200);
  const detail = InterfaceFormatDetailSchema.parse(response.body);

  assert.equal(detail.summary.format_id, 'openai-image-v1');
  assert.equal(detail.summary.display_name, 'OpenAI Image');
  assert.equal(detail.summary.status, 'ready');
  assert.deepEqual(detail.summary.supports_media_slots, ['reference_image']);

  assert.ok(detail.transport, 'ready 格式必须有传输段');
  assert.equal(detail.transport.auth.kind, 'bearer');
  assert.equal(detail.transport.auth.header_name, 'Authorization');
  assert.equal(detail.transport.auth.prefix, 'Bearer');
  // endpoint_key 已解析成实际相对路径，界面不展示内部键名。
  assert.equal(detail.transport.submit.path, '/v1/images/generations');
  assert.equal(detail.transport.submit.content_type, 'application/json');
  assert.equal(detail.transport.submit.payload_format, 'json');
  assert.equal(detail.transport.async, null);

  assert.deepEqual(detail.media_slots, [
    { slot_id: 'reference_image', field_key: 'image', required: false, max_files: 16, carrier: null },
  ]);

  assert.ok(detail.parameter_descriptor);
  assert.equal(detail.parameter_descriptor.family_adapter_id, 'openai-image-v1');
  assert.ok(detail.parameter_descriptor.official_fields.length > 0);

  assert.deepEqual(detail.builtin_behavior, {
    has_success_condition: true,
    // 同步格式的内置映射只声明「产物从这个字段取」，字段里是链接还是内联内容静态判不出来。
    result_form: null,
    requires_auth: false,
    failure_reason_present: false,
  });
  assert.equal(detail.used_by_model_count, 0);
});

void test('接口格式详情：异步格式的轮询段（endpoint_key 解析成路径模板）', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await startServer(t);

  const response = await call(baseUrl, '/api/interface-formats/veo-v1');
  assert.equal(response.status, 200);
  const detail = InterfaceFormatDetailSchema.parse(response.body);

  assert.ok(detail.transport);
  assert.equal(detail.transport.auth.kind, 'header_api_key');
  assert.equal(detail.transport.auth.header_name, 'x-goog-api-key');
  assert.ok(detail.transport.async, '异步格式必须有 async 段');
  assert.equal(detail.transport.async.identity_path, '/name');
  assert.equal(detail.transport.async.polling.url_template, '/v1beta/{operation_name}');
  assert.equal(detail.transport.async.polling.method, 'GET');
  assert.equal(detail.transport.async.polling.interval_ms, 10000);
  assert.equal(detail.transport.async.polling.max_attempts, 120);
  // 异步有 polling_status → 有成功判定声明；内置映射判不出链接还是内联内容。
  assert.deepEqual(detail.builtin_behavior, {
    has_success_condition: true,
    result_form: null,
    requires_auth: false,
    failure_reason_present: false,
  });
});

void test('接口格式详情：内置行为带再取一次（needs_fetch）与下载鉴权', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await startServer(t);

  const response = await call(baseUrl, '/api/interface-formats/openai-video-v1');
  assert.equal(response.status, 200);
  const detail = InterfaceFormatDetailSchema.parse(response.body);

  assert.deepEqual(detail.builtin_behavior, {
    has_success_condition: true,
    result_form: 'needs_fetch',
    requires_auth: true,
    failure_reason_present: false,
  });
});

void test('接口格式详情：未知 id → 404 且给可读原因', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await startServer(t);

  const response = await call(baseUrl, '/api/interface-formats/no-such-format-v1');
  assert.equal(response.status, 404);
  assert.equal(response.body['code'], 'not_found');
  assert.equal(response.body['message'], '没有这个接口格式');
});

void test('路径发现：响应体字段路径 + 响应头字段（同名头不重复列出）', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await startServer(t);

  const response = await call(baseUrl, '/api/interface-formats/openai-image-v1/path-discovery', {
    method: 'POST',
    body: {
      sample: JSON.stringify({
        status: 'succeeded',
        data: [{ url: 'https://cdn.example.invalid/a.png' }],
      }),
      headers: { 'X-Trace-Id': 'trace-1', status: 'header-status' },
    },
  });
  assert.equal(response.status, 200);
  const payload = InterfaceRecipePathDiscoveryResponseSchema.parse(response.body);

  const byPath = new Map(payload.paths.map((entry) => [entry.path, entry]));
  assert.equal(byPath.get('status')?.value_kind, 'string');
  assert.equal(byPath.get('status')?.value, 'succeeded');
  assert.equal(byPath.get('data')?.value_kind, 'array');
  assert.equal(byPath.get('data.0.url')?.value_kind, 'string');
  // 响应头以归一化头名（小写）进入结果，可直接填进判定路径。
  assert.equal(byPath.get('x-trace-id')?.value, 'trace-1');
  // 与响应体同名的头不产出条目（求值器优先读响应体）。
  assert.equal(byPath.get('status')?.value, 'succeeded');
  assert.equal(
    payload.paths.filter((entry) => entry.path === 'status').length,
    1,
  );
});

void test('路径发现：未知 id → 404；请求体非法 → 400', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await startServer(t);

  const unknown = await call(baseUrl, '/api/interface-formats/nope-v1/path-discovery', {
    method: 'POST',
    body: { sample: { a: 1 } },
  });
  assert.equal(unknown.status, 404);

  const invalid = await call(baseUrl, '/api/interface-formats/openai-image-v1/path-discovery', {
    method: 'POST',
    body: { headers: { a: 'b' } },
  });
  assert.equal(invalid.status, 400);

  const extraKey = await call(baseUrl, '/api/interface-formats/openai-image-v1/path-discovery', {
    method: 'POST',
    body: { sample: {}, unexpected: true },
  });
  assert.equal(extraKey.status, 400);
});

void test('used_by_model_count：2 条记录命中 1 条', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await startServer(t);

  const imageRecord = addCustomGenerationModel({
    model_id: 'fmt-count-image',
    connection_id: 'up_conn_fmt_count',
    family_adapter_id: 'openai-image-v1',
    remote_model_id: 'remote-image',
  });
  assert.equal(imageRecord.ok, true);
  const veoRecord = addCustomGenerationModel({
    model_id: 'fmt-count-veo',
    connection_id: 'up_conn_fmt_count',
    family_adapter_id: 'veo-v1',
    remote_model_id: 'remote-veo',
  });
  assert.equal(veoRecord.ok, true);

  const imageDetail = InterfaceFormatDetailSchema.parse(
    (await call(baseUrl, '/api/interface-formats/openai-image-v1')).body,
  );
  const veoDetail = InterfaceFormatDetailSchema.parse(
    (await call(baseUrl, '/api/interface-formats/veo-v1')).body,
  );
  const textDetail = InterfaceFormatDetailSchema.parse(
    (await call(baseUrl, '/api/interface-formats/kling-text2video-v1')).body,
  );

  assert.equal(imageDetail.used_by_model_count, 1);
  assert.equal(veoDetail.used_by_model_count, 1);
  assert.equal(textDetail.used_by_model_count, 0);
});

void test('未就绪格式的投影：只给身份摘要，其余段落为 null / 空数组', () => {
  const presets = loadPresetFormats();
  // 前提：当前随软件分发的 8 条预设全部 ready，因此经 HTTP 无法构造 pending 分支；
  // 该分支由下面的纯函数投影覆盖。将来出现真实 pending 预设时，应改走路由级断言。
  assert.ok(
    presets.every((preset) => preset.status === 'ready'),
    '当前不应存在 pending 预设：若新增了 pending 预设，请把本用例改成路由级 pending 断言',
  );

  const ready = presets.find((preset) => preset.format_id === 'openai-image-v1');
  assert.ok(ready, 'openai-image-v1 预设应存在');
  const pending: InterfaceFormat = { ...ready, status: 'pending' };

  const summary = buildInterfaceFormatSummary(pending);
  assert.equal(summary.status, 'pending');
  assert.deepEqual(summary.supports_media_slots, []);
  assert.deepEqual(summary.required_media_slots, []);

  const detail = buildInterfaceFormatDetail(pending, 3);
  assert.equal(detail.summary.status, 'pending');
  assert.equal(detail.transport, null);
  assert.deepEqual(detail.media_slots, []);
  assert.equal(detail.parameter_descriptor, null);
  assert.equal(detail.builtin_behavior, null);
  assert.equal(detail.used_by_model_count, 3);
});
