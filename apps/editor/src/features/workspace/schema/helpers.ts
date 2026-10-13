import type {
  SchemaCondition,
  SchemaConditionContext,
  SchemaDataFieldDefinition,
  SchemaFieldDefinition,
  SchemaFieldEvent,
  SchemaFieldEventContext,
  SchemaFieldKey,
  SchemaDockPresentation,
  SchemaFieldType,
  SchemaFormDefinition,
  SchemaFormValues,
  SchemaFileField,
  SchemaImageUploadField,
  SchemaStructuralFieldDefinition,
} from "./types";
import type { DynamicRecord } from "@/client/utils/typeGuards";

export type SchemaFieldDictionary<FieldKey extends string = SchemaFieldKey> = Map<
  FieldKey,
  SchemaDataFieldDefinition<FieldKey>
>;

export interface SchemaFieldRuntimeState<FieldKey extends string = SchemaFieldKey> {
  visible: boolean;
  disabled: boolean;
  definition: SchemaDataFieldDefinition<FieldKey>;
}

export type SchemaFieldEventKind = SchemaFieldEvent["kind"];

export const isStructuralField = <FieldKey extends string = SchemaFieldKey>(
  field: SchemaFieldDefinition<FieldKey>
): field is SchemaStructuralFieldDefinition<FieldKey> => field.type === "group" || field.type === "divider";

export const isDataField = <FieldKey extends string = SchemaFieldKey>(
  field: SchemaFieldDefinition<FieldKey>
): field is SchemaDataFieldDefinition<FieldKey> => !isStructuralField(field);

export const traverseFields = <FieldKey extends string = SchemaFieldKey>(
  fields: Array<SchemaFieldDefinition<FieldKey>>,
  visitor: (field: SchemaFieldDefinition<FieldKey>) => void
): void => {
  fields.forEach((field) => {
    visitor(field);
    if (field.type === "group") {
      traverseFields(field.children, visitor);
    }
  });
};

export const buildFieldDictionary = <FieldKey extends string = SchemaFieldKey>(
  schema: SchemaFormDefinition<FieldKey>
): SchemaFieldDictionary<FieldKey> => {
  const map: SchemaFieldDictionary<FieldKey> = new Map();
  traverseFields(schema.fields, (field) => {
    if (isDataField(field)) {
      map.set(field.key, field);
    }
  });
  return map;
};

export const deriveInitialValues = <FieldKey extends string = SchemaFieldKey>(
  schema: SchemaFormDefinition<FieldKey>
): SchemaFormValues<FieldKey> => {
  const defaults = schema.defaults ?? {};
  const values: SchemaFormValues<FieldKey> = { ...defaults } as SchemaFormValues<FieldKey>;

  traverseFields(schema.fields, (field) => {
    if (!isDataField(field)) {
      return;
    }
    const key = field.key;
    if (values[key] !== undefined) {
      return;
    }
    if (field.defaultValue !== undefined) {
      values[key] = cloneUnknownValue(field.defaultValue);
      return;
    }
    values[key] = createFallbackValue(field);
  });

  return values;
};

const cloneUnknownValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => cloneUnknownValue(item));
  }
  if (value && typeof value === "object") {
    return { ...(value as DynamicRecord) };
  }
  return value;
};

const hasNumericMaxFiles = (field: unknown): field is { maxFiles: number | undefined } =>
  Boolean(field && typeof field === "object" && "maxFiles" in field);

const createFallbackValue = <FieldKey extends string>(
  field: SchemaDataFieldDefinition<FieldKey>
): unknown => {
  switch (field.type) {
    case "text":
    case "textarea":
    case "select":
    case "radio":
      return "";
    case "switch":
      return false;
    case "toggle":
      return field.exclusive === false ? [] : "";
    case "tags":
    case "file":
    case "imageUpload":
      return [];
    case "imageSize":
      return "";
    case "number":
      return field.min ?? field.max ?? 0;
    case "slider":
      return field.min;
    default:
      return undefined;
  }
};

/**
 * 统一解析上传字段的最大文件数，支持静态 maxFiles 与基于字段值/模型的动态映射。
 */
export const resolveUploadMaxFiles = <FieldKey extends string>(
  field: SchemaDataFieldDefinition<FieldKey>,
  values: SchemaFormValues<FieldKey>,
  modelId: string | undefined
): number => {
  const fallback =
    field.type === "file" && (field as SchemaFileField<FieldKey>).allowMultiple === false ? 1 : 3;
  const normalize = (value: unknown, defaultValue: number): number => {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      return defaultValue;
    }
    return Math.max(1, Math.floor(value));
  };

  if (field.type === "imageUpload") {
    const uploadField = field as SchemaImageUploadField<FieldKey>;
    const staticMax = normalize(uploadField.maxFiles, fallback);
    const mapConfig = uploadField.maxFilesMap;
    if (!mapConfig) {
      return staticMax;
    }

    const mapField = mapConfig.field;
    const rawMapValue = (values !== null && values !== undefined ? values[mapField] : undefined);
    const mapValue =
      rawMapValue === undefined || rawMapValue === null ? "" : String(rawMapValue);
    const mapped =
      mapConfig.map[mapValue] ??
      (modelId ? mapConfig.map[modelId] : undefined) ??
      mapConfig.default;

    return normalize(mapped, staticMax);
  }

  if (field.type === "file") {
    const fileField = field as SchemaFileField<FieldKey>;
    return normalize(fileField.maxFiles, fallback);
  }

  return hasNumericMaxFiles(field) ? normalize(field.maxFiles, fallback) : fallback;
};

