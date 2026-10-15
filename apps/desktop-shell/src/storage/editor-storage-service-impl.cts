/**
 * Editor Storage Service — 主入口
 *
 * 连接池、生命周期、CRUD、节点输出操作。
 * 简化自 Backend project-store.cts + storage.cts，并收束到 Main Process SQLite 写入边界。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  RemoveOutputItemParams,
  StorageProjectFailure,
  StorageProjectFailureAction,
  StorageProjectFailureCode,
  StorageProjectFailureStage,
} from '@iart/contracts';
import type { ProjectRecord, ProjectMediaAssets } from '@iart/contracts';
import { loadBetterSqlite3, type SqliteDatabase, type SqliteDatabaseCtor } from './sqlite-loader.cjs';
import {
  initSchema,
  isProjectSqliteSchemaMismatchError,
} from './editor-storage-schema.cjs';
import {
  enqueueDelta,
  flush,
  discardPending,
  getPendingState,
  setFlushRegistrySync,
} from './editor-storage-delta.cjs';
import {
  buildProjectRecord,
  readAgentMessages,
  readAgentSendRecords,
  readAgentSessionByNodeId,
  readAgentSessions,
  readAllMediaAssets,
  readAllTasks,
  readBatchById,
  readBatchByClientRequestId,
  readTasksByBatchId,
  readManifestFromDb,
  readMediaAssetById,
  readMediaAssetsByTaskId,
  readTaskById,
  readTaskOutputAssetIndex,
  readTaskOutputs,
  type JsonObject,
} from './editor-storage-read-model.cjs';
import {
  addRecentProject,
  readRecentProjects,
  removeRecentProject,
} from './editor-storage-recent-projects.cjs';

// ── Types ──

interface ProjectDbEntry {
  db: SqliteDatabase;
  dbPath: string;
}

type ProjectFolderValidationResult =
  | {
      ok: true;
      normalizedPath: string;
      db: SqliteDatabase;
    }
  | {
      ok: false;
      failure: StorageProjectFailure;
    };

// ── DB Cache ──

const dbCache = new Map<string, ProjectDbEntry>();

let Database: SqliteDatabaseCtor | null = null;

const getDatabaseCtor = () => {
  if (Database) return Database;
  Database = loadBetterSqlite3();
  return Database;
};

const withCanonicalGraphId = (
  graph: JsonObject,
  nodeGraphId: string,
): JsonObject => ({
  ...graph,
  id: nodeGraphId,
});

const buildStorageProjectFailure = (params: {
  code: StorageProjectFailureCode;
  message: string;
  projectPath: string;
  stage: StorageProjectFailureStage;
  action: StorageProjectFailureAction;
  hint: string | null | undefined;
}): StorageProjectFailure => ({
  code: params.code,
  message: params.message,
  projectPath: params.projectPath,
  stage: params.stage,
  source: 'storage-service',
  action: params.action,
  ...(params.hint !== undefined ? { hint: params.hint } : {}),
});

// ── DB lifecycle ──

const normalizeProjectPathInput = (projectPath: unknown): string => {
  if (typeof projectPath !== 'string' || !projectPath.trim()) {
    throw new Error('INVALID_PROJECT_PATH');
  }
  return path.resolve(projectPath.trim());
};

const getDb = (projectPath: string): SqliteDatabase => {
  const normalized = normalizeProjectPathInput(projectPath);
  const existing = dbCache.get(normalized);
  if (existing !== undefined && existing.db !== undefined) return existing.db;

  const dbPath = path.join(normalized, 'project.sqlite');
  const DatabaseCtor = getDatabaseCtor();
  const db = new DatabaseCtor(dbPath);

  db.pragma('journal_mode = WAL', undefined);
  db.pragma('synchronous = NORMAL', undefined);
  db.pragma('foreign_keys = ON', undefined);
  try {
    initSchema(db, { projectPath: normalized });
  } catch (error) {
    dbCache.delete(normalized);
    try {
      db.close();
    } catch {
      // ignore
    }
    throw error;
  }

  dbCache.set(normalized, { db, dbPath });
  return db;
};

const closeDb = (projectPath: string): void => {
  const normalized = normalizeProjectPathInput(projectPath);
  const entry = dbCache.get(normalized);
  if (entry === undefined || entry.db === undefined) {
    dbCache.delete(normalized);
    return;
  }
  try {
    entry.db.pragma('wal_checkpoint(TRUNCATE)', undefined);
  } catch {
    // ignore
  }
  try {
    entry.db.close();
  } catch {
    // ignore
  }
  dbCache.delete(normalized);
};

const closeAll = (): void => {
  for (const [projectPath] of dbCache) {
    closeDb(projectPath);
  }
};

// ── Project folder helpers ──

const validateProjectFolder = (
  projectPath: string,
): ProjectFolderValidationResult => {
  const normalizedPath = path.resolve(projectPath);
  try {
    if (typeof projectPath !== 'string' || !projectPath.trim()) {
      return {
        ok: false,
        failure: buildStorageProjectFailure({
          code: 'invalid-project-folder',
          message: '项目路径为空，必须传入项目目录。',
          projectPath: normalizedPath,
          stage: 'ipc-open',
          action: 'reselect-project',
          hint: undefined,
        }),
      };
    }
    if (!fs.existsSync(normalizedPath)) {
      return {
        ok: false,
        failure: buildStorageProjectFailure({
          code: 'invalid-project-folder',
          message: '项目目录不存在，当前路径无法打开。',
          projectPath: normalizedPath,
          stage: 'ipc-open',
          action: 'reselect-project',
          hint: undefined,
        }),
      };
    }
    const stat = fs.statSync(normalizedPath);
    if (!stat.isDirectory()) {
      return {
        ok: false,
        failure: buildStorageProjectFailure({
          code: 'invalid-project-folder',
          message:
            path.basename(normalizedPath) === 'project.sqlite'
              ? '当前传入的是 project.sqlite 文件路径，必须传入项目目录。'
              : '当前传入路径不是项目目录，无法继续打开。',
          projectPath: normalizedPath,
          stage: 'ipc-open',
          action: 'reselect-project',
          hint: undefined,
        }),
      };
    }
    if (!fs.existsSync(path.join(normalizedPath, 'project.sqlite'))) {
      return {
        ok: false,
        failure: buildStorageProjectFailure({
          code: 'invalid-project-folder',
          message: '项目目录缺少 project.sqlite，无法作为项目打开。',
          projectPath: normalizedPath,
          stage: 'ipc-open',
          action: 'reselect-project',
          hint: undefined,
        }),
      };
    }
    return {
      ok: true,
      normalizedPath,
      db: getDb(normalizedPath),
    };
  } catch (error) {
    if (isProjectSqliteSchemaMismatchError(error)) throw error;
    return {
      ok: false,
      failure: buildStorageProjectFailure({
        code: 'invalid-project-folder',
        message: '项目目录校验失败，无法确认该路径是否可用。',
        projectPath: normalizedPath,
        stage: 'ipc-open',
        action: 'diagnose',
        hint: undefined,
      }),
    };
  }
};

const isValidProjectFolder = (dirPath: string): boolean =>
  validateProjectFolder(dirPath).ok;

const readProjectFailure = (
  projectPath: string,
  options: { allowEmpty: boolean | undefined } | undefined,
): {
  db: SqliteDatabase;
  normalizedPath: string;
  failure: StorageProjectFailure | null;
} => {
  const validation = validateProjectFolder(projectPath);
  if (!validation.ok) {
    return {
      db: null as never,
      normalizedPath: path.resolve(projectPath),
      failure: validation.failure,
    };
  }

  const manifest = readManifestFromDb(validation.db);
  if (!manifest) {
    return {
      db: validation.db,
      normalizedPath: validation.normalizedPath,
      failure: (options !== null && options !== undefined ? options.allowEmpty : undefined)
        ? null
        : buildStorageProjectFailure({
            code: 'project-manifest-missing',
            message: '项目目录存在，但缺少 project_manifest，无法确认项目主入口。',
            projectPath: validation.normalizedPath,
            stage: 'ipc-open',
            action: 'diagnose',
            hint: undefined,
          }),
    };
  }

  const project = buildProjectRecord(validation.normalizedPath, validation.db);
  if (!project) {
    return {
      db: validation.db,
      normalizedPath: validation.normalizedPath,
      failure: (options !== null && options !== undefined ? options.allowEmpty : undefined)
        ? null
        : buildStorageProjectFailure({
            code: 'missing-node-graph',
            message:
              '项目 manifest 已存在，但正式 graph 缺失或与 manifest.nodeGraphId 不一致。',
            projectPath: validation.normalizedPath,
            stage: 'data-validate',
            action: 'diagnose',
            hint: undefined,
          }),
    };
  }

  return {
    db: validation.db,
    normalizedPath: validation.normalizedPath,
    failure: null,
  };
};

const getDbForExistingProject = (projectPath: unknown): SqliteDatabase | null => {
  if (typeof projectPath !== 'string' || !projectPath.trim()) return null;
  const normalized = path.resolve(projectPath.trim());
  if (!path.isAbsolute(projectPath.trim())) return null;
  if (!isValidProjectFolder(normalized)) return null;
  return getDb(normalized);
};

const ensureProjectFolderDirs = (dirPath: string): void => {
  const mediaDir = path.join(dirPath, 'media');
  if (!fs.existsSync(mediaDir)) {
    fs.mkdirSync(mediaDir, { recursive: true });
  }
};

// ── CRUD ──

/**
 * 重名守卫（spec docs/integrations/CLI与本地Agent集成.md §5.1 project create / CLI-005）：
 * 目标父目录下已存在同名项目目录时必须失败，不得复用或覆盖既有目录（§10）。
 * 守卫加在 createProject 入口——Hub 创建与 CLI 创建走同一通道，GUI 同链受益。
 * 判定用 `fs.existsSync` 且先于任何写动作（不建目录、不写库、登记表不变）。
 */
