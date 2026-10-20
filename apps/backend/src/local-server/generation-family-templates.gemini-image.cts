import type { FamilyTemplateParameterDescriptor } from '@iart/contracts';
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

/**
 * gemini-image-interactions-v1 族模板实现（Gemini 图像生成，Interactions API 同步接口）。
 *
 * 提炼来源：现役 gemini 图像族在役包（`gemini-3-pro-image` / `gemini-3.1-flash-image` /
 * `gemini-3.1-flash-lite-image`）的协议不变部分（payload_rules / request_strategy /
 * result_rule / result_output_mapping / runtime.api_defaults），并对齐登记契约
 * `docs/provider-remote-apis/02-Gemini-图像生成接口.md`：
 * - 提交端点只有一个：`POST /v1beta/interactions`（登记契约 §4.1 主链，官方已明确
 *   generateContent 为 legacy 兼容通道，族模板只表达主链）。路径必须与
 *   `packages/contracts` ADAPTER_REGISTRY 中 gemini-image-interactions-v1 的
 *   `relative_endpoints.interactions` 一致，由 `__tests__/generation-family-template-consistency.test.ts`
 *   一致性门禁钉住（设计 §3.4）。
 * - 同步接口，**不轮询**：result_rule 是 `mode:'sync'`，失败形态是响应体 `error`
 *   （登记契约 §9.1：无独立任务查询 endpoint，图像生成是同步/流式/后台三形态）。
 * - 结果产出为 `steps[].content`（登记契约 §9.1：遍历 steps[]，取图像块 data 的 base64）。
 * - 无公网中转：`url_input_upload_mode` 不声明，媒体目标走 `inline_data`
 *   （请求体 `input[].data` 内联 base64），参考图不经 Files API 或中转图床。
 * - **档位取族通用形态**（与 openai-image 族同一裁定口径）：
 *   `aspectRatio` 只提供全族共有 10 个比例（flash 独有 `1:4`/`4:1`/`1:8`/`8:1` 不入族模板）；
 *   `imageSize` 提供 `1K`/`2K`/`4K`（flash 独有的 `512` 不入族模板）。族内缩小版型号
 *   （lite 仅 1K）用记录级「参数覆盖」收窄枚举——不在这里给某个型号预发它不支持的档位，
 *   也不把整族压到最小型号的水平（详见文件内 buildParameterSchema 的裁定说明）。
 * - prompt_field：保留键 `__prompt`，必填；validation_rules 与在役包一致为空。
 *
 * 模板级 locales（协议与参数文案）内联在本文件，键名与在役包 locales 同构；合成投影经
 * buildProjectionFromPackageSources 走与已装包相同的本地化投影路径，禁止在投影处硬编码文案。
 *
 * 本族的素材位只有「参考图」一个：`accepted_media_slots` 含 `reference_image` 时才生成
 * image 表单字段与 `input` 的 inline_data 分支（族能力声明在注册表条目 `supportsMediaSlots`，
 * 与这里同源）。无该素材位时只生成文生图形态（请求体 `input` 只有 text 块）。
 */

/** 本族适配器 id（值域 owner 仍是 contracts 的 GENERATION_FAMILY_ADAPTER_IDS）。 */
export const GEMINI_IMAGE_INTERACTIONS_V1_FAMILY_ADAPTER_ID = 'gemini-image-interactions-v1';

/** 本族模板能表达的全部素材位（一致性事实源：与注册表条目的 supportsMediaSlots 同值）。 */
export const GEMINI_IMAGE_INTERACTIONS_V1_SUPPORTED_MEDIA_SLOTS = ['reference_image'] as const;

/** Interactions API 提交端点（与适配器 relative_endpoints.interactions 同值）。 */
const INTERACTIONS_ENDPOINT = '/v1beta/interactions';

/**
 * 单个请求的参考图张数上限（登记契约 §8：全族总量 ≤ 14；在役三个包一致）。
 *
 * 官方按型号分桶（Pro 6 物体 + 5 角色 + 3 风格、Flash/Lite 14 张），分桶守卫在创作面，
 * 协议层只有 14 这个硬上限——族模板只表达硬上限。
 */
const MAX_REFERENCE_IMAGES = 14;

