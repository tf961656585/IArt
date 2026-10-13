import { cloneJsonValue, type FamilyTemplateParameterDescriptor, type ParameterOverrides } from '@iart/contracts';
import type { ModelAssetLocalizationResourceMap } from '@iart/contracts/model-asset-contract';
import { isObjectRecord } from './model-package-catalog.shared.cts';
import type { CatalogRawObject, JsonObject } from './model-package-catalog.types.cts';
import type { LocaleResources } from './model-package-catalog.localization.cts';
import {
  applyParameterOverrides,
  collectReservedWireNames,
  collectWireNamesByFieldKey,
  EMPTY_PARAMETER_OVERRIDES,
  isScalarParameterValue,
  resolveLocaleText,
} from './generation-parameter-overrides.cts';

/**
 * 生成族模板（docs/custom-providers/生成模型自建声明试点-design.md §3.3）。
 *
 * 用户自建生成模型没有模型能力包：声明（CustomGenerationModel）只携带模型属性，协议语义与
 * 默认参数表单由本模块内置的族模板承载。试点单族 openai-image-v1（OpenAI 图像接口）。
 *
 * 提炼来源：现役 openai-image 族在役包 `.model-assets/sources/gpt-image-2/runtime_model.json`
 * 的协议不变部分（payload_rules / request_strategy / result_rule / result_output_mapping /
 * runtime.api_defaults），并对齐登记契约 `docs/provider-remote-apis/03-OpenAI-图像生成接口.md`：
 * - endpoint 两分支（generations / edits）必须与 `packages/contracts` ADAPTER_REGISTRY 中
 *   openai-image-v1 的 relative_endpoints 一致，由
 *   `__tests__/generation-family-template-consistency.test.ts` 一致性门禁钉住（设计 §3.4）。
 * - quality 档位取**族通用形态** `auto/low/medium/high`（登记契约 §12：早期版本封顶 high；
 *   个别高阶模型的 `xhigh`/`max` 是模型个性档位，不入族模板——用户声明的是任意
 *   「gpt 接口格式」模型，不能预发其不支持的档位）。
 * - size 保留在役包的 imageSize constrainedResolution 组件形态（16 倍数、长边 ≤3840、
 *   像素 655,360–8,294,400、AR ≤3），与登记契约 §6.1 的 gpt-image-2 系约束一致；K 档
 *   （1k/2k/4k pixelBudget）是包内产品档位且 4k 预算即契约像素上限，无值域冲突，随包形态保留。
 * - `format` 字段是产品侧 UI 键，wire 字段名由 payload_rules `body.output_format` 承载
 *   （登记契约 2026-09-22 裁断：t2i 与 i2i 两路都发送 output_format）。
 * - prompt_field：保留键 `__prompt`，必填；validation_rules 与现役包一致为空（现役包未落
 *   max_length 规则，登记契约 §12 的 32000 chars 上限不在交互层强制——与现役对齐，设计 §3.3）。
 *
 * 模板级 locales（协议与参数文案）内联在本模块，键名与在役包 locales 同构；合成投影经
 * buildProjectionFromPackageSources 走与已装包相同的本地化投影路径，禁止在投影处硬编码文案。
 *
 * 本模块是 Runtime Backend 内置资源：不进 contracts、不落 .model-assets 安装目录；合成投影
 * 是纯内存态（模型包目录零写入）。
 */

/** 试点族唯一适配器 id（与 packages/contracts GENERATION_FAMILY_ADAPTER_IDS 对齐）。 */
export const OPENAI_IMAGE_V1_FAMILY_ADAPTER_ID = 'openai-image-v1';

/** 合成投影的虚拟包身份（本地化命名空间 `model-asset/<packageId>` 的载体）。 */
export const DECLARED_GENERATION_PACKAGE_ID = 'declared-openai-image-v1';

/** JSON 值的深克隆（模板默认值表复用：同一 JSON 树不得被两处共享引用）。 */
const cloneJsonObject = (value: unknown): JsonObject =>
  cloneJsonValue(value ?? null) as JsonObject;

