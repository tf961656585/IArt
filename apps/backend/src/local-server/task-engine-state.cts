import * as loggingModule from "./logging.cts";
import * as taskStoreModule from "./task-store.cts";
import * as backendIpcSenderModule from "./backend-ipc-sender.cts";
import * as taskArchiveStoreModule from "./task-archive-store.cts";
import type {
  RuntimeMediaAssetRow,
  RuntimeMediaAssetView,
  RuntimeTaskOutputRow,
} from "@iart/contracts";
import {
  runtimeMediaAssetRowsToViews,
} from "@iart/contracts";
import {
  buildRuntimeTaskRow,
  buildRuntimeTaskView,
} from "./task-payload-builder.cts";
import {
  resolveProjectPathFromMetadata,
  writeTaskArchiveSnapshot,
} from "./task-engine-archive.cts";
import { awaitRuntimeTaskRowWrite } from "./task-engine-paths.cts";
import { settleTaskTerminal } from "./task-terminal-waiter.cts";
import { shouldDropLateWrite } from "./task-cancel-service.cts";
import {
  getErrorMessage,
  hasOwnField,
  isRecord,
  PROGRESS_NOTIFY_INTERVAL_MS,
  TASK_STATUS,
  toRecord,
  type PlainObject,
} from "./task-engine-shared.cts";
import {
  normalizeString,
  normalizeTaskStatus,
} from "./task-normalizer.cts";

const { logWarn } = loggingModule;
const { updateTaskRecord: updateTaskRecordPure } = taskStoreModule;
const { appendTaskArchiveEvent } = taskArchiveStoreModule;
const {
  sendTaskEvent,
  sendRuntimeTransaction,
  sendTaskStateNotification,
} = backendIpcSenderModule;

type TaskOutputsPayload = {
  taskOutputs: RuntimeTaskOutputRow[] | undefined;
  mediaAssets: RuntimeMediaAssetRow[] | undefined;
};

type PendingProgressEntry = { record: unknown; lastSent: number };

type TaskRecordPatch = {
  createdAt: unknown | undefined;
  error: unknown | undefined;
  execution: { trace: unknown | undefined } | undefined;
  finishedAt: unknown | undefined;
  id: unknown | undefined;
  metadata: unknown | undefined;
  polling: unknown | undefined;
  progress: unknown | undefined;
  projectPath: unknown | undefined;
  request: unknown | undefined;
  response: unknown | undefined;
  startedAt: unknown | undefined;
  status: unknown | undefined;
  taskId: unknown | undefined;
  updatedAt: unknown | undefined;
  version: unknown | undefined;
};

type TaskProgressPatch = {
  attempt: unknown | undefined;
  consecutiveFailures: unknown | undefined;
  maxAttempts: unknown | undefined;
  maxConsecutiveFailures: unknown | undefined;
  message: unknown | undefined;
  percent: unknown | undefined;
  phase: unknown | undefined;
  receivedBytes: unknown | undefined;
  totalBytes: unknown | undefined;
};

const pendingProgress = new Map<string, PendingProgressEntry>();
let progressFlushTimer: ReturnType<typeof setTimeout> | null = null;

const toRuntimeMediaAssetViews = (
  mediaAssets: RuntimeMediaAssetRow[],
): RuntimeMediaAssetView[] =>
  runtimeMediaAssetRowsToViews(mediaAssets, {
    now: undefined,
    onIssue: (issue) => {
      logWarn('[runtime-media-projector] failed to hydrate runtime media asset row', { issue });
    },
  });

const buildRuntimeTaskViewForNotification = (record: unknown) =>
  buildRuntimeTaskView(record, {
    fallbackStatus: undefined,
    statusNormalizer: normalizeTaskStatus,
    projectPathResolver: resolveProjectPathFromMetadata,
  });

const buildRuntimeTaskRowForTransaction = (record: unknown) =>
  buildRuntimeTaskRow(record, {
    fallbackStatus: undefined,
    statusNormalizer: normalizeTaskStatus,
    projectPathResolver: resolveProjectPathFromMetadata,
  });

