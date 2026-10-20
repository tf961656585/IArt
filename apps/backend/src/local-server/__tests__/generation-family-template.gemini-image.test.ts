import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ADAPTER_REGISTRY,
  GENERATION_FAMILY_ADAPTER_IDS,
  type GenerationFamilyAdapterId,
  type GenerationMediaSlotId,
} from '@iart/contracts';
import {
  GEMINI_IMAGE_INTERACTIONS_V1_FAMILY_ADAPTER_ID,
  GEMINI_IMAGE_INTERACTIONS_V1_SUPPORTED_MEDIA_SLOTS,
  buildGeminiImageInteractionsV1BaseTemplateSources,
  buildGeminiImageInteractionsV1ParameterDescriptor,
} from '../generation-family-templates.gemini-image.cts';
import { buildProjectionFromPackageSources } from '../model-package-catalog.projection.cts';
import { isObjectRecord } from '../model-package-catalog.shared.cts';
import { declaredGenerationPackageId } from '../generation-family-templates.cts';
import {
  applyParameterOverrides,
  validateParameterOverrides,
} from '../generation-parameter-overrides.cts';
import {
  GENERATION_FAMILY_TEMPLATE_REGISTRY,
  buildFamilyTemplateSources,
  checkFamilyMediaSlotSupport,
} from '../generation-family-templates.registry.cts';

/**
 * gemini-image-interactions-v1 族模板（Gemini 图像 Interactions 接口，同步）。
 *
 * 钉四件事：
 * ① 两种素材位形态都能构建出**合法** sources，且能走通与已装包相同的
 *    `buildProjectionFromPackageSources` 投影路径（本地化校验、字段键引用校验一并跑过）；
 * ② 同步结果规则与结果映射的关键字段与实测包一致（`mode:'sync'`、`error.*` 三路失败条件、
 *    `steps.[].content` 的产出位置）——这几项漂移会直接让任务永远停在 running 或静默空结果；
 * ③ 参考图开关决定表单字段 / 输入端口 / `input` 内容块分支三处同时切换；
 * ④ 注册表条目已就绪、能力事实与适配器 endpoint 同源（7 族门禁的族侧事实）。
 *
 * 本族模板自包含：测试只读内存态 sources，不读任何磁盘资产（模板是唯一来源）。
 */

const MODEL_ID = 'declared-gemini-image-test';

/** 取模板 runtime 段（模板由本仓构建，形状受控；仍按 unknown 收窄不用断言）。 */
const runtimeOf = (sources: { runtimeModel: { runtime: unknown } }): Record<string, unknown> => {
  const runtime = sources.runtimeModel.runtime;
  assert.ok(isObjectRecord(runtime) && !Array.isArray(runtime), 'template runtime must be an object');
  return runtime;
};

/** 取 payload_rules（投影前的模板原始规则）。 */
const payloadRulesOf = (sources: { runtimeModel: { runtime: unknown } }): Record<string, unknown> => {
  const rules = runtimeOf(sources)['payload_rules'];
  assert.ok(isObjectRecord(rules) && !Array.isArray(rules), 'template must carry payload_rules');
  return rules;
};

/** 取结果规则（runtime_model.result_rule）。 */
const resultRuleOf = (sources: { runtimeModel: Record<string, unknown> }): Record<string, unknown> => {
  const rule = sources.runtimeModel['result_rule'];
  assert.ok(isObjectRecord(rule) && !Array.isArray(rule), 'template must carry result_rule');
  return rule;
};

/** 取结果映射（runtime_model.result_output_mapping）。 */
const resultOutputMappingOf = (
  sources: { runtimeModel: Record<string, unknown> },
): Record<string, unknown> => {
  const mapping = sources.runtimeModel['result_output_mapping'];
  assert.ok(isObjectRecord(mapping) && !Array.isArray(mapping), 'template must carry result_output_mapping');
  return mapping;
};

