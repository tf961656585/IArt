import {
  fromField,
  literal,
  when,
  compute,
  type SchemaConditionExpression,
  type SchemaFieldBase,
  type SchemaFieldDefinition,
  type SchemaFieldOption,
  type SchemaFieldValidation,
  type SchemaFileField,
  type SchemaFormDefinition,
  type SchemaFieldLayout,
  type SchemaFormMeta,
  type SchemaImageUploadField,
  type SchemaPayloadDefinition,
  type SchemaPayloadMap,
  type SchemaValueExpression,
} from '@/features/workspace/schema/types';
import type { UnknownRecord } from '@/client/utils/typeGuards';
import type { ImageResizeMode, ImageValidationConstraints } from '@iart/contracts/media/imageValidationTypes';
import type {
  ModelAssetNodeProjection,
  ModelAssetNodeProjectionParameterField,
  ModelAssetNodeProjectionRuntimeValueRule,
} from '@iart/contracts/model-asset-contract';
import {
  buildSchemaPromptConfig,
  applyRuntimeUploadOptions,
} from '@/features/models/shared/modelAssetSchemaHelpers';
import { normalizeTaskType } from '@/features/models/shared/modelAssetProjectionPrimitives';
import { toSchemaImageSizeField } from './modelAssetImageSizeProjection';
import { evaluateRuntimeValueRule, type RuntimeEvaluationContext } from './modelAssetRuntimeValues';
import {
  isObjectRecord,
  normalizeRuntimeCondition,
  normalizeString,
  normalizeTransforms,
  toBooleanOrUndefined,
  toNumberOrUndefined,
  type RuntimeUploadOptionsRaw,
  type RuntimeProjectionContext,
} from './modelAssetProjectionShared';

type SchemaFieldValidationRaw = SchemaFieldValidation<string>;
type ImageValidationConstraintsRaw = UnknownRecord & ImageValidationConstraints;
type SchemaFieldComponentPropsRaw = UnknownRecord & {
  accept: unknown | undefined;
  allowAuto: unknown | undefined;
  allowMultiple: unknown | undefined;
  aspectField: unknown | undefined;
  aspectOptions: unknown | undefined;
  aspectPresets: unknown | undefined;
  showCounter: unknown | undefined;
  clearable: unknown | undefined;
  constraints: unknown | undefined;
  imageResizeMode: unknown | undefined;
  multiple: unknown | undefined;
  maxFiles: unknown | undefined;
  maxRows: unknown | undefined;
  maxSizeMB: unknown | undefined;
  maxDimension: unknown | undefined;
  minRows: unknown | undefined;
  exclusive: unknown | undefined;
  imageConstraints: unknown | undefined;
  enforceImage: unknown | undefined;
  mode: unknown | undefined;
  sizeLevels: unknown | undefined;
  sizeOptions: unknown | undefined;
  presetOptions: unknown | undefined;
  transforms: unknown | undefined;
};

export {
  normalizeMode,
  normalizePortDataType,
  normalizeProviderId,
  normalizeTaskType,
  toNodeGraphPorts,
} from '@/features/models/shared/modelAssetProjectionPrimitives';

export const normalizePayloadFormat = (
  value: unknown,
): 'json' | 'multipart' | 'stream' => {
  const normalized = normalizeString(value).toLowerCase();
  if (normalized === 'multipart' || normalized === 'stream') {
    return normalized;
  }
  return 'json';
};

const normalizeValidation = (
  field: ModelAssetNodeProjectionParameterField,
): SchemaFieldValidation<string> | undefined => {
  const rules = Array.isArray(field.validation_rules) ? field.validation_rules : [];
  if (rules.length === 0) return undefined;

  const validation: SchemaFieldValidationRaw = {
    min: undefined,
    max: undefined,
    minLength: undefined,
    maxLength: undefined,
    step: undefined,
    pattern: undefined,
    patternMessageKey: undefined,
    custom: undefined,
  };
  rules.forEach((rule) => {
    const type = normalizeString(rule.type).toLowerCase();
    const value = rule.value;
    if (!Number.isFinite(Number(value))) return;
    const numeric = Number(value);
    if (type === 'min' || type === 'minimum') validation.min = numeric;
    if (type === 'max' || type === 'maximum') validation.max = numeric;
    if (type === 'min_length' || type === 'minlength') validation.minLength = numeric;
    if (type === 'max_length' || type === 'maxlength') validation.maxLength = numeric;
    if (type === 'step') validation.step = numeric;
  });

  return Object.keys(validation).length > 0 ? validation : undefined;
};

