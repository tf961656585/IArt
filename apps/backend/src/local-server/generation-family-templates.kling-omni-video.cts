import type { FamilyTemplateParameterDescriptor, GenerationMediaSlotId } from '@iart/contracts';
import type { ModelAssetLocalizationResourceMap } from '@iart/contracts/model-asset-contract';
import type { LocaleResources } from './model-package-catalog.localization.cts';
import type { JsonObject } from './model-package-catalog.types.cts';
import { cloneJsonValue } from '@iart/contracts';
import {
  buildFamilyTemplateParameterDescriptorFromSources,
  toCatalogRawObject,
  type GenerationFamilyTemplateOptions,
  type GenerationFamilyTemplateSources,
} from './generation-family-templates.cts';
import {
  buildKlingCapability,
  buildKlingMediaSlotFields,
  buildKlingMediaWhenBranch,
  buildKlingMetaRules,
  buildKlingParameterFields,
  buildKlingPollingStrategy,
  buildKlingPromptMirrorRules,
  buildKlingPromptRule,
  buildKlingResultOutputMapping,
  buildKlingResultRule,
  buildKlingSettingsRules,
  buildKlingUrlInputUploadRuntime,
  buildKlingWatermarkRule,
  klingMediaSlotFieldKey,
  KLING_OMNI_AUDIO_VALUES,
} from './generation-family-templates.kling-protocol.cts';

/**
 * kling-omni-video-v1 族模板（可灵官方**新设计标准**全模态视频：
 * `POST /omni-video/kling-3.0-omni`，异步任务 + 统一查询端点）。
 *
 * 协议事实来源：`docs/provider-remote-apis/07-Kling-视频生成接口.md` §5/§8/§9 与在役包
 * `kling-v3-omni-video` 的实测规则（2026-10-19）。
 *
 * - **模型身份在 URL path**：`/omni-video/kling-3.0-omni` 的 `kling-3.0-omni` 是 path 的一段，
 *   请求体没有 `model_name` / `model`。本族模板**不生成任何 `body.model` 规则**，也不制造
 *   `{model}` 占位符；remote_model_id 注入对本族惰性（分类事实在
 *   `provider-connection/remote-model-injection.cts`，本批不改分类）。
 * - **请求体是 `contents` 数组**：`[{type:'prompt',text}, …五个素材位分支]`，用
 *   `compact_array` 组装——未填写的素材位求值成 `null` 后被压掉，不产出没有 url 的空壳条目。
 * - **settings 与文生视频同构**：含 `aspect_ratio`；`audio` 比另两族多一档 `original`
 *   （保留参考视频原声）。
 * - **素材位五个**：`first_frame` / `last_frame` / `reference_image` / `feature_video` /
 *   `base_video`，逐位映射到官方 `contents[].type`。本族一个位都不是必填（官方只在语义上
 *   约束「首帧/尾帧成对」「有参考视频时不得同时用参考图」等组合规则，DSL 无法表达跨字段
 *   互斥，见文件末已知边界）。
 * - **公网中转**：`public_relay` + `cloudflare_image_public_url`。本族媒体含**视频**
 *   （`feature_video` / `base_video`），按 AGENTS.md「Public Relay target 能力边界」必须用
 *   通用文件中转目标——`self_hosted_image_public_url` 只服务图像，绝不可用于本族。
 *
 * 五个素材位里 `reference_image` / `feature_video` / `base_video` 是**单值**（官方各最多 1 个），
 * 不是 Seedance 那种多图参考，因此字段 `maxFiles: 1`、`multiple: false`。
 *
 * 模板级 locales 内联在本文件（zh-CN + en），键名与在役包同构；合成投影经
 * buildProjectionFromPackageSources 走与已装包相同的本地化投影路径。
 */

/** 本族适配器 id（值域 owner 仍是 contracts 的 GENERATION_FAMILY_ADAPTER_IDS）。 */
export const KLING_OMNI_VIDEO_V1_FAMILY_ADAPTER_ID = 'kling-omni-video-v1';