/** 取参数表单字段列表。 */
const parameterFieldsOf = (sources: {
  runtimeModel: Record<string, unknown>;
}): Record<string, unknown>[] => {
  const schema = sources.runtimeModel['parameter_schema'];
  assert.ok(isObjectRecord(schema) && !Array.isArray(schema), 'template must carry parameter_schema');
  const fields = schema['fields'];
  assert.ok(Array.isArray(fields), 'parameter_schema.fields must be an array');
  return fields.map((field) => {
    assert.ok(isObjectRecord(field) && !Array.isArray(field), 'parameter field must be an object');
    return field;
  });
};

/** 取 `input` 内容块规则里的 parts（build_content_blocks）。 */
const inputPartsOf = (sources: { runtimeModel: { runtime: unknown } }): Record<string, unknown>[] => {
  const inputRule = payloadRulesOf(sources)['body.input'];
  assert.ok(isObjectRecord(inputRule) && !Array.isArray(inputRule), 'body.input rule must be an object');
  assert.equal(inputRule['operator'], 'build_content_blocks');
  const options = inputRule['options'];
  assert.ok(isObjectRecord(options) && !Array.isArray(options), 'body.input rule must carry options');
  assert.equal(options['output_shape'], 'interactions_input', 'Interactions 输入是扁平 content blocks');
  const parts = options['parts'];
  assert.ok(Array.isArray(parts), 'body.input options.parts must be an array');
  return parts.map((part) => {
    assert.ok(isObjectRecord(part) && !Array.isArray(part), 'content part must be an object');
    return part;
  });
};

/** 把模板 sources 走一遍真实投影路径（失败即抛，测试据此判红）。 */
const projectTemplate = (acceptedMediaSlots: readonly GenerationMediaSlotId[]) => {
  const sources = buildGeminiImageInteractionsV1BaseTemplateSources(MODEL_ID, { acceptedMediaSlots });
  return buildProjectionFromPackageSources({
    packageId: declaredGenerationPackageId(GEMINI_IMAGE_INTERACTIONS_V1_FAMILY_ADAPTER_ID),
    entryModelModelId: MODEL_ID,
    protocolFormat: undefined,
    runtimeModel: sources.runtimeModel,
    node: sources.node,
    localizationResources: sources.localizationResources,
  });
};

void test('gemini 族模板：参考图形态构建出合法 sources 并走通合成投影路径', () => {
  const { projection, localizationBundle } = projectTemplate(['reference_image']);

  assert.equal(projection.model_id, MODEL_ID);
  assert.equal(projection.role, 'generator');
  assert.equal(projection.group_key, 'google');
  assert.deepEqual(projection.capability.output_modalities, ['image']);
  assert.deepEqual(projection.capability.input_modalities, ['text', 'image']);
  assert.equal(projection.capability.supports_async_task, false, 'Gemini 图像是同步接口，不声明异步任务');
  assert.equal(projection.capability.supports_reference_media, true);
  assert.equal(projection.capability.supports_multi_image, true);

  // 参数表单：参考图 + 比例 + 尺寸档 + 输出格式（顺序即创作面呈现顺序）
  assert.deepEqual(
    projection.parameter_schema.fields.map((field) => field.field_key),
    ['image', 'aspectRatio', 'imageSize', 'mimeType'],
  );
  assert.deepEqual(projection.parameter_schema.default_values, {
    image: [],
    aspectRatio: 'auto',
    imageSize: '1K',
    mimeType: 'image/jpeg',
  });

  // 输入端口由素材位字段派生（data_source=both → connection 可接入），输出端口恒有
  assert.deepEqual(
    projection.ports.inputs.map((port) => port.field_key),
    ['image'],
  );
  assert.deepEqual(
    projection.ports.outputs.map((port) => port.id),
    ['image'],
  );

  // 本地化：字段/端口标签必须被重写成命名空间前缀键（投影处不硬编码文案）
  assert.ok(
    projection.parameter_schema.fields.every((field) => field.label.startsWith('model-asset/')),
    'labels must be namespaced localization keys, not hardcoded copy',
  );
  assert.ok(
    projection.ports.outputs.every((port) => port.name.startsWith('model-asset/')),
    'port names must be namespaced localization keys',
  );
  assert.equal(localizationBundle.namespace, `model-asset/${declaredGenerationPackageId(GEMINI_IMAGE_INTERACTIONS_V1_FAMILY_ADAPTER_ID)}`);

  // 提交端点：模板字面量必须与适配器声明一致（一致性门禁的族侧事实）
  const adapterEndpoint = ADAPTER_REGISTRY['gemini-image-interactions-v1'].relative_endpoints?.['interactions'];
  assert.equal(adapterEndpoint, '/v1beta/interactions');
  assert.equal(projection.runtime.api_defaults?.endpoint, adapterEndpoint);
  assert.equal(projection.runtime.payload_format, 'json');
  assert.equal(
    projection.runtime.url_input_upload_mode,
    undefined,
    '无公网中转：媒体走 inline_data，不声明 public relay',
  );
});

