import { describe, expect, it } from 'vitest';

import {
  INTERFACE_FORMAT_RESULT_FORMS,
  InterfaceFormatDetailSchema,
  InterfaceFormatListResponseSchema,
  InterfaceFormatPathDiscoveryBodySchema,
  InterfaceFormatResultFormSchema,
  InterfaceFormatSummarySchema,
} from '../src/custom-generation-model-contract';
import { InterfaceRecipePathDiscoveryResponseSchema } from '../src/interface-recipe-contract';

/**
 * 接口格式只读 DTO（Hub「接口格式」页的数据契约，`docs/custom-providers/接口格式旅程-design.md`
 * §1.2 / §4）与自定义格式草稿（请求落点、固定常量、请求体形态、轮询请求、鉴权）。
 *
 * 覆盖四件事：
 * 1. `.strict()`：每一层（含 transport / builtin_behavior）都拒绝未登记键；
 * 2. 可空性与真实数据一致：未就绪格式的 transport / descriptor / builtin_behavior 为 null，
 *    `content_type` 可为 null（multipart 由运行时生成边界），`result_form` 可为 null（判不出来）；
 * 3. 新增只读字段的默认值：旧响应没有固定头 / 查询参数 / 表单编码风格 / 轮询请求段时仍可解析；
 * 4. 草稿的落点与冲突规则：三个命名空间分别查重、固定常量与动态落点不能撞名、text 分支约束。
 */

const summary = {
  format_id: 'openai-image-v1',
  display_name: 'OpenAI 图像',
  family: 'generation',
  status: 'ready',
  supports_media_slots: ['reference_image'],
  required_media_slots: [],
  order: 10,
  origin: 'preset',
  version: '1.0.0',
};

const parameterDescriptor = {
  family_adapter_id: 'openai-image-v1',
  official_fields: [
    {
      field_key: 'size',
      label: '尺寸',
      component: 'select',
      wire_name: 'size',
      wire_location: 'body',
      required: false,
      default_value: null,
      enum_options: [],
      resolution_presets: [],
      aspect_presets: [],
    },
  ],
  reserved_wire_names: { body: ['model', 'prompt'], query: [], header: [] },
  supports_media_slots: ['reference_image'],
  required_media_slots: [],
};

const detail = {
  summary,
  transport: {
    auth: { kind: 'bearer', header_name: 'Authorization', prefix: 'Bearer' },
    endpoints: { generations: '/v1/images/generations' },
    submit: {
      method: 'POST',
      path: '/v1/images/generations',
      content_type: 'application/json',
      payload_format: 'json',
      headers: [{ name: 'Accept', value: 'application/json' }],
      query: [],
      form_field_style: 'dotted',
      form_array_style: 'repeat',
    },
    async: null,
    prompt_binding: { location: 'body', path: 'prompt' },
    model_binding: { location: 'body', path: 'model' },
  },
  media_slots: [
    { slot_id: 'reference_image', field_key: 'image', required: false, max_files: 16, carrier: 'multipart_file' },
  ],
  parameter_descriptor: parameterDescriptor,
  builtin_behavior: {
    has_success_condition: true,
    result_form: 'direct_url',
    requires_auth: false,
    failure_reason_present: false,
  },
  used_by_model_count: 2,
  recipe_id: null,
};

describe('InterfaceFormatSummarySchema', () => {
  it('解析合法摘要并保留素材位顺序', () => {
    const parsed = InterfaceFormatSummarySchema.parse(summary);
    expect(parsed.supports_media_slots).toEqual(['reference_image']);
    expect(parsed.required_media_slots).toEqual([]);
    expect(parsed.status).toBe('ready');
  });

  it('拒绝未知键、非法状态与空展示名', () => {
    expect(() => InterfaceFormatSummarySchema.parse({ ...summary, unknown_key: true })).toThrow();
    expect(() => InterfaceFormatSummarySchema.parse({ ...summary, status: 'retired' })).toThrow();
    expect(() => InterfaceFormatSummarySchema.parse({ ...summary, display_name: '' })).toThrow();
    expect(() =>
      InterfaceFormatSummarySchema.parse({ ...summary, supports_media_slots: ['not_a_slot'] }),
    ).toThrow();
  });
});

