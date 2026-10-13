import type { ModelConfigEntry } from "@/client/config/models.config";
import type { SchemaGenerationPayload } from "@/client/types/generation";
import {
  isCustomFormConfig,
  isSchemaFormConfig,
  type ModelFormSubmitContext,
} from "@/features/workspace/modelFormTypes";
import type { SchemaFormValues, SchemaFormDefinition } from "@/features/workspace/schema/types";
import type { SchemaFieldOption, SchemaOptionSource } from "@/features/workspace/schema/types";
import type { DynamicRecord } from "@/client/utils/typeGuards";
import { deriveInitialValues, traverseFields } from "@/features/workspace/schema/helpers";
import { buildSchemaPayload } from "@/features/workspace/schema/buildPayload";
import { MODEL_UNUSABLE_TEXT } from "@/features/workspace/modelFailureText";
import { normalizeConstrainedImageSizeValue } from "@/client/components/imageSizeConstrainedResolutionMath";

type SchemaModule =
  | SchemaFormDefinition<string>
  | { default: SchemaFormDefinition<string> }
  | { schema: SchemaFormDefinition<string> };

type ModelOptionField = {
  key: "model";
  type: "select" | "radio" | "toggle";
  options: SchemaOptionSource<string>;
};

type RecordWithModelField = DynamicRecord & {
  model: unknown;
};

type SchemaValuesWithModelField = SchemaFormValues<string> & {
  model: unknown | undefined;
};

const isModelOptionField = (field: unknown): field is ModelOptionField => {
  if (!field || typeof field !== "object") return false;
  const candidate = field as { key: unknown | undefined; type: unknown | undefined; options: unknown | undefined };
  return (
    candidate.key === "model" &&
    (candidate.type === "select" || candidate.type === "radio" || candidate.type === "toggle")
  );
};

const isStaticOptionSource = (
  source: SchemaOptionSource<string> | undefined
): source is { kind: "static"; options: SchemaFieldOption[] } =>
  Boolean(source && source.kind === "static" && Array.isArray(source.options));

const hasModelField = (value: unknown): value is RecordWithModelField => {
  if (!value || typeof value !== "object" || value instanceof FormData) {
    return false;
  }
  return Object.prototype.hasOwnProperty.call(value, "model");
};

const schemaCache = new Map<string, Promise<SchemaFormDefinition<string>>>();

const resolveSchemaDefinition = (mod: SchemaModule): SchemaFormDefinition<string> => {
  if (!mod) {
    throw new Error("schema 模块未返回有效定义");
  }
  if (typeof mod === "object") {
    if ("schema" in mod && mod.schema) {
      return mod.schema as SchemaFormDefinition<string>;
    }
    if ("default" in mod && mod.default) {
      return mod.default as SchemaFormDefinition<string>;
    }
  }
  return mod as SchemaFormDefinition<string>;
};

const normalizeSchemaLoadError = (modelId: string, reason: unknown): Error => {
  const detail =
    reason instanceof Error
      ? reason.message
      : typeof reason === "string"
        ? reason
        : String(reason);
  // 细节只进日志，界面只说用户能处理的话（docs/ui-copy-standard.md 第 4 条）。
  console.error("[modelFormAdapter] 模型表单加载失败", { modelId, detail: detail || "未知错误" });
  return new Error(MODEL_UNUSABLE_TEXT);
};

export const loadWorkspaceSchema = async (
  config: ModelConfigEntry
): Promise<SchemaFormDefinition<string>> => {
  const modelId = config.modelId ?? config.modelId;

  const cached = schemaCache.get(modelId);
  if (cached) {
    return cached;
  }

  const formConfig = (config.workspace !== null && config.workspace !== undefined ? config.workspace.form : undefined);
  if (!isSchemaFormConfig(formConfig)) {
    console.error("[modelFormAdapter] 模型未配置表单", { modelId });
    throw new Error(MODEL_UNUSABLE_TEXT);
  }

  const loadPromise = Promise.resolve()
    .then(() => formConfig.load())
    .then((mod) => resolveSchemaDefinition(mod))
    .catch((reason) => {
      throw normalizeSchemaLoadError(modelId, reason);
    });

  const managedPromise = loadPromise.catch((error) => {
    schemaCache.delete(modelId);
    throw error;
  });

  schemaCache.set(modelId, managedPromise);
  return managedPromise;
};