void test('gemini 族模板：同步结果规则与结果映射与实测包一致', () => {
  const sources = buildGeminiImageInteractionsV1BaseTemplateSources(MODEL_ID, {
    acceptedMediaSlots: [],
  });

  const resultRule = resultRuleOf(sources);
  assert.equal(resultRule['mode'], 'sync', 'Interactions 图像生成是同步返回，不得声明 polling');
  assert.equal(resultRule['submit_response_id_path'], '/id');
  assert.deepEqual(resultRule['failure_condition'], {
    op: 'any',
    children: [
      { op: 'not_empty', path: 'error.message' },
      { op: 'not_empty', path: 'error.code' },
      { op: 'not_empty', path: 'error.status' },
    ],
  });
  assert.deepEqual(resultRule['error_mapping_rules'], [
    { target: 'code', source: { kind: 'response', path: 'error.code' }, required: false },
    { target: 'message', source: { kind: 'response', path: 'error.message' }, required: false },
    { target: 'details.remote.status', source: { kind: 'response', path: 'error.status' }, required: false },
  ]);
  assert.equal(
    sources.runtimeModel['polling_strategy'],
    undefined,
    '同步族模板不得带轮询策略（无任务查询 endpoint）',
  );

  const mapping = resultOutputMappingOf(sources);
  assert.equal(mapping['response_mode'], 'structured_payload');
  assert.deepEqual(mapping['output_mapping_rules'], [
    { target: 'output.image_url', source: { kind: 'response', path: 'steps.[].content' }, required: true },
    {
      target: 'output.text',
      source: { kind: 'response', path: 'steps.[].content' },
      required: false,
      default_value: null,
    },
  ]);

  // 提示词保留键：必填、无长度校验（与在役包一致）
  assert.deepEqual(sources.runtimeModel['prompt_field'], {
    field_key: '__prompt',
    required: true,
    validation_rules: [],
  });
});

