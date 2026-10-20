import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ADAPTER_REGISTRY,
  type GenerationMediaSlotId,
} from '@iart/contracts';
import {
  SEEDANCE_2_0_V1_FAMILY_ADAPTER_ID,
  SEEDANCE_2_0_V1_SUPPORTED_MEDIA_SLOTS,
  buildSeedance20V1BaseTemplateSources,
  buildSeedance20V1ParameterDescriptor,
} from '../generation-family-templates.seedance.cts';
import { buildProjectionFromPackageSources } from '../model-package-catalog.projection.cts';
import { isObjectRecord } from '../model-package-catalog.shared.cts';
import { declaredGenerationPackageId } from '../generation-family-templates.cts';
import {
  GENERATION_FAMILY_TEMPLATE_REGISTRY,
  buildFamilyTemplateSources,
} from '../generation-family-templates.registry.cts';
import { validateParameterOverrides } from '../generation-parameter-overrides.cts';
import { evaluateRule } from '../request-assembler-runtime.cts';
import { extractMappedTaskOutputs } from '../task-result-output-mapping.cts';

/**
 * seedance-2-0-v1 族模板（火山方舟 Seedance 2.0 视频任务接口，异步轮询 + 公网中转）。
 *
 * 钉五件事：
 * ① 六种素材位形态（无素材 / 首帧 / 首尾帧 / 参考图 / 三路参考 / 全开）都能构建出**合法**
 *    sources 并通过与已装包相同的 `buildProjectionFromPackageSources` 投影路径（本地化校验、
 *    字段键引用校验、媒体目标校验一并跑过）；
 * ② 异步轮询策略**逐字段**与实测包一致（intervalMs / maxAttempts / successStatuses /
 *    failureStatuses / statusFieldPaths / failureCodePaths / failureMessagePaths /
 *    successFieldPaths / url_template / method / headers / body）——任一项漂移会让任务永远
 *    停在 running 或把成功当失败；
 * ③ 结果映射能真的从查询响应里解析出 `output.video_url`（喂真实响应给真实消费函数）；
 * ④ 公网中转声明存在且目标类型是通用文件中转（视频/音频不能用只服务图像的 target）；
 * ⑤ content 数组在真实求值器下的组装结果：文本块 + 素材分支按 role 正确落位，
 *    `input_mode` 不出现（由素材位推导）。
 *
 * 本族模板自包含：测试只读内存态 sources，不读任何磁盘资产。
 */

const MODEL_ID = 'declared-seedance-video-test';

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

/** 取轮询策略。 */
const pollingStrategyOf = (sources: { runtimeModel: Record<string, unknown> }): Record<string, unknown> => {
  const strategy = sources.runtimeModel['polling_strategy'];
  assert.ok(isObjectRecord(strategy) && !Array.isArray(strategy), 'template must carry polling_strategy');
  return strategy;
};

/** 取结果映射。 */
const resultOutputMappingOf = (sources: { runtimeModel: Record<string, unknown> }): Record<string, unknown> => {
  const mapping = sources.runtimeModel['result_output_mapping'];
  assert.ok(isObjectRecord(mapping) && !Array.isArray(mapping), 'template must carry result_output_mapping');
  return mapping;
};

/** 取参数表单字段列表。 */
const parameterFieldsOf = (sources: { runtimeModel: Record<string, unknown> }): Record<string, unknown>[] => {
  const schema = sources.runtimeModel['parameter_schema'];
  assert.ok(isObjectRecord(schema) && !Array.isArray(schema), 'template must carry parameter_schema');
  const fields = schema['fields'];
  assert.ok(Array.isArray(fields), 'parameter_schema.fields must be an array');
  return fields.map((field) => {
    assert.ok(isObjectRecord(field) && !Array.isArray(field), 'parameter field must be an object');
    return field;
  });
};

