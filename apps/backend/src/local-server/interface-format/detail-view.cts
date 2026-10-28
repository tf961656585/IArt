import {
  parseInterfaceFormatRuleTarget,
  type AdapterAuth,
  type FamilyTemplateParameterDescriptor,
  type InterfaceFormatBuiltinBehaviorView,
  type InterfaceFormatDetail,
  type InterfaceFormatMediaSlotView,
  type InterfaceFormatModelBinding,
  type InterfaceFormatNameValue,
  type InterfaceFormatPromptBinding,
  type InterfaceFormatSummary,
  type InterfaceFormatTransportView,
} from '@iart/contracts';
import { buildFamilyTemplateParameterDescriptor } from '../generation-family-templates.registry.cts';
import * as loggingModule from '../logging.cts';
import { isObjectRecord } from '../model-package-catalog.shared.cts';
import type { JsonObject } from '../model-package-catalog.types.cts';
import { listCustomGenerationModels } from '../provider-connection/custom-generation-model-store.cts';
import { listInterfaceRecipes } from '../provider-connection/interface-recipe-store.cts';
import type { InterfaceFormat } from './schema.cts';

/**
 * 接口格式实体 → 列表摘要 / 详情视图（纯函数，除记录计数由调用方传入外无 IO）。
 *
 * 2026-10-27 请求落点批次从 `routes/interface-format-routes.cts` 拆出：路由文件只保留
 * HTTP 语义（状态码、错误文案、写策略），投影口径在这里集中。从 `routes/` 重新导出
 * `buildInterfaceFormatSummary` / `buildInterfaceFormatDetail`，既有调用点无需改动。
 */

const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

const readNonEmptyString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const readJsonObject = (value: unknown): JsonObject | null => (isObjectRecord(value) ? value : null);

// ---------------------------------------------------------------------------
// 投影：实体 → 列表摘要 / 详情
//
// 全部是纯函数（除 `used_by_model_count` 由调用方传入），因此未就绪格式的投影可以在测试里用
// 合成实体直接覆盖——当前 8 条预设全部 ready，经路由无法构造 pending 分支。
// ---------------------------------------------------------------------------

/**
 * 实体 → 列表摘要。
 *
 * 未就绪格式的素材位清单取空数组（与族模板注册表条目同一口径）：`pending` 表示运行时规则
 * 尚未就绪，此时它确实一个素材位也表达不了。允许把预设里声明的素材位透出去，会让界面把
 * 「还不能用」显示成「能用这几位」。
 */
export const buildInterfaceFormatSummary = (format: InterfaceFormat): InterfaceFormatSummary => {
  const ready = format.status === 'ready';
  return {
    format_id: format.format_id,
    display_name: format.display_name,
    family: format.family,
    status: format.status,
    supports_media_slots: ready ? [...format.media.supports] : [],
    required_media_slots: ready ? [...format.media.required] : [],
    order: format.order,
    origin: format.origin,
    version: format.version,
  };
};

/**
 * 请求规则的只读视图：只读取本文件需要的几个固定字段。
 *
 * 用局部类型视图而不是裸 `Record<string, unknown>` 方括号访问：固定字段应以属性访问表达，
 * 拼错键名在编译期可见；规则树其余部分是开放 JSON，不需要在这里建模。
 */
type PayloadRuleView = {
  kind?: unknown;
  field_key?: unknown;
  value?: unknown;
  media_target?: unknown;
};

const asPayloadRuleView = (value: unknown): PayloadRuleView | null =>
  isObjectRecord(value) ? (value as PayloadRuleView) : null;

/** 素材位输入载体：从该位在请求规则里的 `media_target` 反推；判不出来给 null。 */
const resolveSlotCarrier = (
  format: InterfaceFormat,
  fieldKey: string,
): 'multipart_file' | 'public_url' | 'inline_data' | null => {
  const rule = asPayloadRuleView(format.transport.payload_rules[`body.${fieldKey}`]);
  const target = rule?.media_target;
  return target === 'multipart_file' || target === 'public_url' || target === 'inline_data'
    ? target
    : null;
};

