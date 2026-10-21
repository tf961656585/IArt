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
 * seedance-2-0-v1 族模板实现（火山方舟 Seedance 2.0 视频任务接口，异步轮询 + 公网中转）。
 *
 * 提炼来源：三个在役包
 * （`doubao-seedance-2-0-260128` / `-fast-260128` / `-mini-260615`）的协议不变部分
 * （payload_rules 的 content 组装 / polling_strategy / result_rule / result_output_mapping /
 * runtime.url_input_upload_*），并对齐登记契约
 * `docs/provider-remote-apis/04-Seedance-2.0-视频生成任务接口.md`：
 *
 * - 提交端点 `POST /api/v3/contents/generations/tasks`、查询端点
 *   `GET /api/v3/contents/generations/tasks/{id}`：两个 endpoint 键（`tasks` / `taskById`）必须与
 *   `packages/contracts` ADAPTER_REGISTRY 里 seedance-2-0-v1 的 `relative_endpoints` 一致，由
 *   `__tests__/generation-family-template-consistency.test.ts` 一致性门禁钉住（设计 §3.4）。
 * - 异步任务：`result_rule = { mode:'async', submit_response_id_path:'/id' }`，轮询策略逐字段
 *   取自三个包实测（三型号完全一致：3000ms × 500 次、success `succeeded`、failure
 *   `failed/expired`、状态路径 `status` / `data.status`）。这三项漂移会让任务永远停在 running
 *   或把成功当失败，故在测试里逐字段钉死。
 * - 结果映射：`output.video_url ← content.video_url`（及网关包裹兜底 `data.content.video_url`），
 *   `required:false` 与包一致（查询响应可能先回状态、后回地址）。
 * - **公网中转**：`url_input_upload_mode:'public_relay'`、
 *   `url_input_upload_target_type:'cloudflare_image_public_url'`。按仓库口径
 *   （AGENTS.md「Public Relay target 能力边界」），`cloudflare_image_public_url` 是通用文件中转，
 *   能服务图片/视频/音频，因此本族三类媒体全部指向它；`self_hosted_image_public_url` 只服务图像，
 *   不得用于视频/音频。
 * - `resolution` 族内差异：标准版 480p/720p/1080p，fast 与 mini 只有 480p/720p。族模板取
 *   **交集 480p/720p**（理由见 buildParameterSchema 的裁定说明），1080p 由记录级参数覆盖
 *   在标准版型号上解锁。
 *
 * ## `seed` 的处置：不提供该参数（按登记契约的官方结论）
 *
 * 登记契约 §6.1（官方正文）把 `seed` 标为「**不支持 2.0**（仅 1.0）」。在役包曾带该字段与它的
 * 发送规则（`body.seed` + `meta.seed`，truthy 守卫、留空不发），那是文档修订前的产物。
 * 2026-10-19 裁定：**按官方结论不提供该参数**——可选列表里不留一个官方声明无效的参数，
 * 避免用户填了没效果且不报错。需要固定随机种子的场景不在 Seedance 2.0 上提供。
 *
 * ## input_mode 的处置：不向用户暴露，由素材位推导
 *
 * 在役包有一个用户可见的 `input_mode`（text / keyframes / reference），它唯一的作用是选择
 * content 数组的组装场景（三种场景官方互斥）。但**用户添加模型时勾的是素材位**，不是场景：
 * 再让他理解「输入模式」这个内部概念，等于把协议实现细节上屏。因此族模板：
 * 1. 不生成 `input_mode` 字段，也不生成任何依赖它的条件；
 * 2. 由 `acceptedMediaSlots` 推导场景，只为勾选的素材位生成表单字段、输入端口与 content 分支：
 *    - 只有首帧/尾帧组 → 首尾帧场景（首帧、尾帧各自非空才追加）；
 *    - 只有参考组（图/视频/音频）→ 全模态参考场景（逐个 map_array，skip_if_empty）；
 *    - 两组都勾 → 混合形态：首帧/尾帧分支额外要求参考组全空（参考场景优先，见
 *      buildContentRule 的说明）。
 * 3. 纯文生视频 = 不勾任何素材位（content 只有文本块）。
 *
 * 模板级 locales（协议与参数文案）内联在本文件，键名与在役包 locales 同构；合成投影经
 * buildProjectionFromPackageSources 走与已装包相同的本地化投影路径，禁止在投影处硬编码文案。
 */

/** 本族适配器 id（值域 owner 仍是 contracts 的 GENERATION_FAMILY_ADAPTER_IDS）。 */
export const SEEDANCE_2_0_V1_FAMILY_ADAPTER_ID = 'seedance-2-0-v1';

/**
 * 本族模板能表达的全部素材位（一致性事实源：与注册表条目的 supportsMediaSlots 同值）。
 *
 * 五个素材位全列：官方创建任务契约里这五个 `role` 都是合法的 content 分支，模板能为每一位
 * 生成表单字段、输入端口与组装分支。官方「音频不能单独作参考」「首尾帧不与参考视频/音频混用」
 * 属于**内容组合约束**，payload DSL 无法表达跨字段互斥（详见文件末的已知边界），不因此删位。
 */
