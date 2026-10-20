import assert from 'node:assert/strict';
import test from 'node:test';

import { ADAPTER_REGISTRY, type GenerationMediaSlotId } from '@iart/contracts';
import type { GenerationFamilyTemplateSources } from '../generation-family-templates.cts';
import {
  KLING_TEXT2VIDEO_V1_FAMILY_ADAPTER_ID,
  KLING_TEXT2VIDEO_V1_SUPPORTED_MEDIA_SLOTS,
  buildKlingText2VideoV1BaseTemplateSources,
  buildKlingText2VideoV1ParameterDescriptor,
} from '../generation-family-templates.kling-text2video.cts';
import {
  KLING_IMAGE2VIDEO_V1_FAMILY_ADAPTER_ID,
  KLING_IMAGE2VIDEO_V1_SUPPORTED_MEDIA_SLOTS,
  buildKlingImage2VideoV1BaseTemplateSources,
  buildKlingImage2VideoV1ParameterDescriptor,
} from '../generation-family-templates.kling-image2video.cts';
import {
  KLING_OMNI_VIDEO_V1_FAMILY_ADAPTER_ID,
  KLING_OMNI_VIDEO_V1_SUPPORTED_MEDIA_SLOTS,
  buildKlingOmniVideoV1BaseTemplateSources,
  buildKlingOmniVideoV1ParameterDescriptor,
} from '../generation-family-templates.kling-omni-video.cts';
import { buildProjectionFromPackageSources } from '../model-package-catalog.projection.cts';
import { isObjectRecord } from '../model-package-catalog.shared.cts';
import { declaredGenerationPackageId } from '../generation-family-templates.cts';
import {
  GENERATION_FAMILY_TEMPLATE_REGISTRY,
  buildFamilyTemplateSources,
} from '../generation-family-templates.registry.cts';
import { evaluateRule } from '../request-assembler-runtime.cts';
import { extractMappedTaskOutputs } from '../task-result-output-mapping.cts';

/**
 * 可灵三族模板（文生视频 / 图生视频 / 全模态视频，可灵官方新设计标准，异步 + 统一查询端点）。
 *
 * 三族放在同一个测试文件，因为它们的协议不变部分**必须**逐字段一致——分成三份反而让「漂移」
 * 看起来像三份各自独立的事实。钉五件事：
 * ① 三族注册条目已就绪，能力事实与适配器 endpoint 键同源；
 * ② 每族模板都能构建**合法** sources 并通过与已装包相同的 `buildProjectionFromPackageSources`
 *   投影路径（本地化校验、字段键引用校验、媒体目标校验一并跑过）；
 * ③ 三族轮询策略 / 结果规则 / 结果映射**逐字段**一致（实测三包相同），且结果映射能从真实
 *   查询响应解析出 `output.video_url`；
 * ④ 素材位驱动：只勾哪几位就只生成哪几位的表单字段、输入端口与 contents 分支；文生视频族
 *   确实一个素材位字段都没有；
 * ⑤ 图生视频族首帧**必填**的处置生效（表单 required + required_fields + 组装期
 *   assert_non_empty 三条同时成立）。
 *
 * 本族模板自包含：测试只读内存态 sources，不读任何磁盘资产。
 */

const MODEL_ID = 'declared-kling-video-test';

/** 族模板构建器签名（三族同形，测试按同一张表遍历）。 */
type FamilyBuilder = (
  modelId: string,
  options: { acceptedMediaSlots: readonly GenerationMediaSlotId[] },
) => GenerationFamilyTemplateSources;

/** 取模板 runtime 段（模板由本仓构建，形状受控；仍按 unknown 收窄不用断言）。 */
const runtimeOf = (sources: GenerationFamilyTemplateSources): Record<string, unknown> => {
  const runtime: unknown = sources.runtimeModel.runtime;
  assert.ok(isObjectRecord(runtime) && !Array.isArray(runtime), 'template runtime must be an object');
  return runtime;
};

/** 取 payload_rules（投影前的模板原始规则）。 */
const payloadRulesOf = (sources: GenerationFamilyTemplateSources): Record<string, unknown> => {
  const rules = runtimeOf(sources)['payload_rules'];
  assert.ok(isObjectRecord(rules) && !Array.isArray(rules), 'template must carry payload_rules');
  return rules;
};

/** 取 runtime_model 上的某个顶层对象（result_rule / polling_strategy / result_output_mapping）。 */
const objectOf = (sources: GenerationFamilyTemplateSources, key: string): Record<string, unknown> => {
  const value = sources.runtimeModel[key];
  assert.ok(isObjectRecord(value) && !Array.isArray(value), `template must carry ${key}`);
  return value;
};

