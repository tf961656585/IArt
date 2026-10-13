import type { ModelConfigEntry } from '@/client/config/models.config';

import type { DynamicRecord } from '@/client/utils/typeGuards';
import { loadWorkspaceSchema, normalizeSchemaValues } from '@/features/workspace/modelFormAdapter';
import { isSchemaFormConfig } from '@/features/workspace/modelFormTypes';
import {
  deriveInitialValues,
  evaluateCondition,
  isDataField,
  traverseFields,
} from '@/features/workspace/schema/helpers';
import type {
  SchemaDataFieldDefinition,
  SchemaFieldOption,
  SchemaFormDefinition,
  SchemaFormValues,
  SchemaImageSizeField,
  SchemaImageSizeOption,
  SchemaImageSizeAspectOption,
  SchemaNumberField,
  SchemaRadioField,
  SchemaSelectField,
  SchemaSliderField,
  SchemaToggleField,
} from '@/features/workspace/schema/types';

type SelectLikeField =
  | SchemaSelectField<string>
  | SchemaRadioField<string>
  | SchemaToggleField<string>;
type ResolvedSchemaFieldOption = SchemaFieldOption & { disabled: boolean | undefined };

const isSelectLikeField = (
  field: SchemaDataFieldDefinition<string>
): field is SelectLikeField =>
  field.type === 'select' || field.type === 'radio' || field.type === 'toggle';

const asyncOptionsCache = new Map<string, Map<string, SchemaFieldOption[]>>();

export interface SchemaFieldOptionResult {
  schema: SchemaFormDefinition<string>;
  field: SelectLikeField;
  options: ResolvedSchemaFieldOption[];
  defaults: SchemaFormValues<string>;
  normalizedValues: SchemaFormValues<string>;
}

const getOptionCache = (modelId: string, cacheKey: string): SchemaFieldOption[] | undefined => {
  const scoped = asyncOptionsCache.get(modelId);
  if (scoped === undefined) return undefined;
  return scoped.get(cacheKey);
};

const setOptionCache = (modelId: string, cacheKey: string, options: SchemaFieldOption[]) => {
  let scoped = asyncOptionsCache.get(modelId);
  if (!scoped) {
    scoped = new Map<string, SchemaFieldOption[]>();
    asyncOptionsCache.set(modelId, scoped);
  }
  scoped.set(cacheKey, options);
};

export async function loadModelSchema(
  config: ModelConfigEntry
): Promise<SchemaFormDefinition<string> | null> {
  if (!isSchemaFormConfig((config.workspace !== null && config.workspace !== undefined ? config.workspace.form : undefined))) return null;
  try {
    return await loadWorkspaceSchema(config);
  } catch (error) {
    console.warn('[schemaBridge] load schema failed', error);
    return null;
  }
}

const findSelectField = (
  schema: SchemaFormDefinition<string>,
  fieldKey: string
): SelectLikeField | null => {
  let found: SelectLikeField | null = null;
  traverseFields(schema.fields, (field) => {
    if (found) return;
    if (!isDataField(field)) return;
    if (!isSelectLikeField(field)) return;
    if (field.key === fieldKey) {
      found = field;
    }
  });
  return found;
};

const resolveOptions = async (
  field: SelectLikeField,
  schema: SchemaFormDefinition<string>,
  values: SchemaFormValues<string>,
  modelId: string
): Promise<ResolvedSchemaFieldOption[]> => {
  const source = field.options;

  const maybeResolveDisabled = async (options: SchemaFieldOption[]): Promise<ResolvedSchemaFieldOption[]> => {
    const resolved = await Promise.all(
      options.map(async (option) => {
        if (!option.disabledWhen) {
          return { ...option, disabled: undefined };
        }
        const disabled = await evaluateCondition(option.disabledWhen, {
          schema,
          values,
          modelId,
          field: field.key,
        });
        return { ...option, disabled };
      })
    );
    return resolved;
  };

  if (source.kind === 'static') {
    return maybeResolveDisabled(source.options);
  }

  const cacheKey = source.cacheKey ?? field.key;
  const cached = source.once !== false ? getOptionCache(modelId, cacheKey) : undefined;
  if (cached) {
    return maybeResolveDisabled(cached);
  }

  try {
    const loaded = await source.loader({
      field: field.key,
      schema,
      values,
      modelId,
      locale: undefined,
    });
    if (source.once !== false) {
      setOptionCache(modelId, cacheKey, loaded);
    }
    return maybeResolveDisabled(loaded);
  } catch (error) {
    console.warn('[schemaBridge] load async options failed', { field: field.key, modelId, error });
    return [];
  }
};

