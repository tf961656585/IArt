import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GENERATION_FAMILY_ADAPTER_IDS,
  GENERATION_MEDIA_SLOT_IDS,
  type GenerationFamilyAdapterId,
  type GenerationMediaSlotId,
  type ParameterOverrides,
} from '@iart/contracts';
import { buildGeminiImageInteractionsV1BaseTemplateSources } from '../generation-family-templates.gemini-image.cts';
import { buildOpenAiImageV1BaseTemplateSources } from '../generation-family-templates.openai-image.cts';
import {
  buildFamilyTemplateParameterDescriptor,
  GENERATION_FAMILY_TEMPLATE_REGISTRY,
} from '../generation-family-templates.registry.cts';
import {
  applyParameterOverrides,
  EMPTY_PARAMETER_OVERRIDES,
  MAX_CUSTOM_PARAMETER_FIELDS,
  validateParameterOverrides,
} from '../generation-parameter-overrides.cts';
import { isObjectRecord } from '../model-package-catalog.shared.cts';
import type { CatalogRawObject, JsonObject } from '../model-package-catalog.types.cts';
import type { GenerationFamilyTemplateSources } from '../generation-family-templates.cts';

/**
 * 生成模型参数高级自定义：覆盖校验与合成的纯函数单测
 *（docs/custom-providers/生成模型参数高级自定义-design.md §3.3/§3.5/§5，S1-S5/S7 场景）。
 *
 * 校验唯一实现口径：本文件直接对保存路径与投影合成路径共用的同一套函数断言；
 * 跨进程主链（声明 store → 合成投影 → 目录/提交/执行）由 engineSeam 测试承载。
 */

const asRaw = (value: unknown): CatalogRawObject => {
  assert.ok(isObjectRecord(value), 'expected an object record');
  return value;
};

const T2I_SOURCES = buildOpenAiImageV1BaseTemplateSources('overrides-unit-model', {
  acceptedMediaSlots: [],
});
const I2I_SOURCES = buildOpenAiImageV1BaseTemplateSources('overrides-unit-model-ref', {
  acceptedMediaSlots: ['reference_image'],
});

/** 测试字面量显式写全必填键（required 等），直接以契约输出类型进入校验器；不 parse——
 * 形状非法（如坏 wire 名）正是要在校验器层测试的输入，parse 会先被 schema 拒掉。 */
const overridesOf = (overrides: ParameterOverrides): ParameterOverrides => overrides;

const payloadRulesOf = (sources: GenerationFamilyTemplateSources): CatalogRawObject => {
  const runtimeModel = asRaw(sources.runtimeModel);
  const runtime = asRaw(runtimeModel.runtime);
  return asRaw(runtime.payload_rules);
};

const parameterSchemaOf = (sources: GenerationFamilyTemplateSources): CatalogRawObject =>
  asRaw(asRaw(sources.runtimeModel).parameter_schema);

const fieldRecordOf = (sources: GenerationFamilyTemplateSources, fieldKey: string): CatalogRawObject => {
  const fields = parameterSchemaOf(sources).fields;
  assert.ok(Array.isArray(fields), 'parameter_schema.fields must be an array');
  const record = fields
    .map((item) => (isObjectRecord(item) ? item : null))
    .find((item) => item !== null && item.field_key === fieldKey);
  assert.ok(record, `field ${fieldKey} must exist after synthesis`);
  return record;
};

const violationsOf = (sources: GenerationFamilyTemplateSources, overrides: ParameterOverrides): string[] =>
  validateParameterOverrides(sources, overrides).map((violation) => violation.code);

void test('空覆盖是恒等变换：同一引用返回，模板内容零改动（S8 基线）', () => {
  const output = applyParameterOverrides(T2I_SOURCES, EMPTY_PARAMETER_OVERRIDES);
  assert.equal(output, T2I_SOURCES, 'empty overrides must return the identical sources object');
  assert.deepEqual(violationsOf(T2I_SOURCES, EMPTY_PARAMETER_OVERRIDES), []);
});

void test('S1 别名：body.<wire> 键段整体改写，面板字段与展示语义不变', () => {
  const overrides = overridesOf({
    official: [{ field_key: 'size', wire_name: 'image_size' }],
    custom: [],
  });
  assert.deepEqual(violationsOf(T2I_SOURCES, overrides), []);
  const output = applyParameterOverrides(T2I_SOURCES, overrides);
  const rules = payloadRulesOf(output);
  const aliasRule = asRaw(rules['body.image_size']);
  assert.equal(aliasRule.kind, 'field');
  assert.equal(aliasRule.field_key, 'size', 'alias rewrites the wire segment, the field_key stays');
  assert.equal(rules['body.size'], undefined, 'old wire key must be gone');
  assert.ok(rules['meta.size'], 'non-body rules referencing the field stay untouched');
  assert.ok(fieldRecordOf(output, 'size'), 'panel field survives the alias');
  // 别名对 i2i 条件形态同样生效。
  const i2iOutput = applyParameterOverrides(I2I_SOURCES, overrides);
  assert.ok(payloadRulesOf(i2iOutput)['body.image_size']);
});