describe('InterfaceFormatDetailSchema', () => {
  it('解析完整详情', () => {
    const parsed = InterfaceFormatDetailSchema.parse(detail);
    expect(parsed.summary.format_id).toBe('openai-image-v1');
    expect(parsed.transport?.submit.path).toBe('/v1/images/generations');
    expect(parsed.transport?.submit.headers).toEqual([{ name: 'Accept', value: 'application/json' }]);
    expect(parsed.transport?.prompt_binding).toEqual({ location: 'body', path: 'prompt' });
    expect(parsed.transport?.model_binding).toEqual({ location: 'body', path: 'model' });
    expect(parsed.media_slots[0]?.field_key).toBe('image');
    expect(parsed.parameter_descriptor?.official_fields).toHaveLength(1);
    expect(parsed.builtin_behavior?.result_form).toBe('direct_url');
    expect(parsed.used_by_model_count).toBe(2);
  });

  it('未就绪格式：transport / descriptor / builtin_behavior 为 null，素材位为空数组', () => {
    const parsed = InterfaceFormatDetailSchema.parse({
      ...detail,
      summary: { ...summary, status: 'pending', supports_media_slots: [], required_media_slots: [] },
      transport: null,
      media_slots: [],
      parameter_descriptor: null,
      builtin_behavior: null,
      used_by_model_count: 0,
    });
    expect(parsed.summary.status).toBe('pending');
    expect(parsed.transport).toBeNull();
    expect(parsed.media_slots).toEqual([]);
    expect(parsed.parameter_descriptor).toBeNull();
    expect(parsed.builtin_behavior).toBeNull();
  });

  it('content_type 可为 null（multipart 由运行时生成边界）', () => {
    const parsed = InterfaceFormatDetailSchema.parse({
      ...detail,
      transport: {
        ...detail.transport,
        submit: { ...detail.transport.submit, content_type: null, payload_format: 'multipart' },
      },
    });
    expect(parsed.transport?.submit.content_type).toBeNull();
  });

  it('提交段的固定头 / 查询参数 / 表单编码风格缺省时取默认值（旧响应可解析）', () => {
    const legacySubmit = {
      method: detail.transport.submit.method,
      path: detail.transport.submit.path,
      content_type: detail.transport.submit.content_type,
      payload_format: detail.transport.submit.payload_format,
    };
    const parsed = InterfaceFormatDetailSchema.parse({
      ...detail,
      transport: { ...detail.transport, submit: legacySubmit },
    });
    expect(parsed.transport?.submit.headers).toEqual([]);
    expect(parsed.transport?.submit.query).toEqual([]);
    expect(parsed.transport?.submit.form_field_style).toBe('dotted');
    expect(parsed.transport?.submit.form_array_style).toBe('repeat');
  });

  it('鉴权视图按 kind 分支：查询参数鉴权只给 query_name', () => {
    const parsed = InterfaceFormatDetailSchema.parse({
      ...detail,
      transport: {
        ...detail.transport,
        auth: { kind: 'query_api_key', query_name: 'key' },
      },
    });
    expect(parsed.transport?.auth).toEqual({ kind: 'query_api_key', query_name: 'key' });
    expect(() =>
      InterfaceFormatDetailSchema.parse({
        ...detail,
        transport: {
          ...detail.transport,
          auth: { kind: 'query_api_key', query_name: 'key', header_name: 'Authorization' },
        },
      }),
    ).toThrow();
  });

  it('异步段解析轮询节奏与轮询请求段', () => {
    const parsed = InterfaceFormatDetailSchema.parse({
      ...detail,
      transport: {
        ...detail.transport,
        async: {
          identity_path: '/operation/name',
          polling: {
            url_template: '/v1/operations/{operation_name}',
            method: 'POST',
            interval_ms: 10000,
            max_attempts: 120,
            headers: [{ name: 'X-Poll', value: '{requestId}' }],
            query: [{ name: 'ids', value: '{id}' }],
            body: { ids: ['{id}'] },
            body_format: 'json',
            content_type: 'application/json',
          },
        },
      },
    });
    expect(parsed.transport?.async?.polling.max_attempts).toBe(120);
    expect(parsed.transport?.async?.polling.body).toEqual({ ids: ['{id}'] });
    expect(parsed.transport?.async?.polling.headers).toEqual([{ name: 'X-Poll', value: '{requestId}' }]);
  });

  it('轮询段新增字段有默认值（旧响应可解析）', () => {
    const parsed = InterfaceFormatDetailSchema.parse({
      ...detail,
      transport: {
        ...detail.transport,
        async: {
          identity_path: '/operation/name',
          polling: {
            url_template: '/v1/operations/{operation_name}',
            method: 'GET',
            interval_ms: 10000,
            max_attempts: 120,
          },
        },
      },
    });
    const polling = parsed.transport?.async?.polling;
    expect(polling?.headers).toEqual([]);
    expect(polling?.query).toEqual([]);
    expect(polling?.body_format).toBe('json');
    expect(polling?.content_type).toBeNull();
    expect(polling?.body).toBeUndefined();
  });

  it('每一层都拒绝未知键', () => {
    expect(() => InterfaceFormatDetailSchema.parse({ ...detail, extra: 1 })).toThrow();
    expect(() =>
      InterfaceFormatDetailSchema.parse({
        ...detail,
        transport: { ...detail.transport, extra: 1 },
      }),
    ).toThrow();
    expect(() =>
      InterfaceFormatDetailSchema.parse({
        ...detail,
        transport: {
          ...detail.transport,
          auth: { ...detail.transport.auth, extra: 1 },
        },
      }),
    ).toThrow();
    expect(() =>
      InterfaceFormatDetailSchema.parse({
        ...detail,
        builtin_behavior: { ...detail.builtin_behavior, extra: 1 },
      }),
    ).toThrow();
    expect(() =>
      InterfaceFormatDetailSchema.parse({
        ...detail,
        media_slots: [{ ...detail.media_slots[0], extra: 1 }],
      }),
    ).toThrow();
  });

  it('used_by_model_count 必须是非负整数；result_form 可为 null', () => {
    expect(() => InterfaceFormatDetailSchema.parse({ ...detail, used_by_model_count: -1 })).toThrow();
    expect(() => InterfaceFormatDetailSchema.parse({ ...detail, used_by_model_count: 1.5 })).toThrow();
    const parsed = InterfaceFormatDetailSchema.parse({
      ...detail,
      builtin_behavior: { ...detail.builtin_behavior, result_form: null },
    });
    expect(parsed.builtin_behavior?.result_form).toBeNull();
  });
});

