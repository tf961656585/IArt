import { describe, expect, it } from 'vitest';

import {
  CustomInterfaceFormatDraftSchema,
  defaultCustomInterfaceFormatContentType,
  isUrlEncodedFormContentType,
} from '../src/custom-interface-format-contract';
import {
  extractQueryParamNamesFromPath,
  formatInterfaceFormatBindingTarget,
  interfaceFormatBodyPathsOverlap,
  isForbiddenRequestHeaderName,
  isValidHttpHeaderName,
  isValidHttpHeaderValue,
  isValidQueryParamName,
  parseInterfaceFormatRuleTarget,
} from '../src/interface-format-binding';

/**
 * 自定义接口格式**草稿**的请求落点、固定常量与请求体形态。
 *
 * 详情视图 DTO 的用例在 `interface-format-contract.test.ts`；本文件只覆盖 Hub 提交的输入形状
 * 与它的跨字段校验（三个命名空间分别查重、固定常量与动态落点不能撞名、text / form / 轮询约束）。
 */

// ---------------------------------------------------------------------------
// 草稿：请求落点、固定常量、请求体形态
// ---------------------------------------------------------------------------

const minimalDraft = {
  display_name: '测试接口',
  submit: {
    path: '/v1/generate',
    method: 'POST',
    payload_format: 'json',
    content_type: 'application/json',
    auth: { kind: 'bearer', header_name: 'Authorization', prefix: 'Bearer' },
  },
  prompt_binding: { location: 'body', path: 'prompt' },
  behavior: { result: { kind: 'direct_url', media_field_paths: ['data.0.url'], media_type: 'image' } },
};

const draftIssueMessages = (draft: unknown): string[] => {
  const parsed = CustomInterfaceFormatDraftSchema.safeParse(draft);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
};

const parameter = (binding: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  binding,
  label: '参数',
  type: 'string',
  ...extra,
});

