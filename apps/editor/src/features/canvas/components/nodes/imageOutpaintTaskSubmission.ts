import type { NodeTaskInfo } from "../../types";

export const createOutpaintTaskInfo = ({
  taskIndex,
  modelId,
  now,
}: {
  taskIndex: number;
  modelId: string;
  now: number;
}): NodeTaskInfo => ({
  taskId: undefined,
  remoteRequestId: undefined,
  modelId,
  status: undefined,
  progress: null,
  taskIndex,
  createdAt: now,
  updatedAt: now,
  error: undefined,
  failure: null,
  batchId: undefined,
});

export const bindOutpaintTaskInfo = ({
  existingTaskInfo,
  modelId,
  createdAtFallback,
  patch,
  now,
}: {
  existingTaskInfo: NodeTaskInfo | undefined;
  modelId: string;
  createdAtFallback: number;
  patch: Partial<NodeTaskInfo>;
  now: number;
}): NodeTaskInfo => {
  const resolvedTaskId = patch.taskId ?? (existingTaskInfo !== null && existingTaskInfo !== undefined ? existingTaskInfo.taskId : undefined);
  const resolvedRemoteRequestId =
    patch.remoteRequestId ?? (existingTaskInfo !== null && existingTaskInfo !== undefined ? existingTaskInfo.remoteRequestId : undefined);
  const resolvedStatus = patch.status ?? (existingTaskInfo !== null && existingTaskInfo !== undefined ? existingTaskInfo.status : undefined);
  const resolvedModelId = patch.modelId ?? (existingTaskInfo !== null && existingTaskInfo !== undefined ? existingTaskInfo.modelId : undefined);
  const resolvedProgress = Object.prototype.hasOwnProperty.call(
    patch,
    "progress",
  )
    ? patch.progress
    : (existingTaskInfo !== null && existingTaskInfo !== undefined ? existingTaskInfo.progress : undefined);
  const resolvedBatchId = patch.batchId ?? (existingTaskInfo !== null && existingTaskInfo !== undefined ? existingTaskInfo.batchId : undefined);
  const resolvedFailure = Object.prototype.hasOwnProperty.call(
    patch,
    "failure",
  )
    ? patch.failure
    : (existingTaskInfo !== null && existingTaskInfo !== undefined ? existingTaskInfo.failure : undefined);
  const resolvedError = Object.prototype.hasOwnProperty.call(patch, "error")
    ? patch.error
    : (existingTaskInfo !== null && existingTaskInfo !== undefined ? existingTaskInfo.error : undefined);

  return {
    taskId:
      typeof resolvedTaskId === "string" && resolvedTaskId.trim()
        ? resolvedTaskId
        : undefined,
    remoteRequestId:
      typeof resolvedRemoteRequestId === "string" &&
      resolvedRemoteRequestId.trim()
        ? resolvedRemoteRequestId
        : undefined,
    modelId:
      resolvedModelId ??
      (existingTaskInfo !== null && existingTaskInfo !== undefined
        ? existingTaskInfo.modelId
        : undefined) ??
      modelId,
    status: resolvedStatus,
    progress: resolvedProgress,
    taskIndex: patch.taskIndex ?? (existingTaskInfo !== null && existingTaskInfo !== undefined ? existingTaskInfo.taskIndex : undefined) ?? 0,
    createdAt: (existingTaskInfo !== null && existingTaskInfo !== undefined ? existingTaskInfo.createdAt : undefined) ?? createdAtFallback,
    updatedAt: now,
    error: resolvedError,
    failure: resolvedFailure,
    batchId: resolvedBatchId,
  };
};