/** 尺寸档枚举（族通用形态）与不合法值回落档（官方默认 1K，大写 K 强制）。 */
const IMAGE_SIZE_TIERS = ['1K', '2K', '4K'] as const;
const IMAGE_SIZE_FALLBACK = '1K';

/** 画面比例枚举（族通用形态：全族 10 个，register 里 flash 独有 4 个极端比例不入族模板）。 */
const ASPECT_RATIO_PRESETS = [
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
] as const;

// ---------------------------------------------------------------------------
// 参数表单字段（提炼自 gemini 图像族在役包，label/description 为本地化键）
// ---------------------------------------------------------------------------

/** 比例枚举值的 locales 键片段（`1:1` → `1_1`，与在役包 locales 同构）。 */
const localeKeyOfRatio = (value: string): string => value.replace(/:/g, '_');

const buildEnumOptions = (labelPrefix: string, values: readonly string[]): JsonObject[] =>
  values.map((value) => ({
    value,
    label: `${labelPrefix}.${localeKeyOfRatio(value)}.label`,
  }));

/**
 * 参数表单（族通用形态）。
 *
 * **族内型号差异的取舍**（三个在役包合法集不同：pro 10 比例 / 1K-2K-4K，flash 14 比例 /
 * 512-1K-2K-4K，lite 10 比例 / 仅 1K）：族模板取**族通用形态**——
 * - 只排除「只有一个型号支持的个性档位」：flash 的 `512` 与 `1:4`/`4:1`/`1:8`/`8:1`。
 *   这与 openai-image 族排除 gpt-image-2.5 的 `xhigh`/`max` 是同一动作（先例原文：
 *   「模型个性档位，不入族模板」）。
 * - 不取严格交集：严格交集会把 `imageSize` 收敛成只有 `1K` 一个选项——一个改不动的控件，
 *   等于让整族默认放弃 2K/4K 这个 Pro/Flash 的主力能力，且把「解锁 4K」推到「参数覆盖」
 *   这个高级入口。缩小版型号（lite）的 1K 上限属于**记录级收窄**：用户在该记录上把
 *   `imageSize` 的枚举收窄到 1K 即可（records 的 parameter_overrides 已支持 select 枚举改写）。
 * - 不取并集：并集会把 flash 独有档位预发给 Pro/Lite，提交后才被上游拒绝——这正是族模板
 *   要避免的「能选但一提交就失败」。
 *
 * `allowed_values`（请求体 `image_size` 的 normalize_enum）与表单枚举同源：两者不一致会
 * 产生「用户选了 4K、wire 上被静默改成 1K」的静默降级（比报错更难排查）。
 */
const buildParameterSchema = (supportsReferenceImage: boolean): JsonObject => {
  const fields: JsonObject[] = [];
  const defaultValues: JsonObject = {};
  if (supportsReferenceImage) {
    fields.push({
      field_key: 'image',
      label: 'fields.image.label',
      description: 'fields.image.description',
      required: false,
      default_value: [],
      validation_rules: [],
      layout: { colSpan: 1 },
      component: 'imageUpload',
      component_props: { accept: 'image/*', maxFiles: MAX_REFERENCE_IMAGES },
      data_source: 'both',
    });
    defaultValues.image = [];
  }
  fields.push(
    {
      field_key: 'aspectRatio',
      label: 'fields.aspectRatio.label',
      description: 'fields.aspectRatio.description',
      required: false,
      default_value: 'auto',
      validation_rules: [],
      layout: { colSpan: 1 },
      component: 'select',
      // auto 表示不发送 aspect_ratio（请求体里由 compact_object 省略该键，跟随参考图比例）。
      enum_options: buildEnumOptions('fields.aspectRatio.options', ['auto', ...ASPECT_RATIO_PRESETS]),
      component_props: {},
    },
    {
      field_key: 'imageSize',
      label: 'fields.imageSize.label',
      description: 'fields.imageSize.description',
      required: false,
      default_value: IMAGE_SIZE_FALLBACK,
      validation_rules: [],
      layout: { colSpan: 1 },
      component: 'select',
      enum_options: buildEnumOptions('fields.imageSize.options', IMAGE_SIZE_TIERS),
      component_props: {},
    },
    {
      field_key: 'mimeType',
      label: 'fields.mimeType.label',
      description: 'fields.mimeType.description',
      required: false,
      default_value: 'image/jpeg',
      validation_rules: [],
      layout: { colSpan: 1 },
      component: 'select',
      // 官方 REST reference 只列 image/jpeg（登记契约 §5.3 的官方内部不一致处按 reference 落定）。
      enum_options: [{ value: 'image/jpeg', label: 'fields.mimeType.options.image_jpeg.label' }],
      component_props: {},
    },
  );
  defaultValues.aspectRatio = 'auto';
  defaultValues.imageSize = IMAGE_SIZE_FALLBACK;
  defaultValues.mimeType = 'image/jpeg';
  return {
    schema_type: 'object',
    fields,
    required_fields: [],
    default_values: defaultValues,
    validation_rules: [],
  };
};

