import { invalidArguments } from "./errors.cts";
import { cloneJsonValue, normalizeString, isPlainObject } from "@iart/contracts";
import type { ModelAssetRuntimeRecord } from "@iart/model-asset-runtime";

type PlainObject = object;
type PathSegment = string | number;

type UploadOptions = {
  uploadMode: string | undefined;
  targetType: string | undefined;
  fieldPath: string | undefined;
};

type PreRequestOutputsMap = Record<string, Record<string, unknown>>;

type EvaluationOptions = {
  uploadOptions: UploadOptions | undefined | undefined;
  item: unknown | undefined;
  targetPath: string | undefined | undefined;
  preRequestOutputs: PreRequestOutputsMap | undefined;
};

type EvaluateState = {
  fields: ModelAssetRuntimeRecord;
  runtime: PlainObject;
  projection: PlainObject;
  currentItem: unknown | undefined;
  projectPath: string | null;
};

type ProjectionRuntimeRaw = {
  api_defaults: unknown | undefined;
  url_input_upload_target_type: unknown | undefined;
  url_input_upload_mode: unknown | undefined;
  payload_format: unknown | undefined;
  payload_format_rule: unknown | undefined;
  payload_rules: unknown | undefined;
  pre_requests: unknown | undefined;
};

type ProjectionCapabilityRaw = { input_modalities: unknown | undefined };

type ProjectionRaw = {
  model_id: unknown | undefined;
  package_id: unknown | undefined;
  capability: unknown | undefined;
  runtime: unknown | undefined;
  task_execution_plan: unknown | undefined;
};

type PayloadApiRaw = {
  endpoint: unknown | undefined;
  method: unknown | undefined;
  contentType: unknown | undefined;
  headers: unknown | undefined;
};

type HeaderMap = { contentTypeLower: unknown | undefined; contentTypeCanonical: unknown | undefined };
type PayloadRaw = { api: unknown | undefined; body: unknown | undefined; meta: unknown | undefined };

type TaskExecutionPlanRaw = {
  polling_strategy: unknown | undefined;
  result_rule: unknown | undefined;
  result_acquisition_strategy: unknown | undefined;
  result_output_mapping: unknown | undefined;
};

type RequestAssemblerContextRaw = { baseDir: unknown | undefined };

type AssemblerContext = {
  projectPath: string | null;
  baseDir: string | null;
};

type RequestAssemblerInputRaw = {
  model_id: unknown | undefined;
  payload: unknown | undefined;
  media_inputs: unknown | undefined;
  arguments: unknown | undefined;
  input_assets: unknown | undefined;
  mention_map: unknown | undefined;
};

/**
 * Cast an unknown value to a specific plain-object shape.
 *
 * TODO: Replace with Zod safeParse once projection/payload contracts are defined
 * as Zod schemas in packages/contracts. These as* wrappers only verify "is a plain
 * object" at runtime; they do NOT validate individual fields.
 */
const castPlainObject = <T extends PlainObject>(value: unknown): T | null =>
  isPlainObject(value) ? (value as T) : null;

const asProjectionRaw = (value: unknown): ProjectionRaw | null =>
  castPlainObject<ProjectionRaw>(value);

const asProjectionRuntimeRaw = (value: unknown): ProjectionRuntimeRaw | null =>
  castPlainObject<ProjectionRuntimeRaw>(value);

const asProjectionCapabilityRaw = (
  value: unknown,
): ProjectionCapabilityRaw | null => castPlainObject<ProjectionCapabilityRaw>(value);

const asPayloadRaw = (value: unknown): PayloadRaw | null =>
  castPlainObject<PayloadRaw>(value);

const asPayloadApiRaw = (value: unknown): PayloadApiRaw | null =>
  castPlainObject<PayloadApiRaw>(value);

const asTaskExecutionPlanRaw = (value: unknown): TaskExecutionPlanRaw | null =>
  castPlainObject<TaskExecutionPlanRaw>(value);

const asRequestAssemblerContextRaw = (
  value: unknown,
): RequestAssemblerContextRaw | null => castPlainObject<RequestAssemblerContextRaw>(value);

const asRequestAssemblerInputRaw = (
  value: unknown,
): RequestAssemblerInputRaw | null => castPlainObject<RequestAssemblerInputRaw>(value);