/** 取参数表单字段列表。 */
const parameterFieldsOf = (sources: GenerationFamilyTemplateSources): Record<string, unknown>[] => {
  const schema = objectOf(sources, 'parameter_schema');
  const fields = schema['fields'];
  assert.ok(Array.isArray(fields), 'parameter_schema.fields must be an array');
  return fields.map((field) => {
    assert.ok(isObjectRecord(field) && !Array.isArray(field), 'parameter field must be an object');
    return field;
  });
};

/** 取参数表单必填清单。 */
const requiredFieldsOf = (sources: GenerationFamilyTemplateSources): unknown[] => {
  const schema = objectOf(sources, 'parameter_schema');
  const required = schema['required_fields'];
  assert.ok(Array.isArray(required), 'parameter_schema.required_fields must be an array');
  return required;
};

/** 参数表单里某个字段（缺失即测试失败，返回收窄后的对象）。 */
const fieldOf = (sources: GenerationFamilyTemplateSources, fieldKey: string): Record<string, unknown> => {
  const found = parameterFieldsOf(sources).find((field) => field['field_key'] === fieldKey);
  assert.ok(found, `parameter field ${fieldKey} must exist`);
  return found;
};

/** 枚举字段的取值清单。 */
const enumValuesOf = (field: Record<string, unknown>): unknown[] => {
  const options = field['enum_options'];
  assert.ok(Array.isArray(options), 'enum_options must be an array');
  return options.map((option) => (isObjectRecord(option) ? option['value'] : undefined));
};

/** 输入端口清单（node_definition.input_ports）。 */
const inputPortsOf = (sources: GenerationFamilyTemplateSources): Record<string, unknown>[] => {
  const ports: unknown = sources.node['input_ports'];
  assert.ok(Array.isArray(ports), 'node.input_ports must be an array');
  return ports.map((port) => {
    assert.ok(isObjectRecord(port) && !Array.isArray(port), 'input port must be an object');
    return port;
  });
};

/** capability 段。 */
const capabilityOf = (sources: GenerationFamilyTemplateSources): Record<string, unknown> => {
  const capability: unknown = sources.runtimeModel['capability'];
  assert.ok(isObjectRecord(capability) && !Array.isArray(capability), 'template must carry capability');
  return capability;
};

/** 素材位字段键（测试侧独立期望，不复用模板常量以免同错同过）。 */
const expectedFieldKeyOfSlot = (slot: GenerationMediaSlotId): string => {
  switch (slot) {
    case 'first_frame':
      return 'firstFrameImage';
    case 'last_frame':
      return 'lastFrameImage';
    case 'reference_image':
      return 'referImage';
    case 'feature_video':
      return 'featureVideo';
    case 'base_video':
      return 'baseVideo';
    default:
      throw new Error(`可灵族模板不表达素材位 ${slot}（测试期望表未覆盖 = 模板越界扩位）`);
  }
};

/** 三族各自的素材位形态（空形态 + 各位单独 + 全开，覆盖条件分支两侧）。 */
const TEXT_SHAPES: ReadonlyArray<readonly GenerationMediaSlotId[]> = [[]];
const IMAGE_SHAPES: ReadonlyArray<readonly GenerationMediaSlotId[]> = [
  [],
  ['first_frame'],
  ['first_frame', 'last_frame'],
  ['last_frame'],
];
const OMNI_SHAPES: ReadonlyArray<readonly GenerationMediaSlotId[]> = [
  [],
  ['first_frame'],
  ['first_frame', 'last_frame'],
  ['reference_image'],
  ['feature_video'],
  ['base_video'],
  ['first_frame', 'last_frame', 'reference_image', 'feature_video', 'base_video'],
];

const isUnknownArray = (value: unknown): value is unknown[] => Array.isArray(value);

/** 把模板 sources 走一遍真实投影路径（失败即抛，测试据此判红）。 */
const projectTemplate = (familyAdapterId: string, sources: GenerationFamilyTemplateSources) =>
  buildProjectionFromPackageSources({
    packageId: declaredGenerationPackageId(
      familyAdapterId as Parameters<typeof declaredGenerationPackageId>[0],
    ),
    entryModelModelId: MODEL_ID,
    protocolFormat: undefined,
    runtimeModel: sources.runtimeModel,
    node: sources.node,
    localizationResources: sources.localizationResources,
  });

/** 在真实求值器下求一条 payload 规则。 */
const evaluateRuleValue = async (
  rule: unknown,
  fields: Record<string, unknown>,
): Promise<unknown> =>
  evaluateRule(rule, {
    fields,
    runtime: {},
    projection: {},
    currentItem: undefined,
    projectPath: null,
  }, {
    uploadOptions: undefined,
    item: undefined,
    targetPath: undefined,
    preRequestOutputs: undefined,
  });

/** contents 条目的 type（文本条目为 'prompt'）。 */
const typeOfEntry = (entry: unknown): unknown => (isObjectRecord(entry) ? entry['type'] : null);

