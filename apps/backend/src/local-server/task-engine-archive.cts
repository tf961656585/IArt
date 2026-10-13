import { isMediaRefPlaceholder, type MediaRefPlaceholder } from "@iart/contracts";
import * as loggingModule from "./logging.cts";
import * as taskArchiveStoreModule from "./task-archive-store.cts";
import {
  summarizeArchiveRequest,
  summarizeArchiveResponse,
  summarizeArchiveValue,
} from "./task-archive-summary-projector.cts";
import {
  cloneValue,
  getErrorMessage,
  isRecord,
  isTaskFinalStatus,
  toRecord,
} from "./task-engine-shared.cts";
import {
  normalizeString,
  normalizeTaskRecord,
  normalizeTaskStatus,
  normalizeTaskType,
} from "./task-normalizer.cts";

const {
  appendTaskArchiveEvent,
  readTaskArchiveEvents,
  resolveProjectPathFromMetadata,
} = taskArchiveStoreModule;

type MediaRefPlaceholderList = MediaRefPlaceholder[];
type TaskArchiveMetadataRaw = {
  taskId: unknown | undefined;
};

const readTaskArchiveEventsForTaskEngine = (options: unknown): unknown[] =>
  readTaskArchiveEvents(options as never) as unknown[];

const collectMediaRefPlaceholders = (value: unknown): MediaRefPlaceholderList => {
  const result: MediaRefPlaceholderList = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      const collected = collectMediaRefPlaceholders(item);
      for (const placeholder of collected) {
        result.push(placeholder);
      }
    }
    return result;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) {
      const collected = collectMediaRefPlaceholders(item);
      for (const placeholder of collected) {
        result.push(placeholder);
      }
    }
    return result;
  }
  if (isMediaRefPlaceholder(value)) {
    result.push(value);
  }
  return result;
};

const normalizeTaskInputUploads = (
  value: unknown,
): MediaRefPlaceholderList | null => {
  const placeholders = collectMediaRefPlaceholders(value);
  if (placeholders.length === 0 && !isRecord(value) && !Array.isArray(value)) {
    return null;
  }
  return placeholders;
};

const asTaskArchiveMetadata = (value: unknown): TaskArchiveMetadataRaw =>
  isRecord(value) ? (value as TaskArchiveMetadataRaw) : { taskId: undefined };

const buildTaskArchiveEventSnapshot = (
  record: unknown,
  reason = "task.snapshot",
) => {
  const recordValue = toRecord(record);
  const metadata = toRecord(cloneValue(recordValue.metadata));
  const taskId = normalizeString(
    metadata.taskId || recordValue.taskId || recordValue.id,
  );
  if (!taskId) return null;
  const progress = toRecord(recordValue.progress);
  return {
    taskId,
    type: reason,
    timestamp: new Date().toISOString(),
    detail: {
      phase: normalizeString(progress.phase) || null,
      remoteRequestId: normalizeString(metadata.remoteRequestId) || null,
    },
    snapshot: {
      task: {
        id: normalizeString(recordValue.id) || null,
        type: normalizeTaskType(recordValue.type),
        status: normalizeTaskStatus(recordValue.status),
        createdAt: Number.isFinite(recordValue.createdAt)
          ? Number(recordValue.createdAt)
          : Date.now(),
        updatedAt: Number.isFinite(recordValue.updatedAt)
          ? Number(recordValue.updatedAt)
          : Date.now(),
        startedAt: Number.isFinite(recordValue.startedAt)
          ? Number(recordValue.startedAt)
          : null,
        finishedAt: Number.isFinite(recordValue.finishedAt)
          ? Number(recordValue.finishedAt)
          : null,
        request: summarizeArchiveRequest(recordValue.request ?? null),
        polling: summarizeArchiveValue(recordValue.polling ?? null, "polling"),
        error: summarizeArchiveValue(recordValue.error ?? null, "error"),
        metadata: summarizeArchiveValue(metadata, "metadata"),
        progress: summarizeArchiveValue(recordValue.progress ?? null, "progress"),
      },
    },
  };
};