void test('S2 禁用：字段、默认值与 payload_rules 一并移除；素材位字段不可禁用', () => {
  const overrides = overridesOf({
    official: [{ field_key: 'moderation', enabled: false }],
    custom: [],
  });
  assert.deepEqual(violationsOf(T2I_SOURCES, overrides), []);
  const output = applyParameterOverrides(T2I_SOURCES, overrides);
  const schema = parameterSchemaOf(output);
  const fields = Array.isArray(schema.fields) ? schema.fields : [];
  assert.ok(
    !fields.some((item) => isObjectRecord(item) && item.field_key === 'moderation'),
    'disabled field must be removed from the panel',
  );
  const defaults = asRaw(schema.default_values);
  assert.equal(defaults.moderation, undefined, 'disabled field default must be removed');
  assert.equal(payloadRulesOf(output)['body.moderation'], undefined, 'disabled field rule must be pruned');
  assert.ok(payloadRulesOf(output)['body.output_format'], 'other fields stay intact');

  assert.deepEqual(violationsOf(I2I_SOURCES, overridesOf({
    official: [{ field_key: 'image', enabled: false }],
    custom: [],
  })), ['official_field_media_slot_not_overridable']);
});

void test('S3 枚举替换：选项替换、默认值随行；替换后旧默认值非法被拒', () => {
  const overrides = overridesOf({
    official: [{ field_key: 'quality', enum_options: ['hd', 'standard'], default_value: 'hd' }],
    custom: [],
  });
  assert.deepEqual(violationsOf(T2I_SOURCES, overrides), []);
  const output = applyParameterOverrides(T2I_SOURCES, overrides);
  const field = fieldRecordOf(output, 'quality');
  assert.deepEqual(field.enum_options, [{ value: 'hd' }, { value: 'standard' }]);
  assert.equal(field.default_value, 'hd');
  const schema = parameterSchemaOf(output);
  assert.equal(asRaw(schema.default_values).quality, 'hd');
  const runtimeModel = asRaw(output.runtimeModel);
  assert.equal(asRaw(asRaw(runtimeModel.runtime).schema_defaults).quality, 'hd');

  // 默认值不在替换后的枚举内 → 保存拒绝（S3 后半句）。
  assert.deepEqual(
    violationsOf(T2I_SOURCES, overridesOf({
      official: [{ field_key: 'quality', enum_options: ['hd', 'standard'], default_value: 'auto' }],
      custom: [],
    })),
    ['default_value_not_in_legal_set'],
  );
  // 未替换枚举时默认值必须在模板枚举内。
  assert.deepEqual(
    violationsOf(T2I_SOURCES, overridesOf({
      official: [{ field_key: 'quality', default_value: 'ultra' }],
      custom: [],
    })),
    ['default_value_not_in_legal_set'],
  );
});

void test('S4 档位收窄：sizeLevels/aspectPresets 子集生效；非法键与非画幅字段被拒', () => {
  const overrides = overridesOf({
    official: [{ field_key: 'size', resolution_preset_keys: ['1k', '2k'], aspect_preset_keys: ['1:1'] }],
    custom: [],
  });
  assert.deepEqual(violationsOf(T2I_SOURCES, overrides), []);
  const output = applyParameterOverrides(T2I_SOURCES, overrides);
  const props = asRaw(fieldRecordOf(output, 'size').component_props);
  const levels = Array.isArray(props.sizeLevels) ? props.sizeLevels : [];
  assert.deepEqual(
    levels.map((item) => (isObjectRecord(item) ? item.id : null)),
    ['1k', '2k'],
  );
  const aspects = Array.isArray(props.aspectPresets) ? props.aspectPresets : [];
  assert.deepEqual(
    aspects.map((item) => (isObjectRecord(item) ? item.id : null)),
    ['1:1'],
  );

  // 收窄后默认值必须仍在保留集内：auto 是直传预设不受收窄影响，合法。
  assert.deepEqual(violationsOf(T2I_SOURCES, overridesOf({
    official: [{ field_key: 'size', resolution_preset_keys: ['1k'], default_value: 'auto' }],
    custom: [],
  })), []);
  // 收窄后 2k×1:1 的合成值不再可得 → 默认值非法。
  assert.deepEqual(
    violationsOf(T2I_SOURCES, overridesOf({
      official: [{ field_key: 'size', resolution_preset_keys: ['1k'], default_value: '2048x2048' }],
      custom: [],
    })),
    ['default_value_not_in_legal_set'],
  );
  // 保留集内的合成值（1k × 1:1 → 1024x1024，与 Editor computeImageSize 同式）合法。
  assert.deepEqual(violationsOf(T2I_SOURCES, overridesOf({
    official: [{ field_key: 'size', resolution_preset_keys: ['1k'], default_value: '1024x1024' }],
    custom: [],
  })), []);

  assert.deepEqual(
    violationsOf(T2I_SOURCES, overridesOf({
      official: [{ field_key: 'quality', resolution_preset_keys: ['1k'] }],
      custom: [],
    })),
    ['preset_keys_not_allowed'],
  );
  assert.deepEqual(
    violationsOf(T2I_SOURCES, overridesOf({
      official: [{ field_key: 'size', resolution_preset_keys: ['9k'] }],
      custom: [],
    })),
    ['preset_key_unknown'],
  );
  assert.deepEqual(
    violationsOf(T2I_SOURCES, overridesOf({
      official: [{ field_key: 'size', enum_options: ['auto'] }],
      custom: [],
    })),
    ['enum_options_not_allowed'],
  );
});

