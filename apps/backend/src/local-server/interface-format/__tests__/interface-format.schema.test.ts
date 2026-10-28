import assert from 'node:assert/strict';
import test from 'node:test';

import type { InterfaceFormat } from '../schema.cts';
import { InterfaceFormatSchema } from '../schema.cts';
import { loadPresetFormats } from '../registry.cts';

/**
 * 接口格式实体 schema 的请求落点校验（2026-10-27 自定义格式请求方式批次）。
 *
 * 覆盖：
 * - 预设仍然全部可解析（新增字段必须带默认值，否则内置格式会被整条丢弃）；
 * - `api.headers.*` / `api.query.*` 的名称合法性、禁止头、与鉴权声明的冲突；
 * - 路径里的静态查询串与规则/鉴权的查询参数重名；
 * - `payload_format = 'text'` 的三条约束（提示词规则在 `body`、无请求体字段、无素材位）；
 * - 轮询段的请求体 / 请求头 / 查询参数（body 只在 POST、form 必须是对象且 form 编码）；
 * - 查询参数鉴权（`query_api_key`）。
 */

const issueMessages = (value: unknown): string[] => {
  const parsed = InterfaceFormatSchema.safeParse(value);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
};

const preset = (formatId: string) => {
  const found = loadPresetFormats().find((item) => item.format_id === formatId);
  assert.ok(found, `预设 ${formatId} 必须存在`);
  return structuredClone(found);
};

/** 用例可自由改写的宽形态（逐处改动后用 schema 的 parse 结果做断言）。 */
type MutableFormat = {
  schema_version: number;
  format_id: string;
  version: string;
  display_name: string;
  family: string;
  origin: string;
  status: string;
  order: number;
  transport: {
    auth: Record<string, unknown>;
    endpoints: Record<string, string>;
    submit: Record<string, unknown>;
    payload_rules: Record<string, unknown>;
  };
  parameters: Record<string, unknown>;
  media: Record<string, unknown>;
  projection: Record<string, unknown>;
  composition: Record<string, unknown>;
  localization: Record<string, unknown>;
};

/** 最小可用的用户格式（json 请求体），供各用例按需改一处。 */
const minimalFormat = (overrides: Record<string, unknown> = {}): MutableFormat => ({
  schema_version: 1,
  format_id: 'test-format',
  version: '1.0.0',
  display_name: '测试格式',
  family: 'generation',
  origin: 'user',
  status: 'ready',
  order: 100,
  transport: {
    auth: { kind: 'bearer', header_name: 'Authorization', prefix: 'Bearer' },
    endpoints: { submit: '/v1/generate' },
    submit: {
      endpoint_key: 'submit',
      method: 'POST',
      content_type: 'application/json',
      payload_format: 'json',
    },
    payload_rules: {
      'api.endpoint': { kind: 'literal', value: '{{endpoint:submit}}' },
      'api.method': { kind: 'literal', value: '{{method:submit}}' },
      'api.contentType': { kind: 'literal', value: '{{content_type:submit}}' },
      'body.prompt': { kind: 'field', field_key: '__prompt', transforms: ['trim'] },
      'prompt': { kind: 'field', field_key: '__prompt', transforms: ['trim'] },
    },
  },
  parameters: {
    schema: { fields: [], required_fields: [], validation_rules: [] },
    defaults: {},
    prompt_field: { field_key: '__prompt', required: true, validation_rules: [] },
  },
  media: { supports: [], required: [], slots: {} },
  projection: {
    provider_id: 'custom',
    group_key: 'custom',
    capability: {},
    execution_profile: { task_type: 'image', supports_async_task: false },
    display: {},
    workspace: {},
    execution_driver: 'http_formal_task',
    node: { node_type: 'model', output_ports: [{ id: 'image' }] },
  },
  composition: { fragments: {}, variants: [] },
  localization: { 'zh-CN': {} },
  ...overrides,
});

const withSubmit = (value: MutableFormat, patch: Record<string, unknown>): MutableFormat => ({
  ...value,
  transport: {
    ...value.transport,
    submit: { ...value.transport.submit, ...patch },
  },
});

const withRules = (value: MutableFormat, rules: Record<string, unknown>): MutableFormat => ({
  ...value,
  transport: {
    ...value.transport,
    payload_rules: { ...value.transport.payload_rules, ...rules },
  },
});

const withAuth = (value: MutableFormat, auth: Record<string, unknown>): MutableFormat => ({
  ...value,
  transport: { ...value.transport, auth },
});

/** 取异步轮询段（预设必有轮询；缺失即测试前置条件坏了）。 */
const requirePolling = (format: InterfaceFormat) => {
  const asyncConfig = format.transport.async;
  assert.ok(asyncConfig !== undefined, '该预设必须声明异步轮询段');
  return asyncConfig.polling;
};