export const SEEDANCE_2_0_V1_SUPPORTED_MEDIA_SLOTS = [
  'first_frame',
  'last_frame',
  'reference_image',
  'reference_video',
  'reference_audio',
] as const;

/** 提交端点（与适配器 relative_endpoints.tasks 同值）。 */
const TASKS_ENDPOINT = '/api/v3/contents/generations/tasks';
/** 查询端点（与适配器 relative_endpoints.taskById 同值，`{id}` 由轮询层替换）。 */
const TASK_BY_ID_ENDPOINT = '/api/v3/contents/generations/tasks/{id}';

/**
 * 分辨率档位（族内交集）。
 *
 * 三个在役型号：标准版 480p/720p/1080p，fast 与 mini 只有 480p/720p。族模板取**交集**：
 * 先例（openai-image 族头注）是「用户声明的是任意『这个接口格式』的模型，不能预发其不支持的
 * 档位」——1080p 只有标准版支持，预发给 fast/mini 会变成「能选、一提交就被上游拒」。
 * 与 openai 族的另一先例并不冲突：那里排除 xhigh/max 时没有把控件压到只剩一个值，这里
 * 交集仍有 480p/720p 两档（可用控件），因此取交集是安全的；标准版的 1080p 由记录级
 * 「参数覆盖」放开 resolution 枚举解锁（覆盖是高级入口，符合「缩小版型号差异走记录级收窄」口径）。
 */
const RESOLUTION_TIERS = ['480p', '720p'] as const;
const RESOLUTION_FALLBACK = '720p';

/** 画幅比例（三型号一致，官方 7 档）。 */
const RATIO_VALUES = ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'] as const;
const RATIO_FALLBACK = 'adaptive';

/**
 * 时长档（官方 4–15 秒整数，或 -1 智能时长；三型号一致）。
 *
 * 交互层保持字符串档位（与在役包 `parameter_schema` 一致），wire 上由 `toNumber` +
 * `normalize_enum` 收成整数。`-1` 是官方「智能时长」取值（登记契约 §6.1），因此比「只有 4–15」
 * 更完整，保留。
 */
const DURATION_VALUES = ['4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', '-1'] as const;
const DURATION_NUMERIC_VALUES = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, -1] as const;
const DURATION_FALLBACK = 5;

/** 媒材位 → 表单字段键（与在役包字段名一致，便于存量记录/文档对照）。 */
const MEDIA_SLOT_FIELD_KEYS: Record<(typeof SEEDANCE_2_0_V1_SUPPORTED_MEDIA_SLOTS)[number], string> = {
  first_frame: 'first_frame',
  last_frame: 'last_frame',
  reference_image: 'reference_images',
  reference_video: 'reference_videos',
  reference_audio: 'reference_audios',
};

/**
 * 本族「素材位 → 参数字段键」映射的对外出口（族模板注册表消费）。
 *
 * 注册表用它给后端可执行目录下发素材位清单。直接导出同一对象，不复制数据，
 * 避免出现第二份映射事实。
 */
export const SEEDANCE_MEDIA_SLOT_FIELD_KEYS = MEDIA_SLOT_FIELD_KEYS;

// ---------------------------------------------------------------------------
// 参数表单字段（提炼自 seedance 2.0 在役包，label/description 为本地化键）
// ---------------------------------------------------------------------------

/** 比例枚举值的 locales 键片段（`16:9` → `16_9`，与在役包 locales 同构）。 */
const localeKeyOfRatio = (value: string): string => value.replace(/:/g, '_');

/**
 * 素材位表单字段的事实表（组件形态与在役包一致）。
 *
 * 图片用 `imageUpload`，视频/音频用 `file`——`MODEL_ASSET_SUPPORTED_FIELD_COMPONENTS` 没有
 * videoUpload/audioUpload，`file` 是唯一承载非图像素材的组件。`data_source` 一律不声明：
 * 输入端口在 node_definition 里逐位显式声明（`file` 组件推导出的 data_type 是 url，会把视频/
 * 音频端口降级成 url，故不走 data_source 推导这条路）。
 *
 * `maxFiles` 取官方上限（登记契约 §7.2 / §8）：首/尾帧各 1 张、参考图 9 张、参考视频与参考音频各 3 段。
 */
const MEDIA_SLOT_FIELD_FACTS: ReadonlyArray<{
  slot: (typeof SEEDANCE_2_0_V1_SUPPORTED_MEDIA_SLOTS)[number];
  component: 'imageUpload' | 'file';
  accept: string;
  maxFiles: number;
  allowMultiple: boolean;
}> = [
  { slot: 'first_frame', component: 'imageUpload', accept: 'image/*', maxFiles: 1, allowMultiple: false },
  { slot: 'last_frame', component: 'imageUpload', accept: 'image/*', maxFiles: 1, allowMultiple: false },
  { slot: 'reference_image', component: 'imageUpload', accept: 'image/*', maxFiles: 9, allowMultiple: true },
  {
    slot: 'reference_video',
    component: 'file',
    accept: 'video/mp4,video/quicktime,video/*',
    maxFiles: 3,
    allowMultiple: true,
  },
  {
    slot: 'reference_audio',
    component: 'file',
    accept: 'audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/*',
    maxFiles: 3,
    allowMultiple: true,
  },
];

