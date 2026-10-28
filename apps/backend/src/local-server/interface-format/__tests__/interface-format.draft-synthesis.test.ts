import assert from 'node:assert/strict';
import test from 'node:test';

import { CustomInterfaceFormatDraftSchema } from '@iart/contracts';
import { composeInterfaceFormatSources } from '../compose.cts';
import { buildInterfaceFormatFromDraft, buildInterfaceRecipeFromDraft } from '../draft-synthesis.cts';
import { InterfaceFormatSchema } from '../schema.cts';

/**
 * 草稿 → 实体 + 配方的合成（2026-10-26 批次 B5a；2026-10-27 请求落点批次扩展到
 * 请求体 / 查询参数 / 请求头三种落点与 form / text 两种请求体形态）。
 *
 * 覆盖：三种 binding、提示词三种落点、模型 ID 三种落点、固定请求头/查询参数、表单编码形态、
 * 纯文本正文、轮询请求（headers/query/body/body_format/content_type）、合成末尾的
 * compose 实跑（占位符 / 宏不可残留、运行时能读到请求规则）。
 */

type JsonRecord = Record<string, unknown>;

const BASE_SUBMIT: JsonRecord = {
  path: '/v1/generate',
  method: 'POST',
  payload_format: 'json',
  content_type: 'application/json',
  auth: { kind: 'bearer', header_name: 'Authorization', prefix: 'Bearer' },
  headers: [],
  query: [],
  form_field_style: 'dotted',
  form_array_style: 'repeat',
};

const MINIMAL_DRAFT_BODY: JsonRecord = {
  display_name: '测试图像接口',
  submit: BASE_SUBMIT,
  parameters: [
    { binding: { location: 'body', path: 'size' }, label: '画面尺寸', type: 'string', default_value: '1024x1024' },
    { binding: { location: 'body', path: 'count' }, label: '生成数量', type: 'number' },
    { binding: { location: 'body', path: 'hd' }, label: '高清', type: 'boolean', default_value: false },
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
    result: { kind: 'direct_url', media_field_paths: ['data.0.url'], media_type: 'image' },
  },
};

const parseDraft = (body: JsonRecord) => {
  const parsed = CustomInterfaceFormatDraftSchema.safeParse(body);
  assert.equal(parsed.success, true, parsed.success ? undefined : parsed.error.message);
  if (!parsed.success) throw new Error('unreachable');
  return parsed.data;
};

const readObject = (value: unknown, message: string): JsonRecord => {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), message);
  return value as JsonRecord;
};

