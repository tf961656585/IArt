import { UNIFIED_GENERATION_RUNNING_STATUSES } from '@iart/contracts';
import * as loggingModule from './logging.cts';
import * as taskEngineModule from './task-engine.cts';
import * as backendIpcSenderModule from './backend-ipc-sender.cts';
import * as taskResultOutputMappingModule from './task-result-output-mapping.cts';
import * as taskResultMaterializerModule from './task-result-materializer.cts';
import * as taskRecordViewModule from './task-record-view.cts';
import { executePollingTask } from './task-engine-polling.cts';
import type { LocalTaskOutput } from './task-result-materializer.cts';
import { toRecord } from './task-engine-shared.cts';
import { resolveProjectPathFromMetadata } from './task-engine-archive.cts';
const { sendReadTasks, sendReadTaskById } = backendIpcSenderModule;
const { hasResultOutputMapping } = taskResultOutputMappingModule;
const { executeTaskResultMaterialization } = taskResultMaterializerModule;
const { readTaskRecordId } = taskRecordViewModule;
const {
  executeHttpTask,
  patchTaskRecord,
} = taskEngineModule;
type TaskRecordRaw = {
  taskId: unknown | undefined;
  id: unknown | undefined;
  metadata: unknown | undefined;
  projectPath: unknown | undefined;
  status: unknown | undefined;
  request: unknown | undefined;
  response: unknown | undefined;
  progress: unknown | undefined;
};
type InFlightTask = {
  controller: AbortController;
  promise: Promise<unknown>;
};
type ResumeIncompleteTasksOptions = {
  limit: unknown | undefined;
  projectPath: unknown | undefined;
};
type ReadTasksResultRaw = {
  data: unknown | undefined;
};
const inFlightTasks = new Map<string, InFlightTask>();
const RUNTIME_RUNNING_STATUS_SET = new Set<string>(UNIFIED_GENERATION_RUNNING_STATUSES);
const normalizeString = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : '';
const isPlainObject = (value: unknown): value is object => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null;
};
const readOwnObjectValue = (value: object, key: string): unknown | undefined => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor ? descriptor.value : undefined;
};
const EMPTY_TASK_RECORD_RAW: TaskRecordRaw = {
  taskId: undefined,
  id: undefined,
  metadata: undefined,
  projectPath: undefined,
  status: undefined,
  request: undefined,
  response: undefined,
  progress: undefined,
};
const EMPTY_RESUME_INCOMPLETE_TASKS_OPTIONS: ResumeIncompleteTasksOptions = {
  limit: undefined,
  projectPath: undefined,
};
const EMPTY_READ_TASKS_RESULT_RAW: ReadTasksResultRaw = {
  data: undefined,
};
const asTaskRecordRaw = (value: unknown): TaskRecordRaw => {
  if (!isPlainObject(value)) return EMPTY_TASK_RECORD_RAW;
  return {
    taskId: readOwnObjectValue(value, 'taskId'),
    id: readOwnObjectValue(value, 'id'),
    metadata: readOwnObjectValue(value, 'metadata'),
    projectPath: readOwnObjectValue(value, 'projectPath'),
    status: readOwnObjectValue(value, 'status'),
    request: readOwnObjectValue(value, 'request'),
    response: readOwnObjectValue(value, 'response'),
    progress: readOwnObjectValue(value, 'progress'),
  };
};
const asResumeIncompleteTasksOptions = (value: unknown): ResumeIncompleteTasksOptions => {
  if (!isPlainObject(value)) return EMPTY_RESUME_INCOMPLETE_TASKS_OPTIONS;
  return {
    limit: readOwnObjectValue(value, 'limit'),
    projectPath: readOwnObjectValue(value, 'projectPath'),
  };
};
const asReadTasksResultRaw = (value: unknown): ReadTasksResultRaw => {
  if (!isPlainObject(value)) return EMPTY_READ_TASKS_RESULT_RAW;
  return { data: readOwnObjectValue(value, 'data') };
};
const getErrorMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : normalizeString(error) || fallback;

/**
 * 失败兜底前重读任务的当前记录（P0 修复）。
 *
 * 原因：执行链（结果物化等）可能已经把具体失败与远端任务号 / 执行快照写入任务记录。
 * catch 若用提交时的旧 record 再 patch 一次通用错误，会把那些更具体的失败覆盖掉。
 *
 * 重读失败（IPC 不可用 / 记录不存在）时返回原始 record —— 保留既有兜底行为，但必须
 * logWarn 留痕，否则「为什么又写回旧记录」在排查中不可见。
 */
