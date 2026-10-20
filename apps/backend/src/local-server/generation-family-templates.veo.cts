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

/**
 * veo-v1 族模板实现（Google Veo 3.1 视频生成，Gemini API `predictLongRunning` 长任务）。
 *
 * 提炼来源：三个在役包（`veo-3.1-generate-preview` / `-fast-generate-preview` /
 * `-lite-generate-preview`）的协议不变部分（payload_rules / polling_strategy / result_rule /
 * result_output_mapping / runtime.api_defaults），并对齐登记契约
 * `docs/provider-remote-apis/05-Veo-视频生成接口.md`：
 *
 * - 提交端点 `POST /v1beta/models/{model}:predictLongRunning`（**含 `{model}` 占位符**）、
 *   查询端点 `GET /v1beta/{operation_name}`。两个 endpoint 键（`predictLongRunning` /
 *   `operation`）必须与 `packages/contracts` ADAPTER_REGISTRY 里 veo-v1 的
 *   `relative_endpoints` 一致，由 `__tests__/generation-family-template-consistency.test.ts`
 *   一致性门禁钉住（设计 §3.4）。
 * - **模型身份走 URL，不在请求体**：本族归 remote_model_id 的 URL 注入类
 *   （provider-connection/remote-model-injection.cts），`{model}` 在派发前替换为记录的
 *   `remote_model_id`（URL 编码）。因此 payload_rules **没有** `body.model`，只有
 *   `meta.model_id`（产品侧留痕，不参与 wire 注入）。
 * - 异步任务：`result_rule = { mode:'async', submit_response_id_path:'/name' }`（提交响应的
 *   `name` 即 operation 资源名，形如 `models/veo-3.1-generate-preview/operations/<id>`）。
 *   查询 URL 的 `{operation_name}` 由轮询层用该值替换（task-engine-polling-utils 的占位符
 *   集合含 `operation_name`）——用 `{id}` 会让查询请求打到一个不存在的路径。
 * - 轮询策略逐字段取自三包实测（三型号完全一致：10s × 120 次、`statusFieldPaths:['done']`、
 *   successStatuses `['true']`、failureStatuses 五个词、失败码 `error.code`、失败文案三条）。
 *   这三项漂移会让任务永远停在 running 或把成功当失败，故在测试里逐字段钉死。
 * - 结果映射：`output.video_url ← response.generateVideoResponse.generatedSamples[0].video.uri`，
 *   `required:false`（查询响应会先回 `done:false`、完成后才回样本地址）。
 * - **无公网中转**：`runtime.url_input_upload_mode` 不声明（`inline_data` 内联上传），
 *   与在役包一致但**有意不沿用包内 `media_target:'inline_data'` 之外的任何中转声明**：
 *   Veo 的 Gemini API 形态只接受 `inlineData` base64（登记契约 §5「仅 inlineData base64」）。
 *
 * ## 族内型号差异与素材位上限（判断点一）
 *
 * 三个型号的差异只有两处：`veo-3.1-lite` 没有 `referenceImages` 素材位、`resolution` 没有 `4k`。
 *
 * - **分辨率取交集 `720p/1080p`**（与 seedance 族对 1080p 的处理同构）：4k 只有标准版与 fast
 *   支持，预发给 lite 会变成「能选、一提交就被上游拒」。标准版的 4k 由记录级参数覆盖
 *   `official[{field_key:'resolution', enum_options:[...]}]` 放开（与 seedance 族相同的解锁通道，
 *   注意 wire 侧 `normalize_enum.allowed_values` 仍是族集合，覆盖只改表单——这是族模板与覆盖层
 *   的既有分工，不在本文件兜底）。
 * - **素材位上限只取 `first_frame` / `last_frame`，排除 `reference_image`**：`packages/contracts`
 *   的 `GENERATION_MEDIA_SLOT_IDS` 头注已把 Veo 的素材面钉为「只有首帧与尾帧」；登记契约 §7
 *   对 lite 的参考图写「官方表格自相矛盾，按不支持处理」。素材位与档位的关键差别是**没有记录级
 *   扩位通道**：`accepted_media_slots` 只能收窄到族上限（写入侧守卫 + 投影侧过滤），族一旦不声明
 *   `reference_image`，任何记录都拿不回来。因此这里的取向是「宁可不让 lite 记录看到一个用不了的
 *   输入口」，而不是「把参考图预发给所有型号」——后者的失败形态是用户勾了、填了、提交才被拒。
 *
 * 但**构建器本身仍是素材位驱动的**：`buildVeoV1BaseTemplateSources` 对三个素材位都生成表单字段
 * 与请求分支（协议确实定义了 `referenceImages`，`runtime.payload_rules` 的
 * `referenceImages: [{ image, referenceType:'asset' }]` 就是它）。族上限将来若要放开参考图，
 * 只需改注册表条目一行，模板零改动；反之若这里删掉分支，放开时就要重写规则。
 *
 * ## `seed` 的处置：保留（判断点二）
 *
 * 登记契约 §6（官方正文）把 `seed` 记为「integer | — | Veo 3 系可用；不保证确定性」——即官方
 * **明确支持**该参数，只是不保证可复现。三个在役包也一致带 `seed`（`number` 组件 + `body`
 * 侧 `when truthy → toNumber`）。因此与 Seedance 2.0 的处置相反，**本族保留 `seed`**：
 * 不因「不保证确定性」删掉一个官方声明有效的参数。
 * 边界（如实记录、不兜底）：值 `0` 在 `when truthy` 下判假，不会发出；这是包内动作的既有语义，
 * 属「留空/不填即不发」的同一条规则，模板不额外改写。
 *
 * ## personGeneration 不向用户暴露
 *
 * 官方按场景限定取值（T2V 仅 `allow_all`，I2V / 参考图仅 `allow_adult`，登记契约 §6）。
 * 它不是用户的创作选择而是协议要求，故族模板按接受的素材位**派生**该值（有图 → `allow_adult`，
 * 纯文生 → `allow_all`），不生成表单字段、也不允许参数覆盖（不在 `parameter_schema.fields` 里）。
 *
 * 模板级 locales（协议与参数文案）内联在本文件，键名与在役包 locales 同构；合成投影经
 * buildProjectionFromPackageSources 走与已装包相同的本地化投影路径，禁止在投影处硬编码文案。
 */