describe('族模板参数描述（按命名空间拆分保留键）', () => {
  it('reserved_wire_names 按 body / query / header 拆分，旧数组形状被拒绝', () => {
    expect(parameterDescriptor.reserved_wire_names.body).toContain('model');
    expect(() =>
      InterfaceFormatDetailSchema.parse({
        ...detail,
        parameter_descriptor: { ...parameterDescriptor, reserved_wire_names: ['model'] },
      }),
    ).toThrow();
  });

  it('official_fields 的 wire_location 缺省为 body，旧响应可解析', () => {
    const legacyField = {
      field_key: 'size',
      label: '尺寸',
      component: 'select',
      wire_name: 'size',
      required: false,
      default_value: null,
      enum_options: [],
      resolution_presets: [],
      aspect_presets: [],
    };
    const parsed = InterfaceFormatDetailSchema.parse({
      ...detail,
      parameter_descriptor: { ...parameterDescriptor, official_fields: [legacyField] },
    });
    expect(parsed.parameter_descriptor?.official_fields[0]?.wire_location).toBe('body');
  });

  it('wire_location 只接受三个命名空间', () => {
    expect(() =>
      InterfaceFormatDetailSchema.parse({
        ...detail,
        parameter_descriptor: {
          ...parameterDescriptor,
          official_fields: [{ ...parameterDescriptor.official_fields[0], wire_location: 'path' }],
        },
      }),
    ).toThrow();
  });
});

describe('结果形态词表', () => {
  it('与配方结果形态同词表，未登记取值拒绝', () => {
    expect([...INTERFACE_FORMAT_RESULT_FORMS]).toEqual(['direct_url', 'inline_media', 'needs_fetch']);
    for (const form of INTERFACE_FORMAT_RESULT_FORMS) {
      expect(InterfaceFormatResultFormSchema.safeParse(form).success).toBe(true);
    }
    expect(InterfaceFormatResultFormSchema.safeParse('binary_media').success).toBe(false);
  });
});

describe('列表与路径发现请求体', () => {
  it('列表响应是 { formats: Summary[] } 且拒绝未知键', () => {
    expect(InterfaceFormatListResponseSchema.parse({ formats: [summary] }).formats).toHaveLength(1);
    expect(() => InterfaceFormatListResponseSchema.parse({ formats: [summary], extra: 1 })).toThrow();
    expect(() => InterfaceFormatListResponseSchema.parse({ items: [summary] })).toThrow();
  });

  it('路径发现请求体：sample 必填，headers 可选，未知键拒绝', () => {
    expect(InterfaceFormatPathDiscoveryBodySchema.parse({ sample: { a: 1 } }).headers).toBeUndefined();
    expect(
      InterfaceFormatPathDiscoveryBodySchema.parse({ sample: { a: 1 }, headers: { 'X-Trace': 't' } })
        .headers,
    ).toEqual({ 'X-Trace': 't' });
    expect(() => InterfaceFormatPathDiscoveryBodySchema.parse({ headers: {} })).toThrow();
    expect(() =>
      InterfaceFormatPathDiscoveryBodySchema.parse({ sample: {}, draft: {} }),
    ).toThrow();
  });

  it('路径发现响应沿用配方侧同一份 schema（含响应头条目）', () => {
    const parsed = InterfaceRecipePathDiscoveryResponseSchema.parse({
      paths: [
        { path: 'status', value: 'succeeded', value_kind: 'string' },
        { path: 'x-trace-id', value: 'abc', value_kind: 'string' },
      ],
    });
    expect(parsed.paths.map((entry) => entry.path)).toEqual(['status', 'x-trace-id']);
  });
});