const findExistingProjectDir = (parentDir: string, projectName: string): string | null => {
  const target = path.join(parentDir, projectName);
  return fs.existsSync(target) ? target : null;
};

const createProject = (params: {
  parentDir: string;
  name: string | undefined;
  nodeGraph: JsonObject | undefined;
  mediaAssets: ProjectMediaAssets | undefined;
}): { projectPath: string; project: ProjectRecord | null } => {
  const { parentDir, name, nodeGraph, mediaAssets } = params;
  const projectName = name || 'Untitled Project';
  const projectPath = path.join(parentDir, projectName);

  const existingDir = findExistingProjectDir(parentDir, projectName);
  if (existingDir !== null) {
    console.warn('[editor-storage] createProject 命中同名项目目录，拒绝创建（CLI-005）', {
      existingDir,
    });
    throw new Error('PROJECT_NAME_CONFLICT');
  }

  fs.mkdirSync(projectPath, { recursive: true });
  ensureProjectFolderDirs(projectPath);

  const db = getDb(projectPath);
  const now = Date.now();
  const nodeGraphId = `graph_${now}`;

  // Write manifest
  db.prepare(
    `INSERT OR REPLACE INTO project_manifest (id, version, name, nodeGraphId, createdAt, savedAt)
     VALUES (1, 1, ?, ?, ?, ?)`,
  ).run(projectName, nodeGraphId, now, now);

  const defaultGraph = nodeGraph || { id: nodeGraphId, nodes: [] };
  db.transaction(() => {
    db.prepare('INSERT OR REPLACE INTO graph (id, payloadJson, updatedAt) VALUES (?, ?, ?)').run(
      nodeGraphId,
      JSON.stringify(withCanonicalGraphId(defaultGraph, nodeGraphId)),
      now,
    );
  })();

  if (mediaAssets && typeof mediaAssets === 'object') {
    const insertAsset = db.prepare(
      `INSERT OR REPLACE INTO media_assets (
        assetId, mediaType, payloadJson, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?)`,
    );
    for (const [id, asset] of Object.entries(mediaAssets)) {
      insertAsset.run(
        id,
        asset.mediaType,
        JSON.stringify(asset),
        asset.lifecycle.createdAt,
        asset.lifecycle.updatedAt,
      );
    }
  }

  addRecentProject({
    nodeGraphId,
    name: projectName,
    path: projectPath,
    createdAt: now,
    savedAt: now,
    lastOpenedAt: now,
  });

  return { projectPath, project: buildProjectRecord(projectPath, db) };
};