const writeTaskArchiveSnapshot = (
  record: unknown,
  reason = "task.snapshot",
) => {
  const recordValue = toRecord(record);
  const metadata = toRecord(recordValue.metadata);
  const taskId = normalizeString(
    metadata.taskId || recordValue.taskId || recordValue.id,
  );
  if (!taskId || !isTaskFinalStatus(recordValue.status)) return null;
  const projectPath = resolveProjectPathFromMetadata(metadata);
  return appendTaskArchiveEvent({
    taskId,
    ...(projectPath ? { projectPath } : {}),
    metadata,
    event: buildTaskArchiveEventSnapshot(record, reason),
  } as Parameters<typeof appendTaskArchiveEvent>[0]);
};

const rebuildTaskSnapshotsFromTaskRecord = (taskRecord: unknown): unknown[] => {
  const taskRecordValue = toRecord(taskRecord);
  const taskId = normalizeString(taskRecordValue.taskId);
  if (!taskId) return [];
  const taskProjectPath = normalizeString(taskRecordValue.projectPath);
  const events = readTaskArchiveEvents({
    taskId,
    ...(taskProjectPath ? { projectPath: taskProjectPath } : {}),
    metadata: taskRecordValue.metadata || undefined,
    event: undefined,
  } as Parameters<typeof readTaskArchiveEvents>[0]);
  const latestByTaskId = new Map<string, unknown>();
  for (const event of events) {
    const eventValue = toRecord(event);
    const snapshot = toRecord(toRecord(eventValue.snapshot).task);
    const normalized = normalizeTaskRecord(snapshot, snapshot.id);
    const normalizedValue = toRecord(normalized);
    const normalizedId = normalizeString(normalizedValue.id);
    if (!normalizedId) continue;
    latestByTaskId.set(normalizedId, normalized);
  }
  return Array.from(latestByTaskId.values());
};

const appendTaskInputUploadArchiveEvent = (
  record: unknown,
  type: string,
  detail: unknown,
) => {
  const recordValue = toRecord(record);
  const metadata = asTaskArchiveMetadata(recordValue.metadata);
  const taskId = normalizeString(
    metadata.taskId || recordValue.taskId || recordValue.id,
  );
  if (!taskId) return null;
  const projectPath = resolveProjectPathFromMetadata(metadata);
  const normalizedUploads = normalizeTaskInputUploads(detail);
  return appendTaskArchiveEvent({
    taskId,
    ...(projectPath ? { projectPath } : {}),
    metadata,
    event: {
      taskId,
      type,
      timestamp: new Date().toISOString(),
      metadata: summarizeArchiveValue(metadata, "metadata"),
      detail: summarizeArchiveValue(
        normalizedUploads ?? detail,
        "detail",
      ),
    },
  } as Parameters<typeof appendTaskArchiveEvent>[0]);
};

const appendTaskArchiveEventSafely = (
  record: unknown,
  type: string,
  detail: unknown,
  warningMessage: string,
) => {
  try {
    const recordValue = toRecord(record);
    const metadata = asTaskArchiveMetadata(recordValue.metadata);
    const taskId = normalizeString(
      metadata.taskId || recordValue.taskId || recordValue.id,
    );
    const projectPath = resolveProjectPathFromMetadata(metadata);
    if (!taskId || !projectPath) return null;
    return appendTaskArchiveEvent({
      taskId,
      projectPath,
      metadata,
      event: {
        taskId,
        type,
        timestamp: new Date().toISOString(),
        metadata: summarizeArchiveValue(metadata, "metadata"),
        detail: summarizeArchiveValue(detail, "detail"),
      },
    } as Parameters<typeof appendTaskArchiveEvent>[0]);
  } catch (error) {
    loggingModule.logWarn(warningMessage, { error: getErrorMessage(error) });
    return null;
  }
};

export {
  readTaskArchiveEventsForTaskEngine as readTaskArchiveEvents,
  resolveProjectPathFromMetadata,
  writeTaskArchiveSnapshot,
  rebuildTaskSnapshotsFromTaskRecord,
  appendTaskInputUploadArchiveEvent,
  appendTaskArchiveEventSafely,
  summarizeArchiveResponse,
};
