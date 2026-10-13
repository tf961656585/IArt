import { MODEL_ASSET_SUPPORTED_FIELD_COMPONENTS } from "@iart/contracts/model-asset-contract";
import { MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY } from "@iart/contracts/model-asset-contract/protocol-constants";
import type {
  CatalogComponentChoiceOption,
  CatalogComponentProps,
  CatalogDefaultValues,
  CatalogEnumOption,
  CatalogImageSizeAspectPreset,
  CatalogImageSizeConstrainedResolutionConstraints,
  CatalogImageSizeLevelOption,
  CatalogImageConstraints,
  CatalogParameterField,
  CatalogParameterLayout,
  CatalogPort,
  CatalogRawObject,
  CatalogValidationRule,
  CatalogVisibleWhen,
  JsonValue,
} from "./model-package-catalog.types.cts";
import {
  isJsonValue,
  isObjectRecord,
  normalizeFiniteNumber,
  normalizePositiveInteger,
  normalizeString,
  normalizeStringArray,
  notNullish,
  setJsonValue,
} from "./model-package-catalog.shared.cts";

const SUPPORTED_FIELD_COMPONENTS = new Set(
  MODEL_ASSET_SUPPORTED_FIELD_COMPONENTS.map((item) => item.toLowerCase()),
);
/* 「允许空 fields」的例外已移除：那是给对话模型包的（对话没有生成参数表），
   而对话模型已不再由能力包承载。 */
