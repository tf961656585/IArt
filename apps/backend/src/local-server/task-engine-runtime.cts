import * as backendIpcSenderModule from "./backend-ipc-sender.cts";
import * as loggingModule from "./logging.cts";
import {
  readTaskArchiveEvents,
  resolveProjectPathFromMetadata,
} from "./task-engine-archive.cts";
import { executeHttpTask } from "./task-engine-http.cts";
import {
  type TaskProgressPatch,
  mergeTaskProgressPatch,
  patchTaskRecord,
} from "./task-engine-state.cts";
import {
  type PlainObject,
  getErrorMessage,
  isTaskFinalStatus,
  TASK_STATUS,
  toRecord,
} from "./task-engine-shared.cts";
import {
  normalizeString,
  normalizeTaskStatus,
  normalizeTaskType,
} from "./task-normalizer.cts";
import { normalizePositiveInt } from "./utils.cts";
import {
  isUnsettledCancelRecord,
  readCancelRecord,
  settleCancelledTask,
} from "./task-cancel-service.cts";

const { sendReadTasks } = backendIpcSenderModule;
const STALE_TASK_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/**
 * 恢复链（后端启动扫描）专用。
 *
 * 在途任务注册表与取消命令的**唯一实现**在 `task-executor.cts`（所有派发都经它登记，
 * 取消路由与 agent 工具循环都消费那一份）。本模块曾另有一份从未被填充的 Map 与
 * 同名 `cancelTaskExecution`，任何调用都会恒返回 false；已删除，不要在恢复链重新引入
 * 第二份在途登记。
 */
const resumeIncompletePollingTasks = async (options: unknown = {}) => {
  const optionsValue = toRecord(options);
  const resolvedProjectPath =
    typeof optionsValue.projectPath === "string"
      ? optionsValue.projectPath.trim()
      : "";
  const limit = normalizePositiveInt(optionsValue.limit, 200);
  const markResumeFailed = async (
    record: unknown,
    code: unknown,
    message: unknown,
  ) =>
    await patchTaskRecord(record, {
      status: TASK_STATUS.FAILED,
      finishedAt: Date.now(),
      error: { code, message, stage: "recovery" },
      progress: mergeTaskProgressPatch(toRecord(record).progress, {
        phase: null,
      } as TaskProgressPatch),
    } as PlainObject);
  const hasSubmittedArchiveEvent = (record: unknown) => {
    const recordValue = toRecord(record);
    const metadata = toRecord(recordValue.metadata);
    const taskId = normalizeString(
      metadata.taskId || recordValue.taskId || recordValue.id,
    );
    if (!taskId) return false;
    const _submittedProjectPath = resolveProjectPathFromMetadata(metadata);
    const events = readTaskArchiveEvents({
      taskId,
      ...(_submittedProjectPath ? { projectPath: _submittedProjectPath } : {}),
      metadata,
    });
    return events.some((event: unknown) => {
      const phase = normalizeString(
        toRecord(toRecord(event).detail).phase,
      ).toLowerCase();
      return phase === "requesting" || phase === "downloading";
    });
  };
  if (!resolvedProjectPath) return { started: 0, failed: 0 };
  let records = [];
  try {
    const result = await sendReadTasks({
      projectPath: resolvedProjectPath,
      status: null,
      limit: 1000,
      offset: 0,
    });
    records = Array.isArray(result !== null && result !== undefined ? result.data : undefined) ? (result !== null ? result.data : []) as unknown[] : [];
  } catch (error) {
    loggingModule.logWarn(
      "[task-engine] sendReadTasks failed in resumeIncompletePollingTasks:",
      { error: getErrorMessage(error) },
    );
    return { started: 0, failed: 0 };
  }
  const candidates = records.filter((item: unknown) => {
    const itemValue = toRecord(item);
    if (Object.keys(itemValue).length === 0) return false;
    const status = normalizeTaskStatus(itemValue.status);
    if (
      status !== TASK_STATUS.SUBMITTING &&
      status !== TASK_STATUS.GENERATING &&
      status !== TASK_STATUS.POLLING &&
      status !== TASK_STATUS.DOWNLOADING
    ) {
      return false;
    }
    const type = normalizeTaskType(itemValue.type);
    return type === "http";
  });
  if (candidates.length === 0) return { started: 0, failed: 0 };
  const started = 0;
  let failed = 0;
  for (const item of candidates) {
    if (started >= limit) break;
    const record = toRecord(item);
    if (!record.id) continue;
    const type = normalizeTaskType(record.type);
    if (type !== "http") continue;
    const status = normalizeTaskStatus(record.status);
    const terminal = isTaskFinalStatus(status) || Boolean(record.finishedAt);
    if (terminal) continue;
    if (
      status !== TASK_STATUS.SUBMITTING &&
      status !== TASK_STATUS.GENERATING &&
      status !== TASK_STATUS.POLLING &&
      status !== TASK_STATUS.DOWNLOADING
    ) {
      continue;
    }
    const age = Date.now() - Number(record.updatedAt || record.createdAt || 0);
    if (age > STALE_TASK_TIMEOUT_MS) {
      failed += 1;
      await markResumeFailed(
        record,
        "stale_task_timeout",
        "Task recovery skipped because task state is stale",
      );
      continue;
    }
    // 恢复路径（spec task-state-machine recovery）：遇未结算取消记录先结算为独立 cancelled，
    // 不再标记 failed、不重提、不重发远端请求。
    if (isUnsettledCancelRecord(record.metadata)) {
      const cancelRecord = readCancelRecord(record.metadata);
      if (cancelRecord) {
        await settleCancelledTask({
          taskId: normalizeString(record.id || record.taskId) || String(record.id ?? ""),
          projectPath: normalizeString(record.projectPath) || resolvedProjectPath,
          metadata: record.metadata,
          request: record.request ?? null,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          cancelRecord,
        });
        failed += 1;
        continue;
      }
    }
    if (status === TASK_STATUS.POLLING) {
      const metadata = toRecord(record.metadata);
      const hasRemoteId = Boolean(
        normalizeString(metadata.remoteRequestId || metadata.remote_request_id),
      );
      const hasResponse = Boolean(record.response);
      if (!hasRemoteId && !hasResponse) {
        failed += 1;
        await markResumeFailed(
          record,
          "stale_polling_no_remote_id",
          "Task recovery skipped because polling task has no remote request id and no response snapshot",
        );
        continue;
      }
      failed += 1;
      await markResumeFailed(
        record,
        "polling_recovery_not_supported",
        "Task recovery for polling state is not supported yet",
      );
      continue;
    }
    if (status === TASK_STATUS.DOWNLOADING) {
      failed += 1;
      await markResumeFailed(
        record,
        "downloading_recovery_not_supported",
        "Task recovery for downloading state is not supported yet",
      );
      continue;
    }
    if (status === TASK_STATUS.SUBMITTING && hasSubmittedArchiveEvent(record)) {
      failed += 1;
      await markResumeFailed(
        record,
        "inconsistent_submitting_state",
        "Task recovery skipped because submitting state is inconsistent with archive events",
      );
      continue;
    }
    failed += 1;
    await markResumeFailed(
      record,
      "submitting_recovery_not_supported",
      "Task recovery for submitting state is not supported",
    );
  }
  return { started, failed };
};

export {
  executeHttpTask,
  resumeIncompletePollingTasks,
};
