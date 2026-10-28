import {
  cloneJsonValue,
  interfaceFormatBodyPathsOverlap,
  normalizeHeaderName,
  parseInterfaceFormatRuleTarget,
  type CustomInterfaceFormatDraft,
} from '@iart/contracts';
import { collectPayloadRuleFieldReferences } from '../model-package-catalog.payload-rule-references.cts';
import * as loggingModule from '../logging.cts';
import { buildDraftParameterFieldKey } from './draft-synthesis.cts';
import { resolveLocaleText } from '../generation-parameter-overrides.cts';
import {
  collectWireNamesByFieldKey,
  ownedFieldKeyOfRule,
  type FieldWireFact,
} from '../generation-wire-names.cts';
import {
  InterfaceFormatSchema,
  type InterfaceFormat,
  type InterfaceFormatJsonObject,
  type InterfaceFormatJsonValue,
} from './schema.cts';

/**
 * 编辑用户接口格式时的**草稿 × 现有实体合并**（纯函数，无 IO）。
 *
 * 背景：编辑表单只能表达「提示词 / 模型 ID / 参数 / 素材位 / 固定请求头 / 固定查询参数 /
 * endpoint / method / Content-Type」这些规则。实体里还有表单表示不到的规则（`meta.*`、
 * 条件分支、额外固定头、顶层 `prompt` / `input` 回显等）——如果编辑时用「草稿重新合成」整体
 * 覆盖，那些规则会被静默删掉（例如 openai-image 的 generations/edits 分支、`body.image`
 * 条件分支、`Accept` 固定头）。本模块把两边合成一份：**表单可表示的部分以草稿为准，
 * 其余原样保留**。
 *
 * 安全边界：保留规则**只能来自服务端加载的现有实体**。客户端只提交草稿，不提交「要保留哪些
 * 规则」——否则客户端可以绕过草稿契约校验，把任意请求规则注入实体（包括任意请求头/地址）。
 *
 * 冲突一律返回可读错误，不静默丢弃：
 * - 保留规则与表单规则的 target 重叠（同一棵树/同一请求头写两次）；
 * - 保留规则引用的字段被删除（引用悬空）；
 * - 字段的发送位置被改到另一处，旧位置还留着按那个字段取值的规则。
 *
 * 参数身份：草稿没有独立的参数标识，合成器用 `p<序号>` 作内部字段键。为了让保留规则
 * （如 `meta.size`）在编辑后仍指向同一个参数，合并时按「落点 + 名称」把草稿参数与现有实体
 * 的参数对齐并复用旧字段键；对不上的（新增参数、改了发送位置）才用新键。
 */

export type MergeInterfaceFormatDraftResult =
  | { ok: true; format: InterfaceFormat }
  | { ok: false; errors: string[] };

const isPlainObject = (value: unknown): value is InterfaceFormatJsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** 读参数表里的字段键（数组形状不合法时返回空数组，交给实体 schema 拒绝）。 */
const readParameterFieldKeys = (format: InterfaceFormat): string[] => {
  const fields = format.parameters.schema.fields;
  if (!Array.isArray(fields)) return [];
  const keys: string[] = [];
  for (const field of fields) {
    if (!isPlainObject(field)) continue;
    if (typeof field.field_key === 'string' && field.field_key.length > 0) keys.push(field.field_key);
  }
  return keys;
};

/** 落点 + 名称的匹配签名（请求头大小写不敏感；请求体给完整路径）。 */
const wireSignature = (fact: FieldWireFact): string => {
  const name = fact.wire_location === 'header' ? normalizeHeaderName(fact.wire_name) : fact.wire_name;
  return `${fact.wire_location}:${name}`;
};

const remapFieldKey = (value: InterfaceFormatJsonValue, keyMap: ReadonlyMap<string, string>): InterfaceFormatJsonValue => {
  if (Array.isArray(value)) return value.map((item) => remapFieldKey(item, keyMap));
  if (!isPlainObject(value)) return value;
  if (value.kind === 'field' && typeof value.field_key === 'string') {
    const next = keyMap.get(value.field_key);
    return next === undefined ? value : { ...value, field_key: next };
  }
  const remapped: InterfaceFormatJsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    remapped[key] = remapFieldKey(child, keyMap);
  }
  return remapped;
};

