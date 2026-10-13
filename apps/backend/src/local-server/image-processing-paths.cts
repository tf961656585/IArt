import * as fs from 'node:fs';
import * as path from 'node:path';

import { isValidProjectFolder, getProjectFolderPaths } from './storage.cts';
import * as safePath from './safe-path.cts';
import * as filesUrl from './files-url.cts';
import * as filesKeyResolverRegistry from './files-key-resolver-registry.cts';

type FilesResolveOptions = { projectPath: string | undefined };

const resolveFilesKeyToFilePath = (fileKey: unknown, options: FilesResolveOptions = { projectPath: undefined }) => {
  return filesKeyResolverRegistry.resolveFilesKeyToFilePathByRegistry(fileKey, options);
};

const resolveFilesUrlToFilePath = (sourceUrl: unknown, options: FilesResolveOptions = { projectPath: undefined }) => {
  if (typeof sourceUrl !== 'string') return null;
  const fileKey = filesUrl.parseFilesKeyFromUrl(sourceUrl);
  if (!fileKey) return null;
  const filePath = resolveFilesKeyToFilePath(fileKey, options);
  if (!filePath) return null;
  return { fileKey, filePath };
};

/**
 * Resolve a local-media:// URL strictly within the given project's media dir.
 *
 * This is required for project-scoped operations (e.g. video thumbnail/trim) to avoid
 * resolving an identically-named file from another opened/recent project.
 */
const resolveFilesUrlToFilePathInProject = (projectPath: unknown, sourceUrl: unknown) => {
  const normalizedProjectPath = typeof projectPath === 'string' ? projectPath.trim() : '';
  if (!normalizedProjectPath || !isValidProjectFolder(normalizedProjectPath)) return null;

  if (typeof sourceUrl !== 'string') return null;
  const fileKey = filesUrl.parseFilesKeyFromUrl(sourceUrl);
  if (!fileKey) return null;

  const folderPaths = getProjectFolderPaths(normalizedProjectPath);
  if (!(folderPaths !== null && folderPaths !== undefined ? folderPaths.media : undefined)) return null;
  if (folderPaths === null) return null;

  const filePath = safePath.safeJoin(folderPaths.media, fileKey);
  if (!filePath) return null;
  if (!fs.existsSync(filePath)) return null;
  return { fileKey, filePath };
};

/**
 * Ensure a local-media:// URL exists within the given project's media dir.
 * - If already exists: returns the project-local path
 * - If missing but found in other opened/recent projects: copies into this project then returns
 */
const ensureFilesUrlToFilePathInProject = (projectPath: unknown, sourceUrl: unknown) => {
  const normalizedProjectPath = typeof projectPath === 'string' ? projectPath.trim() : '';
  if (!normalizedProjectPath || !isValidProjectFolder(normalizedProjectPath)) return null;

  if (typeof sourceUrl !== 'string') return null;
  const fileKey = filesUrl.parseFilesKeyFromUrl(sourceUrl);
  if (!fileKey) return null;

  const folderPaths = getProjectFolderPaths(normalizedProjectPath);
  if (!(folderPaths !== null && folderPaths !== undefined ? folderPaths.media : undefined)) return null;
  if (folderPaths === null) return null;

  const targetPath = safePath.safeJoin(folderPaths.media, fileKey);
  if (!targetPath) return null;
  if (fs.existsSync(targetPath)) {
    return { fileKey, filePath: targetPath, wasCopied: false };
  }

  const sourcePath = resolveFilesKeyToFilePath(fileKey);
  if (!sourcePath || !fs.existsSync(sourcePath)) return null;

  let sourceStat = null;
  try {
    sourceStat = fs.statSync(sourcePath);
  } catch {
    // ignore
  }

  try {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  } catch {
    // ignore
  }

  try {
    fs.copyFileSync(sourcePath, targetPath);
  } catch {
    try {
      // 某些跨盘/权限场景下 copyFileSync 可能失败，降级到 read+write
      const buf = fs.readFileSync(sourcePath);
      fs.writeFileSync(targetPath, buf);
    } catch {
      return null;
    }
  }

  if (!fs.existsSync(targetPath)) return null;
  if (sourceStat) {
    try {
      fs.utimesSync(targetPath, sourceStat.atime, sourceStat.mtime);
    } catch {
      // ignore
    }
  }
  return { fileKey, filePath: targetPath, wasCopied: true };
};

export {
  resolveFilesKeyToFilePath,
  resolveFilesUrlToFilePath,
  resolveFilesUrlToFilePathInProject,
  ensureFilesUrlToFilePathInProject,
};