const projectTaskProgressPatch = (progress: unknown): TaskProgressPatch => {
  const source = toRecord(progress);
  const projected = {} as TaskProgressPatch;
  if (hasOwnField(source, "attempt")) projected.attempt = source.attempt;
  if (hasOwnField(source, "consecutiveFailures"))
    projected.consecutiveFailures = source.consecutiveFailures;
  if (hasOwnField(source, "maxAttempts"))
    projected.maxAttempts = source.maxAttempts;
  if (hasOwnField(source, "maxConsecutiveFailures"))
    projected.maxConsecutiveFailures = source.maxConsecutiveFailures;
  if (hasOwnField(source, "message")) projected.message = source.message;
  if (hasOwnField(source, "percent")) projected.percent = source.percent;
  if (hasOwnField(source, "phase")) projected.phase = source.phase;
  if (hasOwnField(source, "receivedBytes"))
    projected.receivedBytes = source.receivedBytes;
  if (hasOwnField(source, "totalBytes"))
    projected.totalBytes = source.totalBytes;
  return projected;
};

const projectPollingMetadataPatch = (
  metadata: unknown,
  remoteRequestId: unknown,
): PlainObject => {
  const source = toRecord(metadata);
  const projected = {} as PlainObject;
  const normalizedRemoteRequestId = normalizeString(remoteRequestId);
  if (hasOwnField(source, "taskId")) projected.taskId = source.taskId;
  if (normalizedRemoteRequestId)
    projected.remoteRequestId = normalizedRemoteRequestId;
  return projected;
};

const projectTaskRecordPatch = (patch: unknown): TaskRecordPatch => {
  const source = toRecord(patch);
  const projected = {} as TaskRecordPatch;
  if (hasOwnField(source, "createdAt")) projected.createdAt = source.createdAt;
  if (hasOwnField(source, "error")) projected.error = source.error;
  if (hasOwnField(source, "finishedAt"))
    projected.finishedAt = source.finishedAt;
  if (hasOwnField(source, "id")) projected.id = source.id;
  if (hasOwnField(source, "metadata")) projected.metadata = source.metadata;
  if (hasOwnField(source, "polling")) projected.polling = source.polling;
  if (hasOwnField(source, "projectPath"))
    projected.projectPath = source.projectPath;
  if (hasOwnField(source, "request")) projected.request = source.request;
  if (hasOwnField(source, "response")) projected.response = source.response;
  if (hasOwnField(source, "startedAt")) projected.startedAt = source.startedAt;
  if (hasOwnField(source, "status")) projected.status = source.status;
  if (hasOwnField(source, "taskId")) projected.taskId = source.taskId;
  if (hasOwnField(source, "updatedAt")) projected.updatedAt = source.updatedAt;
  if (hasOwnField(source, "progress"))
    projected.progress = projectTaskProgressPatch(source.progress);
  return projected;
};

const mergeTaskProgressPatch = (
  progress: unknown,
  patch: TaskProgressPatch,
): TaskProgressPatch => {
  const projected = projectTaskProgressPatch(progress);
  if (patch.attempt !== undefined) projected.attempt = patch.attempt;
  if (patch.consecutiveFailures !== undefined)
    projected.consecutiveFailures = patch.consecutiveFailures;
  if (patch.maxAttempts !== undefined)
    projected.maxAttempts = patch.maxAttempts;
  if (patch.maxConsecutiveFailures !== undefined)
    projected.maxConsecutiveFailures = patch.maxConsecutiveFailures;
  if (patch.message !== undefined) projected.message = patch.message;
  if (patch.percent !== undefined) projected.percent = patch.percent;
  if (patch.phase !== undefined) projected.phase = patch.phase;
  if (patch.receivedBytes !== undefined)
    projected.receivedBytes = patch.receivedBytes;
  if (patch.totalBytes !== undefined) projected.totalBytes = patch.totalBytes;
  return projected;
};