/** 族模板来源：交给 buildProjectionFromPackageSources 走与已装包相同的投影路径。 */
export type GenerationFamilyTemplateSources = {
  runtimeModel: CatalogRawObject;
  node: CatalogRawObject;
  localizationResources: LocaleResources;
};

/**
 * JsonObject 字面量 → CatalogRawObject 的边界收窄（仓库惯用的 isObjectRecord 运行时守卫，
 * 不用类型断言：CatalogRawObject 的读侧属性是「必需但可 undefined」，弱类型检查不接受
 * 无索引签名的字面量直赋）。
 */
const toCatalogRawObject = (value: JsonObject): CatalogRawObject => {
  if (!isObjectRecord(value)) {
    throw new Error('generation_family_template_source_invalid');
  }
  return value;
};

export type GenerationFamilyTemplateOptions = {
  /** 声明的「支持参考图」：true = i2i 能力 + image 表单字段 + edits 分支；false = 仅文生图。 */
  supportsReferenceImage: boolean;
  /**
   * 声明的参数覆盖（生成模型参数高级自定义设计 §3.2/§3.3）：可省略，省略即空覆盖。
   * 空覆盖时合成函数原样返回基础模板（同一引用），行为与无覆盖完全一致（S8）。
   */
  parameterOverrides?: ParameterOverrides;
};

// ---------------------------------------------------------------------------
// 参数表单字段（提炼自 gpt-image-2 包，label/description 为本地化键）
// ---------------------------------------------------------------------------

const imageSizeComponentProps = {
  mode: 'constrainedResolution',
  allowAuto: true,
  sizeLevels: [
    { id: '1k', label: 'fields.size.sizeLevels.1k.label', pixelBudget: 1048576 },
    { id: '2k', label: 'fields.size.sizeLevels.2k.label', pixelBudget: 4194304 },
    { id: '4k', label: 'fields.size.sizeLevels.4k.label', pixelBudget: 8294400 },
  ],
  aspectPresets: [
    { id: '1:1', label: 'fields.size.aspectPresets.1_1.label', ratio: 1 },
    { id: '3:2', label: 'fields.size.aspectPresets.3_2.label', ratio: 1.5 },
    { id: '2:3', label: 'fields.size.aspectPresets.2_3.label', ratio: 0.6666666667 },
    { id: '16:9', label: 'fields.size.aspectPresets.16_9.label', ratio: 1.7777777778 },
    { id: '9:16', label: 'fields.size.aspectPresets.9_16.label', ratio: 0.5625 },
  ],
  presetOptions: [
    {
      value: 'auto',
      label: 'fields.size.presetOptions.auto.label',
      description: 'fields.size.presetOptions.auto.description',
    },
  ],
  customPresets: [
    { value: '1024x1024' },
    { value: '1536x1024' },
    { value: '1024x1536' },
    { value: '1920x1088' },
    { value: '2560x1440' },
    { value: '3840x2160' },
  ],
  constraints: {
    dimensionMultiple: 16,
    maxLongEdge: 3840,
    minPixels: 655360,
    maxPixels: 8294400,
    maxAspectRatio: 3,
  },
};

