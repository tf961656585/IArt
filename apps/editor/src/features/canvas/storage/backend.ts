/**
 * Editor Storage — IPC 存储层
 */

import { cast } from '@/lib/utils';
import type { NodeGraph } from "../types";
import { normalizeProjectMediaAssets } from "../services/projectMediaAssets";
import type { CreateProjectResponse, OpenProjectResponse, ProjectIndexItem, ProjectMetaIndex, PendingNodeChangesSnapshot, ProjectRecord, ProjectSaveDelta, ProjectNodeStateSyncResult } from "./types";
import type { EditorPersistenceState, StorageListProjectsResult, StorageCreateProjectParams, StorageCreateProjectResult, StorageOpenProjectParams, StorageOpenProjectResult, StorageGetProjectParams, StorageGetProjectResult, StorageDeleteProjectParams, StorageGetMetaIndexResult, StorageSaveDeltaParams, StorageSaveDeltaResult, StorageFlushParams, StorageFlushResult, StorageDiscardPendingParams, StorageDiscardPendingResult, StorageGetPendingSnapshotParams, StorageGetPendingSnapshotResult, StorageImportBundleAssetsParams, StorageImportBundleAssetsResult, StoragePersistDeltaParams, StoragePersistDeltaResult, StorageReadAllTasksParams, StorageReadTaskOutputsParams, StorageReadMediaAssetsByTaskParams } from "@iart/contracts";
import {
  StorageReadAllTasksResultSchema,
  StorageReadMediaAssetsByTaskResultSchema,
  StorageReadTaskOutputsResultSchema,
} from "@iart/contracts";
import type { RuntimeMediaAssetView, RuntimeTaskOutputRow, RuntimeTaskView } from "@iart/contracts";
import { getCurrentProjectPath, ipcInvoke, normalizeProjectRecord, setCurrentProjectPath } from './backendCore';

export { getCurrentProjectPath, setCurrentProjectPath } from './backendCore';
export {
  getNodeTypeUsageStats,
  getCurrentProjectNodeTypeUsageStats, trackNodeTypeUsage, trackCurrentProjectNodeTypeUsage,
} from './backendUsage';
export {
  getProjectCharacterPins,
  getCurrentProjectCharacterPins, setProjectCharacterPinnedIds, setCurrentProjectCharacterPinnedIds,
} from './backendPins';
export { exportProjectBundle, getExportFilenameFromResponse, importProjectBundle } from './backendBundles';
export { clearNodeOutput, removeNodeOutputItem, getCacheStatistics, openProjectSession, reportProjectPresence } from './backendOutputs';
export type { ProjectPresenceResult } from './backendOutputs';

export const isLocalBackendPreferred = (): boolean => {
  if (typeof window === "undefined") return false;
  return true;
};

// A 组：项目 CRUD
// ────────────────────────────────────────────

export const listProjects = async (): Promise<ProjectIndexItem[]> => {
  const result = await ipcInvoke<StorageListProjectsResult>("storage:list-projects", undefined);
  return (result !== null && result !== undefined ? result.projects : undefined) ?? [];
};

export const createProject = async (
  parentDir: string,
  name: string | undefined,
  nodeGraph: NodeGraph | undefined,
  mediaAssets: ProjectRecord["mediaAssets"],
): Promise<CreateProjectResponse> => {
  if (!parentDir) {
    throw new Error("请指定项目保存位置");
  }
  const params: StorageCreateProjectParams = {
    parentDir,
    mediaAssets,
    name: name !== undefined && name.trim() ? name : undefined,
    nodeGraph,
  };
  const result = await ipcInvoke<StorageCreateProjectResult>("storage:create-project", params);
  await setCurrentProjectPath(result.projectPath);
  (result as { project: unknown }).project = normalizeProjectRecord(result.project);
  return cast<CreateProjectResponse>(result);
};

