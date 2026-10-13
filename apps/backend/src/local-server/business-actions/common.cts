import { cloneJsonValue } from "@iart/contracts";

import * as contractsModule from "../contracts.cts";
import * as utilsModule from "../utils.cts";

export const isPlainObject = utilsModule.isPlainObject;
export const EDITOR_BACKEND_ACTION_NAME =
  contractsModule.EDITOR_BACKEND_ACTION_NAME;
export const EDITOR_BACKEND_ACTION_CLASS =
  contractsModule.EDITOR_BACKEND_ACTION_CLASS;
export const EDITOR_BACKEND_ASYNC_EVENT =
  contractsModule.EDITOR_BACKEND_ASYNC_EVENT;
export const EDITOR_BACKEND_COMPAT = contractsModule.EDITOR_BACKEND_COMPAT;
export const EDITOR_BACKEND_MESSAGE_TYPE =
  contractsModule.EDITOR_BACKEND_MESSAGE_TYPE;
export const buildEditorBackendAsyncAck =
  contractsModule.buildEditorBackendAsyncAck;
export const buildEditorBackendBusinessResult =
  contractsModule.buildEditorBackendBusinessResult;
export const normalizeEditorBackendBusinessSubmit =
  contractsModule.normalizeEditorBackendBusinessSubmit;
export const normalizeEditorBackendIdentity =
  contractsModule.normalizeEditorBackendIdentity;

