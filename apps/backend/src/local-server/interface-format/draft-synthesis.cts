import type {
  CustomInterfaceFormatDraft,
  CustomInterfaceFormatParameterDraft,
  CustomInterfaceFormatSubmitAuth,
  InterfaceRecipeCreateBody,
  RecipeMediaType,
} from '@iart/contracts';
import { defaultCustomInterfaceFormatContentType, formatInterfaceFormatBindingTarget } from '@iart/contracts';
import { MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY } from '@iart/contracts/model-asset-contract/protocol-constants';
import { composeInterfaceFormatSources } from './compose.cts';
import {
  INTERFACE_FORMAT_SCHEMA_VERSION,
  InterfaceFormatSchema,
  type InterfaceFormat,
  type InterfaceFormatJsonObject,
  type InterfaceFormatJsonValue,
} from './schema.cts';

/**
 * 用户自建接口格式草稿 → 完整实体 + 判定配方（纯函数，无 IO）。
 *
 * 分工（单一实现）：
 * - 本模块把 Hub 的**声明式草稿**翻译成与预设同形的 `InterfaceFormat` 实体（`origin: 'user'`，
 *   `status: 'ready'`）。预设的字段事实源仍是实体 schema；本模块只是「用草稿里的值填满同一形状」，
 *   不产生第二份字段定义。
 * - 请求规则只有一棵树（`transport.payload_rules`），逐条显式写出：endpoint / method /
 *   Content-Type / 提示词 / 每个参数 / 固定请求头 / 固定查询参数 / 可选 model_id。合成器不会
 *   按参数表自动推导任何一条。参数的发送落点（请求体 / 查询参数 / 请求头）由草稿的 `binding`
 *   决定，实体里的 `field_key` 是参数身份（`p<序号>`），两者刻意分开。
 * - 自定义格式**必须配一份判定配方**（`builtin_behavior` 缺省）：判定与结果形态归配方所有，
 *   格式不携带「没有配方时怎么判」的默认。配方由 `buildInterfaceRecipeFromDraft` 同源生成，
 *   保证两者描述同一件事（成功判定缺省即「产物字段存在」）。
 *
 * 组件词汇表对齐仓库既有能力包字段组件（`MODEL_ASSET_SUPPORTED_FIELD_COMPONENTS`）：
 * string → `text`、number → `number`、boolean → `switch`、enum → `select`。用不受支持的组件名
 * 会在投影构建期被拒（`parameter_schema_component_unsupported`），因此这里取的是契约词表内的值。
 */

/** 用户格式的展示顺序起点（预设最大 order = 80，用户格式从 100 起递增）。 */
export const USER_INTERFACE_FORMAT_ORDER_BASE = 100;

/** 每份自定义格式固定绑定的提交端点键（实体 schema 要求 endpoint 键非空且被 submit 引用）。 */
const SUBMIT_ENDPOINT_KEY = 'submit';

/** 自定义格式的展示档位（任务列表呈现顺序；与预设的 9000 同档，避免挤压内置格式排序）。 */
const CUSTOM_FORMAT_DISPLAY_ORDER = 9000;

const MEDIA_TYPE_LABELS: Readonly<Record<RecipeMediaType, string>> = {
  image: '图像',
  video: '视频',
  audio: '音频',
};

/** 结果形态的媒体类型：再取一次时取直接内容类型或「取回后」的类型。 */
const resolveResultMediaType = (result: CustomInterfaceFormatDraft['behavior']['result']): RecipeMediaType => {
  if (result.kind === 'needs_fetch') {
    return result.media_type ?? result.after?.media_type ?? 'image';
  }
  return result.media_type;
};

const PARAMETER_COMPONENTS: Readonly<Record<CustomInterfaceFormatParameterDraft['type'], string>> = {
  string: 'text',
  number: 'number',
  boolean: 'switch',
  enum: 'select',
};

