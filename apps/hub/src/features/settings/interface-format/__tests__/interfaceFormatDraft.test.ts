import { describe, expect, it } from 'vitest';
import { collectIssues } from '../interfaceFormatIssues';
import {
  buildInterfaceFormatDraft,
  isBlankNameValueRow,
  isBlankParameterRow,
  parsePollingBody,
  type EditorState,
  type ParamRow,
} from '../interfaceFormatDraft';

/**
 * 接口格式草稿构建：请求落点（请求体 / 查询参数 / 请求头 / 纯文本正文 / 地址路径）、
 * 固定请求头与固定查询参数、表单形态、轮询请求与查询鉴权。
 *
 * 断言的是**真正会发给后端的草稿形状**（契约 parse 的唯一输入），不是组件内部状态。
 */

const param = (over: Partial<ParamRow> = {}): ParamRow => ({
  location: 'body',
  key: 'size',
  label: '尺寸',
  type: 'string',
  required: false,
  defaultValue: '',
  enumValues: [],
  defaultNote: '',
  locationNote: '',
  ...over,
});

const baseState = (over: Partial<EditorState> = {}): EditorState => ({
  displayName: '我的格式',
  submitPath: '/v1/mine',
  method: 'POST',
  payloadFormat: 'json',
  contentType: 'application/json',
  formFieldStyle: 'dotted',
  formArrayStyle: 'repeat',
  authKind: 'bearer',
  authHeaderName: 'Authorization',
  authPrefix: 'Bearer',
  authQueryName: 'key',
  fixedHeaders: [],
  fixedQuery: [],
  promptLocation: 'body',
  promptKey: 'prompt',
  modelLocation: 'none',
  modelKey: '',
  params: [],
  mediaSlots: [],
  taskMode: 'sync',
  identityPath: '',
  pollingPath: '',
  pollingMethod: 'GET',
  pollingHeaders: [],
  pollingQuery: [],
  pollingBody: '',
  pollingBodyFormat: 'json',
  pollingContentType: '',
  statusPath: '',
  successValues: [],
  failureValues: [],
  intervalMs: '10000',
  maxAttempts: '300',
  resultKind: 'direct_url',
  resultPathsText: 'data.url',
  mediaType: 'image',
  encoding: 'data_url',
  fetchIdentityPath: '',
  contentUrlTemplate: '',
  requiresAuth: false,
  failureRows: [{ path: '', valuesText: '' }],
  failureReason: '',
  ...over,
});

describe('草稿构建：请求落点', () => {
  it('参数的三种发送位置各自写成请求体路径 / 查询参数名 / 请求头名', () => {
    const { draft, parameterRowIndexes } = buildInterfaceFormatDraft(baseState({
      params: [
        param({ key: 'options.size' }),
        param({ location: 'query', key: 'api_version' }),
        param({ location: 'header', key: 'X-Quality' }),
      ],
    }));

    expect(draft.parameters.map((item) => item.binding)).toEqual([
      { location: 'body', path: 'options.size' },
      { location: 'query', name: 'api_version' },
      { location: 'header', name: 'X-Quality' },
    ]);
    expect(parameterRowIndexes).toEqual([0, 1, 2]);
  });

  it('提示词可以发到请求体、查询参数，或整段作为纯文本正文', () => {
    expect(buildInterfaceFormatDraft(baseState()).draft.prompt_binding)
      .toEqual({ location: 'body', path: 'prompt' });
    expect(buildInterfaceFormatDraft(baseState({ promptLocation: 'query', promptKey: 'q' })).draft.prompt_binding)
      .toEqual({ location: 'query', name: 'q' });

    const text = buildInterfaceFormatDraft(baseState({
      payloadFormat: 'text',
      contentType: 'text/plain; charset=utf-8',
      promptLocation: 'text',
      promptKey: '',
    }));
    expect(text.draft.prompt_binding).toEqual({ location: 'text' });
    expect(text.draft.submit.payload_format).toBe('text');
    expect(text.draft.submit.content_type).toBe('text/plain; charset=utf-8');
  });

  it('模型 ID 可以发到请求体、查询参数、地址路径，或不发送', () => {
    expect(buildInterfaceFormatDraft(baseState({ modelLocation: 'body', modelKey: 'model' })).draft.model_binding)
      .toEqual({ location: 'body', path: 'model' });
    expect(buildInterfaceFormatDraft(baseState({ modelLocation: 'query', modelKey: 'm' })).draft.model_binding)
      .toEqual({ location: 'query', name: 'm' });
    expect(buildInterfaceFormatDraft(baseState({ modelLocation: 'path' })).draft.model_binding)
      .toEqual({ location: 'path' });
    expect(buildInterfaceFormatDraft(baseState({ modelLocation: 'none' })).draft.model_binding)
      .toBeUndefined();
  });
});