export type BusinessDataView = {
  actionClass: unknown | undefined;
  actionId: unknown | undefined;
  actionName: unknown | undefined;
  ackAlreadySent: unknown | undefined;
  asset: unknown | undefined;
  assetId: unknown | undefined;
  auto_start: unknown | undefined;
  autoStart: unknown | undefined;
  batch_id: unknown | undefined;
  batchId: unknown | undefined;
  character: unknown | undefined;
  code: unknown | undefined;
  contentType: unknown | undefined;
  contract: unknown | undefined;
  data: unknown | undefined;
  createdAt: unknown | undefined;
  cookieHeader: unknown | undefined;
  dataBase64: unknown | undefined;
  description: unknown | undefined;
  detail: unknown | undefined;
  error: unknown | undefined;
  fields: unknown | undefined;
  filename: unknown | undefined;
  filenamePrefix: unknown | undefined;
  files: unknown | undefined;
  formData: unknown | undefined;
  height: unknown | undefined;
  id: unknown | undefined;
  imageUrl: unknown | undefined;
  kind: unknown | undefined;
  localized: unknown | undefined;
  maxEdge: unknown | undefined;
  mediaType: unknown | undefined;
  message: unknown | undefined;
  meta: unknown | undefined;
  metadata: unknown | undefined;
  mimeType: unknown | undefined;
  mode: unknown | undefined;
  model_id: unknown | undefined;
  modelId: unknown | undefined;
  name: unknown | undefined;
  nodeGraphId: unknown | undefined;
  ok: unknown | undefined;
  ops: unknown | undefined;
  originalUrl: unknown | undefined;
  payload: unknown | undefined;
  polling: unknown | undefined;
  polling_strategy: unknown | undefined;
  preserveLegacyTaskId: unknown | undefined;
  progress: unknown | undefined;
  projectPath: unknown | undefined;
  quality: unknown | undefined;
  remote_request_id: unknown | undefined;
  remoteRequestId: unknown | undefined;
  response: unknown | undefined;
  reason: unknown | undefined;
  result: unknown | undefined;
  result_acquisition_strategy: unknown | undefined;
  result_output_mapping: unknown | undefined;
  result_rule: unknown | undefined;
  sizeBytes: unknown | undefined;
  sourceNodeId: unknown | undefined;
  sourceUrl: unknown | undefined;
  status: unknown | undefined;
  submit_request: unknown | undefined;
  submissionTransport: unknown | undefined;
  target_success_count: unknown | undefined;
  targetSuccessCount: unknown | undefined;
  taskExecutionPlan: unknown | undefined;
  taskId: unknown | undefined;
  taskStatus: unknown | undefined;
  thumbnail: unknown | undefined;
  thumbnailUrl: unknown | undefined;
  threshold: unknown | undefined;
  timeSec: unknown | undefined;
  token: unknown | undefined;
  tokens: unknown | undefined;
  until_x_success_enabled: unknown | undefined;
  untilXSuccessEnabled: unknown | undefined;
  type: unknown | undefined;
  adapter: unknown | undefined;
  eventType: unknown | undefined;
  emittedAt: unknown | undefined;
  final: unknown | undefined;
  cancelled: unknown | undefined;
  snapshot: unknown | undefined;
  delta: unknown | undefined;
  url: unknown | undefined;
  userId: unknown | undefined;
  value: unknown | undefined;
  width: unknown | undefined;
  successPath: unknown | undefined;
  successFieldPaths: unknown | undefined;
  successStatuses: unknown | undefined;
  statusFieldPaths: unknown | undefined;
  failurePath: unknown | undefined;
  failureStatuses: unknown | undefined;
  failureCodePaths: unknown | undefined;
  failureMessagePaths: unknown | undefined;
  progressFieldPath: unknown | undefined;
  progressPath: unknown | undefined;
  intervalMs: unknown | undefined;
  delayMs: unknown | undefined;
  maxAttempts: unknown | undefined;
  maxConsecutiveFailures: unknown | undefined;
  backoff: unknown | undefined;
};
export type BusinessIdentityView = {
  projectPath: unknown | undefined;
  nodeGraphId: unknown | undefined;
  taskId: unknown | undefined;
  remoteRequestId: unknown | undefined;
};
export type BusinessAsyncEventOptions = { eventType: unknown | undefined };
export type BusinessErrorExtras = { detail: unknown | undefined };
export type FormalTaskExecutionMetadataView = BusinessDataView;
export type PersistedTaskRecordView = BusinessDataView;
export type TaskSubmissionRecordView = BusinessDataView;
export type JsonResponseView = { json: () => Promise<unknown> };
export type BusinessClient = {
  ws: BusinessWebSocket;
  actionIds: Set<string>;
  taskIds: Set<string>;
  closed: boolean;
};
export type BusinessWebSocket = {
  OPEN: number | undefined;
  readyState: number;
  send: (payload: string) => void;
  on: (
    event: "message" | "close" | "error",
    listener: (...args: unknown[]) => void,
  ) => void;
};
export type MediaImageThumbnailResultView = {
  success: unknown | undefined;
  url: unknown | undefined;
  meta: unknown | undefined;
};
export type MediaImageEdgeDetectResultView = {
  success: unknown | undefined;
  url: unknown | undefined;
  width: unknown | undefined;
  height: unknown | undefined;
  mode: unknown | undefined;
  threshold: unknown | undefined;
};
export type MediaImageTransformResultView = {
  success: unknown | undefined;
  url: unknown | undefined;
  width: unknown | undefined;
  height: unknown | undefined;
};
export const businessClients = new Set<BusinessClient>();
export const isRecord = (value: unknown): value is BusinessDataView =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const asRecord = (value: unknown): BusinessDataView =>
  isRecord(value) ? value : ({} as BusinessDataView);
const asBusinessView = <T,>(value: unknown): T =>
  (isRecord(value) ? value : {}) as T;
export const asMediaImageThumbnailResult = (
  value: unknown,
): MediaImageThumbnailResultView => asBusinessView<MediaImageThumbnailResultView>(value);
export const asMediaImageEdgeDetectResult = (
  value: unknown,
): MediaImageEdgeDetectResultView => asBusinessView<MediaImageEdgeDetectResultView>(value);
export const asMediaImageTransformResult = (
  value: unknown,
): MediaImageTransformResultView => asBusinessView<MediaImageTransformResultView>(value);
export const asArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];
export const getDynamicField = (value: unknown, key: string): unknown => {
  if (!isRecord(value)) return undefined;
  return Reflect.get(value, key);
};
export const getRecord = (value: unknown, key: string): BusinessDataView =>
  asRecord(getDynamicField(value, key));
