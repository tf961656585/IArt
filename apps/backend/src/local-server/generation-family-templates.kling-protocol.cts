import type { GenerationMediaSlotId } from '@iart/contracts';
import type { JsonObject } from './model-package-catalog.types.cts';

/**
 * 可灵三族（文生视频 / 图生视频 / 全模态视频）共用的**协议事实**模块。
 *
 * **本模块不是族模板**：它不导出任何 `familyAdapterId`、不导出 `build*BaseTemplateSources`、
 * 不被注册表登记为一族，也不被一致性门禁当作一族遍历。它只是三份模板共同引用的纯函数与常量
 * 库——所以「三族轮询规则不重复三份」与「模板之间不得互相引用或继承」同时成立：
 *
 * - 不重复：轮询 / 结果规则 / 结果映射 / 官方参数档位 / settings 组装 / 素材位字段与单媒体
 *   entry 的**唯一实现**在本文件，三族各自 import 这些叶子函数；
 * - 不互相引用：三族模板文件彼此不 import，也不继承任何「基础模板」；每份模板产物（内存态
 *   sources）自身就携带完整的 endpoint、payload_rules、轮询与结果规则，运行时不依赖另一族
 *   的模板存在。共享的是「协议常量与叶子规则构造」，不是「模板骨架的层层继承」。
 *
 * 事实来源（2026-10-19 实测三个在役包 `kling-v3-text2video` / `-image2video` / `-omni-video`，
 * 与 `docs/provider-remote-apis/07-Kling-视频生成接口.md` 对齐）：三族的
 * polling_strategy / result_rule / result_output_mapping 逐字段一致；差异只在提交端点、请求体
 * 的 contents/prompt 形态、settings 是否含 aspect_ratio、audio 取值集合，以及素材位清单。
 *
 * 注意：可灵新标准把模型版本写死在 path 段（`/text-to-video/kling-3.0` 等），提交路径**不含**
 * `{model}` 占位符；remote_model_id 注入对本族是惰性的（分类事实见
 * `provider-connection/remote-model-injection.cts` 的 `ADAPTER_IDS_WITH_URL_MODEL_TEMPLATE`）。
 * 本模块与三族模板都不得制造 `{model}` 占位符。
 */

/** 统一异步查询端点（与适配器 `relative_endpoints.taskById` 同值，`{id}` 由轮询层替换）。 */
export const KLING_TASK_BY_ID_ENDPOINT = '/tasks?task_ids={id}';

/** 分辨率档位（官方 720p / 1080p / 4k，默认 720p）。 */
export const KLING_RESOLUTION_VALUES = ['720p', '1080p', '4k'] as const;
export const KLING_RESOLUTION_FALLBACK = '720p';

/** 画幅比例（官方 16:9 / 9:16 / 1:1，默认 16:9）。图生视频的 settings 没有该字段。 */
export const KLING_RATIO_VALUES = ['16:9', '9:16', '1:1'] as const;
export const KLING_RATIO_FALLBACK = '16:9';

/** 时长档（官方 3–15 秒整数，默认 5 秒）。 */
export const KLING_DURATION_VALUES = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const;
export const KLING_DURATION_FALLBACK = 5;

/** 音频档：文生 / 图生只有 native / off；全模态多一档 original（保留参考视频原声）。 */
export const KLING_TEXT_AUDIO_VALUES = ['native', 'off'] as const;
export const KLING_OMNI_AUDIO_VALUES = ['native', 'original', 'off'] as const;

export const KLING_DEFAULT_MULTI_SHOT = true;
export const KLING_DEFAULT_WATERMARK = false;

/**
 * 异步轮询策略：三族逐字段一致（实测三包相同）。
 *
 * 查询请求是 GET、无 header、无 body（`headers:{}` / `body:null` 与包一致）；`{id}` 由轮询层
 * 用提交响应 `/data/id` 替换。`failureCodePaths` 为空是实测事实：可灵失败码不是独立路径，
 * 失败原因只从 message 取，不臆造 code 路径。
 *
 * 每次调用返回**新对象**：模板产物之间不得共享同一棵 JSON 树（后续参数覆盖会 clone，但共享
 * 引用在求值期被就地改写时会出现跨族串味）。
 */
