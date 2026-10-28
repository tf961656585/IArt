import assert from 'node:assert/strict';
import test from 'node:test';

import { CustomInterfaceFormatDraftSchema, type ParameterOverrides } from '@iart/contracts';
import { buildInterfaceFormatFromDraft } from '../interface-format/draft-synthesis.cts';
import { composeInterfaceFormatSources } from '../interface-format/compose.cts';
import { buildFamilyTemplateParameterDescriptorFromSources } from '../generation-family-templates.cts';
import { applyParameterOverrides, validateParameterOverrides } from '../generation-parameter-overrides.cts';
import { isObjectRecord } from '../model-package-catalog.shared.cts';
import type { CatalogRawObject, JsonObject } from '../model-package-catalog.types.cts';
import type { GenerationFamilyTemplateSources } from '../generation-family-templates.cts';

/**
 * 参数覆盖的**落点命名空间**（2026-10-27 请求落点批次）。
 *
 * 覆盖：查询参数 / 请求头参数的别名与禁用、跨命名空间不互相占用、描述符的 wire_location
 * 与三个保留键命名空间、自定义参数仍只落请求体。
 */

const asRaw = (value: unknown): CatalogRawObject => {
  assert.ok(isObjectRecord(value), 'expected an object record');
  return value;
};

const payloadRulesOf = (sources: GenerationFamilyTemplateSources): CatalogRawObject => {
  const runtimeModel = asRaw(sources.runtimeModel);
  return asRaw(asRaw(runtimeModel.runtime).payload_rules);
};

const buildSources = (): GenerationFamilyTemplateSources => {
  const parsed = CustomInterfaceFormatDraftSchema.safeParse({
    display_name: '三种落点测试格式',
    submit: {
      path: '/v1/generate',
      method: 'POST',
      payload_format: 'json',
      content_type: 'application/json',
      auth: { kind: 'bearer', header_name: 'Authorization', prefix: 'Bearer' },
      headers: [{ name: 'Accept', value: 'application/json' }],
      query: [],
      form_field_style: 'dotted',
      form_array_style: 'repeat',
    },
    parameters: [
      { binding: { location: 'body', path: 'size' }, label: '画面尺寸', type: 'string' },
      { binding: { location: 'query', name: 'seed' }, label: '随机种子', type: 'number' },
      { binding: { location: 'query', name: 'steps' }, label: '步数', type: 'number' },
      { binding: { location: 'header', name: 'X-Trace' }, label: '追踪标记', type: 'string' },
    ],
    prompt_binding: { location: 'body', path: 'prompt' },
    behavior: {
      result: { kind: 'direct_url', media_field_paths: ['data.0.url'], media_type: 'image' },
    },
  });
  assert.equal(parsed.success, true, parsed.success ? undefined : parsed.error.message);
  if (!parsed.success) throw new Error('unreachable');
  const format = buildInterfaceFormatFromDraft(parsed.data, { format_id: 'if_wire_locations', order: 100 });
  return composeInterfaceFormatSources({ format, modelId: 'wire-locations-model', acceptedMediaSlots: [] });
};

const SOURCES = buildSources();

const overridesOf = (overrides: ParameterOverrides): ParameterOverrides => overrides;

const codesOf = (overrides: ParameterOverrides): string[] =>
  validateParameterOverrides(SOURCES, overrides).map((violation) => violation.code);

const fieldKeys = (sources: GenerationFamilyTemplateSources): unknown[] => {
  const schema = asRaw(asRaw(sources.runtimeModel).parameter_schema);
  const fields = schema.fields;
  assert.ok(Array.isArray(fields));
  return fields.map((field) => (isObjectRecord(field) ? field.field_key : undefined));
};

void test('描述符：wire_location 从 target 解析，保留键按三个命名空间拆分', () => {
  const descriptor = buildFamilyTemplateParameterDescriptorFromSources({
    familyAdapterId: 'if_wire_locations',
    baselineSources: SOURCES,
  });

  const byLabel = new Map(descriptor.official_fields.map((field) => [field.label, field]));
  const sizeField = byLabel.get('画面尺寸');
  const seedField = byLabel.get('随机种子');
  const traceField = byLabel.get('追踪标记');
  assert.ok(sizeField && seedField && traceField);
  assert.deepEqual(
    { name: sizeField.wire_name, location: sizeField.wire_location },
    { name: 'size', location: 'body' },
  );
  assert.deepEqual(
    { name: seedField.wire_name, location: seedField.wire_location },
    { name: 'seed', location: 'query' },
  );
  assert.deepEqual(
    { name: traceField.wire_name, location: traceField.wire_location },
    { name: 'X-Trace', location: 'header' },
  );
  assert.deepEqual(
    { name: byLabel.get('步数')?.wire_name, location: byLabel.get('步数')?.wire_location },
    { name: 'steps', location: 'query' },
  );

  assert.ok(descriptor.reserved_wire_names.body.includes('size'));
  assert.ok(descriptor.reserved_wire_names.body.includes('prompt'));
  assert.ok(descriptor.reserved_wire_names.body.includes('model'));
  assert.ok(descriptor.reserved_wire_names.query.includes('seed'));
  assert.ok(descriptor.reserved_wire_names.query.includes('steps'));
  // 请求头命名空间按大小写不敏感口径归一化（同一头名不同大小写是同一个头）。
  assert.ok(descriptor.reserved_wire_names.header.includes('x-trace'));
  assert.ok(descriptor.reserved_wire_names.header.includes('accept'));
  // 同名跨命名空间是不同字段：query 的 seed 不出现在请求体保留键里。
  assert.equal(descriptor.reserved_wire_names.body.includes('seed'), false);
});