void test('全部预设仍可解析：新增字段都有默认值，没有格式被静默丢弃', () => {
  const formats = loadPresetFormats();
  assert.equal(formats.length, 8);
  for (const format of formats) {
    assert.equal(format.transport.submit.form_field_style, 'dotted');
    assert.equal(format.transport.submit.form_array_style, 'repeat');
    if (format.transport.async !== undefined) {
      assert.deepEqual(format.transport.async.polling.headers, []);
      assert.deepEqual(format.transport.async.polling.query, []);
      assert.equal(format.transport.async.polling.body_format, 'json');
      assert.equal(format.transport.async.polling.content_type, null);
    }
  }
});

void test('预设 openai-image 的 api.headers.Accept 仍然合法', () => {
  const format = preset('openai-image-v1');
  assert.deepEqual(format.transport.payload_rules['api.headers.Accept'], {
    kind: 'literal',
    value: 'application/json',
  });
  assert.deepEqual(issueMessages(format), []);
});

void test('最小 json 格式通过，submit 表单编码字段取默认值', () => {
  const parsed = InterfaceFormatSchema.parse(minimalFormat());
  assert.equal(parsed.transport.submit.form_field_style, 'dotted');
  assert.equal(parsed.transport.submit.form_array_style, 'repeat');
  assert.equal(parsed.transport.auth.kind, 'bearer');
});

void test('固定请求头 / 查询参数：合法名称通过，非法与禁止名称被拒绝', () => {
  assert.deepEqual(
    issueMessages(
      withRules(minimalFormat(), {
        'api.headers.X-Trace': { kind: 'literal', value: 'abc' },
        'api.query.page': { kind: 'literal', value: '1' },
      }),
    ),
    [],
  );

  assert.ok(
    issueMessages(withRules(minimalFormat(), { 'api.headers.bad name': { kind: 'literal', value: 'x' } }))
      .includes('interface_format_header_name_invalid'),
  );
  assert.ok(
    issueMessages(withRules(minimalFormat(), { 'api.headers.Content-Type': { kind: 'literal', value: 'x' } }))
      .includes('interface_format_header_name_forbidden'),
  );
  assert.ok(
    issueMessages(withRules(minimalFormat(), { 'api.query.a&b': { kind: 'literal', value: 'x' } }))
      .includes('interface_format_query_name_invalid'),
  );
});

void test('规则里的鉴权头 / 鉴权查询参数不得与鉴权声明重名', () => {
  assert.ok(
    issueMessages(
      withRules(minimalFormat(), { 'api.headers.Authorization': { kind: 'literal', value: 'x' } }),
    ).includes('interface_format_rule_conflicts_with_auth_header'),
  );
  assert.ok(
    issueMessages(
      withAuth(withRules(minimalFormat(), { 'api.query.key': { kind: 'literal', value: 'x' } }), {
        kind: 'query_api_key',
        query_name: 'key',
      }),
    ).includes('interface_format_rule_conflicts_with_auth_query'),
  );
});

void test('查询参数鉴权：query_name 合法性与路径静态查询串冲突', () => {
  const queryAuth = withAuth(minimalFormat(), { kind: 'query_api_key', query_name: 'key' });
  assert.deepEqual(issueMessages(queryAuth), []);
  assert.equal(InterfaceFormatSchema.parse(queryAuth).transport.auth.kind, 'query_api_key');

  assert.ok(
    issueMessages(withAuth(minimalFormat(), { kind: 'query_api_key', query_name: 'a b' })).includes(
      'interface_format_query_name_invalid',
    ),
  );

  const conflictingPath = withSubmit(queryAuth, { endpoint_key: 'submit' });
  conflictingPath.transport.endpoints = { submit: '/v1/generate?key=1' };
  assert.ok(
    issueMessages(conflictingPath).includes('interface_format_submit_path_query_conflicts'),
  );

  const conflictingRule = withRules(queryAuth, { 'api.query.page': { kind: 'literal', value: '1' } });
  conflictingRule.transport.endpoints = { submit: '/v1/generate?page=1' };
  assert.ok(issueMessages(conflictingRule).includes('interface_format_submit_path_query_conflicts'));
});

