import {
  cloneJsonValue,
  normalizeHeaderName,
  type GenerationMediaSlotId,
  type InterfaceRecipe,
  type ParameterOverrides,
} from '@iart/contracts';
import { MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY } from '@iart/contracts/model-asset-contract/protocol-constants';
import {
  type GenerationFamilyTemplateSources,
} from '../generation-family-templates.cts';
import { applyParameterOverrides, EMPTY_PARAMETER_OVERRIDES } from '../generation-parameter-overrides.cts';
import { applyRecipeToSources } from '../interface-recipe-apply.cts';
import * as loggingModule from '../logging.cts';
import { requireObjectRecord } from '../model-package-catalog.shared.cts';
import type { JsonObject, JsonValue } from '../model-package-catalog.types.cts';
import { assertNoPlaceholderResidue, renderInterfaceFormatPlaceholders } from './placeholder.cts';
import { assertNoMacroResidue, resolveMacroTree, type InterfaceFormatMacroScope } from './macros.cts';
import { deriveFixedRequestHeaders } from './request-headers.cts';
import { InterfaceFormatSchema, type InterfaceFormat, type InterfaceFormatJsonValue } from './schema.cts';

/**
 * 接口格式实体 → 族模板 sources 的合成（纯函数，无 IO、无网络）。
 *
 * 合成顺序与今天 `buildFamilyTemplateSources` 完全一致：
 * 预设基础模板 →（素材位片段）→ 记录参数覆盖 → 接口配方。
 * 因此同一份格式声明合成的 sources 与「一族一份 TypeScript 工厂」逐字段等价——本批的
 * `__tests__/interface-format.compose.equivalence.test.ts` 用 `openai-image-v1` 的两个合法
 * 素材位子集钉住这件事。
 *
 * 分工：
 * - `transport` / `parameters` / `media` / `projection` / `localization` 决定**结构与传输**；
 * - `transport.payload_rules` 是请求规则的**唯一来源**（完整规则树，逐键照搬族构建器）；
 *   素材位条件分支、能力派生、runtime 额外键由合成期宏表达（`macros.cts`），不再按参数表 /
 *   素材位自动推导任何一条规则；
 * - `media.slots` + `composition.fragments` 只决定「某素材位被接受时多出哪些表单字段与画布
 *   端口」；
 * - `builtin_behavior` 是「没有配方时」的判定与结果形态默认；有配方时先落它再让配方覆盖
 *   （配方不决定 mode 与任务标识）。
 *
 * 遗留的 `composition.variants` 是对合成源的 patch（对象递归合并、数组整体替换、`null` 删除、
 * 带 `kind` 的规则节点原子替换）。两条迁移完成的预设已不再使用它：请求规则差异走宏，
 * 源级差异应作为预设结构问题处理，而不是再开一份 patch。
 */

/** 生成族共用的执行特征（8 族同值；不是格式级事实，故不放预设）。 */
const EXECUTION_TRAITS: readonly string[] = ['nonBlocking'];

/** 生成族投影角色（格式恒为 generator）。 */
const RUNTIME_ROLE = 'generator';

/** 请求体形态的两个声明互斥：合并额外键时出现其一即删掉另一个。 */
const RUNTIME_PAYLOAD_FORMAT_KEYS: readonly string[] = ['payload_format', 'payload_format_rule'];

export type ComposeInterfaceFormatSourcesInput = {
  format: InterfaceFormat;
  modelId: string;
  acceptedMediaSlots: readonly GenerationMediaSlotId[];
  parameterOverrides?: ParameterOverrides;
  recipe?: InterfaceRecipe | null;
};

const isPlainJsonObject = (value: unknown): value is Record<string, InterfaceFormatJsonValue> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** 请求规则节点（带 `kind` 判别字段）是原子值：patch 整体替换，不逐键合并。 */
const isRuleNode = (value: Record<string, InterfaceFormatJsonValue>): boolean =>
  typeof value.kind === 'string';

