import { getCurrentProjectPath, ipcInvoke } from './backendCore';
import type { CacheStatistics } from './types';
import type { StorageClearNodeOutputParams, StorageClearNodeOutputResult, StorageRemoveOutputItemParams, StorageRemoveOutputItemResult, StorageGetCacheStatisticsResult } from '@iart/contracts/editor-storage-contract';

// G 组：节点输出
// ────────────────────────────────────────────

export const clearNodeOutput = async (
  nodeId: string,
): Promise<{ success: boolean; cleared: boolean }> => {
  const projectPath = await getCurrentProjectPath();
  if (!projectPath || !nodeId) {
    return { success: false, cleared: false };
  }
  try {
    const params: StorageClearNodeOutputParams = { projectPath, nodeId };
    const result = await ipcInvoke<StorageClearNodeOutputResult>("storage:clear-node-output", params);
    return {
      success: true,
      cleared: Boolean((result !== null && result !== undefined ? result.cleared : undefined)),
    };
  } catch (error) {
    console.warn("[clearNodeOutput] 清除节点输出失败:", error);
    return { success: false, cleared: false };
  }
};

export const removeNodeOutputItem = async (params: {
  targetKey: string;
  baseTargetKey: string | undefined;
  mediaType: string;
  assetId: string | undefined;
  textValue: string | undefined;
  taskId: string | undefined;
  outputIndex: number | undefined;
}): Promise<{
  success: boolean;
  removed: boolean;
  tombstoned: boolean;
  tombstonedNodeIds: string[] | undefined;
}> => {
  const projectPath = await getCurrentProjectPath();
  const taskId = typeof params.taskId === "string" ? params.taskId.trim() : "";
  const assetId = typeof params.assetId === "string" ? params.assetId.trim() : "";
  const textValue =
    typeof params.textValue === "string" ? params.textValue.trim() : "";
  const hasOutputSlotKey =
    taskId.length > 0 &&
    Number.isFinite((params !== null && params !== undefined ? params.outputIndex : undefined)) &&
    Number(params.outputIndex) >= 0;
  const matcherValue =
    assetId ||
    textValue ||
    "";
  if (
    !projectPath ||
    !(params !== null && params !== undefined ? params.targetKey : undefined) ||
    !(params !== null && params !== undefined ? params.mediaType : undefined) ||
    (!matcherValue && !hasOutputSlotKey)
  ) {
    return { success: false, removed: false, tombstoned: false, tombstonedNodeIds: undefined };
  }
  try {
    const ipcParams: StorageRemoveOutputItemParams = {
      projectPath,
      params: {
        targetNodeId: params.targetKey,
        fallbackTargetNodeId: params.baseTargetKey,
        taskId: taskId || undefined,
        outputIndex: typeof params.outputIndex === 'number' ? params.outputIndex : undefined,
        mediaType: params.mediaType,
        assetId: assetId || undefined,
        textValue: textValue || undefined,
        url: undefined,
      },
    };
    const result = await ipcInvoke<StorageRemoveOutputItemResult>("storage:remove-output-item", ipcParams);
    if (!result) {
      return { success: false, removed: false, tombstoned: false, tombstonedNodeIds: undefined };
    }
    return {
      success: true,
      removed: Boolean(result.removed),
      tombstoned: false,
      tombstonedNodeIds: undefined,
    };
  } catch (error) {
    console.warn("[removeNodeOutputItem] 删除输出条目失败:", error);
    return { success: false, removed: false, tombstoned: false, tombstonedNodeIds: undefined };
  }
};

// ────────────────────────────────────────────
// 缓存统计
// ────────────────────────────────────────────

export const getCacheStatistics = async (): Promise<CacheStatistics> => {
  const result = await ipcInvoke<StorageGetCacheStatisticsResult>("storage:get-cache-statistics", undefined);
  const stats = (result !== null && result !== undefined ? result.statistics : undefined);
  if (!stats) {
    return {
      projectCount: 0,
      indexedDbSize: 0,
      localStorageSize: 0,
      totalSize: 0,
      projectSizes: [],
    };
  }
  return {
    projectCount: stats.totalProjects ?? 0,
    indexedDbSize: 0,
    localStorageSize: 0,
    totalSize: 0,
    projectSizes: [],
  };
};

// ────────────────────────────────────────────
// Session/Presence（已移除，保留空壳以兼容）
// ────────────────────────────────────────────

export type ProjectPresenceResult =
  | { status: "ok" }
  | { status: "error"; code: string; message: string | null | undefined };

export const openProjectSession = async (
  _projectPath: string,
): Promise<ProjectPresenceResult> => {
  // Session 机制已由 Storage Service 替代，不再需要
  return { status: "ok" };
};

export const reportProjectPresence = async (
  _projectPath: string,
  _action: "open" | "heartbeat" | "close",
): Promise<ProjectPresenceResult> => {
  // Presence 机制已由 Storage Service 替代，不再需要
  return { status: "ok" };
};
