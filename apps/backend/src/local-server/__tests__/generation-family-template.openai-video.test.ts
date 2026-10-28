import assert from 'node:assert/strict';
import test from 'node:test';

import { ExecutionSnapshotSchema, isSerializedFormDataBody, type GenerationMediaSlotId } from '@iart/contracts';
import { declaredGenerationPackageId } from '../generation-family-templates.cts';
import {
  requireFamilyTemplate,
  checkFamilyMediaSlotSupport,
} from '../generation-family-templates.registry.cts';
import { buildFormatParameterDescriptor, getInterfaceFormat } from '../interface-format/registry.cts';
import { buildProjectionFromPackageSources } from '../model-package-catalog.projection.cts';
import { isObjectRecord } from '../model-package-catalog.shared.cts';
import { convertBodyToSerializedFormData } from '../model-input-preparation/model-input-multipart-file.cts';
import { applyParameterOverrides, validateParameterOverrides } from '../generation-parameter-overrides.cts';
import { prepareModelInputForRequest } from '../model-input-preparation/model-input-preparation.cts';
import { applyRemoteModelInjection } from '../provider-connection/remote-model-injection.cts';
import { evaluateRule } from '../request-assembler-runtime.cts';
import { buildRequestBody } from '../task-engine-request.cts';
import { resolvePollingSuccessValue } from '../task-engine-polling.cts';
import { toRecord } from '../task-engine-shared.cts';
import { extractMappedTaskOutputs } from '../task-result-output-mapping.cts';

/**
 * openai-video-v1 族模板（OpenAI 视频接口格式：multipart 提交 + 异步轮询 + 内容端点下载）。
 *
 * 钉六件事：
 * ① 三个 endpoint 字面量（提交 / 查询 / 内容）与 `ADAPTER_REGISTRY['openai-video-v1']` 的
 *    `relative_endpoints` 逐字一致，注册表条目声明了这三个键；
 * ② 两种素材位形态（不勾首帧 / 勾首帧）都能构建出**合法** sources 并通过与已装包相同的
 *    `buildProjectionFromPackageSources` 投影路径（本地化、字段键引用、媒体目标校验一并跑过）；
 * ③ 轮询策略逐字段（状态词表、成功/失败状态、状态路径、失败码/文案路径；**不声明产物证据
 *    路径**），并用真实判定函数验证「无产物路径 + 状态命中 → 首轮即成功」与未完成两种形态；
 * ④ 结果判定与获取：`mode:'async'` + `submit_response_id_path:'id'`，获取策略是
 *    `fetch_final_result` + `binary` + 内容端点，输出映射沿 `__acquired_media_url` 且要求鉴权；
 * ⑤ 首帧素材位是**可选**的：不勾选时规则不存在、勾选但留空时不上 wire、勾选并填写时成为
 *    multipart 的 `input_reference` 文件 part；`model` 表单字段在派发前替换为 remote_model_id；
 * ⑥ 不使用真实服务商域名（响应用例一律 example.invalid）。
 *
 * 本族模板自包含：测试只读内存态 sources，不读任何磁盘资产。
 */

const MODEL_ID = 'declared-openai-video-test';

/** 接口格式 id（值域由 contracts 的 `GENERATION_FAMILY_ADAPTER_IDS` 裁定）。 */
const OPENAI_VIDEO_V1_FAMILY_ADAPTER_ID = 'openai-video-v1';

/** 经实体门面取本族基础模板 sources（与记录合成同一条链路）。 */
const buildBaseTemplateSources = (
  modelId: string,
  options: { acceptedMediaSlots: readonly GenerationMediaSlotId[] },
) => {
  const entry = requireFamilyTemplate(OPENAI_VIDEO_V1_FAMILY_ADAPTER_ID);
  assert.equal(entry.status, 'ready', 'openai-video-v1 必须已就绪');
  if (entry.status !== 'ready') throw new Error('unreachable: family template not ready');
  return entry.buildBaseSources(modelId, options);
};

/** 取模板 runtime 段。 */
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