const applyValuePatch = (
  target: JsonObject,
  patch: Record<string, InterfaceFormatJsonValue>,
  path: string,
): void => {
  for (const [key, patchValue] of Object.entries(patch)) {
    const childPath = `${path}.${key}`;
    if (patchValue === null) {
      delete target[key];
      continue;
    }
    const current = target[key];
    if (
      isPlainJsonObject(patchValue) &&
      !isRuleNode(patchValue) &&
      isPlainJsonObject(current) &&
      !isRuleNode(current)
    ) {
      applyValuePatch(current, patchValue, childPath);
      continue;
    }
    target[key] = cloneJsonValue(patchValue);
  }
};

type MediaComposition = {
  fields: JsonObject[];
  defaults: JsonObject;
  ports: JsonObject[];
};

/**
 * 从 `media.slots` + `composition.fragments` 生成素材位机制（表单字段与画布端口）。
 *
 * 顺序固定按 `format.media.supports`（而不是调用方传入顺序）：多条素材位时表单字段与画布
 * 端口的次序必须与格式声明一致，否则同一份声明在不同记录上产出不同顺序的投影。
 *
 * 请求规则不在这里生成：某素材位的发出规则由 `transport.payload_rules` 用宏表达。
 */
const composeMedia = (
  format: InterfaceFormat,
  acceptedSlots: ReadonlySet<GenerationMediaSlotId>,
): MediaComposition => {
  const composition: MediaComposition = { fields: [], defaults: {}, ports: [] };
  for (const slotId of format.media.supports) {
    if (!acceptedSlots.has(slotId)) continue;
    const slot = format.media.slots[slotId];
    if (slot === undefined) {
      throw new Error(`interface_format_media_slot_undeclared: ${slotId}`);
    }
    const fragment = format.composition.fragments[slotId];
    if (fragment === undefined) {
      throw new Error(`interface_format_media_fragment_missing: ${slotId}`);
    }

    const field = cloneJsonValue<JsonObject>(fragment.schema_field);
    // `default_value` 归参数默认表（唯一事实源），合成期再回填到字段体。
    const declaredDefault = field.default_value;
    if (declaredDefault !== undefined) {
      composition.defaults[slot.field_key] = cloneJsonValue(declaredDefault);
    }
    delete field.default_value;
    field.field_key = slot.field_key;
    field.component = slot.component;
    if (slot.max_files !== undefined) {
      const props: JsonObject = isPlainJsonObject(field.component_props) ? field.component_props : {};
      props.maxFiles = slot.max_files;
      field.component_props = props;
    }
    composition.fields.push(field);

    const port = cloneJsonValue<JsonObject>(fragment.input_port);
    port.field_key = slot.field_key;
    if (slot.max_files !== undefined) {
      port.multiple = slot.max_files > 1;
    }
    composition.ports.push(port);
  }
  return composition;
};

const resolvePollingUrlTemplate = (format: InterfaceFormat): string => {
  const polling = format.transport.async?.polling;
  if (polling === undefined) {
    throw new Error('interface_format_polling_policy_missing');
  }
  if (polling.url_template !== undefined) return polling.url_template;
  const endpointKey = polling.endpoint_key;
  if (endpointKey === undefined) {
    throw new Error('interface_format_polling_target_missing');
  }
  const path = format.transport.endpoints[endpointKey];
  if (path === undefined) {
    throw new Error(`interface_format_polling_endpoint_unknown: ${endpointKey}`);
  }
  return path;
};

/**
 * 内置轮询策略（等价于今天异步族的 `polling_strategy` 段）。
 *
 * 请求段是**冻结的轮询请求描述**（headers 用 Record、query 用数组）：轮询由运行时按执行计划
 * 独立发起，不回读格式实体的规则树。`{id}` 等占位符保留原样，由运行时的占位替换处理。
 */