void test('可灵三族：注册条目已就绪，能力事实与适配器 endpoint 键同源', () => {
  const expectations: ReadonlyArray<{
    familyAdapterId: string;
    slots: readonly GenerationMediaSlotId[];
    endpointKeys: readonly string[];
    endpointPath: string;
  }> = [
    {
      familyAdapterId: KLING_TEXT2VIDEO_V1_FAMILY_ADAPTER_ID,
      slots: [],
      endpointKeys: ['textToVideo', 'taskById'],
      endpointPath: '/text-to-video/kling-3.0',
    },
    {
      familyAdapterId: KLING_IMAGE2VIDEO_V1_FAMILY_ADAPTER_ID,
      slots: ['first_frame', 'last_frame'],
      endpointKeys: ['imageToVideo', 'taskById'],
      endpointPath: '/image-to-video/kling-3.0',
    },
    {
      familyAdapterId: KLING_OMNI_VIDEO_V1_FAMILY_ADAPTER_ID,
      slots: ['first_frame', 'last_frame', 'reference_image', 'feature_video', 'base_video'],
      endpointKeys: ['omniVideo', 'taskById'],
      endpointPath: '/omni-video/kling-3.0-omni',
    },
  ];

  for (const expectation of expectations) {
    const entry = GENERATION_FAMILY_TEMPLATE_REGISTRY[
      expectation.familyAdapterId as keyof typeof GENERATION_FAMILY_TEMPLATE_REGISTRY
    ];
    assert.equal(entry.status, 'ready', `${expectation.familyAdapterId} 必须已就绪`);
    assert.deepEqual(
      [...entry.supportsMediaSlots],
      [...expectation.slots],
      `${expectation.familyAdapterId} 的素材位事实`,
    );
    assert.deepEqual(
      [...entry.declaredEndpointKeys],
      [...expectation.endpointKeys],
      `${expectation.familyAdapterId} 用到提交端点与统一查询端点两个 key`,
    );

    // 适配器侧路径是事实源，模板字面量必须逐字相同（一致性门禁也会逐条核对）
    const adapter = ADAPTER_REGISTRY[expectation.familyAdapterId as keyof typeof ADAPTER_REGISTRY];
    assert.ok(adapter, `${expectation.familyAdapterId} 必须在 ADAPTER_REGISTRY 中登记`);
    const endpoints = adapter.relative_endpoints ?? {};
    const submitKey = expectation.endpointKeys[0] as string;
    assert.equal(endpoints[submitKey], expectation.endpointPath, '提交端点必须等于适配器声明');
    assert.equal(endpoints['taskById'], '/tasks?task_ids={id}', '统一查询端点必须等于适配器声明');
  }

  // 三族文件导出的支持清单与注册表条目同源（两处漂移即红）
  assert.deepEqual(
    [...GENERATION_FAMILY_TEMPLATE_REGISTRY['kling-text2video-v1'].supportsMediaSlots],
    [...KLING_TEXT2VIDEO_V1_SUPPORTED_MEDIA_SLOTS],
  );
  assert.deepEqual(
    [...GENERATION_FAMILY_TEMPLATE_REGISTRY['kling-image2video-v1'].supportsMediaSlots],
    [...KLING_IMAGE2VIDEO_V1_SUPPORTED_MEDIA_SLOTS],
  );
  assert.deepEqual(
    [...GENERATION_FAMILY_TEMPLATE_REGISTRY['kling-omni-video-v1'].supportsMediaSlots],
    [...KLING_OMNI_VIDEO_V1_SUPPORTED_MEDIA_SLOTS],
  );
});

void test('可灵三族：各种素材位形态都构建出合法 sources 并走通合成投影路径', () => {
  const cases: ReadonlyArray<{
    familyAdapterId: string;
    shapes: ReadonlyArray<readonly GenerationMediaSlotId[]>;
    build: FamilyBuilder;
  }> = [
    {
      familyAdapterId: KLING_TEXT2VIDEO_V1_FAMILY_ADAPTER_ID,
      shapes: TEXT_SHAPES,
      build: buildKlingText2VideoV1BaseTemplateSources,
    },
    {
      familyAdapterId: KLING_IMAGE2VIDEO_V1_FAMILY_ADAPTER_ID,
      shapes: IMAGE_SHAPES,
      build: buildKlingImage2VideoV1BaseTemplateSources,
    },
    {
      familyAdapterId: KLING_OMNI_VIDEO_V1_FAMILY_ADAPTER_ID,
      shapes: OMNI_SHAPES,
      build: buildKlingOmniVideoV1BaseTemplateSources,
    },
  ];

  for (const item of cases) {
    for (const shape of item.shapes) {
      const sources = item.build(MODEL_ID, { acceptedMediaSlots: shape });
      const { projection, localizationBundle } = projectTemplate(item.familyAdapterId, sources);
      assert.equal(projection.model_id, MODEL_ID);
      assert.equal(projection.role, 'generator');
      assert.deepEqual(projection.capability.output_modalities, ['video']);
      assert.equal(projection.capability.supports_async_task, true);
      assert.deepEqual(projection.ports.outputs.map((port) => port.id), ['video']);
      assert.equal(
        localizationBundle.namespace,
        `model-asset/${declaredGenerationPackageId(
          item.familyAdapterId as Parameters<typeof declaredGenerationPackageId>[0],
        )}`,
      );
      // 标签必须走本地化命名空间键（投影处不硬编码文案）
      assert.ok(
        projection.parameter_schema.fields.every((field) => field.label.startsWith('model-asset/')),
        '字段标签必须是命名空间本地化键',
      );
      // 输入端口与勾选的素材位严格一一对应（不多不少）
      assert.deepEqual(
        projection.ports.inputs.map((port) => port.field_key),
        shape.map(expectedFieldKeyOfSlot),
        `${item.familyAdapterId} 形态 ${JSON.stringify(shape)} 的输入端口必须只来自勾选的素材位`,
      );
    }
  }
});