export const evaluateCondition = async <FieldKey extends string = SchemaFieldKey>(
  condition: SchemaCondition<FieldKey> | undefined,
  context: SchemaConditionContext<FieldKey>
): Promise<boolean> => {
  if (!condition) return true;
  if (typeof condition === "function") {
    const result = await condition(context);
    return Boolean(result);
  }

  switch (condition.op) {
    case "and": {
      for (const child of condition.conditions) {
        if (!(await evaluateCondition(child, context))) return false;
      }
      return true;
    }
    case "or": {
      for (const child of condition.conditions) {
        if (await evaluateCondition(child, context)) return true;
      }
      return false;
    }
    case "not":
      return !(await evaluateCondition(condition.condition, context));
    case "eq":
      return compareValues(getFieldValue(context, condition.field), condition.value) === 0;
    case "ne":
      return compareValues(getFieldValue(context, condition.field), condition.value) !== 0;
    case "gt":
      return compareValues(getFieldValue(context, condition.field), condition.value) > 0;
    case "gte":
      return compareValues(getFieldValue(context, condition.field), condition.value) >= 0;
    case "lt":
      return compareValues(getFieldValue(context, condition.field), condition.value) < 0;
    case "lte":
      return compareValues(getFieldValue(context, condition.field), condition.value) <= 0;
    case "includes": {
      const actual = getFieldValue(context, condition.field);
      if (Array.isArray(actual)) {
        return actual.some((item) => compareValues(item, condition.value) === 0);
      }
      if (typeof actual === "string") {
        return actual.includes(String(condition.value));
      }
      return false;
    }
    case "excludes": {
      const actual = getFieldValue(context, condition.field);
      if (Array.isArray(actual)) {
        return actual.every((item) => compareValues(item, condition.value) !== 0);
      }
      if (typeof actual === "string") {
        return !actual.includes(String(condition.value));
      }
      return true;
    }
    case "truthy":
      return Boolean(getFieldValue(context, condition.field));
    case "falsy":
      return !getFieldValue(context, condition.field);
    default:
      return true;
  }
};

const getFieldValue = <FieldKey extends string>(
  context: SchemaConditionContext<FieldKey>,
  field: FieldKey
): unknown => context.values[field];

const compareValues = (a: unknown, b: unknown): number => {
  if (a === b) return 0;
  if (typeof a === "number" && typeof b === "number") {
    return a - b;
  }
  const left = typeof a === "string" ? a : String(a ?? "");
  const right = typeof b === "string" ? b : String(b ?? "");
  if (left === right) return 0;
  return left > right ? 1 : -1;
};

export const runFieldEvents = async <FieldKey extends string = SchemaFieldKey>(
  field: SchemaDataFieldDefinition<FieldKey>,
  kind: SchemaFieldEventKind,
  value: unknown,
  context: SchemaFieldEventContext<FieldKey>
): Promise<Partial<SchemaFormValues<FieldKey>> | undefined> => {
  if (!field.events || field.events.length === 0) {
    return undefined;
  }

  let accumulated: Partial<SchemaFormValues<FieldKey>> | undefined;
  for (const event of field.events) {
    if (event.kind !== kind) continue;
    const shouldRun = await evaluateCondition(event.when, {
      field: field.key,
      schema: context.schema,
      values: context.values,
      modelId: context.modelId,
    });
    if (!shouldRun) continue;
    const result = await event.handler(value, context);
    if (result && typeof result === "object") {
      accumulated = { ...(accumulated ?? {}), ...result };
    }
  }
  return accumulated;
};

/**
 * 根据字段类型获取默认的 Dock 呈现模式
 * @param fieldType - Schema 字段类型
 * @returns 默认的 Dock 呈现模式
 */
export const getDefaultDockPresentation = (
  fieldType: SchemaFieldType
): SchemaDockPresentation => {
  switch (fieldType) {
    // 复合字段需要弹出完整 UI
    case "imageSize":
    case "slider":
    case "tags":
    case "shotList":
      return "popover";

    // 文件/图片上传由独立按钮处理，Dock 中隐藏
    case "imageUpload":
    case "file":
      return "hidden";

    // textarea 通常是主 prompt，由顶部区域处理
    case "textarea":
      return "hidden";

    // 结构型字段不在 Dock 显示
    case "group":
    case "divider":
      return "hidden";

    // 其他紧凑字段直接内联显示
    default:
      return "inline";
  }
};