const buildParameterSchema = (options: GenerationFamilyTemplateOptions): JsonObject => {
  const fields: JsonObject[] = [];
  const defaultValues: JsonObject = {};
  if (options.supportsReferenceImage) {
    fields.push({
      field_key: 'image',
      label: 'fields.image.label',
      description: 'fields.image.description',
      required: false,
      default_value: [],
      validation_rules: [],
      layout: { colSpan: 1 },
      component: 'imageUpload',
      component_props: { accept: 'image/*', maxFiles: 16 },
      data_source: 'both',
    });
    defaultValues.image = [];
  }
  fields.push(
    {
      field_key: 'size',
      label: 'fields.size.label',
      description: 'fields.size.description',
      required: false,
      default_value: 'auto',
      validation_rules: [],
      layout: { colSpan: 2 },
      component: 'imageSize',
      component_props: imageSizeComponentProps,
    },
    {
      field_key: 'quality',
      label: 'fields.quality.label',
      description: 'fields.quality.description',
      required: false,
      default_value: 'auto',
      validation_rules: [],
      layout: { colSpan: 1 },
      component: 'select',
      // 族通用档位（登记契约 §12）：auto/low/medium/high；2.5 的 xhigh/max 不入族模板。
      enum_options: [
        { value: 'auto', label: 'fields.quality.options.auto.label' },
        { value: 'low', label: 'fields.quality.options.low.label' },
        { value: 'medium', label: 'fields.quality.options.medium.label' },
        { value: 'high', label: 'fields.quality.options.high.label' },
      ],
      component_props: {},
    },
    {
      field_key: 'format',
      label: 'fields.format.label',
      description: 'fields.format.description',
      required: false,
      default_value: 'jpeg',
      validation_rules: [],
      layout: { colSpan: 1 },
      component: 'select',
      enum_options: [
        { value: 'png', label: 'fields.format.options.png.label' },
        { value: 'jpeg', label: 'fields.format.options.jpeg.label' },
        { value: 'webp', label: 'fields.format.options.webp.label' },
      ],
      component_props: {},
    },
    {
      field_key: 'moderation',
      label: 'fields.moderation.label',
      description: 'fields.moderation.description',
      required: false,
      default_value: 'auto',
      validation_rules: [],
      layout: { colSpan: 1 },
      component: 'select',
      enum_options: [
        { value: 'auto', label: 'fields.moderation.options.auto.label' },
        { value: 'low', label: 'fields.moderation.options.low.label' },
      ],
      component_props: {},
    },
  );
  defaultValues.size = 'auto';
  defaultValues.quality = 'auto';
  defaultValues.format = 'jpeg';
  defaultValues.moderation = 'auto';
  return {
    schema_type: 'object',
    fields,
    required_fields: [],
    default_values: defaultValues,
    validation_rules: [],
  };
};

// ---------------------------------------------------------------------------
// payload_rules（提炼自 gpt-image-2 包）
// ---------------------------------------------------------------------------

/**
 * i2i 能力形态：与在役包同构的条件规则——image 非空走 edits（multipart），否则 generations（JSON）。
 * `body.model` / `meta.model_id` 的字面量在合成时替换为声明 model_id（remote_model_id 注入的
 * 占位身份，与在役包「包内字面量=产品 model_id」同一形态）。
 */
const buildConditionalPayloadRules = (modelId: string): JsonObject => ({
  'api.endpoint': {
    kind: 'when',
    condition: { op: 'ne', field: 'image', value: [] },
    truthy: { kind: 'literal', value: '/v1/images/edits' },
    falsy: { kind: 'literal', value: '/v1/images/generations' },
  },
  'api.method': { kind: 'literal', value: 'POST' },
  'api.contentType': {
    kind: 'when',
    condition: { op: 'ne', field: 'image', value: [] },
    truthy: { kind: 'literal', value: null },
    falsy: { kind: 'literal', value: 'application/json' },
  },
  'api.headers.Accept': { kind: 'literal', value: 'application/json' },
  'body.model': { kind: 'literal', value: modelId },
  'body.prompt': { kind: 'field', field_key: '__prompt', transforms: ['trim'] },
  'body.image': {
    kind: 'when',
    condition: { op: 'ne', field: 'image', value: [] },
    truthy: {
      kind: 'compute',
      operator: 'assert_array_length',
      args: [
        {
          kind: 'field',
          field_key: 'image',
          transforms: ['allUploadFiles'],
          media_target: 'multipart_file',
        },
      ],
      cache_key: 'declaredGeneration.image',
      options: {
        min_items: 1,
        max_items: 16,
        message: '请至少提供 1 张要编辑的图片。',
      },
    },
    falsy: { kind: 'literal', value: null },
  },
  'body.n': {
    kind: 'when',
    condition: { op: 'ne', field: 'image', value: [] },
    truthy: { kind: 'literal', value: null },
    falsy: { kind: 'literal', value: 1 },
  },
  'body.size': { kind: 'field', field_key: 'size' },
  'body.quality': { kind: 'field', field_key: 'quality' },
  'body.output_format': { kind: 'field', field_key: 'format' },
  'body.moderation': { kind: 'field', field_key: 'moderation' },
  prompt: { kind: 'field', field_key: '__prompt', transforms: ['trim'] },
  input: { kind: 'field', field_key: '__prompt', transforms: ['trim'] },
  'meta.size': { kind: 'field', field_key: 'size' },
  'meta.model_id': { kind: 'literal', value: modelId },
});