const buildPollingStrategy = (format: InterfaceFormat): JsonObject => {
  const polling = format.transport.async?.polling;
  const status = format.builtin_behavior?.polling_status;
  if (polling === undefined || status === undefined) {
    throw new Error('interface_format_polling_policy_missing');
  }
  const pollingRules: JsonObject = {
    intervalMs: polling.interval_ms,
    maxAttempts: polling.max_attempts,
    successStatuses: [...status.success_values],
    statusFieldPaths: [...status.status_paths],
    failureStatuses: [...status.failure_values],
  };
  if (status.success_field_paths !== undefined) {
    pollingRules.successFieldPaths = [...status.success_field_paths];
  }
  if (status.failure_code_paths !== undefined) {
    pollingRules.failureCodePaths = [...status.failure_code_paths];
  }
  if (status.failure_message_paths !== undefined) {
    pollingRules.failureMessagePaths = [...status.failure_message_paths];
  }
  // 保存期已拒绝轮询段内重名的请求头（大小写不敏感）；这里再做一次防御性收口并留痕，
  // 避免手工改写磁盘配置时出现「两个来源写同一个头」的静默二义。
  const headers: Record<string, string> = {};
  const headerNameByLowerCase = new Map<string, string>();
  for (const entry of polling.headers) {
    const lower = normalizeHeaderName(entry.name);
    const previousName = headerNameByLowerCase.get(lower);
    if (previousName !== undefined && previousName !== entry.name) {
      loggingModule.logDebug('[interface-format] duplicated polling header name, last wins', {
        formatId: format.format_id,
        previousName,
        name: entry.name,
      });
      delete headers[previousName];
    }
    headerNameByLowerCase.set(lower, entry.name);
    headers[entry.name] = entry.value;
  }
  return {
    request: {
      url_template: resolvePollingUrlTemplate(format),
      method: polling.method,
      headers,
      query: polling.query.map((entry) => ({ name: entry.name, value: entry.value })),
      body: polling.body === undefined ? null : cloneJsonValue(polling.body),
      body_format: polling.body_format,
      content_type: polling.content_type,
    },
    polling: pollingRules,
  };
};

/** 求值一段宏化的声明对象（占位符已先行渲染）；根被 `$OMIT` 或非对象即预设错误。 */
const resolveMacroObject = (
  value: Record<string, InterfaceFormatJsonValue>,
  scope: InterfaceFormatMacroScope,
  errorCode: string,
): JsonObject => {
  const resolved = resolveMacroTree(value, scope);
  if (!isPlainJsonObject(resolved)) throw new Error(errorCode);
  return cloneJsonValue<JsonObject>(resolved);
};

/**
 * 缺省请求策略：只承载「打到哪个地址、用什么方法」。
 *
 * 请求头 / 查询参数 / 请求体的实际取值只有一棵规则树（`runtime.payload_rules` 的
 * `api.headers.*` / `api.query.*` / `body.*`）。历史 `header_rules` / `body_rules` /
 * `query_rules` 三个数组从未被执行链消费，已随 2026-10-27 批次删除，不得再写回。
 */
const buildDefaultRequestStrategy = (format: InterfaceFormat, submitEndpoint: string): JsonObject => ({
  request_stage: 'submit',
  protocol: 'http',
  endpoint: submitEndpoint,
  method: format.transport.submit.method,
});

/**
 * 并入 `runtime` 的额外键：`projection.runtime_extras`（宏化）与遗留 `url_input_upload`
 * 汇成**同一份合并输入**，合并只发生在一处。
 *
 * 两个 payload format 声明互斥（运行时只认一个请求体形态）：合并时出现其一即删掉另一个，
 * 让「素材位被接受才换成条件规则」能用 `$if` 表达成「条件成立时才写出该键」。
 */
const buildRuntimeExtras = (
  format: InterfaceFormat,
  scope: InterfaceFormatMacroScope,
): JsonObject => {
  const extras: JsonObject = {};
  const declared = format.projection.runtime_extras;
  if (declared !== undefined) {
    const resolved = resolveMacroObject(declared, scope, 'interface_format_runtime_extras_invalid');
    for (const [key, value] of Object.entries(resolved)) {
      extras[key] = cloneJsonValue(value);
    }
  }
  const urlInputUpload = format.projection.url_input_upload;
  if (urlInputUpload !== undefined) {
    const legacyEntries: Array<[string, JsonValue]> = [
      ['url_input_upload_mode', urlInputUpload.mode],
      ['url_input_upload_target_type', urlInputUpload.target_type],
    ];
    for (const [key, value] of legacyEntries) {
      if (key in extras) throw new Error(`interface_format_runtime_extra_conflict: ${key}`);
      extras[key] = value;
    }
  }
  return extras;
};