const buildMediaSlotViews = (format: InterfaceFormat): InterfaceFormatMediaSlotView[] => {
  const views: InterfaceFormatMediaSlotView[] = [];
  for (const slotId of format.media.supports) {
    const slot = format.media.slots[slotId];
    if (slot === undefined) {
      // 实体 schema 已钉住 slots 键集与 supports 一致；走到这里说明预设校验被绕过，留痕不静默。
      loggingModule.logDebug('[interface-format/detail-view] media slot declared but not described', {
        formatId: format.format_id,
        slotId,
      });
      continue;
    }
    views.push({
      slot_id: slotId,
      field_key: slot.field_key,
      required: format.media.required.includes(slotId),
      ...(slot.max_files === undefined ? {} : { max_files: slot.max_files }),
      carrier: resolveSlotCarrier(format, slot.field_key),
    });
  }
  return views;
};

/**
 * 实体 → 传输段视图（`endpoint_key` 解析成实际相对路径）。
 *
 * 解析不出来时返回 `null` 并留痕，不退回 `endpoint_key` 字面量：界面要展示的是「请求打到
 * 哪个地址」，把内部键名当路径显示会让人以为地址就是这个字符串。
 */

/**
 * 提示词落点（从规则树反推，唯一实现）。
 *
 * 只认「直接发出提示词字段」的规则（`kind = 'field'` 且 `field_key` 命中该格式声明的提示词
 * 字段）：预设里把提示词嵌进 `compute` 的格式（结构化 blocks / 数组内容）判不出来，返回
 * `null`，不按名字猜——猜出来的路径会被编辑表单当成事实回填，改坏用户的格式。
 */
const resolvePromptBinding = (format: InterfaceFormat): InterfaceFormatPromptBinding | null => {
  const promptFieldKey = format.parameters.prompt_field.field_key;
  for (const [target, rawRule] of Object.entries(format.transport.payload_rules)) {
    const rule = asPayloadRuleView(rawRule);
    if (rule === null || rule.kind !== 'field' || rule.field_key !== promptFieldKey) continue;
    const parsed = parseInterfaceFormatRuleTarget(target);
    if (parsed.kind === 'body_field') return { location: 'body', path: parsed.path };
    if (parsed.kind === 'body_text') return { location: 'text' };
    if (parsed.kind === 'query') return { location: 'query', name: parsed.name };
  }
  return null;
};

/**
 * 模型 ID 落点（从规则树 / 提交路径反推）。
 *
 * 先看规则树里「发出 `{{model_id}}` 字面量」的落点（请求体或查询参数）；没有这样的规则时，
 * 再看提交路径是否带 `{model}` 占位（地址路径形态）。两处都没有 = 该格式不发 model_id。
 */
const resolveModelBinding = (
  format: InterfaceFormat,
  submitPath: string,
): InterfaceFormatModelBinding | null => {
  for (const [target, rawRule] of Object.entries(format.transport.payload_rules)) {
    const rule = asPayloadRuleView(rawRule);
    if (rule === null || rule.kind !== 'literal' || rule.value !== '{{model_id}}') continue;
    const parsed = parseInterfaceFormatRuleTarget(target);
    if (parsed.kind === 'body_field') return { location: 'body', path: parsed.path };
    if (parsed.kind === 'query') return { location: 'query', name: parsed.name };
  }
  if (submitPath.includes('{model}')) return { location: 'path' };
  return null;
};

/**
 * 从规则树收集**固定线路常量**（`api.headers.*` / `api.query.*`）。
 *
 * 只收「字面量 + 字符串值」：那是表单能无损表达、也能原样回填的形态。字段绑定（参数、
 * 提示词、模型 ID）由 binding 字段表达，不在固定常量里重复；复杂/条件规则（compute /
 * 占位符组合）无法用「名称 = 值」表达，跳过并留痕——该规则仍随格式原样保留，编辑时的
 * 保真机制会把它带回去，只是详情视图不展示它。
 */