/**
 * 仅文生图形态：无 image 表单字段（validatePayloadRuleFieldKeys 禁止引用不存在的字段），
 * 条件规则展平为 generations 静态分支——endpoint/contentType/固定 n=1 全部为字面量，
 * 请求组装期不再依赖 image 字段求值。
 */
const buildT2iOnlyPayloadRules = (modelId: string): JsonObject => ({
  'api.endpoint': { kind: 'literal', value: '/v1/images/generations' },
  'api.method': { kind: 'literal', value: 'POST' },
  'api.contentType': { kind: 'literal', value: 'application/json' },
  'api.headers.Accept': { kind: 'literal', value: 'application/json' },
  'body.model': { kind: 'literal', value: modelId },
  'body.prompt': { kind: 'field', field_key: '__prompt', transforms: ['trim'] },
  'body.n': { kind: 'literal', value: 1 },
  'body.size': { kind: 'field', field_key: 'size' },
  'body.quality': { kind: 'field', field_key: 'quality' },
  'body.output_format': { kind: 'field', field_key: 'format' },
  'body.moderation': { kind: 'field', field_key: 'moderation' },
  prompt: { kind: 'field', field_key: '__prompt', transforms: ['trim'] },
  input: { kind: 'field', field_key: '__prompt', transforms: ['trim'] },
  'meta.size': { kind: 'field', field_key: 'size' },
  'meta.model_id': { kind: 'literal', value: modelId },
});

// ---------------------------------------------------------------------------
// 模板级 locales（键名与在役包 locales 同构；zh-CN/en 内联，声明不携带文案）
// ---------------------------------------------------------------------------

const TEMPLATE_LOCALES_ZH_CN: ModelAssetLocalizationResourceMap = {
  fields: {
    prompt: { label: '提示词' },
    size: {
      label: '画面尺寸',
      description: '可自动选择尺寸，也可按档位与比例（含自定义比例）设置输出尺寸。',
      sizeLevels: {
        '1k': { label: '1K' },
        '2k': { label: '2K' },
        '4k': { label: '4K' },
      },
      aspectPresets: {
        '1_1': { label: '1:1' },
        '3_2': { label: '3:2' },
        '2_3': { label: '2:3' },
        '16_9': { label: '16:9' },
        '9_16': { label: '9:16' },
      },
      presetOptions: {
        auto: { label: '自动', description: '由模型决定输出尺寸' },
      },
    },
    quality: {
      label: '图片画质',
      description: '默认自动，档位越高画质越精细。',
      options: {
        auto: { label: '自动' },
        low: { label: '低' },
        medium: { label: '中' },
        high: { label: '高' },
      },
    },
    format: {
      label: '图片格式',
      description: '可选 png、jpeg 或 webp，默认 jpeg。',
      options: {
        png: { label: 'PNG' },
        jpeg: { label: 'JPEG' },
        webp: { label: 'WebP' },
      },
    },
    moderation: {
      label: '内容审核',
      description: '可选 low 或 auto，默认 auto。',
      options: {
        auto: { label: '自动' },
        low: { label: '低' },
      },
    },
    image: {
      label: '参考图',
      description: '上传一张或多张要编辑的图片。',
    },
  },
  ports: {
    outputs: {
      image: { name: '图像' },
    },
    inputs: {
      prompt: { name: '提示词', description: '描述要生成的编辑效果。' },
      image: { name: '参考图', description: '传入要编辑的图片文件。' },
    },
  },
};