void test('S5 自定义参数：四类控件入表单、默认值与 payload_rules 同步；edits 分支共用规则', () => {
  const overrides = overridesOf({
    official: [],
    custom: [
      { label: '水印', wire_name: 'my_watermark', value_type: 'enum', enum_options: ['on', 'off'], default_value: 'on', required: true },
      { label: '备注', wire_name: 'my_note', value_type: 'string', required: false },
      { label: '步数', wire_name: 'my_steps', value_type: 'number', default_value: 2, required: false },
      { label: '开关', wire_name: 'my_switch', value_type: 'boolean', required: false },
    ],
  });
  assert.deepEqual(violationsOf(T2I_SOURCES, overrides), []);
  const output = applyParameterOverrides(T2I_SOURCES, overrides);
  const watermark = fieldRecordOf(output, 'my_watermark');
  assert.equal(watermark.field_key, 'my_watermark', 'custom field_key is its wire_name');
  assert.equal(watermark.component, 'select');
  assert.equal(watermark.required, true);
  assert.deepEqual(watermark.enum_options, [{ value: 'on' }, { value: 'off' }]);
  // label 值是 locales 键（共享本地化路径要求每个 label 可解析），用户文本注册为译文。
  assert.equal(watermark.label, 'fields.my_watermark.label');
  const zhResources = asRaw(asRaw(output.localizationResources)['zh-CN']);
  assert.deepEqual(asRaw(zhResources.fields).my_watermark, { label: '水印' });
  const enResources = asRaw(asRaw(output.localizationResources)['en']);
  assert.deepEqual(asRaw(enResources.fields).my_watermark, { label: '水印' });
  assert.equal(fieldRecordOf(output, 'my_note').component, 'text');
  assert.equal(fieldRecordOf(output, 'my_steps').component, 'number');
  assert.equal(fieldRecordOf(output, 'my_switch').component, 'switch');

  const rules = payloadRulesOf(output);
  for (const wire of ['my_watermark', 'my_note', 'my_steps', 'my_switch']) {
    const rule = asRaw(rules[`body.${wire}`]);
    assert.equal(rule.kind, 'field');
    assert.equal(rule.field_key, wire, 'custom field rule must be present (serves both endpoint branches)');
  }
  const defaults = asRaw(parameterSchemaOf(output).default_values);
  assert.equal(defaults.my_watermark, 'on');
  assert.equal(defaults.my_steps, 2);
  assert.equal(defaults.my_note, undefined, 'custom without default must not inject a default');

  // edits 分支形态（i2i 条件规则表）同样携带追加的字段规则。
  const i2iRules = payloadRulesOf(applyParameterOverrides(I2I_SOURCES, overrides));
  assert.ok(asRaw(i2iRules['body.my_watermark']), 'custom field rule must serve the edits branch too');
});

