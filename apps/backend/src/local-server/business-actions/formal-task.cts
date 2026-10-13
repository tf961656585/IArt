import { buildRuntimeTaskRow } from "../task-payload-builder.cts";
import {
  projectRuntimeTaskRequestSummary,
} from "../task-storage-summary-projector.cts";
import { normalizeTaskRequest } from "../task-normalizer.cts";
import * as backendIpcSenderModule from "../backend-ipc-sender.cts";
import * as loggingModule from "../logging.cts";
import * as taskArchiveStoreModule from "../task-archive-store.cts";
import * as taskExecutorModule from "../task-executor.cts";
import * as taskStoreModule from "../task-store.cts";

import {
  type BusinessDataView,
  type PersistedTaskRecordView,
  type TaskSubmissionRecordView,
  asRecord,
  cloneValue,
  EDITOR_BACKEND_ACTION_CLASS,
  EDITOR_BACKEND_ASYNC_EVENT,
  buildEditorBackendAsyncAck,
  getBusinessIdentityFromRecord,
  isPlainObject,
  normalizeFormalTaskStatus,
  normalizeMetadata,
  normalizeString,
} from "./common.cts";
import { notifyBusinessActionSubscribers } from "./events.cts";

const { createTaskRecordFromFormalSpec, updateTaskRecord } = taskStoreModule;
const { startTaskExecution } = taskExecutorModule;
const { appendTaskArchiveEvent, resolveProjectPathFromMetadata } =
  taskArchiveStoreModule;
const { sendTaskEvent, sendRuntimeTransaction } = backendIpcSenderModule;
const { logWarn } = loggingModule;
const resolveProjectPathFromMetadataFallback = () => null;

export type BusinessActionFailure = {
  ok: false;
  code: string;
  message: string;
};
export type FormalTaskSubmitOptions = {
  actionId: unknown | undefined;
  actionName: unknown | undefined;
  actionClass: unknown | undefined;
  submissionTransport: string | undefined;
  compatMode: string | undefined;
  preserveLegacyTaskId: boolean | undefined;
};
export type NormalizedExecutionPlanResult =
  | BusinessActionFailure
  | {
      ok: true;
      value: {
        request: unknown;
        type: "http";
        polling: BusinessDataView | null;
        metadata: BusinessDataView;
        autoStart: boolean;
      };
    };
export type TaskSubmissionResult =
  | BusinessActionFailure
  | {
      ok: true;
      record: TaskSubmissionRecordView;
      ack: BusinessDataView;
      autoStart: boolean;
    };
export const normalizeFormalTaskExecutionPlan = (
  payload: unknown,
): NormalizedExecutionPlanResult => {
  const payloadObject = asRecord(payload);
  if (!isPlainObject(payloadObject)) {
    return {
      ok: false,
      code: "invalid_payload",
      message: "Invalid task execution plan payload",
    };
  }
  const submitRequestPayload = isPlainObject(payloadObject.submit_request)
    ? payloadObject.submit_request
    : null;
  const request = normalizeTaskRequest(submitRequestPayload);
  if (!request) {
    return {
      ok: false,
      code: "invalid_job",
      message: "Missing submit_request",
    };
  }
  const pollingStrategy = isPlainObject(payloadObject.polling_strategy)
    ? payloadObject.polling_strategy
    : null;
  const metadata = normalizeMetadata(payloadObject.metadata);
  const modelId =
    normalizeString(metadata.modelId) ||
    normalizeString(metadata.model_id) ||
    normalizeString(payloadObject.model_id);
  if (!modelId) {
    return { ok: false, code: "invalid_job", message: "Missing model_id" };
  }
  metadata.modelId = modelId;
  metadata.model_id = modelId;
  const executionPlan = {
    submit_request_summary: projectRuntimeTaskRequestSummary(
      submitRequestPayload,
      metadata,
    ),
    polling_strategy: cloneValue(pollingStrategy),
    result_rule: isPlainObject(payloadObject.result_rule)
      ? cloneValue(payloadObject.result_rule)
      : null,
    result_acquisition_strategy: isPlainObject(
      payloadObject.result_acquisition_strategy,
    )
      ? cloneValue(payloadObject.result_acquisition_strategy)
      : null,
    result_output_mapping: isPlainObject(payloadObject.result_output_mapping)
      ? cloneValue(payloadObject.result_output_mapping)
      : null,
  };
  metadata.taskExecutionPlan = executionPlan;
  return {
    ok: true,
    value: {
      request,
      type: "http",
      polling: null,
      metadata,
      autoStart:
        payloadObject.auto_start !== false && payloadObject.autoStart !== false,
    },
  };
};
export const createTaskRecordFromFormalSpecCompat = (
  spec: unknown,
  options: FormalTaskSubmitOptions = {} as FormalTaskSubmitOptions,
) =>
  createTaskRecordFromFormalSpec(spec, {
    actionId: normalizeString(options.actionId),
    actionName: normalizeString(options.actionName) || "runtime.task.created",
    actionClass:
      normalizeString(options.actionClass) ||
      EDITOR_BACKEND_ACTION_CLASS.BUSINESS_ASYNC,
    compatMode: normalizeString(options.compatMode) || "formal_task_submit",
    submissionTransport: normalizeString(options.submissionTransport) || "http",
    preserveLegacyTaskId: options.preserveLegacyTaskId === true,
    taskId: undefined,
  });
