export const TASK_WS_PROTOCOL_VERSION = 4 as const;

export type TaskWsStatus =
  | 'submitting'
  | 'generating'
  | 'polling'
  | 'downloading'
  | 'succeeded'
  | 'failed';

export interface TaskSnapshotTaskEntry {
  taskId: string;
  status: TaskWsStatus;
}

export interface TaskChangedNotification {
  type: 'task_changed';
  protocolVersion: typeof TASK_WS_PROTOCOL_VERSION;
  taskId: string;
  status: TaskWsStatus;
  sourceNodeId: string | null | undefined;
  targetNodeId: string | null | undefined;
  progressPercent: number | null | undefined;
  progressMessage: string | null | undefined;
  progressPhase: string | null | undefined;
  errorMessage: string | null | undefined;
  errorCode: string | null | undefined;
  remoteRequestId: string | null | undefined;
  updatedAt: number | null | undefined;
  createdAt: number | null | undefined;
  emittedAt: number;
}

export interface TaskSnapshotNotification {
  type: 'task_snapshot';
  protocolVersion: typeof TASK_WS_PROTOCOL_VERSION;
  tasks: ReadonlyArray<TaskSnapshotTaskEntry>;
  emittedAt: number;
}

export type TaskWsMessage = TaskChangedNotification | TaskSnapshotNotification;

export type TaskDelta = TaskChangedNotification;
export type CanvasTaskDelta = TaskChangedNotification;
export type TaskSnapshot = TaskSnapshotNotification;
export type TaskEntry = TaskSnapshotTaskEntry;

export function isTaskSnapshot(msg: TaskWsMessage): msg is TaskSnapshotNotification {
  return msg.type === 'task_snapshot';
}

export function isTaskDelta(msg: TaskWsMessage): msg is TaskChangedNotification {
  return msg.type === 'task_changed';
}

export const TASK_WS_PATH = '/ws/tasks';
export const TASK_WS_LEGACY_PATH = '/ws/canvas-tasks';