describe('共享落点工具（规则 target ↔ binding）', () => {
  it('解析请求规则 target 的六类形态', () => {
    expect(parseInterfaceFormatRuleTarget('body.prompt')).toEqual({ kind: 'body_field', path: 'prompt' });
    expect(parseInterfaceFormatRuleTarget('body')).toEqual({ kind: 'body_text' });
    expect(parseInterfaceFormatRuleTarget('api.query.key')).toEqual({ kind: 'query', name: 'key' });
    expect(parseInterfaceFormatRuleTarget('api.headers.Accept')).toEqual({ kind: 'header', name: 'Accept' });
    expect(parseInterfaceFormatRuleTarget('api.endpoint')).toEqual({ kind: 'api_endpoint' });
    expect(parseInterfaceFormatRuleTarget('api.contentType')).toEqual({ kind: 'api_content_type' });
    expect(parseInterfaceFormatRuleTarget('meta.size')).toEqual({ kind: 'meta', path: 'size' });
    expect(parseInterfaceFormatRuleTarget('prompt')).toEqual({ kind: 'other', target: 'prompt' });
    expect(parseInterfaceFormatRuleTarget('api.query.')).toEqual({ kind: 'other', target: 'api.query.' });
  });

  it('binding → target 与解析互逆（text 落到 body）', () => {
    expect(formatInterfaceFormatBindingTarget({ location: 'body', path: 'input.text' })).toBe('body.input.text');
    expect(formatInterfaceFormatBindingTarget({ location: 'text' })).toBe('body');
    expect(formatInterfaceFormatBindingTarget({ location: 'query', name: 'key' })).toBe('api.query.key');
    expect(formatInterfaceFormatBindingTarget({ location: 'header', name: 'X-Trace' })).toBe(
      'api.headers.X-Trace',
    );
    for (const target of ['body.prompt', 'api.query.key', 'api.headers.X-Trace']) {
      const parsed = parseInterfaceFormatRuleTarget(target);
      if (parsed.kind === 'body_field') {
        expect(formatInterfaceFormatBindingTarget({ location: 'body', path: parsed.path })).toBe(target);
      } else if (parsed.kind === 'query') {
        expect(formatInterfaceFormatBindingTarget({ location: 'query', name: parsed.name })).toBe(target);
      } else if (parsed.kind === 'header') {
        expect(formatInterfaceFormatBindingTarget({ location: 'header', name: parsed.name })).toBe(target);
      }
    }
  });

  it('请求头 / 查询参数名称与值校验', () => {
    expect(isValidHttpHeaderName('X-Trace-Id')).toBe(true);
    expect(isValidHttpHeaderName('bad header')).toBe(false);
    expect(isForbiddenRequestHeaderName('Content-Type')).toBe(true);
    expect(isForbiddenRequestHeaderName('authorization')).toBe(true);
    expect(isForbiddenRequestHeaderName('X-Trace')).toBe(false);
    expect(isValidHttpHeaderValue('a\tb')).toBe(false);
    expect(isValidHttpHeaderValue('line1\r\nline2')).toBe(false);
    expect(isValidHttpHeaderValue('x'.repeat(8193))).toBe(false);
    expect(isValidQueryParamName('filter[status]')).toBe(true);
    expect(isValidQueryParamName('a&b')).toBe(false);
    expect(isValidQueryParamName('a b')).toBe(false);
  });

  it('从路径里提取静态查询参数名（跳过占位值、解码百分号编码）', () => {
    expect(extractQueryParamNamesFromPath('/v1/images/generations')).toEqual([]);
    expect(extractQueryParamNamesFromPath('/tasks?task_ids={id}')).toEqual(['task_ids']);
    expect(extractQueryParamNamesFromPath('/x?a=1&b=&c')).toEqual(['a', 'b', 'c']);
    expect(extractQueryParamNamesFromPath('/x?%6Bey=s')).toEqual(['key']);
  });

  it('请求体路径重叠按点号分段判定', () => {
    expect(interfaceFormatBodyPathsOverlap('input', 'input.text')).toBe(true);
    expect(interfaceFormatBodyPathsOverlap('input.text', 'input')).toBe(true);
    expect(interfaceFormatBodyPathsOverlap('input', 'inputText')).toBe(false);
    expect(interfaceFormatBodyPathsOverlap('input', 'input')).toBe(true);
  });
});

describe('请求体形态默认 Content-Type', () => {
  it('json / form / text 有标准默认，multipart 为 null（边界由运行时生成）', () => {
    expect(defaultCustomInterfaceFormatContentType('json')).toBe('application/json');
    expect(defaultCustomInterfaceFormatContentType('form')).toBe('application/x-www-form-urlencoded');
    expect(defaultCustomInterfaceFormatContentType('text')).toBe('text/plain; charset=utf-8');
    expect(defaultCustomInterfaceFormatContentType('multipart')).toBeNull();
  });

  it('form 内容类型判定允许 charset 参数', () => {
    expect(isUrlEncodedFormContentType('application/x-www-form-urlencoded')).toBe(true);
    expect(isUrlEncodedFormContentType('application/x-www-form-urlencoded; charset=utf-8')).toBe(true);
    expect(isUrlEncodedFormContentType('text/plain')).toBe(false);
  });
});

