import { readTaskArchiveEvents } from './task-archive-store.cts';

interface SnapshotShape {
  task: unknown | undefined;
}

interface SnapshotTaskShape {
  progress: unknown | undefined;
  metadata: unknown | undefined;
  status: unknown | undefined;
}

interface ReadContextParams {
  taskId: unknown | undefined;
  projectPath: unknown | undefined;
  metadata: unknown | undefined;
}

const readLatestTaskArchiveContext = ({ taskId, projectPath, metadata }: ReadContextParams) => {
  const options: { taskId: string | undefined; projectPath: string | undefined; metadata: unknown | undefined; event: unknown | undefined } = {
    taskId: undefined,
    projectPath: undefined,
    metadata: undefined,
    event: undefined,
  };
  if (typeof taskId === 'string') options.taskId = taskId;
  if (typeof projectPath === 'string' && projectPath) options.projectPath = projectPath;
  options.metadata = metadata;

  const events = readTaskArchiveEvents(options);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event) continue;

    const snapshot = event.snapshot;
    const snapshotObj = snapshot && typeof snapshot === 'object' ? snapshot as SnapshotShape : null;
    const snapshotTask = (snapshotObj !== null && snapshotObj !== undefined ? snapshotObj.task : undefined);
    if (!snapshotTask || typeof snapshotTask !== 'object') continue;

    const taskObj = snapshotTask as SnapshotTaskShape;
    const detail = event.detail && typeof event.detail === 'object' ? event.detail : null;
    if (detail || taskObj.progress || taskObj.metadata || taskObj.status) {
      return { event, snapshotTask, detail };
    }
  }
  return null;
};

export {
  readLatestTaskArchiveContext,
};