export const persistBusinessTaskRecord = (
  record: unknown,
): PersistedTaskRecordView => {
  const persisted = asRecord(updateTaskRecord(record, {}));
  try {
    const metadata = normalizeMetadata(persisted.metadata);
    const taskId = normalizeString(
      metadata.taskId || persisted.taskId || persisted.id,
    );
    if (taskId) {
      const projectPath = resolveProjectPathFromMetadata(metadata);
      appendTaskArchiveEvent({
        taskId,
        ...(projectPath ? { projectPath } : {}),
        metadata,
        event: {
          taskId,
          type: "task.accepted",
          timestamp: new Date().toISOString(),
          metadata,
          detail: {
            phase: "accepted",
            submissionTransport:
              normalizeString(metadata.submissionTransport) || "http",
          },
        },
      } as Parameters<typeof appendTaskArchiveEvent>[0]);
      appendTaskArchiveEvent({
        taskId,
        ...(projectPath ? { projectPath } : {}),
        metadata,
        event: {
          taskId,
          type: "task.request_sent",
          timestamp: new Date().toISOString(),
          metadata,
          detail: {
            phase: "requesting",
            submissionTransport:
              normalizeString(metadata.submissionTransport) || "http",
          },
        },
      } as Parameters<typeof appendTaskArchiveEvent>[0]);
    }
  } catch {
    void 0;
  }
  return persisted;
};
export const submitFormalTaskExecutionPlan = async (
  payload: unknown,
  options: FormalTaskSubmitOptions = {} as FormalTaskSubmitOptions,
): Promise<TaskSubmissionResult> => {
  const normalized = normalizeFormalTaskExecutionPlan(payload);
  if (!normalized.ok) return normalized;
  const record = createTaskRecordFromFormalSpecCompat(
    normalized.value,
    options,
  );
  const persisted = persistBusinessTaskRecord(record);
  const identity = getBusinessIdentityFromRecord(persisted);
  if (identity.projectPath && identity.taskId) {
    // Todo 4（Backend GenerationBatch 受理闭环）落地前，本入口不再构造 batches 行：
    // 旧 until-x 形状（sourceNodeId / targetSuccessCount / cancelRequested）已被 RuntimeBatchRowSchema
    // 改为 GenerationBatch 形状（batchId + payloadJson），而旧 metadata 无法重建不可变 BatchIntentSnapshot。
    // 因此这里收窄为不发送批次行，避免用占位快照污染溯源/恢复语义。
    const batchRow: null = null;
    const projectPath = normalizeString(identity.projectPath);
    const taskId = normalizeString(identity.taskId);
    try {
      const transactionResult = await sendRuntimeTransaction({
        projectPath,
        tasks: [
          buildRuntimeTaskRow(persisted, {
            statusNormalizer: normalizeFormalTaskStatus,
            projectPathResolver: resolveProjectPathFromMetadataFallback,
            fallbackStatus: "submitting",
          }),
        ],
        ...(batchRow ? { batches: [batchRow] } : {}),
      });
      if (!transactionResult || transactionResult.success !== true) {
        const message =
          normalizeString((transactionResult !== null && transactionResult !== undefined ? transactionResult.error : undefined)) ||
          "Runtime transaction failed";
        logWarn("write accepted runtime task failed", {
          taskId,
          error: message,
        });
        return {
          ok: false,
          code: "runtime_write_failed",
          message: `Failed to persist task record: ${message}`,
        };
      }
    } catch (error) {
      logWarn("write accepted runtime task failed", {
        taskId,
        error: String(error),
      });
      return {
        ok: false,
        code: "runtime_write_failed",
        message: `Failed to persist task record: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    void sendTaskEvent({
      projectPath,
      event: {
        taskId,
        eventType: "task.accepted",
        payload: {
          status: persisted.status,
          actionId: normalizeString(options.actionId) || null,
          submissionTransport:
            normalizeString(options.submissionTransport) || "http",
        },
        createdAt: Date.now(),
      },
    }).catch((error: unknown) => {
      logWarn("write accepted task event failed", {
        taskId,
        error: String(error),
      });
    });
  }
  const ack = buildEditorBackendAsyncAck({
    actionId: normalizeString(options.actionId),
    actionName: normalizeString(options.actionName) || "runtime.task.created",
    actionClass:
      normalizeString(options.actionClass) ||
      EDITOR_BACKEND_ACTION_CLASS.BUSINESS_ASYNC,
    accepted: true,
    projectPath: identity.projectPath,
    nodeGraphId: identity.nodeGraphId,
    taskId: identity.taskId,
    remoteRequestId: identity.remoteRequestId,
    status: persisted.status,
    emittedAt: Date.now(),
  });
  return {
    ok: true,
    record: persisted,
    ack: {
      ...asRecord(ack),
      status: persisted.status,
      adapter: {
        route: "/api/tasks",
        mode: normalizeString(options.compatMode) || "formal_task_submit",
      },
    },
    autoStart: normalized.value.autoStart,
  };
};
export const startSubmittedTask = (submission: TaskSubmissionResult) => {
  if (!submission.ok || !submission.autoStart || !submission.record) return;
  void startTaskExecution(submission.record).catch((error: unknown) => {
    const taskId = normalizeString(
      submission.record.id || submission.record.taskId,
    );
    if (taskId) {
      try {
        updateTaskRecord(submission.record, {
          status: "failed",
          finishedAt: Date.now(),
          error: {
            code: "task_execution_unhandled_error",
            message: String(
              asRecord(error).message ||
                error ||
                "Unhandled task execution error",
            ),
          },
        });
      } catch (patchError) {
        void patchError;
      }
    }
  });
};
export const flushSubmittedTask = (
  submission: TaskSubmissionResult,
  options: { ackAlreadySent: boolean | undefined } = { ackAlreadySent: undefined },
) => {
  if (!submission.ok || !submission.record) return;
  if (options.ackAlreadySent) {
    notifyBusinessActionSubscribers(submission.record, {
      eventType: EDITOR_BACKEND_ASYNC_EVENT.SNAPSHOT,
    });
  }
  startSubmittedTask(submission);
};
