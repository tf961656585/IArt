import type { UnknownRecord } from '@/client/utils/typeGuards';
import type {
  SchemaFieldBase,
  SchemaImageSizeAspectOption,
  SchemaImageSizeConstrainedAspectPreset,
  SchemaImageSizeConstrainedResolutionConstraints,
  SchemaImageSizeField,
  SchemaImageSizeLevelOption,
  SchemaImageSizeOption,
  SchemaImageSizePresetOption,
} from '@/features/workspace/schema/types';
import {
  isObjectRecord,
  normalizeString,
  toNumberOrUndefined,
} from './modelAssetProjectionShared';

type ImageSizeComponentPropsRaw = UnknownRecord & {
  allowAuto: unknown | undefined;
  aspectField: unknown | undefined;
  aspectOptions: unknown | undefined;
  aspectPresets: unknown | undefined;
  constraints: unknown | undefined;
  mode: unknown | undefined;
  presetOptions: unknown | undefined;
  sizeLevels: unknown | undefined;
  sizeOptions: unknown | undefined;
};

type ImageSizeOptionRaw = UnknownRecord & {
  description: unknown | undefined;
  descriptionKey: unknown | undefined;
  label: unknown | undefined;
  labelKey: unknown | undefined;
  value: unknown | undefined;
};

type ImageSizeAspectOptionRaw = ImageSizeOptionRaw & {
  id: unknown | undefined;
  ratio: unknown | undefined;
  resolution: unknown | undefined;
};

type ImageSizeLevelOptionRaw = ImageSizeOptionRaw & {
  id: unknown | undefined;
  pixelBudget: unknown | undefined;
};

type ImageSizeResolutionRaw = UnknownRecord & {
  height: unknown | undefined;
  width: unknown | undefined;
};

type ImageSizeConstraintsRaw = UnknownRecord & {
  dimensionMultiple: unknown | undefined;
  maxLongEdge: unknown | undefined;
  minPixels: unknown | undefined;
  maxPixels: unknown | undefined;
  maxAspectRatio: unknown | undefined;
};

const looksLikeI18nKey = (value: string): boolean => value.includes(':');

const resolveProjectedOptionText = (
  option: ImageSizeOptionRaw,
  key: 'label' | 'description',
): { keyValue: string | undefined; text: string | undefined } => {
  const explicitKey = normalizeString(key === 'label' ? option.labelKey : option.descriptionKey);
  const text = normalizeString(key === 'label' ? option.label : option.description);
  const projectedKey = explicitKey || (looksLikeI18nKey(text) ? text : '');
  return {
    keyValue: projectedKey || undefined,
    text: !projectedKey && text ? text : undefined,
  };
};

const normalizeSizeOption = (item: unknown): SchemaImageSizeOption | null => {
  if (Number.isFinite(Number(item))) {
    return {
      value: Number(item),
      labelKey: undefined,
      label: undefined,
    };
  }
  if (!isObjectRecord(item)) return null;
  const option = item as ImageSizeOptionRaw;
  const value = toNumberOrUndefined(option.value);
  if (value === undefined) return null;
  const labelText = resolveProjectedOptionText(option, 'label');
  return {
    value,
    labelKey: labelText.keyValue,
    label: labelText.text,
  };
};

const normalizeSizeLevel = (item: unknown): SchemaImageSizeLevelOption | null => {
  if (!isObjectRecord(item)) return null;
  const option = item as ImageSizeLevelOptionRaw;
  const id = normalizeString(option.id);
  const pixelBudget = toNumberOrUndefined(option.pixelBudget);
  if (!id || pixelBudget === undefined || !Number.isFinite(pixelBudget) || pixelBudget <= 0) {
    return null;
  }
  const labelText = resolveProjectedOptionText(option, 'label');
  return {
    id,
    labelKey: labelText.keyValue,
    label: labelText.text,
    pixelBudget,
  };
};

const normalizeResolution = (
  value: unknown,
): { width: number; height: number } | undefined => {
  if (!isObjectRecord(value)) return undefined;
  const resolution = value as ImageSizeResolutionRaw;
  return {
    width: toNumberOrUndefined(resolution.width) ?? 0,
    height: toNumberOrUndefined(resolution.height) ?? 0,
  };
};

const normalizeConstrainedAspectPreset = (
  item: unknown,
): SchemaImageSizeConstrainedAspectPreset | null => {
  if (!isObjectRecord(item)) return null;
  const option = item as ImageSizeAspectOptionRaw;
  const id = normalizeString(option.id);
  const ratio = toNumberOrUndefined(option.ratio);
  if (!id || ratio === undefined || !Number.isFinite(ratio) || ratio <= 0) {
    return null;
  }
  const labelText = resolveProjectedOptionText(option, 'label');
  return {
    id,
    labelKey: labelText.keyValue,
    label: labelText.text,
    ratio,
  };
};