void test('gemini 族模板：参考图开关决定表单字段、输入端口与 input 内容块分支', () => {
  const withReference = buildGeminiImageInteractionsV1BaseTemplateSources(MODEL_ID, {
    acceptedMediaSlots: ['reference_image'],
  });
  const withoutReference = buildGeminiImageInteractionsV1BaseTemplateSources(MODEL_ID, {
    acceptedMediaSlots: [],
  });

  // ① 表单字段
  assert.deepEqual(
    parameterFieldsOf(withReference).map((field) => field['field_key']),
    ['image', 'aspectRatio', 'imageSize', 'mimeType'],
  );
  assert.deepEqual(
    parameterFieldsOf(withoutReference).map((field) => field['field_key']),
    ['aspectRatio', 'imageSize', 'mimeType'],
    '文生图形态不得生成参考图字段',
  );
  const imageField = parameterFieldsOf(withReference)[0];
  assert.equal(imageField?.['component'], 'imageUpload');
  assert.equal(imageField?.['data_source'], 'both');
  assert.deepEqual(imageField?.['component_props'], { accept: 'image/*', maxFiles: 14 });

  // ② 输入端口
  const referenceNode = withReference.node;
  assert.ok(Array.isArray(referenceNode['input_ports']));
  assert.equal(referenceNode['input_ports'].length, 1);
  assert.deepEqual(referenceNode['input_ports'], [
    {
      id: 'image',
      name: 'ports.inputs.image.name',
      data_type: 'image',
      field_key: 'image',
      required: false,
      multiple: true,
      description: 'ports.inputs.image.description',
    },
  ]);
  assert.ok(Array.isArray(withoutReference.node['input_ports']));
  assert.equal(withoutReference.node['input_ports'].length, 0, '文生图形态没有参考图输入端口');

  // ③ input 内容块：文生图只有 text part；参考图形态多一个 inline_data part
  const textOnlyParts = inputPartsOf(withoutReference);
  assert.deepEqual(textOnlyParts.map((part) => part['part_kind']), ['text']);
  assert.deepEqual(textOnlyParts[0]?.['value'], {
    kind: 'field',
    field_key: '__prompt',
    transforms: ['trim'],
  });

  const referenceParts = inputPartsOf(withReference);
  assert.deepEqual(referenceParts.map((part) => part['part_kind']), ['text', 'inline_data']);
  const inlinePart = referenceParts[1];
  assert.deepEqual(inlinePart?.['value'], {
    kind: 'field',
    field_key: 'image',
    transforms: ['extractUrls'],
    media_target: 'inline_data',
  });
  assert.equal(inlinePart?.['multiple'], true);
  assert.equal(inlinePart?.['max_items'], 14, 'inline 分支张数上限必须与表单 maxFiles 同源');

  // ④ 无素材位形态也不得引用 image 字段（投影校验会拒引用不存在字段的规则）
  assert.equal(
    JSON.stringify(payloadRulesOf(withoutReference)).includes('"field_key":"image"'),
    false,
    '文生图形态的 payload_rules 不得引用不存在的 image 字段',
  );

  // ⑤ 两种形态都能走通真实投影路径
  assert.doesNotThrow(() => projectTemplate([]));
  assert.doesNotThrow(() => projectTemplate(['reference_image']));
});

void test('gemini 族模板：比例/尺寸/输出格式的族通用档位与请求体条件规则', () => {
  const sources = buildGeminiImageInteractionsV1BaseTemplateSources(MODEL_ID, {
    acceptedMediaSlots: [],
  });
  const fields = parameterFieldsOf(sources);
  const enumValues = (fieldKey: string): unknown[] => {
    const field = fields.find((item) => item['field_key'] === fieldKey);
    assert.ok(field, `${fieldKey} field must exist`);
    const options = field['enum_options'];
    assert.ok(Array.isArray(options), `${fieldKey} enum_options must be an array`);
    return options.map((option) => {
      assert.ok(isObjectRecord(option) && !Array.isArray(option), 'enum option must be an object');
      return option['value'];
    });
  };

  // 族通用比例：全族共有的 10 档 + auto（flash 独有的 4 个极端比例不入族模板）
  assert.deepEqual(enumValues('aspectRatio'), [
    'auto',
    '1:1',
    '2:3',
    '3:2',
    '3:4',
    '4:3',
    '4:5',
    '5:4',
    '9:16',
    '16:9',
    '21:9',
  ]);
  // 族通用尺寸档：1K/2K/4K（flash 独有的 512 不入族模板；lite 的仅 1K 由记录级收窄表达）
  assert.deepEqual(enumValues('imageSize'), ['1K', '2K', '4K']);
  assert.deepEqual(enumValues('mimeType'), ['image/jpeg']);

  // response_format：type 恒为 image，aspect_ratio 条件省略，image_size 收敛到族档位
  const responseFormat = payloadRulesOf(sources)['body.response_format'];
  assert.ok(isObjectRecord(responseFormat) && !Array.isArray(responseFormat));
  assert.equal(responseFormat['operator'], 'compact_object');
  const entries = responseFormat['entries'];
  assert.ok(isObjectRecord(entries) && !Array.isArray(entries));
  assert.deepEqual(entries['type'], { kind: 'literal', value: 'image' });
  assert.deepEqual(entries['aspect_ratio'], {
    kind: 'when',
    condition: { op: 'ne', field: 'aspectRatio', value: 'auto' },
    truthy: { kind: 'field', field_key: 'aspectRatio', transforms: ['trim'] },
  });
  // image_size / mime_type 外层是 truthy 守卫：空值不发（求值语义，见模板 buildResponseFormatRule 说明）
  const imageSizeRule = entries['image_size'];
  assert.ok(isObjectRecord(imageSizeRule) && !Array.isArray(imageSizeRule));
  assert.deepEqual(imageSizeRule['condition'], { op: 'truthy', field: 'imageSize' });
  const imageSizeValueRule = imageSizeRule['truthy'];
  assert.ok(isObjectRecord(imageSizeValueRule) && !Array.isArray(imageSizeValueRule));
  assert.equal(imageSizeValueRule['operator'], 'normalize_enum');
  const sizeOptions = imageSizeValueRule['options'];
  assert.ok(isObjectRecord(sizeOptions) && !Array.isArray(sizeOptions));
  assert.deepEqual(sizeOptions['allowed_values'], enumValues('imageSize'), 'wire 收敛集合必须与表单枚举同源');
  assert.equal(sizeOptions['fallback'], '1K');

  const mimeTypeRule = entries['mime_type'];
  assert.ok(isObjectRecord(mimeTypeRule) && !Array.isArray(mimeTypeRule));
  assert.deepEqual(mimeTypeRule['condition'], { op: 'truthy', field: 'mimeType' });
  assert.deepEqual(mimeTypeRule['truthy'], {
    kind: 'field',
    field_key: 'mimeType',
    transforms: ['trim'],
  });
});