const collectFixedWireValues = (
  format: InterfaceFormat,
): { headers: InterfaceFormatNameValue[]; query: InterfaceFormatNameValue[] } => {
  const headers: InterfaceFormatNameValue[] = [];
  const query: InterfaceFormatNameValue[] = [];
  for (const [target, rawRule] of Object.entries(format.transport.payload_rules)) {
    const parsed = parseInterfaceFormatRuleTarget(target);
    if (parsed.kind !== 'header' && parsed.kind !== 'query') continue;
    const rule = asPayloadRuleView(rawRule);
    if (rule !== null && rule.kind === 'field') continue;
    if (rule !== null && rule.kind === 'literal' && typeof rule.value === 'string') {
      (parsed.kind === 'header' ? headers : query).push({ name: parsed.name, value: rule.value });
      continue;
    }
    loggingModule.logDebug('[interface-format/detail-view] non-literal wire rule kept out of the form view', {
      formatId: format.format_id,
      target,
      ruleKind: rule === null ? null : rule.kind,
      note: '编辑保真机制仍会保留该规则',
    });
  }
  return { headers, query };
};

/** 鉴权形状 → 详情视图（按 kind 分支，查询参数鉴权没有 header_name）。 */
const buildAuthView = (auth: AdapterAuth): InterfaceFormatTransportView['auth'] => {
  switch (auth.kind) {
    case 'bearer':
      return auth.prefix === undefined
        ? { kind: 'bearer', header_name: auth.header_name }
        : { kind: 'bearer', header_name: auth.header_name, prefix: auth.prefix };
    case 'header_api_key':
      return { kind: 'header_api_key', header_name: auth.header_name };
    case 'query_api_key':
      return { kind: 'query_api_key', query_name: auth.query_name };
  }
};

const buildTransportView = (format: InterfaceFormat): InterfaceFormatTransportView | null => {
  const submitPath = format.transport.endpoints[format.transport.submit.endpoint_key];
  if (submitPath === undefined) {
    loggingModule.logDebug('[interface-format/detail-view] submit endpoint key not resolvable', {
      formatId: format.format_id,
      endpointKey: format.transport.submit.endpoint_key,
    });
    return null;
  }

  const asyncConfig = format.transport.async;
  let asyncView: InterfaceFormatTransportView['async'] = null;
  if (asyncConfig !== undefined) {
    const polling = asyncConfig.polling;
    const urlTemplate =
      polling.url_template ??
      (polling.endpoint_key === undefined ? undefined : format.transport.endpoints[polling.endpoint_key]);
    if (urlTemplate === undefined) {
      loggingModule.logDebug('[interface-format/detail-view] polling endpoint key not resolvable', {
        formatId: format.format_id,
        endpointKey: polling.endpoint_key ?? null,
      });
      return null;
    }
    asyncView = {
      identity_path: asyncConfig.identity_path,
      polling: {
        url_template: urlTemplate,
        method: polling.method,
        interval_ms: polling.interval_ms,
        max_attempts: polling.max_attempts,
        headers: polling.headers.map((entry) => ({ name: entry.name, value: entry.value })),
        query: polling.query.map((entry) => ({ name: entry.name, value: entry.value })),
        ...(polling.body === undefined ? {} : { body: polling.body }),
        body_format: polling.body_format,
        content_type: polling.content_type,
      },
    };
  }

  const fixedWireValues = collectFixedWireValues(format);
  return {
    auth: buildAuthView(format.transport.auth),
    endpoints: { ...format.transport.endpoints },
    prompt_binding: resolvePromptBinding(format),
    model_binding: resolveModelBinding(format, submitPath),
    submit: {
      method: format.transport.submit.method,
      path: submitPath,
      content_type: format.transport.submit.content_type,
      payload_format: format.transport.submit.payload_format,
      headers: fixedWireValues.headers,
      query: fixedWireValues.query,
      form_field_style: format.transport.submit.form_field_style,
      form_array_style: format.transport.submit.form_array_style,
    },
    async: asyncView,
  };
};

/**
 * 内置行为 → 只读摘要（没有内置行为段或判不出来时为 `null`）。
 *
 * 判定口径（钉死在此，消费侧不再自行解释）：
 * - `has_success_condition`：异步格式看是否声明了 `polling_status`；同步格式看
 *   `result_rule.failure_condition` 是否存在（同步没有轮询状态，失败条件就是它唯一的判定声明）。
 * - `requires_auth`：结果获取段或结果映射段任一声明 `requires_auth === true`。
 * - `failure_reason_present`：`result_rule.failure_reason` 是非空字符串。
 * - `result_form`：`result_acquisition.acquisition_mode` 存在 → `needs_fetch`；
 *   `result_output_mapping.response_mode === 'binary_media'` → `inline_media`；
 *   `structured_payload` 的映射规则只说明「产物从这个字段取」，字段里是链接还是内联内容
 *   静态判不出来（Gemini Interactions 就是内联块），按纪律给 `null` 而不是猜。
 *
 * `result_rule.mode` 不是 sync / async 时整段返回 `null`：连同步异步都判不出来，另外三项
 * 的语义也就无从谈起。
 */