void test('draft synthesis: 最小同步草稿 → 合法实体 + 草稿同源配方', () => {
  const draft = parseDraft(MINIMAL_DRAFT_BODY);
  const format = buildInterfaceFormatFromDraft(draft, { format_id: 'if_test_minimal', order: 100 });

  assert.doesNotThrow(() => InterfaceFormatSchema.parse(format));
  assert.equal(format.origin, 'user');
  assert.equal(format.status, 'ready');
  assert.equal(format.family, 'generation');
  assert.equal(format.order, 100);

  assert.equal(format.transport.endpoints['submit'], '/v1/generate');
  assert.equal(format.transport.submit.endpoint_key, 'submit');
  assert.equal(format.transport.submit.method, 'POST');
  assert.equal(format.transport.submit.content_type, 'application/json');
  assert.equal(format.transport.submit.payload_format, 'json');
  assert.equal(format.transport.submit.form_field_style, 'dotted');
  assert.equal(format.transport.submit.form_array_style, 'repeat');
  assert.equal(format.transport.async, undefined);

  const rules = format.transport.payload_rules;
  assert.deepEqual(rules['api.endpoint'], { kind: 'literal', value: '{{endpoint:submit}}' });
  assert.deepEqual(rules['api.method'], { kind: 'literal', value: '{{method:submit}}' });
  assert.deepEqual(rules['api.contentType'], { kind: 'literal', value: '{{content_type:submit}}' });
  assert.deepEqual(rules['body.prompt'], { kind: 'field', field_key: '__prompt', transforms: ['trim'] });
  // 参数内部键是 p<序号>（参数身份），不是 binding 的请求体路径。
  assert.deepEqual(rules['body.size'], { kind: 'field', field_key: 'p0' });
  assert.deepEqual(rules['body.count'], { kind: 'field', field_key: 'p1' });
  assert.deepEqual(rules['body.hd'], { kind: 'field', field_key: 'p2' });
  assert.deepEqual(rules['body.quality'], { kind: 'field', field_key: 'p3' });
  assert.equal('body.model' in rules, false);

  const parameterSchema = readObject(format.parameters.schema, 'parameter schema');
  const fields = parameterSchema['fields'];
  assert.ok(Array.isArray(fields));
  assert.deepEqual(
    (fields as JsonRecord[]).map((field) => field['field_key']),
    ['p0', 'p1', 'p2', 'p3'],
  );
  assert.deepEqual(parameterSchema['required_fields'], ['p3']);
  assert.deepEqual(format.parameters.defaults, { p0: '1024x1024', p2: false });
  assert.deepEqual(format.parameters.prompt_field, {
    field_key: '__prompt',
    required: true,
    validation_rules: [],
  });
  const qualityField = (fields as JsonRecord[])[3];
  assert.equal(qualityField?.['component'], 'select');
  assert.deepEqual(
    (qualityField?.['enum_options'] as JsonRecord[]).map((option) => option['value']),
    ['low', 'high'],
  );

  assert.deepEqual(format.media, { supports: [], required: [], slots: {} });
  assert.deepEqual(format.composition, { fragments: {}, variants: [] });
  assert.equal(format.builtin_behavior, undefined);

  const recipe = buildInterfaceRecipeFromDraft(draft, 'if_test_minimal');
  assert.equal(recipe.family_adapter_id, 'if_test_minimal');
  assert.equal(recipe.name, '测试图像接口 判定');
  assert.deepEqual(recipe.success_when, { op: 'exists', path: 'data.0.url' });
  assert.equal(recipe.failure_when, undefined);
  assert.deepEqual(recipe.result, { kind: 'direct_url', media_field_paths: ['data.0.url'], media_type: 'image' });
});

void test('draft synthesis: compose 产物无占位符/宏残留，runtime 带请求体形态与表单编码形态', () => {
  const draft = parseDraft(MINIMAL_DRAFT_BODY);
  const format = buildInterfaceFormatFromDraft(draft, { format_id: 'if_test_compose', order: 100 });
  const sources = composeInterfaceFormatSources({ format, modelId: 'model-under-test', acceptedMediaSlots: [] });
  const serialized = JSON.stringify(sources);
  assert.equal(serialized.includes('{{'), false, '占位符必须已被渲染');
  assert.equal(serialized.includes('"$if"'), false, '合成期宏必须已求值');

  const runtime = readObject(sources.runtimeModel['runtime'], 'runtime');
  assert.deepEqual(runtime['payload_rules'], {
    'api.endpoint': { kind: 'literal', value: '/v1/generate' },
    'api.method': { kind: 'literal', value: 'POST' },
    'api.contentType': { kind: 'literal', value: 'application/json' },
    'body.prompt': { kind: 'field', field_key: '__prompt', transforms: ['trim'] },
    'body.size': { kind: 'field', field_key: 'p0' },
    'body.count': { kind: 'field', field_key: 'p1' },
    'body.hd': { kind: 'field', field_key: 'p2' },
    'body.quality': { kind: 'field', field_key: 'p3' },
  });
  assert.equal(runtime['payload_format'], 'json');
  assert.equal(runtime['form_field_style'], 'dotted');
  assert.equal(runtime['form_array_style'], 'repeat');
  // 请求策略只承载地址与方法；历史三个死规则数组不得回潮。
  assert.deepEqual(sources.runtimeModel['request_strategy'], {
    request_stage: 'submit',
    protocol: 'http',
    endpoint: '/v1/generate',
    method: 'POST',
  });
});

