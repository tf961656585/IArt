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
  buildKlingSingleMediaEntry,
  buildKlingUrlInputUploadRuntime,
  buildKlingWatermarkRule,
  klingMediaSlotFieldKey,
  KLING_TEXT_AUDIO_VALUES,
} from './generation-family-templates.kling-protocol.cts';

/**
 * kling-image2video-v1 族模板（可灵官方**新设计标准**图生视频：
 * `POST /image-to-video/kling-3.0`，异步任务 + 统一查询端点）。
 *
 * 协议事实来源：`docs/provider-remote-apis/07-Kling-视频生成接口.md` §5/§7/§9 与在役包
 * `kling-v3-image2video` 的实测规则（2026-10-19）。
 *
 * - **模型身份在 URL path**：`/image-to-video/kling-3.0` 的 `kling-3.0` 是 path 的一段，请求体
 *   没有 `model_name`、也没有 `model`。本族模板**不生成任何 `body.model` 规则**，也不制造
 *   `{model}` 占位符；remote_model_id 注入对本族惰性（分类事实在
 *   `provider-connection/remote-model-injection.cts`，本批不改分类）。
 * - **请求体是 `contents` 数组**：`[{type:'prompt',text}, {type:'first_frame',url},
 *   {type:'last_frame',url}]`，用 `compact_array` 组装——未填写的尾帧分支求值成 `null` 后
 *   被压掉，不产出没有 url 的空壳条目。
 * - **settings 没有 `aspect_ratio`**：官方字段表只列 multi_shot / audio / resolution / duration
 *   （spec 07 §7.3）。三端点不得复用同一 settings，这里显式不生成该键。
 * - **素材位**：首帧 `first_frame`（**必填**）与尾帧 `last_frame`。只在 `acceptedMediaSlots`
 *   出现该位时生成表单字段、输入端口与请求分支（素材位驱动）。
 * - **公网中转**：`public_relay` + `self_hosted_image_public_url`。本族媒体只有图像，符合
 *   AGENTS.md「Public Relay target 能力边界」——`self_hosted_image_public_url` 只服务图像，
 *   因此本族可以（且应该）用它；含视频素材的全模态族不得复用它。
 *
 * ## 首帧必填怎么表达（判断点）
 *
 * 受控词表 `GENERATION_MEDIA_SLOT_IDS` 只有 id、没有「必填」语义，所以必填性表达在**两处、
 * 分层**：
 * 1. **表单层**：首帧字段 `required: true`，并把 `firstFrameImage` 写进 `required_fields`——
 *    目录投影把两份都下发给 Editor，PromptDock 的前置校验因此能在**提交前**阻断；
 * 2. **组装层**：请求规则对首帧用 `assert_non_empty`，空值在本地组装期以「请上传首帧图。」
 *    失败，不发一个注定被上游拒的请求（与在役包同构）。
 *
 * 选这个组合而不是「靠上游报错」：仓库硬底线是「不允许能选但一提交就失败」——靠上游报错时
 * 用户要等一次真实请求往返才知道，且错误文案来自远端、与界面字段无对应关系。两处表达
 * 各自覆盖不同入口（前置校验 / CLI 与程序化提交），缺一都会漏一条入口。
 * 若记录声明了本族却**没有**勾 `first_frame` 素材位（写入侧守卫只检查子集，不强制包含），
 * 模板不凭空造该字段（素材位驱动口径），此时由上游拒绝——这是本族已知边界，见文件末。
 */

/** 本族适配器 id（值域 owner 仍是 contracts 的 GENERATION_FAMILY_ADAPTER_IDS）。 */
export const KLING_IMAGE2VIDEO_V1_FAMILY_ADAPTER_ID = 'kling-image2video-v1';

/**
 * 本族模板能表达的素材位：首帧与尾帧。
 *
 * 顺序即创作面呈现顺序与请求体内容顺序（首帧在尾帧之前，官方不支持「仅尾帧」）。
 */
export const KLING_IMAGE2VIDEO_V1_SUPPORTED_MEDIA_SLOTS = [
  'first_frame',
  'last_frame',
] as const satisfies readonly GenerationMediaSlotId[];

/** 提交端点（与适配器 relative_endpoints.imageToVideo 同值）。 */
const IMAGE_TO_VIDEO_ENDPOINT = '/image-to-video/kling-3.0';

const AUDIO_VALUES = KLING_TEXT_AUDIO_VALUES;
const CACHE_KEY_PREFIX = 'klingV3Image2Video';

