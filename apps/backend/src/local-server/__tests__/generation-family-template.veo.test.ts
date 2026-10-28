import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ExecutionSnapshotSchema,
  type FamilyTemplateParameterDescriptor,
  type GenerationMediaSlotId,
} from '@iart/contracts';
import { buildProjectionFromPackageSources } from '../model-package-catalog.projection.cts';
import { isObjectRecord } from '../model-package-catalog.shared.cts';
import {
  declaredGenerationPackageId,
  type GenerationFamilyTemplateSources,
} from '../generation-family-templates.cts';
import {
  requireFamilyTemplate,
  buildFamilyTemplateSources,
  checkFamilyMediaSlotSupport,
} from '../generation-family-templates.registry.cts';
import { buildFormatParameterDescriptor, getInterfaceFormat } from '../interface-format/registry.cts';
import { validateParameterOverrides } from '../generation-parameter-overrides.cts';
import { applyRemoteModelInjection } from '../provider-connection/remote-model-injection.cts';
import { evaluateRule } from '../request-assembler-runtime.cts';
import { buildPollingRequestFromPlan } from '../task-engine-polling-utils.cts';
import { extractMappedTaskOutputs } from '../task-result-output-mapping.cts';

/**
 * veo-v1 族模板（Google Veo 3.1，Gemini API `predictLongRunning` LRO，内联上传）。
 *
 * 钉六件事：
 * ① 三种素材位形态（无素材 / 首帧 / 首尾帧）都能构建出**合法** sources 并通过与已装包相同的
 *    `buildProjectionFromPackageSources` 投影路径（本地化校验、字段键引用校验、媒体目标校验
 *    一并跑过）；参考图形态虽不在族上限内，但构建器写得出（协议事实），一并验证；
 * ② 异步轮询策略**逐字段**与实测包一致（intervalMs / maxAttempts / successStatuses /
 *    failureStatuses / statusFieldPaths / failureCodePaths / failureMessagePaths /
 *    successFieldPaths / url_template / method / headers / body）——任一项漂移会让任务永远
 *    停在 running 或把成功当失败；
 * ③ 结果映射能真的从查询响应里解析出 `output.video_url`（喂真实响应给真实消费函数）；
 * ④ **模型身份走 URL 注入**：模板内 endpoint 含 `{model}`、没有 `body.model`；派发前
 *    `applyRemoteModelInjection` 把 `{model}` 换成 remote_model_id 且**不**往 body 里塞 model；
 *    轮询 `{operation_name}` 由提交响应 `/name` 替换；
 * ⑤ 无公网中转：不声明 `url_input_upload_mode`，媒体以 `inline_data` 传输；
 * ⑥ `instances` / `parameters` 在真实求值器下的组装结果（含 `seed` 的「留空不发」语义）。
 *
 * 本族模板自包含：测试只读内存态 sources，不读任何磁盘资产。
 */

const MODEL_ID = 'declared-veo-video-test';

/** 接口格式 id（值域由 contracts 的 `GENERATION_FAMILY_ADAPTER_IDS` 裁定）。 */
const VEO_V1_FAMILY_ADAPTER_ID = 'veo-v1';

/** 测试侧独立期望的素材位清单（不复用注册表，避免同错同过）。 */
const VEO_V1_SUPPORTED_MEDIA_SLOTS: readonly GenerationMediaSlotId[] = ['first_frame', 'last_frame'];

/** 经实体门面取本族基础模板 sources（与记录合成同一条链路）。 */
const buildVeoV1BaseTemplateSources = (
  modelId: string,
  options: { acceptedMediaSlots: readonly GenerationMediaSlotId[] },
): GenerationFamilyTemplateSources => {
  const entry = requireFamilyTemplate(VEO_V1_FAMILY_ADAPTER_ID);
  assert.equal(entry.status, 'ready', 'veo-v1 必须已就绪');
  if (entry.status !== 'ready') throw new Error('unreachable: family template not ready');
  return entry.buildBaseSources(modelId, options);
};

