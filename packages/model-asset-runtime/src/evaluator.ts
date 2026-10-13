import type {
  ModelAssetNodeProjectionRuntimeAssertArrayLengthOptions,
  ModelAssetNodeProjectionRuntimeAssertNonEmptyOptions,
  ModelAssetNodeProjectionRuntimeClampNumberOptions,
  ModelAssetNodeProjectionRuntimeComputeOperator,
  ModelAssetNodeProjectionRuntimeMapArrayOptions,
  ModelAssetNodeProjectionRuntimeNormalizeEnumOptions,
  ModelAssetNodeProjectionRuntimeParseLinePairsOptions,
  ModelAssetNodeProjectionRuntimeScaleNumberOptions,
  ModelAssetMediaTargetShape,
  ModelAssetNodeProjectionRuntimeValueRule,
} from '@iart/contracts/model-asset-contract';
import type { ModelAssetRuntimeValueTransform } from './index';
import {
  applyRoundMode,
  cloneRuntimeValue,
  compactRuntimeArray,
  compactRuntimeObject,
  evaluateRuntimeCondition,
  isEmptyRuntimeValue,
  normalizeRoundMode,
  normalizeShotListValue,
  readRuntimeField,
  readRuntimePath,
  timelineToNarrative,
  toNumberOrUndefined,
  type ModelAssetRuntimeEvaluationContext,
  type ModelAssetRuntimeRecord,
} from './runtime-utils';

export type ModelAssetRuntimeComputeOperator = ModelAssetNodeProjectionRuntimeComputeOperator;

export interface ModelAssetRuntimeEvaluationOptionsExtra {
  uploadOptions: unknown | undefined;
  preRequestOutputs: Record<string, Record<string, unknown>> | undefined;
}

export interface ModelAssetRuntimeEvaluationOptions<
  TContext extends ModelAssetRuntimeEvaluationContext = ModelAssetRuntimeEvaluationContext,
  TExtra extends ModelAssetRuntimeEvaluationOptionsExtra = ModelAssetRuntimeEvaluationOptionsExtra,
> {
  item: unknown | undefined | undefined;
  targetPath: string | undefined | undefined;
  mediaTarget: ModelAssetMediaTargetShape | undefined | undefined;
  extra: TExtra | undefined | undefined;
  transformHandlers: Partial<
    Record<
      ModelAssetRuntimeValueTransform,
      (params: ModelAssetRuntimeTransformHandlerParams<TContext, TExtra>) => Promise<unknown> | unknown
    >
  > | undefined | undefined;
  operatorHandlers: Partial<
    Record<
      ModelAssetRuntimeComputeOperator,
      (params: ModelAssetRuntimeOperatorHandlerParams<TContext, TExtra>) => Promise<unknown> | unknown
    >
  > | undefined | undefined;
  createError: ((message: string) => Error) | undefined | undefined;
}

export interface ModelAssetRuntimeTransformHandlerParams<
  TContext extends ModelAssetRuntimeEvaluationContext = ModelAssetRuntimeEvaluationContext,
  TExtra extends ModelAssetRuntimeEvaluationOptionsExtra = ModelAssetRuntimeEvaluationOptionsExtra,
> {
  value: unknown;
  transform: ModelAssetRuntimeValueTransform;
  context: TContext;
  options: ModelAssetRuntimeEvaluationOptions<TContext, TExtra>;
  applyTransform: (
    value: unknown,
    transform: ModelAssetRuntimeValueTransform,
    nextOptions: ModelAssetRuntimeEvaluationOptions<TContext, TExtra> | undefined,
  ) => Promise<unknown>;
}

export interface ModelAssetRuntimeOperatorHandlerParams<
  TContext extends ModelAssetRuntimeEvaluationContext = ModelAssetRuntimeEvaluationContext,
  TExtra extends ModelAssetRuntimeEvaluationOptionsExtra = ModelAssetRuntimeEvaluationOptionsExtra,
> {
  rule: Extract<ModelAssetNodeProjectionRuntimeValueRule, { kind: 'compute' }>;
  operator: ModelAssetRuntimeComputeOperator;
  context: TContext;
  options: ModelAssetRuntimeEvaluationOptions<TContext, TExtra>;
  evaluateRule: (
    rule: ModelAssetNodeProjectionRuntimeValueRule | undefined,
    nextOptions: ModelAssetRuntimeEvaluationOptions<TContext, TExtra> | undefined,
  ) => Promise<unknown>;
}