export const getStringRecord = (value: unknown, key: string): string =>
  normalizeString(getDynamicField(value, key));
export const normalizeString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";
export const cloneValue = (value: unknown) => {
  if (value === null || value === undefined) return value;
  try {
    return cloneJsonValue(value);
  } catch {
    return value;
  }
};
export const asJsonResponse = (value: unknown): JsonResponseView | null => {
  const json = getDynamicField(value, "json");
  if (typeof json !== "function") return null;
  return { json: json as () => Promise<unknown> };
};
export const parseJsonSafe = async (response: unknown) => {
  const jsonResponse = asJsonResponse(response);
  if (!jsonResponse) return null;
  try {
    return await jsonResponse.json();
  } catch {
    return null;
  }
};
export const normalizeMetadata = (
  value: unknown,
): FormalTaskExecutionMetadataView =>
  isRecord(value) || isPlainObject(value) ? asRecord(value) : ({} as BusinessDataView);
export const FORMAL_TASK_STATUSES = new Set([
  "submitting",
  "generating",
  "polling",
  "downloading",
  "succeeded",
  "failed",
]);
export const normalizeFormalTaskStatus = (value: unknown) => {
  const normalized = normalizeString(value).toLowerCase();
  return FORMAL_TASK_STATUSES.has(normalized) ? normalized : null;
};
export const mapTaskStatusToBusinessStatus = (record: unknown) => {
  const metadata = getRecord(record, "metadata");
  const metadataStatus = normalizeFormalTaskStatus(metadata.taskStatus);
  if (metadataStatus) return metadataStatus;
  return normalizeFormalTaskStatus(asRecord(record).status);
};
export const deriveBusinessEventType = (
  record: unknown,
  fallback: unknown = EDITOR_BACKEND_ASYNC_EVENT.DELTA,
) => {
  const formalStatus = mapTaskStatusToBusinessStatus(record);
  const normalized = normalizeString(asRecord(record).status).toLowerCase();
  if (formalStatus === "succeeded") return EDITOR_BACKEND_ASYNC_EVENT.FINAL;
  if (formalStatus === "failed") {
    if (normalized === "failed") return EDITOR_BACKEND_ASYNC_EVENT.CANCELLED;
    return EDITOR_BACKEND_ASYNC_EVENT.ERROR;
  }
  if (normalized === "failed") return EDITOR_BACKEND_ASYNC_EVENT.CANCELLED;
  if (normalized === "submitting") return EDITOR_BACKEND_ASYNC_EVENT.SNAPSHOT;
  return fallback === EDITOR_BACKEND_ASYNC_EVENT.FINAL ||
    fallback === EDITOR_BACKEND_ASYNC_EVENT.ERROR ||
    fallback === EDITOR_BACKEND_ASYNC_EVENT.CANCELLED ||
    fallback === EDITOR_BACKEND_ASYNC_EVENT.SNAPSHOT ||
    fallback === EDITOR_BACKEND_ASYNC_EVENT.DELTA
    ? fallback
    : EDITOR_BACKEND_ASYNC_EVENT.DELTA;
};
export const getBusinessIdentityFromRecord = (
  record: unknown,
): BusinessIdentityView => {
  const recordObject = asRecord(record);
  const metadata = normalizeMetadata(recordObject.metadata);
  const identity = normalizeEditorBackendIdentity({
    projectPath: metadata.projectPath,
    nodeGraphId: metadata.nodeGraphId,
    taskId: metadata.taskId || recordObject.id,
    remoteRequestId: metadata.remoteRequestId,
  });
  return asRecord(identity);
};
export const normalizeBusinessError = (
  error: unknown,
  fallbackCode = "business_action_failed",
) => {
  if (isRecord(error)) {
    const code = normalizeString(error.code) || fallbackCode;
    const message = normalizeString(error.message) || "Business action failed";
    return { code, message };
  }
  return {
    code: fallbackCode,
    message: normalizeString(error) || "Business action failed",
  };
};