/** 给新参数分配一个不与既有键冲突的内部键（`p<序号>` 优先，冲突时加后缀）。 */
const allocateParameterFieldKey = (index: number, used: ReadonlySet<string>): string => {
  const base = buildDraftParameterFieldKey(index);
  if (!used.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}_${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
};

/**
 * 按落点把草稿参数与现有实体参数对齐，返回「草稿字段键 → 应使用的字段键」。
 *
 * 对齐只影响参数身份（保留规则里的 `field_key` 引用），不改变参数的发到哪里：
 * 落点来自草稿，名称来自草稿。匹配不上的参数使用新键。
 */
const buildParameterFieldKeyMap = (
  synthesized: InterfaceFormat,
  existing: InterfaceFormat,
): Map<string, string> => {
  const draftKeys = readParameterFieldKeys(synthesized);
  if (draftKeys.length === 0) return new Map();
  const existingKeys = readParameterFieldKeys(existing);
  const existingKeySet = new Set(existingKeys);
  const draftFacts = collectWireNamesByFieldKey(synthesized.transport.payload_rules);
  const existingFacts = collectWireNamesByFieldKey(existing.transport.payload_rules);
  const existingKeyBySignature = new Map<string, string>();
  for (const key of existingKeys) {
    const fact = existingFacts.get(key);
    if (fact === undefined) continue;
    const signature = wireSignature(fact);
    if (!existingKeyBySignature.has(signature)) existingKeyBySignature.set(signature, key);
  }

  const used = new Set<string>();
  const keyMap = new Map<string, string>();
  draftKeys.forEach((draftKey, index) => {
    const fact = draftFacts.get(draftKey);
    const matched = fact === undefined ? undefined : existingKeyBySignature.get(wireSignature(fact));
    let nextKey: string;
    if (matched !== undefined && !used.has(matched) && existingKeySet.has(matched)) {
      nextKey = matched;
    } else {
      nextKey = allocateParameterFieldKey(index, new Set([...used, ...existingKeySet]));
    }
    used.add(nextKey);
    if (nextKey !== draftKey) keyMap.set(draftKey, nextKey);
  });
  return keyMap;
};

/** 把参数身份重映射应用到新合成的实体上（字段表 / 默认值表 / 必填表 / 请求规则）。 */
const applyParameterFieldKeyMap = (
  format: InterfaceFormat,
  keyMap: ReadonlyMap<string, string>,
): InterfaceFormat => {
  if (keyMap.size === 0) return format;
  const fields = format.parameters.schema.fields;
  const remappedFields = Array.isArray(fields)
    ? fields.map((field) => {
        if (!isPlainObject(field)) return field;
        const key = field.field_key;
        if (typeof key !== 'string') return field;
        const next = keyMap.get(key);
        return next === undefined ? field : { ...field, field_key: next };
      })
    : fields;
  const requiredFields = format.parameters.schema.required_fields;
  const remappedRequired = Array.isArray(requiredFields)
    ? requiredFields.map((item) => (typeof item === 'string' ? keyMap.get(item) ?? item : item))
    : requiredFields;
  const defaults: InterfaceFormatJsonObject = {};
  for (const [key, value] of Object.entries(format.parameters.defaults)) {
    defaults[keyMap.get(key) ?? key] = value;
  }
  return {
    ...format,
    parameters: {
      ...format.parameters,
      schema: {
        ...format.parameters.schema,
        ...(remappedFields === undefined ? {} : { fields: remappedFields }),
        ...(remappedRequired === undefined ? {} : { required_fields: remappedRequired }),
      },
      defaults,
    },
    transport: {
      ...format.transport,
      payload_rules: remapFieldKey(
        format.transport.payload_rules,
        keyMap,
      ) as InterfaceFormatJsonObject,
    },
  };
};

/** 表单能表达的一条规则：请求体/查询参数/请求头的字段规则、固定线路常量、模型 ID 字面量。 */
const isSimpleLiteral = (rule: InterfaceFormatJsonValue): boolean =>
  isPlainObject(rule) && rule.kind === 'literal';

const isFormManagedRule = (
  target: string,
  rule: InterfaceFormatJsonValue,
): boolean => {
  const parsed = parseInterfaceFormatRuleTarget(target);
  switch (parsed.kind) {
    case 'api_endpoint':
    case 'api_method':
    case 'api_content_type':
      // 提交配置（地址 / 方法 / Content-Type）归表单；条件形态（如按素材位切换分支）
      // 不是表单能表达的，原样保留。
      return isSimpleLiteral(rule);
    case 'query':
    case 'header':
      // 固定头 / 固定查询参数在表单里就是一条「名称 = 值」；复杂规则（条件、取值表达式）
      // 表不达，保留。
      return isPlainObject(rule) && rule.kind === 'literal' && typeof rule.value === 'string';
    case 'body_field':
    case 'body_text': {
      if (!isPlainObject(rule)) return false;
      // 参数 / 素材位 / 提示词的字段规则由表单（及对方的分支规则）表达。
      if (rule.kind === 'field' && typeof rule.field_key === 'string') return true;
      // 模型 ID：表单可表达「发或不发、发在哪里」。
      return rule.kind === 'literal' && rule.value === '{{model_id}}';
    }
    case 'meta':
    case 'other':
      return false;
  }
};

const describeTarget = (target: string): string => {
  const parsed = parseInterfaceFormatRuleTarget(target);
  if (parsed.kind === 'body_field') return `请求体字段「${parsed.path}」`;
  if (parsed.kind === 'body_text') return '请求体正文';
  if (parsed.kind === 'query') return `查询参数「${parsed.name}」`;
  if (parsed.kind === 'header') return `请求头「${parsed.name}」`;
  if (parsed.kind === 'meta') return `面板字段「${parsed.path}」`;
  return `「${target}」`;
};

const targetsOverlap = (left: string, right: string): boolean => {
  if (left === right) return true;
  const leftParsed = parseInterfaceFormatRuleTarget(left);
  const rightParsed = parseInterfaceFormatRuleTarget(right);
  const leftIsBody = leftParsed.kind === 'body_field' || leftParsed.kind === 'body_text';
  const rightIsBody = rightParsed.kind === 'body_field' || rightParsed.kind === 'body_text';
  if (leftIsBody && rightIsBody) {
    if (leftParsed.kind === 'body_text' || rightParsed.kind === 'body_text') return true;
    return interfaceFormatBodyPathsOverlap(leftParsed.path, rightParsed.path);
  }
  if (leftParsed.kind === 'query' && rightParsed.kind === 'query') return leftParsed.name === rightParsed.name;
  if (leftParsed.kind === 'header' && rightParsed.kind === 'header') {
    return normalizeHeaderName(leftParsed.name) === normalizeHeaderName(rightParsed.name);
  }
  return false;
};

/** 字段键 → 可读显示名（错误文案用；解析不到回退内部键名）。 */
const displayNameOfFieldKey = (
  fieldKey: string,
  existing: InterfaceFormat,
  draft: CustomInterfaceFormatDraft,
): string => {
  const fields = existing.parameters.schema.fields;
  if (Array.isArray(fields)) {
    for (const field of fields) {
      if (!isPlainObject(field) || field.field_key !== fieldKey) continue;
      const labelKey = typeof field.label === 'string' ? field.label : null;
      const label = labelKey === null ? null : resolveLocaleText(existing.localization['zh-CN'], labelKey);
      return label ?? fieldKey;
    }
  }
  // 素材位字段不在参数表里（合成期由 media.slots + fragments 注入），按位标识找文案。
  for (const [slotId, slot] of Object.entries(existing.media.slots)) {
    if (slot.field_key !== fieldKey) continue;
    const label = resolveLocaleText(existing.localization['zh-CN'], `fields.media_${slotId}.label`);
    return label ?? fieldKey;
  }
  const parameter = draft.parameters.find(
    (item, index) => buildDraftParameterFieldKey(index) === fieldKey,
  );
  return parameter?.label ?? fieldKey;
};

/**
 * 合并草稿实体与现有实体，返回最终要保存的实体。
 *
 * `synthesized` 必须是由同一份草稿调用 `buildInterfaceFormatFromDraft` 得到的实体（路由只做
 * 一次合成，合并复用其产物，避免「校验用一份、写入用另一份」）。
 */
export const mergeInterfaceFormatDraft = (input: {
  existing: InterfaceFormat;
  draft: CustomInterfaceFormatDraft;
  synthesized: InterfaceFormat;
}): MergeInterfaceFormatDraftResult => {
  const { existing, draft, synthesized } = input;
  const keyMap = buildParameterFieldKeyMap(synthesized, existing);
  const fresh = applyParameterFieldKeyMap(cloneJsonValue(synthesized), keyMap);
  const freshRules = fresh.transport.payload_rules;

  const draftParameterKeys = readParameterFieldKeys(fresh);
  const mediaFieldKeys = draft.media_slots.map((slot) => slot.field_key);
  const promptFieldKey = fresh.parameters.prompt_field.field_key;
  const draftFieldKeys = new Set<string>([...draftParameterKeys, ...mediaFieldKeys, promptFieldKey]);

  // 表单可表达的规则由草稿重新生成；表单表示不到的原样保留（条件分支 / meta / 顶层回显 /
  // 额外固定头 / 请求体字面量等）。复杂规则占据同一个 target 时以它为准：它是作者写下的
  // 真实请求语义，表单没有能力表达它（例如 openai-image 的 api.endpoint 条件与 body.image 分支）。
  const preserved: Array<{ target: string; rule: InterfaceFormatJsonValue }> = [];
  for (const [target, rule] of Object.entries(existing.transport.payload_rules)) {
    if (isFormManagedRule(target, rule)) continue;
    preserved.push({ target, rule });
  }

  const errors: string[] = [];
  const mergedRules: InterfaceFormatJsonObject = { ...freshRules };
  for (const entry of preserved) {
    mergedRules[entry.target] = entry.rule;
  }

  // ① 引用悬空：保留规则引用的字段必须仍存在于草稿里（被删掉的字段不能留下悬空引用）。
  const danglingKeys = new Set<string>();
  for (const entry of preserved) {
    for (const reference of collectPayloadRuleFieldReferences(entry.rule)) {
      if (draftFieldKeys.has(reference.field_key)) continue;
      danglingKeys.add(reference.field_key);
    }
  }
  for (const key of danglingKeys) {
    const shownName = displayNameOfFieldKey(key, existing, draft);
    errors.push(`参数「${shownName}」已经删掉了，但还有请求规则在用它。请先处理那条规则，或者把参数加回来再保存。`);
  }

  // ② 落点改变：字段换到另一个位置后，旧位置留下的「只取这个字段」的规则会变成隐藏的第二次发送。
  const freshFactByFieldKey = collectWireNamesByFieldKey(freshRules);
  for (const entry of preserved) {
    const parsed = parseInterfaceFormatRuleTarget(entry.target);
    if (parsed.kind !== 'body_field' && parsed.kind !== 'body_text' && parsed.kind !== 'query' && parsed.kind !== 'header') {
      continue;
    }
    const owner = ownedFieldKeyOfRule(entry.rule);
    if (owner === null || !draftFieldKeys.has(owner)) continue;
    const fact = freshFactByFieldKey.get(owner);
    if (fact === undefined) continue;
    const same =
      parsed.kind === 'body_field' && fact.wire_location === 'body'
        ? parsed.path === fact.wire_name
        : parsed.kind === 'query' && fact.wire_location === 'query'
          ? parsed.name === fact.wire_name
          : parsed.kind === 'header' && fact.wire_location === 'header'
            ? normalizeHeaderName(parsed.name) === normalizeHeaderName(fact.wire_name)
            : false;
    if (!same) {
      const shownName = displayNameOfFieldKey(owner, existing, draft);
      errors.push(
        `参数「${shownName}」的发送位置改了，但${describeTarget(entry.target)}上还有一条按旧位置发送的规则。请先处理那条规则再保存。`,
      );
    }
  }

  // ③ 位置重叠：两条规则写到同一处（请求体祖孙路径 / 同名查询参数 / 同名请求头）。
  //
  // 先处理「同一个 target」这一种：请求体 / 端点 / Content-Type 上的条件规则优先保留（表单
  // 没有能力表达它们，openai-image 的 generations/edits 分支与 body.image 分支就是这种形态）；
  // 但固定请求头、固定查询参数与请求方法上出现条件规则时，表单填的值会被静默忽略，必须拒绝。
  const preservedTargets = new Set(preserved.map((entry) => entry.target));
  for (const entry of preserved) {
    if (!Object.prototype.hasOwnProperty.call(freshRules, entry.target)) continue;
    const parsed = parseInterfaceFormatRuleTarget(entry.target);
    if (parsed.kind === 'query' || parsed.kind === 'header' || parsed.kind === 'api_method') {
      errors.push(
        `表单里的${describeTarget(entry.target)}已经有一条条件规则在控制它，固定值不会生效。请先处理那条规则再保存。`,
      );
    }
  }

  // 提交地址 / Content-Type 由条件规则控制时，表单改的这两项不会生效——必须拦住保存。
  // 只有表单这一项**没改**时才允许继续保留条件规则（普通参数编辑仍可成功）。
  if (preservedTargets.has('api.endpoint')) {
    const existingSubmitPath =
      existing.transport.endpoints[existing.transport.submit.endpoint_key];
    const freshSubmitPath = fresh.transport.endpoints[fresh.transport.submit.endpoint_key];
    if (existingSubmitPath === undefined || freshSubmitPath === undefined) {
      loggingModule.logDebug('[interface-format/draft-merge] submit endpoint path unresolved', {
        formatId: existing.format_id,
        existingEndpointKey: existing.transport.submit.endpoint_key,
        freshEndpointKey: fresh.transport.submit.endpoint_key,
      });
      errors.push(
        '这个格式的提交地址由条件规则控制，无法确认表单里的地址是否生效。请新建一份格式再修改地址。',
      );
    } else if (existingSubmitPath !== freshSubmitPath) {
      errors.push(
        '这个格式的提交地址由条件规则控制，表单里改提交地址不会生效。请先处理那条条件规则，或新建一份格式。',
      );
    }
  }
  if (preservedTargets.has('api.contentType')) {
    const existingContentType = existing.transport.submit.content_type;
    const freshContentType = fresh.transport.submit.content_type;
    if (
      existing.transport.submit.payload_format !== fresh.transport.submit.payload_format ||
      existingContentType !== freshContentType
    ) {
      errors.push(
        '这个格式的请求体形态由条件规则控制，表单里改数据格式或 Content-Type 不会生效。请先处理那条条件规则，或新建一份格式。',
      );
    }
  }

  if (errors.length === 0) {
    const ruleKeys = Object.keys(mergedRules);
    for (const preservedEntry of preserved) {
      let overlapped = false;
      for (const otherKey of ruleKeys) {
        if (otherKey === preservedEntry.target) continue;
        if (!targetsOverlap(preservedEntry.target, otherKey)) continue;
        errors.push(
          `保存后会有两条请求规则写到同一个位置（${describeTarget(preservedEntry.target)} 与 ${describeTarget(otherKey)}）。请先调整参数或那条规则。`,
        );
        overlapped = true;
        break;
      }
      if (overlapped) break;
    }
  }

  if (errors.length > 0) {
    loggingModule.logDebug('[interface-format/draft-merge] merge refused', {
      formatId: existing.format_id,
      errors,
      preservedTargets: preserved.map((entry) => entry.target),
    });
    return { ok: false, errors };
  }

  const candidate: InterfaceFormat = {
    ...fresh,
    transport: {
      ...fresh.transport,
      // 端点表：草稿只声明提交地址（键固定为 `submit`），但保留的请求规则可能引用源格式的
      // 其它端点键（openai-image 的 generations / edits）。把两边合并，草稿的 `submit` 覆盖
      // 同键旧值，其余端点原样保留——否则保留规则里的 `{{endpoint:edits}}` 会在合成期解析失败。
      endpoints: { ...existing.transport.endpoints, ...fresh.transport.endpoints },
      submit: {
        ...fresh.transport.submit,
        // 提交响应里的任务标识路径与条件请求体形态不是表单字段；源格式声明了、草稿没声明时
        // 原样保留（复制保真在编辑后仍然成立）。
        ...(fresh.transport.submit.response_id_path === undefined &&
        existing.transport.submit.response_id_path !== undefined
          ? { response_id_path: existing.transport.submit.response_id_path }
          : {}),
        ...(fresh.transport.submit.payload_format_rule === undefined &&
        existing.transport.submit.payload_format_rule !== undefined
          ? { payload_format_rule: existing.transport.submit.payload_format_rule }
          : {}),
      },
      payload_rules: mergedRules,
    },
  };
  const parsed = InterfaceFormatSchema.safeParse(candidate);
  if (!parsed.success) {
    loggingModule.logDebug('[interface-format/draft-merge] merged entity failed schema validation', {
      formatId: existing.format_id,
      issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    });
    return {
      ok: false,
      errors: ['保留的请求规则和这次修改放在一起后不再成立，请检查发送位置后重试。'],
    };
  }
  return { ok: true, format: parsed.data };
};