void test('可灵三族：异步轮询策略 / 结果规则 / 结果映射逐字段一致（实测三包相同）', () => {
  const builders: ReadonlyArray<{ familyAdapterId: string; build: FamilyBuilder }> = [
    { familyAdapterId: KLING_TEXT2VIDEO_V1_FAMILY_ADAPTER_ID, build: buildKlingText2VideoV1BaseTemplateSources },
    { familyAdapterId: KLING_IMAGE2VIDEO_V1_FAMILY_ADAPTER_ID, build: buildKlingImage2VideoV1BaseTemplateSources },
    { familyAdapterId: KLING_OMNI_VIDEO_V1_FAMILY_ADAPTER_ID, build: buildKlingOmniVideoV1BaseTemplateSources },
  ];

  for (const item of builders) {
    const sources = item.build(MODEL_ID, { acceptedMediaSlots: [] });
    const strategy = objectOf(sources, 'polling_strategy');

    assert.deepEqual(strategy['request'], {
      url_template: '/tasks?task_ids={id}',
      method: 'GET',
      headers: {},
      body: null,
    }, `${item.familyAdapterId} 的轮询请求形态`);

    assert.deepEqual(strategy['polling'], {
      intervalMs: 3000,
      maxAttempts: 500,
      successFieldPaths: ['data.0.outputs.0.url', 'data.0.status'],
      successStatuses: ['succeeded'],
      statusFieldPaths: ['data.0.status', 'data.status', 'status'],
      failureStatuses: ['failed', 'failure', 'error'],
      // 可灵失败码没有独立路径（实测三包皆为空数组），不臆造 code 路径
      failureCodePaths: [],
      failureMessagePaths: ['data.0.message', 'data.message', 'message'],
    }, `${item.familyAdapterId} 的轮询策略`);

    assert.deepEqual(objectOf(sources, 'result_rule'), {
      mode: 'async',
      submit_response_id_path: '/data/id',
    }, `${item.familyAdapterId} 的异步结果规则`);

    assert.deepEqual(objectOf(sources, 'result_output_mapping'), {
      response_mode: 'structured_payload',
      output_mapping_rules: [
        {
          target: 'output.video_url',
          source: { kind: 'response', path: 'data[].outputs[].url' },
          required: false,
          default_value: null,
        },
      ],
      note: '可灵新标准统一查询端点 GET /tasks?task_ids={id}；响应 data[] → outputs[] 取 url（spec 07 §9.2）',
    }, `${item.familyAdapterId} 的结果映射`);

    // 异步响应处理声明：编辑器据此把响应当任务（三族同值）
    assert.deepEqual(payloadRulesOf(sources)['api.responseHandling.mode'], { kind: 'literal', value: 'async' });
  }
});