export const validateParameterSchema = (value: unknown) => {
  if (!isObjectRecord(value)) {
    throw new Error("runtime_model.parameter_schema_missing");
  }
  if (!Array.isArray(value.fields) || value.fields.length === 0) {
    throw new Error("runtime_model.parameter_schema_fields_missing");
  }
  value.fields.forEach((field, index) => {
    if (!isObjectRecord(field)) {
      throw new Error(`runtime_model.parameter_schema_field_invalid:${index}`);
    }
    const component = normalizeString(field.component).toLowerCase();
    if (!component) {
      throw new Error(
        `runtime_model.parameter_schema_component_missing:${index}`,
      );
    }
    if (!SUPPORTED_FIELD_COMPONENTS.has(component)) {
      throw new Error(
        `runtime_model.parameter_schema_component_unsupported:${component}`,
      );
    }
  });
};
const normalizePortDataType = (value: unknown) => {
  const normalized = normalizeString(value).toLowerCase();
  if (!normalized) return "any";
  if (["text", "image", "video", "audio", "url", "any"].includes(normalized)) {
    return normalized;
  }
  return "any";
};
const normalizeVisibleWhen = (
  value: unknown,
): CatalogVisibleWhen | undefined => {
  if (!isObjectRecord(value)) return undefined;
  const field = normalizeString(value.field);
  if (!field) return undefined;
  const opRaw = normalizeString(value.op);
  if (opRaw !== "eq" && opRaw !== "neq" && opRaw !== "in" && opRaw !== "not_in") {
    return undefined;
  }
  const rawValue = value.value;
  if (opRaw === "in" || opRaw === "not_in") {
    if (!Array.isArray(rawValue)) return undefined;
    const filtered = rawValue.filter(
      (item): item is string | number | boolean =>
        typeof item === "string" || typeof item === "number" || typeof item === "boolean",
    );
    if (filtered.length === 0) return undefined;
    return { field, op: opRaw, value: filtered };
  }
  if (typeof rawValue === "string" || typeof rawValue === "number" || typeof rawValue === "boolean") {
    return { field, op: opRaw, value: rawValue };
  }
  return undefined;
};
export const normalizePort = (
  value: unknown,
  fallbackIdPrefix: string,
  index: number,
): CatalogPort => {
  const record = isObjectRecord(value) ? value : ({} as CatalogRawObject);
  const id = normalizeString(record.id) || `${fallbackIdPrefix}_${index + 1}`;
  const fieldKey = normalizeString(record.field_key || record.fieldKey) || id;
  return {
    id,
    name: normalizeString(record.name) || id,
    data_type: normalizePortDataType(record.data_type || record.dataType),
    field_key: fieldKey,
    required: record.required === true,
    multiple: record.multiple === true,
    max_connections: Number.isFinite(
      Number(record.max_connections || record.maxConnections),
    )
      ? Number(record.max_connections || record.maxConnections)
      : undefined,
    description: normalizeString(record.description) || undefined,
    visible_when: normalizeVisibleWhen(record.visible_when || record.visibleWhen),
  };
};
const normalizeFieldComponent = (value: unknown) => {
  const normalized = normalizeString(value).toLowerCase();
  if (!normalized) {
    throw new Error("runtime_model.parameter_schema_component_missing");
  }
  if (!SUPPORTED_FIELD_COMPONENTS.has(normalized)) {
    throw new Error(
      `runtime_model.parameter_schema_component_unsupported:${normalized}`,
    );
  }
  if (normalized === "imageupload") return "imageUpload";
  if (normalized === "imagesize") return "imageSize";
  return normalized;
};
const normalizeFieldDataSource = (
  value: unknown,
): "connection" | "form" | "both" | undefined => {
  const normalized = normalizeString(value).toLowerCase();
  if (normalized === "connection") return "connection";
  if (normalized === "form") return "form";
  if (normalized === "both") return "both";
  return undefined;
};
export const normalizeValidationRule = (
  value: unknown,
): CatalogValidationRule | null => {
  if (!isObjectRecord(value)) return null;
  const type = normalizeString(value.type);
  if (!type) return null;
  const normalized = { type } as CatalogValidationRule;
  if ("value" in value) normalized.value = value.value;
  if (typeof value.message === "string" && value.message.trim()) {
    normalized.message = value.message.trim();
  }
  return normalized;
};
const normalizeComponentChoiceOption = (
  value: unknown,
): CatalogComponentChoiceOption | null => {
  if (
    !isObjectRecord(value) ||
    !Object.prototype.hasOwnProperty.call(value, "value")
  )
    return null;
  if (!isJsonValue(value.value)) return null;
  const option = { value: value.value } as CatalogComponentChoiceOption;
  const id = normalizeString(value.id);
  const label = normalizeString(value.label);
  const description = normalizeString(value.description);
  const ratio = normalizeFiniteNumber(value.ratio);
  const resolution = normalizeResolution(value.resolution);
  if (id) option.id = id;
  if (ratio !== null) option.ratio = ratio;
  if (label) option.label = label;
  if (description) option.description = description;
  if (resolution) option.resolution = resolution;
  return option;
};
const normalizeComponentChoiceOptions = (
  value: unknown,
): CatalogComponentChoiceOption[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const options = value
    .map((item) => normalizeComponentChoiceOption(item))
    .filter(notNullish);
  return options.length > 0 ? options : undefined;
};
const normalizeImageSizeLevelOption = (
  value: unknown,
): CatalogImageSizeLevelOption | null => {
  if (!isObjectRecord(value)) return null;
  const id = normalizeString(value.id);
  const label = normalizeString(value.label);
  const pixelBudget = normalizePositiveInteger(value.pixelBudget);
  if (!id || pixelBudget === null) return null;
  return {
    id,
    ...(label ? { label } : {}),
    pixelBudget,
  } as CatalogImageSizeLevelOption;
};
const normalizeImageSizeLevelOptions = (
  value: unknown,
): CatalogImageSizeLevelOption[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const options = value
    .map((item) => normalizeImageSizeLevelOption(item))
    .filter(notNullish);
  return options.length > 0 ? options : undefined;
};
const normalizeImageSizeAspectPreset = (
  value: unknown,
): CatalogImageSizeAspectPreset | null => {
  if (!isObjectRecord(value)) return null;
  const id = normalizeString(value.id);
  const label = normalizeString(value.label);
  const ratio = normalizeFiniteNumber(value.ratio);
  if (!id || ratio === null || ratio <= 0) return null;
  return {
    id,
    ...(label ? { label } : {}),
    ratio,
  } as CatalogImageSizeAspectPreset;
};
const normalizeImageSizeAspectPresets = (
  value: unknown,
): CatalogImageSizeAspectPreset[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const options = value
    .map((item) => normalizeImageSizeAspectPreset(item))
    .filter(notNullish);
  return options.length > 0 ? options : undefined;
};
const normalizeImageConstraints = (
  value: unknown,
): CatalogImageConstraints | undefined => {
  if (!isObjectRecord(value)) return undefined;
  const constraints = {} as CatalogImageConstraints;
  const minWidth = normalizeFiniteNumber(value.minWidth);
  const minHeight = normalizeFiniteNumber(value.minHeight);
  const maxWidth = normalizeFiniteNumber(value.maxWidth);
  const maxHeight = normalizeFiniteNumber(value.maxHeight);
  if (value.allowedMimeTypes !== undefined) {
    constraints.allowedMimeTypes = normalizeStringArray(value.allowedMimeTypes);
  }
  if (minWidth !== null) constraints.minWidth = minWidth;
  if (minHeight !== null) constraints.minHeight = minHeight;
  if (maxWidth !== null) constraints.maxWidth = maxWidth;
  if (maxHeight !== null) constraints.maxHeight = maxHeight;
  if (typeof value.disallowPngTransparency === "boolean") {
    constraints.disallowPngTransparency = value.disallowPngTransparency;
  }
  return constraints;
};
type CatalogResolutionRaw = CatalogRawObject & {
  width: JsonValue | undefined;
  height: JsonValue | undefined;
};