void test('gemini 族模板：image_size / mime_type 的 truthy 守卫承担「空值不发」（求值语义，不是纯声明）', async () => {
  const { evaluateRuntimeValueRule } = await import('@iart/model-asset-runtime');
  const sources = buildGeminiImageInteractionsV1BaseTemplateSources(MODEL_ID, {
    acceptedMediaSlots: [],
  });
  const responseFormat = payloadRulesOf(sources)['body.response_format'];
  assert.ok(isObjectRecord(responseFormat) && !Array.isArray(responseFormat));
  const entries = responseFormat['entries'];
  assert.ok(isObjectRecord(entries));

  const evaluateWith = async (fields: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const value = await evaluateRuntimeValueRule(
      responseFormat as never,
      { fields } as never,
      {} as never,
    );
    assert.ok(isObjectRecord(value), 'response_format 求值结果必须是对象');
    return value;
  };

  // 有值时：三个字段都按表单值发出。
  const filled = await evaluateWith({ imageSize: '4K', mimeType: 'image/jpeg', aspectRatio: '1:1' });
  assert.equal(filled['image_size'], '4K');
  assert.equal(filled['mime_type'], 'image/jpeg');
  assert.equal(filled['aspect_ratio'], '1:1');

  // 空值：image_size / mime_type 整键缺席（服务端走官方默认档），而不是被 fallback 填成 1K
  // 或发出空串——这正是守卫不能被「清理」掉的原因：去掉守卫后 normalize_enum 会把空值
  // 收敛成 fallback 并显式发出 image_size，凭空给请求体塞了用户没选的档位。
  const empty = await evaluateWith({ imageSize: '', mimeType: '', aspectRatio: 'auto' });
  assert.equal(empty['image_size'], undefined, '空 imageSize 不得被 fallback 填成显式档位发出');
  assert.equal(empty['mime_type'], undefined, '空 mimeType 不得发出空串');
  assert.equal(empty['aspect_ratio'], undefined, 'auto 时省略 aspect_ratio（跟随参考图比例）');
  assert.deepEqual(Object.keys(empty).sort(), ['type'], '空值档下只发协议常量 type');
});