/** 取轮询策略。 */
const pollingStrategyOf = (sources: { runtimeModel: Record<string, unknown> }): Record<string, unknown> => {
  const strategy = sources.runtimeModel['polling_strategy'];
  assert.ok(isObjectRecord(strategy) && !Array.isArray(strategy), 'template must carry polling_strategy');
  return strategy;
};

/** 取结果获取策略。 */
const acquisitionStrategyOf = (sources: { runtimeModel: Record<string, unknown> }): Record<string, unknown> => {
  const strategy = sources.runtimeModel['result_acquisition_strategy'];
  assert.ok(isObjectRecord(strategy) && !Array.isArray(strategy), 'template must carry result_acquisition_strategy');
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
  const sources = buildBaseTemplateSources(MODEL_ID, { acceptedMediaSlots });
  return buildProjectionFromPackageSources({
    packageId: declaredGenerationPackageId(OPENAI_VIDEO_V1_FAMILY_ADAPTER_ID),
    entryModelModelId: MODEL_ID,
    protocolFormat: undefined,
    runtimeModel: sources.runtimeModel,
    node: sources.node,
    localizationResources: sources.localizationResources,
  });
};

/**
 * 按模板的 body.* 规则求值出提交 body（与 request-assembler 的求值顺序一致：先全部求值、
 * 再写入 payload；undefined 的规则不产生键）。
 */
const evaluateSubmitBody = async (
  acceptedMediaSlots: readonly GenerationMediaSlotId[],
  fields: Record<string, unknown>,
): Promise<Record<string, unknown>> =>
  evaluateSubmitBodyFromSources(
    buildBaseTemplateSources(MODEL_ID, { acceptedMediaSlots }),
    fields,
  );

/** 同上的 sources 入参形态（参数覆盖合成后的模板也要按同一路径求值）。 */
const evaluateSubmitBodyFromSources = async (
  sources: { runtimeModel: { runtime: unknown } },
  fields: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const rules = payloadRulesOf(sources);
  const bodyRuleKeys = Object.keys(rules)
    .filter((key) => key.startsWith('body.'))
    .sort();
  const body: Record<string, unknown> = {};
  for (const ruleKey of bodyRuleKeys) {
    const value = await evaluateRule(rules[ruleKey], {
      fields,
      runtime: {},
      projection: {},
      currentItem: undefined,
      projectPath: null,
    });
    if (value === undefined) continue;
    body[ruleKey.slice('body.'.length)] = value;
  }
  return body;
};

void test('openai-video 族模板：注册条目已就绪，三个 endpoint 与适配器同源', () => {
  const entry = requireFamilyTemplate('openai-video-v1');
  assert.equal(entry.status, 'ready');
  assert.equal(entry.familyAdapterId, OPENAI_VIDEO_V1_FAMILY_ADAPTER_ID);
  assert.deepEqual(
    [...entry.supportsMediaSlots],
    ['first_frame', 'last_frame', 'reference_image'],
    '格式可表达首帧、尾帧与多张参考图（第三方沿用时常自行扩展）',
  );
  assert.deepEqual(
    [...entry.declaredEndpointKeys],
    ['videos', 'videoById', 'videoContent'],
    '异步族用到提交 / 查询 / 内容三个 endpoint 键',
  );

  // 接口格式声明是 endpoint 的唯一事实源，这里给出显式期望值
  const formatLookup = getInterfaceFormat('openai-video-v1');
  assert.equal(formatLookup.kind, 'ready');
  if (formatLookup.kind !== 'ready') return;
  const declaredEndpoints = formatLookup.format.transport.endpoints;
  assert.equal(declaredEndpoints['videos'], '/v1/videos');
  assert.equal(declaredEndpoints['videoById'], '/v1/videos/{id}');
  assert.equal(declaredEndpoints['videoContent'], '/v1/videos/{id}/content');

  // 素材位守卫：三种图片位放行；视频/音频参考位本族表达不了
  assert.equal(checkFamilyMediaSlotSupport('openai-video-v1', ['first_frame']).kind, 'ok');
  assert.equal(checkFamilyMediaSlotSupport('openai-video-v1', ['reference_image']).kind, 'ok');
  assert.equal(checkFamilyMediaSlotSupport('openai-video-v1', ['first_frame', 'last_frame']).kind, 'ok');
  assert.equal(checkFamilyMediaSlotSupport('openai-video-v1', ['reference_video']).kind, 'unsupported');
});