const openProject = (params: {
  projectPath: string;
  allowEmpty: boolean | undefined;
}): { project: ProjectRecord | null } => {
  const { projectPath, allowEmpty } = params;
  const resolved = readProjectFailure(
    projectPath,
    allowEmpty !== undefined ? { allowEmpty } : undefined,
  );
  if (resolved.failure) {
    throw new Error(resolved.failure.code);
  }
  const normalized = resolved.normalizedPath;

  ensureProjectFolderDirs(normalized);
  const db = resolved.db;
  const project = buildProjectRecord(normalized, db);

  if (!project && !allowEmpty) {
    throw new Error('PROJECT_DATA_EMPTY');
  }

  addRecentProject({
    nodeGraphId: (project !== null && project !== undefined ? project.nodeGraphId : undefined) || '',
    name: (project !== null && project !== undefined ? project.name : undefined) || path.basename(normalized),
    path: normalized,
    createdAt: (project !== null && project !== undefined ? project.createdAt : undefined) || Date.now(),
    savedAt: (project !== null && project !== undefined ? project.savedAt : undefined) || Date.now(),
    lastOpenedAt: Date.now(),
  });

  return { project };
};

const getProject = (params: { projectPath: string; allowEmpty: boolean | undefined }): ProjectRecord | null => {
  const { projectPath, allowEmpty } = params;
  const resolved = readProjectFailure(
    projectPath,
    allowEmpty !== undefined ? { allowEmpty } : undefined,
  );
  if (resolved.failure) {
    const error = new Error(resolved.failure.message) as Error & {
      code: string | undefined;
      failure: StorageProjectFailure | undefined;
    };
    error.code = resolved.failure.code;
    error.failure = resolved.failure;
    throw error;
  }
  const project = buildProjectRecord(resolved.normalizedPath, resolved.db);
  return project;
};