void test('gemini 族模板：三个参数都不可被记录覆盖静默禁用（参与请求构造）', () => {
  const sources = buildGeminiImageInteractionsV1BaseTemplateSources(MODEL_ID, {
    acceptedMediaSlots: [],
  });
  // 三个字段都参与构造 body.response_format：禁用任何一个都会让请求体变形，保存期必须给
  // 可读拒绝。引用提取已统一到 model-package-catalog.payload-rule-references.cts（数组与
  // compute.args 内的引用同样可见），因此这条行为不再依赖模板把引用提到 condition.field 上；
  // 守卫保留是为了「空值不发」的求值语义（见模板 buildResponseFormatRule 头注）。
  for (const fieldKey of ['aspectRatio', 'imageSize', 'mimeType']) {
    const violations = validateParameterOverrides(sources, {
      official: [{ field_key: fieldKey, enabled: false }],
      custom: [],
    });
    assert.ok(
      violations.some((violation) => violation.code === 'disabled_field_referenced'),
      `${fieldKey} 被禁用时必须被可读拒绝，而不是在合成期抛错或静默删掉 response_format`,
    );
    assert.throws(
      () => applyParameterOverrides(sources, { official: [{ field_key: fieldKey, enabled: false }], custom: [] }),
      /参数/,
      `${fieldKey} 的禁用不得进入合成（保存期已拒绝）`,
    );
  }

  // 合法覆盖（收窄枚举、改显示名、加自定义参数）必须照常工作，且不破坏请求体结构
  const narrowed = applyParameterOverrides(sources, {
    official: [
      { field_key: 'imageSize', enum_options: ['1K'] },
      { field_key: 'aspectRatio', enum_options: ['auto', '1:1'] },
    ],
    custom: [{ wire_name: 'seed', label: '随机种子', value_type: 'number', required: false }],
  });
  const narrowedRules = payloadRulesOf(narrowed);
  assert.ok('body.response_format' in narrowedRules, '合法覆盖不得删掉 response_format');
  assert.deepEqual(narrowedRules['body.seed'], { kind: 'field', field_key: 'seed' });
  assert.doesNotThrow(() =>
    buildProjectionFromPackageSources({
      packageId: declaredGenerationPackageId(GEMINI_IMAGE_INTERACTIONS_V1_FAMILY_ADAPTER_ID),
      entryModelModelId: MODEL_ID,
      protocolFormat: undefined,
      runtimeModel: narrowed.runtimeModel,
      node: narrowed.node,
      localizationResources: narrowed.localizationResources,
    }),
  );
});

void test('gemini 族模板：model_id 字面量同时落在 body.model 与 meta.model_id（等 remote_model_id 注入替换）', () => {
  const sources = buildGeminiImageInteractionsV1BaseTemplateSources('declared-gemini-model-x', {
    acceptedMediaSlots: [],
  });
  const rules = payloadRulesOf(sources);
  assert.deepEqual(rules['body.model'], { kind: 'literal', value: 'declared-gemini-model-x' });
  assert.deepEqual(rules['meta.model_id'], { kind: 'literal', value: 'declared-gemini-model-x' });
  assert.deepEqual(rules['api.endpoint'], { kind: 'literal', value: '/v1beta/interactions' });
  assert.deepEqual(rules['api.method'], { kind: 'literal', value: 'POST' });
  assert.deepEqual(rules['api.contentType'], { kind: 'literal', value: 'application/json' });
});