/** 首帧字段键（必填位；与在役包字段名一致，便于存量记录/文档对照）。 */
const FIRST_FRAME_FIELD_KEY = 'firstFrameImage';
/** 尾帧字段键（可选位）。 */
const LAST_FRAME_FIELD_KEY = 'lastFrameImage';

const FIRST_FRAME_REQUIRED_MESSAGE = '请上传首帧图。';

/** 本族全部素材位（参数描述计算保留键时用「全开形态」覆盖两条分支）。 */
const ALL_ACCEPTED_SLOTS: ReadonlySet<GenerationMediaSlotId> = new Set<GenerationMediaSlotId>(
  KLING_IMAGE2VIDEO_V1_SUPPORTED_MEDIA_SLOTS,
);

const buildParameterSchema = (accepted: ReadonlySet<GenerationMediaSlotId>): JsonObject => {
  // 首帧在本族必填（官方 `first_frame` 必填）；尾帧可选。
  const mediaFields = buildKlingMediaSlotFields(accepted, { firstFrameRequired: true });
  const parameterFields = buildKlingParameterFields({
    audioValues: AUDIO_VALUES,
    includeAspectRatio: false,
  });
  const defaultValues: JsonObject = {};
  for (const field of [...mediaFields, ...parameterFields]) {
    const fieldKey = field.field_key;
    if (typeof fieldKey !== 'string') continue;
    defaultValues[fieldKey] = field.default_value;
  }
  // 必填只随「首帧位被本记录勾选」出现：未勾该位时字段不存在，required_fields 也不能指向
  // 不存在的字段（投影侧会把它当下发清单原样传出去）。
  const requiredFields: string[] = accepted.has('first_frame') ? [FIRST_FRAME_FIELD_KEY] : [];
  return {
    schema_type: 'object',
    fields: [...mediaFields, ...parameterFields],
    required_fields: requiredFields,
    default_values: defaultValues,
    validation_rules: [],
  };
};