void test('draft synthesis: 参数三种落点（请求体 / 查询参数 / 请求头）+ 提示词查询参数 + 固定线路常量', () => {
  const draft = parseDraft({
    ...MINIMAL_DRAFT_BODY,
    submit: {
      ...BASE_SUBMIT,
      path: '/v1/jobs',
      headers: [{ name: 'Accept', value: 'application/json' }],
      query: [{ name: 'api-version', value: '2024-01-01' }],
    },
    parameters: [
      { binding: { location: 'body', path: 'options.size' }, label: '尺寸', type: 'string' },
      { binding: { location: 'query', name: 'seed' }, label: '随机种子', type: 'number' },
      { binding: { location: 'header', name: 'X-Trace' }, label: '追踪标识', type: 'string' },
    ],
    prompt_binding: { location: 'query', name: 'prompt' },
    model_binding: { location: 'query', name: 'model' },
  });
  const format = buildInterfaceFormatFromDraft(draft, { format_id: 'if_test_bindings', order: 100 });
  const rules = format.transport.payload_rules;

  assert.deepEqual(rules['body.options.size'], { kind: 'field', field_key: 'p0' });
  assert.deepEqual(rules['api.query.seed'], { kind: 'field', field_key: 'p1' });
  assert.deepEqual(rules['api.headers.X-Trace'], { kind: 'field', field_key: 'p2' });
  assert.deepEqual(rules['api.query.prompt'], { kind: 'field', field_key: '__prompt', transforms: ['trim'] });
  assert.deepEqual(rules['api.query.model'], { kind: 'literal', value: '{{model_id}}' });
  assert.deepEqual(rules['api.headers.Accept'], { kind: 'literal', value: 'application/json' });
  assert.deepEqual(rules['api.query.api-version'], { kind: 'literal', value: '2024-01-01' });

  const sources = composeInterfaceFormatSources({ format, modelId: 'binding-model', acceptedMediaSlots: [] });
  const runtime = readObject(sources.runtimeModel['runtime'], 'runtime');
  const rendered = readObject(runtime['payload_rules'], 'rendered rules');
  assert.deepEqual(rendered['api.query.model'], { kind: 'literal', value: 'binding-model' });
  assert.deepEqual(rendered['api.query.seed'], { kind: 'field', field_key: 'p1' });
  assert.deepEqual(rendered['api.headers.X-Trace'], { kind: 'field', field_key: 'p2' });
});

void test('draft synthesis: 提示词纯文本正文 → body 规则与 text/plain Content-Type', () => {
  const draft = parseDraft({
    display_name: '纯文本补全接口',
    submit: {
      path: '/v1/completions',
      method: 'POST',
      payload_format: 'text',
      content_type: null,
      auth: { kind: 'query_api_key', query_name: 'key' },
      headers: [],
      query: [{ name: 'model', value: 'static-model' }],
    },
    parameters: [{ binding: { location: 'query', name: 'max_tokens' }, label: '最大长度', type: 'number' }],
    prompt_binding: { location: 'text' },
    behavior: {
      result: { kind: 'direct_url', media_field_paths: ['data.0.url'], media_type: 'image' },
    },
  });
  const format = buildInterfaceFormatFromDraft(draft, { format_id: 'if_test_text', order: 100 });

  assert.equal(format.transport.submit.payload_format, 'text');
  assert.equal(format.transport.submit.content_type, 'text/plain; charset=utf-8');
  assert.deepEqual(format.transport.auth, { kind: 'query_api_key', query_name: 'key' });
  assert.deepEqual(format.transport.payload_rules['body'], {
    kind: 'field',
    field_key: '__prompt',
    transforms: ['trim'],
  });
  assert.deepEqual(format.transport.payload_rules['api.query.max_tokens'], {
    kind: 'field',
    field_key: 'p0',
  });
  assert.equal('api.query.model' in format.transport.payload_rules, true);

  const sources = composeInterfaceFormatSources({ format, modelId: 'text-model', acceptedMediaSlots: [] });
  const runtime = readObject(sources.runtimeModel['runtime'], 'runtime');
  assert.equal(runtime['payload_format'], 'text');
  assert.deepEqual(readObject(runtime['payload_rules'], 'rules')['body'], {
    kind: 'field',
    field_key: '__prompt',
    transforms: ['trim'],
  });
});