/**
 * 参数在实体里的内部字段键（稳定键）。
 *
 * 草稿的 `binding` 是「这个值发到哪里」（请求体路径 / 查询参数名 / 请求头名），它在用户
 * 改发送位置时会变；实体里的 `field_key` 是参数身份，被默认值表、参数覆盖与请求规则引用。
 * 两者必须分开：拿 binding 的路径/名称当字段键会让「改发送位置」变成「换了一个参数」，
 * 已保存的参数覆盖与预设规则引用会集体失效。
 *
 * 本批草稿没有独立的参数标识字段（契约形状已冻结），因此用「参数在草稿里的稳定序号」——
 * 同一份草稿重复合成得到同一组键，编辑时由 `draft-merge` 按落点匹配复用旧键。
 */
export const buildDraftParameterFieldKey = (index: number): string => `p${index}`;

/** 提交段实际的 Content-Type（用户没填时按请求体形态给默认值；multipart 为 null）。 */
export const resolveDraftSubmitContentType = (
  submit: CustomInterfaceFormatDraft['submit'],
): string | null => submit.content_type ?? defaultCustomInterfaceFormatContentType(submit.payload_format);

/** 素材位 → 输入数据类型与表单组件（受控词表；与既有族口径一致）。 */
const MEDIA_SLOT_DATA_TYPES: Readonly<Record<string, 'image' | 'video' | 'audio'>> = {
  reference_image: 'image',
  first_frame: 'image',
  last_frame: 'image',
  reference_video: 'video',
  reference_audio: 'audio',
  feature_video: 'video',
  base_video: 'video',
};

const MEDIA_SLOT_COMPONENTS: Readonly<Record<'image' | 'video' | 'audio', string>> = {
  image: 'imageUpload',
  video: 'videoUpload',
  audio: 'audioUpload',
};

/** 素材位请求规则：载体 + 张数决定变换算子（与运行时媒体目标校验同一组合法算子）。 */
const buildMediaSlotRule = (
  slot: CustomInterfaceFormatDraft['media_slots'][number],
): InterfaceFormatJsonObject => {
  const multiple = slot.max_files > 1;
  const rule: InterfaceFormatJsonObject = {
    kind: 'field',
    field_key: slot.field_key,
  };
  if (slot.carrier === 'multipart_file') {
    rule.transforms = [multiple ? 'allUploadFiles' : 'extractFirstFile'];
    rule.media_target = 'multipart_file';
    if (multiple) rule.multipart_array_naming = 'repeated';
    return rule;
  }
  if (slot.carrier === 'public_url') {
    rule.transforms = [multiple ? 'extractUrls' : 'extractFirstUrl'];
    rule.media_target = 'public_url';
    return rule;
  }
  rule.transforms = ['extractFirstBase64DataUrl'];
  rule.media_target = 'inline_data';
  return rule;
};

/** 配方名：`<display_name> 判定`（超长按契约上限 80 截断，先截名再拼后缀）。 */
export const buildUserInterfaceRecipeName = (displayName: string): string => {
  const suffix = ' 判定';
  const budget = 80 - suffix.length;
  const trimmed = displayName.trim();
  return `${trimmed.length > budget ? trimmed.slice(0, budget) : trimmed}${suffix}`;
};

export type BuildInterfaceFormatFromDraftOptions = {
  format_id: string;
  /** 展示顺序（用户库从 100 起递增，由 store 分配）。 */
  order: number;
};

const parameterField = (
  parameter: CustomInterfaceFormatParameterDraft,
  index: number,
): InterfaceFormatJsonObject => {
  const field: InterfaceFormatJsonObject = {
    field_key: buildDraftParameterFieldKey(index),
    label: `fields.p${index}.label`,
    required: parameter.required,
    validation_rules: [],
    layout: { colSpan: 1 },
    component: PARAMETER_COMPONENTS[parameter.type],
    component_props: {},
  };
  if (parameter.default_value !== undefined) {
    field.default_value = parameter.default_value;
  }
  if (parameter.type === 'enum') {
    field.enum_options = (parameter.enum_values ?? []).map((value, optionIndex) => ({
      value,
      label: `fields.p${index}.options.o${optionIndex}.label`,
    }));
  }
  return field;
};