// ---------------------------------------------------------------------------
// payload_rules（提炼自 gemini 图像族在役包）
// ---------------------------------------------------------------------------

/**
 * 请求体 `input`：interactions 扁平 content blocks。
 *
 * 参考图分支把 image 字段按 `extractUrls` 取媒体后由 `inline_data` 目标转成内联 base64，
 * 与在役包同构（`max_items` 与表单 maxFiles 同值）。文生图分支**不引用 image 字段**——
 * 该形态下表单里根本没有这个字段，引用不存在的字段会被
 * validatePayloadRuleFieldKeys 拒掉。
 */
const buildContentBlocksRule = (supportsReferenceImage: boolean): JsonObject => {
  const parts: JsonObject[] = [
    {
      part_kind: 'text',
      value: { kind: 'field', field_key: '__prompt', transforms: ['trim'] },
    },
  ];
  if (supportsReferenceImage) {
    parts.push({
      part_kind: 'inline_data',
      value: {
        kind: 'field',
        field_key: 'image',
        transforms: ['extractUrls'],
        media_target: 'inline_data',
      },
      multiple: true,
      max_items: MAX_REFERENCE_IMAGES,
    });
  }
  return {
    kind: 'compute',
    operator: 'build_content_blocks',
    // 规则级 media_target 是「本规则处理媒体」的声明，打包/投影校验据此确认媒体目标存在
    // （operator build_content_blocks 本身即媒体规则，即使文生图分支没有 inline_data part）。
    media_target: 'inline_data',
    cache_key: 'declaredGeminiImageInteractions.input',
    options: {
      output_shape: 'interactions_input',
      parts,
    },
  };
};

/**
 * 请求体 `response_format`：`{ type:'image', aspect_ratio?, image_size, mime_type }`
 * （登记契约 §5.3）。
 *
 * - `aspect_ratio` 是条件求值：表单值为 `auto` 时整条被 compact_object 省略，
 *   让服务端跟随参考图比例（登记契约 §7 默认行为）。
 * - `image_size` 经 normalize_enum 收敛到族档位集合，非法值回落 1K（与在役包同构）。
 * - `mime_type` 直取表单值（枚举只有一个值，但必须发送）。
 *
 * **为什么 image_size / mime_type 外层再包一层 `when truthy <field>`**（在役包没有这一层）：
 * 这层守卫有**两重作用**，不能因为「合成层口径已修」就拆掉。
 *
 * 1. 保存期语义（曾是结构缺口，现已由共享实现统一）：字段引用落在 `condition.field` 上，
 *    「禁用该字段」会被保存期判为「参与决定请求怎么发送」→ 可读拒绝，而不是在合成期抛
 *    `invalid_payload_rule_field_key` 或静默删掉整条 `body.response_format`。该缺口已修：
 *    引用提取统一在 `model-package-catalog.payload-rule-references.cts`，数组与
 *    `compute.args[]` 里的引用同样可见，**即使去掉守卫也一样能判出来**（回归测试
 *    `generation-parameter-overrides.test.ts` 的「无守卫形态」用例钉住）。
 * 2. **请求体省略语义（与合成层无关，守卫不可拆）**：`when` 不只是「声明依赖」，它真的改变
 *    求值结果——表单值为空时整条键被省略。实测（`assets`/表单值为 `''` 或 `undefined`）：
 *    有守卫 → `response_format` 不含 `image_size`，服务端走官方默认档；无守卫 →
 *    `normalize_enum` 把空值收敛成 `fallback` 并**发出** `image_size:"1K"`，
 *    凭空给请求体塞了一个用户没选的档位。`mime_type` 同理（空值时不发，而非发空串）。
 *
 * 结论：守卫**保留**。它当前承担的「空值不发」语义是在役包所没有的、本族模板的有意行为，
 * 拆掉会让空值变成显式档位，属行为回归而非清理。
 */