const normalizeAspectOption = (item: unknown): SchemaImageSizeAspectOption | null => {
  if (!isObjectRecord(item)) return null;
  const option = item as ImageSizeAspectOptionRaw;
  const id = normalizeString(option.id);
  const itemValue = normalizeString(option.value);
  const ratio = toNumberOrUndefined(option.ratio);
  const labelText = resolveProjectedOptionText(option, 'label');
  const descriptionText = resolveProjectedOptionText(option, 'description');
  const resolution = normalizeResolution(option.resolution);
  return {
    id: id || undefined,
    value: itemValue || undefined,
    ratio,
    labelKey: labelText.keyValue,
    label: labelText.text,
    descriptionKey: descriptionText.keyValue,
    description: descriptionText.text,
    resolution,
  };
};

const normalizePresetOption = (item: unknown): SchemaImageSizePresetOption | null => {
  if (!isObjectRecord(item)) return null;
  const option = item as ImageSizeOptionRaw;
  const value = normalizeString(option.value);
  if (!value) return null;
  const labelText = resolveProjectedOptionText(option, 'label');
  const descriptionText = resolveProjectedOptionText(option, 'description');
  return {
    value,
    labelKey: labelText.keyValue,
    label: labelText.text,
    descriptionKey: descriptionText.keyValue,
    description: descriptionText.text,
  };
};

const normalizeConstraints = (
  value: unknown,
): SchemaImageSizeConstrainedResolutionConstraints | undefined => {
  if (!isObjectRecord(value)) return undefined;
  const constraints = value as ImageSizeConstraintsRaw;
  const dimensionMultiple = toNumberOrUndefined(constraints.dimensionMultiple);
  const maxLongEdge = toNumberOrUndefined(constraints.maxLongEdge);
  const minPixels = toNumberOrUndefined(constraints.minPixels);
  const maxPixels = toNumberOrUndefined(constraints.maxPixels);
  const maxAspectRatio = toNumberOrUndefined(constraints.maxAspectRatio);
  if (
    dimensionMultiple === undefined ||
    maxLongEdge === undefined ||
    minPixels === undefined ||
    maxPixels === undefined ||
    maxAspectRatio === undefined
  ) {
    return undefined;
  }
  return {
    dimensionMultiple,
    maxLongEdge,
    minPixels,
    maxPixels,
    maxAspectRatio,
  };
};

export const toSchemaImageSizeField = (
  base: SchemaFieldBase<string>,
  componentProps: ImageSizeComponentPropsRaw,
): SchemaImageSizeField<string> => {
  const sizeOptions = Array.isArray(componentProps.sizeOptions)
    ? componentProps.sizeOptions
        .map(normalizeSizeOption)
        .filter((item): item is SchemaImageSizeOption => item !== null)
    : undefined;
  const aspectOptions = Array.isArray(componentProps.aspectOptions)
    ? componentProps.aspectOptions
        .map(normalizeAspectOption)
        .filter((item): item is SchemaImageSizeAspectOption => item !== null)
    : undefined;
  const presetOptions = Array.isArray(componentProps.presetOptions)
    ? componentProps.presetOptions
        .map(normalizePresetOption)
        .filter((item): item is SchemaImageSizePresetOption => item !== null)
    : undefined;
  const sizeLevels = Array.isArray(componentProps.sizeLevels)
    ? componentProps.sizeLevels
        .map(normalizeSizeLevel)
        .filter((item): item is SchemaImageSizeLevelOption => item !== null)
    : undefined;
  const aspectPresets = Array.isArray(componentProps.aspectPresets)
    ? componentProps.aspectPresets
        .map(normalizeConstrainedAspectPreset)
        .filter((item): item is SchemaImageSizeConstrainedAspectPreset => item !== null)
    : undefined;
  const constraints = normalizeConstraints(componentProps.constraints);

  const result: SchemaImageSizeField<string> = {
    ...base,
    type: 'imageSize',
    mode: undefined,
    sizeOptions: undefined,
    aspectField: undefined,
    aspectOptions: undefined,
    allowAuto: undefined,
    sizeLevels: undefined,
    aspectPresets: undefined,
    presetOptions: undefined,
    constraints: undefined,
  };
  if (normalizeString(componentProps.mode) === 'constrainedResolution') {
    result.mode = 'constrainedResolution';
  }
  if (sizeOptions) result.sizeOptions = sizeOptions;
  const aspectField = normalizeString(componentProps.aspectField);
  if (aspectField) result.aspectField = aspectField;
  if (aspectOptions) result.aspectOptions = aspectOptions;
  if (typeof componentProps.allowAuto === 'boolean') result.allowAuto = componentProps.allowAuto;
  if (sizeLevels) result.sizeLevels = sizeLevels;
  if (aspectPresets) result.aspectPresets = aspectPresets;
  if (presetOptions) result.presetOptions = presetOptions;
  if (constraints) result.constraints = constraints;
  return result;
};
