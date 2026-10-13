import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  PROJECT_INDEX_FILENAME,
  PROVIDER_CONNECTIONS_FILENAME,
  MODEL_DEPLOYMENTS_FILENAME,
  ACTIVE_ROUTES_FILENAME,
  PROVIDER_CREDENTIALS_FILENAME,
  PROMPT_PRESETS_FILENAME,
  THINKING_TIER_PRESETS_FILENAME,
  CUSTOM_CHAT_MODELS_FILENAME,
  CUSTOM_GENERATION_MODELS_FILENAME,
  ONBOARDING_STATE_FILENAME,
  RECENT_PROJECTS_FILENAME,
  RECENT_PROJECTS_VERSION,
  PROJECT_FOLDER_PATHS,
  PROJECT_FOLDER_EXT,
} from './constants.cts';
import { getEffectiveStorageRoot } from './config-store.cts';
import * as projectNamingModule from './project-naming.cts';

const {
  generateProjectFolderName: buildProjectFolderName,
  generateProjectFolderNameWithSuffix: buildProjectFolderNameWithSuffix,
} = projectNamingModule as {
  generateProjectFolderName: (projectName: string, suffix: string) => string;
  generateProjectFolderNameWithSuffix: (baseName: string, suffix: number, ext: string) => string;
};

const getStorageRoot = () => getEffectiveStorageRoot();

const getStoragePaths = () => {
  const root = getStorageRoot();
  const configRoot = path.join(root, 'config');
  const mediaRoot = path.join(root, 'media');
  return {
    root,
    jobs: path.join(root, 'jobs'),
    cache: path.join(root, 'cache'),
    logs: path.join(root, 'logs'),
    config: configRoot,
    backendSqlite: path.join(configRoot, 'backend.sqlite'),
    media: mediaRoot,
    projectIndex: path.join(configRoot, PROJECT_INDEX_FILENAME),
    providerConnections: path.join(configRoot, PROVIDER_CONNECTIONS_FILENAME),
    modelDeployments: path.join(configRoot, MODEL_DEPLOYMENTS_FILENAME),
    activeRoutes: path.join(configRoot, ACTIVE_ROUTES_FILENAME),
    providerCredentials: path.join(configRoot, PROVIDER_CREDENTIALS_FILENAME),
    promptPresets: path.join(configRoot, PROMPT_PRESETS_FILENAME),
    thinkingTierPresets: path.join(configRoot, THINKING_TIER_PRESETS_FILENAME),
    customChatModels: path.join(configRoot, CUSTOM_CHAT_MODELS_FILENAME),
    customGenerationModels: path.join(configRoot, CUSTOM_GENERATION_MODELS_FILENAME),
    onboardingState: path.join(configRoot, ONBOARDING_STATE_FILENAME),
    recentProjects: path.join(configRoot, RECENT_PROJECTS_FILENAME),
    globalCharacters: path.join(configRoot, 'global-characters.json'),
    globalCharacterMediaDir: path.join(mediaRoot, 'global-characters'),
  };
};