const buildResponseFormatRule = (): JsonObject => ({
  kind: 'compute',
  operator: 'compact_object',
  cache_key: 'declaredGeminiImageInteractions.responseFormat',
  entries: {
    type: { kind: 'literal', value: 'image' },
    aspect_ratio: {
      kind: 'when',
      condition: { op: 'ne', field: 'aspectRatio', value: 'auto' },
      truthy: { kind: 'field', field_key: 'aspectRatio', transforms: ['trim'] },
    },
    image_size: {
      kind: 'when',
      // 双重作用（见上）：①空值不发——守卫真的改变求值结果，去掉会让空值被 fallback 填成 1K；
      // ②把字段引用暴露在 condition.field 上，语义上它确实参与决定请求怎么发送。
      condition: { op: 'truthy', field: 'imageSize' },
      truthy: {
        kind: 'compute',
        operator: 'normalize_enum',
        cache_key: 'declaredGeminiImageInteractions.imageSize',
        args: [{ kind: 'field', field_key: 'imageSize', transforms: ['trim'] }],
        options: {
          allowed_values: [...IMAGE_SIZE_TIERS],
          fallback: IMAGE_SIZE_FALLBACK,
        },
      },
    },
    mime_type: {
      kind: 'when',
      condition: { op: 'truthy', field: 'mimeType' },
      truthy: { kind: 'field', field_key: 'mimeType', transforms: ['trim'] },
    },
  },
});

/**
 * payload_rules（单一 endpoint，无分支）：`body.model` 的字面量在合成时替换为声明
 * model_id，派发前再由 remote_model_id 注入覆盖（适配器把该族归入 body 注入类）。
 */
const buildPayloadRules = (modelId: string, supportsReferenceImage: boolean): JsonObject => ({
  'api.endpoint': { kind: 'literal', value: INTERACTIONS_ENDPOINT },
  'api.method': { kind: 'literal', value: 'POST' },
  'api.contentType': { kind: 'literal', value: 'application/json' },
  'body.model': { kind: 'literal', value: modelId },
  'body.input': buildContentBlocksRule(supportsReferenceImage),
  'body.response_format': buildResponseFormatRule(),
  prompt: { kind: 'field', field_key: '__prompt', transforms: ['trim'] },
  input: { kind: 'field', field_key: '__prompt', transforms: ['trim'] },
  'meta.model_id': { kind: 'literal', value: modelId },
  'meta.aspectRatio': { kind: 'field', field_key: 'aspectRatio' },
  'meta.imageSize': { kind: 'field', field_key: 'imageSize' },
});

// ---------------------------------------------------------------------------
// 模板级 locales（键名与在役包 locales 同构；zh-CN/en 内联，声明不携带文案）
// ---------------------------------------------------------------------------

const TEMPLATE_LOCALES_ZH_CN: ModelAssetLocalizationResourceMap = {
  fields: {
    prompt: { label: '提示词' },
    image: {
      label: '参考图',
      description: '可上传多张参考图（最多 14 张）；文生图时留空。',
    },
    aspectRatio: {
      label: '画面比例',
      description: '默认自动：不指定时跟随参考图比例，无参考图时为 1:1。',
      options: {
        auto: { label: '自动' },
        '1_1': { label: '1:1' },
        '2_3': { label: '2:3' },
        '3_2': { label: '3:2' },
        '3_4': { label: '3:4' },
        '4_3': { label: '4:3' },
        '4_5': { label: '4:5' },
        '5_4': { label: '5:4' },
        '9_16': { label: '9:16' },
        '16_9': { label: '16:9' },
        '21_9': { label: '21:9' },
      },
    },
    imageSize: {
      label: '尺寸档',
      description: '默认 1K，可选 1K / 2K / 4K。',
      options: {
        '1K': { label: '1K' },
        '2K': { label: '2K' },
        '4K': { label: '4K' },
      },
    },
    mimeType: {
      label: '输出格式',
      description: '官方目前只列出 image/jpeg。',
      options: {
        image_jpeg: { label: 'image/jpeg' },
      },
    },
  },
  ports: {
    inputs: {
      image: { name: '参考图', description: '接入素材或资产节点作为参考图；文生图时留空。' },
    },
    outputs: {
      image: { name: '生成图像', description: '生成的图像结果。' },
    },
  },
};