describe('CustomInterfaceFormatDraftSchema：落点与固定常量', () => {
  it('最小草稿通过，submit 的新字段取默认值', () => {
    const parsed = CustomInterfaceFormatDraftSchema.parse(minimalDraft);
    expect(parsed.submit.headers).toEqual([]);
    expect(parsed.submit.query).toEqual([]);
    expect(parsed.submit.form_field_style).toBe('dotted');
    expect(parsed.submit.form_array_style).toBe('repeat');
    expect(parsed.prompt_binding).toEqual({ location: 'body', path: 'prompt' });
    expect(parsed.model_binding).toBeUndefined();
  });

  it('参数可发到请求体 / 查询参数 / 请求头', () => {
    expect(
      draftIssueMessages({
        ...minimalDraft,
        parameters: [
          parameter({ location: 'body', path: 'options.size' }),
          parameter({ location: 'query', name: 'size' }),
          parameter({ location: 'header', name: 'X-Size' }),
        ],
      }),
    ).toEqual([]);
  });

  it('提示词可发到查询参数；模型 ID 可发到查询参数或地址路径', () => {
    expect(
      draftIssueMessages({
        ...minimalDraft,
        prompt_binding: { location: 'query', name: 'q' },
        model_binding: { location: 'query', name: 'model' },
      }),
    ).toEqual([]);
    expect(
      draftIssueMessages({
        ...minimalDraft,
        submit: { ...minimalDraft.submit, path: '/v1/models/{model}/generate' },
        model_binding: { location: 'path' },
      }),
    ).toEqual([]);
  });

  it('模型 ID 选地址路径时提交路径必须带 {model} 占位', () => {
    expect(draftIssueMessages({ ...minimalDraft, model_binding: { location: 'path' } })).toContain(
      'interface_format_model_path_binding_requires_placeholder',
    );
  });

  it('三个命名空间分别查重：请求体按重叠、查询参数按全等、请求头忽略大小写', () => {
    expect(
      draftIssueMessages({
        ...minimalDraft,
        parameters: [
          parameter({ location: 'query', name: 'size' }),
          parameter({ location: 'query', name: 'size' }),
        ],
      }),
    ).toContain('interface_format_parameter_key_duplicated');

    expect(
      draftIssueMessages({
        ...minimalDraft,
        parameters: [
          parameter({ location: 'header', name: 'X-Trace' }),
          parameter({ location: 'header', name: 'x-trace' }),
        ],
      }),
    ).toContain('interface_format_parameter_key_duplicated');

    // 同一个名字在不同命名空间不是冲突。
    expect(
      draftIssueMessages({
        ...minimalDraft,
        parameters: [
          parameter({ location: 'query', name: 'size' }),
          parameter({ location: 'header', name: 'size' }),
        ],
      }),
    ).toEqual([]);
  });

  it('参数不能占用提示词保留键 __prompt（仅请求体命名空间）', () => {
    expect(
      draftIssueMessages({
        ...minimalDraft,
        parameters: [parameter({ location: 'body', path: '__prompt' })],
      }),
    ).toContain('interface_format_field_key_reserved');
  });

  it('提示词 / 模型 ID 与参数在同一命名空间撞名要拒绝', () => {
    expect(
      draftIssueMessages({
        ...minimalDraft,
        prompt_binding: { location: 'body', path: 'input.text' },
        parameters: [parameter({ location: 'body', path: 'input' })],
      }),
    ).toContain('interface_format_prompt_path_conflicts_with_parameter');

    expect(
      draftIssueMessages({
        ...minimalDraft,
        prompt_binding: { location: 'body', path: 'input.text' },
        model_binding: { location: 'body', path: 'input' },
      }),
    ).toContain('interface_format_model_path_conflicts');
  });

  it('固定请求头：合法名称通过，禁止头 / 非法名称 / 大小写重名被拒绝', () => {
    expect(
      draftIssueMessages({
        ...minimalDraft,
        submit: {
          ...minimalDraft.submit,
          headers: [{ name: 'Accept', value: 'application/json' }],
        },
      }),
    ).toEqual([]);

    expect(
      draftIssueMessages({
        ...minimalDraft,
        submit: {
          ...minimalDraft.submit,
          headers: [{ name: 'Content-Type', value: 'application/json' }],
        },
      }),
    ).toContain('interface_format_header_name_forbidden');

    expect(
      draftIssueMessages({
        ...minimalDraft,
        submit: {
          ...minimalDraft.submit,
          headers: [{ name: 'bad header', value: 'x' }],
        },
      }),
    ).toContain('interface_format_header_name_invalid');

    expect(
      draftIssueMessages({
        ...minimalDraft,
        submit: {
          ...minimalDraft.submit,
          headers: [
            { name: 'X-Trace', value: 'a' },
            { name: 'x-trace', value: 'b' },
          ],
        },
      }),
    ).toContain('interface_format_fixed_header_duplicated');
  });

  it('固定请求头值拒绝 CR/LF', () => {
    expect(
      draftIssueMessages({
        ...minimalDraft,
        submit: {
          ...minimalDraft.submit,
          headers: [{ name: 'X-Trace', value: 'a\r\nInjected: 1' }],
        },
      }),
    ).toContain('interface_format_header_value_invalid');
  });

  it('固定请求头不得与参数 header 落点、鉴权头重名', () => {
    expect(
      draftIssueMessages({
        ...minimalDraft,
        parameters: [parameter({ location: 'header', name: 'X-Trace' })],
        submit: {
          ...minimalDraft.submit,
          headers: [{ name: 'X-Trace', value: 'a' }],
        },
      }),
    ).toContain('interface_format_fixed_header_conflicts');

    expect(
      draftIssueMessages({
        ...minimalDraft,
        submit: {
          ...minimalDraft.submit,
          auth: { kind: 'bearer', header_name: 'X-Api-Key', prefix: 'Bearer' },
          headers: [{ name: 'x-api-key', value: 'a' }],
        },
      }),
    ).toContain('interface_format_fixed_header_conflicts');
  });

  it('固定查询参数不得与参数 / 提示词 / 模型 ID / 鉴权 query 名重名', () => {
    expect(
      draftIssueMessages({
        ...minimalDraft,
        parameters: [parameter({ location: 'query', name: 'size' })],
        submit: { ...minimalDraft.submit, query: [{ name: 'size', value: '1' }] },
      }),
    ).toContain('interface_format_fixed_query_conflicts');

    expect(
      draftIssueMessages({
        ...minimalDraft,
        prompt_binding: { location: 'query', name: 'q' },
        submit: { ...minimalDraft.submit, query: [{ name: 'q', value: '1' }] },
      }),
    ).toContain('interface_format_fixed_query_conflicts');

    expect(
      draftIssueMessages({
        ...minimalDraft,
        submit: {
          ...minimalDraft.submit,
          auth: { kind: 'query_api_key', query_name: 'key' },
          query: [{ name: 'key', value: '1' }],
        },
      }),
    ).toContain('interface_format_fixed_query_conflicts');
  });

  it('提交路径里的静态查询串不得与固定查询 / 动态查询 / 鉴权 query 重名', () => {
    expect(
      draftIssueMessages({
        ...minimalDraft,
        submit: {
          ...minimalDraft.submit,
          path: '/v1/generate?key=1',
          auth: { kind: 'query_api_key', query_name: 'key' },
        },
      }),
    ).toContain('interface_format_submit_path_query_conflicts');

    expect(
      draftIssueMessages({
        ...minimalDraft,
        submit: {
          ...minimalDraft.submit,
          path: '/v1/generate?size=1',
          query: [{ name: 'size', value: '1' }],
        },
      }),
    ).toContain('interface_format_submit_path_query_conflicts');
  });
});