void test('别名：只改当前落点内的名称，不改变落点', () => {
  const overrides = overridesOf({
    official: [
      { field_key: 'p1', wire_name: 'random_seed' },
      { field_key: 'p3', wire_name: 'X-Trace-Id' },
    ],
    custom: [],
  });
  assert.deepEqual(codesOf(overrides), []);
  const rules = payloadRulesOf(applyParameterOverrides(SOURCES, overrides));
  assert.deepEqual(rules['api.query.random_seed'], { kind: 'field', field_key: 'p1' });
  assert.equal(rules['api.query.seed'], undefined);
  assert.deepEqual(rules['api.headers.X-Trace-Id'], { kind: 'field', field_key: 'p3' });
  assert.equal(rules['api.headers.X-Trace'], undefined);
  // 落点不变：别处的同名/相关规则不受影响。
  assert.deepEqual(rules['body.size'], { kind: 'field', field_key: 'p0' });
});

void test('别名：跨命名空间不互相占用（请求体别名可用查询参数名）', () => {
  assert.deepEqual(
    codesOf(overridesOf({ official: [{ field_key: 'p0', wire_name: 'seed' }], custom: [] })),
    [],
  );
});

void test('别名：同名冲突与禁止请求头被拒', () => {
  assert.deepEqual(
    codesOf(overridesOf({ official: [{ field_key: 'p1', wire_name: 'seed' }], custom: [] })),
    [],
    '改回自己当前的名字等于没改',
  );
  assert.deepEqual(
    codesOf(overridesOf({ official: [{ field_key: 'p1', wire_name: 'other_query' }, { field_key: 'p2', wire_name: 'other_query' }], custom: [] })),
    ['wire_name_conflict'],
    '两条别名落到同一查询参数名',
  );
  assert.deepEqual(
    codesOf(overridesOf({ official: [{ field_key: 'p3', wire_name: 'Authorization' }], custom: [] })),
    ['wire_name_reserved'],
    '鉴权头名由软件管理，不能作为参数落点',
  );
  assert.deepEqual(
    codesOf(overridesOf({ official: [{ field_key: 'p3', wire_name: 'Accept' }], custom: [] })),
    ['wire_name_reserved'],
    '请求头名大小写不敏感：accept 已被固定头占用',
  );
});

void test('禁用：请求体 / 查询参数 / 请求头三种落点的规则都被移除', () => {
  const overrides = overridesOf({ official: [{ field_key: 'p1', enabled: false }], custom: [] });
  assert.deepEqual(codesOf(overrides), []);
  const rules = payloadRulesOf(applyParameterOverrides(SOURCES, overrides));
  assert.equal(rules['api.query.seed'], undefined);
  assert.ok(rules['body.size'], '其它命名空间的字段不受影响');
  assert.ok(rules['api.headers.X-Trace']);

  const headerOverrides = overridesOf({ official: [{ field_key: 'p3', enabled: false }], custom: [] });
  assert.deepEqual(codesOf(headerOverrides), []);
  const headerRules = payloadRulesOf(applyParameterOverrides(SOURCES, headerOverrides));
  assert.equal(headerRules['api.headers.X-Trace'], undefined);
  assert.ok(headerRules['api.query.seed']);
  // 字段本身从参数表移除。
  assert.deepEqual(fieldKeys(applyParameterOverrides(SOURCES, headerOverrides)), ['p0', 'p1', 'p2']);
});

void test('自定义参数仍只落请求体：不占用查询参数/请求头的名字，但不得撞请求体名', () => {
  // 查询参数 seed 已被占用，但自定义参数发请求体，互不相干。
  assert.deepEqual(
    codesOf(overridesOf({
      official: [],
      custom: [{ label: '自定义种子', wire_name: 'seed', value_type: 'string', required: false }],
    })),
    [],
  );
  // 请求体里的 size 仍被占用。
  assert.deepEqual(
    codesOf(overridesOf({
      official: [],
      custom: [{ label: '撞请求体', wire_name: 'size', value_type: 'string', required: false }],
    })),
    ['wire_name_reserved'],
  );
  // 新增自定义参数只追加 body 规则，不追加 query/header 规则。
  const applied = applyParameterOverrides(
    SOURCES,
    overridesOf({ official: [], custom: [{ label: '备注', wire_name: 'note', value_type: 'string', required: false }] }),
  );
  const rules = payloadRulesOf(applied);
  assert.deepEqual(rules['body.note'], { kind: 'field', field_key: 'note' });
  assert.equal('api.query.note' in rules, false);
  assert.equal('api.headers.note' in rules, false);
});

void test('保留键事实与禁用裁剪共用同一份 target 解析（meta 规则也在禁用时被裁剪）', () => {
  const sourcesWithMeta: GenerationFamilyTemplateSources = {
    runtimeModel: asRaw({
      ...asRaw(SOURCES.runtimeModel),
      runtime: asRaw({
        ...asRaw(asRaw(SOURCES.runtimeModel).runtime),
        payload_rules: asRaw({
          ...payloadRulesOf(SOURCES),
          'meta.seed': { kind: 'field', field_key: 'p1' } satisfies JsonObject,
        }),
      }),
    }),
    node: SOURCES.node,
    localizationResources: SOURCES.localizationResources,
  };
  const overrides = overridesOf({ official: [{ field_key: 'p1', enabled: false }], custom: [] });
  assert.deepEqual(validateParameterOverrides(sourcesWithMeta, overrides), []);
  const rules = payloadRulesOf(applyParameterOverrides(sourcesWithMeta, overrides));
  assert.equal(rules['meta.seed'], undefined, '面板语义规则同样归属该字段，必须一起裁剪');
});