/** 本族适配器 id（值域 owner 仍是 contracts 的 GENERATION_FAMILY_ADAPTER_IDS）。 */
export const VEO_V1_FAMILY_ADAPTER_ID = 'veo-v1';

/**
 * 本族模板能表达的**素材位上限**（一致性事实源：与注册表条目的 supportsMediaSlots 同值）。
 *
 * 只列首帧与尾帧：`reference_image` 被排除的理由见文件头注「判断点一」（lite 不支持 + 契约
 * 头注已把 Veo 的素材面钉为这两项；素材位无记录级扩位通道，所以族上限即最终能力面）。
 */
export const VEO_V1_SUPPORTED_MEDIA_SLOTS = ['first_frame', 'last_frame'] as const;

/**
 * 构建器可表达的素材位（协议层全集，含 `reference_image`）。
 *
 * 与 `VEO_V1_SUPPORTED_MEDIA_SLOTS` 的差集就是「模板写得出、但族上限当前不开放」的那一位。
 * 分开声明的目的：族上限是策略（会随型号矩阵变化），构建器的表达能力是协议事实（不会变）；
 * 两者混成一个常量会让「放开参考图」看起来像要改模板。
 */
const BUILDABLE_MEDIA_SLOTS = ['first_frame', 'last_frame', 'reference_image'] as const;
type BuildableMediaSlot = (typeof BUILDABLE_MEDIA_SLOTS)[number];

/** 提交端点（与适配器 relative_endpoints.predictLongRunning 同值，`{model}` 由注入层替换）。 */
const PREDICT_LONG_RUNNING_ENDPOINT = '/v1beta/models/{model}:predictLongRunning';
/** 查询端点（与适配器 relative_endpoints.operation 同值，`{operation_name}` 由轮询层替换）。 */
const OPERATION_ENDPOINT = '/v1beta/{operation_name}';

/**
 * 分辨率档位（族内交集）。
 *
 * 标准版与 fast 为 720p/1080p/4k，lite 为 720p/1080p（登记契约 §7）。取交集排除 4k：
 * 与 seedance 族对 1080p 的裁定同一条口径——不为某个型号预发它不支持的档位。4k 由记录级
 * 参数覆盖在标准版/fast 上放开。
 */
const RESOLUTION_TIERS = ['720p', '1080p'] as const;
const RESOLUTION_FALLBACK = '720p';

/** 画幅比例（三型号一致，官方仅两值）。 */
const ASPECT_RATIOS = ['16:9', '9:16'] as const;
const ASPECT_RATIO_FALLBACK = '16:9';

/**
 * 时长档（三型号一致：4 / 6 / 8 秒，string）。
 *
 * 交互层保持字符串档位（与在役包 `parameter_schema` 一致），wire 上也发字符串（官方类型是
 * string，`normalize_enum` 不做数值化）。官方没有载明显式默认，族模板沿用三包的 `'8'`。
 */