const parameterLocalization = (
  parameter: CustomInterfaceFormatParameterDraft,
): InterfaceFormatJsonObject => {
  const entry: InterfaceFormatJsonObject = { label: parameter.label };
  if (parameter.type === 'enum') {
    const options: InterfaceFormatJsonObject = {};
    (parameter.enum_values ?? []).forEach((value, optionIndex) => {
      options[`o${optionIndex}`] = { label: value };
    });
    entry.options = options;
  }
  return entry;
};

/**
 * 草稿 → 参数默认表。
 *
 * 提示词没有默认值（它是用户输入）。参数字段同时把默认值写进 `parameters.defaults` 与字段体：
 * 前者是合成期默认表的唯一来源（`runtime.schema_defaults` 与 `parameter_schema.default_values`
 * 都从这里生成），后者让单独读实体的一方也能看到同一份默认值。
 */
const buildDefaults = (draft: CustomInterfaceFormatDraft): InterfaceFormatJsonObject => {
  const defaults: InterfaceFormatJsonObject = {};
  draft.parameters.forEach((parameter, index) => {
    if (parameter.default_value !== undefined) {
      defaults[buildDraftParameterFieldKey(index)] = parameter.default_value;
    }
  });
  return defaults;
};

/**
 * 请求规则树（`transport.payload_rules` 的唯一来源）。
 *
 * 键是点号路径：`api.*` 是传输元信息，`body.<路径>` 是请求体字段，`api.query.<名称>` /
 * `api.headers.<名称>` 是查询参数与请求头。落点由草稿的 `binding` 决定，target 字符串由共享
 * 层 `formatInterfaceFormatBindingTarget` 生成（与详情视图的反推互为逆运算）。
 *
 * 规则里的 `field_key` 用参数内部稳定键（`p<序号>`），**不是** binding 的路径/名称：
 * binding 会随发送位置改变，字段键是参数身份（见 `buildDraftParameterFieldKey`）。
 */
const buildPayloadRules = (draft: CustomInterfaceFormatDraft): InterfaceFormatJsonObject => {
  const rules: InterfaceFormatJsonObject = {
    'api.endpoint': { kind: 'literal', value: '{{endpoint:submit}}' },
    'api.method': { kind: 'literal', value: '{{method:submit}}' },
  };
  if (resolveDraftSubmitContentType(draft.submit) !== null) {
    rules['api.contentType'] = { kind: 'literal', value: '{{content_type:submit}}' };
  }

  // 提示词：请求体路径 / 查询参数 / 纯文本正文（`body`）。
  rules[formatInterfaceFormatBindingTarget(draft.prompt_binding)] = {
    kind: 'field',
    field_key: MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY,
    transforms: ['trim'],
  };

  draft.parameters.forEach((parameter, index) => {
    rules[formatInterfaceFormatBindingTarget(parameter.binding)] = {
      kind: 'field',
      field_key: buildDraftParameterFieldKey(index),
    };
  });

  for (const slot of draft.media_slots) {
    rules[`body.${slot.field_key}`] = buildMediaSlotRule(slot);
  }

  // 模型 ID：`path` 落点靠提交路径里的 `{model}` 占位，不产生请求规则。
  const modelBinding = draft.model_binding;
  if (modelBinding !== undefined && modelBinding.location !== 'path') {
    rules[formatInterfaceFormatBindingTarget(modelBinding)] = {
      kind: 'literal',
      value: '{{model_id}}',
    };
  }

  // 固定请求头 / 固定查询参数：字面量规则，与动态落点共用同一棵规则树。
  for (const entry of draft.submit.headers) {
    rules[`api.headers.${entry.name}`] = { kind: 'literal', value: entry.value };
  }
  for (const entry of draft.submit.query) {
    rules[`api.query.${entry.name}`] = { kind: 'literal', value: entry.value };
  }
  return rules;
};

