import assert from 'node:assert/strict';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { type ExecutionSnapshot } from '@iart/contracts';
import { assembleGenerationTaskRequest } from '../request-assembler.cts';
import { buildDeclaredGenerationProjection } from '../generation-declaration-projection.cts';
import {
  applyRemoteModelInjection,
  resolveModelInjectionMode,
} from '../provider-connection/remote-model-injection.cts';
import {
  addCustomGenerationModel,
  getCustomGenerationModel,
} from '../provider-connection/custom-generation-model-store.cts';
import {
  createConnection,
  setConnectionCredential,
} from '../provider-connection/connection-store.cts';
import { setCredentialForConnection } from '../provider-connection/credential-store.cts';
import { executeHttpTask } from '../task-engine-http.cts';
import { executePollingTask } from '../task-engine-polling.cts';
import { buildPollingRequestFromPlan } from '../task-engine-polling-utils.cts';
import { maybeRunResultAcquisition } from '../task-result-acquisition.cts';
import { buildRequestBody, encodeUrlEncodedFormBody } from '../task-engine-request.cts';
import { normalizeFixedHeaders } from '../request-wire-utils.cts';
import { downloadRemoteMediaToFiles, type DownloadResult } from '../media-download.cts';
import { normalizeFormalTaskExecutionPlan } from '../business-actions/formal-task.cts';
import {
  BASE_URL,
  CREDENTIAL,
  CONNECTION_DISPLAY_NAME,
  buildManualSnapshot,
  createFormat,
  installFetch,
  jsonQueryFormatDraft,
  jsonResponse,
  readBackendLog,
  readRecord,
  seedFormatModel,
  startRouterServer,
  withIsolatedEnv,
  type JsonRecord,
} from './custom-format-wire.seam-helpers';

/**
 * 自定义接口格式「请求落点」执行链接缝（2026-10-27 批次）。
 *
 * 使命：真实装配（request-assembler）→ 真实执行函数（executeHttpTask / executePollingTask /
 * maybeRunResultAcquisition / applyRemoteModelInjection）→ 真实序列化（buildRequestBody）跑一遍，
 * 只在最外层替换 `globalThis.fetch` 捕获真实发出的 method / path / query / headers / body。
 *
 * 连接 base_url 被 store 约束为 https，假上游因此走 fetch 替换（沿
 * `interface-recipe.mainchain.engineSeam` 与 `task-result-acquisition` 的既有做法）。
 *
 * 覆盖：JSON+query、固定头+参数头、查询参数鉴权（凭证不落记录/日志）、表单编码三种嵌套/数组形态、
 * 轮询 GET/POST、结果获取的 request_headers 与 `{id}` 路径/查询编码差异、
 * 模型 ID 的三种注入落点（body 嵌套 / query / 路径 `{model}`）、媒体下载查询鉴权。
 * 纯文本正文的端到端与防御用例见 `custom-format-text-body.executionSeam.test.ts`。
 */

// ---------------------------------------------------------------------------
// 1. 提交：JSON body + api.query + 固定头 + 参数头 + 模型嵌套路径 + 查询鉴权
// ---------------------------------------------------------------------------

