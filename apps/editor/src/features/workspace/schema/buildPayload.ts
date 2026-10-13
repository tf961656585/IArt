import type { TaskType } from "@/client/adapters/types";
import type { ApiRequestConfig } from "@/client/adapters/types";
import type { SchemaGenerationPayload } from "@/client/types/generation";
import { isUnknownRecord, type DynamicRecord } from "@/client/utils/typeGuards";
import type { ModelAssetMediaTargetShape } from "@iart/contracts/model-asset-contract";
import { isFormData } from "./buildPayloadRuntimeUploads";
import { GENERATION_PREPARE_FAILED_TEXT, MODEL_UNUSABLE_TEXT } from "../modelFailureText";
import { evaluateCondition } from "./helpers";
import { normalizeShotListValue, timelineToNarrative } from "./buildPayloadShotList";
import type {
  SchemaBuildContext,
  SchemaBuiltinTransform,
  SchemaComputedValue,
  SchemaCondition,
  SchemaFieldKey,
  SchemaPayloadDefinition,
  SchemaValueExpression,
  SchemaValueTransform,
  SchemaValueTransformFactory,
} from "./types";

type PathSegment = string | number;
type UnknownArray = unknown[];
type DynamicContainer = DynamicRecord<unknown> | UnknownArray;

interface ValueEvaluationState<FieldKey extends string = SchemaFieldKey> {
  context: SchemaBuildContext<FieldKey>;
  computeCache: Map<string | SchemaComputedValue<FieldKey>, Promise<unknown>>;
}

const isUnknownArray = (value: unknown): value is UnknownArray => Array.isArray(value);

const splitMultilineText = (value: unknown): string[] => {
  if (typeof value !== "string") return [];
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
};

const compactArrayValues = (value: unknown): unknown[] => {
  if (!isUnknownArray(value)) return [];
  return value.filter((item) => {
    if (item === null || item === undefined) return false;
    if (typeof item === "string") return item.trim().length > 0;
    return true;
  });
};

const createBuiltinTransforms = <FieldKey extends string>(): Record<SchemaBuiltinTransform, SchemaValueTransformFactory<FieldKey>> => ({
  trim: async (value) => (typeof value === "string" ? value.trim() : value),
  toLowerCase: async (value) => (typeof value === "string" ? value.toLowerCase() : value),
  toUpperCase: async (value) => (typeof value === "string" ? value.toUpperCase() : value),
  toNumber: async (value) => {
    if (value === undefined || value === null || value === "") return undefined;
    const num = Number(value);
    return Number.isFinite(num) ? num : undefined;
  },
  ensureArray: async (value) => {
    if (isUnknownArray(value)) return Array.from(value);
    if (value === undefined || value === null) return [];
    return [value];
  },
  first: async (value) => {
    if (isUnknownArray(value)) {
      const [firstValue] = value;
      return firstValue;
    }
    return value;
  },
  splitLines: async (value) => splitMultilineText(value),
  compactArray: async (value) => compactArrayValues(value),
  last: async (value) => {
    if (isUnknownArray(value)) {
      const values = Array.from(value);
      return values.at(-1);
    }
    return value;
  },
  shotListToTimeline: async (value) => normalizeShotListValue(value),
  timelineToScript: async (value) => timelineToNarrative(value),
});

const BUILTIN_TRANSFORMS = createBuiltinTransforms<SchemaFieldKey>();

const isObjectLike = isUnknownRecord;

const parsePath = (path: string): PathSegment[] => {
  if (!path) return [];
  const segments: PathSegment[] = [];
  const pattern = /([^.[\]]+)|(\[(\d+)\])/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(path)) !== null) {
    if (match[1]) {
      segments.push(match[1]);
    } else if (match[3]) {
      segments.push(Number.parseInt(match[3], 10));
    }
  }
  return segments;
};

const createDefaultBody = (format: SchemaPayloadDefinition["format"] | undefined): DynamicRecord<unknown> | FormData => {
  if (format === "multipart") {
    if (typeof FormData === "undefined") {
      throw new Error("当前环境不支持 FormData，无法构建 multipart 请求");
    }
    return new FormData();
  }
  return {};
};

const createDefaultApiConfig = (): ApiRequestConfig => ({
  endpoint: undefined,
  method: undefined,
  headers: undefined,
  contentType: undefined,
  taskType: undefined,
  responseHandling: undefined,
});

