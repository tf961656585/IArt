import * as crypto from 'node:crypto';
import { cloneJsonValue } from '@iart/contracts';
import { normalizeTaskPolling, normalizeTaskRequest } from './task-normalizer.cts';
import { projectTaskExecutionPlanSummary } from './task-storage-summary-projector.cts';

const TASK_STORE_VERSION = 1;
const FORMAL_TASK_STATUSES = new Set([
  'submitting',
  'generating',
  'polling',
  'downloading',
  'succeeded',
  'failed',
  'cancelled',
]);

type PlainObject = object;
const TASK_METADATA_KEYS = [
  'actionClass',
  'actionId',
  'actionName',
  // spec 04「血缘与画布投影」：agent 派生任务血缘（{ agentSessionId, toolCallId }，由
  // agent-tool-executor 经 acceptGenerationBatch 写入）。Editor 侧 `parseAgentTaskLineage`
  // 是派生产物落画布资产节点的唯一判据——白名单不放行，血缘就到不了记录 / 通知 / 存储读侧。
  'agentLineage',
  'batch_id',
  'batchId',
  'clientTaskRef',
  'compatMode',
  'compatRoute',
  'executionId',
  'legacyClientTaskId',
  'model_id',
  'modelId',
  'nodeGraphId',
  'projectPath',
  'remote_request_id',
  'remoteRequestId',
  'sourceNodeId',
  'submissionTransport',
  'targetNodeId',
  'taskExecutionPlan',
  'taskId',
  'taskIdOwner',
  'taskIndex',
  'taskStatus',
  'target_success_count',
  'targetSuccessCount',
  'policyTierKey',
  'until_x_success_enabled',
  'untilXSuccessEnabled',
  // spec 03 §8 / spec 45 §5.2：每任务冻结的 ExecutionSnapshot（派发时解析，不可变）
  'executionSnapshot',
  'execution_snapshot',
  'credentialLeaseId',
  // 任务取消记录（backend 本地强类型，spec task-state-machine cancel；结算为 cancelled 终态）
  'taskCancelRecord',
  // @deprecated providerOverride/overrideId 已随 spec 03 废止，仅过渡保留，阶段6 删除
  'providerOverride',
  'overrideId',
] as const;

type TaskMetadataKey = typeof TASK_METADATA_KEYS[number];
type TaskMetadataDraft = Partial<{ [Key in TaskMetadataKey]: unknown }>;

type ExecutionEntryInput = {
  createdAt: unknown | undefined;
  error: unknown | undefined;
  finishedAt: unknown | undefined;
  id: unknown | undefined;
  metadata: unknown | undefined;
  polling: unknown | undefined;
  progress: unknown | undefined;
  request: unknown | undefined;
  response: unknown | undefined;
  startedAt: unknown | undefined;
  status: unknown | undefined;
  stepId: unknown | undefined;
  taskId: unknown | undefined;
  type: unknown | undefined;
  updatedAt: unknown | undefined;
};

type TaskRecordInput = {
  createdAt: unknown | undefined;
  error: unknown | undefined;
  execution: { trace: unknown | undefined } | undefined;
  id: unknown | undefined;
  metadata: unknown | undefined;
  polling: unknown | undefined;
  progress: unknown | undefined;
  projectPath: unknown | undefined;
  request: unknown | undefined;
  response: unknown | undefined;
  status: unknown | undefined;
  taskId: unknown | undefined;
  updatedAt: unknown | undefined;
  version: unknown | undefined;
};

type FormalTaskSpecInput = {
  metadata: unknown | undefined;
  polling: unknown | undefined;
  request: unknown | undefined;
};

type FormalTaskExecutionPlanPollingInput = {
  polling_strategy: unknown | undefined;
};

type SubmissionOptions = {
  actionClass: unknown | undefined;
  actionId: unknown | undefined;
  actionName: unknown | undefined;
  compatMode: unknown | undefined;
  preserveLegacyTaskId: unknown | undefined;
  submissionTransport: unknown | undefined;
  taskId: unknown | undefined;
};

const normalizeString = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : '';