export const normalizeSchemaValues = (
  schema: SchemaFormDefinition<string>,
  rawValues: unknown,
  modelId: string | undefined
): SchemaFormValues<string> => {
  const defaults = deriveInitialValues(schema);
  if (!rawValues || typeof rawValues !== "object" || rawValues instanceof FormData) {
    return defaults;
  }

  const normalized: SchemaFormValues<string> = { ...defaults };
  const entries = Object.entries(rawValues as DynamicRecord);
  entries.forEach(([key, value]) => {
    normalized[key] = value;
  });

  // 提交链路兜底：约束版 imageSize 字段的尺寸值在提交前投影为合法值，
  // 保证旧存档、API 等任何入口进来的值都合规（"auto" 原样放过）。
  traverseFields(schema.fields, (field) => {
    if (field.type !== "imageSize" || field.mode !== "constrainedResolution") return;
    const rawSize = normalized[field.key];
    if (typeof rawSize !== "string") return;
    const normalizedSize = normalizeConstrainedImageSizeValue(
      rawSize,
      field.constraints,
      field.allowAuto === true,
    );
    if (normalizedSize === undefined) return;
    if (normalizedSize !== rawSize) {
      console.debug(
        `[modelFormAdapter] imageSize 字段 ${field.key} 的尺寸值已按约束归一化: ${rawSize} -> ${normalizedSize}`,
      );
      normalized[field.key] = normalizedSize;
    }
  });
  const normalizedWithModel = normalized as SchemaValuesWithModelField;
  const defaultsWithModel = defaults as SchemaValuesWithModelField;

  // Canvas 场景不会运行 schema 的 mount events；当 schema 内存在 `model` 字段且 modelId 恰好为其静态选项之一时，
  // 使用当前模型的 modelId 作为默认值（仅在用户未提供有效 model 值时）。
  if (modelId) {
    let modelField: ModelOptionField | undefined;
    traverseFields(schema.fields, (field) => {
      if (modelField) return;
      if (isModelOptionField(field)) {
        modelField = field;
      }
    });

    const source = modelField ? modelField.options : undefined;
    if (isStaticOptionSource(source)) {
      const allowed = new Set(source.options.map((opt) => String(opt.value ?? "")));
      if (allowed.has(modelId)) {
        const rawHasModel = hasModelField(rawValues);
        const rawModelValue = rawHasModel ? rawValues.model : undefined;
        const rawModelAllowed = allowed.has(String(rawModelValue ?? ""));

        const currentModelValue = normalizedWithModel.model;
        const currentModel = String(currentModelValue ?? "");
        const defaultModel = String(defaultsWithModel.model ?? "");

        if (!rawHasModel || !rawModelAllowed || currentModel === defaultModel) {
          normalizedWithModel.model = modelId;
        }
      }
    }
  }

  return normalized;
};

export const buildPayloadFromConfig = async (
  config: ModelConfigEntry,
  values: unknown
): Promise<SchemaGenerationPayload> => {
  const modelId = config.modelId ?? config.modelId;
  const formConfig = (config.workspace !== null && config.workspace !== undefined ? config.workspace.form : undefined);
  if (!formConfig) {
    console.error("[modelFormAdapter] 模型未配置任何表单", { modelId });
    throw new Error(MODEL_UNUSABLE_TEXT);
  }

  if (isCustomFormConfig(formConfig)) {
    const context: ModelFormSubmitContext<unknown> = {
      modelId,
      values,
    };
    return formConfig.buildPayload(values, context);
  }

  if (isSchemaFormConfig(formConfig)) {
    const schema = await loadWorkspaceSchema(config);
    const normalizedValues = normalizeSchemaValues(schema, values, modelId);
    return buildSchemaPayload({
      schema,
      values: normalizedValues,
      modelId,
      runtime: undefined,
    });
  }

  console.error("[modelFormAdapter] 模型使用了未知的表单配置类型", { modelId });
  throw new Error(MODEL_UNUSABLE_TEXT);
};