const readCurrentTaskRecordForFailure = async (
  fallbackRecord: unknown,
  taskId: string,
): Promise<unknown> => {
  const recordValue = asTaskRecordRaw(fallbackRecord);
  // 记录可能只把项目路径放在 metadata（历史记录形态），两处都要看。
  const projectPath =
    normalizeString(recordValue.projectPath) ||
    normalizeString(resolveProjectPathFromMetadata(recordValue.metadata));
  if (!projectPath) {
    loggingModule.logDebug('[task-executor] skip task re-read before failure patch: missing projectPath', { taskId });
    return fallbackRecord;
  }
  try {
    const result = await sendReadTaskById({ projectPath, taskId });
    if (result.success && result.data) return result.data;
    loggingModule.logWarn('[task-executor] failed to re-read task before failure patch:', {
      taskId,
      reason: result.error ?? 'empty task record',
    });
    return fallbackRecord;
  } catch (readError) {
    loggingModule.logWarn('[task-executor] failed to re-read task before failure patch:', {
      taskId,
      error: getErrorMessage(readError, 'sendReadTaskById failed'),
    });
    return fallbackRecord;
  }
};
async function executeTaskMediaDownload(taskRecordInput: unknown): Promise<LocalTaskOutput[]> {
  return executeTaskResultMaterialization(taskRecordInput, undefined);
}

/**
 * 轮询收尾后的物化收口（提交链与重新查询共用同一份实现）。
 *
 * 轮询命中成功证据后，带 `result_output_mapping` 的任务只推进到 result_received，
 * 正式产物（task_outputs / media_assets）必须由物化链落定；映射未命中时物化链自己写入
 * `result_mapping` 失败并抛错，调用方据此走失败兜底。
 */
async function finalizePolledTaskOutcome(
  executed: unknown,
  controller: AbortController | undefined,
): Promise<unknown> {
  // 已被取消（取消屏障已生效）时不再物化：写入会被屏障丢弃，但下载仍会真实发出。
  if (controller?.signal.aborted) return executed;
  const executedTaskRecord = asTaskRecordRaw(executed);
  if (
    isPlainObject(executed) &&
    normalizeString(executedTaskRecord.status) !== 'failed' &&
    hasResultOutputMapping(executed)
  ) {
    await executeTaskResultMaterialization(executed, controller);
  }
  return executed;
}

async function startTaskExecution(taskRecordInput: unknown): Promise<unknown> {
  const initialTaskRecord = asTaskRecordRaw(taskRecordInput);
  const taskId = readTaskRecordId(initialTaskRecord);
  if (!taskId) return taskRecordInput;
  const inFlightTask = inFlightTasks.get(taskId);
  if (inFlightTask) {
    return inFlightTask.promise;
  }
  const controller = new AbortController();
  const promise = (async (): Promise<unknown> => {
    const executed = await executeHttpTask(taskRecordInput, controller);
    return finalizePolledTaskOutcome(executed, controller);
  })();
  inFlightTasks.set(taskId, { controller, promise });
  try {
    return await promise;
  } catch (error) {
    // 先重读当前记录：物化/轮询阶段可能已把具体失败（含远端任务号与执行快照）落库，
    // 用提交时的旧 record 再写一次通用失败会覆盖它们（P0）。
    const currentRecord = await readCurrentTaskRecordForFailure(taskRecordInput, taskId);
    if (normalizeString(asTaskRecordRaw(currentRecord).status) === 'failed') {
      return currentRecord;
    }
    try {
      const failurePatch = toRecord({
        status: 'failed',
        finishedAt: Date.now(),
        error: {
          code: 'task_execution_unexpected_error',
          message: getErrorMessage(error, 'Unexpected execution error'),
          stage: 'unknown',
        },
      });
      await patchTaskRecord(currentRecord, failurePatch);
    } catch (patchError) {
      loggingModule.logWarn('[task-executor] Failed to mark task execution failure:', { error: getErrorMessage(patchError, 'patchTaskRecord failed') });
    }
    throw error;
  } finally {
    inFlightTasks.delete(taskId);
  }
}
type RequeryDispatchInput = {
  /** 当前落库记录（RuntimeTaskView 形状即可）；只作为轮询入口的基线，不重建提交链。 */
  record: unknown | undefined;
  /** 按当前接口格式与配方重建的轮询请求（不含远端任务号替换后的地址）。 */
  request: unknown | undefined;
  /** 按当前接口格式与配方重建的轮询策略（间隔 / 次数上限 → 一轮完整的新等待预算）。 */
  polling: unknown | undefined;
  /** 与入口状态写入合并的复位补丁（status / finishedAt / error / response / progress / metadata）。 */
  initialPatch: unknown | undefined;
};

type StartTaskRequeryResult =
  | { started: true; promise: Promise<unknown> }
  | { started: false; reason: 'invalid_task' | 'in_flight' };

const EMPTY_REQUERY_DISPATCH_INPUT: RequeryDispatchInput = {
  record: undefined,
  request: undefined,
  polling: undefined,
  initialPatch: undefined,
};

const asRequeryDispatchInput = (value: unknown): RequeryDispatchInput => {
  if (!isPlainObject(value)) return EMPTY_REQUERY_DISPATCH_INPUT;
  return {
    record: readOwnObjectValue(value, 'record'),
    request: readOwnObjectValue(value, 'request'),
    polling: readOwnObjectValue(value, 'polling'),
    initialPatch: readOwnObjectValue(value, 'initialPatch'),
  };
};