const normalizeFieldComponent = (value: string): string => {
  const normalized = normalizeString(value).toLowerCase();
  if (normalized === 'imageupload') return 'imageUpload';
  if (normalized === 'imagesize') return 'imageSize';
  return normalized || 'text';
};

const toStaticOptions = (field: ModelAssetNodeProjectionParameterField): SchemaFieldOption[] =>
  Array.isArray(field.enum_options)
    ? field.enum_options
        .filter((option) => Object.prototype.hasOwnProperty.call(option, 'value'))
        .map((option) => ({
          value: option.value,
          labelKey: normalizeString(option.label) || String(option.value),
          labelParams: undefined,
          descriptionKey: undefined,
          helperKey: undefined,
          disabledWhen: undefined,
          icon: undefined,
          groupKey: undefined,
        }))
    : [];

const normalizeFieldLayout = (value: unknown): SchemaFieldLayout | undefined => {
  if (!isObjectRecord(value)) return undefined;
  const raw = value as UnknownRecord & {
    colSpan: unknown | undefined;
    align: unknown | undefined;
    sticky: unknown | undefined;
    dockPresentation: unknown | undefined;
    dockSummaryTemplate: unknown | undefined;
  };
  const colSpanNumber = toNumberOrUndefined(raw.colSpan);
  const colSpan =
    colSpanNumber === 1 || colSpanNumber === 2 || colSpanNumber === 3 || colSpanNumber === 4 || colSpanNumber === 5
    || colSpanNumber === 6 || colSpanNumber === 7 || colSpanNumber === 8 || colSpanNumber === 9 || colSpanNumber === 10
      ? colSpanNumber
      : undefined;
  const alignText = normalizeString(raw.align);
  const align =
    alignText === 'start' || alignText === 'center' || alignText === 'end' || alignText === 'stretch'
      ? alignText
      : undefined;
  const dockPresentationText = normalizeString(raw.dockPresentation);
  const dockPresentation =
    dockPresentationText === 'inline' || dockPresentationText === 'popover' || dockPresentationText === 'hidden' || dockPresentationText === 'summary'
      ? dockPresentationText
      : undefined;
  const dockSummaryTemplate = normalizeString(raw.dockSummaryTemplate);
  return {
    colSpan,
    align,
    sticky: typeof raw.sticky === 'boolean' ? raw.sticky : undefined,
    dockPresentation,
    dockSummaryTemplate: dockSummaryTemplate || undefined,
  };
};

const createEmptyComponentProps = (): SchemaFieldComponentPropsRaw => ({
  accept: undefined,
  allowAuto: undefined,
  allowMultiple: undefined,
  aspectField: undefined,
  aspectOptions: undefined,
  aspectPresets: undefined,
  showCounter: undefined,
  clearable: undefined,
  constraints: undefined,
  imageResizeMode: undefined,
  multiple: undefined,
  maxFiles: undefined,
  maxRows: undefined,
  maxSizeMB: undefined,
  maxDimension: undefined,
  minRows: undefined,
  exclusive: undefined,
  imageConstraints: undefined,
  enforceImage: undefined,
  mode: undefined,
  sizeLevels: undefined,
  sizeOptions: undefined,
  presetOptions: undefined,
  transforms: undefined,
});


const normalizeImageResizeMode = (value: unknown): ImageResizeMode | undefined => {
  const normalized = normalizeString(value);
  if (normalized === 'fit' || normalized === 'none') {
    return normalized;
  }
  return undefined;
};

