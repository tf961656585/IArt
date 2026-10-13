import { isRecord, normalizeString } from './shared';

type Constraints = {
  dimensionMultiple: number;
  maxLongEdge: number;
  minPixels: number;
  maxPixels: number;
  maxAspectRatio: number;
};

const parsePositiveNumber = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value;
};

const parsePositiveInteger = (value: unknown): number | null => {
  const parsed = parsePositiveNumber(value);
  if (parsed === null || !Number.isInteger(parsed)) {
    return null;
  }
  return parsed;
};

const parseResolutionValue = (value: string): { width: number; height: number } | null => {
  const match = value.match(/^(\d+)x(\d+)$/);
  if (!match) return null;
  const width = Number.parseInt(match[1] ?? '', 10);
  const height = Number.parseInt(match[2] ?? '', 10);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { width, height };
};

const readConstraints = (
  componentProps: Record<string, unknown>,
  fieldIndex: number,
): Constraints => {
  const constraintsRecord = isRecord(componentProps['constraints']) ? componentProps['constraints'] : null;
  if (!constraintsRecord) {
    throw new Error(`runtime_model.parameter_schema_image_size_constraints_missing:${fieldIndex}`);
  }
  const dimensionMultiple = parsePositiveInteger(constraintsRecord['dimensionMultiple']);
  const maxLongEdge = parsePositiveInteger(constraintsRecord['maxLongEdge']);
  const minPixels = parsePositiveNumber(constraintsRecord['minPixels']);
  const maxPixels = parsePositiveNumber(constraintsRecord['maxPixels']);
  const maxAspectRatio = parsePositiveNumber(constraintsRecord['maxAspectRatio']);
  if (
    dimensionMultiple === null ||
    maxLongEdge === null ||
    minPixels === null ||
    maxPixels === null ||
    maxAspectRatio === null
  ) {
    throw new Error(`runtime_model.parameter_schema_image_size_constraints_invalid:${fieldIndex}`);
  }
  if (maxPixels < minPixels) {
    throw new Error(`runtime_model.parameter_schema_image_size_pixels_range_invalid:${fieldIndex}`);
  }
  return {
    dimensionMultiple,
    maxLongEdge,
    minPixels,
    maxPixels,
    maxAspectRatio,
  };
};

const validatePresetResolution = (
  value: string,
  fieldIndex: number,
  optionIndex: number,
  constraints: Constraints,
  codePrefix: 'preset' | 'custom_preset' = 'preset',
): void => {
  const resolution = parseResolutionValue(value);
  if (!resolution) {
    throw new Error(
      `runtime_model.parameter_schema_image_size_${codePrefix}_invalid:${fieldIndex}:${optionIndex}`,
    );
  }
  const longEdge = Math.max(resolution.width, resolution.height);
  const shortEdge = Math.min(resolution.width, resolution.height);
  const pixels = resolution.width * resolution.height;
  const ratio = longEdge / shortEdge;
  if (longEdge > constraints.maxLongEdge) {
    throw new Error(
      `runtime_model.parameter_schema_image_size_${codePrefix}_long_edge_exceeded:${fieldIndex}:${optionIndex}:${value}`,
    );
  }
  if (
    resolution.width % constraints.dimensionMultiple !== 0 ||
    resolution.height % constraints.dimensionMultiple !== 0
  ) {
    throw new Error(
      `runtime_model.parameter_schema_image_size_${codePrefix}_dimension_multiple_invalid:${fieldIndex}:${optionIndex}:${value}`,
    );
  }
  if (ratio > constraints.maxAspectRatio) {
    throw new Error(
      `runtime_model.parameter_schema_image_size_${codePrefix}_aspect_ratio_exceeded:${fieldIndex}:${optionIndex}:${value}`,
    );
  }
  if (pixels < constraints.minPixels || pixels > constraints.maxPixels) {
    throw new Error(
      `runtime_model.parameter_schema_image_size_${codePrefix}_pixels_out_of_range:${fieldIndex}:${optionIndex}:${value}`,
    );
  }
};

const validatePreset = ({
  option,
  fieldIndex,
  optionIndex,
  allowAuto,
  constraints,
}: {
  option: unknown;
  fieldIndex: number;
  optionIndex: number;
  allowAuto: boolean;
  constraints: Constraints;
}): void => {
  if (!isRecord(option)) {
    throw new Error(
      `runtime_model.parameter_schema_image_size_preset_invalid:${fieldIndex}:${optionIndex}`,
    );
  }
  const value = normalizeString(option['value']);
  if (!value) {
    throw new Error(
      `runtime_model.parameter_schema_image_size_preset_value_missing:${fieldIndex}:${optionIndex}`,
    );
  }
  if (value === 'auto') {
    if (!allowAuto) {
      throw new Error(
        `runtime_model.parameter_schema_image_size_auto_not_allowed:${fieldIndex}:${optionIndex}`,
      );
    }
    return;
  }
  validatePresetResolution(value, fieldIndex, optionIndex, constraints);
};