/**
 * 本族模板能表达的素材位（五个；一致性事实源：与注册表条目的 supportsMediaSlots 同值）。
 *
 * 顺序即创作面呈现顺序与请求体 contents 顺序（官方 type 枚举顺序）。
 */
export const KLING_OMNI_VIDEO_V1_SUPPORTED_MEDIA_SLOTS = [
  'first_frame',
  'last_frame',
  'reference_image',
  'feature_video',
  'base_video',
] as const satisfies readonly GenerationMediaSlotId[];

/** 提交端点（与适配器 relative_endpoints.omniVideo 同值）。 */
const OMNI_VIDEO_ENDPOINT = '/omni-video/kling-3.0-omni';

const AUDIO_VALUES = KLING_OMNI_AUDIO_VALUES;
const CACHE_KEY_PREFIX = 'klingV3OmniVideo';

/** 素材位 → 官方 `contents[].type`（与在役包逐位一致）。 */
const MEDIA_SLOT_CONTENT_TYPES: ReadonlyArray<{
  slot: GenerationMediaSlotId;
  contentType: string;
}> = [
  { slot: 'first_frame', contentType: 'first_frame' },
  { slot: 'last_frame', contentType: 'last_frame' },
  { slot: 'reference_image', contentType: 'refer_image' },
  { slot: 'feature_video', contentType: 'feature_video' },
  { slot: 'base_video', contentType: 'base_video' },
];

/** 素材位字段键（本族内部对照用；值与协议模块里的字段事实表同源）。 */
const fieldKeyOfSlot = (slot: GenerationMediaSlotId): string => {
  const fieldKey = klingMediaSlotFieldKey(slot);
  if (fieldKey === null) {
    throw new Error(`kling_omni_unknown_media_slot:${slot}`);
  }
  return fieldKey;
};

/** 本族全部素材位（参数描述计算保留键时用「全开形态」覆盖全部 contents 分支）。 */
const ALL_ACCEPTED_SLOTS: ReadonlySet<GenerationMediaSlotId> = new Set<GenerationMediaSlotId>(
  KLING_OMNI_VIDEO_V1_SUPPORTED_MEDIA_SLOTS,
);

const buildParameterSchema = (accepted: ReadonlySet<GenerationMediaSlotId>): JsonObject => {
  // 本族一个素材位都不是必填（组合约束由上游兜底）。
  const mediaFields = buildKlingMediaSlotFields(accepted);
  const parameterFields = buildKlingParameterFields({
    audioValues: AUDIO_VALUES,
    includeAspectRatio: true,
  });
  const defaultValues: JsonObject = {};
  for (const field of [...mediaFields, ...parameterFields]) {
    const fieldKey = field.field_key;
    if (typeof fieldKey !== 'string') continue;
    defaultValues[fieldKey] = field.default_value;
  }
  return {
    schema_type: 'object',
    fields: [...mediaFields, ...parameterFields],
    // 本族没有必填素材位（五个位都可选，组合约束由上游校验兜底，见文件末）。
    required_fields: [],
    default_values: defaultValues,
    validation_rules: [],
  };
};

/**
 * `body.contents` 组装：文本块恒有，五个素材位各一条条件分支（填了才产出）。
 *
 * `compact_array` 压掉 `when` 的 falsy 分支（`null`）。
 */
const buildContentsRule = (accepted: ReadonlySet<GenerationMediaSlotId>): JsonObject => {
  const args: JsonObject[] = [
    {
      kind: 'compute',
      operator: 'object',
      entries: {
        type: { kind: 'literal', value: 'prompt' },
        text: buildKlingPromptRule(`${CACHE_KEY_PREFIX}.prompt`),
      },
    },
  ];
  for (const shape of MEDIA_SLOT_CONTENT_TYPES) {
    if (!accepted.has(shape.slot)) continue;
    args.push(
      buildKlingMediaWhenBranch({
        fieldKey: fieldKeyOfSlot(shape.slot),
        type: shape.contentType,
      }),
    );
  }
  return {
    kind: 'compute',
    operator: 'compact_array',
    cache_key: `${CACHE_KEY_PREFIX}.contents`,
    note: '按记录的素材位组装官方 contents 数组：文本块 + 首帧/尾帧/参考图/特征视频/基础视频各一条条件分支；compact_array 压掉未填写的分支。',
    args,
  };
};