const normalizeRuntimeString = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const createRuntimeError = <
  TContext extends ModelAssetRuntimeEvaluationContext,
  TExtra extends ModelAssetRuntimeEvaluationOptionsExtra,
>(
  message: string,
  options: ModelAssetRuntimeEvaluationOptions<TContext, TExtra>,
): Error => (options.createError ? options.createError(message) : new Error(message));

const applyRuntimeTransform = async <
  TContext extends ModelAssetRuntimeEvaluationContext,
  TExtra extends ModelAssetRuntimeEvaluationOptionsExtra,
>(
  value: unknown,
  transform: ModelAssetRuntimeValueTransform,
  context: TContext,
  options: ModelAssetRuntimeEvaluationOptions<TContext, TExtra>,
): Promise<unknown> => {
  const handler = (options.transformHandlers !== null && options.transformHandlers !== undefined ? options.transformHandlers[transform] : undefined);
  if (handler) {
    return handler({
      value,
      transform,
      context,
      options,
      applyTransform: (nextValue, nextTransform, nextOptions) =>
        applyRuntimeTransform(nextValue, nextTransform, context, { ...options, ...nextOptions }),
    });
  }

  if (transform === 'trim') return typeof value === 'string' ? value.trim() : value;
  if (transform === 'toLowerCase') return typeof value === 'string' ? value.toLowerCase() : value;
  if (transform === 'toUpperCase') return typeof value === 'string' ? value.toUpperCase() : value;
  if (transform === 'toNumber') {
    if (value === undefined || value === null || value === '') return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (transform === 'ensureArray') {
    if (Array.isArray(value)) return value;
    if (value === undefined || value === null || value === '') return [];
    return [value];
  }
  if (transform === 'first') return Array.isArray(value) ? value[0] : value;
  if (transform === 'last') return Array.isArray(value) ? value[value.length - 1] : value;
  if (transform === 'compactArray') return compactRuntimeArray(value);
  if (transform === 'splitLines') {
    if (typeof value !== 'string') return [];
    return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  }
  if (transform === 'extractFirstUrl' || transform === 'extractFirstFile' || transform === 'firstUploadFile' || transform === 'firstUploadFileOrUrl') {
    const urls = await applyRuntimeTransform(value, 'extractUrls', context, options);
    return Array.isArray(urls) ? urls[0] : undefined;
  }
  if (transform === 'allUploadFiles') return applyRuntimeTransform(value, 'extractUrls', context, options);
  if (transform === 'shotListToTimeline') return normalizeShotListValue(value);
  if (transform === 'timelineToScript') return timelineToNarrative(value);

  throw createRuntimeError(`Unsupported model payload transform: ${transform}`, options);
};

const applyRuntimeTransforms = async <
  TContext extends ModelAssetRuntimeEvaluationContext,
  TExtra extends ModelAssetRuntimeEvaluationOptionsExtra,
>(
  value: unknown,
  transforms: readonly ModelAssetRuntimeValueTransform[] | undefined,
  context: TContext,
  options: ModelAssetRuntimeEvaluationOptions<TContext, TExtra>,
): Promise<unknown> => {
  let current = value;
  for (const transform of transforms ?? []) {
    current = await applyRuntimeTransform(current, transform, context, options);
  }
  return current;
};

const toRuntimeArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];

const toRuntimeArraySegment = (value: unknown, skipIfEmpty: boolean): unknown[] => {
  const sourceItems = Array.isArray(value) ? value : [value];
  const items = sourceItems.flatMap((item): unknown[] => (Array.isArray(item) ? item : [item]));
  return skipIfEmpty ? items.filter((item) => !isEmptyRuntimeValue(item)) : items;
};