describe('草稿构建：固定请求头与固定查询参数', () => {
  it('两张表逐行写进草稿，空行跳过', () => {
    const { draft, fixedHeaderRowIndexes, fixedQueryRowIndexes } = buildInterfaceFormatDraft(baseState({
      fixedHeaders: [{ name: 'X-Client', value: 'hub' }, { name: '', value: '' }],
      fixedQuery: [{ name: 'api-version', value: '2026-01-01' }],
    }));

    expect(draft.submit.headers).toEqual([{ name: 'X-Client', value: 'hub' }]);
    expect(fixedHeaderRowIndexes).toEqual([0]);
    expect(draft.submit.query).toEqual([{ name: 'api-version', value: '2026-01-01' }]);
    expect(fixedQueryRowIndexes).toEqual([0]);
    expect(isBlankNameValueRow({ name: ' ', value: '' })).toBe(true);
  });

  it('只填了取值没填名称的行仍进草稿，由契约报「名称要填」', () => {
    const state = baseState({ fixedHeaders: [{ name: '', value: 'hub' }] });
    expect(buildInterfaceFormatDraft(state).draft.submit.headers).toEqual([{ name: '', value: 'hub' }]);
    const issues = collectIssues(state);
    expect(issues.some((issue) => issue.fieldId === 'interface-format-fixed-header-0-name')).toBe(true);
  });

  it('禁止请求头即时报错并指回那一行', () => {
    const issues = collectIssues(baseState({
      fixedHeaders: [{ name: 'Authorization', value: 'Bearer x' }],
    }));
    const hit = issues.find((issue) => issue.fieldId === 'interface-format-fixed-header-0-name');
    expect(hit?.message).toContain('会在发送时自动写入');
  });

  it('固定查询参数重名指回第二行', () => {
    const issues = collectIssues(baseState({
      fixedQuery: [
        { name: 'api-version', value: '1' },
        { name: 'api-version', value: '2' },
      ],
    }));
    expect(issues.some((issue) =>
      issue.fieldId === 'interface-format-fixed-query-1-name'
      && issue.message === '同一个查询参数只能出现一次'
    )).toBe(true);
  });
});

describe('草稿构建：请求体形态', () => {
  it('表单形态带两套写法，默认点号 + 重复同名键', () => {
    const draft = buildInterfaceFormatDraft(baseState({
      payloadFormat: 'form',
      contentType: 'application/x-www-form-urlencoded',
    })).draft;
    expect(draft.submit.form_field_style).toBe('dotted');
    expect(draft.submit.form_array_style).toBe('repeat');

    const bracket = buildInterfaceFormatDraft(baseState({
      payloadFormat: 'form',
      formFieldStyle: 'bracket',
      formArrayStyle: 'index',
    })).draft;
    expect(bracket.submit.form_field_style).toBe('bracket');
    expect(bracket.submit.form_array_style).toBe('index');
  });

  it('纯文本请求体带请求体参数时，错误指回那条参数行', () => {
    const issues = collectIssues(baseState({
      payloadFormat: 'text',
      contentType: 'text/plain; charset=utf-8',
      promptLocation: 'text',
      promptKey: '',
      params: [param({ key: 'size' })],
    }));
    const hit = issues.find((issue) => issue.fieldId === 'interface-format-param-0-key');
    expect(hit?.message).toContain('纯文本请求体里没有字段');
  });

  it('纯文本请求体带素材位时，错误指回素材位分节', () => {
    const issues = collectIssues(baseState({
      payloadFormat: 'text',
      contentType: 'text/plain; charset=utf-8',
      promptLocation: 'text',
      promptKey: '',
      mediaSlots: [{
        slotId: 'reference_image',
        fieldKey: 'image',
        label: '参考图',
        required: false,
        maxFiles: '1',
        carrier: 'public_url',
      }],
    }));
    expect(issues.some((issue) => issue.message === '纯文本请求体不能带素材位，请把素材位删掉或换一种请求体'))
      .toBe(true);
  });

  it('multipart 文件素材位只能配表单上传：换成 JSON 后错误指回上传方式', () => {
    const issues = collectIssues(baseState({
      payloadFormat: 'json',
      mediaSlots: [{
        slotId: 'reference_image',
        fieldKey: 'image',
        label: '参考图',
        required: false,
        maxFiles: '1',
        carrier: 'multipart_file',
      }],
    }));
    expect(issues.some((issue) =>
      issue.fieldId === 'interface-format-media-0-carrier'
      && issue.message.includes('请把请求体改成「表单上传」')
    )).toBe(true);
  });

  it('模型 ID 放进地址路径但提交路径没有 {model} 时，错误指向提交路径', () => {
    const issues = collectIssues(baseState({ modelLocation: 'path' }));
    expect(issues.some((issue) =>
      issue.fieldId === 'interface-format-submit-path'
      && issue.message.includes('必须写 {model}')
    )).toBe(true);
  });
});