void test('openai-video 族模板：两种素材位形态都构建出合法 sources 并走通合成投影路径', () => {
  const shapes: ReadonlyArray<readonly GenerationMediaSlotId[]> = [
    [],
    ['first_frame'],
    ['first_frame', 'last_frame', 'reference_image'],
  ];
  for (const shape of shapes) {
    const { projection, localizationBundle } = projectTemplate(shape);
    assert.equal(projection.model_id, MODEL_ID, `形态 ${JSON.stringify(shape)} 的 model_id`);
    assert.equal(projection.role, 'generator');
    assert.deepEqual(projection.capability.output_modalities, ['video'], '输出恒为视频');
    assert.equal(projection.capability.supports_async_task, true, '异步任务能力恒成立');
    assert.deepEqual(projection.ports.outputs.map((port) => port.id), ['video']);
    assert.equal(
      localizationBundle.namespace,
      `model-asset/${declaredGenerationPackageId(OPENAI_VIDEO_V1_FAMILY_ADAPTER_ID)}`,
    );
    // 标签必须走本地化命名空间键（投影处不硬编码文案）
    assert.ok(
      projection.parameter_schema.fields.every((field) => field.label.startsWith('model-asset/')),
      '字段标签必须是命名空间本地化键',
    );
    // 输入端口与勾选的素材位严格一一对应（不多不少）
    assert.deepEqual(
      projection.ports.inputs.map((port) => port.field_key),
      [
        ...(shape.includes('first_frame') ? ['inputReference'] : []),
        ...(shape.includes('last_frame') ? ['lastFrame'] : []),
        ...(shape.includes('reference_image') ? ['referenceImage'] : []),
      ],
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

void test('openai-video 族模板：提交端点是 multipart，不写死 content-type（boundary 由运行时生成）', () => {
  for (const shape of [[], ['first_frame'], ['first_frame', 'last_frame', 'reference_image']] as ReadonlyArray<readonly GenerationMediaSlotId[]>) {
    const sources = buildBaseTemplateSources(MODEL_ID, { acceptedMediaSlots: shape });
    const runtime = runtimeOf(sources);
    assert.equal(runtime['payload_format'], 'multipart', '提交恒为 multipart');
    assert.equal(runtime['url_input_upload_mode'], undefined, '不声明公网中转');
    assert.equal(runtime['payload_format_rule'], undefined, '静态 payload_format，无需条件求值');

    const rules = payloadRulesOf(sources);
    assert.deepEqual(rules['api.endpoint'], { kind: 'literal', value: '/v1/videos' });
    assert.deepEqual(rules['api.method'], { kind: 'literal', value: 'POST' });
    assert.deepEqual(rules['api.contentType'], { kind: 'literal', value: null }, 'content-type 交给 FormData');
    assert.deepEqual(rules['body.model'], { kind: 'literal', value: MODEL_ID }, '模型身份在表单字段，派发前注入');
    assert.equal('body.input_reference' in rules, shape.includes('first_frame'), '首帧分支只为勾选的素材位生成');
    assert.equal('body.last_frame' in rules, shape.includes('last_frame'), '尾帧分支只为勾选的素材位生成');
    assert.equal('body.reference_image' in rules, shape.includes('reference_image'), '参考图分支只为勾选的素材位生成');
    if (shape.includes('reference_image')) {
      assert.equal(
        (rules['body.reference_image'] as { truthy?: { multipart_array_naming?: unknown } }).truthy?.multipart_array_naming,
        'repeated',
        '参考图必须按同名重复 part 发送',
      );
    }
  }
});

void test('openai-video 族模板：异步轮询策略逐字段钉死（不声明产物证据路径）', () => {
  for (const shape of [[], ['first_frame'], ['first_frame', 'last_frame', 'reference_image']] as ReadonlyArray<readonly GenerationMediaSlotId[]>) {
    const sources = buildBaseTemplateSources(MODEL_ID, { acceptedMediaSlots: shape });
    const strategy = pollingStrategyOf(sources);

    // 查询请求：GET job 资源，无 header 无 body（{id} 由轮询层替换）。
    assert.deepEqual(strategy['request'], {
      url_template: '/v1/videos/{id}',
      method: 'GET',
      headers: {},
      query: [],
      body: null,
      body_format: 'json',
      content_type: null,
    }, `形态 ${JSON.stringify(shape)} 的轮询请求形态`);

    const polling = strategy['polling'];
    assert.ok(isObjectRecord(polling) && !Array.isArray(polling), 'polling 段必须是对象');
    assert.equal(polling['intervalMs'], 10000);
    assert.equal(polling['maxAttempts'], 500, '视频长任务沿用长轮询上限');
    assert.deepEqual(polling['statusFieldPaths'], ['status', 'data.status', 'state']);
    // 查询响应只带状态：不得声明任何产物证据路径（含把状态路径写进证据位）。
    assert.equal(
      Object.prototype.hasOwnProperty.call(polling, 'successFieldPaths'),
      false,
      '不得声明 successFieldPaths（产物由结果获取阶段从内容端点取）',
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(polling, 'successPath'),
      false,
      '不得声明 successPath（状态路径不是产物证据）',
    );
    assert.deepEqual(polling['successStatuses'], ['completed', 'succeeded', 'success', 'done']);
    assert.deepEqual(polling['failureStatuses'], ['failed', 'error', 'cancelled', 'canceled']);
    assert.deepEqual(polling['failureCodePaths'], ['error.code', 'data.error.code']);
    assert.deepEqual(polling['failureMessagePaths'], ['error.message', 'message', 'data.error.message']);
  }
});

void test('openai-video 族模板：无产物证据路径时，状态命中即在首轮判定成功', () => {
  const sources = buildBaseTemplateSources(MODEL_ID, { acceptedMediaSlots: [] });
  const polling = pollingStrategyOf(sources)['polling'];
  assert.ok(isObjectRecord(polling) && !Array.isArray(polling));
  const pollingForJudge = toRecord(polling);

  // 真实判定函数：无产物路径 + 状态命中 → 返回命中的状态值（首轮即成功）。
  assert.equal(
    resolvePollingSuccessValue(pollingForJudge, { id: 'video_a', status: 'completed' }),
    'completed',
    '状态命中必须直接判定成功，不得因缺少产物地址而继续轮询',
  );
  assert.equal(
    resolvePollingSuccessValue(pollingForJudge, { id: 'video_a', status: 'succeeded' }),
    'succeeded',
    '同义词状态同样命中',
  );
  assert.equal(
    resolvePollingSuccessValue(pollingForJudge, { id: 'video_a', data: { status: 'done' } }),
    'done',
    '嵌套状态路径同样命中',
  );
  assert.equal(
    resolvePollingSuccessValue(pollingForJudge, { id: 'video_a', status: 'in_progress' }),
    undefined,
    '未完成时不得收口成功',
  );
});

void test('openai-video 族模板：异步结果规则、结果获取与输出映射（binary + 同源鉴权）', () => {
  const sources = buildBaseTemplateSources(MODEL_ID, { acceptedMediaSlots: [] });

  // ① 异步任务：提交响应的 id 是后续查询与内容获取的标识。
  assert.deepEqual(sources.runtimeModel['result_rule'], {
    mode: 'async',
    submit_response_id_path: 'id',
  }, '提交响应是 job 对象，id 即远端任务标识');

  // ② 获取策略：内容端点 + binary + 同源鉴权；标识来自轮询冻结的 remoteRequestId。
  const acquisition = acquisitionStrategyOf(sources);
  assert.equal(acquisition['acquisition_mode'], 'fetch_final_result');
  assert.equal(acquisition['identity_source'], 'remote_request_id');
  assert.equal(acquisition['accept'], 'binary');
  assert.equal(acquisition['media_type'], 'video');
  assert.equal(acquisition['requires_auth'], true);
  assert.deepEqual(acquisition['request_strategy'], {
    request_stage: 'acquisition',
    protocol: 'http',
    endpoint: '/v1/videos/{id}/content',
    method: 'GET',
  }, '内容端点模板的 {id} 由获取阶段替换');
  // 取结果请求的固定请求头随策略冻结（该格式没有固定头，空对象而不是缺键）。
  assert.deepEqual(acquisition['request_headers'], {});

  // ③ 输出映射：沿保留路径取产物（获取阶段写入），下载链路据 requires_auth 注入鉴权。
  const mapping = resultOutputMappingOf(sources);
  assert.equal(mapping['response_mode'], 'structured_payload');
  assert.equal(mapping['requires_auth'], true);
  assert.deepEqual(mapping['output_mapping_rules'], [
    {
      target: 'output.video_url',
      source: { kind: 'response', path: '__acquired_media_url' },
      required: true,
    },
  ], '目标名与配方合入侧一致，路径是结果获取阶段的保留键');

  // 真实响应 → 真实消费函数：获取阶段写入内容地址后必须解析出 video 输出。
  const outputs = extractMappedTaskOutputs({
    taskRecord: {
      metadata: {
        taskExecutionPlan: { result_output_mapping: mapping },
      },
    },
    responseBody: {
      status: 'completed',
      id: 'video_abc123',
      __acquired_media_url: 'https://media.example.invalid/openai-video-out.mp4',
    },
  });
  assert.deepEqual(
    outputs.map((output) => ({ mediaType: output.mediaType, url: output.url })),
    [{ mediaType: 'video', url: 'https://media.example.invalid/openai-video-out.mp4' }],
    '保留路径必须被解析成 video 输出',
  );

  // 没有获取结果（未写保留路径）时不得产出输出条目。
  const pendingOutputs = extractMappedTaskOutputs({
    taskRecord: { metadata: { taskExecutionPlan: { result_output_mapping: mapping } } },
    responseBody: { status: 'in_progress', id: 'video_abc123' },
  });
  assert.deepEqual(pendingOutputs, [], '未取到内容地址时不得产出输出条目');
});

void test('openai-video 族模板：首帧素材位可选（不勾不发、留空不发、填写成为文件 part）', async () => {
  // ① 不勾首帧：规则里没有 input_reference 引用。
  const withoutSlot = payloadRulesOf(buildBaseTemplateSources(MODEL_ID, { acceptedMediaSlots: [] }));
  assert.equal('body.input_reference' in withoutSlot, false, '未勾选的素材位不得出现在请求规则里');

  // ② 勾选但留空：条件分支 falsy → null（form-data 序列化丢弃 null，不上 wire）。
  const emptyBody = await evaluateSubmitBody(['first_frame'], {
    __prompt: '  a cat  ',
    seconds: '8',
    size: '1280x720',
    inputReference: [],
  });
  assert.equal(emptyBody['input_reference'], null, '留空时条件分支给 null');
  assert.equal(emptyBody['prompt'], 'a cat', '提示词 trim');

  // ③ 勾选并填写：产出 multipart 文件占位符（不是 URL、不是 inline_data）。
  const filledBody = await evaluateSubmitBody(['first_frame'], {
    __prompt: 'a cat',
    seconds: '8',
    size: '1280x720',
    inputReference: ['https://media.example.invalid/first-frame.png'],
  });
  const reference = filledBody['input_reference'];
  assert.ok(isObjectRecord(reference) && !Array.isArray(reference), '首帧取值必须是媒体占位符');
  assert.equal(reference['transport'], 'multipart_file', '首帧必须走 multipart 文件传输');
  const source = reference['source'];
  assert.ok(isObjectRecord(source) && !Array.isArray(source));
  assert.equal(source['url'], 'https://media.example.invalid/first-frame.png');

  // ④ 序列化：文件字段名必须是 input_reference；null 不产生任何 part。
  const withFile = convertBodyToSerializedFormData({
    ...filledBody,
    input_reference: Buffer.from('fake-png'),
  });
  assert.deepEqual(
    withFile.__formData.files.map((file) => file.name),
    ['input_reference'],
    '首帧文件 part 名必须是 OpenAI 格式的 input_reference',
  );

  const withoutFile = convertBodyToSerializedFormData(emptyBody);
  assert.deepEqual(withoutFile.__formData.files, [], '留空时不得产生文件 part');
  assert.deepEqual(
    withoutFile.__formData.fields.map((field) => field.name).sort(),
    ['model', 'prompt', 'seconds', 'size'],
    '留空时只有标量表单字段（null 被丢弃）',
  );
});

void test('openai-video 族模板：multipart wire 的 model 字段注入 remote_model_id，不会被序列化丢弃', async () => {
  const body = await evaluateSubmitBody(['first_frame'], {
    __prompt: 'a cat',
    seconds: '4',
    size: '1280x720',
    inputReference: [],
  });
  // 注入前：body.model 是产品 model_id 字面量。
  assert.equal(body['model'], MODEL_ID);
  assert.equal(body['input_reference'], null);

  // 输入准备阶段把 body 转成 SerializedFormDataBody（真实消费形态）。
  const serialized = convertBodyToSerializedFormData(body);
  assert.equal(
    serialized.__formData.fields.find((field) => field.name === 'model')?.value,
    MODEL_ID,
    '序列化后 model 表单字段携带产品 model_id（注入前的占位值）',
  );

  const snapshot = ExecutionSnapshotSchema.parse({
    snapshot_id: 'snap_openai_video_test',
    model_id: MODEL_ID,
    model_version: '1.0.0',
    deployment_id: 'up_dep_openai_video_test',
    connection_id: 'up_conn_openai_video_test',
    connection_revision: 1,
    adapter_id: 'openai-video-v1',
    adapter_version: '1.0.0',
    base_url: 'https://provider.example',
    remote_model_id: 'vendor-video-model-x',
    credential_ref: 'cred_openai_video_test',
    credential_version: 1,
    resolved_endpoint: 'https://provider.example/v1/videos',
    created_at: new Date().toISOString(),
  });
  const injected = applyRemoteModelInjection({ snapshot, url: '/v1/videos', body: serialized });
  assert.ok(isSerializedFormDataBody(injected.body), 'multipart body 必须保持 SerializedFormDataBody 形态');
  if (!isSerializedFormDataBody(injected.body)) return;
  assert.equal(
    injected.body.__formData.fields.find((field) => field.name === 'model')?.value,
    'vendor-video-model-x',
    'remote_model_id 必须替换 multipart 的 model 表单字段',
  );

  // 真实 wire：FormData 上 model 是 remote_model_id，content-type 交给 FormData 生成。
  const headers = new Headers();
  const wire = buildRequestBody(injected.body, headers);
  assert.ok(wire instanceof FormData, 'multipart wire body 必须是 FormData');
  if (!(wire instanceof FormData)) return;
  assert.equal(wire.get('model'), 'vendor-video-model-x');
  assert.equal(wire.get('prompt'), 'a cat');
  assert.equal(wire.get('seconds'), '4');
  assert.equal(wire.get('input_reference'), null, '未选择首帧时不得出现该文件字段');
  assert.equal(headers.get('content-type'), null, '不得预先写死 content-type（boundary 由 FormData 生成）');
});

void test('openai-video 族模板：参数描述端点数据（素材位不进官方参数区，首帧文件键保留）', () => {
  const descriptorResult = buildFormatParameterDescriptor(OPENAI_VIDEO_V1_FAMILY_ADAPTER_ID);
  assert.equal(descriptorResult.kind, 'ready');
  if (descriptorResult.kind !== 'ready') return;
  const descriptor = descriptorResult.descriptor;
  assert.equal(descriptor.family_adapter_id, OPENAI_VIDEO_V1_FAMILY_ADAPTER_ID);
  assert.deepEqual(
    descriptor.official_fields.map((field) => field.field_key),
    ['seconds', 'size'],
    '素材位字段不进官方参数区（归属由记录的 accepted_media_slots 管控）',
  );
  assert.deepEqual(
    descriptor.official_fields.map((field) => field.wire_name),
    ['seconds', 'size'],
    'wire 名来自 body.seconds / body.size 两个 target',
  );
  const seconds = descriptor.official_fields.find((field) => field.field_key === 'seconds');
  assert.deepEqual(seconds?.enum_options, ['4', '8', '12', '16', '20']);
  const size = descriptor.official_fields.find((field) => field.field_key === 'size');
  assert.deepEqual(size?.enum_options, ['1280x720', '720x1280', '1920x1080', '1080x1920']);

  // 保留键必须覆盖协议键与全素材位分支（input_reference 是 multipart 文件字段名，不得被自定义参数占用）
  for (const reserved of ['model', 'prompt', 'seconds', 'size', 'input_reference']) {
    assert.ok(descriptor.reserved_wire_names.body.includes(reserved), `保留键必须包含 ${reserved}`);
  }
});

void test('openai-video 族模板：时长/尺寸档位可被记录级参数收窄（族默认保持常见的全档）', () => {
  const sources = buildBaseTemplateSources(MODEL_ID, { acceptedMediaSlots: [] });
  const fields = parameterFieldsOf(sources);
  const seconds = fields.find((field) => field['field_key'] === 'seconds');
  assert.ok(seconds, 'seconds 字段必须存在');
  assert.equal(seconds['default_value'], '4');
  assert.deepEqual(
    seconds['enum_options'],
    ['4', '8', '12', '16', '20'].map((value) => ({ value, label: `fields.seconds.options.seconds_${value}.label` })),
    '族默认给历史常见档位',
  );
  const size = fields.find((field) => field['field_key'] === 'size');
  assert.ok(size, 'size 字段必须存在');
  assert.equal(size['default_value'], '1280x720');
  assert.deepEqual(
    size['enum_options'],
    ['1280x720', '720x1280', '1920x1080', '1080x1920'].map((value) => ({
      value,
      label: `fields.size.options.preset_${value}.label`,
    })),
  );
});

void test('openai-video 族模板：素材位改名与张数经参数覆盖落到 multipart part 与画布端口', async () => {
  const slots = ['first_frame', 'last_frame', 'reference_image'] as const;
  const base = buildBaseTemplateSources(MODEL_ID, { acceptedMediaSlots: [...slots] });
  const overrides = {
    official: [
      { field_key: 'lastFrame', wire_name: 'tail_image' },
      { field_key: 'referenceImage', media_max_files: 3 },
    ],
    custom: [],
  };
  assert.deepEqual(validateParameterOverrides(base, overrides), [], '合法覆盖必须放行');
  const merged = applyParameterOverrides(base, overrides);

  // ① 规则落点：尾帧 target 随发送名改写；参考图保留同名重复命名。
  const rules = payloadRulesOf(merged);
  assert.equal('body.last_frame' in rules, false, '旧发送名不得残留');
  const tailRule = rules['body.tail_image'];
  assert.ok(isObjectRecord(tailRule) && !Array.isArray(tailRule), '新发送名必须承载尾帧规则');
  const refRule = rules['body.reference_image'];
  assert.ok(isObjectRecord(refRule) && !Array.isArray(refRule), '参考图规则必须存在');
  assert.equal(
    (refRule['truthy'] as { multipart_array_naming?: unknown } | undefined)?.multipart_array_naming,
    'repeated',
    '多图必须按同名重复 part 发送',
  );

  // ② 求值 → 输入准备（占位符换 Buffer）→ 序列化：尾帧一个 part、参考图三个同名 part。
  const body = await evaluateSubmitBodyFromSources(merged, {
    __prompt: 'a cat',
    seconds: '8',
    size: '1280x720',
    inputReference: [],
    lastFrame: ['https://media.example.invalid/last.png'],
    referenceImage: [
      'https://media.example.invalid/ref-1.png',
      'https://media.example.invalid/ref-2.png',
      'https://media.example.invalid/ref-3.png',
    ],
  });
  assert.equal(body['input_reference'], null, '首帧留空时不上 wire');
  assert.equal(Array.isArray(body['reference_image']), true, '参考图取值必须是数组');

  const serialized = convertBodyToSerializedFormData(
    {
      ...body,
      tail_image: Buffer.from('tail-frame'),
      reference_image: [Buffer.from('r1'), Buffer.from('r2'), Buffer.from('r3')],
    },
    new Set(['reference_image']),
  );
  assert.deepEqual(
    serialized.__formData.files.map((file) => file.name).sort(),
    ['reference_image', 'reference_image', 'reference_image', 'tail_image'],
    '改名后的尾帧与三张参考图必须成为对应名字的文件 part',
  );

  // ③ 画布端口与能力声明跟随张数（表单 / 画布 / 能力三处同值）。
  const node = merged.node;
  const ports = node['input_ports'];
  assert.ok(Array.isArray(ports), 'node 必须带输入端口');
  const refPort = ports
    .map((port) => (isObjectRecord(port) && !Array.isArray(port) ? port : null))
    .find((port) => port !== null && port['field_key'] === 'referenceImage');
  assert.ok(refPort, '参考图端口必须存在');
  assert.equal(refPort['multiple'], true);
  assert.equal(refPort['max_connections'], 3);
  const capability = merged.runtimeModel['capability'];
  assert.ok(isObjectRecord(capability) && !Array.isArray(capability));
  assert.equal(capability['supports_multi_image'], true, '张数 >1 时多图能力必须升为 true');

  // ④ 张数不是产品侧硬上限：填多大都放行，超限由上游拒绝。
  assert.deepEqual(
    validateParameterOverrides(base, {
      official: [{ field_key: 'referenceImage', media_max_files: 60 }],
      custom: [],
    }),
    [],
    '产品侧不得设置张数上限',
  );
});

void test('openai-video 族模板接缝：真实输入准备层按投影里的媒体目标推导同名重复 part', async () => {
  const slots = ['first_frame', 'last_frame', 'reference_image'] as const;
  const base = buildBaseTemplateSources(MODEL_ID, { acceptedMediaSlots: [...slots] });
  const merged = applyParameterOverrides(base, {
    official: [
      { field_key: 'lastFrame', wire_name: 'tail_image' },
      { field_key: 'referenceImage', media_max_files: 3 },
    ],
    custom: [],
  });
  const { projection } = buildProjectionFromPackageSources({
    packageId: declaredGenerationPackageId(OPENAI_VIDEO_V1_FAMILY_ADAPTER_ID),
    entryModelModelId: MODEL_ID,
    protocolFormat: undefined,
    runtimeModel: merged.runtimeModel,
    node: merged.node,
    localizationResources: merged.localizationResources,
  });

  // 内联图片：输入准备层据媒体目标把占位符换成字节，无需读磁盘。
  const inlineImage = { kind: 'inline_data', data: 'aGVsbG8=', mimeType: 'image/png' };
  const body = await evaluateSubmitBodyFromSources(merged, {
    __prompt: 'a cat',
    seconds: '8',
    size: '1280x720',
    inputReference: [],
    lastFrame: [inlineImage],
    referenceImage: [inlineImage, inlineImage, inlineImage],
  });

  const prepared = await prepareModelInputForRequest({
    modelId: MODEL_ID,
    projectPath: null,
    body,
    projection,
  });
  assert.equal(prepared.ok, true, `输入准备必须成功：${prepared.ok ? '' : prepared.error.message}`);
  if (!prepared.ok) return;
  assert.equal(isSerializedFormDataBody(prepared.body), true, 'multipart 提交必须序列化成 form-data');
  const formData = (prepared.body as { __formData: { files: Array<{ name: string }>; fields: Array<{ name: string }> } }).__formData;
  assert.deepEqual(
    formData.files.map((file) => file.name).sort(),
    ['reference_image', 'reference_image', 'reference_image', 'tail_image'],
    '三张参考图必须由真实准备层展成同名重复 part，尾帧用覆盖后的发送名',
  );
  assert.equal(
    formData.fields.some((field) => field.name === 'input_reference'),
    false,
    '留空的首帧不上 wire',
  );
});
