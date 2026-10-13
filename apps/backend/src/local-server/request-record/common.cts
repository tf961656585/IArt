export type UnknownRecord = object;

export type RequestLogRecord = object;

export type ProjectIndexItem = {
  nodeGraphId: unknown | undefined;
  path: unknown | undefined;
};

export type PackageJsonLike = {
  version: unknown | undefined;
};

export type RecordOptions = {
  appVersion: unknown | undefined;
  metadata: unknown | undefined;
  taskId: unknown | undefined;
  projectPath: unknown | undefined;
  request: unknown | undefined;
  response: unknown | undefined;
  attempt: unknown | undefined;
  error: unknown | undefined;
  timing: unknown | undefined;
};

export type RecordMetadata = {
  appVersion: unknown | undefined;
  scope: unknown | undefined;
  projectPath: unknown | undefined;
  nodeGraphId: unknown | undefined;
  taskId: unknown | undefined;
};

export type InlineDataPayload = {
  inline_data: unknown | undefined;
  data: unknown | undefined;
  mime_type: unknown | undefined;
};

export type ProjectIndexPayload = {
  index: unknown | undefined;
  projects: unknown | undefined;
};

export type AttachmentOptions = {
  metadata: unknown | undefined;
  taskId: unknown | undefined;
  projectPath: unknown | undefined;
  attempt: unknown | undefined;
  sourceFilePath: unknown | undefined;
  kind: unknown | undefined;
  contentType: unknown | undefined;
};

export type HttpRequestPayload = {
  metadata: unknown | undefined;
  url: unknown | undefined;
  method: unknown | undefined;
  headers: unknown | undefined;
  body: unknown | undefined;
};

export type HttpResponsePayload = {
  status: unknown | undefined;
  ok: unknown | undefined;
  contentType: unknown | undefined;
  headers: unknown | undefined;
  body: unknown | undefined;
  bodyType: unknown | undefined;
  file: unknown | undefined;
  resultSummary: unknown | undefined;
  resultRef: unknown | undefined;
  size: unknown | undefined;
  receivedAt: unknown | undefined;
  error: unknown | undefined;
};

export type ErrorPayload = object & {
  name: string;
  message: string;
  stack: string | null;
  cause: unknown | undefined;
};

export const normalizeString = (value: unknown): string =>
  typeof value === "string" && value.trim() ? value.trim() : "";

export const isPlainObject = (value: unknown): value is UnknownRecord => {
  if (!value || typeof value !== "object") return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

export const readObject = (value: unknown): UnknownRecord | null =>
  isPlainObject(value) ? value : null;

export const readPackageJson = (value: unknown): PackageJsonLike | null =>
  isPlainObject(value) ? (value as PackageJsonLike) : null;

export const readRecordMetadata = (value: unknown): RecordMetadata | null =>
  isPlainObject(value) ? (value as RecordMetadata) : null;

export const readRecordOptions = (value: unknown): RecordOptions | null =>
  isPlainObject(value) ? (value as RecordOptions) : null;

export const readInlineDataPayload = (
  value: unknown,
): InlineDataPayload | null =>
  isPlainObject(value) ? (value as InlineDataPayload) : null;

export const readProjectIndexPayload = (
  value: unknown,
): ProjectIndexPayload | null =>
  isPlainObject(value) ? (value as ProjectIndexPayload) : null;

export const readAttachmentOptions = (
  value: unknown,
): AttachmentOptions | null =>
  isPlainObject(value) ? (value as AttachmentOptions) : null;

export const readHttpRequestPayload = (
  value: unknown,
): HttpRequestPayload | null =>
  isPlainObject(value) ? (value as HttpRequestPayload) : null;

export const readHttpResponsePayload = (
  value: unknown,
): HttpResponsePayload | null =>
  isPlainObject(value) ? (value as HttpResponsePayload) : null;
