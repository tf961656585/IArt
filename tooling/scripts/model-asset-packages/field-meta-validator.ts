import { isRecord, normalizeString } from './shared';

const VALID_FIELD_DATA_SOURCES = new Set(['connection', 'form', 'both']);
const VALID_VISIBLE_WHEN_OPS = new Set(['eq', 'neq', 'in', 'not_in']);

export const validateFieldDataSource = (field: Record<string, unknown>, index: number): void => {
  if (field['data_source'] === undefined) return;
  const fieldKey = normalizeString(field['field_key']);
  const fieldLabel = fieldKey || String(index);
  const dataSourceRaw = normalizeString(field['data_source']).toLowerCase();
  if (!VALID_FIELD_DATA_SOURCES.has(dataSourceRaw)) {
    throw new Error(
      `runtime_model.parameter_schema_field_data_source_invalid:${fieldLabel}:${String(field['data_source'])}`,
    );
  }
};

export const validateFieldVisibleWhen = (field: Record<string, unknown>, index: number): void => {
  if (field['visible_when'] === undefined) return;
  const fieldKey = normalizeString(field['field_key']);
  const fieldLabel = fieldKey || String(index);
  const visibleWhen = field['visible_when'];
  if (!isRecord(visibleWhen)) {
    throw new Error(
      `runtime_model.parameter_schema_field_visible_when_invalid:${fieldLabel}:must_be_object`,
    );
  }
  const visibleWhenField = normalizeString(visibleWhen['field']);
  if (!visibleWhenField) {
    throw new Error(
      `runtime_model.parameter_schema_field_visible_when_invalid:${fieldLabel}:field_missing`,
    );
  }
  const opRaw = normalizeString(visibleWhen['op']);
  if (!VALID_VISIBLE_WHEN_OPS.has(opRaw)) {
    throw new Error(
      `runtime_model.parameter_schema_field_visible_when_invalid:${fieldLabel}:op_invalid:${opRaw}`,
    );
  }
  const visibleWhenValue = visibleWhen['value'];
  if (opRaw === 'in' || opRaw === 'not_in') {
    if (!Array.isArray(visibleWhenValue) || visibleWhenValue.length === 0) {
      throw new Error(
        `runtime_model.parameter_schema_field_visible_when_invalid:${fieldLabel}:value_must_be_non_empty_array_for_op:${opRaw}`,
      );
    }
  } else {
    if (Array.isArray(visibleWhenValue) || visibleWhenValue === null || visibleWhenValue === undefined) {
      throw new Error(
        `runtime_model.parameter_schema_field_visible_when_invalid:${fieldLabel}:value_must_be_scalar_for_op:${opRaw}`,
      );
    }
    if (typeof visibleWhenValue !== 'string' && typeof visibleWhenValue !== 'number' && typeof visibleWhenValue !== 'boolean') {
      throw new Error(
        `runtime_model.parameter_schema_field_visible_when_invalid:${fieldLabel}:value_must_be_string_number_or_boolean_for_op:${opRaw}`,
      );
    }
  }
};

export const validateModes = (value: Record<string, unknown>): void => {
  if (value['modes'] === undefined) return;
  const modes = value['modes'];
  if (!Array.isArray(modes)) {
    throw new Error('runtime_model.modes_must_be_array');
  }
  modes.forEach((modeItem, modeIndex) => {
    if (!isRecord(modeItem)) {
      throw new Error(`runtime_model.modes_item_invalid:${modeIndex}`);
    }
    const modeKey = normalizeString(modeItem['key']);
    if (!modeKey) {
      throw new Error(`runtime_model.modes_item_key_missing:${modeIndex}`);
    }
    const modeLabel = normalizeString(modeItem['label']);
    if (!modeLabel) {
      throw new Error(`runtime_model.modes_item_label_missing:${modeIndex}`);
    }
    const overrides = modeItem['parameter_overrides'];
    if (overrides === undefined) return;
    if (!isRecord(overrides)) {
      throw new Error(`runtime_model.modes_item_parameter_overrides_invalid:${modeIndex}`);
    }
    Object.entries(overrides).forEach(([overrideKey, overrideValue]) => {
      if (!isRecord(overrideValue)) {
        throw new Error(
          `runtime_model.modes_item_parameter_overrides_entry_invalid:${modeIndex}:${overrideKey}`,
        );
      }
      const visibility = overrideValue['visibility'];
      if (visibility !== undefined) {
        const visibilityStr = normalizeString(visibility);
        if (visibilityStr !== 'visible' && visibilityStr !== 'hidden') {
          throw new Error(
            `runtime_model.modes_item_parameter_overrides_visibility_invalid:${modeIndex}:${overrideKey}:${String(visibility)}`,
          );
        }
      }
      const required = overrideValue['required'];
      if (required !== undefined) {
        if (typeof required !== 'boolean') {
          throw new Error(
            `runtime_model.modes_item_parameter_overrides_required_invalid:${modeIndex}:${overrideKey}`,
          );
        }
      }
    });
  });
};
