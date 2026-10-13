import {
  compute,
  literal,
  type SchemaComputedValue,
  type SchemaCondition,
  type SchemaFieldEventHandler,
  type SchemaImageUploadField,
  type SchemaSelectField,
  type SchemaTextareaField,
} from "@/features/workspace/schema/types";
import type { ImageResizeMode, ImageValidationConstraints } from '@iart/contracts/media/imageValidationTypes';

import type { DynamicRecord } from '@/client/utils/typeGuards';

const DEFAULT_SELECT_LAYOUT = {
  colSpan: 1,
  align: undefined,
  sticky: undefined,
  dockPresentation: undefined,
  dockSummaryTemplate: undefined,
} as const;

const createFieldPatch = <K extends string, V>(key: K, value: V): Partial<Record<K, V>> =>
  Object.fromEntries([[key, value]]) as Partial<Record<K, V>>;

/**
 * 静态选项的类型定义。
 */
export type StaticSelectOption = {
  value: string;
  labelKey: string;
  descriptionKey: string | undefined;
  labelParams: DynamicRecord | undefined;
};

/**
 * 安全地解引用可能为 null/undefined 的 opts 对象的属性。
 */
const getOpt = <T, K extends keyof T>(opts: T | null | undefined, key: K): T[K] | undefined =>
  (opts !== null && opts !== undefined) ? opts[key] : undefined;

/**
 * 创建一个通用的 Prompt 文本域字段。
 *
 * 默认行为：
 * - 使用 textarea 类型
 * - 最小行数 2、最大行数 3
 * - 默认必填（required = true）
 */
export const createPromptField = <K extends string>(
  key: K,
  opts: {
    labelKey: string | undefined;
    placeholderKey: string | undefined;
    required: boolean | undefined;
    minRows: number | undefined;
  } | undefined
): SchemaTextareaField<K> => ({
  key,
  type: "textarea",
  labelKey: getOpt(opts, 'labelKey'),
  helperTextKey: undefined,
  helperTextParams: undefined,
  placeholderKey: getOpt(opts, 'placeholderKey'),
  tooltipKey: undefined,
  descriptionKey: undefined,
  layout: undefined,
  visibleWhen: undefined,
  disabledWhen: undefined,
  required: getOpt(opts, 'required') ?? true,
  requiredWhen: undefined,
  validation: undefined,
  events: undefined,
  metadata: undefined,
  defaultValue: undefined,
  className: undefined,
  sx: undefined,
  minRows: getOpt(opts, 'minRows') ?? 2,
  maxRows: 3,
  autoResize: undefined,
  showCounter: undefined,
});

/**
 * 创建一个通用的"模型选择"下拉字段。
 *
 * 特性：
 * - 预置 layout.colSpan = 1
 * - 通过传入的 models 参数构建静态选项
 * - 可选默认值与 onChange 事件
 */
export const createModelSelectField = <K extends string>(
  key: K,
  models: Array<{
    value: string;
    labelKey: string;
    descriptionKey: string | undefined;
    visible: boolean | undefined;
  }>,
  opts: {
    defaultValue: string | undefined;
    onChange: SchemaFieldEventHandler<K> | undefined;
  } | undefined
): SchemaSelectField<K> => ({
  key,
  type: "select",
  labelKey: undefined,
  helperTextKey: undefined,
  helperTextParams: undefined,
  placeholderKey: undefined,
  tooltipKey: undefined,
  descriptionKey: undefined,
  layout: DEFAULT_SELECT_LAYOUT,
  visibleWhen: undefined,
  disabledWhen: undefined,
  required: undefined,
  requiredWhen: undefined,
  validation: undefined,
  metadata: undefined,
  defaultValue: getOpt(opts, 'defaultValue'),
  className: undefined,
  sx: undefined,
  options: {
    kind: "static",
    options: models
      .filter((model) => model.visible !== false)
      .map((model) => ({
        value: model.value,
        labelKey: model.labelKey,
        descriptionKey: model.descriptionKey,
        labelParams: undefined,
        helperKey: undefined,
        disabledWhen: undefined,
        icon: undefined,
        groupKey: undefined,
      })),
  },
  multiple: undefined,
  renderValueKey: undefined,
  clearable: undefined,
  events: getOpt(opts, 'onChange')
    ? [
        {
          kind: "change",
          when: undefined,
          handler: getOpt(opts, 'onChange') as SchemaFieldEventHandler<K>,
        },
      ]
    : undefined,
});