void test('S7 非法覆盖拦截：保留键、格式、未知字段、重复、空枚举、超上限', () => {
  // 别名撞保留键（模板已用发出键 + 系统注入键）。
  assert.deepEqual(
    violationsOf(T2I_SOURCES, overridesOf({ official: [{ field_key: 'size', wire_name: 'output_format' }], custom: [] })),
    ['wire_name_reserved'],
  );
  assert.deepEqual(
    violationsOf(T2I_SOURCES, overridesOf({ official: [{ field_key: 'size', wire_name: 'model' }], custom: [] })),
    ['wire_name_reserved'],
  );
  assert.deepEqual(
    violationsOf(T2I_SOURCES, overridesOf({ official: [{ field_key: 'size', wire_name: 'prompt' }], custom: [] })),
    ['wire_name_reserved'],
  );
  // wire 名格式。
  for (const badWire of ['Size', '1abc', 'a-b', 'has space']) {
    assert.deepEqual(
      violationsOf(T2I_SOURCES, overridesOf({ official: [{ field_key: 'size', wire_name: badWire }], custom: [] })),
      ['wire_name_format'],
      `wire name ${badWire} must be rejected`,
    );
  }
  // 自定义参数撞保留键 / 与别名互相查重。
  assert.deepEqual(
    violationsOf(T2I_SOURCES, overridesOf({
      official: [{ field_key: 'size', wire_name: 'image_size' }],
      custom: [{ label: '撞别名', wire_name: 'image_size', value_type: 'string', required: false }],
    })),
    ['wire_name_conflict'],
  );
  assert.deepEqual(
    violationsOf(T2I_SOURCES, overridesOf({
      official: [],
      custom: [
        { label: 'a', wire_name: 'dup_wire', value_type: 'string', required: false },
        { label: 'b', wire_name: 'dup_wire', value_type: 'string', required: false },
      ],
    })),
    ['wire_name_conflict'],
  );
  // 官方参数 field_key 未知 / 重复。
  assert.deepEqual(
    violationsOf(T2I_SOURCES, overridesOf({ official: [{ field_key: 'nope' }], custom: [] })),
    ['official_field_unknown'],
  );
  assert.deepEqual(
    violationsOf(T2I_SOURCES, overridesOf({
      official: [{ field_key: 'size' }, { field_key: 'size', wire_name: 'image_size' }],
      custom: [],
    })),
    ['official_field_duplicate'],
  );
  // 空枚举。
  assert.deepEqual(
    violationsOf(T2I_SOURCES, overridesOf({ official: [{ field_key: 'quality', enum_options: [] }], custom: [] })),
    ['enum_options_empty'],
  );
  // 自定义枚举缺枚举值 / 非枚举类型带枚举值。
  assert.deepEqual(
    violationsOf(T2I_SOURCES, overridesOf({
      official: [],
      custom: [{ label: '枚举', wire_name: 'my_enum', value_type: 'enum', required: false }],
    })),
    ['custom_enum_options_required'],
  );
  assert.deepEqual(
    violationsOf(T2I_SOURCES, overridesOf({
      official: [],
      custom: [{ label: '文本', wire_name: 'my_text', value_type: 'string', enum_options: ['a'], required: false }],
    })),
    ['custom_enum_options_not_allowed'],
  );
  // 数量上限。
  const tooMany = Array.from({ length: MAX_CUSTOM_PARAMETER_FIELDS + 1 }, (_, index) => ({
    label: `参数${index}`,
    wire_name: `my_param_${index}`,
    value_type: 'string' as const, required: false,
  }));
  assert.deepEqual(
    violationsOf(T2I_SOURCES, overridesOf({ official: [], custom: tooMany })),
    ['custom_limit_exceeded'],
  );
  // 禁用全部官方参数且无自定义 → 合成结果参数表单为空，保存拒绝。
  assert.deepEqual(
    violationsOf(T2I_SOURCES, overridesOf({
      official: [
        { field_key: 'size', enabled: false },
        { field_key: 'quality', enabled: false },
        { field_key: 'format', enabled: false },
        { field_key: 'moderation', enabled: false },
      ],
      custom: [],
    })),
    ['all_fields_disabled'],
  );
});

void test('禁用字段被其他字段 visible_when 或 payload_rules 条件引用时拒绝（族无关行为）', () => {
  // 合成最小模板：quality 被 extra 的显示条件与请求分支条件同时引用。
  const synthetic: GenerationFamilyTemplateSources = {
    runtimeModel: asRaw({
      model_id: 'synthetic',
      parameter_schema: {
        schema_type: 'object',
        fields: [
          { field_key: 'quality', label: 'q', component: 'select', enum_options: [{ value: 'auto' }, { value: 'low' }], default_value: 'auto' },
          { field_key: 'extra', label: 'e', component: 'text', visible_when: { field: 'quality', op: 'eq', value: 'auto' } },
        ],
        required_fields: [],
        default_values: { quality: 'auto' },
        validation_rules: [],
      },
      runtime: {
        payload_rules: {
          'api.endpoint': {
            kind: 'when',
            condition: { op: 'eq', field: 'quality', value: 'auto' },
            truthy: { kind: 'literal', value: '/a' },
            falsy: { kind: 'literal', value: '/b' },
          },
          'body.quality': { kind: 'field', field_key: 'quality' },
        },
        schema_defaults: { quality: 'auto' },
      },
    }),
    node: asRaw({}),
    // 显示名解析不可得时回退内部键名——借真实模板的 locales 满足类型，同时保持回退路径被走到。
    localizationResources: T2I_SOURCES.localizationResources,
  };
  assert.deepEqual(
    violationsOf(synthetic, overridesOf({ official: [{ field_key: 'quality', enabled: false }], custom: [] })),
    ['disabled_field_referenced', 'disabled_field_referenced'],
    'quality is referenced by both the request condition and extra.visible_when — one violation each',
  );
  // 无引用时禁用放行。
  assert.deepEqual(
    violationsOf(synthetic, overridesOf({ official: [{ field_key: 'extra', enabled: false }], custom: [] })),
    [],
  );
  // 真实模板中条件只引用 image（不可禁用），其余字段禁用不受条件检查阻碍。
  assert.deepEqual(
    violationsOf(I2I_SOURCES, overridesOf({ official: [{ field_key: 'moderation', enabled: false }], custom: [] })),
    [],
  );
});