void test('payload_format = text：提示词规则必须在 body，且无请求体字段与素材位', () => {
  const textFormat = withRules(
    withSubmit(minimalFormat(), { payload_format: 'text', content_type: null }),
    {},
  );
  textFormat.transport.payload_rules = {
    'api.endpoint': { kind: 'literal', value: '{{endpoint:submit}}' },
    'api.method': { kind: 'literal', value: '{{method:submit}}' },
    body: { kind: 'field', field_key: '__prompt', transforms: ['trim'] },
  };
  assert.deepEqual(issueMessages(textFormat), []);

  // 缺 `body` 规则 → 提示词没有落点。
  const missingBodyRule = withSubmit(minimalFormat(), { payload_format: 'text', content_type: null });
  assert.ok(
    issueMessages(missingBodyRule).includes('interface_format_text_payload_requires_prompt_rule'),
  );

  // 带请求体字段 → 拒绝。
  const withBodyField = withRules(minimalFormat(), {
    'body.size': { kind: 'field', field_key: 'size' },
  });
  assert.ok(
    issueMessages(withSubmit(withBodyField, { payload_format: 'text', content_type: null })).includes(
      'interface_format_text_payload_forbids_body_fields',
    ),
  );

  // 预设带素材位：改成 text 后素材位必须拒绝（同时会报请求体字段）。
  const presetText = preset('openai-image-v1');
  presetText.transport.submit.payload_format = 'text';
  presetText.transport.submit.content_type = null;
  presetText.transport.payload_rules.body = { kind: 'field', field_key: '__prompt' };
  assert.ok(issueMessages(presetText).includes('interface_format_text_payload_forbids_media_slots'));

  // 非 text 形态出现 `body` 目标 → 拒绝。
  assert.ok(
    issueMessages(withRules(minimalFormat(), { body: { kind: 'field', field_key: '__prompt' } })).includes(
      'interface_format_body_text_rule_requires_text_payload',
    ),
  );
});

void test('form 提交的 Content-Type 必须是 form 编码', () => {
  assert.deepEqual(
    issueMessages(withSubmit(minimalFormat(), { payload_format: 'form', content_type: null })),
    [],
  );
  assert.deepEqual(
    issueMessages(
      withSubmit(minimalFormat(), {
        payload_format: 'form',
        content_type: 'application/x-www-form-urlencoded; charset=utf-8',
      }),
    ),
    [],
  );
  assert.ok(
    issueMessages(withSubmit(minimalFormat(), { payload_format: 'form', content_type: 'application/json' }))
      .includes('interface_format_form_content_type_invalid'),
  );
});

void test('轮询段：请求头 / 查询参数 / 请求体被保留，body 只在 POST 允许', () => {
  const format = preset('kling-text2video-v1');
  const polling = requirePolling(format);
  polling.method = 'POST';
  polling.headers = [{ name: 'X-Poll', value: '{requestId}' }];
  polling.query = [{ name: 'ids', value: '{id}' }];
  polling.body = { ids: ['{id}'] };
  polling.body_format = 'json';
  polling.content_type = 'application/json';
  const parsed = InterfaceFormatSchema.parse(format);
  assert.deepEqual(parsed.transport.async?.polling.headers, [{ name: 'X-Poll', value: '{requestId}' }]);
  assert.deepEqual(parsed.transport.async?.polling.query, [{ name: 'ids', value: '{id}' }]);
  assert.deepEqual(parsed.transport.async?.polling.body, { ids: ['{id}'] });

  const getWithBody = preset('kling-text2video-v1');
  requirePolling(getWithBody).body = { ids: ['{id}'] };
  assert.ok(issueMessages(getWithBody).includes('interface_format_polling_body_requires_post'));
});

void test('轮询 form 请求体：必须是对象、Content-Type 必须是 form 编码', () => {
  const format = preset('kling-text2video-v1');
  const polling = requirePolling(format);
  polling.method = 'POST';
  polling.body = ['a'];
  polling.body_format = 'form';
  assert.ok(issueMessages(format).includes('interface_format_polling_form_body_must_be_object'));

  const wrongContentType = preset('kling-text2video-v1');
  const wrongPolling = requirePolling(wrongContentType);
  wrongPolling.method = 'POST';
  wrongPolling.body = { id: '{id}' };
  wrongPolling.body_format = 'form';
  wrongPolling.content_type = 'application/json';
  assert.ok(issueMessages(wrongContentType).includes('interface_format_form_content_type_invalid'));
});

void test('轮询路径静态查询串与轮询查询参数 / 鉴权 query 名冲突被拒绝', () => {
  const format = preset('kling-text2video-v1');
  requirePolling(format).query = [{ name: 'task_ids', value: '{id}' }];
  assert.ok(issueMessages(format).includes('interface_format_polling_path_query_conflicts'));

  const queryAuth = preset('kling-text2video-v1');
  queryAuth.transport.auth = { kind: 'query_api_key', query_name: 'task_ids' };
  // 鉴权 query 名与轮询路径里的静态参数 `task_ids` 撞名（kling 预设轮询地址为
  // `/tasks?task_ids={id}`），同一个键出现两次。
  assert.ok(issueMessages(queryAuth).includes('interface_format_polling_path_query_conflicts'));
});