const isPlainObject = <T extends object = PlainObject>(value: unknown): value is T => {
  if (!value || typeof value !== 'object') return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const cloneValue = <T,>(value: T): T => {
  if (value === null || value === undefined) return value;
  return cloneJsonValue(value);
};

const projectFormalPlanPolling = (metadata: TaskMetadataDraft): unknown => {
  if (!isPlainObject<FormalTaskExecutionPlanPollingInput>(metadata.taskExecutionPlan)) {
    return null;
  }
  const plan = metadata.taskExecutionPlan;
  if (!isPlainObject(plan.polling_strategy)) {
    return null;
  }
  const pollingStrategy = plan.polling_strategy as {
    polling: unknown | undefined;
  };
  return normalizeTaskPolling(pollingStrategy.polling);
};

const normalizeTaskMetadata = (value: unknown): TaskMetadataDraft => {
  if (!isPlainObject<Partial<Record<TaskMetadataKey, unknown>>>(value)) return {} as TaskMetadataDraft;
  const metadata = {} as TaskMetadataDraft;
  for (const key of TASK_METADATA_KEYS) {
    if (value[key] === undefined) continue;
    if (key === 'taskExecutionPlan') {
      metadata[key] = projectTaskExecutionPlanSummary(value[key]);
      continue;
    }
    metadata[key] = cloneValue(value[key]);
  }
  return metadata;
};

const normalizeFormalTaskStatus = (value: unknown, fallback = 'submitting') => {
  const normalized = normalizeString(value).toLowerCase();
  return FORMAL_TASK_STATUSES.has(normalized) ? normalized : fallback;
};

const normalizeExecutionEntry = (entry: unknown) => {
  if (!isPlainObject<ExecutionEntryInput>(entry)) return null;
  const id = normalizeString(entry.id || entry.stepId || entry.type);
  const type = normalizeString(entry.type).toLowerCase();
  if (!id) return null;
  if (type !== 'request' && type !== 'poll' && type !== 'download') return null;
  return {
    id,
    taskId: normalizeString(entry.taskId) || null,
    type,
    status: normalizeFormalTaskStatus(entry.status),
    createdAt: Number.isFinite(entry.createdAt) ? Number(entry.createdAt) : Date.now(),
    updatedAt: Number.isFinite(entry.updatedAt) ? Number(entry.updatedAt) : Date.now(),
    startedAt: Number.isFinite(entry.startedAt) ? Number(entry.startedAt) : null,
    finishedAt: Number.isFinite(entry.finishedAt) ? Number(entry.finishedAt) : null,
    request: cloneValue(entry.request ?? null),
    polling: cloneValue(entry.polling ?? null),
    response: cloneValue(entry.response ?? null),
    error: cloneValue(entry.error ?? null),
    metadata: isPlainObject(entry.metadata) ? cloneValue(entry.metadata) : {},
    progress: cloneValue(entry.progress ?? null),
  };
};

const normalizeTaskRecord = (raw: unknown, fallbackTaskId = '') => {
  if (!isPlainObject<TaskRecordInput>(raw)) return null;
  const taskId = normalizeString(raw.taskId || raw.id || fallbackTaskId);
  if (!taskId) return null;
  const metadata = normalizeTaskMetadata(raw.metadata);
  metadata.taskId = taskId;
  const createdAt = Number.isFinite(raw.createdAt) ? Number(raw.createdAt) : Date.now();
  const updatedAt = Number.isFinite(raw.updatedAt) ? Number(raw.updatedAt) : createdAt;
  return {
    version: TASK_STORE_VERSION,
    taskId,
    id: taskId,
    projectPath: normalizeString(raw.projectPath) || null,
    status: normalizeFormalTaskStatus(raw.status),
    createdAt,
    updatedAt,
    request: cloneValue(raw.request ?? null),
    polling: normalizeTaskPolling(raw.polling),
    response: cloneValue(raw.response ?? null),
    error: cloneValue(raw.error ?? null),
    metadata,
    progress: cloneValue(raw.progress ?? null),
    execution: {
      trace: (raw.execution !== null && raw.execution !== undefined && Array.isArray(raw.execution.trace))
        ? (raw.execution.trace as unknown[]).map((entry: unknown) => normalizeExecutionEntry(entry)).filter(Boolean)
        : [],
    },
  };
};

const buildExecutionTrace = (existingTaskRecord: unknown, patch: unknown = {}, taskId = '') => {
  const existingRecord = isPlainObject<TaskRecordInput>(existingTaskRecord) ? existingTaskRecord : ({} as TaskRecordInput);
  const patchRecord = isPlainObject<TaskRecordInput>(patch) ? patch : ({} as TaskRecordInput);
  const trace = (patchRecord.execution !== null && patchRecord.execution !== undefined && Array.isArray(patchRecord.execution.trace))
    ? patchRecord.execution.trace as unknown[]
    : (existingRecord.execution !== null && existingRecord.execution !== undefined && Array.isArray(existingRecord.execution.trace))
      ? existingRecord.execution.trace as unknown[]
      : [];
  return trace.map((entry) => normalizeExecutionEntry(isPlainObject(entry) ? { ...entry, taskId } : entry)).filter(Boolean);
};

const assignTaskIdForSubmission = (metadata: TaskMetadataDraft, options: SubmissionOptions = {} as SubmissionOptions) => {
  const requestedTaskId = normalizeString(metadata.taskId);
  const requestedClientTaskRef = normalizeString(metadata.clientTaskRef);
  const requestedLocalRef = requestedTaskId || requestedClientTaskRef;
  const fallbackTaskId = requestedLocalRef || normalizeString(options.taskId);
  // 调用方显式铸造的 taskId（batch 受理：响应 task_id 先于记录构建确定，受理响应是
  // Editor 投影创建的唯一触发事实）。此时必须沿用该 id 落库，否则后续所有状态通知的
  // taskId 与受理响应对不上，Editor 投影永远匹配不到节点、停在初始状态。
  const optionsTaskId = normalizeString(options.taskId);
  if (optionsTaskId && !requestedLocalRef) {
    metadata.taskId = optionsTaskId;
    return metadata.taskId;
  }
  if (options.preserveLegacyTaskId) {
    metadata.clientTaskRef = fallbackTaskId;
    metadata.taskId = fallbackTaskId;
    return metadata.taskId;
  }
  if (requestedLocalRef) {
    metadata.clientTaskRef = requestedLocalRef;
    metadata.legacyClientTaskId = requestedLocalRef;
  }
  metadata.taskId = `task_${crypto.randomUUID()}`;
  return metadata.taskId;
};

const createTaskRecordFromFormalSpec = (spec: unknown, options: SubmissionOptions = {} as SubmissionOptions) => {
  const specRecord = isPlainObject<FormalTaskSpecInput>(spec) ? spec : ({} as FormalTaskSpecInput);
  const now = Date.now();
  const metadata = normalizeTaskMetadata(specRecord.metadata);
  const actionId = normalizeString(options.actionId);
  const actionName = normalizeString(options.actionName) || 'runtime.task.created';
  const actionClass = normalizeString(options.actionClass) || 'business_async';
  const compatMode = normalizeString(options.compatMode) || 'formal_task_submit';

  if (actionId) metadata.actionId = actionId;
  metadata.actionName = actionName;
  metadata.actionClass = actionClass;
  metadata.compatRoute = '/api/tasks';
  metadata.compatMode = compatMode;
  metadata.submissionTransport = normalizeString(options.submissionTransport) || 'http';
  metadata.taskIdOwner = 'backend';
  metadata.projectPath = normalizeString(metadata.projectPath) || null;
  metadata.nodeGraphId = normalizeString(metadata.nodeGraphId) || null;
  metadata.sourceNodeId = normalizeString(metadata.sourceNodeId) || null;
  metadata.targetNodeId = normalizeString(metadata.targetNodeId) || null;
  metadata.executionId = normalizeString(metadata.executionId) || null;
  metadata.modelId = normalizeString(metadata.modelId || metadata.model_id) || null;
  metadata.model_id = metadata.modelId;

  const taskId = assignTaskIdForSubmission(metadata, {
    preserveLegacyTaskId: options.preserveLegacyTaskId === true,
    taskId: options.taskId,
  } as SubmissionOptions);

  return normalizeTaskRecord({
    version: TASK_STORE_VERSION,
    taskId,
    projectPath: metadata.projectPath,
    status: 'submitting',
    createdAt: now,
    updatedAt: now,
    request: normalizeTaskRequest(specRecord.request) ?? cloneValue(specRecord.request ?? null),
    polling:
      projectFormalPlanPolling(metadata) ??
      normalizeTaskPolling(specRecord.polling),
    response: null,
    error: null,
    metadata: {
      ...metadata,
      taskId,
      taskExecutionPlan: isPlainObject(metadata.taskExecutionPlan)
        ? projectTaskExecutionPlanSummary(metadata.taskExecutionPlan)
        : null,
    },
    progress: null,
    execution: {
      trace: [],
    },
  });
};

const updateTaskRecord = (taskRecord: unknown, patch: unknown = {}) => {
  const base = normalizeTaskRecord(taskRecord);
  if (!base) return null;
  const patchRecord = isPlainObject<TaskRecordInput>(patch) ? patch : ({} as TaskRecordInput);
  return normalizeTaskRecord({
    ...base,
    ...patchRecord,
    metadata: {
      ...base.metadata,
      ...normalizeTaskMetadata(patchRecord.metadata),
      taskId: base.taskId,
    },
    execution: {
      trace: buildExecutionTrace(base, patchRecord, base.taskId),
    },
    updatedAt: Date.now(),
  }, base.taskId);
};

const toPublicTaskSummary = (item: unknown) => {
  if (!isPlainObject(item)) return null;
  return { ...item };
};

const toPublicTaskRecord = (record: unknown) => {
  if (!isPlainObject(record)) return null;
  return cloneValue(record);
};

export {
  normalizeTaskRecord,
  normalizeFormalTaskStatus,
  normalizeExecutionEntry,
  assignTaskIdForSubmission,
  createTaskRecordFromFormalSpec,
  updateTaskRecord,
  toPublicTaskSummary,
  toPublicTaskRecord,
};
