/**
 * Editor Storage Contract
 *
 * Editor Storage Service 的全部 IPC 类型定义。
 * 替代 Backend 直接暴露 storage 操作，作为 Editor 与 Storage 层之间的合约边界。
 */

import * as z from 'zod';
import type {
  ProjectRecord,
  ProjectIndexItem,
  ProjectMetaIndex,
  ProjectSaveDelta,
  PendingNodeChangesSnapshot,
  MediaAsset,
  ProjectMediaAssets,
} from './project-dto';
export { EDITOR_STORAGE_IPC_CHANNELS } from './editor-storage-ipc-channels';
export type { EditorStorageIpcChannel } from './editor-storage-ipc-channels';
export type {
  StorageReadAllMediaAssetsParams,
  StorageReadAllMediaAssetsResult,
  StorageReadAllTasksParams,
  StorageReadAllTasksResult,
  StorageReadMediaAssetByIdParams,
  StorageReadMediaAssetByIdResult,
  StorageReadMediaAssetsByTaskParams,
  StorageReadMediaAssetsByTaskResult,
  StorageReadTaskByIdParams,
  StorageReadTaskByIdResult,
  StorageReadTaskOutputsParams,
  StorageReadTaskOutputsResult,
} from './editor-storage-runtime-read-contract';
export type {
  PackageAreaAddEntriesMutation,
  PackageAreaEntry,
  PackageAreaEntryInput,
  PackageAreaEntryView,
  PackageAreaMediaType,
  PackageAreaMutation,
  PackageAreaMutationRequest,
  PackageAreaMutationResult,
  PackageAreaReorderEntriesMutation,
  PackageAreaRemoveEntriesMutation,
  PackageAreaResolvedMedia,
  PackageAreaView,
  StorageReadPackageAreaByGraphIdParams,
  StorageReadPackageAreaByGraphIdResult,
} from './package-area-contract';
export type {
  StorageReadFileBytesParams,
  StorageReadFileBytesResult,
  StorageWriteTempFileParams,
  StorageWriteTempFileResult,
} from './editor-storage-bundle-file-contract';
export {
  StorageReadFileBytesParamsSchema,
  StorageReadFileBytesResultSchema,
  StorageWriteTempFileParamsSchema,
  StorageWriteTempFileResultSchema,
} from './editor-storage-bundle-file-contract';
export {
  StorageReadAllMediaAssetsParamsSchema,
  StorageReadAllMediaAssetsResultSchema,
  StorageReadAllTasksParamsSchema,
  StorageReadAllTasksResultSchema,
  StorageReadMediaAssetByIdParamsSchema,
  StorageReadMediaAssetByIdResultSchema,
  StorageReadMediaAssetsByTaskParamsSchema,
  StorageReadMediaAssetsByTaskResultSchema,
  StorageReadTaskByIdParamsSchema,
  StorageReadTaskByIdResultSchema,
  StorageReadTaskOutputsParamsSchema,
  StorageReadTaskOutputsResultSchema,
} from './editor-storage-runtime-read-contract';
export {
  PackageAreaAddEntriesMutationSchema,
  PackageAreaEntryInputSchema,
  PackageAreaEntrySchema,
  PackageAreaEntryViewSchema,
  PackageAreaMediaTypeSchema,
  PackageAreaMutationRequestSchema,
  PackageAreaMutationResultSchema,
  PackageAreaMutationSchema,
  PackageAreaReorderEntriesMutationSchema,
  PackageAreaRemoveEntriesMutationSchema,
  PackageAreaResolvedMediaSchema,
  PackageAreaViewSchema,
  StorageReadPackageAreaByGraphIdParamsSchema,
  StorageReadPackageAreaByGraphIdResultSchema,
} from './package-area-contract';
export type {
  StorageAppendAgentMessageParams,
  StorageAppendAgentMessageResult,
  StorageAppendAgentSendRecordParams,
  StorageAppendAgentSendRecordResult,
  StorageAppendAgentToolCallParams,
  StorageAppendAgentToolCallResult,
  StorageReadAgentMessagesParams,
  StorageReadAgentMessagesResult,
  StorageReadAgentSendRecordsParams,
  StorageReadAgentSendRecordsResult,
  StorageReadAgentSessionByNodeIdParams,
  StorageReadAgentSessionByNodeIdResult,
  StorageReadAgentSessionsParams,
  StorageReadAgentSessionsResult,
  StorageReadAgentToolCallsParams,
  StorageReadAgentToolCallsResult,
  StorageUpdateAgentToolCallParams,
  StorageUpdateAgentToolCallResult,
  StorageUpsertAgentSessionParams,
  StorageUpsertAgentSessionResult,
} from './agent-session-storage-contract';
export {
  StorageAppendAgentMessageParamsSchema,
  StorageAppendAgentMessageResultSchema,
  StorageAppendAgentSendRecordParamsSchema,
  StorageAppendAgentSendRecordResultSchema,
  StorageAppendAgentToolCallParamsSchema,
  StorageAppendAgentToolCallResultSchema,
  StorageReadAgentMessagesParamsSchema,
  StorageReadAgentMessagesResultSchema,
  StorageReadAgentSendRecordsParamsSchema,
  StorageReadAgentSendRecordsResultSchema,
  StorageReadAgentSessionByNodeIdParamsSchema,
  StorageReadAgentSessionByNodeIdResultSchema,
  StorageReadAgentSessionsParamsSchema,
  StorageReadAgentSessionsResultSchema,
  StorageReadAgentToolCallsParamsSchema,
  StorageReadAgentToolCallsResultSchema,
  StorageUpdateAgentToolCallParamsSchema,
  StorageUpdateAgentToolCallResultSchema,
  StorageUpsertAgentSessionParamsSchema,
  StorageUpsertAgentSessionResultSchema,
} from './agent-session-storage-contract';
export type {
  CacheStatistics,
  CharacterPins,
  NodeTypeUsageStats,
  StorageGetCacheStatisticsParams,
  StorageGetCacheStatisticsResult,
  StorageGetCharacterPinsParams,
  StorageGetCharacterPinsResult,
  StorageGetNodeTypeUsageParams,
  StorageGetNodeTypeUsageResult,
  StorageSaveCharacterPinsParams,
  StorageSaveCharacterPinsResult,
  StorageTrackNodeTypeUsageParams,
  StorageTrackNodeTypeUsageResult,
} from './editor-storage-metadata-contract';
export {
  CacheStatisticsSchema,
  CharacterPinsSchema,
  NodeTypeUsageEntrySchema,
  NodeTypeUsageStatsSchema,
  StorageGetCacheStatisticsParamsSchema,
  StorageGetCacheStatisticsResultSchema,
  StorageGetCharacterPinsParamsSchema,
  StorageGetCharacterPinsResultSchema,
  StorageGetNodeTypeUsageParamsSchema,
  StorageGetNodeTypeUsageResultSchema,
  StorageSaveCharacterPinsParamsSchema,
  StorageSaveCharacterPinsResultSchema,
  StorageTrackNodeTypeUsageParamsSchema,
  StorageTrackNodeTypeUsageResultSchema,
} from './editor-storage-metadata-contract';