const TEMPLATE_LOCALES_EN: ModelAssetLocalizationResourceMap = {
  fields: {
    prompt: { label: 'Prompt' },
    size: {
      label: 'Image size',
      description: 'Choose auto sizing, or set the output size by level and aspect ratio (custom ratios supported).',
      sizeLevels: {
        '1k': { label: '1K' },
        '2k': { label: '2K' },
        '4k': { label: '4K' },
      },
      aspectPresets: {
        '1_1': { label: '1:1' },
        '3_2': { label: '3:2' },
        '2_3': { label: '2:3' },
        '16_9': { label: '16:9' },
        '9_16': { label: '9:16' },
      },
      presetOptions: {
        auto: { label: 'Auto', description: 'Let the model decide the output size' },
      },
    },
    quality: {
      label: 'Image quality',
      description: 'Defaults to auto; higher tiers are more refined.',
      options: {
        auto: { label: 'Auto' },
        low: { label: 'Low' },
        medium: { label: 'Medium' },
        high: { label: 'High' },
      },
    },
    format: {
      label: 'Image format',
      description: 'Choose png, jpeg, or webp. Defaults to jpeg.',
      options: {
        png: { label: 'PNG' },
        jpeg: { label: 'JPEG' },
        webp: { label: 'WebP' },
      },
    },
    moderation: {
      label: 'Moderation',
      description: 'Choose low or auto. Defaults to auto.',
      options: {
        auto: { label: 'Auto' },
        low: { label: 'Low' },
      },
    },
    image: {
      label: 'Reference image',
      description: 'Upload one or more images to edit.',
    },
  },
  ports: {
    outputs: {
      image: { name: 'Image' },
    },
    inputs: {
      prompt: { name: 'Prompt', description: 'Describe the edit to generate.' },
      image: { name: 'Reference image', description: 'Images to edit.' },
    },
  },
};

const TEMPLATE_LOCALIZATION_RESOURCES: LocaleResources = {
  'zh-CN': TEMPLATE_LOCALES_ZH_CN,
  en: TEMPLATE_LOCALES_EN,
};

// ---------------------------------------------------------------------------
// 族模板工厂
// ---------------------------------------------------------------------------

/**
 * openai-image-v1 基础族模板（不含声明覆盖）：从声明模型属性合成 runtime_model /
 * node_definition / locales 形状的内存态包源，交给与已装包相同的投影路径。
 *
 * 声明覆盖的应用在 `buildOpenAiImageV1TemplateSources`（合成管线唯一入口）；基础模板单独
 * 导出是因为覆盖校验（保存期）需要在**未应用覆盖**的模板上运行（设计 §3.3 校验唯一实现）。
 */