const handleTerminalPatch = async (persisted: unknown, patch: PlainObject) => {
  const persistedValue = isRecord(persisted) ? persisted : ({} as PlainObject);
  const persistedMetadata = isRecord(persistedValue.metadata)
    ? persistedValue.metadata
    : ({} as PlainObject);
  await awaitRuntimeTaskRowWrite(persisted);
  try {
    const archiveProjectPath =
      resolveProjectPathFromMetadata(persistedMetadata);
    if (archiveProjectPath && (persistedMetadata.taskId || persistedValue.id)) {
      appendTaskArchiveEvent({
        taskId: normalizeString(persistedMetadata.taskId || persistedValue.id),
        projectPath: archiveProjectPath,
        metadata: persistedMetadata,
        event: {
          taskId: normalizeString(
            persistedMetadata.taskId || persistedValue.id,
          ),
          type: patch.status === "succeeded" ? "task.succeeded" : "task.failed",
          timestamp: new Date().toISOString(),
          metadata: persistedMetadata,
          detail: {
            phase: patch.status,
            ...(persistedValue.error ? { error: persistedValue.error } : {}),
          },
        },
      });
    }
  } catch (e) {
    logWarn(
      "[task-engine] Failed to write terminal archive event:",
      { error: getErrorMessage(e) },
    );
  }
  try {
    const projectPath = resolveProjectPathFromMetadata(persistedMetadata);
    const taskId = normalizeString(
      persistedMetadata.taskId || persistedValue.id,
    );
    if (projectPath && taskId) {
      await sendTaskEvent({
        projectPath,
        event: {
          taskId,
          eventType:
            patch.status === "succeeded" ? "task.succeeded" : "task.failed",
          payload: {
            status: patch.status,
            error: persistedValue.error ?? null,
          },
          createdAt: Date.now(),
        },
      });
    }
  } catch (error) {
    logWarn("schedule task event failed", {
      taskId: persistedMetadata.taskId || persistedValue.id,
      error: String(error),
    });
  }
  try {
    writeTaskArchiveSnapshot(persistedValue);
  } catch (error) {
    logWarn(
      "[task-engine] Failed to write terminal archive snapshot:",
      { error: getErrorMessage(error) },
    );
  }
  sendTaskStateNotification({
    type: "task:state-changed",
    projectPath:
      normalizeString(persistedValue.projectPath) ||
      resolveProjectPathFromMetadata(persistedMetadata) ||
      "",
    task: buildRuntimeTaskViewForNotification(persistedValue),
    outputs: [],
    mediaAssets: [],
  });
  // agent 工具调用的阻塞等待结算（spec 04）：无输出终态路径产物为空，
  // 消费方（agent-tool-executor）在成功但无资产时经读取通道兜底。
  settleTaskTerminal(normalizeString(persistedMetadata.taskId || persistedValue.id), {
    status: patch.status === "succeeded" ? "succeeded" : "failed",
    mediaAssets: [],
    errorMessage: persistedValue.error
      ? String(
          (persistedValue.error as { message?: unknown }).message ??
            JSON.stringify(persistedValue.error),
        )
      : null,
  });
};

const clearPendingProgress = (taskId: unknown) => {
  pendingProgress.delete(normalizeString(taskId));
  if (pendingProgress.size === 0 && progressFlushTimer) {
    clearTimeout(progressFlushTimer);
    progressFlushTimer = null;
  }
};

const flushPendingProgress = () => {
  progressFlushTimer = null;
  const now = Date.now();
  for (const [taskId, entry] of pendingProgress) {
    if (now - entry.lastSent >= PROGRESS_NOTIFY_INTERVAL_MS) {
      const recordValue = isRecord(entry.record) ? entry.record : ({} as PlainObject);
      sendTaskStateNotification({
        type: "task:state-changed",
        projectPath:
          normalizeString(recordValue.projectPath) ||
          resolveProjectPathFromMetadata(recordValue.metadata) ||
          "",
        task: buildRuntimeTaskViewForNotification(recordValue),
        outputs: [],
        mediaAssets: [],
      });
      pendingProgress.delete(taskId);
    }
  }
  if (pendingProgress.size > 0) {
    progressFlushTimer = setTimeout(
      flushPendingProgress,
      PROGRESS_NOTIFY_INTERVAL_MS,
    );
  }
};

const scheduleProgressNotify = (record: unknown) => {
  const recordValue = isRecord(record) ? record : ({} as PlainObject);
  const metadata = isRecord(recordValue.metadata) ? recordValue.metadata : ({} as PlainObject);
  const taskId = metadata.taskId || recordValue.id;
  if (!taskId) return;
  const normalizedTaskId = normalizeString(taskId);
  if (!normalizedTaskId) return;
  const now = Date.now();
  const existing = pendingProgress.get(normalizedTaskId);
  if (existing) {
    existing.record = record;
  } else {
    pendingProgress.set(normalizedTaskId, { record, lastSent: now });
  }
  const entry = pendingProgress.get(normalizedTaskId);
  if (!entry) return;
  if (now - entry.lastSent >= PROGRESS_NOTIFY_INTERVAL_MS) {
    sendTaskStateNotification({
      type: "task:state-changed",
      projectPath:
        normalizeString(recordValue.projectPath) ||
        resolveProjectPathFromMetadata(recordValue.metadata) ||
        "",
      task: buildRuntimeTaskViewForNotification(recordValue),
      outputs: [],
      mediaAssets: [],
    });
    entry.lastSent = now;
  } else if (!progressFlushTimer) {
    progressFlushTimer = setTimeout(
      flushPendingProgress,
      PROGRESS_NOTIFY_INTERVAL_MS,
    );
  }
};