const ensureStorageDirs = () => {
  const paths = getStoragePaths();
  Object.values(paths).forEach((dir) => {
    const ext = dir ? path.extname(dir) : '';
    if (dir && ext !== '.json' && ext !== '.sqlite') {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
  return paths;
};

// ==================== 最近项目管理 ====================

interface RecentProjectItem {
  name: string;
  path: string;
  lastOpenedAt: number;
  createdAt: number;
}

interface RecentProjectsIndex {
  version: number;
  updatedAt: string;
  recentProjects: RecentProjectItem[];
}

const buildEmptyRecentProjects = (): RecentProjectsIndex => ({
  version: RECENT_PROJECTS_VERSION,
  updatedAt: new Date().toISOString(),
  recentProjects: [],
});

interface RawRecentProjectItem {
  path: unknown | undefined;
  name: unknown | undefined;
  lastOpenedAt: unknown | undefined;
  createdAt: unknown | undefined;
}
interface RawRecentProjectsIndex {
  recentProjects: unknown | undefined;
  updatedAt: unknown | undefined;
}

const normalizeRecentProjectItem = (item: unknown): RecentProjectItem | null => {
  if (!item || typeof item !== 'object') return null;
  const obj = item as RawRecentProjectItem;
  const projectPath = typeof obj.path === 'string' && obj.path.trim() ? obj.path.trim() : null;
  if (!projectPath) return null;
  const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : '未命名项目';
  const lastOpenedAt = typeof obj.lastOpenedAt === 'number' && Number.isFinite(obj.lastOpenedAt) ? obj.lastOpenedAt : Date.now();
  const createdAt = typeof obj.createdAt === 'number' && Number.isFinite(obj.createdAt) ? obj.createdAt : lastOpenedAt;
  return { name, path: projectPath, lastOpenedAt, createdAt };
};

const normalizeRecentProjects = (raw: unknown): RecentProjectsIndex | null => {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as RawRecentProjectsIndex;
  const recentProjects = Array.isArray(obj.recentProjects)
    ? obj.recentProjects.map(normalizeRecentProjectItem).filter((v): v is RecentProjectItem => v !== null)
    : [];
  return {
    version: RECENT_PROJECTS_VERSION,
    updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : new Date().toISOString(),
    recentProjects,
  };
};

interface StoragePaths {
  recentProjects: string;
  [key: string]: string;
}

const readRecentProjectsFromDisk = (paths: StoragePaths | null) => {
  if (!paths) return null;
  if (!paths.recentProjects) return null;
  try {
    if (!fs.existsSync(paths.recentProjects)) {
      return null;
    }
    const raw = fs.readFileSync(paths.recentProjects, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    return normalizeRecentProjects(parsed);
  } catch {
    return null;
  }
};

const writeRecentProjectsToDisk = (paths: StoragePaths | null, index: unknown) => {
  if (!paths) return;
  if (!paths.recentProjects) return;
  const normalized = normalizeRecentProjects(index) ?? buildEmptyRecentProjects();
  fs.writeFileSync(paths.recentProjects, JSON.stringify(normalized, null, 2), 'utf-8');
};

const getRecentProjects = () => {
  const paths = ensureStorageDirs();
  const index = readRecentProjectsFromDisk(paths) ?? buildEmptyRecentProjects();
  return { index, paths };
};

// ==================== 项目文件夹路径工具 ====================

interface ProjectFolderPaths {
  root: string;
  manifest: string;
  nodeGraph: string;
  sqlite: string;
  index: string;
  modelNodeUsage: string;
  nodeTypeUsage: string;
  nodePalettePins: string;
  characterPins: string;
  media: string;
  taskArchives: string;
  requestLogs: string;
  lock: string;
}

const getProjectFolderPaths = (projectFolderPath: unknown): ProjectFolderPaths | null => {
  if (!projectFolderPath || typeof projectFolderPath !== 'string') return null;
  return {
    root: projectFolderPath,
    manifest: path.join(projectFolderPath, PROJECT_FOLDER_PATHS.MANIFEST),
    nodeGraph: path.join(projectFolderPath, PROJECT_FOLDER_PATHS.NODE_GRAPH),
    sqlite: path.join(projectFolderPath, PROJECT_FOLDER_PATHS.SQLITE),
    index: path.join(projectFolderPath, PROJECT_FOLDER_PATHS.INDEX),
    modelNodeUsage: path.join(
      projectFolderPath,
      PROJECT_FOLDER_PATHS.MODEL_NODE_USAGE,
    ),
    nodeTypeUsage: path.join(
      projectFolderPath,
      PROJECT_FOLDER_PATHS.NODE_TYPE_USAGE,
    ),
    nodePalettePins: path.join(
      projectFolderPath,
      PROJECT_FOLDER_PATHS.NODE_PALETTE_PINS,
    ),
    characterPins: path.join(
      projectFolderPath,
      PROJECT_FOLDER_PATHS.CHARACTER_PINS,
    ),
    media: path.join(projectFolderPath, PROJECT_FOLDER_PATHS.MEDIA_DIR),
    taskArchives: path.join(projectFolderPath, '.iartstudio', PROJECT_FOLDER_PATHS.TASK_ARCHIVES_DIR),
    requestLogs: path.join(projectFolderPath, PROJECT_FOLDER_PATHS.REQUEST_LOGS_DIR),
    lock: path.join(projectFolderPath, PROJECT_FOLDER_PATHS.LOCK_FILE),
  };
};

const ensureProjectFolderDirs = (projectFolderPath: unknown) => {
  const folderPaths = getProjectFolderPaths(projectFolderPath);
  if (!folderPaths) return null;
  fs.mkdirSync(folderPaths.root, { recursive: true });
  fs.mkdirSync(folderPaths.media, { recursive: true });
  fs.mkdirSync(folderPaths.taskArchives, { recursive: true });
  return folderPaths;
};

const isValidProjectFolder = (folderPath: unknown) => {
  if (!folderPath || typeof folderPath !== 'string') return false;
  const paths = getProjectFolderPaths(folderPath);
  if (!paths) return false;
  return fs.existsSync(paths.sqlite) || fs.existsSync(paths.manifest);
};

const generateProjectFolderName = (projectName: unknown) => {
  return buildProjectFolderName(String(projectName ?? ''), PROJECT_FOLDER_EXT);
};

const generateProjectFolderNameWithSuffix = (baseName: unknown, suffix: unknown) => {
  return buildProjectFolderNameWithSuffix(String(baseName ?? ''), Number(suffix ?? 0), PROJECT_FOLDER_EXT);
};

export {
  getStorageRoot,
  getStoragePaths,
  ensureStorageDirs,
  // 最近项目管理
  buildEmptyRecentProjects,
  normalizeRecentProjectItem,
  normalizeRecentProjects,
  readRecentProjectsFromDisk,
  writeRecentProjectsToDisk,
  getRecentProjects,
  // 项目文件夹路径
  type ProjectFolderPaths,
  getProjectFolderPaths,
  ensureProjectFolderDirs,
  isValidProjectFolder,
  generateProjectFolderName,
  generateProjectFolderNameWithSuffix,
};