const deriveBuiltinBehavior = (format: InterfaceFormat): InterfaceFormatBuiltinBehaviorView | null => {
  const behavior = format.builtin_behavior;
  if (behavior === undefined) return null;
  const resultRule = readJsonObject(behavior.result_rule);
  if (resultRule === null) return null;
  const mode = readNonEmptyString(resultRule.mode);
  if (mode !== 'sync' && mode !== 'async') {
    loggingModule.logDebug('[interface-format/detail-view] builtin result_rule mode not recognised', {
      formatId: format.format_id,
      mode,
    });
    return null;
  }

  const hasSuccessCondition =
    mode === 'async' ? behavior.polling_status !== undefined : hasOwn(resultRule, 'failure_condition');

  const acquisition = readJsonObject(behavior.result_acquisition);
  const acquisitionMode = acquisition === null ? null : readNonEmptyString(acquisition.acquisition_mode);
  const mapping = readJsonObject(behavior.result_output_mapping);
  const responseMode = mapping === null ? null : readNonEmptyString(mapping.response_mode);
  const resultForm =
    acquisitionMode !== null
      ? 'needs_fetch'
      : responseMode === 'binary_media'
        ? 'inline_media'
        : null;

  const requiresAuth =
    (acquisition !== null && acquisition.requires_auth === true) ||
    (mapping !== null && mapping.requires_auth === true);

  const failureReason = readNonEmptyString(resultRule.failure_reason);

  return {
    has_success_condition: hasSuccessCondition,
    result_form: resultForm,
    requires_auth: requiresAuth,
    failure_reason_present: failureReason !== null,
  };
};

/**
 * 引用该格式的生成模型记录条数。
 *
 * 口径：记录 store 里 `family_adapter_id === formatId` 的条数（含预设与将来用户自建格式）。
 * store 读取失败不能伪装成 0（0 是「没有模型在用」这个业务事实），因此异常向上抛，由路由
 * 统一落 500 并在报告里说明。
 */
export const countModelsUsingFormat = (formatId: string): number =>
  listCustomGenerationModels().filter((model) => model.family_adapter_id === formatId).length;

export const buildInterfaceFormatDetail = (
  format: InterfaceFormat,
  usedByModelCount: number,
): InterfaceFormatDetail => {
  const summary = buildInterfaceFormatSummary(format);
  const recipeId =
    format.origin === 'user'
      ? (listInterfaceRecipes().find((recipe) => recipe.family_adapter_id === format.format_id)?.recipe_id ?? null)
      : null;
  if (format.status !== 'ready') {
    // 未就绪：只有身份可用，其余段落按「还没就绪」给 null / 空数组（不使用半成品形状）。
    return {
      summary,
      transport: null,
      media_slots: [],
      parameter_descriptor: null,
      builtin_behavior: null,
      used_by_model_count: usedByModelCount,
      recipe_id: recipeId,
    };
  }

  const descriptorResult = buildFamilyTemplateParameterDescriptor(format.format_id);
  let parameterDescriptor: FamilyTemplateParameterDescriptor | null = null;
  if (descriptorResult.kind === 'ready') {
    parameterDescriptor = descriptorResult.descriptor;
  } else {
    // 同一份注册表刚刚命中该 id，这里只可能是合成期失败（理论不可达）；留痕，不伪造描述。
    loggingModule.logDebug('[interface-format/detail-view] parameter descriptor unavailable for ready format', {
      formatId: format.format_id,
      resultKind: descriptorResult.kind,
    });
  }

  return {
    summary,
    transport: buildTransportView(format),
    media_slots: buildMediaSlotViews(format),
    parameter_descriptor: parameterDescriptor,
    builtin_behavior: deriveBuiltinBehavior(format),
    used_by_model_count: usedByModelCount,
    recipe_id: recipeId,
  };
};