const DURATION_VALUES = ['4', '6', '8'] as const;
const DURATION_FALLBACK = '8';

/** 参考图张数上限（官方 ≤ 3 张 asset；三包 `maxFiles`/`max_items` 均为 3）。 */
const MAX_REFERENCE_IMAGES = 3;

/** 素材位 → 表单字段键（与在役包字段名一致，便于存量记录/文档对照）。 */
const MEDIA_SLOT_FIELD_KEYS: Record<BuildableMediaSlot, string> = {
  first_frame: 'firstFrameImage',
  last_frame: 'lastFrameImage',
  reference_image: 'referenceImages',
};

// ---------------------------------------------------------------------------
// 参数表单字段（提炼自在役包，label/description 为本地化键）
// ---------------------------------------------------------------------------

/** 比例枚举值的 locales 键片段（`16:9` → `16_9`，与在役包 locales 同构）。 */
const localeKeyOfRatio = (value: string): string => value.replace(/:/g, '_');

/**
 * 素材位表单字段的事实表（组件形态与在役包一致）。
 *
 * 三个素材位全部是图像：Veo 3.1 没有视频/音频素材位（extension 的 `video` 是独立动词，
 * 不是生成参数，登记契约 §8），因此组件统一 `imageUpload`。
 * `data_source` 不声明：输入端口在 node_definition 里逐位显式声明（与 seedance 族同一做法）。
 */
const MEDIA_SLOT_FIELD_FACTS: ReadonlyArray<{
  slot: BuildableMediaSlot;
  maxFiles: number;
  allowMultiple: boolean;
}> = [
  { slot: 'first_frame', maxFiles: 1, allowMultiple: false },
  { slot: 'last_frame', maxFiles: 1, allowMultiple: false },
  { slot: 'reference_image', maxFiles: MAX_REFERENCE_IMAGES, allowMultiple: true },
];

/** 素材位表单字段：只为 `acceptedMediaSlots` 里出现的素材位生成（顺序即创作面呈现顺序）。 */
const buildMediaSlotFields = (accepted: ReadonlySet<GenerationMediaSlotId>): JsonObject[] =>
  MEDIA_SLOT_FIELD_FACTS.filter((fact) => accepted.has(fact.slot)).map((fact) => {
    const fieldKey = MEDIA_SLOT_FIELD_KEYS[fact.slot];
    const componentProps: JsonObject = { accept: 'image/*', maxFiles: fact.maxFiles };
    if (fact.allowMultiple) componentProps.allowMultiple = true;
    return {
      field_key: fieldKey,
      label: `fields.${fieldKey}.label`,
      description: `fields.${fieldKey}.description`,
      required: false,
      default_value: [],
      validation_rules: [],
      layout: { colSpan: 1 },
      component: 'imageUpload',
      component_props: componentProps,
    };
  });

/** 非素材位的生成参数（三型号一致的部分；`seed` 见文件头注「判断点二」）。 */
const buildGenerationParameterFields = (): JsonObject[] => [
  {
    field_key: 'aspectRatio',
    label: 'fields.aspectRatio.label',
    description: 'fields.aspectRatio.description',
    required: false,
    default_value: ASPECT_RATIO_FALLBACK,
    validation_rules: [],
    layout: { colSpan: 1 },
    component: 'select',
    enum_options: ASPECT_RATIOS.map((value) => ({
      value,
      label: `fields.aspectRatio.options.ratio_${localeKeyOfRatio(value)}.label`,
    })),
    component_props: {},
  },
  {
    field_key: 'durationSeconds',
    label: 'fields.durationSeconds.label',
    description: 'fields.durationSeconds.description',
    required: false,
    default_value: DURATION_FALLBACK,
    validation_rules: [],
    layout: { colSpan: 1 },
    component: 'select',
    enum_options: DURATION_VALUES.map((value) => ({
      value,
      label: `fields.durationSeconds.options.duration_${value}.label`,
    })),
    component_props: {},
  },
  {
    field_key: 'resolution',
    label: 'fields.resolution.label',
    description: 'fields.resolution.description',
    required: false,
    default_value: RESOLUTION_FALLBACK,
    validation_rules: [],
    layout: { colSpan: 1 },
    component: 'select',
    enum_options: RESOLUTION_TIERS.map((value) => ({
      value,
      label: `fields.resolution.options.resolution_${value}.label`,
    })),
    component_props: {},
  },
  {
    // 官方支持（登记契约 §6「Veo 3 系可用；不保证确定性」）；留空即不发送。
    field_key: 'seed',
    label: 'fields.seed.label',
    description: 'fields.seed.description',
    required: false,
    validation_rules: [],
    layout: { colSpan: 1 },
    component: 'number',
    component_props: {},
  },
];