const TEMPLATE_LOCALES_EN: ModelAssetLocalizationResourceMap = {
  fields: {
    prompt: { label: 'Prompt' },
    image: {
      label: 'Reference images',
      description: 'Attach up to 14 reference images; leave empty for text-to-image.',
    },
    aspectRatio: {
      label: 'Aspect ratio',
      description: 'Defaults to auto: the output follows the reference images, or 1:1 without references.',
      options: {
        auto: { label: 'Auto' },
        '1_1': { label: '1:1' },
        '2_3': { label: '2:3' },
        '3_2': { label: '3:2' },
        '3_4': { label: '3:4' },
        '4_3': { label: '4:3' },
        '4_5': { label: '4:5' },
        '5_4': { label: '5:4' },
        '9_16': { label: '9:16' },
        '16_9': { label: '16:9' },
        '21_9': { label: '21:9' },
      },
    },
    imageSize: {
      label: 'Image size',
      description: 'Defaults to 1K. Available: 1K, 2K, 4K.',
      options: {
        '1K': { label: '1K' },
        '2K': { label: '2K' },
        '4K': { label: '4K' },
      },
    },
    mimeType: {
      label: 'Output format',
      description: 'Only image/jpeg is listed in the official REST reference.',
      options: {
        image_jpeg: { label: 'image/jpeg' },
      },
    },
  },
  ports: {
    inputs: {
      image: { name: 'Reference images', description: 'Connect assets as references; leave empty for text-to-image.' },
    },
    outputs: {
      image: { name: 'Generated image', description: 'Generated image output.' },
    },
  },
};

const TEMPLATE_LOCALIZATION_RESOURCES: LocaleResources = {
  'zh-CN': TEMPLATE_LOCALES_ZH_CN,
  en: TEMPLATE_LOCALES_EN,
};

/** JSON 值的深克隆（模板默认值表复用：同一 JSON 树不得被两处共享引用）。 */
const cloneJsonObject = (value: unknown): JsonObject =>
  cloneJsonValue(value ?? null) as JsonObject;

// ---------------------------------------------------------------------------
// 族模板工厂
// ---------------------------------------------------------------------------

/**
 * gemini-image-interactions-v1 基础族模板（不含记录覆盖）：从 model_id 与接受的素材位合成
 * runtime_model / node_definition / locales 形状的内存态包源，交给与已装包相同的投影路径。
 *
 * 记录覆盖由注册表的通用合成入口（`buildFamilyTemplateSources`）统一应用；基础模板单独
 * 导出是因为覆盖校验（保存期）需要在**未应用覆盖**的模板上运行（设计 §3.3 校验唯一实现）。
 */