const buildPayloadRules = (accepted: ReadonlySet<GenerationMediaSlotId>): JsonObject => ({
  'api.endpoint': { kind: 'literal', value: OMNI_VIDEO_ENDPOINT },
  'api.method': { kind: 'literal', value: 'POST' },
  'api.contentType': { kind: 'literal', value: 'application/json' },
  'api.responseHandling.mode': { kind: 'literal', value: 'async' },
  'body.contents': buildContentsRule(accepted),
  ...buildKlingSettingsRules({
    cacheKeyPrefix: CACHE_KEY_PREFIX,
    audioValues: AUDIO_VALUES,
    // 全模态与文生视频同构：settings 含 aspect_ratio。
    includeAspectRatio: true,
  }),
  'body.options.watermark_info.enabled': buildKlingWatermarkRule(),
  ...buildKlingMetaRules({
    cacheKeyPrefix: CACHE_KEY_PREFIX,
    audioValues: AUDIO_VALUES,
    includeAspectRatio: true,
    taskType: 'omniVideo',
  }),
  ...buildKlingPromptMirrorRules(),
});

/** 输入端口：只为勾选的素材位声明（data_type 逐位正确，file 组件不参与推导）。 */
const buildInputPorts = (accepted: ReadonlySet<GenerationMediaSlotId>): JsonObject[] => {
  const ports: JsonObject[] = [];
  for (const shape of MEDIA_SLOT_CONTENT_TYPES) {
    if (!accepted.has(shape.slot)) continue;
    const fieldKey = fieldKeyOfSlot(shape.slot);
    const isVideo = shape.slot === 'feature_video' || shape.slot === 'base_video';
    ports.push({
      id: fieldKey,
      name: `ports.inputs.${fieldKey}.name`,
      data_type: isVideo ? 'video' : 'image',
      field_key: fieldKey,
      required: false,
      multiple: false,
      max_connections: 1,
      description: `ports.inputs.${fieldKey}.description`,
    });
  }
  return ports;
};

// ---------------------------------------------------------------------------
// 模板级 locales（键名与在役包同构；zh-CN/en 内联，声明不携带文案）
// ---------------------------------------------------------------------------

const DURATION_OPTION_LABELS_ZH: Record<string, { label: string }> = {
  '3': { label: '3 秒' },
  '4': { label: '4 秒' },
  '5': { label: '5 秒' },
  '6': { label: '6 秒' },
  '7': { label: '7 秒' },
  '8': { label: '8 秒' },
  '9': { label: '9 秒' },
  '10': { label: '10 秒' },
  '11': { label: '11 秒' },
  '12': { label: '12 秒' },
  '13': { label: '13 秒' },
  '14': { label: '14 秒' },
  '15': { label: '15 秒' },
};

const DURATION_OPTION_LABELS_EN: Record<string, { label: string }> = {
  '3': { label: '3 seconds' },
  '4': { label: '4 seconds' },
  '5': { label: '5 seconds' },
  '6': { label: '6 seconds' },
  '7': { label: '7 seconds' },
  '8': { label: '8 seconds' },
  '9': { label: '9 seconds' },
  '10': { label: '10 seconds' },
  '11': { label: '11 seconds' },
  '12': { label: '12 seconds' },
  '13': { label: '13 seconds' },
  '14': { label: '14 seconds' },
  '15': { label: '15 seconds' },
};

