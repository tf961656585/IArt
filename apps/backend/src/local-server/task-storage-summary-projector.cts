import { cloneJsonValue } from "@iart/contracts";

type JsonRecord = Record<string, unknown>;

type TaskSummaryObject = JsonRecord;
type UploadSourceView = {
  kind: unknown | undefined;
  mimeType: unknown | undefined;
  url: unknown | undefined;
  path: unknown | undefined;
  filename: unknown | undefined;
  fileKey: unknown | undefined;
  assetId: unknown | undefined;
  sha256: unknown | undefined;
  hash: unknown | undefined;
  size: unknown | undefined;
  dataBase64: unknown | undefined;
  data: unknown | undefined;
};
type UploadEntryView = {
  token: unknown | undefined;
  mode: unknown | undefined;
  targetType: unknown | undefined;
  filename: unknown | undefined;
  fieldPath: unknown | undefined;
  fileKey: unknown | undefined;
  assetId: unknown | undefined;
  sha256: unknown | undefined;
  hash: unknown | undefined;
  size: unknown | undefined;
  source: unknown | undefined;
};
type FormDataFieldView = {
  name: unknown | undefined;
  filename: unknown | undefined;
  contentType: unknown | undefined;
  dataBase64: unknown | undefined;
  value: unknown | undefined;
};
type FormDataPayloadView = {
  fields: unknown | undefined;
  files: unknown | undefined;
};
type RequestView = {
  method: unknown | undefined;
  url: unknown | undefined;
  endpoint: unknown | undefined;
  headers: unknown | undefined;
  body: unknown | undefined;
};
type MetadataView = {
  projectPath: unknown | undefined;
  nodeGraphId: unknown | undefined;
  sourceNodeId: unknown | undefined;
  targetNodeId: unknown | undefined;
  batchId: unknown | undefined;
  batch_id: unknown | undefined;
};
type MetadataSummaryRecord = JsonRecord & {
  taskExecutionPlan: unknown;
};
type TaskExecutionPlanView = {
  submit_request: unknown | undefined;
  submit_request_summary: unknown | undefined;
  metadata: unknown | undefined;
  polling_strategy: unknown | undefined;
  result_rule: unknown | undefined;
  result_acquisition_strategy: unknown | undefined;
  result_output_mapping: unknown | undefined;
};

const MAX_INLINE_STRING = 512;
const MAX_PREVIEW_ITEMS = 8;

const normalizeString = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : "";

const isPlainObject = (value: unknown): value is JsonRecord => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const cloneValue = <T,>(value: T): T => {
  if (value === null || value === undefined) return value;
  return cloneJsonValue(value);
};

const looksLikeBase64 = (value: unknown) => {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length < 256) return false;
  if (trimmed.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/=]+$/.test(trimmed);
};

const summarizeStringValue = (value: string) => {
  const trimmed = value.trim();
  if (looksLikeBase64(trimmed)) {
    return {
      kind: "omitted_base64",
      size: trimmed.length,
    };
  }
  if (trimmed.length <= MAX_INLINE_STRING) return value;
  return {
    kind: "omitted_text",
    size: trimmed.length,
    preview: trimmed.slice(0, MAX_INLINE_STRING),
  };
};

const summarizeHeaders = (headers: unknown) => {
  if (!isPlainObject(headers)) return null;
  const names: string[] = [];
  for (const [key] of Object.entries(headers)) {
    const normalizedKey = normalizeString(key);
    if (!normalizedKey) continue;
    names.push(normalizedKey.toLowerCase());
  }
  names.sort();
  return {
    names,
  };
};

const projectUploadSourceSummary = (value: unknown) => {
  if (!isPlainObject(value)) return null;
  const source = value as UploadSourceView;
  return {
    kind: normalizeString(source.kind) || null,
    mimeType: normalizeString(source.mimeType) || null,
    url: normalizeString(source.url) || null,
    path: normalizeString(source.path) || null,
    filename: normalizeString(source.filename) || null,
    fileKey: normalizeString(source.fileKey) || null,
    assetId: normalizeString(source.assetId) || null,
    sha256: normalizeString(source.sha256) || normalizeString(source.hash) || null,
    size: typeof source.size === "number" && Number.isFinite(source.size) ? source.size : null,
    hasDataBase64: Boolean(source.dataBase64 || source.data),
  };
};

const projectUploadEntrySummary = (value: unknown) => {
  if (!isPlainObject(value)) return null;
  const entry = value as UploadEntryView;
  return {
    token: normalizeString(entry.token) || null,
    mode: normalizeString(entry.mode) || null,
    targetType: normalizeString(entry.targetType) || null,
    filename: normalizeString(entry.filename) || null,
    fieldPath: normalizeString(entry.fieldPath) || null,
    fileKey: normalizeString(entry.fileKey) || null,
    assetId: normalizeString(entry.assetId) || null,
    sha256: normalizeString(entry.sha256) || normalizeString(entry.hash) || null,
    size: typeof entry.size === "number" && Number.isFinite(entry.size) ? entry.size : null,
    source: projectUploadSourceSummary(entry.source),
  };
};