// ────────────────────────────────────────────
// 1. EditorPersistenceState（替代 EditorBackendNodeStateAuthority）
// ────────────────────────────────────────────

export interface EditorPersistenceState {
  hasPendingWrite: boolean;
  pendingChangeCount: number;
}

// ────────────────────────────────────────────
// 2. MediaAssetUpsertParams
// ────────────────────────────────────────────

export interface MediaAssetUpsertParams {
  mediaType: 'image' | 'video' | 'audio';
  url: string;
  /** 导入素材的原始文件名（含扩展名）；生成/加工产物登记与 bundle 导入不传（2026-10-07 素材检索底座）。 */
  sourceFileName: string | undefined;
  mimeType: string | undefined;
  sizeBytes: number | undefined;
  width: number | undefined;
  height: number | undefined;
  durationMs: number | undefined;
  thumbnailUrl: string | undefined;
  thumbnailStatus: 'missing' | 'generating' | 'ready' | 'failed' | 'stale' | undefined;
}

// ────────────────────────────────────────────
// 3. StorageImportFolderParams / StorageImportFolderResult
// ────────────────────────────────────────────

export interface StorageImportFolderParams {
  projectPath: string;
}

export interface StorageImportFolderResult {
  projectPath: string;
  project: ProjectRecord;
}

export const ProjectIndexItemSchema = z.object({
  nodeGraphId: z.string(),
  name: z.string(),
  savedAt: z.number(),
  createdAt: z.number(),
  path: z.string(),
  valid: z.boolean().optional(),
  mediaSize: z.number().optional(),
  mediaCount: z.number().optional(),
});