const cloneValue = <T,>(value: T): T => {
  if (value === null || value === undefined) return value;
  return cloneJsonValue(value);
};

const parsePath = (rawPath: unknown): PathSegment[] => {
  const normalizedPath = normalizeString(rawPath);
  if (!normalizedPath) return [];
  const segments: PathSegment[] = [];
  const pattern = /([^.[\]]+)|(\[(\d+)\])/g;
  let match: RegExpExecArray | null = null;
  while ((match = pattern.exec(normalizedPath)) !== null) {
    if (match[1]) {
      segments.push(match[1]);
      continue;
    }
    if (match[3]) {
      segments.push(Number.parseInt(match[3], 10));
    }
  }
  return segments;
};

const readOpenField = (source: unknown, key: string): unknown => {
  if (source === null || source === undefined) return undefined;
  return Reflect.get(Object(source), key);
};

const writeOpenField = (target: unknown, key: string, value: unknown) => {
  if (!isPlainObject(target)) {
    throw invalidArguments("Invalid payload target path");
  }
  Reflect.set(target, key, value);
};

const ensureChildContainer = (
  parent: unknown,
  segment: PathSegment,
  nextSegment: PathSegment,
): unknown => {
  if (typeof segment === "number") {
    if (!Array.isArray(parent)) {
      throw invalidArguments("Invalid payload target path");
    }
    if (parent[segment] === undefined) {
      parent[segment] = typeof nextSegment === "number" ? [] : {};
    }
    return parent[segment];
  }
  if (!isPlainObject(parent)) {
    throw invalidArguments("Invalid payload target path");
  }
  const existing = readOpenField(parent, segment);
  if (
    !Object.prototype.hasOwnProperty.call(parent, segment) ||
    existing == null
  ) {
    writeOpenField(parent, segment, typeof nextSegment === "number" ? [] : {});
  }
  return readOpenField(parent, segment);
};

const assignNestedValue = (
  payload: PlainObject,
  rawPath: unknown,
  value: unknown,
) => {
  if (value === undefined) return;
  const segments = parsePath(rawPath);
  const first = segments[0];
  if (first === undefined) return;
  let current: unknown = payload;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    const nextSegment = segments[index + 1];
    if (segment === undefined || nextSegment === undefined) return;
    current = ensureChildContainer(current, segment, nextSegment);
  }
  const last = segments[segments.length - 1];
  if (last === undefined) return;
  if (typeof last === "number") {
    if (!Array.isArray(current)) {
      throw invalidArguments(`Invalid array target path: ${rawPath}`);
    }
    current[last] = value;
    return;
  }
  writeOpenField(current, last, value);
};

const mergeFieldMaps = (...sources: unknown[]): PlainObject =>
  sources.reduce<PlainObject>((merged, source) => {
    if (!isPlainObject(source)) return merged;
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined || value === null || value === "") continue;
      const existing = readOpenField(merged, key);
      if (Array.isArray(existing) || Array.isArray(value)) {
        const next: unknown[] = [];
        if (Array.isArray(existing)) next.push(...existing);
        else if (existing !== undefined) next.push(existing);
        if (Array.isArray(value)) next.push(...value);
        else next.push(value);
        writeOpenField(merged, key, next);
        continue;
      }
      if (existing === undefined || existing === null || existing === "") {
        writeOpenField(merged, key, value);
        continue;
      }
      writeOpenField(merged, key, value);
    }
    return merged;
  }, {});

export {
  type PlainObject,
  type PreRequestOutputsMap,
  type UploadOptions,
  type EvaluationOptions,
  type EvaluateState,
  type AssemblerContext,
  type HeaderMap,
  normalizeString,
  isPlainObject,
  asProjectionRaw,
  asProjectionRuntimeRaw,
  asProjectionCapabilityRaw,
  asPayloadRaw,
  asPayloadApiRaw,
  asTaskExecutionPlanRaw,
  asRequestAssemblerContextRaw,
  asRequestAssemblerInputRaw,
  cloneValue,
  parsePath,
  readOpenField,
  writeOpenField,
  assignNestedValue,
  mergeFieldMaps,
};