const buildParameterSchema = (accepted: ReadonlySet<GenerationMediaSlotId>): JsonObject => {
  const mediaFields = buildMediaSlotFields(accepted);
  const parameterFields = buildGenerationParameterFields();
  const defaultValues: JsonObject = {};
  for (const field of [...mediaFields, ...parameterFields]) {
    const fieldKey = field.field_key;
    if (typeof fieldKey !== 'string') continue;
    // seed 没有默认值（在役包的 default_values 也没有它）：留空 = 不发送。
    if (fieldKey === 'seed') continue;
    defaultValues[fieldKey] = field.default_value;
  }
  return {
    schema_type: 'object',
    fields: [...mediaFields, ...parameterFields],
    required_fields: [],
    default_values: defaultValues,
    validation_rules: [],
  };
};

// ---------------------------------------------------------------------------
// payload_rules（提炼自在役包 body.instances / body.parameters 的组装结构）
// ---------------------------------------------------------------------------

/** 图像取值节点：`extractFirstUrl` + `media_target:'inline_data'` 产出一个内联 base64 媒体引用。 */
const buildInlineImageValue = (fieldKey: string): JsonObject => ({
  kind: 'field',
  field_key: fieldKey,
  transforms: ['extractFirstUrl'],
  media_target: 'inline_data',
});

/**
 * 参考图条目：`map_array` 把该字段的每张图展开成 `{ image, referenceType:'asset' }`
 * （官方 ingredients 形态，登记契约 §10.3）。
 *
 * `max_items` 取官方上限 3、`skip_if_empty` 与在役包一致：没填时不产出空壳条目。
 */
const buildReferenceImagesEntry = (): JsonObject => ({
  kind: 'when',
  condition: { op: 'ne', field: 'referenceImages', value: [] },
  truthy: {
    kind: 'compute',
    operator: 'map_array',
    cache_key: 'declaredVeoV1.referenceImages',
    media_target: 'inline_data',
    options: {
      source: {
        kind: 'field',
        field_key: 'referenceImages',
        transforms: ['extractUrls'],
        media_target: 'inline_data',
      },
      item: {
        kind: 'compute',
        operator: 'object',
        entries: {
          image: { kind: 'item' },
          referenceType: { kind: 'literal', value: 'asset' },
        },
      },
      max_items: MAX_REFERENCE_IMAGES,
      skip_if_empty: true,
    },
  },
});

/**
 * `body.instances` 组装：`[{ prompt?, image?, lastFrame?, referenceImages? }]`。
 *
 * 与在役包逐层同构，唯一差别是**只为勾选的素材位生成分支**：未勾选的素材位在这个记录的
 * 表单里根本没有对应字段，规则里出现它的引用会被投影校验判为
 * `invalid_payload_rule_field_key`（`validatePayloadRuleFieldKeysForParts` 校验取值引用）。
 * 纯文生视频（不勾任何素材位）时 instance 只有 `prompt`。
 *
 * 官方互斥（登记契约 §5：有 `image` 时不得带 `referenceImages`，有 `referenceImages` 时不得带
 * `image`/`lastFrame`）属跨字段约束，payload DSL 无法表达；本族的族上限不含参考图，
 * 记录不可能勾出混合形态，因此该互斥在实际能力面上不可达（若将来放开参考图，需要在这里
 * 补「参考图优先」的条件，见文件末「已知边界」）。
 */
const buildInstancesRule = (accepted: ReadonlySet<GenerationMediaSlotId>): JsonObject => {
  const entries: JsonObject = {
    prompt: {
      kind: 'when',
      condition: { op: 'truthy', field: '__prompt' },
      truthy: { kind: 'field', field_key: '__prompt', transforms: ['trim'] },
    },
  };
  if (accepted.has('first_frame')) {
    entries.image = {
      kind: 'when',
      condition: { op: 'ne', field: MEDIA_SLOT_FIELD_KEYS.first_frame, value: [] },
      truthy: buildInlineImageValue(MEDIA_SLOT_FIELD_KEYS.first_frame),
    };
  }
  if (accepted.has('last_frame')) {
    entries.lastFrame = {
      kind: 'when',
      condition: { op: 'ne', field: MEDIA_SLOT_FIELD_KEYS.last_frame, value: [] },
      truthy: buildInlineImageValue(MEDIA_SLOT_FIELD_KEYS.last_frame),
    };
  }
  if (accepted.has('reference_image')) {
    entries.referenceImages = buildReferenceImagesEntry();
  }
  return {
    kind: 'compute',
    operator: 'array',
    cache_key: 'declaredVeoV1.instances',
    note: '按记录的素材位组装官方 instances：prompt 与首帧/尾帧/参考图分支，compact_object 丢弃未填写的分支。',
    args: [
      {
        kind: 'compute',
        operator: 'compact_object',
        cache_key: 'declaredVeoV1.instance',
        entries,
      },
    ],
  };
};