export async function resolveSchemaFieldOptions(
  config: ModelConfigEntry,
  fieldKey: string,
  rawValues: DynamicRecord = {}
): Promise<SchemaFieldOptionResult | null> {
  const schema = await loadModelSchema(config);
  if (!schema) return null;

  const defaults = deriveInitialValues(schema);
  const normalizedValues = normalizeSchemaValues(schema, rawValues, config.modelId);
  const field = findSelectField(schema, fieldKey);
  if (!field) return null;

  const options = await resolveOptions(field, schema, normalizedValues, config.modelId ?? '');

  return {
    schema,
    field,
    options,
    defaults,
    normalizedValues,
  };
}

export interface SchemaConstraintResult {
  values: DynamicRecord;
  defaults: SchemaFormValues<string> | undefined;
  schema: SchemaFormDefinition<string> | undefined;
  corrections: Record<string, { from: unknown; to: unknown; reason: string }>;
  selectFieldKeys: string[] | undefined;
}

const isMultiValueField = (field: SelectLikeField) =>
  (field.type === 'select' && Boolean(field.multiple)) || (field.type === 'toggle' && field.exclusive === false);

const pickFallbackValue = (
  field: SelectLikeField,
  defaults: SchemaFormValues<string>,
  options: ResolvedSchemaFieldOption[]
) => {
  const defaultValue = defaults[field.key];
  if (defaultValue !== undefined) return defaultValue;
  return (options[0] !== null && options[0] !== undefined ? options[0].value : undefined);
};

const isEmptySelectValue = (value: unknown): boolean =>
  value === undefined || value === null || (typeof value === 'string' && value.trim().length === 0);

const isClearableSingleSelect = (field: SelectLikeField): boolean =>
  field.type === 'select' && field.clearable === true && !field.multiple;

export async function applySchemaSelectConstraints(
  config: ModelConfigEntry,
  rawValues: DynamicRecord
): Promise<SchemaConstraintResult> {
  const schema = await loadModelSchema(config);
  if (!schema) {
    return {
      values: rawValues,
      defaults: undefined,
      schema: undefined,
      corrections: {},
      selectFieldKeys: undefined,
    };
  }

  const defaults = deriveInitialValues(schema);
  const normalized = normalizeSchemaValues(schema, rawValues, config.modelId);
  const resultValues: DynamicRecord = { ...normalized };
  const corrections: SchemaConstraintResult['corrections'] = {};

  const selectFields: SelectLikeField[] = [];
  const selectKeys: string[] = [];
  traverseFields(schema.fields, (field) => {
    if (!isDataField(field)) return;
    if (isSelectLikeField(field)) {
      selectFields.push(field);
      selectKeys.push(field.key);
    }
  });

  for (const field of selectFields) {
    const options = await resolveOptions(field, schema, resultValues as SchemaFormValues<string>, config.modelId ?? '');
    if (options.length === 0) continue;

    const allowed = new Set(options.filter((opt) => !opt.disabled).map((opt) => opt.value));
    const current = resultValues[field.key];
    const fallback = pickFallbackValue(field, defaults, options);

    if (isClearableSingleSelect(field) && isEmptySelectValue(current)) {
      continue;
    }

    if (isMultiValueField(field)) {
      const currentList = Array.isArray(current) ? current : [];
      const filtered = currentList.filter((item) => allowed.has(item));
      const next = filtered.length > 0 ? filtered : [];
      if (next.length === 0 && fallback !== undefined) {
        if (Array.isArray(fallback)) {
          next.push(...(fallback as unknown[]));
        } else if (allowed.has(fallback)) {
          next.push(fallback);
        }
      }
      const changed = JSON.stringify(next) !== JSON.stringify(currentList);
      if (changed) {
        resultValues[field.key] = next;
        corrections[field.key] = { from: current, to: next, reason: 'schema-options' };
      }
      continue;
    }

    if (!allowed.has(current)) {
      const firstAllowedOption = options.find((opt) => allowed.has(opt.value));
      const candidate = allowed.has(fallback)
        ? fallback
        : isClearableSingleSelect(field)
          ? ''
          : (firstAllowedOption !== undefined ? firstAllowedOption.value : undefined) ?? current;
      if (candidate !== current) {
        resultValues[field.key] = candidate;
        corrections[field.key] = { from: current, to: candidate, reason: 'schema-options' };
      }
    }
  }

  return { values: resultValues, defaults, schema, corrections, selectFieldKeys: selectKeys };
}

// ==================== ImageSize Field Support ====================

const isImageSizeField = (
  field: SchemaDataFieldDefinition<string>
): field is SchemaImageSizeField<string> => field.type === 'imageSize';