const validateSizeLevel = ({
  option,
  fieldIndex,
  optionIndex,
  constraints,
}: {
  option: unknown;
  fieldIndex: number;
  optionIndex: number;
  constraints: Constraints;
}): void => {
  if (!isRecord(option)) {
    throw new Error(
      `runtime_model.parameter_schema_image_size_level_invalid:${fieldIndex}:${optionIndex}`,
    );
  }
  const id = normalizeString(option['id']);
  const label = normalizeString(option['label']);
  const pixelBudget = parsePositiveInteger(option['pixelBudget']);
  if (!id) {
    throw new Error(
      `runtime_model.parameter_schema_image_size_level_id_missing:${fieldIndex}:${optionIndex}`,
    );
  }
  if (!label) {
    throw new Error(
      `runtime_model.parameter_schema_image_size_level_label_missing:${fieldIndex}:${optionIndex}`,
    );
  }
  if (pixelBudget === null) {
    throw new Error(
      `runtime_model.parameter_schema_image_size_level_pixel_budget_invalid:${fieldIndex}:${optionIndex}`,
    );
  }
  if (pixelBudget > constraints.maxPixels) {
    throw new Error(
      `runtime_model.parameter_schema_image_size_level_pixel_budget_exceeded:${fieldIndex}:${optionIndex}:${pixelBudget}`,
    );
  }
  if (pixelBudget < constraints.minPixels) {
    throw new Error(
      `runtime_model.parameter_schema_image_size_level_pixel_budget_below_min:${fieldIndex}:${optionIndex}:${pixelBudget}`,
    );
  }
};

const validateAspectPreset = ({
  option,
  fieldIndex,
  optionIndex,
  constraints,
}: {
  option: unknown;
  fieldIndex: number;
  optionIndex: number;
  constraints: Constraints;
}): void => {
  if (!isRecord(option)) {
    throw new Error(
      `runtime_model.parameter_schema_image_size_aspect_preset_invalid:${fieldIndex}:${optionIndex}`,
    );
  }
  const id = normalizeString(option['id']);
  const label = normalizeString(option['label']);
  const ratio = parsePositiveNumber(option['ratio']);
  if (!id) {
    throw new Error(
      `runtime_model.parameter_schema_image_size_aspect_preset_id_missing:${fieldIndex}:${optionIndex}`,
    );
  }
  if (!label) {
    throw new Error(
      `runtime_model.parameter_schema_image_size_aspect_preset_label_missing:${fieldIndex}:${optionIndex}`,
    );
  }
  if (ratio === null) {
    throw new Error(
      `runtime_model.parameter_schema_image_size_aspect_preset_ratio_invalid:${fieldIndex}:${optionIndex}`,
    );
  }
  const longShortRatio = ratio >= 1 ? ratio : 1 / ratio;
  if (longShortRatio > constraints.maxAspectRatio) {
    throw new Error(
      `runtime_model.parameter_schema_image_size_aspect_preset_ratio_exceeded:${fieldIndex}:${optionIndex}:${ratio}`,
    );
  }
};

const validateCustomPreset = ({
  option,
  fieldIndex,
  optionIndex,
  constraints,
}: {
  option: unknown;
  fieldIndex: number;
  optionIndex: number;
  constraints: Constraints;
}): void => {
  if (!isRecord(option)) {
    throw new Error(
      `runtime_model.parameter_schema_image_size_custom_preset_invalid:${fieldIndex}:${optionIndex}`,
    );
  }
  const value = normalizeString(option['value']);
  // 常见宽高预设必须是具体 WxH 尺寸，不接受 auto（auto 由 presetOptions 承载）
  if (!value || value === 'auto') {
    throw new Error(
      `runtime_model.parameter_schema_image_size_custom_preset_invalid:${fieldIndex}:${optionIndex}`,
    );
  }
  validatePresetResolution(value, fieldIndex, optionIndex, constraints, 'custom_preset');
};

export const validateImageSizeConstrainedResolutionField = (
  field: Record<string, unknown>,
  index: number,
): void => {
  const component = normalizeString(field['component']).toLowerCase();
  if (component !== 'imagesize') return;

  const componentProps = isRecord(field['component_props']) ? field['component_props'] : null;
  if (!componentProps || normalizeString(componentProps['mode']) !== 'constrainedResolution') {
    return;
  }

  const constraints = readConstraints(componentProps, index);
  const sizeLevels = componentProps['sizeLevels'];
  if (!Array.isArray(sizeLevels) || sizeLevels.length === 0) {
    throw new Error(`runtime_model.parameter_schema_image_size_levels_missing:${index}`);
  }
  sizeLevels.forEach((option, optionIndex) => {
    validateSizeLevel({
      option,
      fieldIndex: index,
      optionIndex,
      constraints,
    });
  });
  const aspectPresets = componentProps['aspectPresets'];
  if (!Array.isArray(aspectPresets) || aspectPresets.length === 0) {
    throw new Error(`runtime_model.parameter_schema_image_size_aspect_presets_missing:${index}`);
  }
  aspectPresets.forEach((option, optionIndex) => {
    validateAspectPreset({
      option,
      fieldIndex: index,
      optionIndex,
      constraints,
    });
  });
  const presetOptions = componentProps['presetOptions'];
  if (!Array.isArray(presetOptions) || presetOptions.length === 0) {
    throw new Error(`runtime_model.parameter_schema_image_size_preset_options_missing:${index}`);
  }
  const allowAuto = componentProps['allowAuto'] === true;
  presetOptions.forEach((option, optionIndex) => {
    validatePreset({
      option,
      fieldIndex: index,
      optionIndex,
      allowAuto,
      constraints,
    });
  });
  const customPresets = componentProps['customPresets'];
  if (customPresets !== undefined) {
    if (!Array.isArray(customPresets)) {
      throw new Error(`runtime_model.parameter_schema_image_size_custom_presets_invalid:${index}`);
    }
    customPresets.forEach((option, optionIndex) => {
      validateCustomPreset({
        option,
        fieldIndex: index,
        optionIndex,
        constraints,
      });
    });
  }
};