void test('提交接缝：JSON body + 查询参数 + 固定头 + 参数头 + 模型嵌套路径 + 查询参数鉴权', async (t) => {
  const storageRoot = withIsolatedEnv(t);
  const seeded = await seedFormatModel(t, jsonQueryFormatDraft('接缝 JSON 查询接口'), 'custom-wire-json-model');

  // 真实装配：格式实体 → 合成投影 → 请求规则求值 → 执行计划。
  const record = getCustomGenerationModel(seeded.modelId);
  assert.ok(record, 'custom model record must exist');
  if (!record) return;
  const built = buildDeclaredGenerationProjection(record);
  assert.ok(built, 'projection must build from the created format');
  const assembled = await assembleGenerationTaskRequest(
    {
      model_id: seeded.modelId,
      prompt: '把天空换成晚霞',
      arguments: { p0: 'high', p1: 'from-param' },
    },
    { projectPath: null, baseDir: null },
  );
  assert.ok(assembled && typeof assembled === 'object', 'assembly must produce an execution plan');
  const plan = readRecord(readRecord(assembled, 'assembly result').executionPlan, 'execution plan');
  const submitRequest = readRecord(plan.submit_request, 'submit request');

  const assembledUrl = new URL(`${BASE_URL}${String(submitRequest.url)}`);
  assert.equal(assembledUrl.pathname, '/v1/custom/generate');
  assert.equal(assembledUrl.searchParams.get('api_version'), '2026-10-27');
  assert.equal(assembledUrl.searchParams.get('quality'), 'high');
  const assembledHeaders = readRecord(submitRequest.headers, 'submit headers');
  assert.equal(assembledHeaders['X-Fixed-Header'], 'fixed-value');
  assert.equal(assembledHeaders['X-Param-Header'], 'from-param');
  assert.equal(submitRequest.payload_format, 'json');
  const assembledBody = readRecord(submitRequest.body, 'submit body');
  assert.equal(readRecord(assembledBody.config, 'body config').model, seeded.modelId);
  assert.equal(assembledBody.prompt, '把天空换成晚霞');
  assert.deepEqual(
    resolveModelInjectionMode(String(seeded.format['format_id'])),
    { bodyPaths: ['config.model'], queryNames: [] },
    '用户格式实体的 {{model_id}} 规则必须被识别为模型落点',
  );

  // 表单形态的「格式实体 → 合成投影 → 装配 → 序列化」闭环：styles 必须从实体透传到
  // submit_request，再由发送期编码器消费（缺任何一环都会静默退回 dotted/repeat JSON）。
  const formFormat = await createFormat(await startRouterServer(t), {
    display_name: '接缝表单接口',
    submit: {
      path: '/v1/custom/form',
      method: 'POST',
      payload_format: 'form',
      content_type: null,
      auth: { kind: 'bearer', header_name: 'Authorization' },
      headers: [],
      query: [],
      form_field_style: 'bracket',
      form_array_style: 'index',
    },
    model_binding: { location: 'body', path: 'model' },
    parameters: [
      {
        binding: { location: 'body', path: 'options.tag' },
        label: '标签',
        type: 'string',
        required: false,
        default_value: 'x',
      },
    ],
    prompt_binding: { location: 'body', path: 'prompt' },
    behavior: { result: { kind: 'direct_url', media_field_paths: ['data.0.url'], media_type: 'image' } },
  });
  const formModel = addCustomGenerationModel({
    model_id: 'custom-wire-form-model',
    connection_id: seeded.connectionId,
    family_adapter_id: String(formFormat['format_id']),
    remote_model_id: 'remote-custom-wire-form-model',
    ...(typeof formFormat['recipe_id'] === 'string' ? { recipe_id: formFormat['recipe_id'] } : {}),
  });
  assert.ok(formModel.ok, `form model record should be created: ${JSON.stringify(formModel)}`);
  if (!formModel.ok) return;
  const formAssembled = await assembleGenerationTaskRequest(
    { model_id: 'custom-wire-form-model', prompt: '表单提示词' },
    { projectPath: null, baseDir: null },
  );
  const formPlan = readRecord(readRecord(formAssembled, 'form assembly').executionPlan, 'form plan');
  const formSubmit = readRecord(formPlan.submit_request, 'form submit request');
  assert.equal(formSubmit.payload_format, 'form');
  assert.equal(formSubmit.form_field_style, 'bracket');
  assert.equal(formSubmit.form_array_style, 'index');
  const formBody = String(
    buildRequestBody(
      formSubmit.body,
      new Headers(readRecord(formSubmit.headers, 'form headers') as Record<string, string>),
      {
        payloadFormat: typeof formSubmit.payload_format === 'string' ? formSubmit.payload_format : undefined,
        formFieldStyle: typeof formSubmit.form_field_style === 'string' ? formSubmit.form_field_style : undefined,
        formArrayStyle: typeof formSubmit.form_array_style === 'string' ? formSubmit.form_array_style : undefined,
      },
    ),
  );
  const formParams = new URLSearchParams(formBody);
  assert.equal(formParams.get('prompt'), '表单提示词');
  assert.equal(formParams.get('model'), 'custom-wire-form-model');

  // 真实发送：记录只带无凭证的声明，凭证在 fetch 前注入。
  const upstream = installFetch(t, () => jsonResponse({ id: 'sync-1', data: { url: 'https://cdn.example.invalid/out.png' } }));
  const taskRecord = {
    id: 'custom-wire-json-task',
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
    metadata: {
      modelId: seeded.modelId,
      model_id: seeded.modelId,
      taskExecutionPlan: plan,
    },
  };
  const result = await executeHttpTask(taskRecord, new AbortController());
  const resultRecord = readRecord(result, 'task record');

  assert.equal(upstream.calls.length >= 1, true, 'upstream must receive the submit request');
  const submitCall = upstream.calls[0];
  assert.ok(submitCall, 'submit call missing');
  if (!submitCall) return;
  assert.equal(submitCall.method, 'POST');
  assert.equal(submitCall.url.pathname, '/v1/custom/generate');
  assert.equal(submitCall.url.searchParams.get('api_version'), '2026-10-27');
  assert.equal(submitCall.url.searchParams.get('quality'), 'high');
  assert.equal(submitCall.url.searchParams.get('api_key'), CREDENTIAL, '查询参数鉴权必须拼在真实请求地址上');
  assert.equal(submitCall.headers.get('x-fixed-header'), 'fixed-value');
  assert.equal(submitCall.headers.get('x-param-header'), 'from-param');
  assert.equal(submitCall.headers.get('content-type'), 'application/json');
  const sentBody = JSON.parse(submitCall.bodyText ?? '{}') as JsonRecord;
  assert.equal(readRecord(sentBody.config, 'sent config').model, 'remote-custom-wire-json-model');

  // 凭证不得进入任务记录（查询参数鉴权的核心约束）。
  assert.equal(
    JSON.stringify(resultRecord).includes(CREDENTIAL),
    false,
    '任务记录不得包含查询参数凭证',
  );
  assert.equal(readBackendLog(storageRoot).includes(CREDENTIAL), false, '后端日志不得包含查询参数凭证');
  assert.ok(readBackendLog(storageRoot).length > 0, 'debug 级日志应当有留痕（脱敏断言不能空跑）');

});