describe('CustomInterfaceFormatDraftSchema：form 与 text 请求体', () => {
  it('form 形态：缺省 Content-Type 可用，填写必须是 form 编码', () => {
    expect(
      draftIssueMessages({
        ...minimalDraft,
        submit: { ...minimalDraft.submit, payload_format: 'form', content_type: null },
      }),
    ).toEqual([]);
    expect(
      draftIssueMessages({
        ...minimalDraft,
        submit: {
          ...minimalDraft.submit,
          payload_format: 'form',
          content_type: 'application/x-www-form-urlencoded; charset=utf-8',
        },
      }),
    ).toEqual([]);
    expect(
      draftIssueMessages({
        ...minimalDraft,
        submit: { ...minimalDraft.submit, payload_format: 'form', content_type: 'application/json' },
      }),
    ).toContain('interface_format_form_content_type_invalid');
  });

  it('text 形态：提示词必须是纯文本正文，不允许请求体参数与素材位', () => {
    expect(
      draftIssueMessages({
        ...minimalDraft,
        submit: { ...minimalDraft.submit, payload_format: 'text', content_type: null },
        prompt_binding: { location: 'text' },
      }),
    ).toEqual([]);

    // 提示词仍发到请求体路径 → 拒绝。
    expect(
      draftIssueMessages({
        ...minimalDraft,
        submit: { ...minimalDraft.submit, payload_format: 'text', content_type: null },
        prompt_binding: { location: 'body', path: 'prompt' },
      }),
    ).toContain('interface_format_text_payload_requires_text_prompt');

    // 非 text 形态却声明纯文本正文 → 拒绝。
    expect(
      draftIssueMessages({ ...minimalDraft, prompt_binding: { location: 'text' } }),
    ).toContain('interface_format_text_binding_requires_text_payload');

    // text 形态下带请求体参数 → 拒绝；查询参数 / 请求头参数仍可存在。
    expect(
      draftIssueMessages({
        ...minimalDraft,
        submit: { ...minimalDraft.submit, payload_format: 'text', content_type: null },
        prompt_binding: { location: 'text' },
        parameters: [parameter({ location: 'body', path: 'size' })],
      }),
    ).toContain('interface_format_text_payload_forbids_body_fields');
    expect(
      draftIssueMessages({
        ...minimalDraft,
        submit: { ...minimalDraft.submit, payload_format: 'text', content_type: null },
        prompt_binding: { location: 'text' },
        parameters: [parameter({ location: 'query', name: 'size' })],
      }),
    ).toEqual([]);

    // text 形态下带素材位 → 拒绝。
    expect(
      draftIssueMessages({
        ...minimalDraft,
        submit: { ...minimalDraft.submit, payload_format: 'text', content_type: null },
        prompt_binding: { location: 'text' },
        media_slots: [
          { slot_id: 'reference_image', field_key: 'image', label: '参考图', carrier: 'public_url' },
        ],
      }),
    ).toContain('interface_format_text_payload_forbids_media_slots');

    // text 形态下模型 ID 不能发到请求体（正文已被提示词占满），发查询参数可以。
    expect(
      draftIssueMessages({
        ...minimalDraft,
        submit: { ...minimalDraft.submit, payload_format: 'text', content_type: null },
        prompt_binding: { location: 'text' },
        model_binding: { location: 'body', path: 'model' },
      }),
    ).toContain('interface_format_text_payload_forbids_body_fields');
    expect(
      draftIssueMessages({
        ...minimalDraft,
        submit: { ...minimalDraft.submit, payload_format: 'text', content_type: null },
        prompt_binding: { location: 'text' },
        model_binding: { location: 'query', name: 'model' },
      }),
    ).toEqual([]);
  });

  it('multipart_file 素材位仍要求 multipart 提交且 content_type 为 null', () => {
    expect(
      draftIssueMessages({
        ...minimalDraft,
        media_slots: [
          { slot_id: 'reference_image', field_key: 'image', label: '参考图', carrier: 'multipart_file' },
        ],
      }),
    ).toContain('interface_format_multipart_slot_requires_multipart_submit');
  });
});