/** 把模板 sources 走一遍真实投影路径（失败即抛，测试据此判红）。 */
const projectTemplate = (acceptedMediaSlots: readonly GenerationMediaSlotId[]) => {
  const sources = buildSeedance20V1BaseTemplateSources(MODEL_ID, { acceptedMediaSlots });
  return buildProjectionFromPackageSources({
    packageId: declaredGenerationPackageId(SEEDANCE_2_0_V1_FAMILY_ADAPTER_ID),
    entryModelModelId: MODEL_ID,
    protocolFormat: undefined,
    runtimeModel: sources.runtimeModel,
    node: sources.node,
    localizationResources: sources.localizationResources,
  });
};

/** 素材位 → 表单字段键（测试侧独立期望，不复用模板常量以免同错同过）。 */
const expectedFieldKeyOfSlot = (slot: GenerationMediaSlotId): string => {
  switch (slot) {
    case 'first_frame':
      return 'first_frame';
    case 'last_frame':
      return 'last_frame';
    case 'reference_image':
      return 'reference_images';
    case 'reference_video':
      return 'reference_videos';
    case 'reference_audio':
      return 'reference_audios';
    default:
      throw new Error(`本族模板不表达素材位 ${slot}（测试期望表未覆盖 = 模板越界扩位）`);
  }
};

/** 六种素材位形态：覆盖本族全部素材位的可选/可不选组合。 */
const MEDIA_SLOT_SHAPES: ReadonlyArray<readonly GenerationMediaSlotId[]> = [
  [],
  ['first_frame'],
  ['first_frame', 'last_frame'],
  ['reference_image'],
  ['reference_image', 'reference_video', 'reference_audio'],
  ['first_frame', 'last_frame', 'reference_image', 'reference_video', 'reference_audio'],
];

/**
 * `unknown → unknown[]` 的收窄守卫。
 *
 * 不用 `Array.isArray` 直接判：它的谓词是 `arg is any[]`，会把后续返回值变成 `any`。
 * 自建谓词把类型收窄到 `unknown[]`，测试里全程不出现 `any` 与断言。
 */
const isUnknownArray = (value: unknown): value is unknown[] => Array.isArray(value);