const TEMPLATE_LOCALES_ZH_CN: ModelAssetLocalizationResourceMap = {
  fields: {
    firstFrameImage: {
      label: '首帧图',
      description: '作为视频起始画面。支持 JPG / PNG / WebP，单张不超过 50 MB，宽高均不小于 300 px，宽高比 1:2.5–2.5:1。',
    },
    lastFrameImage: {
      label: '尾帧图',
      description: '作为视频结束画面，需与首帧图成对使用；官方不支持只给尾帧。',
    },
    referImage: {
      label: '参考图',
      description: '元素参考图，用于在提示词里 @ 指认画面元素。约束与首帧图相同。',
    },
    featureVideo: {
      label: '特征参考视频',
      description: '参考其风格或动作的视频（MP4 / MOV，≤ 200 MB，3–15.5 秒，最多 1 个）。使用时多镜头只能开启、音频只能关闭。',
    },
    baseVideo: {
      label: '基础视频',
      description: '待编辑的原视频（MP4 / MOV，≤ 200 MB，3–15.5 秒，最多 1 个）。不能同时指定首帧/尾帧，不支持多镜头，音频不能选原生音频。',
    },
    duration: {
      label: '视频时长',
      options: DURATION_OPTION_LABELS_ZH,
    },
    resolution: {
      label: '清晰度',
      description: '默认 720P，可选 1080P 与 4K；档位越高生成越慢。',
      options: {
        '720p': { label: '720P' },
        '1080p': { label: '1080P' },
        '4k': { label: '4K' },
      },
    },
    aspectRatio: {
      label: '画幅比例',
      description: '生成视频画面的宽高比，默认 16:9；没有首帧也没有参考视频时必须填写。',
      options: {
        '16_9': { label: '16:9 横屏' },
        '9_16': { label: '9:16 竖屏' },
        '1_1': { label: '1:1 方形' },
      },
    },
    audio: {
      label: '音频',
      description: '「原生音频」生成与画面匹配的声音；「保留参考视频原声」沿用参考视频的声音；默认无音频。',
      options: {
        native: { label: '原生音频' },
        original: { label: '保留参考视频原声' },
        off: { label: '无音频' },
      },
    },
    multiShot: {
      label: '多镜头',
      description: '开启后可用多镜头提示词语法生成多镜头视频，默认开启。',
    },
    watermark: {
      label: '水印',
      description: '开启后生成带水印的结果，默认关闭。',
    },
  },
  ports: {
    inputs: {
      firstFrameImage: { name: '首帧图', description: '接入素材或资产节点作为视频起始画面。' },
      lastFrameImage: { name: '尾帧图', description: '接入素材或资产节点作为视频结束画面。' },
      referImage: { name: '参考图', description: '接入素材或资产节点作为元素参考图。' },
      featureVideo: { name: '特征参考视频', description: '接入视频素材作为风格或动作参考。' },
      baseVideo: { name: '基础视频', description: '接入视频素材作为待编辑的原视频。' },
    },
    outputs: {
      video: { name: '视频' },
    },
  },
};