export const buildKlingPollingStrategy = (): JsonObject => ({
  request: {
    url_template: KLING_TASK_BY_ID_ENDPOINT,
    method: 'GET',
    headers: {},
    body: null,
  },
  polling: {
    intervalMs: 3000,
    maxAttempts: 500,
    successFieldPaths: ['data.0.outputs.0.url', 'data.0.status'],
    successStatuses: ['succeeded'],
    statusFieldPaths: ['data.0.status', 'data.status', 'status'],
    failureStatuses: ['failed', 'failure', 'error'],
    failureCodePaths: [],
    failureMessagePaths: ['data.0.message', 'data.message', 'message'],
  },
});

/** 异步结果规则：提交响应的 `/data/id` 是后续查询的任务 id（三族一致）。 */
export const buildKlingResultRule = (): JsonObject => ({
  mode: 'async',
  submit_response_id_path: '/data/id',
});

/** 结果映射：`output.video_url ← data[].outputs[].url`（required:false，查询可能先回状态后回地址）。 */
export const buildKlingResultOutputMapping = (): JsonObject => ({
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
});

/** 枚举型请求参数的 wire 收敛（allowed_values 与表单枚举同源：档位常量是唯一事实）。 */
export const buildKlingNormalizeEnumRule = (options: {
  cacheKey: string;
  fieldKey: string;
  allowedValues: readonly (string | number)[];
  fallback: string | number;
  transforms?: readonly string[];
}): JsonObject => ({
  kind: 'compute',
  operator: 'normalize_enum',
  cache_key: options.cacheKey,
  args: [
    {
      kind: 'field',
      field_key: options.fieldKey,
      ...(options.transforms === undefined ? {} : { transforms: [...options.transforms] }),
    },
  ],
  options: { allowed_values: [...options.allowedValues], fallback: options.fallback },
});

/**
 * 提示词：官方要求非空。`assert_non_empty` 让空提示词在**本地组装期**以可读原因失败，
 * 而不是发出去等上游拒（与在役包同构）。
 */
export const buildKlingPromptRule = (cacheKey: string): JsonObject => ({
  kind: 'compute',
  operator: 'assert_non_empty',
  cache_key: cacheKey,
  args: [{ kind: 'field', field_key: '__prompt', transforms: ['trim'] }],
  options: { message: '请填写提示词。' },
});

/**
 * `body.settings.*`（三族差异的唯一承载点）。
 *
 * - `includeAspectRatio`：文生视频与全模态有 `aspect_ratio`，**图生视频没有**（官方字段表只列
 *   multi_shot / audio / resolution / duration，spec 07 §7.3）——三端点不得复用同一 settings。
 * - `audioValues`：文生/图生 native|off，全模态多一档 original。
 */
export const buildKlingSettingsRules = (options: {
  cacheKeyPrefix: string;
  audioValues: readonly string[];
  includeAspectRatio: boolean;
}): JsonObject => {
  const rules: JsonObject = {
    'body.settings.multi_shot': { kind: 'field', field_key: 'multiShot' },
    'body.settings.audio': buildKlingNormalizeEnumRule({
      cacheKey: `${options.cacheKeyPrefix}.audio`,
      fieldKey: 'audio',
      allowedValues: options.audioValues,
      fallback: 'off',
      transforms: ['trim'],
    }),
    'body.settings.resolution': buildKlingNormalizeEnumRule({
      cacheKey: `${options.cacheKeyPrefix}.resolution`,
      fieldKey: 'resolution',
      allowedValues: KLING_RESOLUTION_VALUES,
      fallback: KLING_RESOLUTION_FALLBACK,
      transforms: ['trim'],
    }),
    'body.settings.duration': buildKlingNormalizeEnumRule({
      cacheKey: `${options.cacheKeyPrefix}.duration`,
      fieldKey: 'duration',
      allowedValues: KLING_DURATION_VALUES,
      fallback: KLING_DURATION_FALLBACK,
      transforms: ['toNumber'],
    }),
  };
  if (options.includeAspectRatio) {
    rules['body.settings.aspect_ratio'] = buildKlingNormalizeEnumRule({
      cacheKey: `${options.cacheKeyPrefix}.aspectRatio`,
      fieldKey: 'aspectRatio',
      allowedValues: KLING_RATIO_VALUES,
      fallback: KLING_RATIO_FALLBACK,
      transforms: ['trim'],
    });
  }
  return rules;
};