void test('族模板参数描述：字段、wire 名、预设与保留键（GET 描述符端点的数据构建）', () => {
  const result = buildFamilyTemplateParameterDescriptor('openai-image-v1');
  assert.equal(result.kind, 'ready', 'openai-image-v1 must have a parameter descriptor');
  assert.ok(result.kind === 'ready');
  const descriptor = result.descriptor;
  assert.deepEqual(
    descriptor.official_fields.map((field) => field.field_key),
    ['size', 'quality', 'format', 'moderation'],
    'descriptor must exclude the image system-modality field',
  );
  const size = descriptor.official_fields.find((field) => field.field_key === 'size');
  assert.ok(size);
  assert.equal(size.component, 'imageSize');
  assert.equal(size.wire_name, 'size');
  assert.equal(size.label, '画面尺寸');
  assert.equal(size.default_value, 'auto');
  assert.deepEqual(size.resolution_presets.map((preset) => preset.key), ['1k', '2k', '4k']);
  assert.deepEqual(size.aspect_presets.map((preset) => preset.key), ['1:1', '3:2', '2:3', '16:9', '9:16']);
  assert.ok(size.resolution_presets.every((preset) => preset.label.length > 0));

  const format = descriptor.official_fields.find((field) => field.field_key === 'format');
  assert.ok(format);
  assert.equal(format.wire_name, 'output_format', 'wire name comes from payload_rules body.<键> target');
  assert.deepEqual(format.enum_options, ['png', 'jpeg', 'webp']);
  assert.equal(format.label, '图片格式');

  assert.ok(descriptor.reserved_wire_names.includes('model'));
  assert.ok(descriptor.reserved_wire_names.includes('prompt'));
  assert.ok(descriptor.reserved_wire_names.includes('input'));
  assert.ok(descriptor.reserved_wire_names.includes('image'), '素材位字段键保留，t2i 基线同样保留');
  // 素材位词表里的每个 id 都保留（参数层永不开放），词表扩容时这条断言自动跟随
  for (const slot of GENERATION_MEDIA_SLOT_IDS) {
    assert.ok(descriptor.reserved_wire_names.includes(slot), `${slot} 素材位必须保留`);
  }
  assert.ok(descriptor.reserved_wire_names.includes('output_format'));
  assert.ok(descriptor.reserved_wire_names.includes('n'));

  // 未知族与未就绪族必须可区分：前者是非法 id（路由 404），后者是合法接口类型但模板未实现
  assert.equal(buildFamilyTemplateParameterDescriptor('not-a-family').kind, 'unknown');
  // pending 清单从注册表派生（逐族实现批次逐个转 ready，测试不手写「哪族还没实现」——
  // 手写清单会在并行批次把某族转 ready 时变成对方的红灯）。
  const pendingFamilyAdapterIds = GENERATION_FAMILY_ADAPTER_IDS.filter(
    (id) => GENERATION_FAMILY_TEMPLATE_REGISTRY[id].status === 'pending',
  );
  for (const pendingFamilyAdapterId of pendingFamilyAdapterIds) {
    assert.equal(
      buildFamilyTemplateParameterDescriptor(pendingFamilyAdapterId).kind,
      'pending',
      `${pendingFamilyAdapterId} 在注册表里 pending，描述符入口必须同样返回 pending`,
    );
  }
  // veo 族已就绪：同一入口必须给出描述符而不是 pending
  assert.equal(buildFamilyTemplateParameterDescriptor('veo-v1').kind, 'ready');

  // 素材位能力：描述符必须从注册表条目填入（各族不各自声明一份，防两侧漂移）
  const descriptorByFamily = new Map<GenerationFamilyAdapterId, readonly GenerationMediaSlotId[]>();
  for (const familyAdapterId of GENERATION_FAMILY_ADAPTER_IDS) {
    const built = buildFamilyTemplateParameterDescriptor(familyAdapterId);
    if (built.kind !== 'ready') continue;
    descriptorByFamily.set(familyAdapterId, built.descriptor.supports_media_slots);
    assert.deepEqual(
      built.descriptor.supports_media_slots,
      [...GENERATION_FAMILY_TEMPLATE_REGISTRY[familyAdapterId].supportsMediaSlots],
      `${familyAdapterId} 的描述符素材位必须等于注册表声明的能力`,
    );
  }
  // 三个代表族的取值显式钉住：0 位族给空数组（不是缺键），Veo 不含参考图
  assert.deepEqual(descriptorByFamily.get('kling-text2video-v1'), [], '文生视频族一个素材位都没有');
  assert.deepEqual(descriptorByFamily.get('veo-v1'), ['first_frame', 'last_frame']);
  assert.equal(descriptorByFamily.get('seedance-2-0-v1')?.length, 5, 'Seedance 2.0 五个素材位');
});