// ---------------------------------------------------------------------------
// 2. 表单编码 / 纯文本 / 非法固定头
// ---------------------------------------------------------------------------

void test('表单编码：嵌套 dotted/bracket 与数组 repeat/bracket/index；纯文本正文；非法固定头被拒', () => {
  const dottedRepeat = buildRequestBody(
    { options: { size: '1024' }, tag: ['a', 'b'], empty: '' },
    new Headers(),
    { payloadFormat: 'form', formFieldStyle: 'dotted', formArrayStyle: 'repeat' },
  );
  assert.equal(typeof dottedRepeat, 'string');
  const repeatParams = new URLSearchParams(String(dottedRepeat));
  assert.equal(repeatParams.get('options.size'), '1024');
  assert.deepEqual(repeatParams.getAll('tag'), ['a', 'b']);
  assert.equal(repeatParams.get('empty'), '');

  const bracketBracket = String(
    buildRequestBody(
      { options: { size: '1024' }, tag: ['a', 'b'] },
      new Headers(),
      { payloadFormat: 'form', formFieldStyle: 'bracket', formArrayStyle: 'bracket' },
    ),
  );
  const bracketParams = new URLSearchParams(bracketBracket);
  assert.equal(bracketParams.get('options[size]'), '1024');
  assert.deepEqual(bracketParams.getAll('tag[]'), ['a', 'b']);

  const dottedIndex = String(
    buildRequestBody(
      { tag: ['a', 'b'] },
      new Headers(),
      { payloadFormat: 'form', formFieldStyle: 'dotted', formArrayStyle: 'index' },
    ),
  );
  const indexParams = new URLSearchParams(dottedIndex);
  assert.equal(indexParams.get('tag[0]'), 'a');
  assert.equal(indexParams.get('tag[1]'), 'b');
  assert.equal(
    encodeUrlEncodedFormBody({ a: { b: undefined }, c: null, d: 'keep' }, {
      payloadFormat: 'form',
      formFieldStyle: 'dotted',
      formArrayStyle: 'repeat',
    }),
    'd=keep',
    'undefined/null 跳过、普通字符串保留',
  );

  const textHeaders = new Headers();
  const textBody = buildRequestBody('整段提示词', textHeaders, {
    payloadFormat: 'text',
    formFieldStyle: undefined,
    formArrayStyle: undefined,
  });
  assert.equal(textBody, '整段提示词');
  assert.equal(textHeaders.get('content-type'), 'text/plain; charset=utf-8');
  assert.throws(
    () => buildRequestBody({ prompt: 'x' }, new Headers(), { payloadFormat: 'text', formFieldStyle: undefined, formArrayStyle: undefined }),
    /requires a string request body/,
  );

  assert.throws(
    () => normalizeFixedHeaders({ Authorization: 'Bearer sk-x' }, 'test submit request'),
    /managed by the runtime/,
    '禁止头（authorization）必须报错而不是静默覆盖',
  );
  assert.throws(
    () => normalizeFixedHeaders({ 'bad header': 'v' }, 'test submit request'),
    /invalid request header name/,
  );

  // 记录落库面：受理期归一必须保留请求体形态，否则发送期拿不到 form/text 的序列化依据。
  const normalized = normalizeFormalTaskExecutionPlan({
    submit_request: {
      url: '/v1/custom/generate',
      method: 'POST',
      headers: {},
      body: { tag: ['a'] },
      payload_format: 'form',
      form_field_style: 'bracket',
      form_array_style: 'index',
    },
    metadata: { modelId: 'custom-wire-form-model' },
  });
  assert.equal(normalized.ok, true);
  if (!normalized.ok) return;
  const normalizedRequest = readRecord(normalized.value.request, 'normalized formal task request');
  assert.equal(normalizedRequest['payload_format'], 'form');
  assert.equal(normalizedRequest['form_field_style'], 'bracket');
  assert.equal(normalizedRequest['form_array_style'], 'index');
});