const applyRuntimeExtras = (runtime: JsonObject, extras: JsonObject): void => {
  for (const [key, value] of Object.entries(extras)) {
    if (RUNTIME_PAYLOAD_FORMAT_KEYS.includes(key)) {
      for (const otherPayloadFormatKey of RUNTIME_PAYLOAD_FORMAT_KEYS) {
        if (otherPayloadFormatKey !== key) delete runtime[otherPayloadFormatKey];
      }
    }
    runtime[key] = cloneJsonValue(value);
  }
};

const buildRuntimeModel = (
  format: InterfaceFormat,
  modelId: string,
  media: MediaComposition,
  acceptedSlots: ReadonlySet<GenerationMediaSlotId>,
): JsonObject => {
  const transport = format.transport;
  const projection = format.projection;
  const submitEndpoint = transport.endpoints[transport.submit.endpoint_key];
  if (submitEndpoint === undefined) {
    throw new Error(`interface_format_submit_endpoint_unknown: ${transport.submit.endpoint_key}`);
  }
  const promptField = format.parameters.prompt_field;
  const taskType = projection.execution_profile.task_type;
  const macroScope: InterfaceFormatMacroScope = { acceptedMediaSlots: acceptedSlots };

  const defaults: JsonObject = {
    ...cloneJsonValue<JsonObject>(format.parameters.defaults),
    ...media.defaults,
  };

  // 参数表单：素材位行在前（与既有族模板同序），基线字段在后；每个字段的 default_value
  // 由默认表统一回填（默认值只在一处声明）。
  const baseFields = format.parameters.schema.fields;
  if (!Array.isArray(baseFields)) {
    throw new Error('interface_format_parameter_fields_missing');
  }
  const fields: JsonObject[] = [...media.fields];
  for (const rawField of baseFields) {
    if (!isPlainJsonObject(rawField)) {
      throw new Error('interface_format_parameter_field_invalid');
    }
    const field = cloneJsonValue<JsonObject>(rawField);
    const fieldKey = field.field_key;
    if (typeof fieldKey !== 'string' || fieldKey.length === 0) {
      throw new Error('interface_format_parameter_field_key_missing');
    }
    // 提示词只由 `parameters.prompt_field` 声明；参数表出现保留键说明数据没归一，
    // 不能静默渲染成第二个提示词输入。
    if (fieldKey === MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY) {
      throw new Error('interface_format_prompt_field_in_parameters');
    }
    fields.push(field);
  }
  // 默认值从默认表单点回填（含素材位字段）：字段体里的 default_value 与两张默认表同值，
  // 但只在 `parameters.defaults` / 素材位片段里声明一次。
  for (const field of fields) {
    const fieldKey = field.field_key;
    if (typeof fieldKey !== 'string') continue;
    const defaultValue = defaults[fieldKey];
    if (defaultValue !== undefined) {
      field.default_value = cloneJsonValue(defaultValue);
    }
  }
  const parameterSchema: JsonObject = {
    ...cloneJsonValue<JsonObject>(format.parameters.schema),
    fields,
    default_values: cloneJsonValue<JsonObject>(defaults),
  };

  // 请求规则唯一来源：完整规则树原样落入 `runtime.payload_rules`（宏已求值）。
  const payloadRules = resolveMacroObject(
    transport.payload_rules,
    macroScope,
    'interface_format_payload_rules_invalid',
  );
  const requestStrategy =
    transport.request_strategy === undefined
      ? buildDefaultRequestStrategy(format, submitEndpoint)
      : resolveMacroObject(
          transport.request_strategy,
          macroScope,
          'interface_format_request_strategy_invalid',
        );

  // `content_type: null` = 该分支没有固定 Content-Type（multipart 的 boundary 由运行时按
  // FormData 生成）。此时 `api_defaults` **不写该键**（不是写 `null`）：写 `null` 与「没有
  // 这个默认值」在消费端是两种语义，现役 multipart 族（openai-video）的基线就没有这个键。
  const apiDefaults: JsonObject = {
    endpoint: submitEndpoint,
    method: transport.submit.method,
  };
  if (transport.submit.content_type !== null) {
    apiDefaults.contentType = transport.submit.content_type;
  }

  const runtime: JsonObject = {
    provider_id: projection.provider_id,
    default_task_type: taskType,
    mode: taskType,
    aliases: [],
    workspace: cloneJsonValue<JsonObject>(projection.workspace),
    api_defaults: apiDefaults,
    payload_rules: payloadRules,
    capabilities: { execution_traits: [...EXECUTION_TRAITS] },
    schema_defaults: cloneJsonValue<JsonObject>(defaults),
    execution_driver: projection.execution_driver,
    // 表单编码的嵌套字段 / 数组形态随请求体形态一起冻结：运行时按这两个值决定 form 键名。
    // 非 form 形态下这两个键不参与发送，但保留声明让消费方不必区分「缺键」与「默认值」。
    form_field_style: transport.submit.form_field_style,
    form_array_style: transport.submit.form_array_style,
  };
  const payloadFormatRule = transport.submit.payload_format_rule;
  if (payloadFormatRule !== undefined) {
    runtime.payload_format_rule = cloneJsonValue(payloadFormatRule);
  } else {
    runtime.payload_format = transport.submit.payload_format;
  }
  // 单一合并路径：runtime_extras / 遗留 url_input_upload 都在这里并入。
  applyRuntimeExtras(runtime, buildRuntimeExtras(format, macroScope));

  const runtimeModel: JsonObject = {
    model_id: modelId,
    provider_id: projection.provider_id,
    default_task_type: taskType,
    mode: taskType,
    role: RUNTIME_ROLE,
    capability: resolveMacroObject(
      projection.capability,
      macroScope,
      'interface_format_capability_invalid',
    ),
    parameter_schema: parameterSchema,
    execution_profile: cloneJsonValue<JsonObject>(projection.execution_profile),
    display: cloneJsonValue<JsonObject>(projection.display),
    runtime,
    request_strategy: requestStrategy,
    prompt_field: {
      field_key: promptField.field_key,
      required: promptField.required,
      validation_rules: cloneJsonValue(promptField.validation_rules),
    },
  };

  const behavior = format.builtin_behavior;
  if (behavior !== undefined) {
    const resultRule = cloneJsonValue<JsonObject>(behavior.result_rule);
    const responseIdPath = transport.submit.response_id_path ?? transport.async?.identity_path;
    if (responseIdPath !== undefined) {
      resultRule.submit_response_id_path = responseIdPath;
    }
    runtimeModel.result_rule = resultRule;
    runtimeModel.result_output_mapping = cloneJsonValue<JsonObject>(behavior.result_output_mapping);
    if (behavior.result_acquisition !== undefined) {
      const acquisition = cloneJsonValue<JsonObject>(behavior.result_acquisition);
      // 取结果请求的固定请求头从规则树的字面量规则派生并冻结进策略（与配方路径同一实现）：
      // 运行时按策略独立发请求，不回读格式实体。
      acquisition.request_headers = deriveFixedRequestHeaders(payloadRules, {
        formatId: format.format_id,
        modelId,
      });
      runtimeModel.result_acquisition_strategy = acquisition;
    }
    if (behavior.polling_status !== undefined) {
      runtimeModel.polling_strategy = buildPollingStrategy(format);
    }
  }

  return runtimeModel;
};