/** 草稿的鉴权形状 → 实体鉴权形状（判别联合逐分支搬运，不重新解释语义）。 */
const buildAuth = (auth: CustomInterfaceFormatSubmitAuth): InterfaceFormatJsonObject => {
  switch (auth.kind) {
    case 'bearer':
      return {
        kind: 'bearer',
        header_name: auth.header_name,
        ...(auth.prefix === undefined ? {} : { prefix: auth.prefix }),
      };
    case 'header_api_key':
      return { kind: 'header_api_key', header_name: auth.header_name };
    case 'query_api_key':
      return { kind: 'query_api_key', query_name: auth.query_name };
  }
};

const buildLocalization = (
  draft: CustomInterfaceFormatDraft,
  mediaType: RecipeMediaType,
): InterfaceFormatJsonObject => {
  // 提示词不是参数字段，不再生成 `fields.prompt.label`；参数行从 p0 起编号。
  const fields: InterfaceFormatJsonObject = {};
  draft.parameters.forEach((parameter, index) => {
    fields[`p${index}`] = parameterLocalization(parameter);
  });
  draft.media_slots.forEach((slot) => {
    fields[`media_${slot.slot_id}`] = { label: slot.label };
  });
  const ports: InterfaceFormatJsonObject = {
    outputs: {
      [mediaType]: { name: MEDIA_TYPE_LABELS[mediaType] },
    },
  };
  if (draft.media_slots.length > 0) {
    const inputs: InterfaceFormatJsonObject = {};
    draft.media_slots.forEach((slot) => {
      inputs[slot.slot_id] = { name: slot.label };
    });
    ports.inputs = inputs;
  }
  return { fields, ports };
};

/**
 * 合成完整实体。
 *
 * 失败即抛错（可读错误码）：草稿形状已在 contracts 校验过，这里失败只可能来自
 * 「草稿合法但合成出的实体不合法」（如路径占位冲突），属于必须当场暴露的输入错误，
 * 而不是静默降级成一条不可用的格式。
 *
 * 合成末尾用 `composeInterfaceFormatSources` 在「不接受任何素材位」下实跑一次：
 * 既验证占位符/宏无残留，也保证运行时真的能拿到请求规则与参数表。
 */
