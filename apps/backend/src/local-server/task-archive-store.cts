import * as fs from 'node:fs';
import * as path from 'node:path';
import { PROJECT_FOLDER_PATHS } from './constants.cts';
import * as loggingModule from './logging.cts';
import { ensureStorageDirs, getProjectFolderPaths, isValidProjectFolder } from './storage.cts';
import { getProjectIndex } from './project-store.cts';
import { externalizeTaskArchiveEventPayloads, hydrateTaskArchiveEventPayloads } from './task-archive-payloads.cts';
import { enforceTaskArchiveRetention } from './task-archive-retention.cts';

const normalizeString = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : '';

const cloneValue = <T,>(value: T) => {
  if (value === null || value === undefined) return value;
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
};

const ensureDir = (dirPath: unknown) => {
  const resolved = normalizeString(dirPath);
  if (!resolved) return null;
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
};

const safeExists = (filePath: unknown) => {
  const resolved = normalizeString(filePath);
  return resolved ? fs.existsSync(resolved) : false;
};

interface RawTaskArchiveMetadata {
  scope: unknown | undefined;
  projectPath: unknown | undefined;
  nodeGraphId: unknown | undefined;
}
interface RawProjectIndexItem {
  nodeGraphId: unknown | undefined;
  path: unknown | undefined;
}
interface RawTaskArchiveEvent {
  taskId: unknown | undefined;
  type: unknown | undefined;
  eventType: unknown | undefined;
  timestamp: unknown | undefined;
  recordedAt: unknown | undefined;
  createdAt: unknown | undefined;
  metadata: unknown | undefined;
  detail: unknown | undefined;
  snapshot: unknown | undefined;
}

const resolveProjectPathFromMetadata = (meta: unknown) => {
  if (!meta || typeof meta !== 'object') return null;
  const metaObj = meta as RawTaskArchiveMetadata;
  const scope = normalizeString(metaObj.scope).toLowerCase();
  if (scope === 'global') return null;
  const direct = normalizeString(metaObj.projectPath);
  if (direct) return direct;

  const nodeGraphId = normalizeString(metaObj.nodeGraphId);
  if (!nodeGraphId) return null;
  try {
    const projects = (getProjectIndex() !== null && getProjectIndex() !== undefined && getProjectIndex().index !== null && getProjectIndex().index !== undefined ? getProjectIndex().index.projects : undefined) ?? [];
    const hit = Array.isArray(projects)
      ? projects.find((item) => {
          if (typeof item !== 'object' || item === null) return false;
          return normalizeString((item as RawProjectIndexItem).nodeGraphId) === nodeGraphId;
        }) as RawProjectIndexItem | null | undefined
      : null;
    return normalizeString((hit !== null && hit !== undefined ? hit.path : undefined)) || null;
  } catch {
    return null;
  }
};

interface TaskArchiveRootResult {
  scope: 'project' | 'global';
  projectPath: string | null;
  root: string;
}

interface ArchiveOptions {
  taskId: string | undefined;
  projectPath: string | undefined;
  metadata: unknown | undefined;
  event: unknown | undefined;
}

const getTaskArchiveRoot = (options: ArchiveOptions = {} as ArchiveOptions): TaskArchiveRootResult => {
  const explicitProjectPath = normalizeString(options.projectPath);
  const metadataProjectPath = resolveProjectPathFromMetadata(options.metadata);
  const projectPath = explicitProjectPath || metadataProjectPath;

  if (projectPath && isValidProjectFolder(projectPath)) {
    const projectPaths = getProjectFolderPaths(projectPath);
    return {
      scope: 'project',
      projectPath,
      root: projectPaths ? projectPaths.taskArchives : path.join(projectPath, '.iartstudio', PROJECT_FOLDER_PATHS.TASK_ARCHIVES_DIR),
    };
  }

  const storage = ensureStorageDirs();
  return {
    scope: 'global',
    projectPath: null,
    root: path.join(storage.root, PROJECT_FOLDER_PATHS.TASK_ARCHIVES_DIR),
  };
};

const resolveTaskArchiveDir = (options: ArchiveOptions = {} as ArchiveOptions) => {
  const taskId = normalizeString(options.taskId);
  if (!taskId) return null;
  const location = getTaskArchiveRoot(options);
  const root = ensureDir(location.root);
  if (!root) return null;
  return path.join(root, encodeURIComponent(taskId));
};

const resolveTaskArchiveEventsPath = (options: ArchiveOptions = {} as ArchiveOptions) => {
  const taskArchiveDir = resolveTaskArchiveDir(options);
  if (!taskArchiveDir) return null;
  return path.join(taskArchiveDir, 'events.jsonl');
};