/**
 * 创建一个"时长选择"下拉字段,并自动附加归一化（ensureDuration）事件。
 *
 * 特性：
 * - 预置 layout.colSpan = 1
 * - 使用传入 durations 构建静态选项
 * - 默认值为 opts.defaultValue 或 durations[0]
 * - onChange 时会将任意输入归一化为允许列表中的值
 * - labelKeyTemplate 若提供,将作为所有选项的 labelKey,并注入 { seconds } 参数
 */
export const createDurationField = <K extends string>(
  key: K,
  durations: number[],
  opts: {
    labelKeyTemplate: string | undefined;
    defaultValue: number | undefined;
  } | undefined
): SchemaSelectField<K> => {
  const fallback = typeof getOpt(opts, 'defaultValue') === "number" ? getOpt(opts, 'defaultValue') as number : (durations[0] ?? 0);
  const ensureDurationBase = createNormalizer<number>(durations, fallback);

  const ensureDuration = (value: unknown): number => {
    const numeric = typeof value === "number" ? value : Number(value);
    return ensureDurationBase(Number.isNaN(numeric) ? fallback : numeric);
  };

  const resolvedLabelKeyTemplate = getOpt(opts, 'labelKeyTemplate');

  return {
    key,
    type: "select",
    labelKey: undefined,
    helperTextKey: undefined,
    helperTextParams: undefined,
    placeholderKey: undefined,
    tooltipKey: undefined,
    descriptionKey: undefined,
    layout: DEFAULT_SELECT_LAYOUT,
    visibleWhen: undefined,
    disabledWhen: undefined,
    required: undefined,
    requiredWhen: undefined,
    validation: undefined,
    metadata: undefined,
    className: undefined,
    sx: undefined,
    options: {
      kind: "static",
      options: durations.map((value) => ({
        value,
        labelKey: resolvedLabelKeyTemplate
          ? resolveLabelKeyTemplate(resolvedLabelKeyTemplate, { seconds: value })
          : `duration.${value}`,
        labelParams: resolvedLabelKeyTemplate
          ? { seconds: value }
          : undefined,
        descriptionKey: undefined,
        helperKey: undefined,
        disabledWhen: undefined,
        icon: undefined,
        groupKey: undefined,
      })),
    },
    defaultValue: fallback,
    events: [
      {
        kind: "change",
        when: undefined,
        handler: (value: unknown) => createFieldPatch(key, ensureDuration(value)),
      },
    ],
    multiple: undefined,
    renderValueKey: undefined,
    clearable: undefined,
  };
};

const resolveLabelKeyTemplate = (
  template: string,
  params: DynamicRecord | undefined
): string => {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match: string, token: string) => {
    if (!Object.prototype.hasOwnProperty.call(params, token)) return match;
    const param = params[token];
    return param === undefined || param === null ? match : String(param);
  });
};

/**
 * 创建一个通用的图片上传字段。
 *
 * 特性：
 * - 使用 imageUpload 类型
 * - 可选紧凑模式（compact = true 时自动添加 metadata.compactUpload）
 * - 支持配置 labelKey、accept、maxFiles
 */