void test('校验错误文案用户可读：无内部术语上屏、用中文显示名拼句', () => {
  // 触发每一条校验项的非法覆盖组合，逐条断言文案不含内部术语。
  const invalidBatches: ParameterOverrides[] = [
    { official: [{ field_key: 'nope' }], custom: [] },
    { official: [{ field_key: 'image', enabled: false }], custom: [] },
    { official: [{ field_key: 'size' }, { field_key: 'size' }], custom: [] },
    { official: [{ field_key: 'size', wire_name: 'Size' }], custom: [] },
    { official: [{ field_key: 'size', wire_name: 'model' }], custom: [] },
    { official: [{ field_key: 'size', wire_name: 'output_format' }], custom: [] },
    { official: [{ field_key: 'size', wire_name: 'image_size' }, { field_key: 'quality', wire_name: 'image_size' }], custom: [] },
    { official: [{ field_key: 'quality', enum_options: [] }], custom: [] },
    { official: [{ field_key: 'size', enum_options: ['auto'] }], custom: [] },
    { official: [{ field_key: 'size', resolution_preset_keys: ['9k'] }], custom: [] },
    { official: [{ field_key: 'quality', resolution_preset_keys: ['1k'] }], custom: [] },
    { official: [{ field_key: 'quality', default_value: 'ultra' }], custom: [] },
    { official: [{ field_key: 'format', default_value: 'bogus' }], custom: [] },
    {
      official: [
        { field_key: 'size', enabled: false },
        { field_key: 'quality', enabled: false },
        { field_key: 'format', enabled: false },
        { field_key: 'moderation', enabled: false },
      ],
      custom: [],
    },
    {
      official: [],
      custom: [
        { label: '文本', wire_name: 'my_text', value_type: 'string', enum_options: ['a'], required: false },
        { label: '枚举', wire_name: 'my_enum', value_type: 'enum', required: false },
        { label: '重名', wire_name: 'my_dup', value_type: 'string', required: false },
        { label: '重名', wire_name: 'my_dup', value_type: 'string', required: false },
        { label: '撞保留', wire_name: 'prompt', value_type: 'string', required: false },
      ],
    },
    { official: [], custom: Array.from({ length: MAX_CUSTOM_PARAMETER_FIELDS + 1 }, (_, index) => ({ label: `参数${index}`, wire_name: `my_p_${index}`, value_type: 'string' as const, required: false })) },
  ];
  // 内部术语禁用清单（协调方文案要求）：这些词一律不得出现在用户可见错误里。
  const bannedTerms = ['发出键名', 'wire', '字段', '模板', '系统键', '别名', '覆盖', '投影', '声明', '协议', 'payload', 'schema', 'field_key', '枚举值列表'];
  const allMessages: string[] = [];
  for (const overrides of invalidBatches) {
    const violations = validateParameterOverrides(T2I_SOURCES, overridesOf(overrides));
    assert.ok(violations.length > 0, 'each invalid batch must produce at least one violation');
    for (const violation of violations) {
      allMessages.push(violation.message);
      for (const term of bannedTerms) {
        assert.ok(!violation.message.includes(term), `message must not contain banned term "${term}": ${violation.message}`);
      }
    }
  }
  // 显示名拼句：官方参数的错误用模板中文显示名（如「图片格式」），不用内部键名当名词。
  assert.ok(
    allMessages.some((message) => message.includes('图片格式')),
    'format-related messages must use the resolved Chinese display name',
  );
  assert.ok(
    allMessages.some((message) => message.includes('画面尺寸')),
    'size-related messages must use the resolved Chinese display name',
  );
  // 每条消息以句号收尾、含可读指引（冒号或请字）。
  for (const message of allMessages) {
    assert.ok(message.endsWith('。'), `message must end with a full stop: ${message}`);
    assert.ok(message.includes('请') || message.includes('：'), `message must carry guidance: ${message}`);
  }
});