void test('draft synthesis: 表单编码形态与自定义字段/数组编码方式透传', () => {
  const draft = parseDraft({
    ...MINIMAL_DRAFT_BODY,
    submit: {
      ...BASE_SUBMIT,
      path: '/v1/form',
      payload_format: 'form',
      content_type: null,
      form_field_style: 'bracket',
      form_array_style: 'index',
    },
  });
  const format = buildInterfaceFormatFromDraft(draft, { format_id: 'if_test_form', order: 100 });

  assert.equal(format.transport.submit.content_type, 'application/x-www-form-urlencoded');
  assert.equal(format.transport.submit.form_field_style, 'bracket');
  assert.equal(format.transport.submit.form_array_style, 'index');

  const sources = composeInterfaceFormatSources({ format, modelId: 'form-model', acceptedMediaSlots: [] });
  const runtime = readObject(sources.runtimeModel['runtime'], 'runtime');
  assert.equal(runtime['payload_format'], 'form');
  assert.equal(runtime['form_field_style'], 'bracket');
  assert.equal(runtime['form_array_style'], 'index');
});

void test('draft synthesis: 模型 ID 走地址路径（不产生规则，靠 {model} 占位）', () => {
  const draft = parseDraft({
    ...MINIMAL_DRAFT_BODY,
    submit: { ...BASE_SUBMIT, path: '/v1/models/{model}/generate' },
    model_binding: { location: 'path' },
  });
  const format = buildInterfaceFormatFromDraft(draft, { format_id: 'if_test_model_path', order: 100 });
  assert.equal(Object.values(format.transport.payload_rules).some(
    (rule) => readObject(rule, 'rule')['value'] === '{{model_id}}',
  ), false);
  assert.ok(format.transport.endpoints['submit']?.includes('{model}'));
});

void test('draft synthesis: 模型 ID 走请求体时注入 {{model_id}} 并在合成期渲染', () => {
  const withModel = parseDraft({ ...MINIMAL_DRAFT_BODY, model_binding: { location: 'body', path: 'model' } });
  const format = buildInterfaceFormatFromDraft(withModel, { format_id: 'if_test_model', order: 100 });
  assert.deepEqual(format.transport.payload_rules['body.model'], {
    kind: 'literal',
    value: '{{model_id}}',
  });
  const sources = composeInterfaceFormatSources({ format, modelId: 'my-model', acceptedMediaSlots: [] });
  const runtime = readObject(sources.runtimeModel['runtime'], 'runtime');
  const rules = readObject(runtime['payload_rules'], 'payload rules');
  assert.deepEqual(rules['body.model'], { kind: 'literal', value: 'my-model' });
});

void test('draft synthesis: 嵌套参数路径落到嵌套请求体路径', () => {
  const draft = parseDraft({
    ...MINIMAL_DRAFT_BODY,
    parameters: [{ binding: { location: 'body', path: 'options.size' }, label: '尺寸', type: 'string' }],
    prompt_binding: { location: 'body', path: 'input.text' },
  });
  const format = buildInterfaceFormatFromDraft(draft, { format_id: 'if_test_nested', order: 100 });
  assert.equal('body.input.text' in format.transport.payload_rules, true);
  assert.equal('body.options.size' in format.transport.payload_rules, true);
});

const ASYNC_DRAFT_BODY: JsonRecord = {
  ...MINIMAL_DRAFT_BODY,
  submit: {
    ...BASE_SUBMIT,
    headers: [{ name: 'Accept', value: 'application/json' }],
  },
  behavior: {
    requires_auth: true,
    result: {
      kind: 'needs_fetch',
      identity_field_path: 'output.id',
      content_url_template: '/v1/files/{id}/content',
      accept: 'binary',
      media_type: 'video',
    },
    async: {
      identity_path: 'id',
      polling: {
        path: '/v1/tasks/{id}',
        method: 'POST',
        headers: [{ name: 'X-Poll', value: 'v1' }],
        query: [{ name: 'task_ids', value: '{id}' }],
        body: { id: '{id}', kind: 'status' },
        body_format: 'form',
        content_type: 'application/x-www-form-urlencoded',
        status_path: 'status',
        success_values: ['succeeded'],
        failure_values: ['failed'],
        interval_ms: 5000,
        max_attempts: 10,
      },
    },
  },
};