export const ProjectRecordSchema = z.object({
  name: z.string(),
  nodeGraph: z.unknown(),
  mediaAssets: z.unknown(),
  savedAt: z.number(),
  hasUnsavedChanges: z.boolean(),
  createdAt: z.number(),
  path: z.string(),
  nodeGraphId: z.string(),
});

export const StorageListProjectsResultSchema = z.object({
  projects: z.array(ProjectIndexItemSchema),
});

export const StorageCreateProjectResultSchema = z.object({
  projectPath: z.string(),
  project: ProjectRecordSchema,
});

export const StorageOpenProjectResultSchema = z.object({
  project: ProjectRecordSchema,
});

export const StorageProjectFailureCodeSchema = z.enum([
  'invalid-project-folder',
  'project-manifest-missing',
  'project-data-empty',
  'missing-node-graph',
]);

export const StorageProjectFailureStageSchema = z.enum([
  'ipc-open',
  'storage-read',
  'data-validate',
]);

export const StorageProjectFailureActionSchema = z.enum([
  'retry',
  'reselect-project',
  'diagnose',
]);

export const StorageProjectFailureSchema = z.object({
  code: StorageProjectFailureCodeSchema,
  message: z.string().min(1),
  projectPath: z.string().min(1),
  stage: StorageProjectFailureStageSchema,
  source: z.literal('storage-service'),
  action: StorageProjectFailureActionSchema,
  hint: z.string().min(1).nullable().optional(),
});

export const StorageGetProjectResultSchema = z.object({
  project: ProjectRecordSchema.nullable(),
  failure: StorageProjectFailureSchema.nullable().optional(),
});

export const StorageDeleteProjectResultSchema = z.object({}).strict();

export const StorageImportFolderResultSchema = z.object({
  projectPath: z.string(),
  project: ProjectRecordSchema,
});

export const StorageImportBundleResultSchema = z.object({
  projectPath: z.string(),
  project: ProjectRecordSchema,
});

export const StorageExportBundleResultSchema = z.object({}).strict();

// ────────────────────────────────────────────
// 5. PromptPresetItem
// ────────────────────────────────────────────