// ---------------------------------------------------------------------------
// 3. 轮询：GET query/headers 占位 + 查询参数鉴权
// ---------------------------------------------------------------------------

type PollingSeam = {
  snapshot: ExecutionSnapshot;
  credentialRef: string;
  metadata: JsonRecord;
};

const seedPollingIdentity = async (t: TestContext, params: {
  auth: { kind: 'query_api_key'; query_name: string } | { kind: 'bearer'; header_name: string };
  formatId: string;
}): Promise<PollingSeam> => {
  const connection = createConnection({ display_name: CONNECTION_DISPLAY_NAME, base_url: BASE_URL });
  const credential = await setCredentialForConnection(connection.connection_id, CREDENTIAL);
  assert.ok(credential, 'credential should be stored');
  if (!credential) throw new Error('credential setup failed');
  setConnectionCredential(connection.connection_id, credential.credentialRef, credential.version, true);
  const snapshot = buildManualSnapshot({
    formatId: params.formatId,
    remoteModelId: 'remote-poll-model',
    credentialRef: credential.credentialRef,
    auth: params.auth,
  });
  return {
    snapshot,
    credentialRef: credential.credentialRef,
    metadata: { modelId: 'poll-model', model_id: 'poll-model', executionSnapshot: snapshot },
  };
};

const buildPollingPlan = (request: JsonRecord, successPath = 'output.url'): JsonRecord => ({
  polling_strategy: {
    request,
    polling: {
      intervalMs: 1,
      maxAttempts: 3,
      successStatuses: ['succeeded'],
      statusFieldPaths: ['status'],
      failureStatuses: ['failed'],
      successPath,
    },
  },
  result_rule: { mode: 'async', submit_response_id_path: 'id' },
});