/** `body.options.watermark_info.enabled`：开关字段恒有值（false 也要显式发出）。 */
export const buildKlingWatermarkRule = (): JsonObject => ({
  kind: 'when',
  condition: { op: 'truthy', field: 'watermark' },
  truthy: { kind: 'literal', value: true },
  falsy: { kind: 'literal', value: false },
});

/** `meta.*`（本地任务元数据，不发给上游）：taskType 是族内唯一的取值差异。 */
export const buildKlingMetaRules = (options: {
  cacheKeyPrefix: string;
  audioValues: readonly string[];
  includeAspectRatio: boolean;
  taskType: string;
}): JsonObject => {
  const rules: JsonObject = {
    'meta.taskType': { kind: 'literal', value: options.taskType },
    'meta.duration': buildKlingNormalizeEnumRule({
      cacheKey: `${options.cacheKeyPrefix}.duration`,
      fieldKey: 'duration',
      allowedValues: KLING_DURATION_VALUES,
      fallback: KLING_DURATION_FALLBACK,
      transforms: ['toNumber'],
    }),
    'meta.resolution': buildKlingNormalizeEnumRule({
      cacheKey: `${options.cacheKeyPrefix}.resolution`,
      fieldKey: 'resolution',
      allowedValues: KLING_RESOLUTION_VALUES,
      fallback: KLING_RESOLUTION_FALLBACK,
      transforms: ['trim'],
    }),
    'meta.audio': buildKlingNormalizeEnumRule({
      cacheKey: `${options.cacheKeyPrefix}.audio`,
      fieldKey: 'audio',
      allowedValues: options.audioValues,
      fallback: 'off',
      transforms: ['trim'],
    }),
  };
  if (options.includeAspectRatio) {
    rules['meta.aspectRatio'] = buildKlingNormalizeEnumRule({
      cacheKey: `${options.cacheKeyPrefix}.aspectRatio`,
      fieldKey: 'aspectRatio',
      allowedValues: KLING_RATIO_VALUES,
      fallback: KLING_RATIO_FALLBACK,
      transforms: ['trim'],
    });
  }
  return rules;
};

/** 请求体组装规则表尾部的通用键：prompt / input 供后续步骤读取用户原文。 */
export const buildKlingPromptMirrorRules = (): JsonObject => ({
  prompt: { kind: 'field', field_key: '__prompt', transforms: ['trim'] },
  input: { kind: 'field', field_key: '__prompt', transforms: ['trim'] },
});