const normalizeVisibleWhen = (
  visibleWhen: ModelAssetNodeProjectionParameterField['visible_when'],
): SchemaConditionExpression<string> | undefined => {
  if (visibleWhen === undefined || visibleWhen === null) return undefined;
  const op = visibleWhen.op;
  if (op === 'eq') {
    return { op: 'eq', field: visibleWhen.field, value: visibleWhen.value };
  }
  if (op === 'neq') {
    return { op: 'ne', field: visibleWhen.field, value: visibleWhen.value };
  }
  if (op === 'in') {
    return { op: 'includes', field: visibleWhen.field, value: visibleWhen.value };
  }
  if (op === 'not_in') {
    return { op: 'excludes', field: visibleWhen.field, value: visibleWhen.value };
  }
  return undefined;
};

const toSchemaField = (field: ModelAssetNodeProjectionParameterField): SchemaFieldDefinition<string> => {
  const componentProps: SchemaFieldComponentPropsRaw = isObjectRecord(field.component_props)
    ? field.component_props as SchemaFieldComponentPropsRaw
    : createEmptyComponentProps();

  const visibleWhen = normalizeVisibleWhen(field.visible_when);

  const base: SchemaFieldBase<string> = {
    key: field.field_key,
    labelKey: normalizeString(field.label) || field.field_key,
    helperTextKey: undefined,
    helperTextParams: undefined,
    placeholderKey: undefined,
    tooltipKey: undefined,
    descriptionKey: undefined,
    layout: undefined,
    visibleWhen,
    disabledWhen: undefined,
    required: field.required === true,
    requiredWhen: undefined,
    validation: undefined,
    events: undefined,
    metadata: isObjectRecord(field.metadata) ? (field.metadata as UnknownRecord) : undefined,
    defaultValue: field.default_value,
    className: undefined,
    sx: undefined,
  };
  const validation = normalizeValidation(field);
  if (validation) base.validation = validation;
  base.layout = normalizeFieldLayout(field.layout);
  const helperText = normalizeString(field.description);
  if (helperText) base.helperTextKey = helperText;

  const component = normalizeFieldComponent(field.component);
  if (component === 'textarea') {
    return {
      ...base,
      type: 'textarea' as const,
      minRows: toNumberOrUndefined(componentProps.minRows) ?? 3,
      maxRows: toNumberOrUndefined(componentProps.maxRows) ?? 10,
      autoResize: undefined,
      showCounter: componentProps.showCounter !== false,
    };
  }

  if (component === 'select') {
    return {
      ...base,
      type: 'select' as const,
      options: {
        kind: 'static' as const,
        options: toStaticOptions(field),
      },
      clearable: componentProps.clearable === true,
      multiple: componentProps.multiple === true,
      renderValueKey: undefined,
    };
  }

  if (component === 'radio') {
    return {
      ...base,
      type: 'radio' as const,
      options: {
        kind: 'static' as const,
        options: toStaticOptions(field),
      },
    };
  }

  if (component === 'toggle') {
    return {
      ...base,
      type: 'toggle' as const,
      options: {
        kind: 'static' as const,
        options: toStaticOptions(field),
      },
      exclusive: componentProps.exclusive !== false,
    };
  }

  if (component === 'switch') {
    return {
      ...base,
      type: 'switch' as const,
      trueLabelKey: undefined,
      falseLabelKey: undefined,
    };
  }

  if (component === 'number') {
    return {
      ...base,
      type: 'number' as const,
      min: undefined,
      max: undefined,
      step: undefined,
      precision: undefined,
      unitKey: undefined,
    };
  }

  if (component === 'file') {
    const result: SchemaFileField<string> = {
      ...base,
      type: 'file',
      accept: undefined,
      maxFiles: undefined,
      maxSizeMB: undefined,
      allowMultiple: undefined,
      requiredWhen: undefined,
      transforms: undefined,
    };
    const accept = normalizeString(componentProps.accept);
    if (accept) result.accept = accept;
    const maxFiles = toNumberOrUndefined(componentProps.maxFiles);
    if (maxFiles !== undefined) result.maxFiles = maxFiles;
    const maxSizeMB = toNumberOrUndefined(componentProps.maxSizeMB);
    if (maxSizeMB !== undefined) result.maxSizeMB = maxSizeMB;
    const allowMultiple = toBooleanOrUndefined(componentProps.allowMultiple);
    if (allowMultiple !== undefined) result.allowMultiple = allowMultiple;
    const transforms = normalizeTransforms(componentProps.transforms);
    if (transforms) result.transforms = transforms;
    return result;
  }

  if (component === 'imageUpload') {
    const result: SchemaImageUploadField<string> = {
      ...base,
      type: 'imageUpload',
      accept: undefined,
      maxFiles: undefined,
      maxSizeMB: undefined,
      maxDimension: undefined,
      imageResizeMode: undefined,
      imageConstraints: undefined,
      maxFilesMap: undefined,
      enforceImage: undefined,
      requiredWhen: undefined,
      transforms: undefined,
    };
    const accept = normalizeString(componentProps.accept);
    if (accept) result.accept = accept;
    const maxFiles = toNumberOrUndefined(componentProps.maxFiles);
    if (maxFiles !== undefined) result.maxFiles = maxFiles;
    const maxSizeMB = toNumberOrUndefined(componentProps.maxSizeMB);
    if (maxSizeMB !== undefined) result.maxSizeMB = maxSizeMB;
    const maxDimension = toNumberOrUndefined(componentProps.maxDimension);
    if (maxDimension !== undefined) result.maxDimension = maxDimension;
    const imageResizeMode = normalizeImageResizeMode(componentProps.imageResizeMode);
    if (imageResizeMode) result.imageResizeMode = imageResizeMode;
    if (isObjectRecord(componentProps.imageConstraints)) {
      const imageConstraints = componentProps.imageConstraints as ImageValidationConstraintsRaw;
      result.imageConstraints = imageConstraints;
    }
    if (componentProps.enforceImage === true) result.enforceImage = true;
    const transforms = normalizeTransforms(componentProps.transforms);
    if (transforms) result.transforms = transforms;
    return result;
  }

  if (component === 'imageSize') {
    return toSchemaImageSizeField(base, componentProps);
  }

  return {
    ...base,
    type: 'text',
    inputMode: undefined,
    maxLength: undefined,
    autoComplete: undefined,
  };
};
const normalizeValueExpression = (
  rule: ModelAssetNodeProjectionRuntimeValueRule,
): SchemaValueExpression<string> | null => {
  if (rule.kind === 'literal') {
    return literal(rule.value);
  }

  if (rule.kind === 'field') {
    const fieldKey = normalizeString(rule.field_key);
    if (!fieldKey) return null;
    const transforms = normalizeTransforms(rule.transforms);
    const expression = fromField(fieldKey, transforms, rule.media_target);
    if (rule.fallback) {
      const fallbackExpression = normalizeValueExpression(rule.fallback);
      if (fallbackExpression) {
        expression.fallback = fallbackExpression;
      }
    }
    return expression;
  }

  if (rule.kind === 'item') {
    return compute(
      (context) => {
        const evalContext: RuntimeEvaluationContext = {
          schema: context.schema as SchemaFormDefinition<string>,
          values: context.values,
          fields: undefined,
          modelId: context.modelId,
          runtime: context.runtime as RuntimeProjectionContext | undefined,
          currentItem: undefined,
        };
        return evaluateRuntimeValueRule(rule, evalContext);
      },
      undefined,
      undefined,
      undefined,
    );
  }

  if (rule.kind === 'when') {
    const condition = normalizeRuntimeCondition(rule.condition);
    const truthy = normalizeValueExpression(rule.truthy);
    if (!condition || !truthy) return null;
    const falsy = rule.falsy ? normalizeValueExpression(rule.falsy) ?? undefined : undefined;
    return when(condition, truthy, falsy);
  }

  if (rule.kind === 'compute') {
    const cacheKey = normalizeString(rule.cache_key);
    return compute(
      (context) => {
        const evalContext: RuntimeEvaluationContext = {
          schema: context.schema as SchemaFormDefinition<string>,
          values: context.values,
          fields: undefined,
          modelId: context.modelId,
          runtime: context.runtime as RuntimeProjectionContext | undefined,
          currentItem: undefined,
        };
        return evaluateRuntimeValueRule(rule, evalContext);
      },
      undefined,
      cacheKey || undefined,
      rule.media_target,
    );
  }

  return null;
};

