import { WebSocket } from "ws";

import {
  type BusinessAsyncEventOptions,
  type BusinessDataView,
  type BusinessErrorExtras,
  type BusinessWebSocket,
  asRecord,
  businessClients,
  buildEditorBackendAsyncAck,
  buildEditorBackendBusinessResult,
  deriveBusinessEventType,
  EDITOR_BACKEND_ACTION_CLASS,
  EDITOR_BACKEND_ASYNC_EVENT,
  EDITOR_BACKEND_MESSAGE_TYPE,
  getBusinessIdentityFromRecord,
  getStringRecord,
  mapTaskStatusToBusinessStatus,
  normalizeMetadata,
  normalizeString,
} from "./common.cts";

export { businessClients } from "./common.cts";

export const buildBusinessAsyncEvent = (
  record: unknown,
  options: BusinessAsyncEventOptions = {} as BusinessAsyncEventOptions,
) => {
  const recordObject = asRecord(record);
  const metadata = normalizeMetadata(recordObject.metadata);
  const actionId = normalizeString(metadata.actionId);
  if (!actionId) return null;
  const identity = getBusinessIdentityFromRecord(record);
  const eventType = deriveBusinessEventType(record, options.eventType);
  const status = mapTaskStatusToBusinessStatus(record);
  const payload: BusinessDataView = {} as BusinessDataView;
  payload.type = EDITOR_BACKEND_MESSAGE_TYPE.EVENT;
  payload.actionId = actionId;
  payload.actionName = normalizeString(metadata.actionName) || "runtime.task.created";
  payload.actionClass =
    normalizeString(metadata.actionClass) ||
    EDITOR_BACKEND_ACTION_CLASS.BUSINESS_ASYNC;
  payload.eventType = eventType;
  payload.projectPath = identity.projectPath;
  payload.nodeGraphId = identity.nodeGraphId;
  payload.taskId = identity.taskId;
  payload.remoteRequestId = identity.remoteRequestId;
  payload.status = status;
  payload.emittedAt = Date.now();
  const detail = {
    progress: recordObject.progress ?? null,
  };
  if (eventType === EDITOR_BACKEND_ASYNC_EVENT.FINAL) {
    payload.final = {
      progress: detail.progress,
      response: recordObject.response ?? null,
    };
    return payload;
  }
  if (eventType === EDITOR_BACKEND_ASYNC_EVENT.ERROR) {
    payload.error = recordObject.error ?? {
      code: "task_failed",
      message: "Business task failed",
    };
    return payload;
  }
  if (eventType === EDITOR_BACKEND_ASYNC_EVENT.CANCELLED) {
    const errorRecord = asRecord(recordObject.error);
    payload.cancelled = {
      reason: normalizeString(errorRecord.message) || "cancelled",
    };
    return payload;
  }
  if (eventType === EDITOR_BACKEND_ASYNC_EVENT.SNAPSHOT) {
    payload.snapshot = detail;
    return payload;
  }
  payload.delta = detail;
  return payload;
};
export const sendJson = (
  ws: BusinessWebSocket | null | undefined,
  payload: unknown,
) => {
  const openState = typeof (ws !== null && ws !== undefined ? ws.OPEN : undefined) === "number" ? (ws as { OPEN: number }).OPEN : WebSocket.OPEN;
  if (!ws || ws.readyState !== openState) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    void 0;
  }
};
export const notifyBusinessActionSubscribers = (
  record: unknown,
  options: BusinessAsyncEventOptions = {} as BusinessAsyncEventOptions,
) => {
  const recordObject = asRecord(record);
  const payload = buildBusinessAsyncEvent(record, options);
  if (!payload) return;
  for (const client of businessClients) {
    if (client.closed) continue;
    const payloadActionId = normalizeString(payload.actionId);
    if (
      !client.taskIds.has(normalizeString(recordObject.id)) &&
      !client.actionIds.has(payloadActionId)
    ) {
      continue;
    }
    sendJson(client.ws, payload);
  }
};
export const buildBusinessErrorPayload = (
  submit: unknown,
  code: unknown,
  message: unknown,
  extras: BusinessErrorExtras | null = null,
) => ({
  ...((extras !== null && extras !== undefined ? extras.detail : undefined) !== undefined ? { detail: (extras as { detail: unknown }).detail } : {}),
  type: EDITOR_BACKEND_MESSAGE_TYPE.RESULT,
  actionId: getStringRecord(submit, "actionId"),
  actionName: getStringRecord(submit, "actionName"),
  actionClass:
    getStringRecord(submit, "actionClass") ||
    EDITOR_BACKEND_ACTION_CLASS.BUSINESS_ASYNC,
  projectPath: getStringRecord(submit, "projectPath"),
  error: {
    code: normalizeString(code) || "business_action_failed",
    message: normalizeString(message) || "Business action failed",
  },
  emittedAt: Date.now(),
});
export const buildBusinessSyncAckPayload = (submit: unknown) =>
  buildEditorBackendAsyncAck({
    actionId: getStringRecord(submit, "actionId"),
    actionName: getStringRecord(submit, "actionName"),
    actionClass:
      getStringRecord(submit, "actionClass") ||
      EDITOR_BACKEND_ACTION_CLASS.BUSINESS_SYNC,
    accepted: true,
    projectPath: getStringRecord(submit, "projectPath"),
    nodeGraphId: getStringRecord(submit, "nodeGraphId") || null,
    taskId: null,
    emittedAt: Date.now(),
  });
export const buildBusinessSyncResultPayload = (
  submit: unknown,
  result: unknown,
) =>
  buildEditorBackendBusinessResult({
    actionId: getStringRecord(submit, "actionId"),
    actionName: getStringRecord(submit, "actionName"),
    actionClass:
      getStringRecord(submit, "actionClass") ||
      EDITOR_BACKEND_ACTION_CLASS.BUSINESS_SYNC,
    projectPath: getStringRecord(submit, "projectPath"),
    nodeGraphId: getStringRecord(submit, "nodeGraphId") || null,
    result,
    emittedAt: Date.now(),
  });