/** 枚举型请求参数的 wire 收敛（与表单枚举同源；族内支持的取值集合是唯一事实）。 */
const buildNormalizeEnumRule = (
  cacheKeySuffix: string,
  fieldKey: string,
  allowedValues: readonly string[],
  fallback: string,
  transforms: readonly string[],
): JsonObject => ({
  kind: 'compute',
  operator: 'normalize_enum',
  cache_key: `declaredVeoV1.${cacheKeySuffix}`,
  args: [{ kind: 'field', field_key: fieldKey, transforms: [...transforms] }],
  options: { allowed_values: [...allowedValues], fallback },
});

/**
 * `personGeneration`（协议要求、不向用户暴露）：按接受的素材位派生。
 *
 * 有首帧图（或参考图）→ `allow_adult`；否则纯文生 → `allow_all`（登记契约 §6）。
 * 在役包的判断条件只含 `firstFrameImage` / `referenceImages`（不含尾帧），这里沿用同一口径，
 * 但只为**已接受**的素材位生成条件——未接受的位没有表单字段，条件引用它会读到 undefined。
 * 条件为空（纯文生）时直接给字面量 `allow_all`：省掉一条恒假的 `when`。
 */
const buildPersonGenerationRule = (accepted: ReadonlySet<GenerationMediaSlotId>): JsonObject => {
  const conditions: JsonObject[] = [];
  if (accepted.has('first_frame')) {
    conditions.push({ op: 'ne', field: MEDIA_SLOT_FIELD_KEYS.first_frame, value: [] });
  }
  if (accepted.has('reference_image')) {
    conditions.push({ op: 'ne', field: MEDIA_SLOT_FIELD_KEYS.reference_image, value: [] });
  }
  if (conditions.length === 0) {
    return { kind: 'literal', value: 'allow_all' };
  }
  const condition: JsonObject =
    conditions.length === 1 && conditions[0] !== undefined
      ? conditions[0]
      : { op: 'or', conditions };
  return {
    kind: 'when',
    condition,
    truthy: { kind: 'literal', value: 'allow_adult' },
    falsy: { kind: 'literal', value: 'allow_all' },
  };
};

/**
 * `body.parameters`：`{ aspectRatio, durationSeconds, resolution, personGeneration, seed? }`。
 *
 * 四个枚举/派生参数与在役包同构；`seed` 是 `when truthy → toNumber`（留空/0 都不发送，
 * 与包内动作一致，见文件头注「判断点二」的边界说明）。
 */
const buildParametersRule = (accepted: ReadonlySet<GenerationMediaSlotId>): JsonObject => ({
  kind: 'compute',
  operator: 'compact_object',
  cache_key: 'declaredVeoV1.parameters',
  entries: {
    aspectRatio: buildNormalizeEnumRule('aspectRatio', 'aspectRatio', ASPECT_RATIOS, ASPECT_RATIO_FALLBACK, ['trim']),
    durationSeconds: buildNormalizeEnumRule('durationSeconds', 'durationSeconds', DURATION_VALUES, DURATION_FALLBACK, ['trim']),
    resolution: buildNormalizeEnumRule('resolution', 'resolution', RESOLUTION_TIERS, RESOLUTION_FALLBACK, ['trim']),
    personGeneration: buildPersonGenerationRule(accepted),
    seed: {
      kind: 'when',
      condition: { op: 'truthy', field: 'seed' },
      truthy: { kind: 'field', field_key: 'seed', transforms: ['toNumber'] },
    },
  },
});

/**
 * payload_rules（提炼自在役包）。
 *
 * **没有 `body.model`**：本族的模型身份由 URL 模板 `{model}` 承载，派发前由
 * `applyRemoteModelInjection` 按 snapshot 的 `remote_model_id` 替换；`meta.model_id` 只是
 * 产品侧留痕（注入层不改它）。这与 seedance / gemini 族的「body 注入类」相反。
 */