export interface PromptPresetItem {
  id: string;
  name: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

/** RemoveOutputItemParams — 节点输出移除请求参数 */
export interface RemoveOutputItemParams {
  targetNodeId: string;
  fallbackTargetNodeId: string | undefined;
  taskId: string | undefined;
  outputIndex: number | undefined;
  mediaType: string | undefined;
  assetId: string | undefined;
  textValue: string | undefined;
  url: string | undefined;
}

// ────────────────────────────────────────────
// 7. IPC Channel 参数 / 返回值类型（按组）
// ────────────────────────────────────────────

// ── A 组：项目 CRUD（7 个）──

export type StorageListProjectsParams = Record<string, never>;

export interface StorageListProjectsResult {
  projects: ProjectIndexItem[];
}

export interface StorageCreateProjectParams<T = unknown, M = ProjectMediaAssets> {
  parentDir: string;
  name: string | undefined;
  nodeGraph: T | undefined;
  mediaAssets: M | undefined;
}

export interface StorageCreateProjectResult<T = unknown, M = ProjectMediaAssets> {
  projectPath: string;
  project: ProjectRecord<T, M>;
}

export interface StorageOpenProjectParams {
  projectPath: string;
  allowEmpty: boolean | undefined;
}

export interface StorageOpenProjectResult {
  project: ProjectRecord;
}

export interface StorageGetProjectParams {
  projectPath: string;
  allowEmpty: boolean | undefined;
}

export interface StorageGetProjectResult {
  project: ProjectRecord | null;
  failure: StorageProjectFailure | null | undefined;
}

export type StorageProjectFailureCode = z.infer<
  typeof StorageProjectFailureCodeSchema
>;
export type StorageProjectFailureStage = z.infer<
  typeof StorageProjectFailureStageSchema
>;
export type StorageProjectFailureAction = z.infer<
  typeof StorageProjectFailureActionSchema
>;
export type StorageProjectFailure = z.infer<
  typeof StorageProjectFailureSchema
>;

export interface StorageDeleteProjectParams {
  projectPath: string;
}

export type StorageDeleteProjectResult = Record<string, never>;

export type StorageGetMetaIndexParams = Record<string, never>;

export interface StorageGetMetaIndexResult {
  metaIndex: ProjectMetaIndex | null;
}

// StorageImportFolderParams / StorageImportFolderResult 已在第 3 节定义

// ── B 组：Delta/Save（4 个）──

export interface StorageSaveDeltaParams {
  projectPath: string;
  delta: ProjectSaveDelta;
}

export interface StorageSaveDeltaResult {
  persistenceState: EditorPersistenceState;
}

export interface StorageFlushParams {
  projectPath: string;
}

export interface StorageFlushResult {
  persistenceState: EditorPersistenceState;
}

export interface StorageDiscardPendingParams {
  projectPath: string;
}

export interface StorageDiscardPendingResult {
  project: ProjectRecord | null;
}

export interface StorageGetPendingSnapshotParams {
  projectPath: string;
}

export interface StorageGetPendingSnapshotResult {
  snapshot: PendingNodeChangesSnapshot | null;
}

export interface StoragePersistDeltaParams {
  projectPath: string;
  delta: ProjectSaveDelta;
}

export interface StoragePersistDeltaResult {
  persistenceState: EditorPersistenceState;
}

// ── C 组：媒体资产（2 个）──

export interface StorageUpsertMediaAssetParams {
  projectPath: string;
  params: MediaAssetUpsertParams;
}

export interface StorageUpsertMediaAssetResult {
  assetId: string;
  asset: MediaAsset;
}

export interface StorageImportBundleAssetsParams {
  projectPath: string;
  mediaAssets: ProjectMediaAssets;
}

export interface StorageImportBundleAssetsResult {
  assetIdMap: Record<string, string>;
  mediaAssetsPatch: ProjectMediaAssets;
}

// ── D 组：使用统计（5 个）──

// 可执行 schema 与共享 DTO 由 editor-storage-metadata-contract 承载，本入口只保持统一 re-export。

// ── E 组：偏好/Pins（4 个）──

// 可执行 schema 与共享 DTO 由 editor-storage-metadata-contract 承载，本入口只保持统一 re-export。

// ── F 组：Bundle 导入导出（2 个）──

export interface StorageExportBundleParams {
  projectPath: string;
  destPath: string;
}

export type StorageExportBundleResult = Record<string, never>;

export interface StorageImportBundleParams {
  bundlePath: string;
  destDir: string;
  name: string | undefined;
}

export interface StorageImportBundleResult {
  projectPath: string;
  project: ProjectRecord;
}

// ── G 组：节点输出（2 个）──

export interface StorageClearNodeOutputParams {
  projectPath: string;
  nodeId: string;
}

export interface StorageClearNodeOutputResult {
  cleared: boolean;
}

export interface StorageRemoveOutputItemParams {
  projectPath: string;
  params: RemoveOutputItemParams;
}

export interface StorageRemoveOutputItemResult {
  removed: boolean;
}

// ── H 组：运行域读取（6 个）──
// 可执行 schema 由 editor-storage-runtime-read-contract 承载，本入口只保持统一 re-export。

// ── I 组：缓存统计（1 个）──

// 可执行 schema 与共享 DTO 由 editor-storage-metadata-contract 承载，本入口只保持统一 re-export。

// ── J 组：提示词预设（5 个）──

export type StorageListPromptPresetsParams = Record<string, never>;

export interface StorageListPromptPresetsResult {
  presets: PromptPresetItem[];
}

export interface StorageGetPromptPresetParams {
  id: string;
}

export interface StorageGetPromptPresetResult {
  preset: PromptPresetItem | null;
}

export interface StorageCreatePromptPresetParams {
  name: string;
  content: string;
}

export interface StorageCreatePromptPresetResult {
  preset: PromptPresetItem | null;
}

export interface StorageUpdatePromptPresetParams {
  id: string;
  name: string | undefined;
  content: string | undefined;
}

export interface StorageUpdatePromptPresetResult {
  preset: PromptPresetItem | null;
}

export interface StorageDeletePromptPresetParams {
  id: string;
}

export interface StorageDeletePromptPresetResult {
  success: boolean;
}

// ── K 组：本地媒体导入（1 个）──

export interface StorageImportLocalMediaParams {
  projectPath: string;
  fileDataBase64: string;
  mimeType: string;
  originalFileName: string;
}

export interface StorageImportLocalMediaResult {
  url: string;
  fileName: string;
  isNew: boolean;
  sizeBytes: number;
}

// ── P 组：agent 会话（7 个）──
// 可执行 schema 由 agent-session-storage-contract 承载，本入口只保持统一 re-export。
// 共享 DTO（AgentSessionRecord / AgentMessageRecord / AgentSendRecord）由 agent-contract 承载。