/** 经实体层取本族参数描述符（与 GET 端点同一份构建器）。 */
const buildVeoV1ParameterDescriptor = (): FamilyTemplateParameterDescriptor => {
  const result = buildFormatParameterDescriptor(VEO_V1_FAMILY_ADAPTER_ID);
  assert.equal(result.kind, 'ready', 'veo-v1 描述符必须就绪');
  if (result.kind !== 'ready') throw new Error('unreachable: descriptor not ready');
  return result.descriptor;
};

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
  const sources = buildVeoV1BaseTemplateSources(MODEL_ID, { acceptedMediaSlots });
  return buildProjectionFromPackageSources({
    packageId: declaredGenerationPackageId(VEO_V1_FAMILY_ADAPTER_ID),
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
      return 'firstFrameImage';
    case 'last_frame':
      return 'lastFrameImage';
    default:
      throw new Error(`本族模板不表达素材位 ${slot}（测试期望表未覆盖 = 模板越界扩位）`);
  }
};

/** `unknown → unknown[]` 的收窄守卫（不用 Array.isArray 直接判，避免引入 any）。 */
const isUnknownArray = (value: unknown): value is unknown[] => Array.isArray(value);

/** 在真实求值器下求一条 payload 规则（字段表 → 求值结果）。 */
const evaluateRuleUnderTest = async (
  acceptedMediaSlots: readonly GenerationMediaSlotId[],
  target: string,
  fields: Record<string, unknown>,
): Promise<unknown> => {
  const sources = buildVeoV1BaseTemplateSources(MODEL_ID, { acceptedMediaSlots });
  const rule = payloadRulesOf(sources)[target];
  return evaluateRule(rule, {
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
};

/** 求 `body.instances` 并取出唯一 instance（求值器返回单元素数组是协议事实）。 */
const evaluateInstance = async (
  acceptedMediaSlots: readonly GenerationMediaSlotId[],
  fields: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const value = await evaluateRuleUnderTest(acceptedMediaSlots, 'body.instances', fields);
  assert.ok(isUnknownArray(value), 'body.instances 必须求值成数组');
  assert.equal(value.length, 1, '一次请求只提交 1 个 instance');
  const instance = value[0];
  assert.ok(isObjectRecord(instance) && !Array.isArray(instance), 'instance 必须是对象');
  return instance;
};

/** 求 `body.parameters`。 */
const evaluateParameters = async (
  acceptedMediaSlots: readonly GenerationMediaSlotId[],
  fields: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const value = await evaluateRuleUnderTest(acceptedMediaSlots, 'body.parameters', fields);
  assert.ok(isObjectRecord(value) && !Array.isArray(value), 'body.parameters 必须求值成对象');
  return value;
};

/** 读一个内联媒体占位符的 transport 与来源 URL（占位符形状由 request-assembler-runtime 定义）。 */
const readMediaRef = (value: unknown): { transport: unknown; url: unknown } => {
  assert.ok(isObjectRecord(value) && !Array.isArray(value), 'media ref must be an object');
  const source = value['source'];
  assert.ok(isObjectRecord(source) && !Array.isArray(source), 'media ref must carry a source');
  return { transport: value['transport'], url: source['url'] };
};

void test('veo 族模板：注册条目已就绪，能力事实与适配器 endpoint 同源', () => {
  const entry = requireFamilyTemplate('veo-v1');
  assert.equal(entry.status, 'ready');
  assert.equal(entry.familyAdapterId, VEO_V1_FAMILY_ADAPTER_ID);
  assert.deepEqual([...entry.supportsMediaSlots], [...VEO_V1_SUPPORTED_MEDIA_SLOTS]);
  assert.deepEqual(
    [...entry.supportsMediaSlots],
    ['first_frame', 'last_frame'],
    '族上限只到首帧/尾帧：参考图 lite 不支持且素材位没有记录级扩位通道',
  );
  assert.deepEqual(
    [...entry.declaredEndpointKeys],
    ['predictLongRunning', 'operation'],
    '异步族用到提交（含 {model}）与轮询（含 {operation_name}）两个 endpoint 键',
  );

  // 接口格式声明是 endpoint 的唯一事实源，这里给出显式期望值
  const formatLookup = getInterfaceFormat('veo-v1');
  assert.equal(formatLookup.kind, 'ready');
  if (formatLookup.kind !== 'ready') return;
  const declaredEndpoints = formatLookup.format.transport.endpoints;
  assert.equal(declaredEndpoints['predictLongRunning'], '/v1beta/models/{model}:predictLongRunning');
  assert.equal(declaredEndpoints['operation'], '/v1beta/{operation_name}');

  // 素材位守卫：首帧/尾帧放行，参考图与视频/音频位拒绝（族上限表达不了）
  assert.equal(checkFamilyMediaSlotSupport('veo-v1', ['first_frame', 'last_frame']).kind, 'ok');
  assert.equal(checkFamilyMediaSlotSupport('veo-v1', ['reference_image']).kind, 'unsupported');
  assert.equal(checkFamilyMediaSlotSupport('veo-v1', ['first_frame', 'reference_audio']).kind, 'unsupported');
});

void test('veo 族模板：三种素材位形态都构建出合法 sources 并走通合成投影路径', () => {
  // 族上限内的形态（注册表允许写入的记录形态）
  const shapes: ReadonlyArray<readonly GenerationMediaSlotId[]> = [[], ['first_frame'], ['first_frame', 'last_frame']];
  for (const shape of shapes) {
    const { projection, localizationBundle } = projectTemplate(shape);
    assert.equal(projection.model_id, MODEL_ID, `形态 ${JSON.stringify(shape)} 的 model_id`);
    assert.equal(projection.role, 'generator');
    assert.deepEqual(projection.capability.output_modalities, ['video'], '输出恒为视频');
    assert.equal(projection.capability.supports_async_task, true, '异步任务能力恒成立');
    assert.deepEqual(projection.ports.outputs.map((port) => port.id), ['video']);
    assert.equal(
      localizationBundle.namespace,
      `model-asset/${declaredGenerationPackageId(VEO_V1_FAMILY_ADAPTER_ID)}`,
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
    // 输入模态随素材位增长
    assert.deepEqual(
      projection.capability.input_modalities,
      shape.length > 0 ? ['text', 'image'] : ['text'],
      '不勾素材位时输入模态只有文本',
    );
  }
});

void test('veo 族模板：异步轮询策略逐字段与实测包一致', () => {
  // 三型号（标准 / fast / lite）实测完全一致；每一项单独列出，漂移即点名。
  for (const shape of [[], ['first_frame', 'last_frame']] as ReadonlyArray<readonly GenerationMediaSlotId[]>) {
    const sources = buildVeoV1BaseTemplateSources(MODEL_ID, { acceptedMediaSlots: shape });
    const strategy = pollingStrategyOf(sources);

    // 查询请求：GET operation 资源，无 header 无 body（operation_name 由轮询层替换）。
    assert.deepEqual(strategy['request'], {
      url_template: '/v1beta/{operation_name}',
      method: 'GET',
      headers: {},
      query: [],
      body: null,
      body_format: 'json',
      content_type: null,
    }, `形态 ${JSON.stringify(shape)} 的轮询请求形态`);

    assert.deepEqual(strategy['polling'], {
      intervalMs: 10000,
      maxAttempts: 120,
      successFieldPaths: ['response.generateVideoResponse.generatedSamples[0].video.uri'],
      successStatuses: ['true'],
      statusFieldPaths: ['done'],
      failureStatuses: ['error', 'failed', 'failure', 'cancelled', 'canceled'],
      failureCodePaths: ['error.code'],
      failureMessagePaths: ['error.message', 'error.status', 'error.details'],
    }, `形态 ${JSON.stringify(shape)} 的轮询策略`);
  }
});

void test('veo 族模板：异步提交结果规则与结果映射与实测包一致，且能解析出 output.video_url', () => {
  const sources = buildVeoV1BaseTemplateSources(MODEL_ID, { acceptedMediaSlots: [] });

  // 提交响应是 Operation 对象，`name` 即 operation 资源名（不是普通 id）。
  assert.deepEqual(resultRuleOf(sources), {
    mode: 'async',
    submit_response_id_path: '/name',
  }, '异步任务：提交响应的 /name 是轮询用 operation 资源名');

  const mapping = resultOutputMappingOf(sources);
  assert.equal(mapping['response_mode'], 'structured_payload');
  assert.deepEqual(mapping['output_mapping_rules'], [
    {
      target: 'output.video_url',
      source: { kind: 'response', path: 'response.generateVideoResponse.generatedSamples[0].video.uri' },
      required: false,
      default_value: null,
    },
  ], '结果路径与三型号包逐字一致，required:false（查询会先回 done:false）');

  // 真实响应 → 真实消费函数：官方查询成功负载（done:true + 样本 URI）必须解析出视频 URL
  const primaryOutputs = extractMappedTaskOutputs({
    taskRecord: {
      metadata: {
        taskExecutionPlan: { result_output_mapping: mapping },
      },
    },
    responseBody: {
      name: 'models/veo-3.1-generate-preview/operations/abc123',
      done: true,
      response: {
        generateVideoResponse: {
          generatedSamples: [
            { video: { uri: 'https://media.example.invalid/veo-out.mp4' } },
          ],
        },
      },
    },
  });
  assert.deepEqual(
    primaryOutputs.map((output) => ({ mediaType: output.mediaType, url: output.url })),
    [{ mediaType: 'video', url: 'https://media.example.invalid/veo-out.mp4' }],
    '主路径 response.generateVideoResponse.generatedSamples[0].video.uri 必须被解析成 video 输出',
  );

  // 未完成的 operation（done:false，无 samples）不能产出任何输出——否则会把空地址当成功
  const pendingOutputs = extractMappedTaskOutputs({
    taskRecord: { metadata: { taskExecutionPlan: { result_output_mapping: mapping } } },
    responseBody: { name: 'models/veo/operations/abc123', done: false },
  });
  assert.deepEqual(pendingOutputs, [], '未完成时不得产出输出条目');
});

void test('veo 族模板：模型身份走 URL 注入（{model}），请求体没有 model 字段', () => {
  const sources = buildVeoV1BaseTemplateSources(MODEL_ID, { acceptedMediaSlots: [] });
  const rules = payloadRulesOf(sources);

  // ① 模板内 endpoint 含 {model} 占位符，且没有 body.model（否则会向 Veo 上游注入未定义字段）
  assert.deepEqual(rules['api.endpoint'], {
    kind: 'literal',
    value: '/v1beta/models/{model}:predictLongRunning',
  });
  assert.equal('body.model' in rules, false, 'URL 注入类不得声明 body.model');
  assert.deepEqual(rules['meta.model_id'], { kind: 'literal', value: MODEL_ID }, 'meta.model_id 只是产品侧留痕');

  // ② 派发前注入：{model} 换成 remote_model_id（URL 编码），body 原样不动
  const snapshot = ExecutionSnapshotSchema.parse({
    snapshot_id: 'snap_veo_test',
    model_id: MODEL_ID,
    model_version: '1.0.0',
    deployment_id: 'up_dep_veo_test',
    connection_id: 'up_conn_veo_test',
    connection_revision: 1,
    adapter_id: 'veo-v1',
    adapter_version: '1.0.0',
    base_url: 'https://provider.example',
    remote_model_id: 'veo-3.1-generate-preview',
    credential_ref: 'cred_veo_test',
    credential_version: 1,
    resolved_endpoint: 'https://provider.example/v1/placeholder',
    created_at: new Date().toISOString(),
  });
  const injected = applyRemoteModelInjection({
    snapshot,
    url: '/v1beta/models/{model}:predictLongRunning',
    body: { instances: [{ prompt: 'a cat' }] },
  });
  assert.equal(
    injected.url,
    '/v1beta/models/veo-3.1-generate-preview:predictLongRunning',
    'remote_model_id 必须注入到 URL 路径段（占位符替换）',
  );
  assert.deepEqual(injected.body, { instances: [{ prompt: 'a cat' }] }, 'URL 注入类不得改动请求体');

  // ③ 轮询：提交响应的 /name 填进 {operation_name}（含 `models/.../operations/...` 的斜杠形态）
  const operationName = 'models/veo-3.1-generate-preview/operations/abc123';
  const pollingBuild = buildPollingRequestFromPlan(
    {
      metadata: {
        taskExecutionPlan: {
          result_rule: resultRuleOf(sources),
          polling_strategy: pollingStrategyOf(sources),
        },
      },
    },
    { name: operationName },
  );
  assert.equal(pollingBuild.status, 'ready', '提交响应带 /name 时轮询请求必须可构建');
  if (pollingBuild.status !== 'ready') return;
  assert.equal(pollingBuild.remoteRequestId, operationName);
  assert.equal(
    pollingBuild.request.url,
    `/v1beta/${operationName}`,
    '查询 URL 的 {operation_name} 必须用提交响应的 name 替换',
  );
  assert.equal(pollingBuild.request.method, 'GET');
});

void test('veo 族模板：无公网中转，媒体一律内联（inline_data）', () => {
  for (const shape of [[], ['first_frame', 'last_frame']] as ReadonlyArray<readonly GenerationMediaSlotId[]>) {
    const runtime = runtimeOf(buildVeoV1BaseTemplateSources(MODEL_ID, { acceptedMediaSlots: shape }));
    assert.equal(runtime['url_input_upload_mode'], undefined, 'Gemini API 形态只接受 inlineData，不得声明公网中转');
    assert.equal(runtime['url_input_upload_target_type'], undefined);
    assert.equal(runtime['payload_format'], 'json', '请求体是 JSON');
  }

  // 首帧分支的取值节点必须声明 inline_data 媒体目标（否则会被判 media_target_missing）
  const firstFrameRule = payloadRulesOf(buildVeoV1BaseTemplateSources(MODEL_ID, { acceptedMediaSlots: ['first_frame'] }))['body.instances'];
  const serialized = JSON.stringify(firstFrameRule);
  assert.ok(serialized.includes('"media_target":"inline_data"'), '首帧取值必须走 inline_data');
  assert.equal(serialized.includes('"media_target":"public_url"'), false, '不得出现公网中转目标');
});

void test('veo 族模板：instances 在真实求值器下按素材位组装（含 seed 与 personGeneration 派生）', async () => {
  // ① 文生视频：只有 trim 后的 prompt（image/lastFrame 都不产出）
  const textOnly = await evaluateInstance([], { __prompt: '  a cat  ' });
  assert.deepEqual(textOnly, { prompt: 'a cat' }, '文生视频 instance 只有 trim 后的 prompt');

  // ② 首帧
  const firstFrame = await evaluateInstance(['first_frame'], {
    __prompt: 'cat',
    firstFrameImage: ['https://media.example.invalid/a.png'],
  });
  assert.equal(firstFrame['prompt'], 'cat');
  assert.deepEqual(readMediaRef(firstFrame['image']), {
    transport: 'inline_data',
    url: 'https://media.example.invalid/a.png',
  }, '首帧必须以 inline_data 传输');
  assert.equal('lastFrame' in firstFrame, false, '未接受的素材位不得出现');

  // ③ 首尾帧：两个键都产出，且互不干扰
  const keyframes = await evaluateInstance(['first_frame', 'last_frame'], {
    __prompt: 'cat',
    firstFrameImage: ['https://media.example.invalid/a.png'],
    lastFrameImage: ['https://media.example.invalid/b.png'],
  });
  assert.deepEqual(Object.keys(keyframes).sort(), ['image', 'lastFrame', 'prompt']);
  assert.deepEqual(readMediaRef(keyframes['lastFrame']), {
    transport: 'inline_data',
    url: 'https://media.example.invalid/b.png',
  });

  // ④ 只填尾帧（首帧留空）：尾帧照发，首帧分支不产出（不产出空壳键）
  const lastFrameOnly = await evaluateInstance(['first_frame', 'last_frame'], {
    __prompt: 'cat',
    firstFrameImage: [],
    lastFrameImage: ['https://media.example.invalid/b.png'],
  });
  assert.deepEqual(Object.keys(lastFrameOnly).sort(), ['lastFrame', 'prompt']);

  // ⑤ parameters：枚举收敛 + personGeneration 派生 + seed 留空不发
  const textParameters = await evaluateParameters([], {
    aspectRatio: 'bogus',
    durationSeconds: 'bogus',
    resolution: 'bogus',
  });
  assert.deepEqual(textParameters, {
    aspectRatio: '16:9',
    durationSeconds: '8',
    resolution: '720p',
    personGeneration: 'allow_all',
  }, '非法枚举回落官方默认档；纯文生 personGeneration=allow_all');

  const imageParameters = await evaluateParameters(['first_frame'], {
    aspectRatio: '9:16',
    durationSeconds: '4',
    resolution: '1080p',
    firstFrameImage: ['https://media.example.invalid/a.png'],
  });
  assert.deepEqual(imageParameters, {
    aspectRatio: '9:16',
    durationSeconds: '4',
    resolution: '1080p',
    personGeneration: 'allow_adult',
  }, '有图输入时 personGeneration=allow_adult（官方 I2V 约束）');

  // seed：填了发数字，留空整条键不出现（「留空不发」语义）
  const withSeed = await evaluateParameters([], {
    aspectRatio: '16:9',
    durationSeconds: '8',
    resolution: '720p',
    seed: '42',
  });
  assert.equal(withSeed['seed'], 42, 'seed 必须以数字发出（toNumber）');
  const withoutSeed = await evaluateParameters([], {
    aspectRatio: '16:9',
    durationSeconds: '8',
    resolution: '720p',
    seed: '',
  });
  assert.equal('seed' in withoutSeed, false, '未填写 seed 时不得发出该键');
});

void test('veo 族模板：分辨率取族内交集，4k 由记录级收窄解锁', () => {
  const sources = buildVeoV1BaseTemplateSources(MODEL_ID, { acceptedMediaSlots: [] });
  const fields = parameterFieldsOf(sources);

  const resolution = fields.find((field) => field['field_key'] === 'resolution');
  assert.ok(resolution, 'resolution 字段必须存在');
  const options = resolution['enum_options'];
  assert.ok(Array.isArray(options));
  assert.deepEqual(
    options.map((option) => (isObjectRecord(option) ? option['value'] : undefined)),
    ['720p', '1080p'],
    '族模板取三型号交集：lite 没有 4k，不预发',
  );
  assert.equal(resolution['default_value'], '720p');

  // wire 侧收敛集合必须与表单枚举同源（同一个 allowed_values 事实）
  const instancesParameters = payloadRulesOf(sources)['body.parameters'];
  assert.ok(isObjectRecord(instancesParameters) && !Array.isArray(instancesParameters));
  const entries = instancesParameters['entries'];
  assert.ok(isObjectRecord(entries) && !Array.isArray(entries));
  const resolutionRule = entries['resolution'];
  assert.ok(isObjectRecord(resolutionRule) && !Array.isArray(resolutionRule));
  const ruleOptions = resolutionRule['options'];
  assert.ok(isObjectRecord(ruleOptions) && !Array.isArray(ruleOptions));
  assert.deepEqual(ruleOptions['allowed_values'], ['720p', '1080p']);
  assert.equal(ruleOptions['fallback'], '720p');

  // 其余参数档位与三型号包一致
  const aspectRatio = fields.find((field) => field['field_key'] === 'aspectRatio');
  assert.ok(aspectRatio && Array.isArray(aspectRatio['enum_options']));
  assert.deepEqual(
    aspectRatio['enum_options'].map((option) => (isObjectRecord(option) ? option['value'] : undefined)),
    ['16:9', '9:16'],
    '官方仅两值，不得提供自由比例',
  );
  assert.equal(aspectRatio['default_value'], '16:9');

  const durationSeconds = fields.find((field) => field['field_key'] === 'durationSeconds');
  assert.ok(durationSeconds && Array.isArray(durationSeconds['enum_options']));
  assert.deepEqual(
    durationSeconds['enum_options'].map((option) => (isObjectRecord(option) ? option['value'] : undefined)),
    ['4', '6', '8'],
  );
  assert.equal(durationSeconds['default_value'], '8');

  // seed：number 组件、官方支持（登记契约 §6）、无默认值（留空不发）
  const seed = fields.find((field) => field['field_key'] === 'seed');
  assert.ok(seed, 'seed 字段必须存在（官方明确支持 Veo 3 系 seed）');
  assert.equal(seed['component'], 'number');
  assert.equal('default_value' in seed, false, 'seed 不设默认值：留空即不发送');

  // 4k 由记录级参数覆盖解锁（族模板不预发；wire 收敛集合不因覆盖漂移，与 seedance 族同构）
  const unlocked = buildFamilyTemplateSources('veo-v1', MODEL_ID, {
    acceptedMediaSlots: [],
    parameterOverrides: {
      official: [{ field_key: 'resolution', enum_options: ['1080p', '4k'] }],
      custom: [],
    },
  });
  assert.equal(unlocked.kind, 'ready');
  if (unlocked.kind !== 'ready') return;
  const unlockedResolution = parameterFieldsOf(unlocked.sources).find((field) => field['field_key'] === 'resolution');
  assert.ok(unlockedResolution);
  assert.deepEqual(unlockedResolution['enum_options'], [{ value: '1080p' }, { value: '4k' }]);
  assert.doesNotThrow(() =>
    buildProjectionFromPackageSources({
      packageId: declaredGenerationPackageId(VEO_V1_FAMILY_ADAPTER_ID),
      entryModelModelId: MODEL_ID,
      protocolFormat: undefined,
      runtimeModel: unlocked.sources.runtimeModel,
      node: unlocked.sources.node,
      localizationResources: unlocked.sources.localizationResources,
    }),
  );
});

void test('veo 族模板：参数描述端点数据（素材位不进官方参数区，协议键全部保留）', () => {
  const descriptor = buildVeoV1ParameterDescriptor();
  assert.equal(descriptor.family_adapter_id, VEO_V1_FAMILY_ADAPTER_ID);
  assert.deepEqual(
    descriptor.official_fields.map((field) => field.field_key),
    ['aspectRatio', 'durationSeconds', 'resolution', 'seed'],
    '素材位字段不进官方参数区（归属由记录的 accepted_media_slots 管控）',
  );
  // 四个参数都在 body.parameters 内部承载，wire 名取不到顶层 body.<字段> → 回退字段名
  // （与 gemini 族 response_format 内部承载的既有口径一致）。
  assert.deepEqual(
    descriptor.official_fields.map((field) => field.wire_name),
    ['aspectRatio', 'durationSeconds', 'resolution', 'seed'],
  );
  // 保留键必须覆盖协议键与全素材位形态的分支
  for (const reserved of ['instances', 'parameters', 'prompt', 'input', 'model']) {
    assert.ok(
      descriptor.reserved_wire_names.body.includes(reserved),
      `保留键必须包含 ${reserved}`,
    );
  }
  const resolution = descriptor.official_fields.find((field) => field.field_key === 'resolution');
  assert.deepEqual(resolution?.enum_options, ['720p', '1080p']);
  const seed = descriptor.official_fields.find((field) => field.field_key === 'seed');
  assert.equal(seed?.component, 'number');
  assert.equal(seed?.default_value, null, '无默认值的参数在描述符里是 null');
});

void test('veo 族模板：四个参数都参与请求构造（禁用会被可读拒绝），素材位字段不可覆盖', () => {
  const sources = buildVeoV1BaseTemplateSources(MODEL_ID, { acceptedMediaSlots: ['first_frame'] });

  // 四个参数都落在 body.parameters 这一个目标里：禁用任何一个都会让该目标无法安全裁剪
  for (const fieldKey of ['aspectRatio', 'durationSeconds', 'resolution', 'seed']) {
    const violations = validateParameterOverrides(sources, {
      official: [{ field_key: fieldKey, enabled: false }],
      custom: [],
    });
    assert.equal(
      violations.length,
      1,
      `${fieldKey} 参与 body.parameters 构造，禁用必须被拒绝而不是静默删掉整条 parameters`,
    );
    assert.equal(violations[0]?.code, 'disabled_field_referenced');
    assert.match(violations[0]?.message ?? '', /参与决定生成请求怎么发送/);
  }

  // 素材位字段是模型自带素材输入，不允许关闭/改名（归属由 accepted_media_slots 管控）
  assert.throws(
    () =>
      buildFamilyTemplateSources('veo-v1', MODEL_ID, {
        acceptedMediaSlots: ['first_frame'],
        parameterOverrides: { official: [{ field_key: 'firstFrameImage', enabled: false }], custom: [] },
      }),
    /素材输入/,
    '素材位字段必须拒绝覆盖',
  );

  // 可禁用的形态不存在（四个参数都参与构造）——但枚举收窄是允许的，且不破坏请求体
  const narrowed = buildFamilyTemplateSources('veo-v1', MODEL_ID, {
    acceptedMediaSlots: ['first_frame'],
    parameterOverrides: {
      official: [{ field_key: 'durationSeconds', enum_options: ['8'] }],
      custom: [],
    },
  });
  assert.equal(narrowed.kind, 'ready');
  if (narrowed.kind !== 'ready') return;
  const durationSeconds = parameterFieldsOf(narrowed.sources).find((field) => field['field_key'] === 'durationSeconds');
  assert.deepEqual(durationSeconds?.['enum_options'], [{ value: '8' }], '收窄到官方强制 8 秒的用法');
  assert.doesNotThrow(() =>
    buildProjectionFromPackageSources({
      packageId: declaredGenerationPackageId(VEO_V1_FAMILY_ADAPTER_ID),
      entryModelModelId: MODEL_ID,
      protocolFormat: undefined,
      runtimeModel: narrowed.sources.runtimeModel,
      node: narrowed.sources.node,
      localizationResources: narrowed.sources.localizationResources,
    }),
  );
});