void test('可灵三族：结果映射能从真实查询响应解析出 output.video_url', () => {
  const sources = buildKlingOmniVideoV1BaseTemplateSources(MODEL_ID, { acceptedMediaSlots: [] });
  const mapping = objectOf(sources, 'result_output_mapping');

  // 单任务查询响应（官方 §9 结构：data 数组 → outputs 数组 → url）
  const outputs = extractMappedTaskOutputs({
    taskRecord: { metadata: { taskExecutionPlan: { result_output_mapping: mapping } } },
    responseBody: {
      code: 0,
      message: 'success',
      data: [
        {
          id: 'task-kling-1',
          status: 'succeeded',
          outputs: [
            { type: 'video', url: 'https://media.example.invalid/kling-out.mp4', duration: 5 },
          ],
        },
      ],
    },
  });
  assert.deepEqual(
    outputs.map((output) => ({ mediaType: output.mediaType, url: output.url })),
    [{ mediaType: 'video', url: 'https://media.example.invalid/kling-out.mp4' }],
    'data[].outputs[].url 必须被解析成 video 输出',
  );

  // 批量查询：data 数组逐个展开
  const batchOutputs = extractMappedTaskOutputs({
    taskRecord: { metadata: { taskExecutionPlan: { result_output_mapping: mapping } } },
    responseBody: {
      data: [
        { id: 'a', status: 'succeeded', outputs: [{ url: 'https://media.example.invalid/a.mp4' }] },
        { id: 'b', status: 'succeeded', outputs: [{ url: 'https://media.example.invalid/b.mp4' }] },
      ],
    },
  });
  assert.deepEqual(batchOutputs.map((output) => output.url), [
    'https://media.example.invalid/a.mp4',
    'https://media.example.invalid/b.mp4',
  ]);

  // 还没产出地址时（只有状态）不得产出空输出
  const pendingOutputs = extractMappedTaskOutputs({
    taskRecord: { metadata: { taskExecutionPlan: { result_output_mapping: mapping } } },
    responseBody: { data: [{ id: 'c', status: 'processing', outputs: [] }] },
  });
  assert.deepEqual(pendingOutputs, [], '尚无输出地址时不产出媒体输出');
});

void test('可灵文生视频族：确实没有任何素材位字段、端口与素材分支', () => {
  // 越界传入素材位也不得造出字段（本族零素材位）
  const sources = buildKlingText2VideoV1BaseTemplateSources(MODEL_ID, {
    acceptedMediaSlots: ['first_frame'],
  });

  assert.deepEqual(
    parameterFieldsOf(sources).map((field) => field['field_key']),
    ['duration', 'resolution', 'aspectRatio', 'audio', 'multiShot', 'watermark'],
    '文生视频族只有生成参数，零素材位字段',
  );
  const mediaComponents = parameterFieldsOf(sources)
    .map((field) => field['component'])
    .filter((component) => component === 'imageUpload' || component === 'file');
  assert.deepEqual(mediaComponents, [], '不得出现任何媒体上传组件');

  assert.deepEqual(inputPortsOf(sources), [], '文生视频族没有输入端口');

  const rules = payloadRulesOf(sources);
  assert.equal('body.contents' in rules, false, '官方文生视频没有 contents 数组');
  const serialized = JSON.stringify(rules);
  assert.equal(serialized.includes('media_target'), false, '没有任何媒体目标');
  assert.equal(serialized.includes('first_frame'), false);
  assert.equal(serialized.includes('last_frame'), false);

  // 无媒体目标 → 不得声明公网中转（声明即坏包 url_input_upload_mode_without_public_url_target）
  const runtime = runtimeOf(sources);
  assert.equal(runtime['url_input_upload_mode'], undefined);
  assert.equal(runtime['url_input_upload_target_type'], undefined);

  // 能力事实：纯文本输入
  const capability = capabilityOf(sources);
  assert.deepEqual(capability['input_modalities'], ['text']);
  assert.equal(capability['supports_multi_image'], false);
  assert.equal(capability['supports_reference_media'], false);
});

void test('可灵文生视频族：请求体是顶层 prompt + settings（含 aspect_ratio），无 model 字段与 {model} 占位符', async () => {
  const sources = buildKlingText2VideoV1BaseTemplateSources(MODEL_ID, { acceptedMediaSlots: [] });
  const rules = payloadRulesOf(sources);

  assert.deepEqual(rules['api.endpoint'], { kind: 'literal', value: '/text-to-video/kling-3.0' });
  assert.equal('body.model' in rules, false, '可灵新标准请求体没有模型字段');
  assert.equal(
    JSON.stringify(sources.runtimeModel).includes('{model}'),
    false,
    '模板不得制造 {model} 占位符（模型版本写死在 path 段）',
  );
  assert.equal('body.contents' in rules, false, '文生视频用顶层 prompt，不是 contents 数组');

  // settings 含 aspect_ratio（图生视频没有该字段——三端点的实质差异）
  const settingsKeys = Object.keys(rules).filter((key) => key.startsWith('body.settings.'));
  assert.deepEqual(settingsKeys.sort(), [
    'body.settings.aspect_ratio',
    'body.settings.audio',
    'body.settings.duration',
    'body.settings.multi_shot',
    'body.settings.resolution',
  ]);

  // prompt 非空断言在真实求值器下生效
  await assert.rejects(
    () => evaluateRuleValue(rules['body.prompt'], { __prompt: '   ' }),
    /请填写提示词/,
  );
  assert.equal(await evaluateRuleValue(rules['body.prompt'], { __prompt: '  a cat  ' }), 'a cat');

  // 枚举收敛：非法档位回落到默认值（与表单枚举同源）
  assert.equal(await evaluateRuleValue(rules['body.settings.resolution'], { resolution: 'huge' }), '720p');
  assert.equal(await evaluateRuleValue(rules['body.settings.duration'], { duration: '9' }), 9);
  assert.equal(await evaluateRuleValue(rules['body.settings.aspect_ratio'], { aspectRatio: '9:16' }), '9:16');

  assert.deepEqual(enumValuesOf(fieldOf(sources, 'aspectRatio')), ['16:9', '9:16', '1:1']);
  assert.deepEqual(enumValuesOf(fieldOf(sources, 'resolution')), ['720p', '1080p', '4k']);
  assert.deepEqual(enumValuesOf(fieldOf(sources, 'audio')), ['native', 'off']);
  assert.equal(fieldOf(sources, 'duration')['default_value'], 5);
  assert.equal(fieldOf(sources, 'multiShot')['component'], 'switch');
  assert.equal(fieldOf(sources, 'multiShot')['default_value'], true);
  assert.equal(fieldOf(sources, 'watermark')['default_value'], false);
});