/**
 * 合成一份「字段引用嵌在 compute 规则内部」的模板：这是 gemini 图像族的真实形态
 * （`body.response_format` = compact_object，`image_size` 来自 normalize_enum.args[0]，
 * `mime_type` 直取字段）。历史缺陷：保存期只认 `when.condition.field`、合成期遍历又排除
 * 数组，两层错位导致禁用 imageSize 在合成期抛错、禁用 mimeType 静默删掉整个
 * `body.response_format`。
 */
const buildNestedComputeSources = (): GenerationFamilyTemplateSources => ({
  runtimeModel: asRaw({
    model_id: 'nested-compute',
    parameter_schema: {
      schema_type: 'object',
      fields: [
        { field_key: 'aspectRatio', label: 'ar', component: 'select', enum_options: [{ value: 'auto' }, { value: '1:1' }], default_value: 'auto' },
        { field_key: 'imageSize', label: 'is', component: 'select', enum_options: [{ value: '1K' }, { value: '2K' }], default_value: '1K' },
        { field_key: 'mimeType', label: 'mt', component: 'select', enum_options: [{ value: 'image/jpeg' }], default_value: 'image/jpeg' },
      ],
      required_fields: [],
      default_values: { aspectRatio: 'auto', imageSize: '1K', mimeType: 'image/jpeg' },
      validation_rules: [],
    },
    runtime: {
      payload_rules: {
        'body.response_format': {
          kind: 'compute',
          operator: 'compact_object',
          entries: {
            type: { kind: 'literal', value: 'image' },
            aspect_ratio: { kind: 'field', field_key: 'aspectRatio' },
            // 字段引用在数组里，且是嵌套 compute。
            image_size: {
              kind: 'compute',
              operator: 'normalize_enum',
              args: [{ kind: 'field', field_key: 'imageSize' }],
              options: { allowed_values: ['1K', '2K'], fallback: '1K' },
            },
            mime_type: {
              kind: 'compute',
              operator: 'coalesce',
              args: [{ kind: 'field', field_key: 'mimeType' }],
            },
          },
        },
        'meta.imageSize': { kind: 'field', field_key: 'imageSize' },
      },
      schema_defaults: { aspectRatio: 'auto', imageSize: '1K', mimeType: 'image/jpeg' },
    },
  }),
  node: asRaw({}),
  localizationResources: T2I_SOURCES.localizationResources,
});

void test('禁用嵌套在 compute 规则里的字段：保存期可读拒绝，合成期不抛错不删目标', () => {
  const sources = buildNestedComputeSources();
  // 1) 保存期必须给出可读拒绝（而不是放行后在合成期炸掉）。
  for (const fieldKey of ['imageSize', 'mimeType']) {
    const violations = validateParameterOverrides(sources, overridesOf({
      official: [{ field_key: fieldKey, enabled: false }],
      custom: [],
    }));
    const codes = violations.map((violation) => violation.code);
    assert.ok(
      codes.includes('disabled_field_referenced'),
      `${fieldKey} 参与请求构造，禁用必须在保存期被拒绝，实际：${JSON.stringify(codes)}`,
    );
    // 拒绝文案必须说清后果并给可行指引（不出现内部术语）。
    const message = violations.find((violation) => violation.code === 'disabled_field_referenced')?.message ?? '';
    assert.ok(message.includes('参与决定生成请求怎么发送'), `拒绝文案必须说明原因：${message}`);
    assert.ok(message.includes('请'), `拒绝文案必须给指引：${message}`);
    // 2) 合成期不得发生：保存期已拒绝 → applyParameterOverrides 前置校验直接抛错。
    assert.throws(
      () => applyParameterOverrides(sources, overridesOf({ official: [{ field_key: fieldKey, enabled: false }], custom: [] })),
      /参数/,
      `${fieldKey} 的禁用不得进入合成`,
    );
  }

  // 3) 另一种「可安全裁剪」的形态：引用全部落在禁用字段自身，没有固化协议常量。
  const prunable = asRaw({
    model_id: 'prunable',
    parameter_schema: {
      schema_type: 'object',
      fields: [
        { field_key: 'seed', label: 's', component: 'text', default_value: '' },
        { field_key: 'quality', label: 'q', component: 'select', enum_options: [{ value: 'auto' }], default_value: 'auto' },
      ],
      required_fields: [],
      default_values: { seed: '', quality: 'auto' },
      validation_rules: [],
    },
    runtime: {
      payload_rules: {
        'body.seed': {
          kind: 'when',
          condition: { op: 'truthy', field: 'seed' },
          truthy: { kind: 'field', field_key: 'seed' },
        },
        'meta.seed': {
          kind: 'compute',
          operator: 'coalesce',
          args: [{ kind: 'field', field_key: 'seed' }],
        },
        'body.quality': { kind: 'field', field_key: 'quality' },
      },
      schema_defaults: { seed: '', quality: 'auto' },
    },
  });
  const prunableSources: GenerationFamilyTemplateSources = {
    runtimeModel: prunable,
    node: asRaw({}),
    localizationResources: T2I_SOURCES.localizationResources,
  };
  const overrides = overridesOf({ official: [{ field_key: 'seed', enabled: false }], custom: [] });
  assert.deepEqual(violationsOf(prunableSources, overrides), [], '只引用自身的字段可以安全禁用');
  const output = applyParameterOverrides(prunableSources, overrides);
  const rules = payloadRulesOf(output);
  assert.equal(rules['body.seed'], undefined, '引用被禁用字段自身的目标被裁剪');
  assert.equal(rules['meta.seed'], undefined, '嵌套在 compute.args 里的同一字段目标也被裁剪');
  assert.ok(rules['body.quality'], '与前缀无关的目标必须保留');
  assert.equal(fieldRecordOf(output, 'quality').field_key, 'quality');
});