const buildPayloadRules = (
  modelId: string,
  accepted: ReadonlySet<GenerationMediaSlotId>,
): JsonObject => ({
  'api.endpoint': { kind: 'literal', value: PREDICT_LONG_RUNNING_ENDPOINT },
  'api.method': { kind: 'literal', value: 'POST' },
  'api.contentType': { kind: 'literal', value: 'application/json' },
  'body.instances': buildInstancesRule(accepted),
  'body.parameters': buildParametersRule(accepted),
  prompt: { kind: 'field', field_key: '__prompt', transforms: ['trim'] },
  input: { kind: 'field', field_key: '__prompt', transforms: ['trim'] },
  'meta.model_id': { kind: 'literal', value: modelId },
  'meta.aspectRatio': { kind: 'field', field_key: 'aspectRatio' },
  'meta.durationSeconds': { kind: 'field', field_key: 'durationSeconds' },
  'meta.resolution': { kind: 'field', field_key: 'resolution' },
});

// ---------------------------------------------------------------------------
// 模板级 locales（键名与在役包 locales 同构；zh-CN/en 内联，声明不携带文案）
// ---------------------------------------------------------------------------

const TEMPLATE_LOCALES_ZH_CN: ModelAssetLocalizationResourceMap = {
  fields: {
    prompt: { label: '提示词' },
    firstFrameImage: {
      label: '首帧图',
      description: '作为视频起始画面；建议不低于 720p，画幅为 16:9 或 9:16。',
    },
    lastFrameImage: {
      label: '尾帧图',
      description: '作为视频结束画面，必须与首帧图一同使用。',
    },
    referenceImages: {
      label: '参考图',
      description: '最多 3 张，用于保持主体外观；使用时视频时长固定为 8 秒。',
    },
    aspectRatio: {
      label: '画幅比例',
      description: '仅支持 16:9 与 9:16 两档。',
      options: {
        ratio_16_9: { label: '横屏 16:9' },
        ratio_9_16: { label: '竖屏 9:16' },
      },
    },
    durationSeconds: {
      label: '视频时长',
      description: '1080p 或使用参考图时必须为 8 秒。',
      options: {
        duration_4: { label: '4 秒' },
        duration_6: { label: '6 秒' },
        duration_8: { label: '8 秒' },
      },
    },
    resolution: {
      label: '清晰度',
      description: '默认 720p，可选 720p / 1080p；1080p 仅支持 8 秒时长。',
      options: {
        resolution_720p: { label: '720p' },
        resolution_1080p: { label: '1080p' },
      },
    },
    seed: {
      label: '随机种子',
      description: '用于重复生成的随机种子，不保证结果完全一致。',
    },
  },
  ports: {
    inputs: {
      firstFrameImage: { name: '首帧图', description: '接入素材或资产节点作为视频起始画面。' },
      lastFrameImage: { name: '尾帧图', description: '接入素材或资产节点作为视频结束画面。' },
      referenceImages: { name: '参考图', description: '接入多张参考图（最多 3 张）。' },
    },
    outputs: {
      video: { name: '生成视频', description: '生成的视频结果。' },
    },
  },
};