/**
 * `body.contents` 组装：文本块恒有，首帧恒有（带 assert_non_empty），尾帧条件追加。
 *
 * `compact_array` 压掉 `when` 的 falsy 分支（`null`）：未填尾帧时不产出没有 url 的空壳条目。
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
  if (accepted.has('first_frame')) {
    args.push(
      buildKlingSingleMediaEntry({
        type: 'first_frame',
        fieldKey: FIRST_FRAME_FIELD_KEY,
        cacheKey: `${CACHE_KEY_PREFIX}.firstFrame`,
        requireNonEmptyMessage: FIRST_FRAME_REQUIRED_MESSAGE,
      }),
    );
  }
  if (accepted.has('last_frame')) {
    args.push(buildKlingMediaWhenBranch({ fieldKey: LAST_FRAME_FIELD_KEY, type: 'last_frame' }));
  }
  return {
    kind: 'compute',
    operator: 'compact_array',
    cache_key: `${CACHE_KEY_PREFIX}.contents`,
    note: '按记录的素材位组装官方 contents 数组：文本块 + 首帧（必填，assert_non_empty）+ 尾帧（条件追加）；compact_array 压掉未填写的分支。',
    args,
  };
};

const buildPayloadRules = (accepted: ReadonlySet<GenerationMediaSlotId>): JsonObject => ({
  'api.endpoint': { kind: 'literal', value: IMAGE_TO_VIDEO_ENDPOINT },
  'api.method': { kind: 'literal', value: 'POST' },
  'api.contentType': { kind: 'literal', value: 'application/json' },
  'api.responseHandling.mode': { kind: 'literal', value: 'async' },
  'body.contents': buildContentsRule(accepted),
  ...buildKlingSettingsRules({
    cacheKeyPrefix: CACHE_KEY_PREFIX,
    audioValues: AUDIO_VALUES,
    // 图生视频的 settings 没有 aspect_ratio（spec 07 §7.3）。
    includeAspectRatio: false,
  }),
  'body.options.watermark_info.enabled': buildKlingWatermarkRule(),
  ...buildKlingMetaRules({
    cacheKeyPrefix: CACHE_KEY_PREFIX,
    audioValues: AUDIO_VALUES,
    includeAspectRatio: false,
    taskType: 'image2video',
  }),
  ...buildKlingPromptMirrorRules(),
});

/** 输入端口：只为勾选的素材位声明（data_type 逐位正确，file 组件不参与推导）。 */
const buildInputPorts = (accepted: ReadonlySet<GenerationMediaSlotId>): JsonObject[] => {
  const ports: JsonObject[] = [];
  for (const slot of KLING_IMAGE2VIDEO_V1_SUPPORTED_MEDIA_SLOTS) {
    if (!accepted.has(slot)) continue;
    const fieldKey = klingMediaSlotFieldKey(slot);
    if (fieldKey === null) continue;
    ports.push({
      id: fieldKey,
      name: `ports.inputs.${fieldKey}.name`,
      data_type: 'image',
      field_key: fieldKey,
      // 端口必填性与字段必填性同源：首帧端口 required=true，尾帧 false。
      required: slot === 'first_frame',
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
      description: '必填，作为视频起始画面。支持 JPG / PNG / WebP，单张不超过 50 MB，宽高均不小于 300 px，宽高比 1:2.5–2.5:1。',
    },
    lastFrameImage: {
      label: '尾帧图',
      description: '可选，作为视频结束画面；官方不支持只给尾帧、不给首帧。约束与首帧图相同。',
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
    audio: {
      label: '音频',
      description: '选择「原生音频」时生成与画面匹配的声音；默认无音频。',
      options: {
        native: { label: '原生音频' },
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
      firstFrameImage: { name: '首帧图', description: '接入素材或资产节点作为视频起始画面（必填）。' },
      lastFrameImage: { name: '尾帧图', description: '接入素材或资产节点作为视频结束画面。' },
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
      description: 'Required. The starting frame. JPG / PNG / WebP, up to 50 MB, edges at least 300 px, aspect ratio 1:2.5–2.5:1.',
    },
    lastFrameImage: {
      label: 'Last frame',
      description: 'Optional ending frame. A last frame alone (without a first frame) is not supported. Same constraints as the first frame.',
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
    audio: {
      label: 'Audio',
      description: 'Choose native audio to generate matching sound. Defaults to no audio.',
      options: {
        native: { label: 'Native audio' },
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
      firstFrameImage: { name: 'First frame', description: 'Connect an asset as the starting frame (required).' },
      lastFrameImage: { name: 'Last frame', description: 'Connect an asset as the ending frame.' },
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
 * kling-image2video-v1 基础族模板（不含记录覆盖）：从 model_id 与接受的素材位合成
 * runtime_model / node_definition / locales 形状的内存态包源，交给与已装包相同的投影路径。
 *
 * 记录覆盖由注册表的通用合成入口（`buildFamilyTemplateSources`）统一应用；基础模板单独导出是
 * 因为覆盖校验（保存期）需要在**未应用覆盖**的模板上运行（设计 §3.3 校验唯一实现）。
 */
export const buildKlingImage2VideoV1BaseTemplateSources = (
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
      inputModalities: ['text', 'image'],
      // 本族每个素材位都只接 1 张图（首帧/尾帧），不是多图参考。
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
      // 图像素材走公网中转；本族媒体只有图像，用只服务图像的自建图床 target 符合能力边界。
      ...buildKlingUrlInputUploadRuntime(accepted, 'self_hosted_image_public_url'),
      api_defaults: {
        endpoint: IMAGE_TO_VIDEO_ENDPOINT,
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
      endpoint: IMAGE_TO_VIDEO_ENDPOINT,
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
 * kling-image2video-v1 的参数描述（GET /api/generation-family-templates/:familyAdapterId 的数据）。
 *
 * 基线是「不接受任何素材位」形态（素材位字段不进官方参数区），另把「素材位全开」形态的
 * payload_rules 并入保留键计算——基线没有首帧/尾帧分支，但声明可能接受它们，`contents` 等
 * 协议键同样要保留。
 */
export const buildKlingImage2VideoV1ParameterDescriptor = (): FamilyTemplateParameterDescriptor =>
  buildFamilyTemplateParameterDescriptorFromSources({
    familyAdapterId: KLING_IMAGE2VIDEO_V1_FAMILY_ADAPTER_ID,
    baselineSources: buildKlingImage2VideoV1BaseTemplateSources('descriptor-baseline', {
      acceptedMediaSlots: [],
    }),
    extraPayloadRuleSets: [buildPayloadRules(ALL_ACCEPTED_SLOTS)],
  });

/**
 * 已知边界（不在此处兜底）：
 *
 * 1. **只声明尾帧、不声明首帧**：写入侧守卫只校验「勾的位 ⊆ 本族可表达的位」，因此记录可以
 *    只勾 `last_frame`。此时模板按素材位驱动不生成首帧分支，请求只有尾帧 → 上游拒绝
 *    （官方明确不支持 last-frame-only）。把「本族必选素材位」做成契约/守卫语义超出本批边界，
 *    留作后续批次（届时 registry 条目需增加 requiredSlots 判据）。
 * 2. **两个素材位都不勾**：同上，模板不造首帧字段（素材位驱动口径），请求只有提示词 → 上游
 *    拒绝。若要让该族在声明层就不可提交，需同样引入 requiredSlots 判据。
 */
