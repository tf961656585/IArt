import { buildRuntimeTaskRow, buildRuntimeTaskView } from './task-payload-builder.cts';
import { normalizeFormalTaskStatus } from './task-store.cts';
import { resolveProjectPathFromMetadata } from './task-engine-archive.cts';
import * as backendIpcSenderModule from './backend-ipc-sender.cts';
import * as loggingModule from './logging.cts';
import { isRecord, toRecord } from './task-engine-shared.cts';
import { settleTaskTerminal } from './task-terminal-waiter.cts';

const { sendRuntimeTransaction, sendTaskStateNotification, sendTaskEvent } = backendIpcSenderModule;
const { logDebug, logWarn } = loggingModule;

/**
 * 任务取消闭环（spec task-state-machine cancel / runtime spec「固定任务数」）。
 *
 * - 取消是命令，不是状态；持久化取消记录成功后才可返回 accepted。
 * - 取消记录落在 task record metadata 内（backend 本地强类型），结算为独立 `cancelled` 终态。
 * - 结算后晚到成功/媒体/输出/成功通知一律丢弃（取消屏障）。
 * - 恢复路径遇未结算取消记录先结算 cancelled，不再标记 failed、不重提。
 */

export type TaskCancelRecord = {
  taskId: string;
  /** 命令被接受并持久化取消记录的时间（UTC ISO 8601） */
  acceptedAt: string;
  /** 取消结算完成时间；null = 未结算（恢复时需先结算 cancelled） */
  settledAt: string | null;
};

const CANCEL_RECORD_METADATA_KEY = 'taskCancelRecord';

// 已结算 cancelled 的任务屏障：此集合中任务的任何晚到状态推进/输出/通知一律丢弃。
const CANCELLED_BARRIER_TASK_IDS = new Set<string>();

const buildCancelRecord = (taskId: string, nowIso: string): TaskCancelRecord => ({
  taskId,
  acceptedAt: nowIso,
  settledAt: null,
});

type CancelRecordCandidateFields = 'taskId' | 'acceptedAt' | 'settledAt';

const isCancelRecordCandidate = (value: unknown): value is Record<CancelRecordCandidateFields, unknown> => {
  if (!isRecord(value)) return false;
  const candidate = value as { taskId?: unknown; acceptedAt?: unknown; settledAt?: unknown };
  return (
    (candidate.taskId === undefined || typeof candidate.taskId === 'string') &&
    (candidate.acceptedAt === undefined || typeof candidate.acceptedAt === 'string') &&
    (candidate.settledAt === undefined || candidate.settledAt === null || typeof candidate.settledAt === 'string')
  );
};

const readCancelRecord = (metadata: unknown): TaskCancelRecord | null => {
  const record = toRecord(metadata);
  const candidateRaw = isRecord(record) ? (record as { taskCancelRecord?: unknown }).taskCancelRecord : undefined;
  if (!isCancelRecordCandidate(candidateRaw)) return null;
  const candidate = candidateRaw as { taskId?: unknown; acceptedAt?: unknown; settledAt?: unknown };
  const taskId = typeof candidate.taskId === 'string' ? candidate.taskId : '';
  const acceptedAt = typeof candidate.acceptedAt === 'string' ? candidate.acceptedAt : '';
  const settledAt = typeof candidate.settledAt === 'string' ? candidate.settledAt : null;
  if (!taskId || !acceptedAt) return null;
  return { taskId, acceptedAt, settledAt };
};

const isUnsettledCancelRecord = (metadata: unknown): boolean => {
  const record = readCancelRecord(metadata);
  return record !== null && record.settledAt == null;
};

const registerCancelledBarrier = (taskId: string): void => {
  CANCELLED_BARRIER_TASK_IDS.add(taskId);
};

const unregisterCancelledBarrier = (taskId: string): void => {
  CANCELLED_BARRIER_TASK_IDS.delete(taskId);
};

const hasCancelledBarrier = (taskId: unknown): boolean => {
  return typeof taskId === 'string' && CANCELLED_BARRIER_TASK_IDS.has(taskId);
};

const clearCancelledBarrierForTest = (): void => {
  CANCELLED_BARRIER_TASK_IDS.clear();
};

type CancelPersistSource = {
  taskId: string;
  projectPath: string;
  status: unknown;
  metadata: unknown;
  request: unknown;
  createdAt: unknown;
  updatedAt: unknown;
};

type TaskMetadataMap = Record<string, unknown>;

const buildEffectiveMetadata = (metadata: unknown, cancelRecord: TaskCancelRecord): TaskMetadataMap => {
  const base: TaskMetadataMap = isRecord(metadata) ? { ...metadata } : {};
  return { ...base, [CANCEL_RECORD_METADATA_KEY]: cancelRecord };
};

/**
 * 持久化取消记录（不改变 status）—— canceled 命令 accepted 前必须完成的正式写入。
 */