void test('可灵图生视频族：素材位驱动 + 首帧必填（表单 required / required_fields / 组装期断言三条同时生效）', async () => {
  // ① 两位都勾：首帧必填、尾帧可选，端口 required 与字段同源
  const both = buildKlingImage2VideoV1BaseTemplateSources(MODEL_ID, {
    acceptedMediaSlots: ['first_frame', 'last_frame'],
  });
  assert.equal(fieldOf(both, 'firstFrameImage')['required'], true, '首帧字段必须 required:true');
  assert.equal(fieldOf(both, 'lastFrameImage')['required'], false);
  assert.deepEqual(requiredFieldsOf(both), ['firstFrameImage'], '首帧必须进 required_fields');
  assert.deepEqual(
    inputPortsOf(both).map((port) => ({
      field_key: port['field_key'],
      data_type: port['data_type'],
      required: port['required'],
    })),
    [
      { field_key: 'firstFrameImage', data_type: 'image', required: true },
      { field_key: 'lastFrameImage', data_type: 'image', required: false },
    ],
    '端口必填性与字段必填性同源',
  );

  // ② 图生视频 settings 没有 aspect_ratio（官方字段表只列四项）
  const rules = payloadRulesOf(both);
  const settingsKeys = Object.keys(rules).filter((key) => key.startsWith('body.settings.'));
  assert.deepEqual(settingsKeys.sort(), [
    'body.settings.audio',
    'body.settings.duration',
    'body.settings.multi_shot',
    'body.settings.resolution',
  ], '图生视频不得生成 aspect_ratio');
  assert.equal(
    parameterFieldsOf(both).some((field) => field['field_key'] === 'aspectRatio'),
    false,
    '图生视频不得出现 aspectRatio 表单字段',
  );

  // ③ contents 组装：文本 + 首帧（恒有）+ 尾帧（条件）
  const contentsRule = rules['body.contents'];
  const contents = await evaluateRuleValue(contentsRule, {
    __prompt: '  cat  ',
    firstFrameImage: ['https://media.example.invalid/f.png'],
    lastFrameImage: ['https://media.example.invalid/l.png'],
  });
  assert.ok(isUnknownArray(contents));
  assert.deepEqual(contents.map(typeOfEntry), ['prompt', 'first_frame', 'last_frame']);
  assert.equal(
    isObjectRecord(contents[0]) ? contents[0]['text'] : null,
    'cat',
    '提示词必须 trim 后进 contents',
  );

  // 未填尾帧：不得产出没有 url 的空壳 last_frame 条目
  const firstOnly = await evaluateRuleValue(contentsRule, {
    __prompt: 'cat',
    firstFrameImage: ['https://media.example.invalid/f.png'],
    lastFrameImage: [],
  });
  assert.ok(isUnknownArray(firstOnly));
  assert.deepEqual(firstOnly.map(typeOfEntry), ['prompt', 'first_frame']);

  // 首帧为空：组装期拒绝（不发一个注定被上游拒的请求）
  await assert.rejects(
    () => evaluateRuleValue(contentsRule, { __prompt: 'cat', firstFrameImage: [], lastFrameImage: [] }),
    /请上传首帧图/,
  );

  // ④ 只勾首帧：不生成尾帧字段/端口/分支，且首帧仍必填
  const firstOnlyShape = buildKlingImage2VideoV1BaseTemplateSources(MODEL_ID, {
    acceptedMediaSlots: ['first_frame'],
  });
  assert.equal(
    parameterFieldsOf(firstOnlyShape).some((field) => field['field_key'] === 'lastFrameImage'),
    false,
  );
  assert.deepEqual(requiredFieldsOf(firstOnlyShape), ['firstFrameImage']);
  assert.deepEqual(inputPortsOf(firstOnlyShape).map((port) => port['field_key']), ['firstFrameImage']);

  // ⑤ 一位都不勾：首帧字段不存在，required_fields 不得指向不存在的字段
  const none = buildKlingImage2VideoV1BaseTemplateSources(MODEL_ID, { acceptedMediaSlots: [] });
  assert.deepEqual(requiredFieldsOf(none), [], '未勾首帧位时不得声明必填字段（字段不存在）');
  assert.equal(
    parameterFieldsOf(none).some((field) => field['field_key'] === 'firstFrameImage'),
    false,
  );
  assert.deepEqual(inputPortsOf(none), []);

  // ⑥ 公网中转：本族媒体只有图像 → 用只服务图像的自建图床 target
  const runtime = runtimeOf(both);
  assert.equal(runtime['url_input_upload_mode'], 'public_relay');
  assert.equal(
    runtime['url_input_upload_target_type'],
    'self_hosted_image_public_url',
    '本族只有图像素材，符合 self_hosted 图床的能力边界',
  );
});