/** 在真实求值器下求 body.content（素材位形态 → content 数组）。 */
const evaluateContent = async (
  acceptedMediaSlots: readonly GenerationMediaSlotId[],
  fields: Record<string, unknown>,
): Promise<unknown[]> => {
  const sources = buildSeedance20V1BaseTemplateSources(MODEL_ID, { acceptedMediaSlots });
  const rule = payloadRulesOf(sources)['body.content'];
  const value = await evaluateRule(rule, {
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
  if (!isUnknownArray(value)) {
    throw new Error('body.content 必须求值成数组');
  }
  return value;
};

/** 读 content 条目上的 role（文本条目没有 role，返回 'text'）。 */
const roleOfEntry = (entry: unknown): string => {
  assert.ok(isObjectRecord(entry) && !Array.isArray(entry), 'content entry must be an object');
  const type = entry['type'];
  if (type === 'text') return 'text';
  const role = entry['role'];
  return typeof role === 'string' ? role : '(no role)';
};

void test('seedance 族模板：注册条目已就绪，能力事实与适配器 endpoint 同源', () => {
  const entry = GENERATION_FAMILY_TEMPLATE_REGISTRY['seedance-2-0-v1'];
  assert.equal(entry.status, 'ready');
  assert.deepEqual(
    [...entry.supportsMediaSlots],
    ['first_frame', 'last_frame', 'reference_image', 'reference_video', 'reference_audio'],
    '本族模板能表达五个素材位（官方 content 的五个 role）',
  );
  assert.deepEqual([...entry.supportsMediaSlots], [...SEEDANCE_2_0_V1_SUPPORTED_MEDIA_SLOTS]);
  assert.deepEqual([...entry.declaredEndpointKeys], ['tasks', 'taskById'], '异步族用到提交与查询两个 endpoint 键');

  // 适配器侧路径是事实源，模板字面量必须逐字相同（一致性门禁会把两边对齐，这里给出显式期望）
  const adapter = ADAPTER_REGISTRY['seedance-2-0-v1'].relative_endpoints ?? {};
  assert.equal(adapter['tasks'], '/api/v3/contents/generations/tasks');
  assert.equal(adapter['taskById'], '/api/v3/contents/generations/tasks/{id}');
});

void test('seedance 族模板：六种素材位形态都构建出合法 sources 并走通合成投影路径', () => {
  for (const shape of MEDIA_SLOT_SHAPES) {
    const { projection, localizationBundle } = projectTemplate(shape);
    assert.equal(projection.model_id, MODEL_ID, `形态 ${JSON.stringify(shape)} 的 model_id`);
    assert.equal(projection.role, 'generator');
    assert.deepEqual(projection.capability.output_modalities, ['video'], '输出恒为视频');
    assert.equal(projection.capability.supports_async_task, true, '异步任务能力恒成立');
    assert.deepEqual(projection.ports.outputs.map((port) => port.id), ['video']);
    assert.equal(
      localizationBundle.namespace,
      `model-asset/${declaredGenerationPackageId(SEEDANCE_2_0_V1_FAMILY_ADAPTER_ID)}`,
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
      `形态 ${JSON.stringify(shape)} 的输入端口必须只来自勾选的素材位`,
    );
  }
});

void test('seedance 族模板：异步轮询策略逐字段与实测包一致', () => {
  // 三型号（标准 / fast / mini）实测完全一致；本断言把每一项单独列出来，漂移即点名。
  for (const shape of MEDIA_SLOT_SHAPES) {
    const sources = buildSeedance20V1BaseTemplateSources(MODEL_ID, { acceptedMediaSlots: shape });
    const strategy = pollingStrategyOf(sources);

    // 查询请求：GET 任务详情端点，无 header 无 body。
    assert.deepEqual(strategy['request'], {
      url_template: '/api/v3/contents/generations/tasks/{id}',
      method: 'GET',
      headers: {},
      body: null,
    }, `形态 ${JSON.stringify(shape)} 的轮询请求形态`);

    // 异步响应处理声明：编辑器据此把响应当任务（与在役包同值）。
    assert.deepEqual(payloadRulesOf(sources)['api.responseHandling.mode'], { kind: 'literal', value: 'async' });

    assert.deepEqual(strategy['polling'], {
      intervalMs: 3000,
      maxAttempts: 500,
      successFieldPaths: ['content.video_url', 'status'],
      successStatuses: ['succeeded'],
      statusFieldPaths: ['status', 'data.status'],
      failureStatuses: ['failed', 'expired'],
      failureCodePaths: ['error.code'],
      failureMessagePaths: ['error.message', 'message', 'data.message', 'fail_reason'],
    }, `形态 ${JSON.stringify(shape)} 的轮询策略`);
  }
});

void test('seedance 族模板：异步提交结果规则与结果映射与实测包一致，且能解析出 output.video_url', () => {
  const sources = buildSeedance20V1BaseTemplateSources(MODEL_ID, { acceptedMediaSlots: [] });

  assert.deepEqual(resultRuleOf(sources), {
    mode: 'async',
    submit_response_id_path: '/id',
  }, '异步任务：提交响应的 /id 是轮询任务 id');

  const mapping = resultOutputMappingOf(sources);
  assert.equal(mapping['response_mode'], 'structured_payload');
  assert.deepEqual(mapping['output_mapping_rules'], [
    { target: 'output.video_url', source: { kind: 'response', path: 'content.video_url' }, required: false, default_value: null },
    { target: 'output.video_url', source: { kind: 'response', path: 'data.content.video_url' }, required: false, default_value: null },
  ]);

  // 真实响应 → 真实消费函数：主路径（官方查询成功负载）必须解析出视频 URL
  const primaryOutputs = extractMappedTaskOutputs({
    taskRecord: {
      metadata: {
        taskExecutionPlan: { result_output_mapping: mapping },
      },
    },
    responseBody: {
      id: 'cgt-20260703185641-9nbbg',
      model: MODEL_ID,
      status: 'succeeded',
      content: { video_url: 'https://media.example.invalid/out.mp4' },
    },
  });
  assert.deepEqual(
    primaryOutputs.map((output) => ({ mediaType: output.mediaType, url: output.url })),
    [{ mediaType: 'video', url: 'https://media.example.invalid/out.mp4' }],
    '主路径 content.video_url 必须被解析成 video 输出',
  );

  // 兜底路径（网关包裹形态）同样可解析
  const wrappedOutputs = extractMappedTaskOutputs({
    taskRecord: {
      metadata: {
        taskExecutionPlan: { result_output_mapping: mapping },
      },
    },
    responseBody: {
      data: { status: 'succeeded', content: { video_url: 'https://media.example.invalid/wrapped.mp4' } },
    },
  });
  assert.deepEqual(
    wrappedOutputs.map((output) => output.url),
    ['https://media.example.invalid/wrapped.mp4'],
    '兜底路径 data.content.video_url 必须被解析成 video 输出',
  );
});

void test('seedance 族模板：公网中转声明存在，且目标类型是通用文件中转（视频/音频不可用仅图像 target）', () => {
  // 带素材位：必须声明公网中转 —— content 里的媒体全部以公网 URL 提交
  for (const shape of MEDIA_SLOT_SHAPES.filter((item) => item.length > 0)) {
    const sources = buildSeedance20V1BaseTemplateSources(MODEL_ID, { acceptedMediaSlots: shape });
    const runtime = runtimeOf(sources);
    assert.equal(runtime['url_input_upload_mode'], 'public_relay', `形态 ${JSON.stringify(shape)} 必须声明公网中转`);
    assert.equal(
      runtime['url_input_upload_target_type'],
      'cloudflare_image_public_url',
      '视频与音频素材必须走通用文件中转（self_hosted_image_public_url 只服务图像）',
    );
    assert.equal(runtime['payload_format'], 'json', '请求体是 JSON');
  }

  // 纯文生视频：没有任何 public_url 目标，声明中转会被判坏包（url_input_upload_mode_without_public_url_target）
  const textOnly = runtimeOf(buildSeedance20V1BaseTemplateSources(MODEL_ID, { acceptedMediaSlots: [] }));
  assert.equal(textOnly['url_input_upload_mode'], undefined, '无素材位时不得声明公网中转');
  assert.equal(textOnly['url_input_upload_target_type'], undefined);
});

void test('seedance 族模板：content 由素材位推导，不出现 input_mode 字段或规则', () => {
  // 文生视频：只有文本块
  const textOnlySources = buildSeedance20V1BaseTemplateSources(MODEL_ID, { acceptedMediaSlots: [] });
  assert.equal(
    JSON.stringify(textOnlySources.runtimeModel).includes('input_mode'),
    false,
    'input_mode 是包内内部概念，族模板不得把它作为用户可见参数或规则条件',
  );
  assert.equal(
    parameterFieldsOf(textOnlySources).some((field) => field['field_key'] === 'input_mode'),
    false,
  );
});

void test('seedance 族模板：content 数组在真实求值器下按素材位组装（文本 + 各 role）', async () => {
  // ① 文生视频
  const textOnly = await evaluateContent([], { __prompt: '  a cat  ' });
  assert.deepEqual(textOnly, [{ type: 'text', text: 'a cat' }], '文生视频 content 只有 trim 后的文本块');

  // ② 首帧
  const firstFrame = await evaluateContent(['first_frame'], {
    __prompt: 'cat',
    first_frame: ['https://media.example.invalid/a.png'],
  });
  assert.deepEqual(firstFrame.map(roleOfEntry), ['text', 'first_frame']);

  // ③ 首尾帧
  const keyframes = await evaluateContent(['first_frame', 'last_frame'], {
    __prompt: 'cat',
    first_frame: ['https://media.example.invalid/a.png'],
    last_frame: ['https://media.example.invalid/b.png'],
  });
  assert.deepEqual(keyframes.map(roleOfEntry), ['text', 'first_frame', 'last_frame']);

  // ④ 参考组三路（多值展开成多条）
  const references = await evaluateContent(['reference_image', 'reference_video', 'reference_audio'], {
    __prompt: 'cat',
    reference_images: ['https://media.example.invalid/r1.png', 'https://media.example.invalid/r2.png'],
    reference_videos: ['https://media.example.invalid/v1.mp4'],
    reference_audios: ['https://media.example.invalid/a1.mp3'],
  });
  assert.deepEqual(
    references.map(roleOfEntry),
    ['text', 'reference_image', 'reference_image', 'reference_video', 'reference_audio'],
    '参考图按张展开，视频/音频各一条',
  );
  assert.deepEqual(
    references.slice(1).map((entry) => (isObjectRecord(entry) ? entry['type'] : null)),
    ['image_url', 'image_url', 'video_url', 'audio_url'],
    'content 条目的 type 必须与 role 对应的官方形态一致',
  );

  // ⑤ 全开形态：参考组非空时首尾帧分支不产出（官方三场景互斥，模板取「参考优先」）
  const mixed = await evaluateContent(
    ['first_frame', 'last_frame', 'reference_image', 'reference_video', 'reference_audio'],
    {
      __prompt: 'cat',
      first_frame: ['https://media.example.invalid/a.png'],
      last_frame: ['https://media.example.invalid/b.png'],
      reference_images: ['https://media.example.invalid/r1.png'],
      reference_videos: [],
      reference_audios: [],
    },
  );
  assert.deepEqual(mixed.map(roleOfEntry), ['text', 'reference_image'], '参考组非空时首尾帧分支不产出');

  // ⑥ 全开形态 + 参考组全空：首尾帧分支照常产出
  const mixedKeyframes = await evaluateContent(
    ['first_frame', 'last_frame', 'reference_image', 'reference_video', 'reference_audio'],
    {
      __prompt: 'cat',
      first_frame: ['https://media.example.invalid/a.png'],
      last_frame: ['https://media.example.invalid/b.png'],
      reference_images: [],
      reference_videos: [],
      reference_audios: [],
    },
  );
  assert.deepEqual(mixedKeyframes.map(roleOfEntry), ['text', 'first_frame', 'last_frame']);

  // ⑦ 素材位勾了却没填：content 只剩文本块（不产出空壳条目）
  const unfilled = await evaluateContent(['reference_image'], {
    __prompt: 'cat',
    reference_images: [],
  });
  assert.deepEqual(unfilled.map(roleOfEntry), ['text'], '未填写的素材位不产出 content 条目');
});

void test('seedance 族模板：分辨率取族内交集，1080p 由记录级收窄解锁', () => {
  const sources = buildSeedance20V1BaseTemplateSources(MODEL_ID, { acceptedMediaSlots: [] });
  const fields = parameterFieldsOf(sources);
  const resolution = fields.find((field) => field['field_key'] === 'resolution');
  assert.ok(resolution, 'resolution 字段必须存在');
  const options = resolution['enum_options'];
  assert.ok(Array.isArray(options));
  assert.deepEqual(
    options.map((option) => (isObjectRecord(option) ? option['value'] : undefined)),
    ['480p', '720p'],
    '族模板取三型号交集：fast 与 mini 只支持 480p/720p，不预发 1080p',
  );
  assert.equal(resolution['default_value'], '720p');

  // wire 侧收敛集合必须与表单枚举同源（同一个 allowed_values 事实）
  const resolutionRule = payloadRulesOf(sources)['body.resolution'];
  assert.ok(isObjectRecord(resolutionRule) && !Array.isArray(resolutionRule));
  const ruleOptions = resolutionRule['options'];
  assert.ok(isObjectRecord(ruleOptions) && !Array.isArray(ruleOptions));
  assert.deepEqual(ruleOptions['allowed_values'], ['480p', '720p']);
  assert.equal(ruleOptions['fallback'], '720p');

  // 其余参数与在役包一致的档位
  const ratio = fields.find((field) => field['field_key'] === 'ratio');
  assert.ok(ratio && Array.isArray(ratio['enum_options']));
  assert.deepEqual(
    ratio['enum_options'].map((option) => (isObjectRecord(option) ? option['value'] : undefined)),
    ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'],
  );
  assert.equal(ratio['default_value'], 'adaptive');

  const duration = fields.find((field) => field['field_key'] === 'duration');
  assert.ok(duration && Array.isArray(duration['enum_options']));
  assert.deepEqual(
    duration['enum_options'].map((option) => (isObjectRecord(option) ? option['value'] : undefined)),
    ['4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', '-1'],
    '官方 4–15 整数 + -1 智能时长',
  );
  assert.equal(duration['default_value'], '5');
  // wire 上收敛成整数（-1 是官方智能时长取值）
  const durationRule = payloadRulesOf(sources)['body.duration'];
  assert.ok(isObjectRecord(durationRule) && !Array.isArray(durationRule));
  const durationOptions = durationRule['options'];
  assert.ok(isObjectRecord(durationOptions) && !Array.isArray(durationOptions));
  assert.deepEqual(durationOptions['allowed_values'], [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, -1]);
  assert.equal(durationOptions['fallback'], 5);

  for (const fieldKey of ['generate_audio', 'return_last_frame', 'watermark']) {
    const field = fields.find((item) => item['field_key'] === fieldKey);
    assert.ok(field, `${fieldKey} 字段必须存在`);
    assert.equal(field['component'], 'switch');
  }
  assert.equal(fields.find((item) => item['field_key'] === 'generate_audio')?.['default_value'], true);
  assert.equal(fields.find((item) => item['field_key'] === 'return_last_frame')?.['default_value'], false);
  assert.equal(fields.find((item) => item['field_key'] === 'watermark')?.['default_value'], false);
});

void test('seedance 族模板：参数描述端点数据（素材位不进官方参数区）', () => {
  const descriptor = buildSeedance20V1ParameterDescriptor();
  assert.equal(descriptor.family_adapter_id, SEEDANCE_2_0_V1_FAMILY_ADAPTER_ID);
  assert.deepEqual(
    descriptor.official_fields.map((field) => field.field_key),
    ['resolution', 'ratio', 'duration', 'generate_audio', 'return_last_frame', 'watermark'],
    '素材位字段不进官方参数区（归属由记录的 accepted_media_slots 管控）',
  );
  // 保留键必须覆盖 content / model / prompt 等协议键（含全素材位形态的分支）
  for (const reserved of ['content', 'model', 'prompt', 'input']) {
    assert.ok(
      descriptor.reserved_wire_names.includes(reserved),
      `保留键必须包含 ${reserved}`,
    );
  }
  // wire 名从 payload_rules 提取
  const resolution = descriptor.official_fields.find((field) => field.field_key === 'resolution');
  assert.equal(resolution?.wire_name, 'resolution');
  assert.deepEqual(resolution?.enum_options, ['480p', '720p']);
});

void test('seedance 族模板：记录级参数覆盖可解锁 1080p、可收窄档位，且不破坏请求体', () => {
  // 标准版解锁 1080p 走记录级收窄（族模板取交集，交集之外的档位由记录放开）
  const unlocked = buildFamilyTemplateSources('seedance-2-0-v1', MODEL_ID, {
    acceptedMediaSlots: ['reference_image'],
    parameterOverrides: {
      official: [{ field_key: 'resolution', enum_options: ['720p', '1080p'] }],
      custom: [],
    },
  });
  assert.equal(unlocked.kind, 'ready');
  if (unlocked.kind !== 'ready') return;
  const resolutionField = parameterFieldsOf(unlocked.sources).find((field) => field['field_key'] === 'resolution');
  assert.ok(resolutionField);
  assert.deepEqual(resolutionField['enum_options'], [{ value: '720p' }, { value: '1080p' }]);
  // 解锁后的 wire 收敛集合仍与表单同源（族模板的 allowed_values 不因覆盖而漂移）
  const resolutionRule = payloadRulesOf(unlocked.sources)['body.resolution'];
  assert.ok(isObjectRecord(resolutionRule) && !Array.isArray(resolutionRule));
  const resolutionOptions = resolutionRule['options'];
  assert.ok(isObjectRecord(resolutionOptions) && !Array.isArray(resolutionOptions));
  assert.deepEqual(resolutionOptions['allowed_values'], ['480p', '720p']);
  // 收窄后的合成投影仍然合法
  assert.doesNotThrow(() =>
    buildProjectionFromPackageSources({
      packageId: declaredGenerationPackageId(SEEDANCE_2_0_V1_FAMILY_ADAPTER_ID),
      entryModelModelId: MODEL_ID,
      protocolFormat: undefined,
      runtimeModel: unlocked.sources.runtimeModel,
      node: unlocked.sources.node,
      localizationResources: unlocked.sources.localizationResources,
    }),
  );
});

void test('seedance 族模板：生成参数可被禁用（保存期放行、合成期剪掉自身规则），素材位字段不可覆盖', () => {
  // 七个生成参数都不参与 body.content 组装，禁用它们只丢掉自己的发送规则
  for (const fieldKey of ['resolution', 'ratio', 'duration', 'generate_audio', 'return_last_frame', 'watermark']) {
    const violations = validateParameterOverrides(buildSeedance20V1BaseTemplateSources(MODEL_ID, { acceptedMediaSlots: [] }), {
      official: [{ field_key: fieldKey, enabled: false }],
      custom: [],
    });
    assert.deepEqual(violations, [], `${fieldKey} 不参与 content 组装，应当允许禁用`);
  }

  // 合成期：duration 被禁用后，body.duration / meta.duration 整条消失，字段也消失
  const built = buildFamilyTemplateSources('seedance-2-0-v1', MODEL_ID, {
    acceptedMediaSlots: [],
    parameterOverrides: { official: [{ field_key: 'duration', enabled: false }], custom: [] },
  });
  assert.equal(built.kind, 'ready');
  if (built.kind !== 'ready') return;
  const rules = payloadRulesOf(built.sources);
  assert.equal('body.duration' in rules, false, '被禁用字段的发送规则必须整条剪掉');
  assert.equal('meta.duration' in rules, false);
  assert.equal('body.content' in rules, true, 'content 组装不得受影响');
  assert.doesNotThrow(() =>
    buildProjectionFromPackageSources({
      packageId: declaredGenerationPackageId(SEEDANCE_2_0_V1_FAMILY_ADAPTER_ID),
      entryModelModelId: MODEL_ID,
      protocolFormat: undefined,
      runtimeModel: built.sources.runtimeModel,
      node: built.sources.node,
      localizationResources: built.sources.localizationResources,
    }),
  );

  // 素材位字段是模型自带素材输入，不允许在这里关闭/改名（归属由 accepted_media_slots 管控）
  assert.throws(
    () =>
      buildFamilyTemplateSources('seedance-2-0-v1', MODEL_ID, {
        acceptedMediaSlots: ['reference_image'],
        parameterOverrides: { official: [{ field_key: 'reference_images', enabled: false }], custom: [] },
      }),
    /素材输入/,
    '素材位字段必须拒绝覆盖',
  );
});