const TEMPLATE_LOCALES_EN: ModelAssetLocalizationResourceMap = {
  fields: {
    firstFrameImage: {
      label: 'First frame',
      description: 'The starting frame. JPG / PNG / WebP, up to 50 MB, edges at least 300 px, aspect ratio 1:2.5–2.5:1.',
    },
    lastFrameImage: {
      label: 'Last frame',
      description: 'The ending frame, used together with the first frame. A last frame alone is not supported.',
    },
    referImage: {
      label: 'Reference image',
      description: 'Element reference image, referenced with @ in the prompt. Same constraints as the first frame.',
    },
    featureVideo: {
      label: 'Feature reference video',
      description: 'Video whose style or motion is referenced (MP4 / MOV, up to 200 MB, 3–15.5 s, at most 1). Multi-shot must stay on and audio must stay off.',
    },
    baseVideo: {
      label: 'Base video',
      description: 'The source video to edit (MP4 / MOV, up to 200 MB, 3–15.5 s, at most 1). Cannot be combined with first/last frame, no multi-shot, and audio cannot be native.',
    },
    duration: {
      label: 'Duration',
      options: DURATION_OPTION_LABELS_EN,
    },
    resolution: {
      label: 'Resolution',
      description: 'Defaults to 720P. 1080P and 4K are available; higher tiers take longer.',
      options: {
        '720p': { label: '720P' },
        '1080p': { label: '1080P' },
        '4k': { label: '4K' },
      },
    },
    aspectRatio: {
      label: 'Aspect ratio',
      description: 'Width-to-height ratio of the generated video. Defaults to 16:9; required when there is neither a first frame nor a reference video.',
      options: {
        '16_9': { label: '16:9 landscape' },
        '9_16': { label: '9:16 portrait' },
        '1_1': { label: '1:1 square' },
      },
    },
    audio: {
      label: 'Audio',
      description: 'Native generates matching sound; "Keep reference audio" reuses the reference video sound; defaults to no audio.',
      options: {
        native: { label: 'Native audio' },
        original: { label: 'Keep reference audio' },
        off: { label: 'No audio' },
      },
    },
    multiShot: {
      label: 'Multi-shot',
      description: 'Allow multi-shot prompt syntax to produce a multi-shot video. On by default.',
    },
    watermark: {
      label: 'Watermark',
      description: 'Generate watermarked results when on. Off by default.',
    },
  },
  ports: {
    inputs: {
      firstFrameImage: { name: 'First frame', description: 'Connect an asset as the starting frame.' },
      lastFrameImage: { name: 'Last frame', description: 'Connect an asset as the ending frame.' },
      referImage: { name: 'Reference image', description: 'Connect an asset as an element reference image.' },
      featureVideo: { name: 'Feature reference video', description: 'Connect a video as style or motion reference.' },
      baseVideo: { name: 'Base video', description: 'Connect a video as the source to edit.' },
    },
    outputs: {
      video: { name: 'Video' },
    },
  },
};

const TEMPLATE_LOCALIZATION_RESOURCES: LocaleResources = {
  'zh-CN': TEMPLATE_LOCALES_ZH_CN,
  en: TEMPLATE_LOCALES_EN,
};

/** JSON 值的深克隆（模板默认值表复用：同一 JSON 树不得被两处共享引用）。 */
const cloneJsonObject = (value: unknown): JsonObject => cloneJsonValue(value ?? null) as JsonObject;

// ---------------------------------------------------------------------------
// 族模板工厂
// ---------------------------------------------------------------------------

/**
 * kling-omni-video-v1 基础族模板（不含记录覆盖）：从 model_id 与接受的素材位合成
 * runtime_model / node_definition / locales 形状的内存态包源，交给与已装包相同的投影路径。
 *
 * 记录覆盖由注册表的通用合成入口（`buildFamilyTemplateSources`）统一应用；基础模板单独导出是
 * 因为覆盖校验（保存期）需要在**未应用覆盖**的模板上运行（设计 §3.3 校验唯一实现）。
 */