export const createImageUploadField = <K extends string>(
  key: K,
  opts: {
    labelKey: string | undefined;
    compact: boolean | undefined;
    maxFiles: number | undefined;
    accept: string | undefined;
    maxSizeMB: number | undefined;
    maxDimension: number | undefined;
    imageResizeMode: ImageResizeMode | undefined;
    imageConstraints: ImageValidationConstraints | undefined;
  } | undefined
): SchemaImageUploadField<K> => ({
  key,
  type: "imageUpload",
  labelKey: getOpt(opts, 'labelKey'),
  helperTextKey: undefined,
  helperTextParams: undefined,
  placeholderKey: undefined,
  tooltipKey: undefined,
  descriptionKey: undefined,
  layout: undefined,
  visibleWhen: undefined,
  disabledWhen: undefined,
  required: undefined,
  requiredWhen: undefined,
  validation: undefined,
  events: undefined,
  metadata: getOpt(opts, 'compact') ? { compactUpload: true } : undefined,
  defaultValue: [],
  className: undefined,
  sx: undefined,
  accept: getOpt(opts, 'accept'),
  maxFiles: getOpt(opts, 'maxFiles'),
  maxSizeMB: getOpt(opts, 'maxSizeMB'),
  maxDimension: getOpt(opts, 'maxDimension'),
  imageResizeMode: getOpt(opts, 'imageResizeMode'),
  imageConstraints: getOpt(opts, 'imageConstraints'),
  maxFilesMap: undefined,
  enforceImage: undefined,
  transforms: undefined,
});

/**
 * 创建一个用于"去除首尾空白"的计算值。
 *
 * 等价于对指定字段应用 compute + trim 的组合。
 */
export const createTrimmedPromptCompute = <K extends string>(
  promptKey: K
): SchemaComputedValue<K> =>
  compute<K>(
    ({ values }) => {
      const raw = values[promptKey as keyof typeof values];
      return typeof raw === "string" ? raw.trim() : "";
    },
    [promptKey],
    `trim.${promptKey}`,
    undefined,
  );

/**
 * 创建一个通用归一化函数,确保值落在允许列表中。
 *
 * 行为：
 * - 若传入值严格等于 allowed 中某项,则返回该值
 * - 否则回退到 fallback
 */
export const createNormalizer = <T,>(allowed: T[], fallback: T) => (value: unknown): T => {
  const typed = value as T;
  return allowed.includes(typed) ? typed : fallback;
};

/**
 * 创建一个归一化计算值,自动将字段值限制在允许列表内。
 *
 * 使用场景：
 * - 模型选择: 确保 model 字段始终为有效模型 ID
 * - 时长/比例: 确保数值在预定义范围内
 *
 * 示例：
 * ```ts
 * const normalizedModelValue = createNormalizerCompute(
 *   "model",
 *   ["model-a", "model-b"],
 *   "model-a"
 * );
 * ```
 */
export const createNormalizerCompute = <K extends string, T = unknown>(
  key: K,
  allowed: T[],
  fallback: T,
  cacheKey: string | undefined
): SchemaComputedValue<K> =>
  compute<K>(
    ({ values }) => {
      const value = values[key];
      return allowed.includes(value as T) ? (value as T) : fallback;
    },
    [key],
    cacheKey ?? `normalize.${key}`,
    undefined,
  );

/**
 * 创建一个"检查上传字段是否有文件"的条件。
 *
 * 使用场景：
 * - 图生视频模式切换: 有图 => image2video, 无图 => text2video
 * - 条件字段显隐: 仅在上传图片后显示相关参数
 *
 * 示例：
 * ```ts
 * const hasReferenceImage = createHasUploadCondition("referenceImage");
 * // 用于 visibleWhen / requiredWhen
 * ```
 */
export const createHasUploadCondition = <K extends string>(
  key: K
): SchemaCondition<K> => ({ values }) =>
  Array.isArray(values[key]) && (values[key] as unknown[]).length > 0;

/**
 * 创建一个"检查文本字段是否非空"的条件。
 *
 * 使用场景：
 * - 可选字段的 payload 映射: 仅在有值时才添加到请求体
 * - 联动显隐: 填写某字段后才显示关联字段
 *
 * 示例：
 * ```ts
 * const hasNegativePrompt = createHasTextCondition("negativePrompt");
 * ```
 */
export const createHasTextCondition = <K extends string>(
  key: K
): SchemaCondition<K> => ({ values }) =>
  typeof values[key] === "string" && (values[key] as string).trim().length > 0;

/**
 * 创建标准 Payload 映射模板,包含常见字段的默认映射。
 *
 * 默认包含:
 * - prompt: trim 后的主提示词
 * - input: 同 prompt (用于兼容不同 API)
 * - api.method: POST
 *
 * 使用场景：
 * - 减少重复的 payload map 定义
 * - 统一 prompt 字段的处理方式
 *
 * 示例：
 * ```ts
 * payload: {
 *   format: "json",
 *   taskType: "video",
 *   map: createStandardPayloadMap({
 *     "api route endpoint": literal("/v1/videos"),
 *     "body.model": normalizedModelValue,
 *     "body.duration": normalizedDurationValue,
 *   }),
 * }
 * ```
 */
