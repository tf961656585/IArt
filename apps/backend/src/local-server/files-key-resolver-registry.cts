import * as fs from 'node:fs';

import { isValidProjectFolder, getProjectFolderPaths } from './storage.cts';
import { getRegisteredProjectScopePaths } from './project-media-scope.cts';
import { listProjects } from './project-store.cts';
import { safeJoin } from './safe-path.cts';

const normalizeKey = (value: unknown) =>
  typeof value === 'string' ? value.trim().replace(/\\/g, '/') : '';

type ResolverDynamicParams = Record<string, unknown>;

interface RawResolverEntry {
  name: unknown | undefined;
  priority: unknown | undefined;
  match: unknown | undefined;
  resolve: unknown | undefined;
}
interface ResolverEntry {
  name: string;
  priority: number;
  match: (key: string, options: ResolverDynamicParams) => boolean;
  resolve: (key: string, options: ResolverDynamicParams) => string | null;
}

class FilesKeyResolverRegistry {
  resolvers: ResolverEntry[];

  constructor() {
    this.resolvers = [];
  }

  register(resolver: unknown) {
    if (!resolver || typeof resolver !== 'object') return false;
    const obj = resolver as RawResolverEntry;
    if (typeof obj.resolve !== 'function') return false;

    const name =
      typeof obj.name === 'string' && obj.name.trim()
        ? obj.name.trim()
        : `resolver-${this.resolvers.length + 1}`;
    const priority = typeof obj.priority === 'number' && Number.isFinite(obj.priority)
      ? Math.floor(obj.priority)
      : 100;
    const match =
      typeof obj.match === 'function' ? obj.match as ResolverEntry['match'] : () => true;

    this.resolvers.push({
      name,
      priority,
      match,
      resolve: obj.resolve as ResolverEntry['resolve'],
    });

    this.resolvers.sort((a, b) => a.priority - b.priority);
    return true;
  }

  resolve(fileKey: unknown, options: ResolverDynamicParams = {}) {
    const key = normalizeKey(fileKey);
    if (!key) return null;

    for (const resolver of this.resolvers) {
      let shouldHandle = false;
      try {
        shouldHandle = Boolean(resolver.match(key, options));
      } catch {
        shouldHandle = false;
      }
      if (!shouldHandle) continue;

      try {
        const result = resolver.resolve(key, options);
        if (typeof result === 'string' && result) return result;
      } catch {
        // ignore and continue to next resolver
      }
    }

    return null;
  }
}

const resolveFromProjectMedia = (fileKey: unknown) => {
  // 首选已注册项目作用域（Main 经 runtime:project-scope-* 同步，见 project-media-scope）；
  // 查不到再退全量项目列表兜底。
  const opened = (() => {
    try {
      return getRegisteredProjectScopePaths();
    } catch {
      return [];
    }
  })();

  for (const projectPath of opened) {
    if (!projectPath || typeof projectPath !== 'string') continue;
    if (!isValidProjectFolder(projectPath)) continue;
    const folderPaths = getProjectFolderPaths(projectPath);
    if (!folderPaths) continue;
    if (!folderPaths.media) continue;
    const candidate = safeJoin(folderPaths.media, fileKey);
    if (candidate && fs.existsSync(candidate)) return candidate;
  }

  const recent = (() => {
    try {
      return listProjects();
    } catch {
      return [];
    }
  })();

  for (const item of recent) {
    const projectPath =
      item !== null && item !== undefined && typeof item === 'object' && 'path' in item
        ? item.path
        : undefined;
    if (!projectPath || typeof projectPath !== 'string') continue;
    if (!isValidProjectFolder(projectPath)) continue;
    const folderPaths = getProjectFolderPaths(projectPath);
    if (!folderPaths) continue;
    if (!folderPaths.media) continue;
    const candidate = safeJoin(folderPaths.media, fileKey);
    if (candidate && fs.existsSync(candidate)) return candidate;
  }

  return null;
};

const createDefaultFilesKeyResolverRegistry = () => {
  const registry = new FilesKeyResolverRegistry();

  registry.register({
    name: 'project-media-resolver',
    priority: 100,
    match: () => true,
    resolve: (fileKey: string) => resolveFromProjectMedia(fileKey),
  });

  return registry;
};

const defaultFilesKeyResolverRegistry = createDefaultFilesKeyResolverRegistry();

const registerFilesKeyResolver = (resolver: unknown) =>
  defaultFilesKeyResolverRegistry.register(resolver);

const resolveFilesKeyToFilePathByRegistry = (fileKey: unknown, options: ResolverDynamicParams = {}) =>
  defaultFilesKeyResolverRegistry.resolve(fileKey, options);

const getFilesKeyResolverRegistry = () => defaultFilesKeyResolverRegistry;

export {
  FilesKeyResolverRegistry,
  createDefaultFilesKeyResolverRegistry,
  getFilesKeyResolverRegistry,
  registerFilesKeyResolver,
  resolveFilesKeyToFilePathByRegistry,
};