const patchTaskRecord = async (record: unknown, patch: PlainObject) => {
  const sourceRecord = toRecord(record);
  const sourceTaskId = sourceRecord.metadata !== null && sourceRecord.metadata !== undefined
    ? toRecord(sourceRecord.metadata).taskId ?? sourceRecord.id ?? sourceRecord.taskId
    : sourceRecord.id ?? sourceRecord.taskId;
  if (shouldDropLateWrite(sourceTaskId)) return record;
  const patchValue = projectTaskRecordPatch(patch);
  patchValue.updatedAt = Date.now();
  const next = updateTaskRecordPure(record, patchValue);
  const persisted = next;
  const persistedValue = toRecord(persisted);
  const metadata = toRecord(persistedValue.metadata);
  const isTerminal = patch.status === "succeeded" || patch.status === "failed";
  const taskId = metadata.taskId || persistedValue.id;
  if (isTerminal) {
    if (taskId) clearPendingProgress(taskId);
    await handleTerminalPatch(persisted, patch);
    return persisted;
  }
  try {
    await awaitRuntimeTaskRowWrite(persisted);
  } catch (error) {
    logWarn(
      "[task-engine] runtime task upsert failed:",
      { error: getErrorMessage(error) },
    );
  }
  const isStatusChange = "status" in patch;
  if (isStatusChange) {
    if (taskId) clearPendingProgress(taskId);
    sendTaskStateNotification({
      type: "task:state-changed",
      projectPath:
        normalizeString(persistedValue.projectPath) ||
        resolveProjectPathFromMetadata(metadata) ||
        "",
      task: buildRuntimeTaskViewForNotification(persisted),
      outputs: [],
      mediaAssets: [],
    });
  } else {
    scheduleProgressNotify(persisted);
  }
  return persisted;
};

const patchTaskRecordWithOutputs = async (
  record: unknown,
  patch: unknown,
  outputs: TaskOutputsPayload | undefined,
) => {
  const preRecord = toRecord(record);
  const preTaskId = preRecord.metadata !== null && preRecord.metadata !== undefined
    ? toRecord(preRecord.metadata).taskId ?? preRecord.id ?? preRecord.taskId
    : preRecord.id ?? preRecord.taskId;
  if (shouldDropLateWrite(preTaskId)) return record;
  const patchValue = projectTaskRecordPatch(patch);
  patchValue.updatedAt = Date.now();
  const persisted = updateTaskRecordPure(record, patchValue);
  const persistedValue = toRecord(persisted);
  const metadata = toRecord(persistedValue.metadata);
  const status = normalizeTaskStatus(patchValue.status, "");
  const isTerminal =
    status === TASK_STATUS.SUCCEEDED || status === TASK_STATUS.FAILED;
  const taskId = metadata.taskId || persistedValue.id;
  const taskOutputs = outputs !== null && outputs !== undefined && Array.isArray(outputs.taskOutputs)
    ? outputs.taskOutputs
    : undefined;
  const mediaAssets = outputs !== null && outputs !== undefined && Array.isArray(outputs.mediaAssets)
    ? outputs.mediaAssets
    : undefined;
  if (isTerminal && (taskOutputs || mediaAssets)) {
    if (taskId) clearPendingProgress(taskId);
    const projectPath =
      normalizeString(persistedValue.projectPath) ||
      resolveProjectPathFromMetadata(metadata);
    if (projectPath) {
      const row = buildRuntimeTaskRowForTransaction(persisted);
      const transactionPayload: {
        projectPath: string;
        tasks: ReturnType<typeof buildRuntimeTaskRow>[];
        taskOutputs: RuntimeTaskOutputRow[] | undefined;
        mediaAssets: RuntimeMediaAssetRow[] | undefined;
      } = { projectPath, tasks: [row], taskOutputs: undefined, mediaAssets: undefined };
      if (taskOutputs) transactionPayload.taskOutputs = taskOutputs;
      if (mediaAssets) transactionPayload.mediaAssets = mediaAssets;
      const transactionResult =
        await sendRuntimeTransaction(transactionPayload);
      if (!transactionResult || transactionResult.success !== true) {
        throw new Error(
          normalizeString((transactionResult !== null && transactionResult !== undefined ? transactionResult.error : undefined)) ||
            "Runtime transaction failed",
        );
      }
    }
    await handleTerminalPatchWithOutputs(
      persisted,
      status,
      taskOutputs ?? [],
      mediaAssets ?? [],
    );
    return persisted;
  }
  if (isTerminal) {
    if (taskId) clearPendingProgress(taskId);
    await handleTerminalPatch(persisted, toRecord(patchValue));
    return persisted;
  }
  try {
    await awaitRuntimeTaskRowWrite(persisted);
  } catch (error) {
    logWarn(
      "[task-engine] runtime task upsert failed:",
      { error: getErrorMessage(error) },
    );
  }
  const isStatusChange = "status" in patchValue;
  if (isStatusChange) {
    if (taskId) clearPendingProgress(taskId);
    sendTaskStateNotification({
      type: "task:state-changed",
      projectPath:
        normalizeString(persistedValue.projectPath) ||
        resolveProjectPathFromMetadata(metadata) ||
        "",
      task: buildRuntimeTaskViewForNotification(persisted),
      outputs: [],
      mediaAssets: [],
    });
  } else {
    scheduleProgressNotify(persisted);
  }
  return persisted;
};