void test('draft synthesis: 异步轮询 → 轮询请求各段落入实体，配方判定同源', () => {
  const draft = parseDraft(ASYNC_DRAFT_BODY);
  const format = buildInterfaceFormatFromDraft(draft, { format_id: 'if_async', order: 101 });

  assert.ok(format.transport.async !== undefined);
  assert.equal(format.transport.async.identity_path, 'id');
  const polling = format.transport.async.polling;
  assert.equal(polling.url_template, '/v1/tasks/{id}', '查询参数不拼进路径');
  assert.equal(polling.method, 'POST');
  assert.deepEqual(polling.headers, [{ name: 'X-Poll', value: 'v1' }]);
  assert.deepEqual(polling.query, [{ name: 'task_ids', value: '{id}' }]);
  assert.deepEqual(polling.body, { id: '{id}', kind: 'status' });
  assert.equal(polling.body_format, 'form');
  assert.equal(polling.content_type, 'application/x-www-form-urlencoded');

  assert.equal(format.projection.capability['supports_async_task'], true);
  const builtin = format.builtin_behavior;
  assert.ok(builtin !== undefined);
  assert.equal(readObject(builtin.result_rule, 'result_rule')['mode'], 'async');
  assert.deepEqual(builtin.polling_status?.success_values, ['succeeded']);
  assert.deepEqual(builtin.polling_status?.failure_values, ['failed']);

  // 合成期：轮询请求形状是冻结的策略（headers 用 Record、query 用数组、body/body_format/content_type）。
  const recipe = buildInterfaceRecipeFromDraft(draft, 'if_async');
  const sources = composeInterfaceFormatSources({
    format,
    modelId: 'async-model',
    acceptedMediaSlots: [],
    recipe: withRecipeId(recipe),
  });
  const pollingStrategy = readObject(sources.runtimeModel['polling_strategy'], 'polling strategy');
  assert.deepEqual(pollingStrategy['request'], {
    url_template: '/v1/tasks/{id}',
    method: 'POST',
    headers: { 'X-Poll': 'v1' },
    query: [{ name: 'task_ids', value: '{id}' }],
    body: { id: '{id}', kind: 'status' },
    body_format: 'form',
    content_type: 'application/x-www-form-urlencoded',
  });
  const acquisition = readObject(sources.runtimeModel['result_acquisition_strategy'], 'acquisition');
  assert.deepEqual(acquisition['request_headers'], { Accept: 'application/json' });
  assert.deepEqual(acquisition['request_strategy'], {
    request_stage: 'acquisition',
    protocol: 'http',
    endpoint: '/v1/files/{id}/content',
    method: 'GET',
  });

  assert.deepEqual(recipe.success_when, { op: 'in', path: 'status', value: ['succeeded'] });
  assert.deepEqual(recipe.failure_when, { op: 'in', path: 'status', value: ['failed'] });
  assert.equal(recipe.result.kind, 'needs_fetch');
  assert.equal(recipe.requires_auth, true);
});

/** 配方合成需要带 id/时间戳的实体形状；测试只关心判定与结果段。 */
const withRecipeId = (recipe: ReturnType<typeof buildInterfaceRecipeFromDraft>) => ({
  ...recipe,
  recipe_id: 'ir_test_async',
  requires_auth: recipe.requires_auth ?? false,
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(),
});