void test('轮询接缝：GET 带 query/headers 占位（路径保留 /、查询编码）+ 鉴权 query 不进记录/日志', async (t) => {
  const storageRoot = withIsolatedEnv(t);
  const identity = await seedPollingIdentity(t, {
    auth: { kind: 'query_api_key', query_name: 'access_key' },
    formatId: 'openai-image-v1',
  });
  const operationName = 'models/base/models/x/operations/y';
  const plan = buildPollingPlan({
    url_template: '/v1/operations/{operation_name}?task_ids={id}',
    method: 'GET',
    headers: { 'X-Poll-Token': '{id}' },
    query: [{ name: 'job', value: '{id}' }],
    body: null,
    body_format: 'json',
    content_type: null,
  });
  const record = {
    id: 'custom-wire-poll-get',
    type: 'http',
    status: 'polling',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    request: { url: `${BASE_URL}/v1/custom/generate`, method: 'POST', headers: {}, body: {} },
    metadata: {
      ...identity.metadata,
      remoteRequestId: operationName,
      taskExecutionPlan: plan,
    },
  };
  const pollingBuild = buildPollingRequestFromPlan(record, { id: 'ignored' });
  assert.equal(pollingBuild.status, 'ready');
  if (pollingBuild.status !== 'ready') return;
  assert.equal(
    pollingBuild.request.url,
    `/v1/operations/${operationName}?task_ids=${encodeURIComponent(operationName)}&job=${encodeURIComponent(operationName)}`,
    '路径占位保留 /，查询串占位完整编码',
  );
  assert.equal(pollingBuild.request.headers['X-Poll-Token'], operationName);

  const upstream = installFetch(t, () => jsonResponse({ status: 'succeeded', output: { url: 'https://cdn.example.invalid/poll.png' } }));
  const result = await executePollingTask(record, new AbortController(), {
    request: pollingBuild.request,
    polling: pollingBuild.polling,
  });
  const resultRecord = readRecord(result, 'polling result');

  const pollCall = upstream.calls[0];
  assert.ok(pollCall, 'polling call missing');
  if (!pollCall) return;
  assert.equal(pollCall.method, 'GET');
  assert.equal(pollCall.url.pathname, `/v1/operations/${operationName}`);
  assert.equal(pollCall.url.searchParams.get('task_ids'), operationName);
  assert.equal(pollCall.url.searchParams.get('job'), operationName);
  assert.equal(pollCall.url.searchParams.get('access_key'), CREDENTIAL);
  assert.equal(pollCall.headers.get('x-poll-token'), operationName);
  assert.equal(JSON.stringify(resultRecord).includes(CREDENTIAL), false, '轮询记录不得包含凭证');
  assert.equal(readBackendLog(storageRoot).includes(CREDENTIAL), false, '轮询日志不得包含凭证');
});

void test('轮询接缝：POST form body（占位替换后按表单编码）', async (t) => {
  withIsolatedEnv(t);
  const identity = await seedPollingIdentity(t, {
    auth: { kind: 'bearer', header_name: 'Authorization' },
    formatId: 'openai-image-v1',
  });
  const plan = buildPollingPlan({
    url_template: '/v1/poll/{id}',
    method: 'POST',
    headers: {},
    query: [],
    body: { job: '{id}', nested: { state: 'running' } },
    body_format: 'form',
    content_type: null,
  });
  const record = {
    id: 'custom-wire-poll-post',
    type: 'http',
    status: 'polling',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    request: { url: `${BASE_URL}/v1/custom/generate`, method: 'POST', headers: {}, body: {} },
    metadata: {
      ...identity.metadata,
      remoteRequestId: 'job-9',
      taskExecutionPlan: plan,
    },
  };
  const pollingBuild = buildPollingRequestFromPlan(record, { id: 'ignored' });
  assert.equal(pollingBuild.status, 'ready');
  if (pollingBuild.status !== 'ready') return;
  assert.equal(pollingBuild.request.payload_format, 'form');

  const upstream = installFetch(t, () => jsonResponse({ status: 'succeeded', output: { url: 'https://cdn.example.invalid/poll.png' } }));
  await executePollingTask(record, new AbortController(), {
    request: pollingBuild.request,
    polling: pollingBuild.polling,
  });
  const pollCall = upstream.calls[0];
  assert.ok(pollCall, 'polling call missing');
  if (!pollCall) return;
  assert.equal(pollCall.method, 'POST');
  assert.equal(pollCall.headers.get('content-type'), 'application/x-www-form-urlencoded');
  const params = new URLSearchParams(pollCall.bodyText ?? '');
  assert.equal(params.get('job'), 'job-9');
  assert.equal(params.get('nested.state'), 'running');
});