describe('草稿构建：鉴权与轮询', () => {
  it('查询参数鉴权只写 query_name，不带请求头字段', () => {
    const draft = buildInterfaceFormatDraft(baseState({
      authKind: 'query_api_key',
      authQueryName: 'api_key',
    })).draft;
    expect(draft.submit.auth).toEqual({ kind: 'query_api_key', query_name: 'api_key' });
  });

  it('header 形态鉴权保留头名；bearer 才写前缀', () => {
    expect(buildInterfaceFormatDraft(baseState({
      authKind: 'header_api_key',
      authHeaderName: 'x-api-key',
      authPrefix: 'Bearer',
    })).draft.submit.auth).toEqual({ kind: 'header_api_key', header_name: 'x-api-key' });

    expect(buildInterfaceFormatDraft(baseState()).draft.submit.auth)
      .toEqual({ kind: 'bearer', header_name: 'Authorization', prefix: 'Bearer' });
  });

  it('POST 轮询带上请求头、查询参数与 JSON 请求体（取值可含 {id} 占位）', () => {
    const draft = buildInterfaceFormatDraft(baseState({
      taskMode: 'async',
      identityPath: 'id',
      pollingPath: '/v1/tasks/{id}',
      pollingMethod: 'POST',
      pollingHeaders: [{ name: 'X-Poll', value: '{id}' }],
      pollingQuery: [{ name: 'task', value: '{id}' }],
      pollingBody: '{"task_id": "{id}"}',
      pollingBodyFormat: 'form',
      pollingContentType: 'application/x-www-form-urlencoded',
      statusPath: 'status',
      successValues: ['succeeded'],
    })).draft;

    expect(draft.behavior.async?.polling).toMatchObject({
      path: '/v1/tasks/{id}',
      method: 'POST',
      headers: [{ name: 'X-Poll', value: '{id}' }],
      query: [{ name: 'task', value: '{id}' }],
      body: { task_id: '{id}' },
      body_format: 'form',
      content_type: 'application/x-www-form-urlencoded',
    });
  });

  it('GET 轮询不带请求体（请求体字段只在 POST 下渲染）', () => {
    const draft = buildInterfaceFormatDraft(baseState({
      taskMode: 'async',
      identityPath: 'id',
      pollingPath: '/v1/tasks/{id}',
      pollingMethod: 'GET',
      pollingBody: '{"task_id": "{id}"}',
      statusPath: 'status',
      successValues: ['succeeded'],
    })).draft;
    expect(draft.behavior.async?.polling.body).toBeUndefined();
  });

  it('轮询请求体不是 JSON 时拦住保存并指回请求体文本框', () => {
    const issues = collectIssues(baseState({
      taskMode: 'async',
      identityPath: 'id',
      pollingPath: '/v1/tasks/{id}',
      pollingMethod: 'POST',
      pollingBody: '{task_id: "{id}"}',
      statusPath: 'status',
      successValues: ['succeeded'],
    }));
    expect(issues.some((issue) =>
      issue.fieldId === 'interface-format-polling-body'
      && issue.message.includes('不是有效的 JSON')
    )).toBe(true);
  });

  it('轮询请求体解析：空文本表示不带请求体', () => {
    expect(parsePollingBody('  ')).toEqual({ ok: true, value: undefined });
    expect(parsePollingBody('{"a": 1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parsePollingBody('nope').ok).toBe(false);
  });
});

describe('草稿构建：空白行判定', () => {
  it('参数行只换过发送位置也算填写中（不能当空白丢掉）', () => {
    expect(isBlankParameterRow(param({ location: 'body', key: '', label: '' }))).toBe(true);
    expect(isBlankParameterRow(param({ location: 'query', key: '', label: '' }))).toBe(false);
    expect(isBlankParameterRow(param({ location: 'body', key: '', label: '', required: true }))).toBe(false);
  });
});