void test('gemini 族注册表条目：已就绪、能力事实与适配器同源，参数描述可用', () => {
  const entry = GENERATION_FAMILY_TEMPLATE_REGISTRY['gemini-image-interactions-v1'];
  assert.equal(entry.status, 'ready');
  assert.equal(entry.familyAdapterId, GEMINI_IMAGE_INTERACTIONS_V1_FAMILY_ADAPTER_ID);
  assert.deepEqual(
    [...entry.supportsMediaSlots],
    [...GEMINI_IMAGE_INTERACTIONS_V1_SUPPORTED_MEDIA_SLOTS],
    '注册表能力事实必须与本族模板导出同值',
  );
  assert.deepEqual([...entry.supportsMediaSlots], ['reference_image'], '本族模板只能表达参考图素材位');
  assert.deepEqual([...entry.declaredEndpointKeys], ['interactions']);

  // 素材位守卫：参考图放行，其余词表位拒绝（模板表达不了）
  assert.equal(checkFamilyMediaSlotSupport('gemini-image-interactions-v1', ['reference_image']).kind, 'ok');
  assert.equal(checkFamilyMediaSlotSupport('gemini-image-interactions-v1', ['first_frame']).kind, 'unsupported');

  // 参数描述：素材位字段不可覆盖、不进编辑器；wire 键与请求体同源
  const descriptor = buildGeminiImageInteractionsV1ParameterDescriptor();
  assert.equal(descriptor.family_adapter_id, 'gemini-image-interactions-v1');
  assert.deepEqual(
    descriptor.official_fields.map((field) => field.field_key),
    ['aspectRatio', 'imageSize', 'mimeType'],
    '参考图是模型自带的素材输入，不出现在参数编辑器里',
  );
  assert.deepEqual(
    descriptor.official_fields.map((field) => field.wire_name),
    ['aspectRatio', 'imageSize', 'mimeType'],
  );
  // 保留键取请求体里的协议键（body.* 的 wire 名）：三个参数都在 response_format 内部承载，
  // 它们的 wire 键是 response_format 而不是各自的字段名。
  for (const reserved of ['model', 'input', 'response_format', 'prompt']) {
    assert.ok(
      descriptor.reserved_wire_names.includes(reserved),
      `保留键 ${reserved} 必须被声明，否则用户自定义参数可能与协议键撞名`,
    );
  }

  // 7 族键集不变；本族已就绪，veo 也已就绪，剩余 pending 只可能落在还没实现的可灵三族里
  // （不钉「恰是哪几族」：可灵三族由并行批次逐个转 ready，钉死清单会与那条批次互相踩）。
  assert.equal(Object.keys(GENERATION_FAMILY_TEMPLATE_REGISTRY).length, GENERATION_FAMILY_ADAPTER_IDS.length);
  const pendingIds = GENERATION_FAMILY_ADAPTER_IDS.filter(
    (id: GenerationFamilyAdapterId) => GENERATION_FAMILY_TEMPLATE_REGISTRY[id].status === 'pending',
  );
  const KLING_FAMILY_ADAPTER_IDS: readonly GenerationFamilyAdapterId[] = [
    'kling-text2video-v1',
    'kling-image2video-v1',
    'kling-omni-video-v1',
  ];
  assert.deepEqual(
    pendingIds.filter((id) => !KLING_FAMILY_ADAPTER_IDS.includes(id)),
    [],
    'openai-image / gemini-image / seedance / veo 之外的 pending 只应是可灵三族',
  );
  assert.equal(GENERATION_FAMILY_TEMPLATE_REGISTRY['veo-v1'].status, 'ready', 'veo 族已就绪');
});

void test('gemini 族模板：记录级参数覆盖可把尺寸档收窄到 1K（lite 型号的用法）', () => {
  const built = buildFamilyTemplateSources('gemini-image-interactions-v1', 'declared-gemini-lite', {
    acceptedMediaSlots: [],
    parameterOverrides: {
      official: [{ field_key: 'imageSize', enum_options: ['1K'] }],
      custom: [],
    },
  });
  assert.equal(built.kind, 'ready');
  if (built.kind !== 'ready') return;
  const fields = parameterFieldsOf(built.sources);
  const imageSizeField = fields.find((field) => field['field_key'] === 'imageSize');
  assert.ok(imageSizeField);
  assert.deepEqual(imageSizeField['enum_options'], [{ value: '1K' }]);
  // 收窄后的合成投影仍然合法（这一路是「族模板取通用形态」的兜底通道）
  assert.doesNotThrow(() =>
    buildProjectionFromPackageSources({
      packageId: declaredGenerationPackageId(GEMINI_IMAGE_INTERACTIONS_V1_FAMILY_ADAPTER_ID),
      entryModelModelId: 'declared-gemini-lite',
      protocolFormat: undefined,
      runtimeModel: built.sources.runtimeModel,
      node: built.sources.node,
      localizationResources: built.sources.localizationResources,
    }),
  );
});
