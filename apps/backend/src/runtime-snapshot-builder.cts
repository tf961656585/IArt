import type {
  RuntimeMediaAssetView,
  RuntimeTaskOutputRow,
  RuntimeTaskView,
  TaskStateSnapshot,
} from '@iart/contracts';

export const buildTaskStateSnapshotPayload = (params: {
  projectPath: string;
  tasks: RuntimeTaskView[];
  taskOutputsByTaskId: Record<string, RuntimeTaskOutputRow[]>;
  mediaAssetsByTaskId: Record<string, RuntimeMediaAssetView[]>;
  normalizeTaskStatus: (status: unknown) => string;
  isTaskFinalStatus: (status: string) => boolean;
}): TaskStateSnapshot | null => {
  const projectPath = typeof params.projectPath === 'string' ? params.projectPath.trim() : '';
  if (!projectPath) return null;

  const tasks = params.tasks.filter((task) => {
    const status = params.normalizeTaskStatus(task.status);
    return !params.isTaskFinalStatus(status);
  });
  if (tasks.length === 0) return null;

  const taskOutputsByTaskId: Record<string, RuntimeTaskOutputRow[]> = {};
  const mediaAssetsByTaskId: Record<string, RuntimeMediaAssetView[]> = {};
  for (const task of tasks) {
    const taskId = typeof task.taskId === 'string' ? task.taskId.trim() : '';
    if (!taskId) continue;
    taskOutputsByTaskId[taskId] = params.taskOutputsByTaskId[taskId] ?? [];
    mediaAssetsByTaskId[taskId] = params.mediaAssetsByTaskId[taskId] ?? [];
  }

  return {
    type: 'task:state-snapshot',
    projectPath,
    tasks,
    taskOutputsByTaskId,
    mediaAssetsByTaskId,
  };
};
