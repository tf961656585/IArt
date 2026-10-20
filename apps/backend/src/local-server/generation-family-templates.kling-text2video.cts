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
  buildKlingMetaRules,
  buildKlingParameterFields,
  buildKlingPollingStrategy,
  buildKlingPromptMirrorRules,
  buildKlingPromptRule,
  buildKlingResultOutputMapping,
  buildKlingResultRule,
  buildKlingSettingsRules,
  buildKlingWatermarkRule,
  KLING_TEXT_AUDIO_VALUES,
} from './generation-family-templates.kling-protocol.cts';

/**
 * kling-text2video-v1 族模板（可灵官方**新设计标准**文生视频：`POST /text-to-video/kling-3.0`，
 * 异步任务 + 统一查询端点）。
 *
 * 协议事实来源：`docs/provider-remote-apis/07-Kling-视频生成接口.md` §5/§6/§9 与三个在役包
 * （`kling-v3-text2video` / `-image2video` / `-omni-video`）的实测规则（2026-10-19）。
 *
 * - **模型身份在 URL path**：`kling-3.0` 是 path 的一段，请求体没有 `model_name`、也没有其他
 *   模型字段。因此本族模板**不生成任何 `body.model` 规则**，也**不制造 `{model}` 占位符**；
 *   remote_model_id 注入对本族是惰性的（分类事实在
 *   `provider-connection/remote-model-injection.cts` 的 `ADAPTER_IDS_WITH_URL_MODEL_TEMPLATE`，
 *   本批不改分类）。
 * - **纯文生视频**：`capability.input_modalities = ['text']`、`supports_multi_image = false`、
 *   `supports_reference_media = false`，**零素材位**——既不生成素材表单字段，也不生成输入端口，
 *   注册表条目的 `supportsMediaSlots` 因此是空清单（写入侧守卫据此拒绝给本族勾任何素材位）。
 *   没有素材目标 → 不声明 public_relay（声明了会被判
 *   `url_input_upload_mode_without_public_url_target` 坏包）。
 * - endpoint 只用到 `textToVideo` 与 `taskById` 两个适配器键，路径字面量与
 *   `packages/contracts` ADAPTER_REGISTRY 逐字一致，由一致性门禁双向核对。
 *
 * ## 与另两族「不重复」的做法
 *
 * 轮询 / 结果规则 / 结果映射 / 官方档位 / settings 组装 / 素材位字段与单媒体 entry 的**唯一实现**
 * 在 `generation-family-templates.kling-protocol.cts`（纯函数叶子库，不是族模板、不被注册表登记）。
 * 三族各自 import 这些叶子函数：既不重复三份协议事实，也**不产生族间引用或继承**——本文件不
 * import 另两族模板，产物（内存态 sources）自身携带完整的 endpoint / payload_rules / 轮询 /
 * 结果规则，运行时不需要另一族模板存在。
 *
 * ## 时长档的处置
 *
 * 官方 `duration` 是 3–15 秒整数，在役包的表单也是数字档位（不是字符串）。本族模板沿用**数字**
 * 枚举值与 `toNumber` 收敛：`normalize_enum` 的 allowed_values 与表单枚举同源（同一份常量），
 * 避免「表单填 5、wire 收成 "5"」的形态漂移。
 *
 * 模板级 locales 内联在本文件（zh-CN + en），键名与在役包同构；合成投影经
 * buildProjectionFromPackageSources 走与已装包相同的本地化投影路径，禁止在投影处硬编码文案。
 */

/** 本族适配器 id（值域 owner 仍是 contracts 的 GENERATION_FAMILY_ADAPTER_IDS）。 */
export const KLING_TEXT2VIDEO_V1_FAMILY_ADAPTER_ID = 'kling-text2video-v1';

/**
 * 本族模板能表达的素材位：**空清单**。
 *
 * 官方文生视频端点没有任何素材输入（`contents` 不存在，请求体只有 prompt/settings/options）。
 * 空清单既是本族模板的事实，也是写入侧守卫拒绝非空素材位声明的依据。
 */
export const KLING_TEXT2VIDEO_V1_SUPPORTED_MEDIA_SLOTS = [] as const satisfies readonly GenerationMediaSlotId[];

/** 提交端点（与适配器 relative_endpoints.textToVideo 同值）。 */
const TEXT_TO_VIDEO_ENDPOINT = '/text-to-video/kling-3.0';

/** 本族 audio 取值集合（文生视频没有 original 档）。 */
const AUDIO_VALUES = KLING_TEXT_AUDIO_VALUES;

const CACHE_KEY_PREFIX = 'klingV3Text2Video';

/**
 * parameter_schema：本族零素材位，字段只有生成参数；`required_fields` 为空
 * （提示词必填由 prompt_field + payload 的 assert_non_empty 承担，不进参数表单）。
 */
const buildParameterSchema = (): JsonObject => {
  const fields = buildKlingParameterFields({ audioValues: AUDIO_VALUES, includeAspectRatio: true });
  const defaultValues: JsonObject = {};
  for (const field of fields) {
    const fieldKey = field.field_key;
    if (typeof fieldKey !== 'string') continue;
    defaultValues[fieldKey] = field.default_value;
  }
  return {
    schema_type: 'object',
    fields,
    required_fields: [],
    default_values: defaultValues,
    validation_rules: [],
  };
};