export const buildKlingOmniVideoV1BaseTemplateSources = (
  modelId: string,
  options: GenerationFamilyTemplateOptions,
): GenerationFamilyTemplateSources => {
  const accepted = new Set<GenerationMediaSlotId>(options.acceptedMediaSlots);
  const parameterSchema = buildParameterSchema(accepted);
  const runtimeModel: JsonObject = {
    model_id: modelId,
    provider_id: 'kling',
    default_task_type: 'video',
    mode: 'video',
    role: 'generator',
    capability: buildKlingCapability({
      inputModalities: ['text', 'image', 'video'],
      supportsMultiImage: false,
      supportsReferenceMedia: true,
    }),
    parameter_schema: parameterSchema,
    execution_profile: {
      task_type: 'video',
      supports_async_task: true,
    },
    display: {
      visible: true,
      order: 9000,
    },
    runtime: {
      provider_id: 'kling',
      default_task_type: 'video',
      mode: 'video',
      aliases: [],
      payload_format: 'json',
      workspace: {
        task_list_position: 'right',
      },
      // 含视频素材：必须用通用文件中转目标（self_hosted_image_public_url 只服务图像）。
      ...buildKlingUrlInputUploadRuntime(accepted, 'cloudflare_image_public_url'),
      api_defaults: {
        endpoint: OMNI_VIDEO_ENDPOINT,
        method: 'POST',
        contentType: 'application/json',
      },
      payload_rules: buildPayloadRules(accepted),
      capabilities: {
        execution_traits: ['nonBlocking'],
      },
      schema_defaults: cloneJsonObject(parameterSchema.default_values),
      execution_driver: 'http_formal_task',
    },
    request_strategy: {
      request_stage: 'submit',
      protocol: 'http',
      endpoint: OMNI_VIDEO_ENDPOINT,
      method: 'POST',
      header_rules: [],
      body_rules: [],
      query_rules: [],
    },
    result_rule: buildKlingResultRule(),
    polling_strategy: buildKlingPollingStrategy(),
    result_output_mapping: buildKlingResultOutputMapping(),
    prompt_field: {
      field_key: '__prompt',
      required: true,
      validation_rules: [],
    },
  };
  const node: JsonObject = {
    node_type: 'model',
    group_key: 'kling',
    input_ports: buildInputPorts(accepted),
    output_ports: [
      {
        id: 'video',
        name: 'ports.outputs.video.name',
        data_type: 'video',
        field_key: 'output_video',
        multiple: true,
      },
    ],
  };
  return {
    runtimeModel: toCatalogRawObject(runtimeModel),
    node: toCatalogRawObject(node),
    localizationResources: TEMPLATE_LOCALIZATION_RESOURCES,
  };
};

/**
 * kling-omni-video-v1 的参数描述（GET /api/generation-family-templates/:familyAdapterId 的数据）。
 *
 * 基线是「不接受任何素材位」形态（素材位字段不进官方参数区），另把「素材位全开」形态的
 * payload_rules 并入保留键计算——基线的 contents 只有文本块，但声明可能接受五个素材位，
 * `contents` 等协议键同样要保留。
 */
export const buildKlingOmniVideoV1ParameterDescriptor = (): FamilyTemplateParameterDescriptor =>
  buildFamilyTemplateParameterDescriptorFromSources({
    familyAdapterId: KLING_OMNI_VIDEO_V1_FAMILY_ADAPTER_ID,
    baselineSources: buildKlingOmniVideoV1BaseTemplateSources('descriptor-baseline', {
      acceptedMediaSlots: [],
    }),
    extraPayloadRuleSets: [buildPayloadRules(ALL_ACCEPTED_SLOTS)],
  });

/**
 * 已知边界（payload DSL 表达力的真实限制，不在此处兜底）：
 *
 * 1. **跨字段互斥只能靠上游**。官方多条组合约束无法在 DSL 里断言：
 *    「首帧/尾帧成对」「有参考视频时不得同时用参考图」「基础视频不得与首帧/尾帧同时使用」
 *    「特征视频场景下 multiShot 只能 true、audio 只能 off」「基础视频下 audio 不得 native」。
 *    `assert_*` 只能判断单字段，无法表达「A 非空 ⇒ B 为空」这类组合；这些约束由上游校验兜底。
 * 2. **`aspect_ratio` 的条件必填**（官方：没有首帧或参考视频时该参数必填）无法表达为
 *    `required_when` 之外的语义；本族模板把它保留为普通可选参数，由上游兜底。
 * 3. **`contents[].id` 未发送**：官方示例列出该字段（输入索引 ID，用于提示词内指认），
 *    但首帧/尾帧场景是否必填官方未明说（spec 07 §8.2 备注）；在役包也不发送该字段，
 *    本族模板与在役包一致不发送。TODO：若后续确认必填，需在 `buildKlingSingleMediaEntry`
 *    增加 `id` 条目。
 */