export const openProject = async (
  projectPath: string,
  options: { allowEmpty: boolean | undefined } | undefined,
): Promise<OpenProjectResponse> => {
  if (!projectPath) {
    throw new Error("项目路径不能为空");
  }
  const params: StorageOpenProjectParams = {
    projectPath,
    allowEmpty: Boolean((options !== null && options !== undefined ? options.allowEmpty : undefined)),
  };
  const result = await ipcInvoke<StorageOpenProjectResult>("storage:open-project", params);
  await setCurrentProjectPath(projectPath);
  const normalizedProject = normalizeProjectRecord(result.project);
  return {
    projectPath,
    project: normalizedProject,
  } as OpenProjectResponse;
};

export const getProject = async (
  projectPath: string,
  options: { allowEmpty: boolean | undefined } | undefined,
): Promise<ProjectRecord | null> => {
  if (!projectPath) return null;
  const params: StorageGetProjectParams = {
    projectPath,
    allowEmpty: Boolean((options !== null && options !== undefined ? options.allowEmpty : undefined)),
  };
  const result = await ipcInvoke<StorageGetProjectResult>("storage:get-project", params);
  const failure = result.failure;
  if (failure !== null && failure !== undefined) {
    throw Object.assign(new Error(failure.message), {
      code: failure.code,
      body: {
        code: failure.code,
        message: failure.message,
      },
      diagnostics: {
        projectOpenStage: failure.stage,
        projectOpenSource: failure.source,
        projectOpenAction: failure.action,
        hint: failure.hint ?? null,
        failure: {
          code: failure.code,
          message: failure.message,
        },
      },
    });
  }
  return normalizeProjectRecord((result !== null && result !== undefined ? result.project : undefined));
};

export const getProjectMetaIndex =
  async (): Promise<ProjectMetaIndex | null> => {
    const result = await ipcInvoke<StorageGetMetaIndexResult>("storage:get-meta-index", undefined);
    return (result !== null && result !== undefined ? result.metaIndex : undefined) ?? null;
  };

export const deleteProject = async (projectPath: string): Promise<void> => {
  if (!projectPath) return;
  const params: StorageDeleteProjectParams = { projectPath };
  await ipcInvoke("storage:delete-project", params);
};

// ────────────────────────────────────────────
// B 组：Delta/Save
// ────────────────────────────────────────────

const mapPersistenceState = (
  ps: EditorPersistenceState | null | undefined,
): ProjectNodeStateSyncResult => {
  if (!ps) return { ok: true, persistenceState: undefined };
  return {
    ok: true,
    persistenceState: ps,
  };
};

export const saveProjectDelta = async (
  projectPath: string,
  delta: ProjectSaveDelta,
): Promise<ProjectNodeStateSyncResult> => {
  if (!projectPath || !delta) {
    return { ok: false, persistenceState: undefined };
  }
  const params: StorageSaveDeltaParams = { projectPath, delta };
  const result = await ipcInvoke<StorageSaveDeltaResult>("storage:save-delta", params);
  return mapPersistenceState((result !== null && result !== undefined ? result.persistenceState : undefined));
};

export const flushProject = async (
  projectPath: string,
): Promise<ProjectNodeStateSyncResult> => {
  if (!projectPath) {
    return { ok: false, persistenceState: undefined };
  }
  const params: StorageFlushParams = { projectPath };
  const result = await ipcInvoke<StorageFlushResult>("storage:flush", params);
  return mapPersistenceState((result !== null && result !== undefined ? result.persistenceState : undefined));
};

export const discardPendingNodeChanges =
  async (): Promise<ProjectRecord | null> => {
    const projectPath = await getCurrentProjectPath();
    if (!projectPath) return null;
    const params: StorageDiscardPendingParams = { projectPath };
    const result = await ipcInvoke<StorageDiscardPendingResult>("storage:discard-pending", params);
    return normalizeProjectRecord((result !== null && result !== undefined ? result.project : undefined));
  };

export const getPendingNodeChangesSnapshot =
  async (): Promise<PendingNodeChangesSnapshot | null> => {
    const projectPath = await getCurrentProjectPath();
    if (!projectPath) return null;
    const params: StorageGetPendingSnapshotParams = { projectPath };
    const result = await ipcInvoke<StorageGetPendingSnapshotResult>("storage:get-pending-snapshot", params);
    return ((result !== null && result !== undefined ? result.snapshot : undefined) ?? null) as PendingNodeChangesSnapshot | null;
  };