void test('禁用任何字段都不得让整条规则键被静默删除（含协议常量与共享字段）', () => {
  const sources = buildNestedComputeSources();
  for (const fieldKey of ['imageSize', 'mimeType']) {
    // 绕过保存期拒绝，直接探测合成期判据：必须抛错（fail loud），不得静默返回缺键结果。
    assert.throws(
      () => applyParameterOverrides(sources, overridesOf({ official: [{ field_key: fieldKey, enabled: false }], custom: [] })),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        // 不得是「合成期才发现的字段键悬空」——那说明保存期没拦住。
        assert.ok(
          !error.message.includes('invalid_payload_rule_field_key'),
          `必须以可读原因拒绝，而不是合成期字段键悬空：${error.message}`,
        );
        return true;
      },
    );
  }
  // 合法的收窄覆盖不得破坏 response_format 结构。
  const narrowed = applyParameterOverrides(sources, overridesOf({
    official: [{ field_key: 'imageSize', enum_options: ['1K'] }],
    custom: [],
  }));
  const narrowedRules = payloadRulesOf(narrowed);
  assert.ok('body.response_format' in narrowedRules, '合法覆盖不得删掉整条 response_format');
  assert.ok('meta.imageSize' in narrowedRules);
});

void test('真实 gemini 图像族：嵌套 compute 字段引用被保存期识别（族无关口径回归）', () => {
  // 该族为自保在外层加了 `when truthy <field>` 守卫；即便去掉守卫（字段引用只留在
  // compute.args 里），保存期也必须给出同样的可读拒绝——这才是根因修复的判据。
  const sources = buildGeminiImageInteractionsV1BaseTemplateSources('gemini-nested-check', {
    acceptedMediaSlots: [],
  });
  const responseFormat = asRaw(payloadRulesOf(sources)['body.response_format']);
  const entries = asRaw(responseFormat.entries);
  // 复刻「无守卫」形态：把 when 拆掉，直接留下被包裹的值规则。
  const unguarded: JsonObject = { ...asRaw(responseFormat) };
  const unguardedEntries: JsonObject = { ...entries };
  for (const key of ['image_size', 'mime_type']) {
    const guarded = asRaw(unguardedEntries[key]);
    unguardedEntries[key] = guarded.truthy;
  }
  unguarded.entries = unguardedEntries;
  const unguardedSources: GenerationFamilyTemplateSources = {
    runtimeModel: asRaw({
      ...asRaw(sources.runtimeModel),
      runtime: asRaw({
        ...asRaw(asRaw(sources.runtimeModel).runtime),
        payload_rules: asRaw({
          ...payloadRulesOf(sources),
          'body.response_format': unguarded,
        }),
      }),
    }),
    node: sources.node,
    localizationResources: sources.localizationResources,
  };
  for (const fieldKey of ['imageSize', 'mimeType']) {
    const codes = violationsOf(unguardedSources, overridesOf({
      official: [{ field_key: fieldKey, enabled: false }],
      custom: [],
    }));
    assert.ok(
      codes.includes('disabled_field_referenced'),
      `无守卫形态下禁用 ${fieldKey} 仍必须被保存期拒绝，实际：${JSON.stringify(codes)}`,
    );
  }
  // 合法覆盖照常工作。
  assert.deepEqual(violationsOf(sources, overridesOf({
    official: [{ field_key: 'imageSize', enum_options: ['1K'] }],
    custom: [],
  })), []);
});