const summarizeTaskValue = (
  value: unknown,
  contextKey: string,
  depth = 0,
): unknown => {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return summarizeStringValue(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_PREVIEW_ITEMS).map((item) => summarizeTaskValue(item, contextKey, depth + 1));
    if (value.length <= MAX_PREVIEW_ITEMS) return items;
    return {
      kind: "array_summary",
      length: value.length,
      preview: items,
    };
  }
  if (!isPlainObject(value)) return cloneValue(value);
  if (contextKey === "headers") return summarizeHeaders(value);
  if (contextKey === "files") {
    return Object.values(value).slice(0, MAX_PREVIEW_ITEMS).map((entry) => projectUploadEntrySummary(entry));
  }
  if (contextKey === "__formData") {
    const payload = value as FormDataPayloadView;
    const fields = Array.isArray(payload.fields) ? payload.fields : [];
    return {
      kind: "form_data_summary",
      fieldCount: fields.length,
      fields: fields.slice(0, MAX_PREVIEW_ITEMS).map((field) => {
        if (!isPlainObject(field)) return summarizeTaskValue(field, "field", depth + 1);
        const formField = field as FormDataFieldView;
        return {
          name: normalizeString(formField.name) || null,
          filename: normalizeString(formField.filename) || null,
          contentType: normalizeString(formField.contentType) || null,
          hasDataBase64: Boolean(formField.dataBase64),
          value: summarizeTaskValue(formField.value, "value", depth + 1),
        };
      }),
    };
  }
  const result: TaskSummaryObject = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === "dataBase64") {
      result[key] = {
        kind: "omitted_base64",
        size: typeof nested === "string" ? nested.length : null,
      };
      continue;
    }
    if (key === "authorization" || key.toLowerCase() === "authorization") {
      result[key] = {
        kind: "redacted_header",
      };
      continue;
    }
    result[key] = summarizeTaskValue(nested, key, depth + 1);
  }
  if (depth > 0) {
    const serialized = JSON.stringify(result);
    if (serialized.length > 4096) {
      return {
        kind: "object_summary",
        keys: Object.keys(result).sort(),
        size: serialized.length,
      };
    }
  }
  return result;
};

const projectRuntimeTaskRequestSummary = (
  request: unknown,
  metadata: unknown,
): JsonRecord | null => {
  if (!isPlainObject(request)) return null;
  const requestView = request as RequestView;
  const metadataRecord = (isPlainObject(metadata) ? metadata : {}) as MetadataView;
  return {
    method: normalizeString(requestView.method) || null,
    url: normalizeString(requestView.url) || null,
    endpoint: normalizeString(requestView.endpoint) || null,
    projectPath: normalizeString(metadataRecord.projectPath) || null,
    nodeGraphId: normalizeString(metadataRecord.nodeGraphId) || null,
    sourceNodeId: normalizeString(metadataRecord.sourceNodeId) || null,
    targetNodeId: normalizeString(metadataRecord.targetNodeId) || null,
    batchId:
      normalizeString(metadataRecord.batchId) ||
      normalizeString(metadataRecord.batch_id) ||
      null,
    headers: summarizeHeaders(requestView.headers),
    body: summarizeTaskValue(requestView.body, "body"),
  };
};

const projectTaskExecutionPlanSummary = (value: unknown): JsonRecord | null => {
  if (!isPlainObject(value)) return null;
  const plan = value as TaskExecutionPlanView;
  const submitRequest = isPlainObject(plan.submit_request) ? plan.submit_request : null;
  const submitRequestSummary = isPlainObject(plan.submit_request_summary)
    ? cloneValue(plan.submit_request_summary)
    : null;
  return {
    submit_request_summary: submitRequest
      ? summarizeTaskValue(submitRequest, "submit_request")
      : submitRequestSummary,
    polling_strategy: summarizeTaskValue(plan.polling_strategy ?? null, "polling_strategy"),
    result_rule: summarizeTaskValue(plan.result_rule ?? null, "result_rule"),
    result_acquisition_strategy: summarizeTaskValue(
      plan.result_acquisition_strategy ?? null,
      "result_acquisition_strategy",
    ),
    result_output_mapping: summarizeTaskValue(
      plan.result_output_mapping ?? null,
      "result_output_mapping",
    ),
  };
};

const projectRuntimeTaskMetadataSummary = (
  metadata: unknown,
  request: unknown,
): JsonRecord | null => {
  if (!isPlainObject(metadata)) return null;
  const result = {} as MetadataSummaryRecord;
  for (const [key, value] of Object.entries(metadata)) {
    if (key === "taskExecutionPlan") {
    result[key] = projectTaskExecutionPlanSummary(value);
      continue;
    }
    result[key] = summarizeTaskValue(value, key);
  }
  if (!Object.prototype.hasOwnProperty.call(result, "taskExecutionPlan")) {
    result.taskExecutionPlan = projectTaskExecutionPlanSummary({
      submit_request: request,
    });
  }
  return result;
};

const projectRuntimeTaskFailureSummary = (failure: unknown): unknown => {
  return summarizeTaskValue(failure, "failure");
};

export {
  projectRuntimeTaskFailureSummary,
  projectRuntimeTaskMetadataSummary,
  projectRuntimeTaskRequestSummary,
  projectTaskExecutionPlanSummary,
  summarizeTaskValue,
};