export const buildGeminiImageInteractionsV1BaseTemplateSources = (
  modelId: string,
  options: GenerationFamilyTemplateOptions,
): GenerationFamilyTemplateSources => {
  const supportsReferenceImage = options.acceptedMediaSlots.includes('reference_image');
  const inputModalities = supportsReferenceImage ? ['text', 'image'] : ['text'];
  const capability: JsonObject = {
    input_modalities: inputModalities,
    output_modalities: ['image'],
    supports_async_task: false,
    supports_streaming: false,
    supports_multi_image: supportsReferenceImage,
    supports_reference_media: supportsReferenceImage,
    constraints: [],
  };
  const parameterSchema = buildParameterSchema(supportsReferenceImage);
  const payloadRules = buildPayloadRules(modelId, supportsReferenceImage);
  const inputPorts: JsonObject[] = supportsReferenceImage
    ? [
        {
          id: 'image',
          name: 'ports.inputs.image.name',
          data_type: 'image',
          field_key: 'image',
          required: false,
          multiple: true,
          description: 'ports.inputs.image.description',
        },
      ]
    : [];
  const runtimeModel: JsonObject = {
    model_id: modelId,
    provider_id: 'google',
    default_task_type: 'image',
    mode: 'image',
    role: 'generator',
    capability,
    parameter_schema: parameterSchema,
    execution_profile: {
      task_type: 'image',
      supports_async_task: false,
    },
    display: {
      visible: true,
      // 与 openai-image 族同一约定：声明模型的目录排序排在已装包之后。
      order: 9000,
    },
    runtime: {
      provider_id: 'google',
      default_task_type: 'image',
      mode: 'image',
      aliases: [],
      // 单一 endpoint、固定 JSON 体：两种素材位形态都不需要条件求值的 payload_format。
      payload_format: 'json',
      workspace: {
        task_list_position: 'bottom',
        task_queue: {
          enabled: true,
          // 与在役 gemini 图像包同值（在役包 max_concurrent=30）。
          max_concurrent: 30,
        },
      },
      api_defaults: {
        endpoint: INTERACTIONS_ENDPOINT,
        method: 'POST',
        contentType: 'application/json',
      },
      payload_rules: payloadRules,
      capabilities: {
        execution_traits: ['nonBlocking'],
      },
      schema_defaults: cloneJsonObject(parameterSchema.default_values),
      execution_driver: 'http_formal_task',
    },
    request_strategy: {
      request_stage: 'submit',
      protocol: 'http',
      endpoint: INTERACTIONS_ENDPOINT,
      method: 'POST',
      header_rules: [],
      body_rules: [],
      query_rules: [],
    },
    // 同步接口：无轮询策略（登记契约 §9.3「图像生成是同步/流式/后台三形态」）。
    result_rule: {
      mode: 'sync',
      submit_response_id_path: '/id',
      failure_condition: {
        op: 'any',
        children: [
          { op: 'not_empty', path: 'error.message' },
          { op: 'not_empty', path: 'error.code' },
          { op: 'not_empty', path: 'error.status' },
        ],
      },
      error_mapping_rules: [
        {
          target: 'code',
          source: { kind: 'response', path: 'error.code' },
          required: false,
        },
        {
          target: 'message',
          source: { kind: 'response', path: 'error.message' },
          required: false,
        },
        {
          target: 'details.remote.status',
          source: { kind: 'response', path: 'error.status' },
          required: false,
        },
      ],
    },
    // 产出是 steps[] 里的图像块（base64 内联），与在役包同构。
    result_output_mapping: {
      response_mode: 'structured_payload',
      output_mapping_rules: [
        {
          target: 'output.image_url',
          source: { kind: 'response', path: 'steps.[].content' },
          required: true,
        },
        {
          target: 'output.text',
          source: { kind: 'response', path: 'steps.[].content' },
          required: false,
          default_value: null,
        },
      ],
      note: 'declared generation model (gemini-image-interactions-v1 family template)',
    },
    prompt_field: {
      field_key: '__prompt',
      required: true,
      validation_rules: [],
    },
  };
  const node: JsonObject = {
    node_type: 'model',
    group_key: 'google',
    input_ports: inputPorts,
    output_ports: [
      {
        id: 'image',
        name: 'ports.outputs.image.name',
        data_type: 'image',
        field_key: 'output_image',
        multiple: true,
        description: 'ports.outputs.image.description',
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
 * gemini-image-interactions-v1 的参数描述（GET /api/generation-family-templates/:familyAdapterId 的数据）。
 *
 * 与 openai-image 族同一口径：以「不接受任何素材位」基线构建（素材位字段不进编辑器），
 * 另把参考图分支的 payload_rules 并入保留键计算——基线是文生图形态，但声明可能接受参考图，
 * 该分支的键同样要保留（当前两分支的 wire 键集相同，并入是为了让保留键口径始终覆盖两个分支）。
 */
export const buildGeminiImageInteractionsV1ParameterDescriptor = (): FamilyTemplateParameterDescriptor =>
  buildFamilyTemplateParameterDescriptorFromSources({
    familyAdapterId: GEMINI_IMAGE_INTERACTIONS_V1_FAMILY_ADAPTER_ID,
    baselineSources: buildGeminiImageInteractionsV1BaseTemplateSources('descriptor-baseline', {
      acceptedMediaSlots: [],
    }),
    extraPayloadRuleSets: [buildPayloadRules('descriptor-baseline', true)],
  });