/** 素材位表单字段：只为 `acceptedMediaSlots` 里出现的素材位生成（顺序即创作面呈现顺序）。 */
const buildMediaSlotFields = (accepted: ReadonlySet<GenerationMediaSlotId>): JsonObject[] =>
  MEDIA_SLOT_FIELD_FACTS.filter((fact) => accepted.has(fact.slot)).map((fact) => {
    const fieldKey = MEDIA_SLOT_FIELD_KEYS[fact.slot];
    const componentProps: JsonObject = { accept: fact.accept, maxFiles: fact.maxFiles };
    if (fact.allowMultiple) componentProps.allowMultiple = true;
    return {
      field_key: fieldKey,
      // locales 键用字段名（参考位是复数字段名，首尾帧与字段名同形）。
      label: `fields.${fieldKey}.label`,
      description: `fields.${fieldKey}.description`,
      required: false,
      default_value: [],
      validation_rules: [],
      layout: { colSpan: 1 },
      component: fact.component,
      component_props: componentProps,
    };
  });

/** 非素材位的生成参数（三个型号一致的部分）。 */
const buildGenerationParameterFields = (): JsonObject[] => [
  {
    field_key: 'resolution',
    label: 'fields.resolution.label',
    description: 'fields.resolution.description',
    required: false,
    default_value: RESOLUTION_FALLBACK,
    validation_rules: [],
    layout: { colSpan: 1 },
    component: 'select',
    enum_options: RESOLUTION_TIERS.map((value) => ({ value, label: `fields.resolution.options.${value}.label` })),
    component_props: {},
  },
  {
    field_key: 'ratio',
    label: 'fields.ratio.label',
    description: 'fields.ratio.description',
    required: false,
    default_value: RATIO_FALLBACK,
    validation_rules: [],
    layout: { colSpan: 1 },
    component: 'select',
    enum_options: RATIO_VALUES.map((value) => ({
      value,
      label: `fields.ratio.options.${localeKeyOfRatio(value)}.label`,
    })),
    component_props: {},
  },
  {
    field_key: 'duration',
    label: 'fields.duration.label',
    description: 'fields.duration.description',
    required: false,
    default_value: '5',
    validation_rules: [],
    layout: { colSpan: 1 },
    component: 'select',
    enum_options: DURATION_VALUES.map((value) => ({
      // -1（智能时长）的 locales 键用 `smart`，与在役包 locales 同构。
      value,
      label: `fields.duration.options.${value === '-1' ? 'smart' : value}.label`,
    })),
    component_props: {},
  },
  {
    field_key: 'generate_audio',
    label: 'fields.generate_audio.label',
    description: 'fields.generate_audio.description',
    required: false,
    default_value: true,
    validation_rules: [],
    layout: { colSpan: 1 },
    component: 'switch',
  },
  {
    field_key: 'return_last_frame',
    label: 'fields.return_last_frame.label',
    description: 'fields.return_last_frame.description',
    required: false,
    default_value: false,
    validation_rules: [],
    layout: { colSpan: 1 },
    component: 'switch',
  },
  {
    field_key: 'watermark',
    label: 'fields.watermark.label',
    description: 'fields.watermark.description',
    required: false,
    default_value: false,
    validation_rules: [],
    layout: { colSpan: 1 },
    component: 'switch',
  },
];