const createDefaultMeta = (): NonNullable<SchemaGenerationPayload["meta"]> => ({
  _tempTaskId: undefined,
  _historyId: undefined,
});

const buildFormDataKey = (segments: PathSegment[]): string =>
  segments
    .map((segment, index) => {
      if (typeof segment === "number") {
        return `[${segment}]`;
      }
      return index === 0 ? segment : `.${segment}`;
    })
    .join("")
    .replace(/^\./, "");

const appendFormDataValue = (formData: FormData, key: string, value: unknown): void => {
  if (value === undefined || value === null) {
    return;
  }
  const appendEntry = (entry: unknown) => {
    if (entry === undefined || entry === null) return;
    const isFile = typeof File !== "undefined" && entry instanceof File;
    const isBlob = typeof Blob !== "undefined" && entry instanceof Blob;
    if (isFile) {
      formData.append(key, entry, entry.name);
      return;
    }
    if (isBlob) {
      formData.append(key, entry);
      return;
    }
    if (Array.isArray(entry)) {
      entry.forEach((item) => appendEntry(item));
      return;
    }
    if (typeof entry === "object") {
      formData.append(key, JSON.stringify(entry));
      return;
    }
    formData.append(key, String(entry));
  };

  appendEntry(value);
};

const createPathContainer = (nextSegment: PathSegment | undefined): DynamicContainer =>
  typeof nextSegment === "number" ? [] : {};

const ensureArrayChildContainer = (
  parent: unknown[],
  segment: number,
  nextSegment: PathSegment | undefined
): DynamicContainer => {
  const current = parent[segment];
  if (current === undefined || current === null) {
    const created = createPathContainer(nextSegment);
    parent[segment] = created;
    return created;
  }
  if (typeof nextSegment === "number" && !isUnknownArray(current)) {
    const created: unknown[] = [];
    parent[segment] = created;
    return created;
  }
  if (typeof nextSegment === "string" && !isObjectLike(current)) {
    const created: DynamicRecord<unknown> = {};
    parent[segment] = created;
    return created;
  }
  if (isUnknownArray(current) || isObjectLike(current)) {
    return current;
  }
  const created = createPathContainer(nextSegment);
  parent[segment] = created;
  return created;
};

const ensureObjectChildContainer = (
  parent: DynamicRecord<unknown>,
  segment: string,
  nextSegment: PathSegment | undefined
): DynamicContainer => {
  const current = parent[segment];
  if (current === undefined || current === null) {
    const created = createPathContainer(nextSegment);
    parent[segment] = created;
    return created;
  }
  if (typeof nextSegment === "number" && !isUnknownArray(current)) {
    const created: unknown[] = [];
    parent[segment] = created;
    return created;
  }
  if (typeof nextSegment !== "number" && !isObjectLike(current)) {
    const created: DynamicRecord<unknown> = {};
    parent[segment] = created;
    return created;
  }
  if (isUnknownArray(current) || isObjectLike(current)) {
    return current;
  }
  const created = createPathContainer(nextSegment);
  parent[segment] = created;
  return created;
};

const ensureChildContainer = (
  parent: DynamicContainer,
  segment: PathSegment,
  nextSegment: PathSegment | undefined
): DynamicContainer => {
  if (typeof segment === "number") {
    if (!isUnknownArray(parent)) {
      throw new Error("路径定义与数据结构不匹配，期望数组却找到非数组节点");
    }
    return ensureArrayChildContainer(parent, segment, nextSegment);
  }
  if (isUnknownArray(parent)) {
    throw new Error("路径定义与数据结构不匹配，期望对象却找到数组节点");
  }
  return ensureObjectChildContainer(parent, segment, nextSegment);
};