const isResolutionRaw = (value: unknown): value is CatalogResolutionRaw =>
  isObjectRecord(value);

const normalizeResolution = (
  value: unknown,
): { width: number; height: number } | undefined => {
  if (!isResolutionRaw(value)) return undefined;
  const width = normalizePositiveInteger(value.width);
  const height = normalizePositiveInteger(value.height);
  if (width === null || height === null) return undefined;
  return { width, height };
};
const normalizeConstrainedResolutionConstraints = (
  value: unknown,
): CatalogImageSizeConstrainedResolutionConstraints | undefined => {
  if (!isObjectRecord(value)) return undefined;
  const dimensionMultiple = normalizePositiveInteger(value.dimensionMultiple);
  const maxLongEdge = normalizePositiveInteger(value.maxLongEdge);
  const minPixels = normalizeFiniteNumber(value.minPixels);
  const maxPixels = normalizeFiniteNumber(value.maxPixels);
  const maxAspectRatio = normalizeFiniteNumber(value.maxAspectRatio);
  if (
    dimensionMultiple === null ||
    maxLongEdge === null ||
    minPixels === null ||
    maxPixels === null ||
    maxAspectRatio === null
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
const normalizeComponentProps = (
  value: unknown,
): CatalogComponentProps | undefined => {
  if (!isObjectRecord(value)) return undefined;
  const props = {} as CatalogComponentProps;
  const minRows = normalizePositiveInteger(value.minRows);
  const maxRows = normalizePositiveInteger(value.maxRows);
  const maxFiles = normalizePositiveInteger(value.maxFiles);
  const maxSizeMB = normalizeFiniteNumber(value.maxSizeMB);
  const accept = normalizeString(value.accept);
  const imageResizeMode = normalizeString(value.imageResizeMode);
  const aspectField = normalizeString(value.aspectField);
  const mode = normalizeString(value.mode);
  if (mode) props.mode = mode;
  if (minRows !== null) props.minRows = minRows;
  if (maxRows !== null) props.maxRows = maxRows;
  if (accept) props.accept = accept;
  if (maxFiles !== null) props.maxFiles = maxFiles;
  if (typeof value.showCounter === "boolean")
    props.showCounter = value.showCounter;
  if (maxSizeMB !== null) props.maxSizeMB = maxSizeMB;
  props.imageConstraints = normalizeImageConstraints(value.imageConstraints);
  if (typeof value.allowMultiple === "boolean")
    props.allowMultiple = value.allowMultiple;
  if (imageResizeMode) props.imageResizeMode = imageResizeMode;
  if (typeof value.clearable === "boolean") props.clearable = value.clearable;
  if (typeof value.exclusive === "boolean") props.exclusive = value.exclusive;
  props.sizeOptions = normalizeComponentChoiceOptions(value.sizeOptions);
  if (aspectField) props.aspectField = aspectField;
  props.aspectOptions = normalizeComponentChoiceOptions(value.aspectOptions);
  if (typeof value.allowAuto === "boolean") props.allowAuto = value.allowAuto;
  props.sizeLevels = normalizeImageSizeLevelOptions(value.sizeLevels);
  props.aspectPresets = normalizeImageSizeAspectPresets(value.aspectPresets);
  props.presetOptions = normalizeComponentChoiceOptions(value.presetOptions);
  props.customPresets = normalizeComponentChoiceOptions(value.customPresets);
  props.constraints = normalizeConstrainedResolutionConstraints(
    value.constraints,
  );
  return props;
};
const normalizeParameterLayout = (
  value: unknown,
): CatalogParameterLayout | undefined => {
  if (!isObjectRecord(value)) return undefined;
  const layout = {} as CatalogParameterLayout;
  const colSpan = normalizePositiveInteger(value.colSpan);
  const dockPresentation = normalizeString(value.dockPresentation);
  if (colSpan !== null) layout.colSpan = colSpan;
  if (dockPresentation) layout.dockPresentation = dockPresentation;
  return layout;
};
export const normalizeParameterField = (
  value: unknown,
  index: number,
): CatalogParameterField => {
  const record = isObjectRecord(value) ? value : ({} as CatalogRawObject);
  const fieldKey =
    normalizeString(record.field_key || record.fieldKey) ||
    `field_${index + 1}`;
  if (!normalizeString(record.component)) {
    throw new Error(
      `runtime_model.parameter_schema_component_missing:${index}`,
    );
  }
  const component = normalizeFieldComponent(record.component);
  const enumOptions = record.enum_options || record.enumOptions;
  const componentPropsSource = record.component_props || record.componentProps;
  const options = Array.isArray(enumOptions)
    ? enumOptions
        .map((item) => {
          if (!isObjectRecord(item)) return null;
          if (!Object.prototype.hasOwnProperty.call(item, "value")) return null;
          if (!isJsonValue(item.value)) return null;
          const label = normalizeString(item.label);
          return label ? ({ value: item.value, label } as CatalogEnumOption) : ({ value: item.value } as CatalogEnumOption);
        })
        .filter(notNullish)
    : undefined;
  const dataSourceRaw =
    record.data_source || record.dataSource;
  const dataSource = normalizeFieldDataSource(dataSourceRaw);

  const visibleWhenSource = record.visible_when || record.visibleWhen;
  const visible_when = normalizeVisibleWhen(visibleWhenSource);

  return {
    field_key: fieldKey,
    label: normalizeString(record.label) || fieldKey,
    description: normalizeString(record.description) || undefined,
    component,
    component_props: normalizeComponentProps(componentPropsSource),
    data_source: dataSource,
    required: record.required === true,
    default_value: Object.prototype.hasOwnProperty.call(record, "default_value")
      ? record.default_value
      : Object.prototype.hasOwnProperty.call(record, "defaultValue")
        ? record.defaultValue
        : undefined,
    enum_options: options,
    validation_rules: (() => {
      const rulesSource = record.validation_rules || record.validationRules;
      if (!Array.isArray(rulesSource)) return undefined;
      return rulesSource
        .map((rule) => normalizeValidationRule(rule))
        .filter(notNullish);
    })(),
    layout: normalizeParameterLayout(record.layout),
    visible_when,
    metadata: isObjectRecord(record.metadata) ? record.metadata : undefined,
  };
};
const setDefaultValueByFieldKey = (
  defaults: CatalogDefaultValues,
  fieldKey: string,
  value: JsonValue | undefined,
) => {
  // `__prompt` 是提示词保留键（不是模型参数），default_values 禁止出现
  // （contracts protocol-constants）；其余字段键一律透传，不做白名单裁剪。
  if (fieldKey === MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY) return;
  setJsonValue(defaults, fieldKey, value);
};
export const normalizeDefaultValues = (
  value: unknown,
  fields: CatalogParameterField[],
): CatalogDefaultValues => {
  const defaults = {} as CatalogDefaultValues;
  const source = isObjectRecord(value) ? value : null;
  for (const field of fields) {
    const sourceValue = source ? source[field.field_key] : undefined;
    if (
      source &&
      Object.prototype.hasOwnProperty.call(source, field.field_key)
    ) {
      setDefaultValueByFieldKey(defaults, field.field_key, sourceValue);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(field, "default_value")) {
      setDefaultValueByFieldKey(defaults, field.field_key, field.default_value);
    }
  }
  return defaults;
};

export const validatePortFieldKeyConsistency = ({
  inputPorts,
  parameterFields,
  packageId,
}: {
  inputPorts: CatalogPort[];
  parameterFields: CatalogParameterField[];
  packageId: string;
}): void => {
  if (parameterFields.length === 0) {
    return;
  }
  const fieldKeySet = new Set(parameterFields.map((field) => field.field_key));
  const mismatches: string[] = [];
  for (const port of inputPorts) {
    if (!fieldKeySet.has(port.field_key)) {
      mismatches.push(port.field_key);
    }
  }
  if (mismatches.length > 0) {
    throw new Error(
      `port_field_key_not_in_parameter_schema:[${packageId}]${mismatches.join(",")}`,
    );
  }
};