const normalizeAcceptedSlots = (
  format: InterfaceFormat,
  acceptedMediaSlots: readonly GenerationMediaSlotId[],
): ReadonlySet<GenerationMediaSlotId> => {
  const supported = new Set<GenerationMediaSlotId>(format.media.supports);
  const accepted = new Set<GenerationMediaSlotId>();
  const unsupported: string[] = [];
  for (const slotId of acceptedMediaSlots) {
    if (!supported.has(slotId)) {
      unsupported.push(slotId);
      continue;
    }
    accepted.add(slotId);
  }
  if (unsupported.length > 0) {
    throw new Error(`interface_format_media_slot_unsupported: ${unsupported.join(', ')}`);
  }
  return accepted;
};

/**
 * 合成一份接口格式的 sources（等价于今天该族的族模板工厂 + 参数覆盖 + 配方）。
 *
 * 失败即抛错（可读错误码）：预设随软件分发，格式错误属于构建期缺陷，不允许静默降级成
 * 「某族少了一个字段」——那种形态要到真机提交时才会暴露。
 */
export const composeInterfaceFormatSources = (
  input: ComposeInterfaceFormatSourcesInput,
): GenerationFamilyTemplateSources => {
  // 先渲染占位符再 parse 一次：占位符把必填字符串填成非字符串时仍在边界暴露。
  const format = InterfaceFormatSchema.parse(
    renderInterfaceFormatPlaceholders(input.format, input.modelId),
  );
  const acceptedSlots = normalizeAcceptedSlots(format, input.acceptedMediaSlots);
  const media = composeMedia(format, acceptedSlots);
  const runtimeModel = buildRuntimeModel(format, input.modelId, media, acceptedSlots);

  const outputPorts = format.projection.node.output_ports;
  const node: JsonObject = {
    node_type: format.projection.node.node_type,
    group_key: format.projection.group_key,
    input_ports: media.ports,
    output_ports: outputPorts.map((port) => cloneJsonValue<JsonObject>(port)),
  };

  const zhResources = cloneJsonValue<JsonObject>(format.localization['zh-CN']);
  const enResources =
    format.localization.en === undefined
      ? cloneJsonValue<JsonObject>(format.localization['zh-CN'])
      : cloneJsonValue<JsonObject>(format.localization.en);
  const localizationResources: JsonObject = { 'zh-CN': zhResources, en: enResources };

  // 变体 patch 作用在「源级」形状上：保持同一份对象引用，patch 的替换/删除直接生效。
  const sourcesJson: JsonObject = { runtimeModel, node, localizationResources };
  for (const variant of format.composition.variants) {
    const applies = variant.when.slots_present.every((slotId) => acceptedSlots.has(slotId));
    if (!applies) continue;
    applyValuePatch(sourcesJson, variant.patch, 'sources');
  }

  const composedLocalization = requireObjectRecord(
    sourcesJson.localizationResources,
    'interface_format_localization_invalid',
  );
  const composedSources: GenerationFamilyTemplateSources = {
    runtimeModel: requireObjectRecord(
      sourcesJson.runtimeModel,
      'interface_format_runtime_model_invalid',
    ),
    node: requireObjectRecord(sourcesJson.node, 'interface_format_node_invalid'),
    localizationResources: {
      'zh-CN': requireObjectRecord(
        composedLocalization['zh-CN'],
        'interface_format_localization_invalid',
      ),
      // 缺 en 时回落 zh-CN（与渲染上下文同一份回落规则，不造出空语言域）。
      en: requireObjectRecord(
        composedLocalization.en ?? composedLocalization['zh-CN'],
        'interface_format_localization_invalid',
      ),
    },
  };

  // 合成顺序固定：格式基础模板 → 素材位片段/变体（上）→ 记录参数覆盖 → 接口配方。
  const withOverrides = applyParameterOverrides(
    composedSources,
    input.parameterOverrides ?? EMPTY_PARAMETER_OVERRIDES,
  );
  const recipe = input.recipe;
  const composed =
    recipe === undefined || recipe === null ? withOverrides : applyRecipeToSources(withOverrides, recipe);

  assertNoPlaceholderResidue(composed);
  assertNoMacroResidue(composed);
  return composed;
};