export const toSchemaPayloadMap = (
  rules: Record<string, ModelAssetNodeProjectionRuntimeValueRule> | undefined,
): SchemaPayloadMap<string> => {
  if (!rules) {
    return {};
  }

  const payloadMap: SchemaPayloadMap<string> = {};
  Object.entries(rules).forEach(([path, rule]) => {
    const expression = normalizeValueExpression(rule);
    if (!expression) return;
    payloadMap[path] = expression;
  });
  return payloadMap;
};

export const buildSchema = (projection: ModelAssetNodeProjection): SchemaFormDefinition<string> => {
  const runtime = projection.runtime;
  const modelId = projection.model_id;
  const fields = projection.parameter_schema.fields.map((field) => toSchemaField(field));
  const payloadMap = toSchemaPayloadMap((runtime !== null && runtime !== undefined ? runtime.payload_rules : undefined));

  // 提示词字段来自投影顶层 prompt_field 声明（保留键 `__prompt`），不是参数表单字段。
  // 参数清单字段（fields）不再承载 prompt。
  const promptFieldKey =
    projection.prompt_field !== undefined && projection.prompt_field.field_key
      ? projection.prompt_field.field_key
      : undefined;

  const meta: SchemaFormMeta = {
    id: `${modelId}.runtime-schema`,
    version: '1.0.0',
    modelId: modelId,
    titleKey: undefined,
    descriptionKey: undefined,
    docLinkKey: undefined,
  };

  const payload: SchemaPayloadDefinition<string> = {
    map: payloadMap,
    format: undefined,
    format_rule: undefined,
    taskType: undefined,
    hooks: undefined,
  };
  // payload_format 支持静态声明（字符串）与运行时条件求值（payload_format_rule）两种形态。
  // 后者标记为 "dynamic"，原始规则保存到 format_rule，由 buildPayload 在请求构造期求值。
  // 详见 docs/model-assets/21-模型资产规则DSL规范.md 的「请求体格式语义」段。
  const payloadFormatRuleRaw = runtime !== null && runtime !== undefined ? runtime.payload_format_rule : undefined;
  if (payloadFormatRuleRaw !== undefined && payloadFormatRuleRaw !== null) {
    payload.format = 'dynamic';
    payload.format_rule = payloadFormatRuleRaw as SchemaValueExpression<string>;
  } else {
    const format = normalizePayloadFormat((runtime !== null && runtime !== undefined ? runtime.payload_format : undefined));
    if (format !== 'json') payload.format = format;
  }
  const taskType = normalizeTaskType(projection.execution_profile.task_type);
  if (taskType) payload.taskType = taskType;
  payload.hooks = {
    beforeBuild: async (context) => {
      const runtimeOptions: RuntimeUploadOptionsRaw = {
        url_input_upload_mode: undefined,
        url_input_upload_target_type: undefined,
        ...((runtime !== null && runtime !== undefined && runtime.url_input_upload_mode !== null && runtime.url_input_upload_mode !== undefined)
          ? { url_input_upload_mode: runtime.url_input_upload_mode }
          : {}),
        ...((runtime !== null && runtime !== undefined && runtime.url_input_upload_target_type !== null && runtime.url_input_upload_target_type !== undefined)
          ? { url_input_upload_target_type: runtime.url_input_upload_target_type }
          : {}),
      };
      applyRuntimeUploadOptions(context, runtimeOptions);
    },
    afterBuild: undefined,
  };

  const schema: SchemaFormDefinition<string> = {
    meta,
    layout: {
      sections: undefined,
      stickyFooter: true,
      columns: 8,
    },
    fields,
    defaults: undefined,
    formValidators: undefined,
    prompt: undefined,
    payload,
    responseHandling: undefined,
  };
  const defaultValues = projection.parameter_schema.default_values;
  if (defaultValues) schema.defaults = defaultValues;
  schema.prompt = buildSchemaPromptConfig(promptFieldKey);
  return schema;
};