const TEMPLATE_LOCALES_EN: ModelAssetLocalizationResourceMap = {
  fields: {
    prompt: { label: 'Prompt' },
    firstFrameImage: {
      label: 'First frame image',
      description: 'Image used as the opening frame; 720p or higher and a 16:9 or 9:16 frame is recommended.',
    },
    lastFrameImage: {
      label: 'Last frame image',
      description: 'Image used as the closing frame; must be provided together with the first frame image.',
    },
    referenceImages: {
      label: 'Reference images',
      description: 'Up to 3 images that keep the subject appearance; duration is fixed at 8 seconds when used.',
    },
    aspectRatio: {
      label: 'Aspect ratio',
      description: 'Only 16:9 and 9:16 are supported.',
      options: {
        ratio_16_9: { label: 'Landscape 16:9' },
        ratio_9_16: { label: 'Portrait 9:16' },
      },
    },
    durationSeconds: {
      label: 'Duration',
      description: 'Must be 8 seconds for 1080p or reference-image inputs.',
      options: {
        duration_4: { label: '4 seconds' },
        duration_6: { label: '6 seconds' },
        duration_8: { label: '8 seconds' },
      },
    },
    resolution: {
      label: 'Resolution',
      description: 'Defaults to 720p. Available: 720p, 1080p; 1080p requires an 8 second duration.',
      options: {
        resolution_720p: { label: '720p' },
        resolution_1080p: { label: '1080p' },
      },
    },
    seed: {
      label: 'Seed',
      description: 'Random seed for repeat generation; output is not guaranteed to be identical.',
    },
  },
  ports: {
    inputs: {
      firstFrameImage: { name: 'First frame', description: 'Connect an asset as the opening frame.' },
      lastFrameImage: { name: 'Last frame', description: 'Connect an asset as the closing frame.' },
      referenceImages: { name: 'Reference images', description: 'Connect up to 3 reference images.' },
    },
    outputs: {
      video: { name: 'Generated video', description: 'The generated video output.' },
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

/** 输入端口：只为勾选的素材位声明（`data_type` 逐位正确；参考图多值）。 */
const buildInputPorts = (accepted: ReadonlySet<GenerationMediaSlotId>): JsonObject[] => {
  const ports: JsonObject[] = [];
  for (const fact of MEDIA_SLOT_FIELD_FACTS) {
    if (!accepted.has(fact.slot)) continue;
    const fieldKey = MEDIA_SLOT_FIELD_KEYS[fact.slot];
    ports.push({
      id: fieldKey,
      name: `ports.inputs.${fieldKey}.name`,
      data_type: 'image',
      field_key: fieldKey,
      required: false,
      multiple: fact.allowMultiple,
      max_connections: fact.maxFiles,
      description: `ports.inputs.${fieldKey}.description`,
    });
  }
  return ports;
};

/** 能力声明：输入模态随勾选的素材位增长，其余与三型号一致的协议事实。 */
const buildCapability = (accepted: ReadonlySet<GenerationMediaSlotId>): JsonObject => {
  const hasImageInput = accepted.size > 0;
  return {
    input_modalities: hasImageInput ? ['text', 'image'] : ['text'],
    output_modalities: ['video'],
    supports_async_task: true,
    supports_streaming: false,
    // 只有参考图是「多图」输入；首帧/尾帧各一张。
    supports_multi_image: accepted.has('reference_image'),
    supports_reference_media: hasImageInput,
    constraints: [],
  };
};

/**
 * 异步轮询策略（三个在役型号逐字段一致，测试钉死）。
 *
 * 查询请求是 GET、无 header、无 body（`headers:{}` / `body:null` 与包一致）；`{operation_name}`
 * 由轮询层用提交响应 `/name` 替换（task-engine-polling-utils 的占位符集合含 `operation_name`）。
 * `intervalMs` 10s × 120 次 ≈ 20 分钟上限，与官方「单任务 11 秒至 6 分钟」的延迟预算匹配。
 */
const buildPollingStrategy = (): JsonObject => ({
  request: {
    url_template: OPERATION_ENDPOINT,
    method: 'GET',
    headers: {},
    body: null,
  },
  polling: {
    intervalMs: 10000,
    maxAttempts: 120,
    successFieldPaths: ['response.generateVideoResponse.generatedSamples[0].video.uri'],
    successStatuses: ['true'],
    statusFieldPaths: ['done'],
    failureStatuses: ['error', 'failed', 'failure', 'cancelled', 'canceled'],
    failureCodePaths: ['error.code'],
    failureMessagePaths: ['error.message', 'error.status', 'error.details'],
  },
});

/**
 * veo-v1 基础族模板（不含记录覆盖）：从 model_id 与接受的素材位合成
 * runtime_model / node_definition / locales 形状的内存态包源，交给与已装包相同的投影路径。
 *
 * 记录覆盖由注册表的通用合成入口（`buildFamilyTemplateSources`）统一应用；基础模板单独
 * 导出是因为覆盖校验（保存期）需要在**未应用覆盖**的模板上运行（设计 §3.3 校验唯一实现）。
 */
export const buildVeoV1BaseTemplateSources = (
  modelId: string,
  options: GenerationFamilyTemplateOptions,
): GenerationFamilyTemplateSources => {
  const accepted = new Set<GenerationMediaSlotId>(options.acceptedMediaSlots);
  const parameterSchema = buildParameterSchema(accepted);
  const runtimeModel: JsonObject = {
    model_id: modelId,
    provider_id: 'google',
    default_task_type: 'video',
    mode: 'video',
    role: 'generator',
    capability: buildCapability(accepted),
    parameter_schema: parameterSchema,
    execution_profile: {
      task_type: 'video',
      supports_async_task: true,
    },
    display: {
      visible: true,
      // 与其它已就绪族同一约定：声明模型的目录排序排在在役包之后。
      order: 9000,
    },
    runtime: {
      provider_id: 'google',
      default_task_type: 'video',
      mode: 'video',
      aliases: [],
      // 单一 endpoint、固定 JSON 体：不需要条件求值的 payload_format。
      payload_format: 'json',
      workspace: {
        // 与在役包同值：视频任务列表在画布右侧。
        task_list_position: 'right',
      },
      // 无公网中转：Gemini API 形态只接受 inlineData base64（登记契约 §5），因此这里
      // **不声明** url_input_upload_mode / url_input_upload_target_type——声明 public_relay
      // 会让所有媒体 target 被判成 public_url 与 uploadMode 不匹配，且上游根本收不到 base64。
      api_defaults: {
        endpoint: PREDICT_LONG_RUNNING_ENDPOINT,
        method: 'POST',
        contentType: 'application/json',
      },
      payload_rules: buildPayloadRules(modelId, accepted),
      capabilities: {
        execution_traits: ['nonBlocking'],
      },
      schema_defaults: cloneJsonObject(parameterSchema.default_values),
      execution_driver: 'http_formal_task',
    },
    request_strategy: {
      request_stage: 'submit',
      protocol: 'http',
      endpoint: PREDICT_LONG_RUNNING_ENDPOINT,
      method: 'POST',
      header_rules: [],
      body_rules: [],
      query_rules: [],
    },
    // 异步 LRO：提交响应的 `/name` 是后续查询的 operation 资源名（不是普通任务 id）。
    result_rule: {
      mode: 'async',
      submit_response_id_path: '/name',
    },
    polling_strategy: buildPollingStrategy(),
    result_output_mapping: {
      response_mode: 'structured_payload',
      output_mapping_rules: [
        {
          target: 'output.video_url',
          source: { kind: 'response', path: 'response.generateVideoResponse.generatedSamples[0].video.uri' },
          required: false,
          default_value: null,
        },
      ],
      note: 'declared generation model (veo-v1 family template)',
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
    input_ports: buildInputPorts(accepted),
    output_ports: [
      {
        id: 'video',
        name: 'ports.outputs.video.name',
        data_type: 'video',
        field_key: 'output_video',
        multiple: true,
        description: 'ports.outputs.video.description',
      },
    ],
  };
  return {
    runtimeModel: toCatalogRawObject(runtimeModel),
    node: toCatalogRawObject(node),
    localizationResources: TEMPLATE_LOCALIZATION_RESOURCES,
  };
};

/** 全素材位态（含参考图）：参数描述的保留键基线需要覆盖所有可能出现的请求分支。 */
const ALL_ACCEPTED_SLOTS: ReadonlySet<GenerationMediaSlotId> = new Set<GenerationMediaSlotId>(
  BUILDABLE_MEDIA_SLOTS,
);

/**
 * veo-v1 的参数描述（GET /api/generation-family-templates/:familyAdapterId 的数据）。
 *
 * 与其它已就绪族同一口径：以「不接受任何素材位」基线构建（素材位字段不进编辑器，归属由记录
 * 的 `accepted_media_slots` 管控），另把「全素材位」形态的 payload_rules 并入保留键计算——
 * 基线是纯文生视频形态，但模板写得出首帧/尾帧/参考图分支，`instances` / `parameters` 等协议键
 * 同样要保留（否则参数编辑器可能让用户的自定义参数占用这些键）。
 */
export const buildVeoV1ParameterDescriptor = (): FamilyTemplateParameterDescriptor =>
  buildFamilyTemplateParameterDescriptorFromSources({
    familyAdapterId: VEO_V1_FAMILY_ADAPTER_ID,
    baselineSources: buildVeoV1BaseTemplateSources('descriptor-baseline', {
      acceptedMediaSlots: [],
    }),
    extraPayloadRuleSets: [buildPayloadRules('descriptor-baseline', ALL_ACCEPTED_SLOTS)],
  });

/**
 * 已知边界（payload DSL 与族上限的真实限制，不在此处兜底）：
 *
 * 1. **参考图的官方互斥无法在 DSL 里表达**：官方禁止 `image` 与 `referenceImages` 同时出现
 *    （登记契约 §5）。当前族上限不含参考图，混合形态不可达；若将来放开 `reference_image`，
 *    必须在这里补「参考图非空时首帧/尾帧分支不产出」的条件（seedance 族的 buildKeyframeEntry
 *    是同一手法的先例），否则会构造出上游必拒的 instances。
 * 2. **参考图强制 8 秒、1080p 强制 8 秒**是不可表达的组合约束（`durationSeconds` 与
 *    `resolution`/`referenceImages` 的联动，登记契约 §6/§11）：DSL 没有跨字段制约算子，
 *    交互层按 §11 自行禁用非法档位，族模板只保证枚举值域；上游拒绝是最后一道闸。
 * 3. **lite 型号的 4k 缺失与参考图缺失**由记录侧收窄承担（resolution 用参数覆盖收窄到
 *    720p/1080p 之外还能再收；参考图因族上限不含而根本不可勾），族模板不为单个 model_id
 *    写分支——族模板不认识具体型号，只认识「这个接口格式」。
 */