const assignValue = (
  payload: SchemaGenerationPayload,
  path: string,
  value: unknown,
  format: SchemaPayloadDefinition["format"] | undefined
): void => {
  if (value === undefined) return;
  const segments = parsePath(path);
  if (segments.length === 0) return;

  // FormData 专用写入
  if (segments[0] === "body" && segments.length > 1) {
    if (!payload.body) {
      payload.body = createDefaultBody(format);
    }
    if (isFormData(payload.body)) {
      const key = buildFormDataKey(segments.slice(1));
      appendFormDataValue(payload.body, key, value);
      return;
    }
  }

  let target: DynamicContainer = payload;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    const next = segments[i + 1];
    if (segment === undefined) {
      return;
    }

    if (segment === "body" && payload.body === undefined) {
      payload.body = createDefaultBody(format);
    }
    if (segment === "body" && payload.body !== undefined) {
      if (isFormData(payload.body)) {
        throw new Error("multipart body 不支持嵌套对象路径写入");
      }
      target = payload.body;
      continue;
    }
    if (segment === "api") {
      if (!payload.api) {
        payload.api = createDefaultApiConfig();
      }
      const apiTarget = payload.api;
      if (!isObjectLike(apiTarget)) {
        console.error("[buildPayload] payload.api 不是对象，无法写入", { path });
        throw new Error(GENERATION_PREPARE_FAILED_TEXT);
      }
      target = apiTarget;
      continue;
    }
    if (segment === "meta") {
      if (!payload.meta) {
        payload.meta = createDefaultMeta();
      }
      target = payload.meta;
      continue;
    }

    target = ensureChildContainer(target, segment, next);
  }

  const last = segments[segments.length - 1];
  if (last === undefined) {
    return;
  }
  if (last === "body") {
    payload.body = value as NonNullable<SchemaGenerationPayload["body"]>;
    return;
  }
  if (last === "api") {
    payload.api = value as NonNullable<SchemaGenerationPayload["api"]>;
    return;
  }
  if (last === "meta") {
    payload.meta = value as NonNullable<SchemaGenerationPayload["meta"]>;
    return;
  }

  if (typeof last === "number") {
    if (!isUnknownArray(target)) {
      console.error("[buildPayload] 路径无法写入索引", { path, last });
      throw new Error(GENERATION_PREPARE_FAILED_TEXT);
    }
    target[last] = value;
    return;
  }

  if (isUnknownArray(target)) {
    console.error("[buildPayload] 路径无法写入属性", { path, last });
    throw new Error(GENERATION_PREPARE_FAILED_TEXT);
  }
  target[last] = value;
};

const isBuiltinTransform = (transform: string): transform is SchemaBuiltinTransform => transform in BUILTIN_TRANSFORMS;

const buildTransformContext = <FieldKey extends string>(
  state: ValueEvaluationState<FieldKey>,
  options: {
    field: FieldKey | undefined;
    mediaTarget: ModelAssetMediaTargetShape | undefined;
    targetPath: string | undefined;
  },
) => ({
  field: options.field,
  targetPath: options.targetPath,
  mediaTarget: options.mediaTarget,
  values: state.context.values,
  schema: state.context.schema,
  modelId: state.context.modelId,
  runtime: state.context.runtime,
});

const applyTransforms = async <FieldKey extends string>(
  value: unknown,
  transforms: SchemaValueTransform<FieldKey>[] | undefined,
  state: ValueEvaluationState<FieldKey>,
  options: {
    field: FieldKey | undefined;
    mediaTarget: ModelAssetMediaTargetShape | undefined;
    targetPath: string | undefined;
  }
): Promise<unknown> => {
  if (!transforms || transforms.length === 0) {
    return value;
  }
  let current = value;
  for (const transform of transforms) {
    const transformContext = buildTransformContext(state, options);
    if (typeof transform === "string") {
      if (!isBuiltinTransform(transform)) {
        throw new Error(`未定义的内置 transform: ${transform}`);
      }
      const builtin = createBuiltinTransforms<FieldKey>()[transform];
      current = await builtin(current, transformContext);
      continue;
    }
    current = await transform(current, transformContext);
  }
  return current;
};