const handleTerminalPatchWithOutputs = async (
  persisted: unknown,
  status: string,
  taskOutputs: RuntimeTaskOutputRow[],
  mediaAssets: RuntimeMediaAssetRow[],
) => {
  const persistedValue = toRecord(persisted);
  const metadata = toRecord(persistedValue.metadata);
  try {
    const archiveProjectPath = resolveProjectPathFromMetadata(metadata);
    const archiveTaskId = normalizeString(metadata.taskId || persistedValue.id);
    if (archiveProjectPath && archiveTaskId) {
      taskArchiveStoreModule.appendTaskArchiveEvent({
        taskId: archiveTaskId,
        projectPath: archiveProjectPath,
        metadata,
        event: {
          taskId: archiveTaskId,
          type:
            status === TASK_STATUS.SUCCEEDED
              ? "task.succeeded"
              : "task.failed",
          timestamp: new Date().toISOString(),
          metadata,
          detail: {
            phase: status,
            ...(persistedValue.error ? { error: persistedValue.error } : {}),
          },
        },
      });
    }
  } catch (e) {
    logWarn(
      "[task-engine] Failed to write terminal archive event:",
      { error: getErrorMessage(e) },
    );
  }
  // 带产物终态与无产物终态（handleTerminalPatch）同口径补写 task_events 事件：
  // task_events 表是数据库内轻量时序（诊断/对账），任务档案 JSONL 是完整事实源——
  // 两条终态路径都必须在两侧各落一条终态事件，缺一即事件流分裂。
  try {
    const projectPath = resolveProjectPathFromMetadata(metadata);
    const taskId = normalizeString(metadata.taskId || persistedValue.id);
    if (projectPath && taskId) {
      await sendTaskEvent({
        projectPath,
        event: {
          taskId,
          eventType:
            status === TASK_STATUS.SUCCEEDED
              ? "task.succeeded"
              : "task.failed",
          payload: {
            status,
            error: persistedValue.error ?? null,
          },
          createdAt: Date.now(),
        },
      });
    }
  } catch (error) {
    logWarn("schedule task event failed", {
      taskId: metadata.taskId || persistedValue.id,
      error: String(error),
    });
  }
  try {
    writeTaskArchiveSnapshot(persisted);
  } catch (error) {
    logWarn(
      "[task-engine] Failed to write terminal archive snapshot:",
      { error: getErrorMessage(error) },
    );
  }
  sendTaskStateNotification({
    type: "task:state-changed",
    projectPath:
      normalizeString(persistedValue.projectPath) ||
      resolveProjectPathFromMetadata(metadata) ||
      "",
    task: buildRuntimeTaskViewForNotification(persisted),
    outputs: taskOutputs,
    mediaAssets: toRuntimeMediaAssetViews(mediaAssets),
  });
  // agent 工具调用的阻塞等待结算（spec 04）：随终态带回产物资产，执行方无需二次读取。
  settleTaskTerminal(normalizeString(metadata.taskId || persistedValue.id), {
    status: status === TASK_STATUS.SUCCEEDED ? "succeeded" : "failed",
    mediaAssets: toRuntimeMediaAssetViews(mediaAssets),
    errorMessage: persistedValue.error
      ? String(
          (persistedValue.error as { message?: unknown }).message ??
            JSON.stringify(persistedValue.error),
        )
      : null,
  });
};

export {
  type TaskProgressPatch,
  projectPollingMetadataPatch,
  mergeTaskProgressPatch,
  patchTaskRecord,
  patchTaskRecordWithOutputs,
};
