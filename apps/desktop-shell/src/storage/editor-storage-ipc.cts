/**
 * Editor Storage Service — IPC Handler 注册
 */
import { ipcMain } from 'electron';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  EDITOR_STORAGE_IPC_CHANNELS,
  StorageReadFileBytesParamsSchema,
  StorageReadFileBytesResultSchema,
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
  StorageWriteTempFileParamsSchema,
  StorageWriteTempFileResultSchema,
} from '@iart/contracts';
import type {
  StorageClearNodeOutputParams,
  StorageCreateProjectParams,
  StorageCreatePromptPresetParams,
  StorageDeleteProjectParams,
  StorageDeletePromptPresetParams,
  StorageDiscardPendingParams,
  StorageExportBundleParams,
  StorageFlushParams,
  StorageGetPendingSnapshotParams,
  StorageGetProjectParams,
  StorageGetPromptPresetParams,
  StorageImportBundleAssetsParams,
  StorageImportBundleParams,
  StorageImportFolderParams,
  StorageImportLocalMediaParams,
  StorageOpenProjectParams,
  StoragePersistDeltaParams,
  StorageRemoveOutputItemParams,
  StorageSaveDeltaParams,
  StorageUpdatePromptPresetParams,
  StorageUpsertMediaAssetParams,
} from '@iart/contracts';
import {
  getDb,
  getDbForExistingProject,
  createProject,
  openProject,
  getProject,
  deleteProject,
  listProjects,
  getMetaIndex,
  importFolder,
  clearNodeOutput,
  removeOutputItem,
  enqueueDelta,
  flush,
  discardPending,
  getPendingState,
  buildProjectRecord,
  addRecentProject,
  readTaskById,
  readTaskOutputs,
  readMediaAssetsByTaskId,
  readAllTasks,
  readAllMediaAssets,
  readMediaAssetById,
} from './editor-storage-service.cjs';
import { buildGetProjectIpcResult } from './editor-storage-ipc-project-get.cjs';
import { upsertMediaAsset, importBundleAssets } from './editor-storage-media.cjs';
import { exportBundle, importBundle } from './editor-storage-bundle.cjs';
import { importLocalMedia } from './editor-storage-local-media.cjs';
import { resolveStableProjectId } from './stable-project-id-resolver.cjs';
import {
  listPromptPresets,
  getPromptPreset,
  createPromptPreset,
  updatePromptPreset,
  deletePromptPreset,
} from './editor-storage-prompt-presets.cjs';
import { registerSystemPromptStorageIpcHandlers } from './editor-storage-ipc-system-prompts.cjs';
import { registerStorageMetadataIpcHandlers } from './editor-storage-ipc-metadata.cjs';
import { registerPackageAreaStorageIpcHandlers } from './editor-storage-ipc-package-area.cjs';
import { registerAgentSessionStorageIpcHandlers } from './editor-storage-ipc-agent-sessions.cjs';
import projectRefUtils = require('@iart/utils/project-ref');
const CH = EDITOR_STORAGE_IPC_CHANNELS;

type JsonObject = Record<string, unknown>;

const asJsonObject = (value: unknown): JsonObject | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;

const safeTempFileName = (value: unknown): string => {
  const normalized = typeof value === 'string' ? value.trim() : '';
  const safe = normalized.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return safe || `bundle-${Date.now()}.iarts`;
};

/**
 * 项目位于系统临时目录（os.tmpdir）时留痕告警。
 *
 * macOS 会定期清理临时目录中约 3 天未访问的文件，项目 media/ 下的媒体文件
 * （image/video/audio 一视同仁）会被 OS 静默删除，节点图片/视频 404 且不可恢复。
 * e2e harness 的 demo.iartproj 残留是已知踩坑路径（2026-09 实锤案例）。
 */
