import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assembleGenerationTaskRequest,
  buildExecutionPlanFromPayload,
} from '../request-assembler.cts';
import { executeHttpTask } from '../task-engine-http.cts';
import {
  BASE_URL,
  CREDENTIAL,
  createFormat,
  installFetch,
  jsonResponse,
  readBackendLog,
  readRecord,
  seedModelForFormat,
  startRouterServer,
  withIsolatedEnv,
} from './custom-format-wire.seam-helpers';

/**
 * 纯文本请求体（`payload_format = 'text'`）执行链接缝（2026-10-27 批次）。
 *
 * 使命：证明「提示词原文就是整个请求体」这条声明在真实链路上成立——
 * 真实格式写入 → 真实合成投影 → 真实装配 → 真实 executeHttpTask → 假 HTTP 上游
 * 捕获到的正文必须是原文（不是 JSON 字符串、不是 `{"prompt":...}`），Content-Type 为
 * 契约默认的 `text/plain; charset=utf-8`，同时声明在 query / header 上的参数仍照常发出。
 *
 * 防御用例：投影里错误地出现请求体参数规则或正文不是字符串时，装配期必须显式失败并给出
 * 可读错误——纯文本格式没有可命名的正文字段，静默丢弃会把错误推到上游。
 */

// ---------------------------------------------------------------------------
// 7. 纯文本请求体：整段提示词作为正文，query/header 参数照常发出
// ---------------------------------------------------------------------------

void test('纯文本提交接缝：提示词原文就是请求体（非 JSON）+ text/plain + query/header 参数', async (t) => {
  const storageRoot = withIsolatedEnv(t);
  const baseUrl = await startRouterServer(t);
  const promptText = '用一句话介绍海豚的生活习性。';
  const format = await createFormat(baseUrl, {
    display_name: '接缝纯文本接口',
    submit: {
      path: '/v1/custom/text',
      method: 'POST',
      payload_format: 'text',
      content_type: null,
      auth: { kind: 'query_api_key', query_name: 'api_key' },
      headers: [],
      query: [],
      form_field_style: 'dotted',
      form_array_style: 'repeat',
    },
    model_binding: { location: 'query', name: 'model_key' },
    parameters: [
      {
        binding: { location: 'query', name: 'style' },
        label: '风格',
        type: 'string',
        required: false,
        default_value: 'plain',
      },
      {
        binding: { location: 'header', name: 'X-Style' },
        label: '风格请求头',
        type: 'string',
        required: false,
        default_value: 'from-header',
      },
    ],
    prompt_binding: { location: 'text' },
    behavior: { result: { kind: 'direct_url', media_field_paths: ['data.0.url'], media_type: 'image' } },
  });
  const seeded = await seedModelForFormat(format, 'custom-wire-text-model');

  const assembled = await assembleGenerationTaskRequest(
    { model_id: seeded.modelId, prompt: promptText, arguments: { p0: 'vivid', p1: 'from-param' } },
    { projectPath: null, baseDir: null },
  );
  const plan = readRecord(readRecord(assembled, 'text assembly').executionPlan, 'text plan');
  const submitRequest = readRecord(plan.submit_request, 'text submit request');
  assert.equal(submitRequest.payload_format, 'text');
  assert.equal(submitRequest.body, promptText, '装配期正文必须就是提示词原文');
  const assembledHeaders = readRecord(submitRequest.headers, 'text submit headers');
  assert.equal(assembledHeaders['content-type'], 'text/plain; charset=utf-8');
  assert.equal(assembledHeaders['X-Style'], 'from-param');
  const assembledUrl = new URL(`${BASE_URL}${String(submitRequest.url)}`);
  assert.equal(assembledUrl.searchParams.get('style'), 'vivid');

  const upstream = installFetch(t, () => jsonResponse({ id: 'text-1', data: [{ url: 'https://cdn.example.invalid/text.png' }] }));
  const result = await executeHttpTask(
    {
      id: 'custom-wire-text-task',
      type: 'http',
      status: 'submitting',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      request: {
        url: submitRequest.url,
        method: submitRequest.method,
        headers: submitRequest.headers,
        body: submitRequest.body,
        payload_format: submitRequest.payload_format,
        form_field_style: submitRequest.form_field_style,
        form_array_style: submitRequest.form_array_style,
      },
      metadata: { modelId: seeded.modelId, model_id: seeded.modelId, taskExecutionPlan: plan },
    },
    new AbortController(),
  );
  const resultRecord = readRecord(result, 'text task record');

  const call = upstream.calls[0];
  assert.ok(call, 'text submit call missing');
  if (!call) return;
  assert.equal(call.method, 'POST');
  assert.equal(call.url.pathname, '/v1/custom/text');
  assert.equal(call.bodyText, promptText, '上行正文必须是提示词原文，不得是 JSON 字符串');
  assert.equal(call.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(call.url.searchParams.get('style'), 'vivid');
  assert.equal(call.url.searchParams.get('model_key'), 'remote-custom-wire-text-model');
  assert.equal(call.url.searchParams.get('api_key'), CREDENTIAL);
  assert.equal(call.headers.get('x-style'), 'from-param');
  assert.equal(JSON.stringify(resultRecord).includes(CREDENTIAL), false, '任务记录不得包含查询参数凭证');
  assert.equal(readBackendLog(storageRoot).includes(CREDENTIAL), false, '日志不得包含查询参数凭证');
});

// ---------------------------------------------------------------------------
// 8. 纯文本防御：投影误声明请求体参数时装配期显式失败
// ---------------------------------------------------------------------------

void test('纯文本防御：投影里出现请求体参数规则时装配期显式失败（不静默丢弃）', () => {
  const baseRuntime = {
    api_defaults: { endpoint: '/v1/custom/text', method: 'POST', contentType: null },
    payload_format: 'text',
  };
  const projectionWithBodyField = {
    model_id: 'text-guard-model',
    package_id: 'pkg-text-guard',
    runtime: {
      ...baseRuntime,
      payload_rules: {
        body: { kind: 'field', field_key: '__prompt' },
        'body.rogue': { kind: 'literal', value: 'must-not-be-sent' },
      },
    },
    task_execution_plan: { result_rule: { mode: 'sync' } },
  };
  assert.throws(
    () => buildExecutionPlanFromPayload(
      projectionWithBodyField,
      'text-guard-model',
      { api: {}, body: 'hello', meta: {} },
    ),
    /payload_format "text" forbids request body fields.*body\.rogue/,
    '投影误带请求体参数时必须明确报错并点名违规规则',
  );

  const projectionWithObjectBody = {
    model_id: 'text-guard-model-2',
    package_id: 'pkg-text-guard-2',
    runtime: {
      ...baseRuntime,
      payload_rules: { body: { kind: 'field', field_key: '__prompt' } },
    },
    task_execution_plan: { result_rule: { mode: 'sync' } },
  };
  assert.throws(
    () => buildExecutionPlanFromPayload(
      projectionWithObjectBody,
      'text-guard-model-2',
      { api: {}, body: { prompt: 'hello' }, meta: {} },
    ),
    /requires the prompt as the plain request body, got object/,
    '正文不是字符串时必须报错，而不是按 JSON 发出去',
  );
});