describe('CustomInterfaceFormatDraftSchema：轮询请求与查询参数鉴权', () => {
  const asyncBase = {
    ...minimalDraft,
    behavior: {
      ...minimalDraft.behavior,
      async: {
        identity_path: 'id',
        polling: {
          path: '/v1/tasks/{id}',
          status_path: 'status',
          success_values: ['succeeded'],
        },
      },
    },
  };

  it('轮询段新字段取默认值', () => {
    const parsed = CustomInterfaceFormatDraftSchema.parse(asyncBase);
    const polling = parsed.behavior.async?.polling;
    expect(polling?.headers).toEqual([]);
    expect(polling?.query).toEqual([]);
    expect(polling?.body_format).toBe('json');
    expect(polling?.content_type).toBeNull();
    expect(polling?.body).toBeUndefined();
  });

  it('POST 轮询可带请求体；GET 轮询带请求体被拒绝', () => {
    expect(
      draftIssueMessages({
        ...asyncBase,
        behavior: {
          ...asyncBase.behavior,
          async: {
            identity_path: 'id',
            polling: {
              path: '/v1/tasks/{id}',
              method: 'POST',
              body: { id: '{id}' },
              body_format: 'json',
              status_path: 'status',
              success_values: ['succeeded'],
            },
          },
        },
      }),
    ).toEqual([]);

    expect(
      draftIssueMessages({
        ...asyncBase,
        behavior: {
          ...asyncBase.behavior,
          async: {
            identity_path: 'id',
            polling: {
              path: '/v1/tasks/{id}',
              body: { id: '{id}' },
              status_path: 'status',
              success_values: ['succeeded'],
            },
          },
        },
      }),
    ).toContain('interface_format_polling_body_requires_post');
  });

  it('form 轮询要求请求体是对象、Content-Type 是 form 编码', () => {
    expect(
      draftIssueMessages({
        ...asyncBase,
        behavior: {
          ...asyncBase.behavior,
          async: {
            identity_path: 'id',
            polling: {
              path: '/v1/tasks/{id}',
              method: 'POST',
              body: ['a'],
              body_format: 'form',
              status_path: 'status',
              success_values: ['succeeded'],
            },
          },
        },
      }),
    ).toContain('interface_format_polling_form_body_must_be_object');

    expect(
      draftIssueMessages({
        ...asyncBase,
        behavior: {
          ...asyncBase.behavior,
          async: {
            identity_path: 'id',
            polling: {
              path: '/v1/tasks/{id}',
              method: 'POST',
              body: { id: '{id}' },
              body_format: 'form',
              content_type: 'application/json',
              status_path: 'status',
              success_values: ['succeeded'],
            },
          },
        },
      }),
    ).toContain('interface_format_form_content_type_invalid');
  });

  it('轮询路径静态查询串与轮询查询参数 / 鉴权 query 名重名被拒绝', () => {
    expect(
      draftIssueMessages({
        ...asyncBase,
        behavior: {
          ...asyncBase.behavior,
          async: {
            identity_path: 'id',
            polling: {
              path: '/v1/tasks?ids={id}',
              query: [{ name: 'ids', value: '{id}' }],
              status_path: 'status',
              success_values: ['succeeded'],
            },
          },
        },
      }),
    ).toContain('interface_format_polling_path_query_conflicts');

    expect(
      draftIssueMessages({
        ...asyncBase,
        submit: {
          ...minimalDraft.submit,
          auth: { kind: 'query_api_key', query_name: 'key' },
        },
        behavior: {
          ...asyncBase.behavior,
          async: {
            identity_path: 'id',
            polling: {
              path: '/v1/tasks?key=1',
              status_path: 'status',
              success_values: ['succeeded'],
            },
          },
        },
      }),
    ).toContain('interface_format_polling_path_query_conflicts');
  });

  it('查询参数 API Key 与请求头形态共用同一形状约束', () => {
    expect(
      draftIssueMessages({
        ...minimalDraft,
        submit: { ...minimalDraft.submit, auth: { kind: 'query_api_key', query_name: 'key' } },
      }),
    ).toEqual([]);

    // query_api_key 不带 header_name，也不接受 header_name。
    expect(
      draftIssueMessages({
        ...minimalDraft,
        submit: {
          ...minimalDraft.submit,
          auth: { kind: 'query_api_key', query_name: 'key', header_name: 'Authorization' },
        },
      }).length,
    ).toBeGreaterThan(0);
  });
});