export const buildOpenAiImageV1BaseTemplateSources = (
  modelId: string,
  options: GenerationFamilyTemplateOptions,
): GenerationFamilyTemplateSources => {
  const supportsReferenceImage = options.supportsReferenceImage;
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
  const parameterSchema = buildParameterSchema(options);
  const payloadRules = supportsReferenceImage
    ? buildConditionalPayloadRules(modelId)
    : buildT2iOnlyPayloadRules(modelId);
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
    provider_id: 'openai',
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
      order: 9000,
    },
    runtime: {
      provider_id: 'openai',
      default_task_type: 'image',
      mode: 'image',
      aliases: [],
      // t2i-only 无 image 字段可判：payload_format 静态 json；i2i 形态与在役包同构走条件求值。
      ...(supportsReferenceImage
        ? {
            payload_format_rule: {
              kind: 'when',
              condition: { op: 'ne', field: 'image', value: [] },
              truthy: { kind: 'literal', value: 'multipart' },
              falsy: { kind: 'literal', value: 'json' },
            },
          }
        : { payload_format: 'json' }),
      workspace: {
        task_list_position: 'bottom',
        task_queue: {
          enabled: true,
          max_concurrent: 10,
        },
      },
      api_defaults: {
        endpoint: '/v1/images/generations',
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
      endpoint: '/v1/images/generations',
      method: 'POST',
      header_rules: [],
      body_rules: [],
      query_rules: [],
    },
    result_rule: {
      mode: 'sync',
      submit_response_id_path: '/id',
      failure_condition: {
        op: 'any',
        children: [
          { op: 'not_empty', path: 'error.message' },
          { op: 'not_empty', path: 'error.code' },
          { op: 'not_empty', path: 'error.type' },
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
          target: 'details.remote.type',
          source: { kind: 'response', path: 'error.type' },
          required: false,
        },
        {
          target: 'details.remote.param',
          source: { kind: 'response', path: 'error.param' },
          required: false,
        },
      ],
    },
    result_output_mapping: {
      response_mode: 'structured_payload',
      output_mapping_rules: [
        {
          target: 'output.image_url',
          source: { kind: 'response', path: 'data' },
          required: true,
        },
      ],
      note: 'declared generation model (openai-image-v1 family template)',
    },
    prompt_field: {
      field_key: '__prompt',
      required: true,
      validation_rules: [],
    },
  };
  const node: JsonObject = {
    node_type: 'model',
    group_key: 'openai',
    input_ports: inputPorts,
    output_ports: [
      {
        id: 'image',
        name: 'ports.outputs.image.name',
        data_type: 'image',
        field_key: 'output_image',
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
 * openai-image-v1 族模板合成唯一入口（基础模板 × 声明参数覆盖 → 合成 sources）。
 *
 * 覆盖应用与校验的唯一实现在 generation-parameter-overrides.cts（设计 §3.3）；空覆盖
 * 快速路径原样返回基础模板（同一引用），保证无覆盖声明与现状行为完全一致（S8）。
 */
export const buildOpenAiImageV1TemplateSources = (
  modelId: string,
  options: GenerationFamilyTemplateOptions,
): GenerationFamilyTemplateSources =>
  applyParameterOverrides(
    buildOpenAiImageV1BaseTemplateSources(modelId, options),
    options.parameterOverrides ?? EMPTY_PARAMETER_OVERRIDES,
  );

// ---------------------------------------------------------------------------
// 族模板参数描述（GET /api/generation-family-templates/:familyAdapterId 的数据构建）
// ---------------------------------------------------------------------------

// 点号路径取文案的实现唯一承载在 generation-parameter-overrides.resolveLocaleText
// （校验错误文案用同一份解析把内部键名换成用户可读显示名），此处不再另写一份。

/**
 * 族模板参数描述（生成模型参数高级自定义设计 §3.4 的编辑器数据源）。
 *
 * 以 supportsReferenceImage=false 基线构建并过滤 image 字段（系统模态字段不可覆盖，不在
 * 编辑器出现）；wire_name 从 payload_rules 的 `body.<键>` target 提取；label 用模板 locales
 * 中文解析；预设从 component_props 提取（含档位/auto/自定义预设全量可选键）；reserved 从
 * 模板两分支 sources 计算。试点单族：未知族返回 null（路由落 404）。
 */
export const buildFamilyTemplateParameterDescriptor = (
  familyAdapterId: string,
): FamilyTemplateParameterDescriptor | null => {
  if (familyAdapterId !== OPENAI_IMAGE_V1_FAMILY_ADAPTER_ID) {
    return null;
  }
  const sources = buildOpenAiImageV1BaseTemplateSources('descriptor-baseline', { supportsReferenceImage: false });
  const runtimeModel = sources.runtimeModel;
  const parameterSchema = toCatalogRawObject(
    isObjectRecord(runtimeModel.parameter_schema) ? runtimeModel.parameter_schema : {},
  );
  const runtime = toCatalogRawObject(isObjectRecord(runtimeModel.runtime) ? runtimeModel.runtime : {});
  const payloadRules = isObjectRecord(runtime.payload_rules) ? runtime.payload_rules : null;
  const wireNameByFieldKey = collectWireNamesByFieldKey(payloadRules);
  // 保留键从两分支（t2i 静态 + i2i 条件）模板 sources 的并集计算：基线是 t2i 形态，
  // 但声明可能开启参考图，image 等分支键同样要保留。
  const reservedWireNames = collectReservedWireNames(payloadRules);
  for (const name of collectReservedWireNames(buildConditionalPayloadRules('descriptor-baseline'))) {
    reservedWireNames.add(name);
  }
  const rawFields = Array.isArray(parameterSchema.fields) ? parameterSchema.fields : [];
  const officialFields: FamilyTemplateParameterDescriptor['official_fields'] = [];
  for (const rawField of rawFields) {
    if (!isObjectRecord(rawField)) continue;
    const fieldKey = typeof rawField.field_key === 'string' ? rawField.field_key : null;
    if (fieldKey === null) continue;
    const component = typeof rawField.component === 'string' ? rawField.component : '';
    if (component.toLowerCase() === 'imageupload') continue; // 系统模态字段不可覆盖，不在编辑器出现
    const labelKey = typeof rawField.label === 'string' && rawField.label ? rawField.label : `fields.${fieldKey}.label`;
    const label = resolveLocaleText(TEMPLATE_LOCALES_ZH_CN, labelKey) ?? fieldKey;
    const wireName = wireNameByFieldKey.get(fieldKey) ?? fieldKey;
    const defaultValue = isScalarParameterValue(rawField.default_value) ? rawField.default_value : null;
    const enumOptions: FamilyTemplateParameterDescriptor['official_fields'][number]['enum_options'] = [];
    if (Array.isArray(rawField.enum_options)) {
      for (const option of rawField.enum_options) {
        if (!isObjectRecord(option)) continue;
        if (isScalarParameterValue(option.value)) enumOptions.push(option.value);
      }
    }
    const labelPrefix = labelKey.endsWith('.label') ? labelKey.slice(0, -'.label'.length) : labelKey;
    const resolutionPresets: FamilyTemplateParameterDescriptor['official_fields'][number]['resolution_presets'] = [];
    const aspectPresets: FamilyTemplateParameterDescriptor['official_fields'][number]['aspect_presets'] = [];
    if (isObjectRecord(rawField.component_props)) {
      const props = rawField.component_props;
      if (Array.isArray(props.sizeLevels)) {
        for (const item of props.sizeLevels) {
          if (!isObjectRecord(item) || typeof item.id !== 'string') continue;
          resolutionPresets.push({
            key: item.id,
            label: resolveLocaleText(TEMPLATE_LOCALES_ZH_CN, `${labelPrefix}.sizeLevels.${item.id}.label`) ?? item.id,
          });
        }
      }
      if (Array.isArray(props.aspectPresets)) {
        for (const item of props.aspectPresets) {
          if (!isObjectRecord(item) || typeof item.id !== 'string') continue;
          // 比例预设 id 形如 '1:1'，locales 键用下划线形态（'1_1'）。
          const localeKey = item.id.replace(/:/g, '_');
          aspectPresets.push({
            key: item.id,
            label: resolveLocaleText(TEMPLATE_LOCALES_ZH_CN, `${labelPrefix}.aspectPresets.${localeKey}.label`) ?? item.id,
          });
        }
      }
    }
    officialFields.push({
      field_key: fieldKey,
      label,
      component,
      wire_name: wireName,
      required: rawField.required === true,
      default_value: defaultValue,
      enum_options: enumOptions,
      resolution_presets: resolutionPresets,
      aspect_presets: aspectPresets,
    });
  }
  return {
    family_adapter_id: familyAdapterId,
    official_fields: officialFields,
    reserved_wire_names: [...reservedWireNames].sort(),
  };
};