const buildParameterSchema = (accepted: ReadonlySet<GenerationMediaSlotId>): JsonObject => {
  const mediaFields = buildMediaSlotFields(accepted);
  const parameterFields = buildGenerationParameterFields();
  const defaultValues: JsonObject = {};
  for (const field of [...mediaFields, ...parameterFields]) {
    const fieldKey = field.field_key;
    if (typeof fieldKey !== 'string') continue;
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
// payload_rules（提炼自 seedance 2.0 在役包 body.content 的组装结构）
// ---------------------------------------------------------------------------

const REFERENCE_SLOT_ORDER = ['reference_image', 'reference_video', 'reference_audio'] as const;
const KEYFRAME_SLOT_ORDER = ['first_frame', 'last_frame'] as const;

type ReferenceSlot = (typeof REFERENCE_SLOT_ORDER)[number];
type KeyframeSlot = (typeof KEYFRAME_SLOT_ORDER)[number];

/** 参考素材位 → content 条目形态（官方 §7.1 的 type / 载荷键与 role 一一对应）。 */
const REFERENCE_ENTRY_SHAPE: Record<ReferenceSlot, { type: string; payloadKey: string; role: string }> = {
  reference_image: { type: 'image_url', payloadKey: 'image_url', role: 'reference_image' },
  reference_video: { type: 'video_url', payloadKey: 'video_url', role: 'reference_video' },
  reference_audio: { type: 'audio_url', payloadKey: 'audio_url', role: 'reference_audio' },
};

/** 单张图片条目（首帧/尾帧）：`{ type:'image_url', image_url:{ url }, role }`。 */
const buildSingleImageEntry = (fieldKey: string, role: string): JsonObject => ({
  kind: 'compute',
  operator: 'object',
  entries: {
    type: { kind: 'literal', value: 'image_url' },
    image_url: {
      kind: 'compute',
      operator: 'object',
      entries: {
        url: {
          kind: 'field',
          field_key: fieldKey,
          transforms: ['extractFirstUrl'],
          media_target: 'public_url',
        },
      },
    },
    role: { kind: 'literal', value: role },
  },
});

/**
 * 参考素材位条目：`map_array` 把该字段的每个公网 URL 展开成一条 content 条目。
 *
 * `skip_if_empty` 与在役包一致：该素材位没填时整段不产出（map_array 返回 undefined，
 * 外层 append 再滤掉空条目），因此「只有图片参考」「只有视频参考」等组合都不需要条件分支。
 */
const buildReferenceEntries = (slot: ReferenceSlot): JsonObject => {
  const shape = REFERENCE_ENTRY_SHAPE[slot];
  return {
    kind: 'compute',
    operator: 'map_array',
    cache_key: `declaredSeedance20.${slot}`,
    options: {
      source: {
        kind: 'field',
        field_key: MEDIA_SLOT_FIELD_KEYS[slot],
        transforms: ['extractUrls'],
        media_target: 'public_url',
      },
      item: {
        kind: 'compute',
        operator: 'object',
        entries: {
          type: { kind: 'literal', value: shape.type },
          [shape.payloadKey]: {
            kind: 'compute',
            operator: 'object',
            entries: { url: { kind: 'item' } },
          },
          role: { kind: 'literal', value: shape.role },
        },
      },
      skip_if_empty: true,
    },
  };
};

/**
 * 首帧/尾帧条目：该字段非空才追加（`when` + 保序 append）。
 *
 * **混合形态的互斥处理**：当记录同时勾了首帧/尾帧组与参考组时，官方三种场景仍然互斥
 * （登记契约 §7.3）。payload DSL 没有跨字段互斥算子，模板用条件把这条规则表达成
 * 「参考组任一非空时，首帧/尾帧分支不产出」——即参考场景优先。选参考优先而不是首尾帧优先的
 * 依据是官方给混用者的建议路径：要锁定首尾帧又用参考素材时，官方让用户走参考结构并在提示词里
 * 指认（登记契约 §7.3 末条）。残余风险见文件末「已知边界」。
 */
const buildKeyframeEntry = (
  slot: KeyframeSlot,
  accepted: ReadonlySet<GenerationMediaSlotId>,
): JsonObject => {
  const fieldKey = MEDIA_SLOT_FIELD_KEYS[slot];
  const condition: JsonObject = accepted.has('reference_image') || accepted.has('reference_video') || accepted.has('reference_audio')
    ? {
        op: 'and',
        conditions: [
          { op: 'ne', field: fieldKey, value: [] },
          ...REFERENCE_SLOT_ORDER.filter((referenceSlot) => accepted.has(referenceSlot)).map((referenceSlot) => ({
            op: 'eq',
            field: MEDIA_SLOT_FIELD_KEYS[referenceSlot],
            value: [],
          })),
        ],
      }
    : { op: 'ne', field: fieldKey, value: [] };
  return {
    kind: 'when',
    condition,
    truthy: buildSingleImageEntry(fieldKey, slot),
    falsy: { kind: 'literal', value: null },
  };
};

/**
 * `body.content` 组装：文本块前置（prepend）+ 素材分支后置（append），`skip_if_empty` 丢弃
 * 未启用分支——与在役包逐层同构，唯一差别是场景由素材位推导而非读取 `input_mode` 字段。
 *
 * 文生视频（不勾任何素材位）时 append 为空数组，content 只剩 `{ type:'text', text }`；
 * 这正是官方「纯文本」场景。
 */
const buildContentRule = (accepted: ReadonlySet<GenerationMediaSlotId>): JsonObject => {
  const append: JsonObject[] = [];
  for (const slot of KEYFRAME_SLOT_ORDER) {
    if (accepted.has(slot)) append.push(buildKeyframeEntry(slot, accepted));
  }
  for (const slot of REFERENCE_SLOT_ORDER) {
    if (accepted.has(slot)) append.push(buildReferenceEntries(slot));
  }
  return {
    kind: 'compute',
    operator: 'map_array',
    cache_key: 'declaredSeedance20.content',
    note: '按记录的素材位组装官方 content 数组：prepend 文本块，append 首/尾帧与参考图/视频/音频；skip_if_empty 丢弃未填写的分支。',
    options: {
      // 主体由 prepend/append 承载，source 恒为空数组（map_array 要求 source/item 必填）。
      source: { kind: 'literal', value: [] },
      item: { kind: 'literal', value: null },
      prepend: [
        {
          kind: 'compute',
          operator: 'object',
          entries: {
            type: { kind: 'literal', value: 'text' },
            text: { kind: 'field', field_key: '__prompt', transforms: ['trim'] },
          },
        },
      ],
      append,
      skip_if_empty: true,
    },
  };
};

/** 枚举型请求参数的 wire 收敛（与表单枚举同源；族内支持的取值集合是唯一事实）。 */
const buildNormalizeEnumRule = (fieldKey: string, allowedValues: readonly (string | number)[], fallback: string | number, transforms: readonly string[]): JsonObject => ({
  kind: 'compute',
  operator: 'normalize_enum',
  cache_key: `declaredSeedance20.${fieldKey}`,
  args: [{ kind: 'field', field_key: fieldKey, transforms: [...transforms] }],
  options: { allowed_values: [...allowedValues], fallback },
});

/**
 * payload_rules（提炼自在役包）。
 *
 * `body.model` 的字面量在合成时替换为声明 model_id，派发前再由 remote_model_id 注入覆盖
 * （适配器把本族归入 body 注入类，见 remote-model-injection 头注）。
 */
const buildPayloadRules = (
  modelId: string,
  accepted: ReadonlySet<GenerationMediaSlotId>,
): JsonObject => ({
  'api.endpoint': { kind: 'literal', value: TASKS_ENDPOINT },
  'api.method': { kind: 'literal', value: 'POST' },
  'api.contentType': { kind: 'literal', value: 'application/json' },
  // 异步响应处理声明：编辑器侧据此把结果当任务处理（与在役包同值，kling 系异步包同样声明）。
  'api.responseHandling.mode': { kind: 'literal', value: 'async' },
  'body.model': { kind: 'literal', value: modelId },
  'body.content': buildContentRule(accepted),
  'body.resolution': buildNormalizeEnumRule('resolution', RESOLUTION_TIERS, RESOLUTION_FALLBACK, ['trim']),
  'body.ratio': buildNormalizeEnumRule('ratio', RATIO_VALUES, RATIO_FALLBACK, ['trim']),
  'body.duration': buildNormalizeEnumRule('duration', DURATION_NUMERIC_VALUES, DURATION_FALLBACK, ['toNumber']),
  'body.generate_audio': { kind: 'field', field_key: 'generate_audio' },
  'body.return_last_frame': { kind: 'field', field_key: 'return_last_frame' },
  'body.watermark': { kind: 'field', field_key: 'watermark' },
  prompt: { kind: 'field', field_key: '__prompt', transforms: ['trim'] },
  input: { kind: 'field', field_key: '__prompt', transforms: ['trim'] },
  'meta.model_id': { kind: 'literal', value: modelId },
  'meta.resolution': buildNormalizeEnumRule('resolution', RESOLUTION_TIERS, RESOLUTION_FALLBACK, ['trim']),
  'meta.ratio': buildNormalizeEnumRule('ratio', RATIO_VALUES, RATIO_FALLBACK, ['trim']),
  'meta.duration': buildNormalizeEnumRule('duration', DURATION_NUMERIC_VALUES, DURATION_FALLBACK, ['toNumber']),
  'meta.generate_audio': { kind: 'field', field_key: 'generate_audio' },
  'meta.return_last_frame': { kind: 'field', field_key: 'return_last_frame' },
  'meta.watermark': { kind: 'field', field_key: 'watermark' },
});

// ---------------------------------------------------------------------------
// 模板级 locales（键名与在役包 locales 同构；zh-CN/en 内联，声明不携带文案）
// ---------------------------------------------------------------------------

const TEMPLATE_LOCALES_ZH_CN: ModelAssetLocalizationResourceMap = {
  fields: {
    prompt: { label: '提示词' },
    first_frame: {
      label: '首帧图',
      description: '作为视频起始画面。宽高比 0.4–2.5、单边 300–6000 px、单张小于 30 MB；含真人人脸的素材会被上游拒绝。',
    },
    last_frame: {
      label: '尾帧图',
      description: '作为视频结束画面，与首帧图成对使用；约束与首帧图相同。',
    },
    reference_images: {
      label: '参考图',
      description: '最多 9 张。宽高比 0.4–2.5、单边 300–6000 px、单张小于 30 MB；含真人人脸的素材会被上游拒绝。',
    },
    reference_videos: {
      label: '参考视频',
      description: '最多 3 段，单段 2–15 秒且不超过 200 MB；与参考音频合计时长不超过 15 秒。',
    },
    reference_audios: {
      label: '参考音频',
      description: '最多 3 段，WAV / MP3，单段 2–15 秒；不能单独作参考，需同时提供至少 1 张参考图或 1 段参考视频。',
    },
    resolution: {
      label: '分辨率',
      description: '默认 720p，可选 480p / 720p。',
      options: {
        '480p': { label: '480p 标清' },
        '720p': { label: '720p 高清' },
      },
    },
    ratio: {
      label: '画幅比例',
      description: '官方 7 档，默认 adaptive（按输入内容自适应）。',
      options: {
        '16_9': { label: '16:9' },
        '4_3': { label: '4:3' },
        '1_1': { label: '1:1' },
        '3_4': { label: '3:4' },
        '9_16': { label: '9:16' },
        '21_9': { label: '21:9' },
        adaptive: { label: '自适应（默认）' },
      },
    },
    duration: {
      label: '视频时长（秒）',
      description: '4–15 秒整数，或「智能时长」（由提示词复杂度决定，约 5 秒）；默认 5 秒。帧率固定 24 fps，不可调。',
      options: {
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
        smart: { label: '智能时长（约 5 秒）' },
      },
    },
    generate_audio: {
      label: '生成音频',
      description: '默认开启。关闭后提交静音视频。',
    },
    return_last_frame: {
      label: '返回尾帧图',
      description: '开启后任务成功时额外返回尾帧图 URL，可用于续拍。',
    },
    watermark: {
      label: '展示水印',
      description: '默认关闭。平台强制的可见水印与此开关无关。',
    },
  },
  ports: {
    inputs: {
      first_frame: { name: '首帧图', description: '接入素材或资产节点作为视频起始画面。' },
      last_frame: { name: '尾帧图', description: '接入素材或资产节点作为视频结束画面。' },
      reference_images: { name: '参考图', description: '接入多张参考图（最多 9 张）。' },
      reference_videos: { name: '参考视频', description: '接入参考视频（最多 3 段）。' },
      reference_audios: { name: '参考音频', description: '接入参考音频（最多 3 段）。' },
    },
    outputs: {
      video: { name: '生成视频', description: '生成的视频结果。' },
    },
  },
};

const TEMPLATE_LOCALES_EN: ModelAssetLocalizationResourceMap = {
  fields: {
    prompt: { label: 'Prompt' },
    first_frame: {
      label: 'First frame',
      description: 'The starting frame. Aspect ratio 0.4–2.5, edges 300–6000 px, under 30 MB; inputs containing real human faces are rejected upstream.',
    },
    last_frame: {
      label: 'Last frame',
      description: 'The ending frame, used together with the first frame; same constraints as the first frame.',
    },
    reference_images: {
      label: 'Reference images',
      description: 'Up to 9 images. Aspect ratio 0.4–2.5, edges 300–6000 px, under 30 MB; inputs containing real human faces are rejected upstream.',
    },
    reference_videos: {
      label: 'Reference videos',
      description: 'Up to 3 clips, each 2–15 s and under 200 MB; combined with reference audio the total length must stay within 15 s.',
    },
    reference_audios: {
      label: 'Reference audio',
      description: 'Up to 3 clips in WAV / MP3, each 2–15 s. Audio cannot stand alone: attach at least one reference image or video.',
    },
    resolution: {
      label: 'Resolution',
      description: 'Defaults to 720p. Available: 480p, 720p.',
      options: {
        '480p': { label: '480p SD' },
        '720p': { label: '720p HD' },
      },
    },
    ratio: {
      label: 'Aspect ratio',
      description: 'All 7 official ratios. Defaults to adaptive (follows the input content).',
      options: {
        '16_9': { label: '16:9' },
        '4_3': { label: '4:3' },
        '1_1': { label: '1:1' },
        '3_4': { label: '3:4' },
        '9_16': { label: '9:16' },
        '21_9': { label: '21:9' },
        adaptive: { label: 'Adaptive (default)' },
      },
    },
    duration: {
      label: 'Duration (seconds)',
      description: 'An integer from 4 to 15, or "smart" duration (decided by prompt complexity, around 5 s). Defaults to 5 s. Frame rate is fixed at 24 fps.',
      options: {
        '4': { label: '4 s' },
        '5': { label: '5 s' },
        '6': { label: '6 s' },
        '7': { label: '7 s' },
        '8': { label: '8 s' },
        '9': { label: '9 s' },
        '10': { label: '10 s' },
        '11': { label: '11 s' },
        '12': { label: '12 s' },
        '13': { label: '13 s' },
        '14': { label: '14 s' },
        '15': { label: '15 s' },
        smart: { label: 'Smart (about 5 s)' },
      },
    },
    generate_audio: {
      label: 'Generate audio',
      description: 'On by default. Turn off to submit a silent video.',
    },
    return_last_frame: {
      label: 'Return last frame',
      description: 'When on, a succeeded task also returns the last-frame image URL for continuation.',
    },
    watermark: {
      label: 'Watermark',
      description: 'Off by default. Platform-enforced visible watermarking is independent of this switch.',
    },
  },
  ports: {
    inputs: {
      first_frame: { name: 'First frame', description: 'Connect an asset as the starting frame.' },
      last_frame: { name: 'Last frame', description: 'Connect an asset as the ending frame.' },
      reference_images: { name: 'Reference images', description: 'Connect up to 9 reference images.' },
      reference_videos: { name: 'Reference videos', description: 'Connect up to 3 reference videos.' },
      reference_audios: { name: 'Reference audio', description: 'Connect up to 3 reference audio clips.' },
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

/** 输入端口：只为勾选的素材位声明（data_type 逐位正确，file 组件不参与推导）。 */
const buildInputPorts = (accepted: ReadonlySet<GenerationMediaSlotId>): JsonObject[] => {
  const ports: JsonObject[] = [];
  for (const slot of KEYFRAME_SLOT_ORDER) {
    if (!accepted.has(slot)) continue;
    const fieldKey = MEDIA_SLOT_FIELD_KEYS[slot];
    ports.push({
      id: fieldKey,
      name: `ports.inputs.${fieldKey}.name`,
      data_type: 'image',
      field_key: fieldKey,
      required: false,
      multiple: false,
      max_connections: 1,
      description: `ports.inputs.${fieldKey}.description`,
    });
  }
  if (accepted.has('reference_image')) {
    ports.push({
      id: MEDIA_SLOT_FIELD_KEYS.reference_image,
      name: `ports.inputs.${MEDIA_SLOT_FIELD_KEYS.reference_image}.name`,
      data_type: 'image',
      field_key: MEDIA_SLOT_FIELD_KEYS.reference_image,
      required: false,
      multiple: true,
      max_connections: 9,
      description: `ports.inputs.${MEDIA_SLOT_FIELD_KEYS.reference_image}.description`,
    });
  }
  if (accepted.has('reference_video')) {
    ports.push({
      id: MEDIA_SLOT_FIELD_KEYS.reference_video,
      name: `ports.inputs.${MEDIA_SLOT_FIELD_KEYS.reference_video}.name`,
      data_type: 'video',
      field_key: MEDIA_SLOT_FIELD_KEYS.reference_video,
      required: false,
      multiple: true,
      max_connections: 3,
      description: `ports.inputs.${MEDIA_SLOT_FIELD_KEYS.reference_video}.description`,
    });
  }
  if (accepted.has('reference_audio')) {
    ports.push({
      id: MEDIA_SLOT_FIELD_KEYS.reference_audio,
      name: `ports.inputs.${MEDIA_SLOT_FIELD_KEYS.reference_audio}.name`,
      data_type: 'audio',
      field_key: MEDIA_SLOT_FIELD_KEYS.reference_audio,
      required: false,
      multiple: true,
      max_connections: 3,
      description: `ports.inputs.${MEDIA_SLOT_FIELD_KEYS.reference_audio}.description`,
    });
  }
  return ports;
};

/** 能力声明：输入模态随勾选的素材位增长，其余与三型号一致。 */
const buildCapability = (accepted: ReadonlySet<GenerationMediaSlotId>): JsonObject => {
  const inputModalities = ['text'];
  if (accepted.has('first_frame') || accepted.has('last_frame') || accepted.has('reference_image')) {
    inputModalities.push('image');
  }
  if (accepted.has('reference_video')) inputModalities.push('video');
  if (accepted.has('reference_audio')) inputModalities.push('audio');
  return {
    input_modalities: inputModalities,
    output_modalities: ['video'],
    supports_async_task: true,
    supports_streaming: false,
    supports_multi_image: accepted.has('reference_image'),
    supports_reference_media: accepted.size > 0,
    constraints: [],
  };
};

/**
 * 异步轮询策略（三个在役型号逐字段一致，测试钉死）。
 *
 * 查询请求是 GET、无 header、无 body（`headers:{}` / `body:null` 与包一致）；`{id}` 由轮询层
 * 用提交响应 `/id` 替换（task-engine-polling-utils 的占位符集合含 `{id}`）。
 */
const buildPollingStrategy = (): JsonObject => ({
  request: {
    url_template: TASK_BY_ID_ENDPOINT,
    method: 'GET',
    headers: {},
    body: null,
  },
  polling: {
    intervalMs: 3000,
    maxAttempts: 500,
    successFieldPaths: ['content.video_url', 'status'],
    successStatuses: ['succeeded'],
    statusFieldPaths: ['status', 'data.status'],
    failureStatuses: ['failed', 'expired'],
    failureCodePaths: ['error.code'],
    failureMessagePaths: ['error.message', 'message', 'data.message', 'fail_reason'],
  },
});

/**
 * seedance-2-0-v1 基础族模板（不含记录覆盖）：从 model_id 与接受的素材位合成
 * runtime_model / node_definition / locales 形状的内存态包源，交给与已装包相同的投影路径。
 *
 * 记录覆盖由注册表的通用合成入口（`buildFamilyTemplateSources`）统一应用；基础模板单独
 * 导出是因为覆盖校验（保存期）需要在**未应用覆盖**的模板上运行（设计 §3.3 校验唯一实现）。
 */
export const buildSeedance20V1BaseTemplateSources = (
  modelId: string,
  options: GenerationFamilyTemplateOptions,
): GenerationFamilyTemplateSources => {
  const accepted = new Set<GenerationMediaSlotId>(options.acceptedMediaSlots);
  const parameterSchema = buildParameterSchema(accepted);
  const runtimeModel: JsonObject = {
    model_id: modelId,
    provider_id: 'bytedance',
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
      // 与 openai/gemini 族同一约定：声明模型的目录排序排在其它模型之后。
      order: 9000,
    },
    runtime: {
      provider_id: 'bytedance',
      default_task_type: 'video',
      mode: 'video',
      aliases: [],
      // 单一 endpoint、固定 JSON 体：不需要条件求值的 payload_format。
      payload_format: 'json',
      workspace: {
        // 与在役包同值：视频任务列表在画布右侧。
        task_list_position: 'right',
      },
      // 公网中转：content 里的媒体一律以公网 URL 提交（三类媒体都走通用文件中转目标）。
      // 只在确实带素材位时声明——不勾任何素材位的纯文生视频形态没有任何 public_url 目标，
      // 此时声明 public_relay 会被 validateMediaTargetRuleSet 判为
      // `url_input_upload_mode_without_public_url_target`（坏包）。
      ...(accepted.size > 0
        ? {
            url_input_upload_mode: 'public_relay',
            url_input_upload_target_type: 'cloudflare_image_public_url',
          }
        : {}),
      api_defaults: {
        endpoint: TASKS_ENDPOINT,
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
      endpoint: TASKS_ENDPOINT,
      method: 'POST',
      header_rules: [],
      body_rules: [],
      query_rules: [],
    },
    // 异步任务：提交响应的 `/id` 是后续查询的任务 id（与包一致，无额外失败条件——
    // 失败判定走 polling.failureStatuses / failureCodePaths / failureMessagePaths）。
    result_rule: {
      mode: 'async',
      submit_response_id_path: '/id',
    },
    polling_strategy: buildPollingStrategy(),
    result_output_mapping: {
      response_mode: 'structured_payload',
      output_mapping_rules: [
        {
          target: 'output.video_url',
          source: { kind: 'response', path: 'content.video_url' },
          required: false,
          default_value: null,
        },
        {
          // 网关包裹形态的兜底路径（与包一致）。
          target: 'output.video_url',
          source: { kind: 'response', path: 'data.content.video_url' },
          required: false,
          default_value: null,
        },
      ],
      note: 'declared generation model (seedance-2-0-v1 family template)',
    },
    prompt_field: {
      field_key: '__prompt',
      required: true,
      validation_rules: [],
    },
  };
  const node: JsonObject = {
    node_type: 'model',
    group_key: 'bytedance',
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

/** 全素材位态：参数描述的保留键基线需要覆盖所有可能出现的 content 分支。 */
const ALL_ACCEPTED_SLOTS: ReadonlySet<GenerationMediaSlotId> = new Set<GenerationMediaSlotId>(
  SEEDANCE_2_0_V1_SUPPORTED_MEDIA_SLOTS,
);

/**
 * seedance-2-0-v1 的参数描述（GET /api/generation-family-templates/:familyAdapterId 的数据）。
 *
 * 与 openai/gemini 族同一口径：以「不接受任何素材位」基线构建（素材位字段不进编辑器），
 * 另把「全素材位」形态的 payload_rules 并入保留键计算——基线是纯文生视频形态，但声明可能
 * 接受素材位，那些分支的键同样要保留（content / model / prompt 等协议键）。
 */
export const buildSeedance20V1ParameterDescriptor = (): FamilyTemplateParameterDescriptor =>
  buildFamilyTemplateParameterDescriptorFromSources({
    familyAdapterId: SEEDANCE_2_0_V1_FAMILY_ADAPTER_ID,
    baselineSources: buildSeedance20V1BaseTemplateSources('descriptor-baseline', {
      acceptedMediaSlots: [],
    }),
    extraPayloadRuleSets: [buildPayloadRules('descriptor-baseline', ALL_ACCEPTED_SLOTS)],
  });

/**
 * 已知边界（payload DSL 表达力的真实限制，不在此处兜底）：
 *
 * 1. **跨字段互斥只能单向表达**。「首尾帧、全模态参考」官方互斥（登记契约 §7.3），DSL 没有
 *    「两组不得同时非空 → 报错」的算子。模板做成「参考组优先」：混填时首帧/尾帧分支不产出，
 *    既不报错也不静默拼出非法 content；被丢掉的首尾帧在请求体里不可见（无日志通道）。
 * 2. **音频必须伴随图/视频**（官方 2.0 约束）无法在 DSL 里断言：`assert_*` 只能判断单字段，
 *    无法表达「audio 非空 ⇒ image 或 video 至少一个非空」。该约束由上游校验兜底。
 * 3. **首尾帧数量（1 张 vs 2 张）**：两条 when 分支各自独立，`last_frame` 单独填写会产出
 *    「只有尾帧」的 content，官方语义上属于首尾帧场景的残缺形态，同样由上游校验兜底。
 */