export const createStandardPayloadMap = <K extends string>(
  overrides: DynamicRecord
): DynamicRecord => ({
  prompt: createTrimmedPromptCompute("prompt" as K),
  input: createTrimmedPromptCompute("prompt" as K),
  "api.method": literal("POST"),
  ...overrides,
});

/**
 * 创建一个带静态选项的通用下拉字段。
 *
 * 特性：
 * - 默认 layout.colSpan = 1，自动注入静态 options
 * - 未显式传入 normalize 时，自动校验 value 是否在 options.value 列表中，不合法则回退 defaultValue 或首个选项
 * - normalize 可自定义任何归一化策略（例如容错旧枚举值），返回的结果会在 change 事件中写回
 * - 支持 helperTextKey 与 visibleWhen，便于复杂联动
 *
 * 使用场景：
 * - 画面比例选择：1:1、16:9 等固定比例列表
 * - 分辨率选择：1K、2K、4K 等预设分辨率
 * - 风格选择：cinematic、anime 等风格预设
 *
 * @example
 * ```ts
 * const aspectRatioField = createStaticSelectField(
 *   "aspectRatio",
 *   [
 *     { value: "1_1", labelKey: "pages:aspect.1_1" },
 *     { value: "16_9", labelKey: "pages:aspect.16_9" }
 *   ],
 *   {
 *     labelKey: "pages:aspect.label",
 *     helperTextKey: "pages:aspect.helper",
 *     defaultValue: "16_9",
 *     normalize: (value) => value === "1:1" ? "1_1" : value // 容错旧格式
 *   }
 * );
 * ```
 */
export const createStaticSelectField = <K extends string>(
  key: K,
  options: StaticSelectOption[],
  opts: {
    labelKey: string | undefined;
    helperTextKey: string | undefined;
    defaultValue: string | undefined;
    visibleWhen: SchemaCondition<K> | undefined;
    normalize: (value: unknown) => string | undefined;
  } | undefined
): SchemaSelectField<K> => {
  const resolvedDefaultValue = getOpt(opts, 'defaultValue');
  const firstOptionValue = options.length > 0 ? (options[0] !== undefined ? options[0].value : undefined) : undefined;
  const fallback = resolvedDefaultValue ?? firstOptionValue ?? "";
  const resolvedNormalize = getOpt(opts, 'normalize');
  const normalize = resolvedNormalize
    ? resolvedNormalize
    : (value: unknown) => {
        if (typeof value === "string" && options.some((option) => option.value === value)) {
          return value;
        }
        return fallback;
      };

  return {
    key,
    type: "select",
    labelKey: getOpt(opts, 'labelKey'),
    helperTextKey: getOpt(opts, 'helperTextKey'),
    helperTextParams: undefined,
    placeholderKey: undefined,
    tooltipKey: undefined,
    descriptionKey: undefined,
    layout: DEFAULT_SELECT_LAYOUT,
    disabledWhen: undefined,
    required: undefined,
    requiredWhen: undefined,
    validation: undefined,
    metadata: undefined,
    className: undefined,
    sx: undefined,
    options: {
      kind: "static",
      options: options.map((option) => ({
        value: option.value,
        labelKey: option.labelKey,
        labelParams: option.labelParams,
        descriptionKey: option.descriptionKey,
        helperKey: undefined,
        disabledWhen: undefined,
        icon: undefined,
        groupKey: undefined,
      })),
    },
    defaultValue: fallback,
    visibleWhen: getOpt(opts, 'visibleWhen'),
    events: [
      {
        kind: "change" as const,
        when: undefined,
        handler: (value: unknown) => {
          const normalized = normalize(value);
          return normalized === value
            ? undefined
            : createFieldPatch(key, normalized);
        },
      },
    ],
    multiple: undefined,
    renderValueKey: undefined,
    clearable: undefined,
  };
};