const evaluateValueExpression = async <FieldKey extends string>(
  expression: SchemaValueExpression<FieldKey> | undefined,
  state: ValueEvaluationState<FieldKey>,
  options: { targetPath: string | undefined } = { targetPath: undefined }
): Promise<unknown> => {
  if (!expression) {
    return undefined;
  }

  switch (expression.kind) {
    case "literal":
      return expression.value;
    case "field": {
      const raw = state.context.values[expression.field];
      const transformed = await applyTransforms(raw, expression.transforms, state, {
        field: expression.field,
        mediaTarget: expression.mediaTarget,
        targetPath: options.targetPath,
      });
      if (transformed === undefined && expression.fallback) {
        return evaluateValueExpression(expression.fallback, state, options);
      }
      return transformed;
    }
    case "compute": {
      const cacheKey = expression.cacheKey ?? expression;
      if (!state.computeCache.has(cacheKey)) {
        const promise = Promise.resolve(expression.run(state.context));
        state.computeCache.set(cacheKey, promise);
      }
      const computed = await state.computeCache.get(cacheKey);
      return computed;
    }
    case "when": {
      const passes = await evaluateCondition(expression.condition as SchemaCondition<FieldKey>, {
        field: undefined,
        schema: state.context.schema,
        values: state.context.values,
        modelId: state.context.modelId,
      });
      if (passes) {
        return evaluateValueExpression(expression.truthy, state, options);
      }
      return evaluateValueExpression(expression.falsy, state, options);
    }
    default:
      return undefined;
  }
};

const ensureApiDefaults = (payload: SchemaGenerationPayload): void => {
  if (!payload.api) return;
  const hasFormDataBody = isFormData(payload.body);
  if (payload.api.contentType === undefined) {
    payload.api.contentType = hasFormDataBody ? null : "application/json";
  }
};

export const buildSchemaPayload = async <FieldKey extends string = SchemaFieldKey>(
  context: SchemaBuildContext<FieldKey>
): Promise<SchemaGenerationPayload> => {
  const runtime = context.runtime ?? {};
  const buildContext: SchemaBuildContext<FieldKey> = {
    ...context,
    runtime,
  };

  const { schema } = buildContext;
  const { payload: payloadDefinition } = schema;

  if (!payloadDefinition) {
    console.error("[buildPayload] schema.payload 未定义，无法构建请求");
    throw new Error(MODEL_UNUSABLE_TEXT);
  }

  const payload: SchemaGenerationPayload = {
    input: undefined,
    prompt: undefined,
    meta: undefined,
    body: undefined,
    api: undefined,
  };

  const beforeBuild = payloadDefinition.hooks !== undefined ? payloadDefinition.hooks.beforeBuild : undefined;
  if (beforeBuild !== undefined) {
    await beforeBuild(buildContext);
  }

  const state: ValueEvaluationState<FieldKey> = {
    context: buildContext,
    computeCache: new Map(),
  };

  // 求值 payload format：静态值直接使用；"dynamic" 时通过 format_rule 在请求构造期求值。
  // 用于单节点承载多种远端接口语义的场景（如文生图 + 图生图合并节点）。
  // 详见 docs/model-assets/21-模型资产规则DSL规范.md 的「请求体格式语义」段。
  let effectiveFormat: SchemaPayloadDefinition["format"] | undefined = payloadDefinition.format;
  if (payloadDefinition.format === "dynamic" && payloadDefinition.format_rule) {
    const evaluatedFormat = await evaluateValueExpression(payloadDefinition.format_rule, state, { targetPath: "api.payload_format" });
    const normalized = typeof evaluatedFormat === "string" ? evaluatedFormat.toLowerCase() : "";
    if (normalized === "multipart" || normalized === "stream" || normalized === "json") {
      effectiveFormat = normalized;
    } else {
      // 求值失败或不合法时安全 fallback 到 json（与 normalizePayloadFormat 默认值一致）
      effectiveFormat = "json";
    }
  }

  const entries = Object.entries(payloadDefinition.map ?? {});
  for (const [path, expression] of entries) {
    const result = await evaluateValueExpression(expression, state, { targetPath: path });
    assignValue(payload, path, result, effectiveFormat);
  }

  if (payloadDefinition.taskType) {
    const taskType = payloadDefinition.taskType as TaskType;
    if (!payload.api) {
      payload.api = createDefaultApiConfig();
      payload.api.taskType = taskType;
    } else if (payload.api.taskType === undefined) {
      payload.api.taskType = taskType;
    }
  }

  ensureApiDefaults(payload);

  const afterBuild = payloadDefinition.hooks !== undefined ? payloadDefinition.hooks.afterBuild : undefined;
  if (afterBuild !== undefined) {
    const maybeNext = await afterBuild(payload, buildContext);
    if (maybeNext !== undefined) {
      return maybeNext;
    }
  }

  return payload;
};