/**
 * payload_rules：官方文生视频请求体 `{ prompt, settings, options }`。
 *
 * settings 含 `aspect_ratio`（图生视频没有该字段——这是三端点的实质差异，不复用同一 settings）。
 */
const buildPayloadRules = (): JsonObject => ({
  'api.endpoint': { kind: 'literal', value: TEXT_TO_VIDEO_ENDPOINT },
  'api.method': { kind: 'literal', value: 'POST' },
  'api.contentType': { kind: 'literal', value: 'application/json' },
  // 异步响应处理声明：编辑器据此把结果当任务处理（三族同值）。
  'api.responseHandling.mode': { kind: 'literal', value: 'async' },
  'body.prompt': buildKlingPromptRule(`${CACHE_KEY_PREFIX}.prompt`),
  ...buildKlingSettingsRules({
    cacheKeyPrefix: CACHE_KEY_PREFIX,
    audioValues: AUDIO_VALUES,
    includeAspectRatio: true,
  }),
  'body.options.watermark_info.enabled': buildKlingWatermarkRule(),
  ...buildKlingMetaRules({
    cacheKeyPrefix: CACHE_KEY_PREFIX,
    audioValues: AUDIO_VALUES,
    includeAspectRatio: true,
    taskType: 'text2video',
  }),
  ...buildKlingPromptMirrorRules(),
});

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
      description: '生成视频画面的宽高比，默认 16:9。',
      options: {
        '16_9': { label: '16:9 横屏' },
        '9_16': { label: '9:16 竖屏' },
        '1_1': { label: '1:1 方形' },
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
    outputs: {
      video: { name: '视频' },
    },
  },
};

const TEMPLATE_LOCALES_EN: ModelAssetLocalizationResourceMap = {
  fields: {
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
      description: 'Width-to-height ratio of the generated video. Defaults to 16:9.',
      options: {
        '16_9': { label: '16:9 landscape' },
        '9_16': { label: '9:16 portrait' },
        '1_1': { label: '1:1 square' },
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
 * kling-text2video-v1 基础族模板（不含记录覆盖）：从 model_id 与接受的素材位合成
 * runtime_model / node_definition / locales 形状的内存态包源，交给与已装包相同的投影路径。
 *
 * 本族零素材位：`acceptedMediaSlots` 在本族没有可表达的取值（写入侧守卫已拒绝非空清单，
 * 投影侧 filterAcceptedMediaSlotsForFamily 再兜一次）。参数保留在签名里是因为注册表
 * 统一按同一形状调用每族构建器。
 */
export const buildKlingText2VideoV1BaseTemplateSources = (
  modelId: string,
  options: GenerationFamilyTemplateOptions,
): GenerationFamilyTemplateSources => {
  // 本族没有素材位可表达：即使调用方传了非空清单，也不生成任何素材字段/端口/请求分支。
  void options;
  const parameterSchema = buildParameterSchema();
  const runtimeModel: JsonObject = {
    model_id: modelId,
    provider_id: 'kling',
    default_task_type: 'video',
    mode: 'video',
    role: 'generator',
    capability: buildKlingCapability({
      inputModalities: ['text'],
      supportsMultiImage: false,
      supportsReferenceMedia: false,
    }),
    parameter_schema: parameterSchema,
    execution_profile: {
      task_type: 'video',
      supports_async_task: true,
    },
    display: {
      visible: true,
      // 与其它族模板同一约定：声明模型的目录排序排在其它模型之后。
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
      // 纯文生视频没有任何 public_url 目标，不声明公网中转（声明即坏包）。
      api_defaults: {
        endpoint: TEXT_TO_VIDEO_ENDPOINT,
        method: 'POST',
        contentType: 'application/json',
      },
      payload_rules: buildPayloadRules(),
      capabilities: {
        execution_traits: ['nonBlocking'],
      },
      schema_defaults: cloneJsonObject(parameterSchema.default_values),
      execution_driver: 'http_formal_task',
    },
    request_strategy: {
      request_stage: 'submit',
      protocol: 'http',
      endpoint: TEXT_TO_VIDEO_ENDPOINT,
      method: 'POST',
      header_rules: [],
      body_rules: [],
      query_rules: [],
    },
    // 异步任务：提交响应的 /data/id 是后续查询的任务 id（三族一致）。
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
    // 零素材位 → 零输入端口。
    input_ports: [],
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
 * kling-text2video-v1 的参数描述（GET /api/generation-family-templates/:familyAdapterId 的数据）。
 *
 * 本族基线即完整形态（零素材位，没有第二条请求分支），因此不需要 `extraPayloadRuleSets`：
 * 基线 payload_rules 的 `body.*` target 已经覆盖了本族全部协议键（prompt / settings / options）。
 */
export const buildKlingText2VideoV1ParameterDescriptor = (): FamilyTemplateParameterDescriptor =>
  buildFamilyTemplateParameterDescriptorFromSources({
    familyAdapterId: KLING_TEXT2VIDEO_V1_FAMILY_ADAPTER_ID,
    baselineSources: buildKlingText2VideoV1BaseTemplateSources('descriptor-baseline', {
      acceptedMediaSlots: [],
    }),
  });