void test('可灵全模态族：五个素材位逐位驱动，contents 按官方 type 组装', async () => {
  const all = buildKlingOmniVideoV1BaseTemplateSources(MODEL_ID, {
    acceptedMediaSlots: ['first_frame', 'last_frame', 'reference_image', 'feature_video', 'base_video'],
  });
  const mediaFields = parameterFieldsOf(all).filter(
    (field) => field['component'] === 'imageUpload' || field['component'] === 'file',
  );
  assert.deepEqual(
    mediaFields.map((field) => ({ field_key: field['field_key'], component: field['component'] })),
    [
      { field_key: 'firstFrameImage', component: 'imageUpload' },
      { field_key: 'lastFrameImage', component: 'imageUpload' },
      { field_key: 'referImage', component: 'imageUpload' },
      { field_key: 'featureVideo', component: 'file' },
      { field_key: 'baseVideo', component: 'file' },
    ],
    '五个素材位逐位生成字段（视频位用 file 组件）',
  );
  // 本族没有必填素材位
  assert.deepEqual(requiredFieldsOf(all), []);
  assert.ok(mediaFields.every((field) => field['required'] === false));

  // 视频位端口 data_type = video（file 组件不参与推导，逐位显式声明）
  assert.deepEqual(
    inputPortsOf(all).map((port) => `${String(port['field_key'])}:${String(port['data_type'])}`),
    [
      'firstFrameImage:image',
      'lastFrameImage:image',
      'referImage:image',
      'featureVideo:video',
      'baseVideo:video',
    ],
  );

  // settings 含 aspect_ratio，audio 多一档 original
  const rules = payloadRulesOf(all);
  assert.ok('body.settings.aspect_ratio' in rules, '全模态 settings 含 aspect_ratio');
  assert.deepEqual(
    enumValuesOf(fieldOf(all, 'audio')),
    ['native', 'original', 'off'],
    '全模态 audio 比另两族多 original 档',
  );
  assert.equal(await evaluateRuleValue(rules['body.settings.audio'], { audio: 'original' }), 'original');
  assert.equal(await evaluateRuleValue(rules['body.settings.audio'], { audio: 'nope' }), 'off');

  // contents 组装：文本 + 五条按官方 type
  const contents = await evaluateRuleValue(rules['body.contents'], {
    __prompt: 'cat',
    firstFrameImage: ['https://media.example.invalid/f.png'],
    lastFrameImage: ['https://media.example.invalid/l.png'],
    referImage: ['https://media.example.invalid/r.png'],
    featureVideo: ['https://media.example.invalid/fv.mp4'],
    baseVideo: ['https://media.example.invalid/bv.mp4'],
  });
  assert.ok(isUnknownArray(contents));
  assert.deepEqual(contents.map(typeOfEntry), [
    'prompt',
    'first_frame',
    'last_frame',
    'refer_image',
    'feature_video',
    'base_video',
  ]);

  // 只填参考图：其余分支不产出
  const partial = await evaluateRuleValue(rules['body.contents'], {
    __prompt: 'cat',
    referImage: ['https://media.example.invalid/r.png'],
  });
  assert.ok(isUnknownArray(partial));
  assert.deepEqual(partial.map(typeOfEntry), ['prompt', 'refer_image']);

  // 公网中转：含视频素材 → 必须用通用文件中转目标
  const runtime = runtimeOf(all);
  assert.equal(runtime['url_input_upload_mode'], 'public_relay');
  assert.equal(
    runtime['url_input_upload_target_type'],
    'cloudflare_image_public_url',
    '含视频素材的族不得使用只服务图像的 self_hosted_image_public_url',
  );

  // 能力事实
  assert.deepEqual(capabilityOf(all)['input_modalities'], ['text', 'image', 'video']);
});