void test('draft schema: 非法提交路径 / 方法 / 路径冲突被拒', () => {
  const cases: Array<{ name: string; patch: JsonRecord }> = [
    { name: '绝对 URL', patch: { submit: { ...BASE_SUBMIT, path: 'https://api.example.com/v1/gen' } } },
    { name: '协议相对地址', patch: { submit: { ...BASE_SUBMIT, path: '//api.example.com/v1/gen' } } },
    { name: '上级目录', patch: { submit: { ...BASE_SUBMIT, path: '/v1/../admin' } } },
    { name: '不以斜杠开头', patch: { submit: { ...BASE_SUBMIT, path: 'v1/gen' } } },
    { name: '方法不在白名单', patch: { submit: { ...BASE_SUBMIT, method: 'DELETE' } } },
    { name: '提示词路径与参数冲突', patch: { prompt_binding: { location: 'body', path: 'size' } } },
    { name: 'model 路径与提示词冲突', patch: { model_binding: { location: 'body', path: 'prompt' } } },
    {
      name: '参数键重复',
      patch: {
        parameters: [
          { binding: { location: 'body', path: 'a' }, label: 'A', type: 'string' },
          { binding: { location: 'body', path: 'a' }, label: 'A2', type: 'string' },
        ],
      },
    },
    { name: '枚举没有候选值', patch: { parameters: [{ binding: { location: 'body', path: 'q' }, label: 'Q', type: 'enum' }] } },
    { name: '模型 ID 走地址路径但路径没有占位', patch: { model_binding: { location: 'path' } } },
  ];
  for (const item of cases) {
    const merged: JsonRecord = { ...MINIMAL_DRAFT_BODY, ...item.patch };
    const parsed = CustomInterfaceFormatDraftSchema.safeParse(merged);
    assert.equal(parsed.success, false, `${item.name} 必须被拒绝`);
  }
});

void test('draft schema: 再取一次必须声明异步轮询', () => {
  const body: JsonRecord = {
    ...MINIMAL_DRAFT_BODY,
    behavior: {
      result: {
        kind: 'needs_fetch',
        identity_field_path: 'id',
        content_url_template: '/v1/f/{id}',
        accept: 'binary',
        media_type: 'image',
      },
    },
  };
  assert.equal(CustomInterfaceFormatDraftSchema.safeParse(body).success, false);
});

void test('draft synthesis: 素材位 → 媒体清单、输入片段与载体规则', () => {
  const body: JsonRecord = {
    ...MINIMAL_DRAFT_BODY,
    submit: {
      ...BASE_SUBMIT,
      path: '/v1/edit',
      payload_format: 'multipart',
      content_type: null,
    },
    media_slots: [
      {
        slot_id: 'reference_image',
        field_key: 'image',
        label: '参考图',
        required: false,
        max_files: 2,
        carrier: 'multipart_file',
      },
      {
        slot_id: 'first_frame',
        field_key: 'frame',
        label: '首帧',
        required: true,
        max_files: 1,
        carrier: 'public_url',
      },
    ],
  };
  const draft = parseDraft(body);
  const format = buildInterfaceFormatFromDraft(draft, { format_id: 'if_media', order: 102 });

  assert.equal(format.transport.submit.content_type, null, 'multipart 不因默认值写入 Content-Type');
  assert.equal('api.contentType' in format.transport.payload_rules, false);
  assert.deepEqual(format.media.supports, ['reference_image', 'first_frame']);
  assert.deepEqual(format.media.required, ['first_frame']);
  assert.equal(format.media.slots.reference_image?.field_key, 'image');
  assert.deepEqual(format.transport.payload_rules['body.image'], {
    kind: 'field',
    field_key: 'image',
    transforms: ['allUploadFiles'],
    media_target: 'multipart_file',
    multipart_array_naming: 'repeated',
  });
  assert.deepEqual(format.transport.payload_rules['body.frame'], {
    kind: 'field',
    field_key: 'frame',
    transforms: ['extractFirstUrl'],
    media_target: 'public_url',
  });
  const runtimeExtras = readObject(format.projection.runtime_extras, '公网中转声明必须存在');
  assert.equal(runtimeExtras['url_input_upload_mode'], 'public_relay');

  const sources = composeInterfaceFormatSources({
    format,
    modelId: 'media-model',
    acceptedMediaSlots: ['reference_image', 'first_frame'],
  });
  const parameterSchema = readObject(readObject(sources.runtimeModel.parameter_schema, 'schema'), 'schema');
  const fields = parameterSchema['fields'];
  assert.ok(Array.isArray(fields));
  assert.ok(fields.some((field) => readObject(field, 'field')['field_key'] === 'image'));
});

void test('draft schema: 表单文件素材位要求 multipart 提交体', () => {
  const body: JsonRecord = {
    ...MINIMAL_DRAFT_BODY,
    media_slots: [
      { slot_id: 'reference_image', field_key: 'image', label: '参考图', carrier: 'multipart_file' },
    ],
  };
  assert.equal(CustomInterfaceFormatDraftSchema.safeParse(body).success, false);
});