export const enqueuePendingNodeChanges = async (
  delta: ProjectSaveDelta,
): Promise<ProjectNodeStateSyncResult> => {
  const projectPath = await getCurrentProjectPath();
  if (!projectPath) {
    throw new Error("未选择项目，无法上报节点改动");
  }
  return saveProjectDelta(projectPath, delta);
};

export const flushPendingNodeChanges =
  async (): Promise<ProjectNodeStateSyncResult | void> => {
    const projectPath = await getCurrentProjectPath();
    if (!projectPath) return;
    return flushProject(projectPath);
  };

export const persistProjectDelta = async (
  projectPath: string,
  delta: ProjectSaveDelta,
): Promise<ProjectNodeStateSyncResult> => {
  if (!projectPath || !delta) {
    return { ok: false, persistenceState: undefined };
  }
  const params: StoragePersistDeltaParams = { projectPath, delta };
  const result = await ipcInvoke<StoragePersistDeltaResult>("storage:persist-delta", params);
  return mapPersistenceState((result !== null && result !== undefined ? result.persistenceState : undefined));
};

export const persistNodeChanges = async (
  delta: ProjectSaveDelta,
): Promise<ProjectNodeStateSyncResult> => {
  const projectPath = await getCurrentProjectPath();
  if (!projectPath) {
    throw new Error("未选择项目，无法持久化节点改动");
  }
  return persistProjectDelta(projectPath, delta);
};

// ────────────────────────────────────────────
// C 组：媒体资产
// ────────────────────────────────────────────

export const importBundleRuntimeAssets = async (
  projectPath: string,
  mediaAssets: ProjectRecord["mediaAssets"],
): Promise<StorageImportBundleAssetsResult> => {
  const normalizedMediaAssets = normalizeProjectMediaAssets(mediaAssets);
  if (!projectPath) {
    return { assetIdMap: {}, mediaAssetsPatch: {} };
  }
  const params: StorageImportBundleAssetsParams = {
    projectPath,
    mediaAssets: normalizedMediaAssets,
  };
  const result = await ipcInvoke<StorageImportBundleAssetsResult>("storage:import-bundle-assets", params);
  return {
    assetIdMap: (result !== null && result !== undefined ? result.assetIdMap : undefined) ?? {},
    mediaAssetsPatch: (result !== null && result !== undefined ? result.mediaAssetsPatch : undefined) ?? {},
  };
};

// ────────────────────────────────────────────
// H 组：运行域只读投影
// ────────────────────────────────────────────

export const readAllRuntimeTasks = async (
  projectPath: string,
): Promise<RuntimeTaskView[]> => {
  if (!projectPath) return [];
  const params: StorageReadAllTasksParams = { projectPath };
  const result = StorageReadAllTasksResultSchema.parse(
    await ipcInvoke<unknown>("storage:read-all-tasks", params),
  );
  return result.tasks;
};

export const readRuntimeTaskOutputs = async (
  projectPath: string,
  taskId: string,
): Promise<RuntimeTaskOutputRow[]> => {
  if (!projectPath || !taskId) return [];
  const params: StorageReadTaskOutputsParams = { projectPath, taskId };
  const result = StorageReadTaskOutputsResultSchema.parse(
    await ipcInvoke<unknown>("storage:read-task-outputs", params),
  );
  return result.outputs;
};

export const readRuntimeMediaAssetsByTask = async (
  projectPath: string,
  taskId: string,
): Promise<RuntimeMediaAssetView[]> => {
  if (!projectPath || !taskId) return [];
  const params: StorageReadMediaAssetsByTaskParams = { projectPath, taskId };
  const result = StorageReadMediaAssetsByTaskResultSchema.parse(
    await ipcInvoke<unknown>("storage:read-media-assets-by-task", params),
  );
  return result.mediaAssets;
};

// ────────────────────────────────────────────