/** 非素材位的生成参数表单字段（顺序即创作面呈现顺序，与在役包一致）。 */
export const buildKlingParameterFields = (options: {
  audioValues: readonly string[];
  includeAspectRatio: boolean;
}): JsonObject[] => {
  const fields: JsonObject[] = [
    {
      field_key: 'duration',
      label: 'fields.duration.label',
      required: false,
      default_value: KLING_DURATION_FALLBACK,
      validation_rules: [],
      layout: { colSpan: 1 },
      component: 'select',
      enum_options: KLING_DURATION_VALUES.map((value) => ({
        value,
        label: `fields.duration.options.${value}.label`,
      })),
      component_props: {},
    },
    {
      field_key: 'resolution',
      label: 'fields.resolution.label',
      required: false,
      default_value: KLING_RESOLUTION_FALLBACK,
      validation_rules: [],
      layout: { colSpan: 1 },
      component: 'select',
      enum_options: KLING_RESOLUTION_VALUES.map((value) => ({
        value,
        label: `fields.resolution.options.${value}.label`,
      })),
      component_props: {},
    },
  ];
  if (options.includeAspectRatio) {
    fields.push({
      field_key: 'aspectRatio',
      label: 'fields.aspectRatio.label',
      required: false,
      default_value: KLING_RATIO_FALLBACK,
      validation_rules: [],
      layout: { colSpan: 1 },
      component: 'select',
      enum_options: KLING_RATIO_VALUES.map((value) => ({
        value,
        // 比例值的 locales 键用下划线形态（`16:9` → `16_9`）。
        label: `fields.aspectRatio.options.${value.replace(/:/g, '_')}.label`,
      })),
      component_props: {},
    });
  }
  fields.push(
    {
      field_key: 'audio',
      label: 'fields.audio.label',
      required: false,
      default_value: 'off',
      validation_rules: [],
      layout: { colSpan: 1 },
      component: 'select',
      enum_options: options.audioValues.map((value) => ({
        value,
        label: `fields.audio.options.${value}.label`,
      })),
      component_props: {},
    },
    {
      field_key: 'multiShot',
      label: 'fields.multiShot.label',
      required: false,
      default_value: KLING_DEFAULT_MULTI_SHOT,
      validation_rules: [],
      layout: { colSpan: 1 },
      component: 'switch',
      component_props: {},
    },
    {
      field_key: 'watermark',
      label: 'fields.watermark.label',
      required: false,
      default_value: KLING_DEFAULT_WATERMARK,
      validation_rules: [],
      layout: { colSpan: 1 },
      component: 'switch',
      component_props: {},
    },
  );
  return fields;
};

/**
 * 素材位字段事实（同一素材位在各族的表单形态一致）。
 *
 * 图片用 `imageUpload`，视频用 `file`——`MODEL_ASSET_SUPPORTED_FIELD_COMPONENTS` 没有
 * videoUpload，`file` 是唯一承载非图像素材的组件。`data_source` 一律不声明：输入端口在
 * node_definition 里逐位显式声明（`file` 组件推导出的 data_type 是 url，会把视频端口降级）。
 */
export const KLING_MEDIA_SLOT_FIELD_FACTS: ReadonlyArray<{
  slot: GenerationMediaSlotId;
  fieldKey: string;
  component: 'imageUpload' | 'file';
  accept: string;
  maxFiles: number;
}> = [
  {
    slot: 'first_frame',
    fieldKey: 'firstFrameImage',
    component: 'imageUpload',
    accept: 'image/png,image/jpeg,image/webp,image/*',
    maxFiles: 1,
  },
  {
    slot: 'last_frame',
    fieldKey: 'lastFrameImage',
    component: 'imageUpload',
    accept: 'image/png,image/jpeg,image/webp,image/*',
    maxFiles: 1,
  },
  {
    slot: 'reference_image',
    fieldKey: 'referImage',
    component: 'imageUpload',
    accept: 'image/png,image/jpeg,image/webp,image/*',
    maxFiles: 1,
  },
  {
    slot: 'feature_video',
    fieldKey: 'featureVideo',
    component: 'file',
    accept: 'video/mp4,video/quicktime,video/*',
    maxFiles: 1,
  },
  {
    slot: 'base_video',
    fieldKey: 'baseVideo',
    component: 'file',
    accept: 'video/mp4,video/quicktime,video/*',
    maxFiles: 1,
  },
];

/**
 * 只为 `accepted` 里出现的素材位生成表单字段（族模板的素材位驱动口径）。
 *
 * 「必填」不是素材位的属性、而是**族**的属性：首帧在图生视频族必填（官方 `first_frame` 必填），
 * 在全模态族可选（官方只在组合语义上约束），因此由调用方显式声明 `firstFrameRequired`——
 * 素材位词表本身没有必填语义（`GENERATION_MEDIA_SLOT_IDS` 只有 id），必填性不能藏在共享的
 * 字段事实表里。
 */