// ---------------------------------------------------------------------------
// 4. 结果获取：request_headers + {id} 编码差异 + 鉴权 query
// ---------------------------------------------------------------------------

void test('结果获取接缝：request_headers + 路径 id 保留 / 查询 id 编码 + 鉴权 query', async (t) => {
  const storageRoot = withIsolatedEnv(t);
  const identity = await seedPollingIdentity(t, {
    auth: { kind: 'query_api_key', query_name: 'access_key' },
    formatId: 'openai-image-v1',
  });
  const operationName = 'models/x/operations/y';
  const strategy = {
    acquisition_mode: 'fetch_final_result',
    identity_source: 'query_response_path',
    identity_path: 'task.id',
    accept: 'json',
    requires_auth: true,
    request_headers: { 'X-Result-Header': 'result-fixed' },
    request_strategy: {
      request_stage: 'acquisition',
      protocol: 'http',
      endpoint: '/v1/tasks/{id}/result?task_id={id}',
      method: 'GET',
    },
  };
  const record = {
    id: 'custom-wire-acquisition',
    type: 'http',
    status: 'polling',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    request: { url: `${BASE_URL}/v1/custom/generate`, method: 'POST', headers: {}, body: {} },
    metadata: {
      ...identity.metadata,
      taskExecutionPlan: { result_acquisition_strategy: strategy },
    },
    response: {
      status: 200,
      ok: true,
      contentType: 'application/json',
      bodyType: 'json',
      body: { task: { id: operationName } },
    },
  };
  const upstream = installFetch(t, () => jsonResponse({ data: { url: 'https://cdn.example.invalid/final.png' } }));
  const outcome = await maybeRunResultAcquisition(record);
  assert.equal(outcome.kind, 'acquired');

  const call = upstream.calls[0];
  assert.ok(call, 'acquisition call missing');
  if (!call) return;
  assert.equal(call.method, 'GET');
  assert.equal(call.url.pathname, `/v1/tasks/${operationName}/result`, '路径里的 {id} 保留层级');
  assert.equal(call.url.searchParams.get('task_id'), operationName, '查询串里的 {id} 编码后仍可解码');
  assert.equal(call.headers.get('x-result-header'), 'result-fixed');
  assert.equal(call.url.searchParams.get('access_key'), CREDENTIAL);
  assert.equal(JSON.stringify(outcome.record).includes(CREDENTIAL), false, '结果记录不得包含凭证');
  assert.equal(readBackendLog(storageRoot).includes(CREDENTIAL), false, '结果获取日志不得包含凭证');
});

// ---------------------------------------------------------------------------
// 5. 模型 ID 注入：body 嵌套路径 / query / 路径 {model}
// ---------------------------------------------------------------------------

