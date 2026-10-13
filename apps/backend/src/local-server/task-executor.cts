import { UNIFIED_GENERATION_RUNNING_STATUSES } from '@iart/contracts';
import * as loggingModule from './logging.cts';
import * as taskEngineModule from './task-engine.cts';
import * as backendIpcSenderModule from './backend-ipc-sender.cts';
import * as taskResultOutputMappingModule from './task-result-output-mapping.cts';
import * as taskResultMaterializerModule from './task-result-materializer.cts';
import * as taskRecordViewModule from './task-record-view.cts';
import type { LocalTaskOutput } from './task-result-materializer.cts';
import { toRecord } from './task-engine-shared.cts';
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
async function executeTaskMediaDownload(taskRecordInput: unknown): Promise<LocalTaskOutput[]> {
  return executeTaskResultMaterialization(taskRecordInput, undefined);
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
    const executedTaskRecord = asTaskRecordRaw(executed);
    if (
      isPlainObject(executed) &&
      normalizeString(executedTaskRecord.status) !== 'failed' &&
      hasResultOutputMapping(executed)
    ) {
      await executeTaskResultMaterialization(executed, controller);
      return executed;
    }
    return executed;
  })();
  inFlightTasks.set(taskId, { controller, promise });
  try {
    return await promise;
  } catch (error) {
    try {
      if (normalizeString(asTaskRecordRaw(taskRecordInput).status) === 'failed') {
        return taskRecordInput;
      }
      const failurePatch = toRecord({
        status: 'failed',
        finishedAt: Date.now(),
        error: {
          code: 'task_execution_unexpected_error',
          message: getErrorMessage(error, 'Unexpected execution error'),
        },
      });
      await patchTaskRecord(taskRecordInput, failurePatch);
    } catch (patchError) {
      loggingModule.logWarn('[task-executor] Failed to mark task execution failure:', { error: getErrorMessage(patchError, 'patchTaskRecord failed') });
    }
    throw error;
  } finally {
    inFlightTasks.delete(taskId);
  }
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
  executeTaskMediaDownload,
  executeTaskResultMaterialization,
  cancelTaskExecution,
  resumeIncompleteTasks,
};