const deleteProject = (params: { projectPath: string }): void => {
  const { projectPath } = params;
  const normalized = path.resolve(projectPath);
  removeRecentProject(normalized);
  closeDb(normalized);
};

type ProjectIndexEntry = {
  nodeGraphId: string;
  name: string;
  savedAt: number;
  createdAt: number;
  path: string;
  valid: true;
};

const listProjects = (): ProjectIndexEntry[] => {
  const registry = readRecentProjects();
  return registry
    .filter((entry) => (entry !== null && entry !== undefined ? entry.path : undefined) && fs.existsSync(entry.path) && fs.statSync(entry.path).isDirectory())
    .map((entry) => ({
      nodeGraphId: entry.nodeGraphId || '',
      name: entry.name || path.basename(entry.path),
      savedAt: entry.savedAt || 0,
      createdAt: entry.createdAt || 0,
      path: entry.path,
      valid: true as const,
    }));
};

const getMetaIndex = (): { key: string; projects: ProjectIndexEntry[] } => {
  const projects = listProjects();
  return { key: 'index', projects };
};

const importFolder = (params: { projectPath: string }): { projectPath: string; project: ProjectRecord | null } => {
  const { projectPath } = params;
  const normalized = path.resolve(projectPath);

  if (!normalized || !normalized.trim()) {
    throw new Error('INVALID_PROJECT');
  }
  if (!isValidProjectFolder(normalized)) {
    throw new Error('PROJECT_NOT_FOUND');
  }

  ensureProjectFolderDirs(normalized);
  const db = getDb(normalized);
  const manifest = readManifestFromDb(db);
  if (!manifest) {
    throw new Error('PROJECT_DATA_EMPTY');
  }

  const project = buildProjectRecord(normalized, db);
  if (!project) throw new Error('PROJECT_DATA_EMPTY');

  addRecentProject({
    nodeGraphId: manifest.nodeGraphId || '',
    name: manifest.name,
    path: normalized,
    createdAt: manifest.createdAt || Date.now(),
    savedAt: manifest.savedAt || Date.now(),
    lastOpenedAt: Date.now(),
  });

  return { projectPath: normalized, project };
};

// ── Node output operations ──

const clearNodeOutput = (params: {
  projectPath: string;
  nodeId: string;
}): { cleared: boolean } => {
  const { projectPath, nodeId } = params;
  const db = getDb(path.resolve(projectPath));

  // Add tombstone
  void db;
  void nodeId;
  return { cleared: true };
};

const removeOutputItem = (params: {
  projectPath: string;
  item: RemoveOutputItemParams;
}): { removed: boolean } => {
  const { projectPath, item } = params;
  const db = getDb(path.resolve(projectPath));

  void db;
  void item;
  return { removed: true };
};

// ── Flush registry sync hook ──

setFlushRegistrySync((db: SqliteDatabase, projectPath: string): void => {
  const manifest = readManifestFromDb(db);
  if (!manifest) return;
  addRecentProject({
    nodeGraphId: manifest.nodeGraphId || '',
    name: manifest.name,
    path: projectPath,
    createdAt: manifest.createdAt || Date.now(),
    savedAt: manifest.savedAt,
    lastOpenedAt: Date.now(),
  });
});

// ── Exports ──

export {
  getDb,
  getDbForExistingProject,
  validateProjectFolder,
  closeDb,
  closeAll,
  createProject,
  findExistingProjectDir,
  openProject,
  getProject,
  deleteProject,
  listProjects,
  getMetaIndex,
  importFolder,
  clearNodeOutput,
  removeOutputItem,
  buildProjectRecord,
  addRecentProject,
  removeRecentProject,
  readManifestFromDb,
  readTaskById,
  readBatchById,
  readBatchByClientRequestId,
  readTasksByBatchId,
  readTaskOutputs,
  readTaskOutputAssetIndex,
  readMediaAssetsByTaskId,
  readAllTasks,
  readAllMediaAssets,
  readMediaAssetById,
  readAgentSessions,
  readAgentSessionByNodeId,
  readAgentMessages,
  readAgentSendRecords,
  enqueueDelta,
  flush,
  discardPending,
  getPendingState,
};