export const buildInterfaceFormatFromDraft = (
  draft: CustomInterfaceFormatDraft,
  options: BuildInterfaceFormatFromDraftOptions,
): InterfaceFormat => {
  const mediaType = resolveResultMediaType(draft.behavior.result);
  const asyncConfig = draft.behavior.async;
  const isAsync = asyncConfig !== undefined;
  const mediaDataTypes = draft.media_slots.map((slot) => MEDIA_SLOT_DATA_TYPES[slot.slot_id] ?? 'image');
  const inputModalities: string[] = ['text'];
  for (const dataType of mediaDataTypes) {
    if (!inputModalities.includes(dataType)) inputModalities.push(dataType);
  }
  const mediaSupports = draft.media_slots.map((slot) => slot.slot_id);
  const mediaRequired = draft.media_slots.filter((slot) => slot.required).map((slot) => slot.slot_id);
  const mediaSlots: InterfaceFormatJsonObject = {};
  const mediaFragments: InterfaceFormatJsonObject = {};
  draft.media_slots.forEach((slot) => {
    const dataType = MEDIA_SLOT_DATA_TYPES[slot.slot_id] ?? 'image';
    mediaSlots[slot.slot_id] = {
      field_key: slot.field_key,
      component: MEDIA_SLOT_COMPONENTS[dataType],
      wire_name: slot.field_key,
      max_files: slot.max_files,
    };
    mediaFragments[slot.slot_id] = {
      schema_field: {
        label: `fields.media_${slot.slot_id}.label`,
        required: slot.required,
        validation_rules: [],
        layout: { colSpan: 1 },
        component_props: { maxFiles: slot.max_files },
        default_value: [],
      },
      input_port: {
        id: slot.field_key,
        name: `ports.inputs.${slot.slot_id}.name`,
        data_type: dataType,
        required: slot.required,
        multiple: slot.max_files > 1,
      },
    };
  });
  const hasPublicUrlSlot = draft.media_slots.some((slot) => slot.carrier === 'public_url');
  // 提示词由 `prompt_field` 单独声明，不是参数：参数表只放用户参数。
  const fields: InterfaceFormatJsonValue[] = [];
  draft.parameters.forEach((parameter, index) => {
    fields.push(parameterField(parameter, index));
  });

  const requiredFields = draft.parameters
    .map((parameter, index) => ({ parameter, fieldKey: buildDraftParameterFieldKey(index) }))
    .filter((entry) => entry.parameter.required)
    .map((entry) => entry.fieldKey);
  for (const slot of draft.media_slots) {
    if (slot.required) requiredFields.push(slot.field_key);
  }

  const submitContentType = resolveDraftSubmitContentType(draft.submit);
  const candidate = {
    schema_version: INTERFACE_FORMAT_SCHEMA_VERSION,
    format_id: options.format_id,
    version: '1.0.0',
    display_name: draft.display_name,
    family: 'generation' as const,
    origin: 'user' as const,
    status: 'ready' as const,
    order: options.order,
    transport: {
      auth: buildAuth(draft.submit.auth),
      endpoints: { [SUBMIT_ENDPOINT_KEY]: draft.submit.path },
      submit: {
        endpoint_key: SUBMIT_ENDPOINT_KEY,
        method: draft.submit.method,
        content_type: submitContentType,
        payload_format: draft.submit.payload_format,
        form_field_style: draft.submit.form_field_style,
        form_array_style: draft.submit.form_array_style,
      },
      payload_rules: buildPayloadRules(draft),
      ...(asyncConfig === undefined
        ? {}
        : {
            async: {
              identity_path: asyncConfig.identity_path,
              polling: {
                // 轮询地址只承载路径；查询参数走自己的数组，不再拼进路径字符串。
                url_template: asyncConfig.polling.path,
                method: asyncConfig.polling.method,
                headers: asyncConfig.polling.headers.map((entry) => ({ name: entry.name, value: entry.value })),
                query: asyncConfig.polling.query.map((entry) => ({ name: entry.name, value: entry.value })),
                ...(asyncConfig.polling.body === undefined ? {} : { body: asyncConfig.polling.body }),
                body_format: asyncConfig.polling.body_format,
                content_type: asyncConfig.polling.content_type,
                interval_ms: asyncConfig.polling.interval_ms,
                max_attempts: asyncConfig.polling.max_attempts,
              },
            },
          }),
    },
    parameters: {
      schema: {
        schema_type: 'object',
        fields,
        required_fields: requiredFields,
        validation_rules: [],
      },
      defaults: buildDefaults(draft),
      prompt_field: {
        field_key: MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY,
        required: true,
        validation_rules: [],
      },
    },
    media: { supports: mediaSupports, required: mediaRequired, slots: mediaSlots },
    projection: {
      provider_id: 'custom',
      group_key: 'custom',
      capability: {
        input_modalities: inputModalities,
        output_modalities: [mediaType],
        supports_async_task: isAsync,
        supports_streaming: false,
        supports_multi_image: mediaSupports.includes('reference_image'),
        supports_reference_media: mediaSupports.length > 0,
        constraints: [],
      },
      execution_profile: { task_type: mediaType, supports_async_task: isAsync },
      display: { visible: true, order: CUSTOM_FORMAT_DISPLAY_ORDER },
      workspace: {
        task_list_position: 'bottom',
        task_queue: { enabled: true, max_concurrent: 10 },
      },
      execution_driver: 'http_formal_task',
      ...(hasPublicUrlSlot
        ? {
            runtime_extras: {
              url_input_upload_mode: 'public_relay',
              url_input_upload_target_type: 'cloudflare_image_public_url',
            },
          }
        : {}),
      node: {
        node_type: 'model',
        output_ports: [
          {
            id: mediaType,
            name: `ports.outputs.${mediaType}.name`,
            data_type: mediaType,
            field_key: `output_${mediaType}`,
            multiple: true,
          },
        ],
      },
    },
    ...(asyncConfig === undefined
      ? {}
      : {
          builtin_behavior: {
            result_rule: { mode: 'async' },
            polling_status: {
              status_paths: [asyncConfig.polling.status_path],
              success_values: [...asyncConfig.polling.success_values],
              failure_values: [...asyncConfig.polling.failure_values],
            },
            // 行为由绑定的配方承载；这里只保留异步轮询骨架（合成轮询策略需要它）。
            result_output_mapping: { response_mode: 'structured_payload', output_mapping_rules: [] },
          },
        }),
    composition: { fragments: mediaFragments, variants: [] },
    localization: { 'zh-CN': buildLocalization(draft, mediaType) },
  };

  const format = InterfaceFormatSchema.parse(candidate);
  // 无素材位基线与「全部素材位」两态都实跑一次：占位符 / 宏 / 参数表 / 请求规则 /
  // 素材位片段任何一处不可用都在这里失败。
  composeInterfaceFormatSources({ format, modelId: 'custom-format-validation', acceptedMediaSlots: [] });
  if (mediaSupports.length > 0) {
    composeInterfaceFormatSources({
      format,
      modelId: 'custom-format-validation',
      acceptedMediaSlots: mediaSupports,
    });
  }
  return format;
};