/**
 * 重新查询派发（failed → polling）：与首次执行共用同一个在途注册表。
 *
 * 复用 `inFlightTasks` 的目的：取消按钮（`cancelTaskExecution`）对重新查询同样有效，
 * 且同一任务同一时刻只接受一次重新查询（单飞）。不复制执行器：入口状态写入仍由
 * 轮询引擎完成（`overrides.initialPatch`），轮询收尾物化仍走 `finalizePolledTaskOutcome`。
 *
 * 调用方（task-requery）在派发成功时写 `task.requery_requested` / `task.requery_started`：
 * 前者记录命令受理与旧的失败阶段，后者记录引擎已进入等待（同一时刻派发）。
 *
 * 返回 Promise 供调用方 / 测试等待；内部不抛错——上游把失败写进任务记录后此处只做兜底
 * （与 `startTaskExecution` 同口径：先重读，已 failed 不覆盖）。
 */
function startTaskRequery(input: unknown): StartTaskRequeryResult {
  const dispatch = asRequeryDispatchInput(input);
  const recordView = asTaskRecordRaw(dispatch.record);
  const taskId = readTaskRecordId(recordView);
  if (!taskId) return { started: false, reason: 'invalid_task' };
  if (inFlightTasks.has(taskId)) return { started: false, reason: 'in_flight' };
  const controller = new AbortController();
  const promise = (async (): Promise<unknown> => {
    try {
      const polled = await executePollingTask(dispatch.record, controller, {
        request: dispatch.request,
        polling: dispatch.polling,
        initialPatch: dispatch.initialPatch,
      });
      return await finalizePolledTaskOutcome(polled, controller);
    } catch (error) {
      const currentRecord = await readCurrentTaskRecordForFailure(dispatch.record, taskId);
      if (normalizeString(asTaskRecordRaw(currentRecord).status) === 'failed') {
        return currentRecord;
      }
      loggingModule.logWarn('[task-executor] requery execution failed without a persisted failure:', {
        taskId,
        error: getErrorMessage(error, 'Unexpected requery error'),
      });
      try {
        await patchTaskRecord(currentRecord, toRecord({
          status: 'failed',
          finishedAt: Date.now(),
          error: {
            code: 'task_execution_unexpected_error',
            message: getErrorMessage(error, 'Unexpected requery error'),
            stage: 'unknown',
          },
        }));
      } catch (patchError) {
        loggingModule.logWarn('[task-executor] Failed to mark requery failure:', {
          error: getErrorMessage(patchError, 'patchTaskRecord failed'),
        });
      }
      return currentRecord;
    } finally {
      inFlightTasks.delete(taskId);
    }
  })();
  inFlightTasks.set(taskId, { controller, promise });
  return { started: true, promise };
}

function cancelTaskExecution(taskIdInput: unknown) {
  const taskId = normalizeString(taskIdInput);
  const entry = inFlightTasks.get(taskId);
  if (entry) {
    entry.controller.abort();
    return true;
  }
  return false;
}
async function resumeIncompleteTasks(optionsInput: unknown = {}) {
  const options = asResumeIncompleteTasksOptions(optionsInput);
  const limit = Number.isFinite(options.limit) && Number(options.limit) > 0 ? Number(options.limit) : 200;
  const projectPath = normalizeString(options.projectPath) || '';
  if (!projectPath) return { started: 0 };
  let candidates: unknown[] = [];
  try {
    const result = asReadTasksResultRaw(await sendReadTasks({ projectPath, status: null, limit: 1000, offset: 0 }));
    candidates = (Array.isArray(result.data) ? result.data : []).filter((taskRecordInput: unknown) => {
      const taskRecord = asTaskRecordRaw(taskRecordInput);
      const status = normalizeString(taskRecord.status).toLowerCase();
      return RUNTIME_RUNNING_STATUS_SET.has(status);
    });
  } catch (error) {
    loggingModule.logWarn('[task-executor] sendReadTasks failed in resumeIncompleteTasks:', { error: getErrorMessage(error, 'sendReadTasks failed') });
    return { started: 0 };
  }
  let started = 0;
  for (const item of candidates) {
    if (started >= limit) break;
    const itemTaskRecord = asTaskRecordRaw(item);
    const taskId = readTaskRecordId(itemTaskRecord);
    if (!taskId) continue;
    let latest: unknown = item;
    try {
      const itemProjectPath = normalizeString(itemTaskRecord.projectPath) || projectPath;
      if (itemProjectPath) {
        const result = await sendReadTaskById({ projectPath: itemProjectPath, taskId });
        if (result.success && result.data) latest = result.data;
      }
    } catch { void 0; }
    if (!latest) continue;
    started += 1;
    void startTaskExecution(latest);
  }
  return { started };
}
export {
  inFlightTasks,
  startTaskExecution,
  startTaskRequery,
  executeTaskMediaDownload,
  executeTaskResultMaterialization,
  cancelTaskExecution,
  resumeIncompleteTasks,
};