const resolveLegacyTaskArchiveDir = (options: ArchiveOptions = {} as ArchiveOptions) => {
  const taskId = normalizeString(options.taskId);
  const projectPath = normalizeString(options.projectPath) || resolveProjectPathFromMetadata(options.metadata);
  if (!taskId || !projectPath) return null;
  return path.join(projectPath, PROJECT_FOLDER_PATHS.TASK_ARCHIVES_DIR, encodeURIComponent(taskId));
};

const hasLegacyTaskArchiveDir = (options: ArchiveOptions = {} as ArchiveOptions) => {
  const legacyDir = resolveLegacyTaskArchiveDir(options);
  return legacyDir ? fs.existsSync(legacyDir) : false;
};

const resolveTaskArchivePath = (options: ArchiveOptions = {} as ArchiveOptions) => {
  return resolveTaskArchiveEventsPath(options);
};

export interface TaskArchiveEvent {
  taskId: string;
  type: string;
  timestamp: string;
  metadata: unknown;
  detail: unknown;
  snapshot: unknown;
}

const normalizeTaskArchiveEvent = (value: unknown, options: ArchiveOptions = {} as ArchiveOptions): TaskArchiveEvent | null => {
  if (!value || typeof value !== 'object') return null;
  const obj = value as RawTaskArchiveEvent;
  const taskId = normalizeString(obj.taskId || options.taskId);
  if (!taskId) return null;
  const metadata = obj.metadata && typeof obj.metadata === 'object' ? cloneValue(obj.metadata) : null;
  const eventType = normalizeString(obj.type || obj.eventType) || 'task.event';
  const timestamp =
    normalizeString(obj.timestamp || obj.recordedAt || obj.createdAt) || new Date().toISOString();
  return {
    taskId,
    type: eventType,
    timestamp,
    metadata,
    detail: cloneValue(obj.detail ?? null),
    snapshot: cloneValue(obj.snapshot ?? null),
  };
};

const appendTaskArchiveEvent = (options: ArchiveOptions = {} as ArchiveOptions) => {
  const taskId = normalizeString(options.taskId);
  const event = normalizeTaskArchiveEvent(options.event, { taskId, projectPath: undefined, metadata: undefined, event: undefined });
  if (!taskId || !event) return null;
  const archiveDirPath = resolveTaskArchiveDir(options);
  const archivePath = resolveTaskArchiveEventsPath(options);
  if (!archiveDirPath || !archivePath) return null;
  const archiveRoot = getTaskArchiveRoot(options).root;
  ensureDir(archiveDirPath);
  const eventWithPayloadRefs: unknown = externalizeTaskArchiveEventPayloads({
    event,
    archiveRootPath: archiveRoot,
    taskArchiveDirPath: archiveDirPath,
  });
  fs.appendFileSync(archivePath, `${JSON.stringify(eventWithPayloadRefs)}\n`, 'utf-8');
  try {
    const location = getTaskArchiveRoot(options);
    if (location.scope === 'project') {
      enforceTaskArchiveRetention(location.root);
    }
  } catch (error) {
    loggingModule.logWarn('[task-archive-store] retention failed', { error: String(error) });
  }
  return { archivePath, archiveDirPath, event: eventWithPayloadRefs };
};

const readTaskArchiveEvents = (options: ArchiveOptions = {} as ArchiveOptions): TaskArchiveEvent[] => {
  const archiveDirPath = resolveTaskArchiveDir(options);
  const archivePath = resolveTaskArchiveEventsPath(options);
  if (!archivePath || !fs.existsSync(archivePath)) return [];
  const lines = fs.readFileSync(archivePath, 'utf-8').split('\n');
  const events: TaskArchiveEvent[] = [];
  for (const line of lines) {
    const text = normalizeString(line);
    if (!text) continue;
    try {
      const parsed: unknown = JSON.parse(text);
      const hydrated = hydrateTaskArchiveEventPayloads({
        event: parsed,
        archiveDirPath,
      });
      const normalized = normalizeTaskArchiveEvent(hydrated, options.taskId ? { taskId: options.taskId, projectPath: undefined, metadata: undefined, event: undefined } : {} as ArchiveOptions);
      if (normalized) events.push(normalized);
    } catch {
      // ignore broken line
    }
  }
  return events;
};

const deleteTaskArchive = (options: ArchiveOptions = {} as ArchiveOptions) => {
  const archiveDirPath = resolveTaskArchiveDir(options);
  if (!archiveDirPath || !safeExists(archiveDirPath)) return false;
  fs.rmSync(archiveDirPath, { recursive: true, force: true });
  return true;
};

export {
  getTaskArchiveRoot,
  resolveProjectPathFromMetadata,
  resolveTaskArchiveDir,
  resolveTaskArchiveEventsPath,
  resolveTaskArchivePath,
  resolveLegacyTaskArchiveDir,
  hasLegacyTaskArchiveDir,
  normalizeTaskArchiveEvent,
  appendTaskArchiveEvent,
  readTaskArchiveEvents,
  deleteTaskArchive,
};