const warnIfProjectPathInOsTempDir = (projectPath: unknown, action: 'create' | 'open' | 'import'): void => {
  const normalized = typeof projectPath === 'string' ? projectPath.trim() : '';
  if (!normalized) return;
  try {
    const tempDir = os.tmpdir();
    if (!tempDir) return;
    const realTempDir = fs.realpathSync(tempDir);
    const realProjectPath = fs.realpathSync(normalized);
    const relative = path.relative(realTempDir, realProjectPath);
    const inside = relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
    if (inside) {
      console.warn(`[storage] project ${action} inside OS temp dir: files untouched for ~3 days are purged by the OS (media loss risk)`, {
        projectPath: normalized,
        tempDir: realTempDir,
      });
    }
  } catch {
    // realpath 失败（路径不存在等）不阻断主流程
  }
};

const registerStorageIpcHandlers = (): void => {
  // ── A 组：项目 CRUD（7 个）──

  ipcMain.handle(CH.LIST_PROJECTS, () => {
    return { projects: listProjects() };
  });

  ipcMain.handle(CH.CREATE_PROJECT, (_event, args: StorageCreateProjectParams) => {
    warnIfProjectPathInOsTempDir(args.parentDir, 'create');
    const nodeGraph = asJsonObject(args.nodeGraph);
    return createProject({
      parentDir: args.parentDir,
      name: args.name,
      nodeGraph: nodeGraph === null ? undefined : nodeGraph,
      mediaAssets: args.mediaAssets,
    });
  });

  ipcMain.handle(CH.OPEN_PROJECT, (_event, args: StorageOpenProjectParams) => {
    warnIfProjectPathInOsTempDir(args.projectPath, 'open');
    return openProject({ projectPath: args.projectPath, allowEmpty: args.allowEmpty });
  });

  ipcMain.handle(CH.GET_PROJECT, (_event, args: StorageGetProjectParams) => {
    return buildGetProjectIpcResult(getProject, { projectPath: args.projectPath, allowEmpty: args.allowEmpty });
  });

  ipcMain.handle(CH.DELETE_PROJECT, (_event, args: StorageDeleteProjectParams) => {
    return deleteProject(args);
  });

  ipcMain.handle(CH.GET_META_INDEX, () => {
    return getMetaIndex();
  });

  ipcMain.handle(CH.IMPORT_FOLDER, (_event, args: StorageImportFolderParams) => {
    warnIfProjectPathInOsTempDir(args.projectPath, 'import');
    return importFolder(args);
  });

  // ── B 组：Delta/Save（4 个）──

  ipcMain.handle(CH.SAVE_DELTA, (_event, args: StorageSaveDeltaParams) => {
    const { projectPath, delta } = args;
    const db = getDb(projectPath);
    enqueueDelta(db, delta);
    return getPendingState(db);
  });

  ipcMain.handle(CH.FLUSH, async (_event, args: StorageFlushParams) => {
    const { projectPath } = args;
    const db = getDb(projectPath);
    await flush(db, projectPath);
    return getPendingState(db);
  });

  ipcMain.handle(CH.DISCARD_PENDING, (_event, args: StorageDiscardPendingParams) => {
    const { projectPath } = args;
    const db = getDb(projectPath);
    discardPending(db);
    return { project: buildProjectRecord(projectPath, db) };
  });

  ipcMain.handle(CH.GET_PENDING_SNAPSHOT, (_event, args: StorageGetPendingSnapshotParams) => {
    const { projectPath } = args;
    const db = getDb(projectPath);
    const pendingState = getPendingState(db);
    if (!pendingState.hasPendingWrite) return null;

    const record = buildProjectRecord(projectPath, db);
    if (!record) return null;

    return {
      key: 'current',
      nodeGraph: record.nodeGraph,
      savedAt: record.savedAt,
      hasUnsavedChanges: record.hasUnsavedChanges,
    };
  });

  ipcMain.handle(CH.PERSIST_DELTA, async (_event, args: StoragePersistDeltaParams) => {
    const { projectPath, delta } = args;
    const db = getDb(projectPath);
    enqueueDelta(db, delta);
    await flush(db, projectPath);
    return getPendingState(db);
  });

  // ── G 组：节点输出（2 个）──

  ipcMain.handle(CH.CLEAR_NODE_OUTPUT, (_event, args: StorageClearNodeOutputParams) => {
    return clearNodeOutput(args);
  });

  ipcMain.handle(CH.REMOVE_OUTPUT_ITEM, (_event, args: StorageRemoveOutputItemParams) => {
    const { projectPath, params } = args;
    return removeOutputItem({ projectPath, item: params });
  });

  // ── C 组：媒体资产（2 个）──

  ipcMain.handle(CH.UPSERT_MEDIA_ASSET, (_event, args: StorageUpsertMediaAssetParams) => {
    const { projectPath, params } = args;
    const db = getDb(projectPath);
    return upsertMediaAsset(db, {
      mediaType: params.mediaType,
      url: params.url,
      sourceFileName: params.sourceFileName,
      mimeType: params.mimeType,
      sizeBytes: params.sizeBytes,
      width: undefined,
      height: undefined,
      durationMs: undefined,
      fps: undefined,
      thumbnailUrl: undefined,
      thumbnailStatus: undefined,
    });
  });

  ipcMain.handle(CH.IMPORT_BUNDLE_ASSETS, (_event, args: StorageImportBundleAssetsParams) => {
    const { projectPath, mediaAssets } = args;
    const db = getDb(projectPath);
    return importBundleAssets(db, mediaAssets);
  });

  // ── F 组：Bundle（2 个）──

  ipcMain.handle(CH.EXPORT_BUNDLE, async (_event, args: StorageExportBundleParams) => {
    const { projectPath, destPath } = args;
    const sqlitePath = path.join(path.resolve(projectPath), 'project.sqlite');
    if (!fs.existsSync(sqlitePath)) {
      throw new Error('PROJECT_SQLITE_NOT_FOUND');
    }
    getDb(projectPath);
    await exportBundle(projectPath, destPath);
  });

  ipcMain.handle(CH.IMPORT_BUNDLE, async (_event, args: StorageImportBundleParams) => {
    const { bundlePath, destDir, name } = args;
    const projectPath = await importBundle(bundlePath, destDir, name);
    const db = getDb(projectPath);
    const project = buildProjectRecord(projectPath, db);
    if (project) {
      addRecentProject({
        nodeGraphId: project.nodeGraphId,
        name: project.name,
        path: projectPath,
        createdAt: project.createdAt,
        savedAt: project.savedAt,
        lastOpenedAt: Date.now(),
      });
    }
    return { projectPath, project };
  });

  ipcMain.handle(CH.READ_FILE_BYTES, async (_event, args: unknown) => {
    const params = StorageReadFileBytesParamsSchema.parse(args);
    const filePath = path.resolve(params.filePath);
    const buffer = fs.readFileSync(filePath);
    return StorageReadFileBytesResultSchema.parse({
      dataBase64: buffer.toString('base64'),
      sizeBytes: buffer.byteLength,
    });
  });

  ipcMain.handle(CH.WRITE_TEMP_FILE, async (_event, args: unknown) => {
    const params = StorageWriteTempFileParamsSchema.parse(args);
    const fileName = safeTempFileName(params.fileName);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iarts-bundle-import-'));
    const filePath = path.join(tempDir, fileName);
    fs.writeFileSync(filePath, Buffer.from(params.dataBase64, 'base64'));
    return StorageWriteTempFileResultSchema.parse({ filePath });
  });

  // ── H 组：运行域读取（6 个）──

  ipcMain.handle(CH.READ_TASK_BY_ID, (_event, args: unknown) => {
    const params = StorageReadTaskByIdParamsSchema.parse(args);
    const db = getDbForExistingProject(params.projectPath);
    return StorageReadTaskByIdResultSchema.parse({
      task: db ? readTaskById(db, params.taskId) : null,
    });
  });

  ipcMain.handle(CH.READ_TASK_OUTPUTS, (_event, args: unknown) => {
    const params = StorageReadTaskOutputsParamsSchema.parse(args);
    const db = getDbForExistingProject(params.projectPath);
    return StorageReadTaskOutputsResultSchema.parse({
      outputs: db ? readTaskOutputs(db, params.taskId) : [],
    });
  });

  ipcMain.handle(
    CH.READ_MEDIA_ASSETS_BY_TASK,
    (_event, args: unknown) => {
      const params = StorageReadMediaAssetsByTaskParamsSchema.parse(args);
      const db = getDbForExistingProject(params.projectPath);
      return StorageReadMediaAssetsByTaskResultSchema.parse({
        mediaAssets: db ? readMediaAssetsByTaskId(db, params.taskId) : [],
      });
    },
  );

  ipcMain.handle(CH.READ_ALL_TASKS, (_event, args: unknown) => {
    const params = StorageReadAllTasksParamsSchema.parse(args);
    const db = getDbForExistingProject(params.projectPath);
    return StorageReadAllTasksResultSchema.parse({
      tasks: db ? readAllTasks(db, undefined) : [],
    });
  });

  ipcMain.handle(CH.READ_ALL_MEDIA_ASSETS, (_event, args: unknown) => {
    const params = StorageReadAllMediaAssetsParamsSchema.parse(args);
    const db = getDbForExistingProject(params.projectPath);
    return StorageReadAllMediaAssetsResultSchema.parse({
      mediaAssets: db ? readAllMediaAssets(db) : [],
    });
  });

  ipcMain.handle(CH.READ_MEDIA_ASSET_BY_ID, (_event, args: unknown) => {
    const params = StorageReadMediaAssetByIdParamsSchema.parse(args);
    const db = getDbForExistingProject(params.projectPath);
    return StorageReadMediaAssetByIdResultSchema.parse({
      mediaAsset: db ? readMediaAssetById(db, params.assetId) : null,
    });
  });

  // ── J 组：提示词预设（5 个）──

  ipcMain.handle(CH.LIST_PROMPT_PRESETS, () => {
    return { presets: listPromptPresets() };
  });

  ipcMain.handle(CH.GET_PROMPT_PRESET, (_event, args: StorageGetPromptPresetParams) => {
    const { id } = args;
    return { preset: getPromptPreset(id) };
  });

  ipcMain.handle(CH.CREATE_PROMPT_PRESET, (_event, args: StorageCreatePromptPresetParams) => {
    const { name, content } = args;
    const preset = createPromptPreset({ name, content });
    return { preset };
  });

  ipcMain.handle(CH.UPDATE_PROMPT_PRESET, (_event, args: StorageUpdatePromptPresetParams) => {
    const { id, name, content } = args;
    const preset = updatePromptPreset(id, { name, content });
    return { preset };
  });

  ipcMain.handle(CH.DELETE_PROMPT_PRESET, (_event, args: StorageDeletePromptPresetParams) => {
    const { id } = args;
    return { success: deletePromptPreset(id) };
  });

  // ── K 组：本地媒体导入（1 个）──

  ipcMain.handle(CH.IMPORT_LOCAL_MEDIA, (_event, args: StorageImportLocalMediaParams) => {
    const { projectPath, fileDataBase64, mimeType, originalFileName } = args ?? {};
    const fileData = Buffer.from(
      typeof fileDataBase64 === 'string' ? fileDataBase64 : '',
      'base64',
    );
    const projectRef = projectRefUtils.buildProjectRef(projectPath);
    if (!projectRef) throw new Error('Failed to compute projectRef');
    // stableProjectId 只读解析：coordinator.registerScope 已在窗口打开时补写 manifest，
    // 此处读取已持久化值；旧项目首次导入若尚未补写则 fallback 到 V1 URL。
    const stableProjectId = resolveStableProjectId(projectPath);
    return importLocalMedia({ projectPath, projectRef, stableProjectId, fileData, mimeType, originalFileName });
  });
  registerStorageMetadataIpcHandlers();
  registerSystemPromptStorageIpcHandlers();
  registerPackageAreaStorageIpcHandlers(getDbForExistingProject);

  // ── P 组：agent 会话（7 个）──
  // 读通道按已存在的项目库读取，写通道允许 DB 层建库（与 save-delta / upsert-media-asset 一致）。
  registerAgentSessionStorageIpcHandlers({
    getExistingDb: getDbForExistingProject,
    getWritableDb: getDb,
  });
};
export { registerStorageIpcHandlers };