void test('模型 ID 注入接缝：body 嵌套路径 / query / 路径 {model} 三种落点', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await startRouterServer(t);

  const bodyFormat = await createFormat(baseUrl, {
    display_name: '接缝模型嵌套落点',
    submit: {
      path: '/v1/custom/generate',
      method: 'POST',
      payload_format: 'json',
      content_type: 'application/json',
      auth: { kind: 'bearer', header_name: 'Authorization' },
      headers: [],
      query: [],
      form_field_style: 'dotted',
      form_array_style: 'repeat',
    },
    model_binding: { location: 'body', path: 'config.model' },
    parameters: [],
    prompt_binding: { location: 'body', path: 'prompt' },
    behavior: { result: { kind: 'direct_url', media_field_paths: ['data.0.url'], media_type: 'image' } },
  });
  const queryFormat = await createFormat(baseUrl, {
    display_name: '接缝模型查询落点',
    submit: {
      path: '/v1/custom/generate',
      method: 'POST',
      payload_format: 'json',
      content_type: 'application/json',
      auth: { kind: 'bearer', header_name: 'Authorization' },
      headers: [],
      query: [],
      form_field_style: 'dotted',
      form_array_style: 'repeat',
    },
    model_binding: { location: 'query', name: 'model_key' },
    parameters: [],
    prompt_binding: { location: 'body', path: 'prompt' },
    behavior: { result: { kind: 'direct_url', media_field_paths: ['data.0.url'], media_type: 'image' } },
  });

  const bodySnapshot = buildManualSnapshot({
    formatId: String(bodyFormat['format_id']),
    remoteModelId: 'remote-model-body',
    credentialRef: 'cred_bogus',
    auth: { kind: 'bearer', header_name: 'Authorization' },
  });
  const bodyInjected = applyRemoteModelInjection({
    snapshot: bodySnapshot,
    url: '/v1/custom/generate',
    body: { config: { model: 'product-model-id', keep: true }, prompt: 'hi' },
  });
  assert.equal(readRecord(readRecord(bodyInjected.body, 'body').config, 'config').model, 'remote-model-body');
  assert.equal(readRecord(readRecord(bodyInjected.body, 'body').config, 'config').keep, true);

  const querySnapshot = buildManualSnapshot({
    formatId: String(queryFormat['format_id']),
    remoteModelId: 'remote-model-query',
    credentialRef: 'cred_bogus',
    auth: { kind: 'bearer', header_name: 'Authorization' },
  });
  const queryInjected = applyRemoteModelInjection({
    snapshot: querySnapshot,
    url: '/v1/custom/generate?other=1',
    body: { prompt: 'hi' },
  });
  const queryUrl = new URL(`${BASE_URL}${queryInjected.url}`);
  assert.equal(queryUrl.searchParams.get('other'), '1');
  assert.equal(queryUrl.searchParams.get('model_key'), 'remote-model-query');
  assert.equal(readRecord(queryInjected.body, 'body').model, undefined, '查询落点不得往请求体塞 model');

  const pathSnapshot = buildManualSnapshot({
    formatId: 'veo-v1',
    remoteModelId: 'veo-seam-model',
    credentialRef: 'cred_bogus',
    auth: { kind: 'bearer', header_name: 'Authorization' },
  });
  const pathInjected = applyRemoteModelInjection({
    snapshot: pathSnapshot,
    url: '/v1beta/models/{model}:predictLongRunning',
    body: {},
  });
  assert.equal(pathInjected.url, '/v1beta/models/veo-seam-model:predictLongRunning');
});

// ---------------------------------------------------------------------------
// 6. 媒体下载：查询参数鉴权只进 fetch 地址，返回结果与日志无凭证
// ---------------------------------------------------------------------------

void test('媒体下载接缝：查询参数鉴权只拼到下载地址，落盘结果与日志不含凭证', async (t) => {
  const storageRoot = withIsolatedEnv(t);
  const mediaDir = path.join(storageRoot, 'project-media');
  const upstream = installFetch(
    t,
    () => new Response(Buffer.from('fake-image-bytes'), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    }),
  );
  const result = await downloadRemoteMediaToFiles(`${BASE_URL}/files/out.png`, {
    source: 'custom-wire-seam',
    abortSignal: undefined,
    headers: undefined,
    mediaDir,
    projectRef: undefined,
    authQuery: { name: 'access_key', value: CREDENTIAL },
  });
  assert.ok(result !== null && typeof (result as DownloadResult).fileKey === 'string', 'download should succeed');
  const call = upstream.calls[0];
  assert.ok(call, 'download call missing');
  if (!call) return;
  assert.equal(call.url.searchParams.get('access_key'), CREDENTIAL);
  assert.equal(JSON.stringify(result).includes(CREDENTIAL), false, '下载结果不得包含凭证');
  assert.equal(readBackendLog(storageRoot).includes(CREDENTIAL), false, '下载日志不得包含凭证');
});