/**
 * 草稿 → 判定配方。
 *
 * 同步接口没有轮询，判定在「一次响应」上完成：
 * - 成功判定缺省 = 「产物映射的第一个路径存在」，与 `result.media_field_paths` 同一份声明；
 * - 失败判定与失败原因原样透传（用户明确写了的才生效）；
 * - `family_adapter_id` 绑定刚合成的格式，一个自定义格式对一份配方（写入侧保证一一对应）。
 */
export const buildInterfaceRecipeFromDraft = (
  draft: CustomInterfaceFormatDraft,
  formatId: string,
): InterfaceRecipeCreateBody => {
  const behavior = draft.behavior;
  const asyncConfig = behavior.async;
  const directResult = behavior.result.kind === 'needs_fetch'
    ? behavior.result.after ?? null
    : behavior.result;
  const firstMediaPath = directResult?.media_field_paths[0];

  /**
   * 成功判定的缺省：
   * - 异步：轮询状态命中允许值（这是唯一可靠的完成信号）；
   * - 同步：产物映射的第一个路径存在。
   */
  const successWhen = behavior.success_when
    ?? (asyncConfig !== undefined
      ? { op: 'in' as const, path: asyncConfig.polling.status_path, value: asyncConfig.polling.success_values }
      : firstMediaPath === undefined
        ? undefined
        : { op: 'exists' as const, path: firstMediaPath });
  if (successWhen === undefined) {
    throw new Error('custom_interface_format_success_condition_missing');
  }

  const failureWhen = behavior.failure_when
    ?? (asyncConfig !== undefined && asyncConfig.polling.failure_values.length > 0
      ? { op: 'in' as const, path: asyncConfig.polling.status_path, value: asyncConfig.polling.failure_values }
      : undefined);

  return {
    name: buildUserInterfaceRecipeName(draft.display_name),
    family_adapter_id: formatId,
    success_when: successWhen,
    ...(failureWhen === undefined ? {} : { failure_when: failureWhen }),
    ...(behavior.failure_reason === undefined ? {} : { failure_reason: behavior.failure_reason }),
    result: behavior.result,
    requires_auth: behavior.requires_auth,
  };
};
