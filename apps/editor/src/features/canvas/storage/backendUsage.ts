import { getCurrentProjectPath, ipcInvoke, normalizeStringKeys } from './backendCore';
import type { NodeTypeUsageStats } from './types';
import type { StorageGetNodeTypeUsageParams, StorageGetNodeTypeUsageResult, StorageTrackNodeTypeUsageParams, StorageTrackNodeTypeUsageResult } from '@iart/contracts/editor-storage-contract';

// D 组：使用统计
// ────────────────────────────────────────────

const normalizeNodeKeys = normalizeStringKeys;

export const getNodeTypeUsageStats = async (
  projectPath: string,
): Promise<NodeTypeUsageStats | null> => {
  if (!projectPath) return null;
  try {
    const params: StorageGetNodeTypeUsageParams = { projectPath };
    const result = await ipcInvoke<StorageGetNodeTypeUsageResult>("storage:get-node-type-usage", params);
    return (result !== null && result !== undefined ? result.stats : undefined) ?? null;
  } catch {
    return null;
  }
};

export const getCurrentProjectNodeTypeUsageStats =
  async (): Promise<NodeTypeUsageStats | null> => {
    const projectPath = await getCurrentProjectPath();
    if (!projectPath) return null;
    return getNodeTypeUsageStats(projectPath);
  };

export const trackNodeTypeUsage = async (
  projectPath: string,
  nodeKeys: unknown,
): Promise<NodeTypeUsageStats | null> => {
  if (!projectPath) return null;
  const normalized = normalizeNodeKeys(nodeKeys);
  try {
    const params: StorageTrackNodeTypeUsageParams = { projectPath, nodeKeys: normalized };
    const result = await ipcInvoke<StorageTrackNodeTypeUsageResult>("storage:track-node-type-usage", params);
    return (result !== null && result !== undefined ? result.stats : undefined) ?? null;
  } catch {
    return null;
  }
};

export const trackCurrentProjectNodeTypeUsage = async (
  nodeKeys: unknown,
): Promise<void> => {
  const projectPath = await getCurrentProjectPath();
  if (!projectPath) return;
  await trackNodeTypeUsage(projectPath, nodeKeys);
};

// ────────────────────────────────────────────