export const buildKlingMediaSlotFields = (
  accepted: ReadonlySet<GenerationMediaSlotId>,
  options: { firstFrameRequired?: boolean } = {},
): JsonObject[] =>
  KLING_MEDIA_SLOT_FIELD_FACTS.filter((fact) => accepted.has(fact.slot)).map((fact) => {
    const componentProps: JsonObject = { accept: fact.accept, maxFiles: fact.maxFiles };
    if (fact.component === 'file') componentProps.allowMultiple = false;
    return {
      field_key: fact.fieldKey,
      label: `fields.${fact.fieldKey}.label`,
      description: `fields.${fact.fieldKey}.description`,
      required: fact.slot === 'first_frame' && options.firstFrameRequired === true,
      default_value: [],
      validation_rules: [],
      layout: { colSpan: 2 },
      component: fact.component,
      component_props: componentProps,
    };
  });

/** 素材位字段键（供 payload_rules 与输入端口同源引用）。 */
export const klingMediaSlotFieldKey = (slot: GenerationMediaSlotId): string | null => {
  const fact = KLING_MEDIA_SLOT_FIELD_FACTS.find((item) => item.slot === slot);
  return fact === undefined ? null : fact.fieldKey;
};

/**
 * 单媒体 `contents` 条目：`{ type, url }`，url 取该字段首个公网 URL。
 *
 * `requireNonEmpty` 用于官方必填位（图生视频首帧）：值缺失时在本地组装期以可读原因失败，
 * 不发一个注定被上游拒的请求。
 */
export const buildKlingSingleMediaEntry = (options: {
  type: string;
  fieldKey: string;
  cacheKey?: string;
  requireNonEmptyMessage?: string;
}): JsonObject => {
  const fieldRule: JsonObject = {
    kind: 'field',
    field_key: options.fieldKey,
    transforms: ['extractFirstUrl'],
    media_target: 'public_url',
  };
  const urlRule: JsonObject =
    options.requireNonEmptyMessage === undefined
      ? fieldRule
      : {
          kind: 'compute',
          operator: 'assert_non_empty',
          ...(options.cacheKey === undefined ? {} : { cache_key: options.cacheKey }),
          args: [fieldRule],
          options: { message: options.requireNonEmptyMessage },
        };
  return {
    kind: 'compute',
    operator: 'object',
    entries: {
      type: { kind: 'literal', value: options.type },
      url: urlRule,
    },
  };
};

/** 「该素材位填了就产出这一条」的条件分支（判空口径 `ne []`，与在役包一致）。 */
export const buildKlingMediaWhenBranch = (options: {
  fieldKey: string;
  type: string;
}): JsonObject => ({
  kind: 'when',
  condition: { op: 'ne', field: options.fieldKey, value: [] },
  truthy: buildKlingSingleMediaEntry({ type: options.type, fieldKey: options.fieldKey }),
  falsy: { kind: 'literal', value: null },
});

/** capability 声明（三族差异只在输入模态与素材支持布尔）。 */
export const buildKlingCapability = (options: {
  inputModalities: readonly string[];
  supportsMultiImage: boolean;
  supportsReferenceMedia: boolean;
}): JsonObject => ({
  input_modalities: [...options.inputModalities],
  output_modalities: ['video'],
  supports_async_task: true,
  supports_streaming: false,
  supports_multi_image: options.supportsMultiImage,
  supports_reference_media: options.supportsReferenceMedia,
  constraints: [],
});

/**
 * 公网中转声明：只在确实带素材位时出现。
 *
 * 不带任何素材位的形态没有任何 `public_url` 媒体目标，此时声明 public_relay 会被
 * `validateMediaTargetRuleSet` 判为 `url_input_upload_mode_without_public_url_target`（坏包）。
 */
export const buildKlingUrlInputUploadRuntime = (
  accepted: ReadonlySet<GenerationMediaSlotId>,
  targetType: 'self_hosted_image_public_url' | 'cloudflare_image_public_url',
): JsonObject =>
  accepted.size === 0
    ? {}
    : { url_input_upload_mode: 'public_relay', url_input_upload_target_type: targetType };