const parseLinePairs = (
  rawValue: unknown,
  options: ModelAssetNodeProjectionRuntimeParseLinePairsOptions,
  createError: (message: string) => Error,
): ModelAssetRuntimeRecord[] => {
  const lines = (typeof rawValue === 'string' ? rawValue : '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) throw createError(normalizeRuntimeString(options.message) || '至少需要 1 条结构化配置。');

  const delimiter = normalizeRuntimeString(options.pair_delimiter) || '|';
  const leftKey = normalizeRuntimeString(options.left_key);
  const rightKey = normalizeRuntimeString(options.right_key);
  return lines.map((line, index) => {
    const separatorIndex = line.indexOf(delimiter);
    if (separatorIndex < 0) throw createError(`第 ${index + 1} 条配置缺少分隔符 ${delimiter}。`);
    const left = line.slice(0, separatorIndex).trim();
    const right = line.slice(separatorIndex + delimiter.length).trim();
    if (!left || !right) throw createError(`第 ${index + 1} 条配置不完整。`);
    return { [leftKey]: left, [rightKey]: right };
  });
};

export const evaluateRuntimeValueRule = async <
  TContext extends ModelAssetRuntimeEvaluationContext,
  TExtra extends ModelAssetRuntimeEvaluationOptionsExtra = ModelAssetRuntimeEvaluationOptionsExtra,
>(
  rule: ModelAssetNodeProjectionRuntimeValueRule | undefined,
  context: TContext,
  options: ModelAssetRuntimeEvaluationOptions<TContext, TExtra> = { item: undefined, targetPath: undefined, mediaTarget: undefined, extra: undefined, transformHandlers: undefined, operatorHandlers: undefined, createError: undefined },
): Promise<unknown> => {
  if (!rule) return undefined;
  if (rule.kind === 'literal') return cloneRuntimeValue(rule.value);

  if (rule.kind === 'field') {
    const raw = readRuntimeField(context.fields, normalizeRuntimeString(rule.field_key));
    const transformed = await applyRuntimeTransforms(raw, rule.transforms, context, {
      ...options,
      mediaTarget: rule.media_target,
    });
    if (transformed === undefined && rule.fallback) return evaluateRuntimeValueRule(rule.fallback, context, options);
    return transformed;
  }

  if (rule.kind === 'item') {
    const item = options.item ?? context.currentItem;
    return rule.path ? readRuntimePath(item, rule.path) : item;
  }

  if (rule.kind === 'when') {
    const passes = await evaluateRuntimeCondition(rule.condition, context);
    return evaluateRuntimeValueRule(passes ? rule.truthy : rule.falsy, context, options);
  }

  if (rule.kind === 'pre_request_output') {
    const extraRecord = (options.extra !== null && options.extra !== undefined)
      ? options.extra as Record<string, unknown>
      : undefined;
    const preRequestOutputs = (extraRecord !== undefined && extraRecord !== null)
      ? extraRecord['preRequestOutputs'] as Record<string, Record<string, unknown>> | undefined
      : undefined;
    if (preRequestOutputs === undefined || preRequestOutputs === null) {
      return undefined;
    }
    const entry = preRequestOutputs[rule.pre_request_id];
    if (entry === undefined || entry === null) {
      return undefined;
    }
    return entry[rule.output_key];
  }

  if (rule.kind !== 'compute') return undefined;

  const operator = rule.operator;
  const evaluateRule = (
    nestedRule: ModelAssetNodeProjectionRuntimeValueRule | undefined,
    nextOptions: ModelAssetRuntimeEvaluationOptions<TContext, TExtra> | undefined,
  ) => evaluateRuntimeValueRule(nestedRule, context, {
    ...options,
    mediaTarget: rule.media_target,
    ...nextOptions,
  });
  const ruleOptions = { ...options, mediaTarget: rule.media_target };
  const operatorHandler = (options.operatorHandlers !== null && options.operatorHandlers !== undefined ? options.operatorHandlers[operator] : undefined);
  if (operatorHandler) return operatorHandler({ rule, operator, context, options: ruleOptions, evaluateRule });

  if (operator === 'coalesce') {
    for (const arg of rule.args ?? []) {
      const value = await evaluateRule(arg, undefined);
      if (!isEmptyRuntimeValue(value)) return value;
    }
    return undefined;
  }
  if (operator === 'concat') {
    const values = await Promise.all((rule.args ?? []).map((item) => evaluateRule(item, undefined)));
    return values.filter((item) => item !== undefined && item !== null).map((item) => String(item)).join('');
  }
  if (operator === 'join') {
    const values = await Promise.all((rule.args ?? []).map((item) => evaluateRule(item, undefined)));
    return values.flatMap((item): unknown[] => (Array.isArray(item) ? item : [item]))
      .filter((item) => !isEmptyRuntimeValue(item)).map((item) => String(item))
      .join(normalizeRuntimeString(rule.delimiter));
  }
  if (operator === 'array' || operator === 'compact_array') {
    const values = await Promise.all((rule.args ?? []).map((item) => evaluateRule(item, undefined)));
    return operator === 'compact_array' ? compactRuntimeArray(values) : values;
  }
  if (operator === 'object' || operator === 'compact_object') {
    const ruleEntries = (rule.entries ?? {}) as Record<string, ModelAssetNodeProjectionRuntimeValueRule>;
    const evaluatedEntries = await Promise.all(
      Object.entries(ruleEntries).map(async ([key, entry]): Promise<[string, unknown]> => [
        key,
        await evaluateRule(entry, undefined),
      ]),
    );
    const value: ModelAssetRuntimeRecord = Object.fromEntries(evaluatedEntries);
    return operator === 'compact_object' ? compactRuntimeObject(value) : value;
  }
  if (operator === 'normalize_enum') {
    const [currentValue] = await Promise.all((rule.args ?? []).map((item) => evaluateRule(item, undefined)));
    const opts = rule.options as ModelAssetNodeProjectionRuntimeNormalizeEnumOptions;
    return opts.allowed_values.includes(currentValue as string | number | boolean) ? currentValue : opts.fallback;
  }
  if (operator === 'assert_non_empty') {
    const [currentValue] = await Promise.all((rule.args ?? []).map((item) => evaluateRule(item, undefined)));
    if (isEmptyRuntimeValue(currentValue)) {
      const opts = (rule.options ?? {}) as ModelAssetNodeProjectionRuntimeAssertNonEmptyOptions;
      throw createRuntimeError(normalizeRuntimeString(opts.message) || 'Required field missing', options);
    }
    return currentValue;
  }
  if (operator === 'assert_array_length') {
    const [currentValue] = await Promise.all((rule.args ?? []).map((item) => evaluateRule(item, undefined)));
    const items = toRuntimeArray(currentValue).filter((item) => !isEmptyRuntimeValue(item));
    const opts = rule.options as ModelAssetNodeProjectionRuntimeAssertArrayLengthOptions;
    if (typeof opts.min_items === 'number' && items.length < opts.min_items) {
      throw createRuntimeError(normalizeRuntimeString(opts.message) || `至少需要 ${opts.min_items} 项。`, options);
    }
    if (typeof opts.max_items === 'number' && items.length > opts.max_items) {
      throw createRuntimeError(normalizeRuntimeString(opts.message) || `最多允许 ${opts.max_items} 项。`, options);
    }
    return currentValue;
  }
  if (operator === 'parse_line_pairs') {
    const [currentValue] = await Promise.all((rule.args ?? []).map((item) => evaluateRule(item, undefined)));
    return parseLinePairs(currentValue, rule.options, (message) => createRuntimeError(message, options));
  }
  if (operator === 'scale_number' || operator === 'clamp_number') {
    const [currentValue] = await Promise.all((rule.args ?? []).map((item) => evaluateRule(item, undefined)));
    const numeric = toNumberOrUndefined(currentValue);
    if (numeric === undefined) return undefined;
    if (operator === 'scale_number') {
      const opts = rule.options as ModelAssetNodeProjectionRuntimeScaleNumberOptions;
      const factor = toNumberOrUndefined(opts.factor);
      return factor === undefined ? undefined : applyRoundMode(numeric * factor, normalizeRoundMode(opts.round));
    }
    const opts = rule.options as ModelAssetNodeProjectionRuntimeClampNumberOptions;
    let next = numeric;
    const min = toNumberOrUndefined(opts.min);
    const max = toNumberOrUndefined(opts.max);
    if (typeof min === 'number') next = Math.max(min, next);
    if (typeof max === 'number') next = Math.min(max, next);
    return applyRoundMode(next, normalizeRoundMode(opts.round));
  }
  if (operator === 'map_array') {
    const opts = rule.options as ModelAssetNodeProjectionRuntimeMapArrayOptions;
    const sourceItems = toRuntimeArray(await evaluateRule(opts.source, undefined));
    const limit = toNumberOrUndefined(opts.max_items);
    const skipIfEmpty = opts.skip_if_empty === true;
    const result: unknown[] = [];
    for (const prependRule of opts.prepend ?? []) result.push(...toRuntimeArraySegment(await evaluateRule(prependRule, undefined), skipIfEmpty));
    for (const item of sourceItems.slice(0, limit ?? sourceItems.length)) result.push(...toRuntimeArraySegment(await evaluateRule(opts.item, { item, targetPath: undefined, mediaTarget: undefined, extra: undefined, transformHandlers: undefined, operatorHandlers: undefined, createError: undefined }), skipIfEmpty));
    for (const appendRule of opts.append ?? []) result.push(...toRuntimeArraySegment(await evaluateRule(appendRule, undefined), skipIfEmpty));
    return result.length === 0 && skipIfEmpty ? undefined : result;
  }

  throw createRuntimeError(`Unsupported model payload operator: ${operator || '(empty)'}`, options);
};