void test('可灵三族：不带素材位时不声明公网中转（否则判坏包），带素材位时才声明', () => {
  const cases: ReadonlyArray<{
    familyAdapterId: string;
    build: FamilyBuilder;
    slot: GenerationMediaSlotId;
    targetType: string;
  }> = [
    {
      familyAdapterId: KLING_IMAGE2VIDEO_V1_FAMILY_ADAPTER_ID,
      build: buildKlingImage2VideoV1BaseTemplateSources,
      slot: 'first_frame',
      targetType: 'self_hosted_image_public_url',
    },
    {
      familyAdapterId: KLING_OMNI_VIDEO_V1_FAMILY_ADAPTER_ID,
      build: buildKlingOmniVideoV1BaseTemplateSources,
      slot: 'feature_video',
      targetType: 'cloudflare_image_public_url',
    },
  ];
  for (const item of cases) {
    const emptyRuntime = runtimeOf(item.build(MODEL_ID, { acceptedMediaSlots: [] }));
    assert.equal(
      emptyRuntime['url_input_upload_mode'],
      undefined,
      `${item.familyAdapterId} 无素材位时不得声明中转`,
    );
    assert.equal(emptyRuntime['url_input_upload_target_type'], undefined);

    const slotRuntime = runtimeOf(item.build(MODEL_ID, { acceptedMediaSlots: [item.slot] }));
    assert.equal(slotRuntime['url_input_upload_mode'], 'public_relay');
    assert.equal(slotRuntime['url_input_upload_target_type'], item.targetType);
  }
});

void test('可灵三族：参数描述端点数据（素材位不进官方参数区，协议键进保留键）', () => {
  const cases: ReadonlyArray<{
    familyAdapterId: string;
    descriptor: ReturnType<typeof buildKlingText2VideoV1ParameterDescriptor>;
    officialFieldKeys: readonly string[];
    reserved: readonly string[];
  }> = [
    {
      familyAdapterId: KLING_TEXT2VIDEO_V1_FAMILY_ADAPTER_ID,
      descriptor: buildKlingText2VideoV1ParameterDescriptor(),
      officialFieldKeys: ['duration', 'resolution', 'aspectRatio', 'audio', 'multiShot', 'watermark'],
      reserved: ['prompt', 'settings', 'options'],
    },
    {
      familyAdapterId: KLING_IMAGE2VIDEO_V1_FAMILY_ADAPTER_ID,
      descriptor: buildKlingImage2VideoV1ParameterDescriptor(),
      officialFieldKeys: ['duration', 'resolution', 'audio', 'multiShot', 'watermark'],
      reserved: ['contents', 'settings', 'options', 'prompt'],
    },
    {
      familyAdapterId: KLING_OMNI_VIDEO_V1_FAMILY_ADAPTER_ID,
      descriptor: buildKlingOmniVideoV1ParameterDescriptor(),
      officialFieldKeys: ['duration', 'resolution', 'aspectRatio', 'audio', 'multiShot', 'watermark'],
      reserved: ['contents', 'settings', 'options', 'prompt'],
    },
  ];

  for (const item of cases) {
    assert.equal(item.descriptor.family_adapter_id, item.familyAdapterId);
    assert.deepEqual(
      item.descriptor.official_fields.map((field) => field.field_key),
      [...item.officialFieldKeys],
      `${item.familyAdapterId} 的官方参数区（素材位字段不进编辑器）`,
    );
    for (const reserved of item.reserved) {
      assert.ok(
        item.descriptor.reserved_wire_names.includes(reserved),
        `${item.familyAdapterId} 的保留键必须包含 ${reserved}`,
      );
    }
    // 素材位字段不可覆盖 → 不能出现在官方参数区
    for (const field of item.descriptor.official_fields) {
      assert.equal(
        ['firstFrameImage', 'lastFrameImage', 'referImage', 'featureVideo', 'baseVideo'].includes(field.field_key),
        false,
        `${item.familyAdapterId} 的素材位字段不得出现在官方参数区`,
      );
    }
  }
});

void test('可灵文生视频族：记录级参数覆盖可收窄档位，且不破坏请求体与投影', () => {
  const built = buildFamilyTemplateSources('kling-text2video-v1', MODEL_ID, {
    acceptedMediaSlots: [],
    parameterOverrides: {
      official: [{ field_key: 'resolution', enum_options: ['720p', '1080p'] }],
      custom: [],
    },
  });
  assert.equal(built.kind, 'ready');
  if (built.kind !== 'ready') return;
  assert.deepEqual(enumValuesOf(fieldOf(built.sources, 'resolution')), ['720p', '1080p']);
  // wire 侧收敛集合仍与族模板同源（覆盖只改表单可选值，不改协议允许值）
  const resolutionRule = payloadRulesOf(built.sources)['body.settings.resolution'];
  assert.ok(isObjectRecord(resolutionRule) && !Array.isArray(resolutionRule));
  assert.deepEqual(resolutionRule['options'], { allowed_values: ['720p', '1080p', '4k'], fallback: '720p' });
  assert.doesNotThrow(() => projectTemplate('kling-text2video-v1', built.sources));
});