const persistCancelRecord = async (source: CancelPersistSource): Promise<boolean> => {
  const nowIso = new Date().toISOString();
  const cancelRecord = buildCancelRecord(source.taskId, nowIso);
  const record = {
    taskId: source.taskId,
    id: source.taskId,
    projectPath: source.projectPath,
    status: source.status,
    metadata: buildEffectiveMetadata(source.metadata, cancelRecord),
    request: source.request,
    createdAt: source.createdAt,
    updatedAt: Date.now(),
  };
  try {
    const row = buildRuntimeTaskRow(record, {
      fallbackStatus: undefined,
      statusNormalizer: normalizeFormalTaskStatus,
      projectPathResolver: () => source.projectPath,
    });
    const result = await sendRuntimeTransaction({ projectPath: source.projectPath, tasks: [row] });
    if (!result || result.success !== true) {
      logWarn('[task-cancel] persist cancel record failed', {
        taskId: source.taskId,
        error: result?.error ?? 'runtime transaction failed',
      });
      return false;
    }
    return true;
  } catch (error) {
    logWarn('[task-cancel] persist cancel record threw', {
      taskId: source.taskId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
};

/**
 * 结算为独立 `cancelled` 终态（同一正式写入边界持久化 cancelled 状态与取消结算记录）。
 *
 * 成功后发送 task:state-changed 通知与 task.cancelled 事件（不写任务输出或 MediaAsset）。
 */
const settleCancelledTask = async (params: {
  taskId: string;
  projectPath: string;
  metadata: unknown;
  request: unknown;
  createdAt: unknown;
  updatedAt: unknown;
  cancelRecord: TaskCancelRecord;
}): Promise<boolean> => {
  const { taskId, projectPath, metadata, request, createdAt, cancelRecord } = params;
  registerCancelledBarrier(taskId);
  const settledRecord: TaskCancelRecord = {
    ...cancelRecord,
    settledAt: new Date().toISOString(),
  };
  const record = {
    taskId,
    id: taskId,
    projectPath,
    status: 'cancelled',
    finishedAt: Date.now(),
    progress: { phase: null },
    metadata: buildEffectiveMetadata(metadata, settledRecord),
    request,
    createdAt,
    updatedAt: Date.now(),
  };
  try {
    const row = buildRuntimeTaskRow(record, {
      fallbackStatus: undefined,
      statusNormalizer: normalizeFormalTaskStatus,
      projectPathResolver: () => projectPath,
    });
    const result = await sendRuntimeTransaction({ projectPath, tasks: [row] });
    if (!result || result.success !== true) {
      logWarn('[task-cancel] settle cancelled failed', {
        taskId,
        error: result?.error ?? 'runtime transaction failed',
      });
      return false;
    }
  } catch (error) {
    logWarn('[task-cancel] settle cancelled threw', {
      taskId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }

  try {
    const view = buildRuntimeTaskView(record, {
      fallbackStatus: undefined,
      statusNormalizer: normalizeFormalTaskStatus,
      projectPathResolver: () => projectPath,
    });
    sendTaskStateNotification({
      type: 'task:state-changed',
      projectPath,
      task: view,
      outputs: [],
      mediaAssets: [],
    });
  } catch (error) {
    logWarn('[task-cancel] cancelled state notification failed', {
      taskId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  void sendTaskEvent({
    projectPath,
    event: {
      taskId,
      eventType: 'task.cancelled',
      payload: { status: 'cancelled' },
      createdAt: Date.now(),
    },
  }).catch((error: unknown) => {
    logWarn('[task-cancel] cancelled event write failed', {
      taskId,
      error: String(error),
    });
  });
  // agent 工具调用的阻塞等待结算（spec 04）：取消是等待方的合法终态之一。
  settleTaskTerminal(taskId, { status: 'cancelled', mediaAssets: [], errorMessage: null });
  return true;
};

/**
 * 晚到写入屏障判定（AGENTS.md 条件跳过留痕）：结算 cancelled 后任何非 cancelled 的
 * 状态推进/输出/通知写入一律丢弃并留 debug 日志。
 */
const shouldDropLateWrite = (taskId: unknown): boolean => {
  if (!hasCancelledBarrier(taskId)) return false;
  const resolvedTaskId = typeof taskId === 'string' ? taskId : String(taskId);
  logDebug('[task-cancel] drop late write after cancelled settlement', { taskId: resolvedTaskId });
  return true;
};

export {
  CANCEL_RECORD_METADATA_KEY,
  buildCancelRecord,
  readCancelRecord,
  isUnsettledCancelRecord,
  registerCancelledBarrier,
  unregisterCancelledBarrier,
  hasCancelledBarrier,
  clearCancelledBarrierForTest,
  persistCancelRecord,
  settleCancelledTask,
  shouldDropLateWrite,
  buildEffectiveMetadata,
  resolveProjectPathFromMetadata,
  type CancelPersistSource,
};