const findImageSizeField = (
  schema: SchemaFormDefinition<string>,
  fieldKey: string
): SchemaImageSizeField<string> | null => {
  let found: SchemaImageSizeField<string> | null = null;
  traverseFields(schema.fields, (field) => {
    if (found) return;
    if (!isDataField(field)) return;
    if (!isImageSizeField(field)) return;
    if (field.key === fieldKey) {
      found = field;
    }
  });
  return found;
};

export interface ImageSizeFieldConfig {
  sizeOptions: SchemaImageSizeOption[];
  aspectOptions: SchemaImageSizeAspectOption[];
  mode: 'constrainedResolution' | undefined;
  aspectField: string | undefined;
  defaultValue: string | undefined;
  allowAuto: boolean | undefined;
  sizeLevels: NonNullable<SchemaImageSizeField<string>['sizeLevels']> | undefined;
  aspectPresets: NonNullable<SchemaImageSizeField<string>['aspectPresets']> | undefined;
  presetOptions: NonNullable<SchemaImageSizeField<string>['presetOptions']> | undefined;
  constraints: SchemaImageSizeField<string>['constraints'] | undefined;
}

export async function resolveImageSizeFieldConfig(
  config: ModelConfigEntry,
  fieldKey: string
): Promise<ImageSizeFieldConfig | null> {
  const schema = await loadModelSchema(config);
  if (!schema) return null;

  const field = findImageSizeField(schema, fieldKey);
  if (!field) return null;

  const defaults = deriveInitialValues(schema);
  const defaultValue = defaults[fieldKey] as string | undefined;

  return {
    sizeOptions: field.sizeOptions ?? [],
    aspectOptions: field.aspectOptions ?? [],
    mode: field.mode,
    aspectField: field.aspectField,
    defaultValue,
    allowAuto: field.allowAuto,
    sizeLevels: field.sizeLevels,
    aspectPresets: field.aspectPresets,
    presetOptions: field.presetOptions,
    constraints: field.constraints,
  };
}

// ==================== Number / Slider Field Support ====================

type NumericField = SchemaNumberField<string> | SchemaSliderField<string>;

const isNumericField = (field: SchemaDataFieldDefinition<string>): field is NumericField =>
  field.type === 'number' || field.type === 'slider';

const findNumericField = (
  schema: SchemaFormDefinition<string>,
  fieldKey: string
): NumericField | null => {
  let found: NumericField | null = null;
  traverseFields(schema.fields, (field) => {
    if (found) return;
    if (!isDataField(field)) return;
    if (!isNumericField(field)) return;
    if (field.key === fieldKey) {
      found = field;
    }
  });
  return found;
};

export interface NumericFieldConfig {
  kind: 'number' | 'slider';
  min: number | undefined;
  max: number | undefined;
  step: number | undefined;
  precision: number | undefined;
  marks: Array<{ value: number; labelKey: string | undefined }> | undefined;
  defaultValue: number | undefined;
  helperTextKey: string | undefined;
  helperTextParams: DynamicRecord | undefined;
  unitKey: string | undefined;
}

export async function resolveNumericFieldConfig(
  config: ModelConfigEntry,
  fieldKey: string
): Promise<NumericFieldConfig | null> {
  const schema = await loadModelSchema(config);
  if (!schema) return null;

  const field = findNumericField(schema, fieldKey);
  if (!field) return null;

  const defaults = deriveInitialValues(schema);
  const defaultValueRaw = defaults[fieldKey];
  const defaultValue = typeof defaultValueRaw === 'number' ? defaultValueRaw : undefined;

  if (field.type === 'slider') {
    const step = field.step ?? (field.validation !== null && field.validation !== undefined ? field.validation.step : undefined);
    return {
      kind: 'slider',
      min: field.min,
      max: field.max,
      step,
      precision: undefined,
      marks: field.marks,
      defaultValue,
      helperTextKey: field.helperTextKey,
      helperTextParams: field.helperTextParams,
      unitKey: undefined,
    };
  }

  const min = field.min ?? (field.validation !== null && field.validation !== undefined ? field.validation.min : undefined);
  const max = field.max ?? (field.validation !== null && field.validation !== undefined ? field.validation.max : undefined);
  const step = field.step ?? (field.validation !== null && field.validation !== undefined ? field.validation.step : undefined);
  return {
    kind: 'number',
    min,
    max,
    step,
    precision: field.precision,
    marks: undefined,
    defaultValue,
    helperTextKey: field.helperTextKey,
    helperTextParams: field.helperTextParams,
    unitKey: field.unitKey,
  };
}
