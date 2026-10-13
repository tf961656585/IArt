import * as fs from 'node:fs';
import * as path from 'node:path';
import projectPathsUtils = require('@iart/utils/project-paths');

const { isValidProjectFolder, getProjectFolderPaths } = projectPathsUtils;

type RevealFilesUrlParams = {
  url: string | null | undefined;
  storedProjectPath: string | null | undefined;
  hintedProjectPath: string | null | undefined;
  shell: {
    showItemInFolder: (filePath: string) => void;
    openPath: (dirPath: string) => Promise<string>;
  } | null | undefined;
  urlResolverRegistry: {
    resolve: ((url: string, context: { projectPath: string }) => {
      ok: boolean | undefined;
      reason: string | undefined;
      fileKey: string | null | undefined;
    } | null) | undefined;
  } | null | undefined;
};

const normalizeString = (value: unknown) =>
  (typeof value === 'string' && value.trim() ? value.trim() : '');

const isSafeFilesKey = (fileKey: unknown) => {
  const key = normalizeString(fileKey);
  if (!key) return false;
  if (key.includes('\0')) return false;

  if (path.isAbsolute(key) || path.win32.isAbsolute(key)) return false;
  if (/^[a-zA-Z]:/.test(key)) return false;
  if (key.startsWith('\\\\')) return false;

  const normalized = key.replace(/\\/g, '/');
  if (normalized === '.' || normalized === '..') return false;
  if (normalized.startsWith('../') || normalized.includes('/../') || normalized.endsWith('/..')) return false;

  return true;
};

const resolvePathWithin = (baseDir: unknown, relativePath: unknown) => {
  const base = normalizeString(baseDir);
  const rel = normalizeString(relativePath);
  if (!base || !rel) return null;

  try {
    const resolvedBase = path.resolve(base);
    const resolved = path.resolve(resolvedBase, rel);
    const relative = path.relative(resolvedBase, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      return null;
    }
    return resolved;
  } catch {
    return null;
  }
};

const pickProjectPath = (
  storedProjectPath: string | null | undefined,
  hintedProjectPath: string | null | undefined,
) => {
  const candidates = [storedProjectPath, hintedProjectPath];
  for (const candidate of candidates) {
    const normalized = normalizeString(candidate);
    if (!normalized) continue;
    if (!path.isAbsolute(normalized)) continue;
    if (!isValidProjectFolder(normalized)) continue;
    return normalized;
  }
  return '';
};

const isDirectory = (dirPath: string) => {
  try {
    if (!fs.existsSync(dirPath)) return false;
    const stat = fs.statSync(dirPath);
    return !!stat && typeof stat.isDirectory === 'function' && stat.isDirectory();
  } catch {
    return false;
  }
};

/**
 * Reveal a URL in the system file manager.
 * - Accepts only URLs that can be resolved by the provided registry.
 * - Enforces that the resolved path stays within <project>/media.
 */
export const revealFilesUrl = async ({
  url,
  storedProjectPath,
  hintedProjectPath,
  shell,
  urlResolverRegistry,
}: RevealFilesUrlParams = {} as RevealFilesUrlParams) => {
  const normalizedUrl = normalizeString(url);
  if (!normalizedUrl) {
    return { ok: false, reason: 'missing-url' };
  }

  const projectPath = pickProjectPath(storedProjectPath, hintedProjectPath);
  if (!projectPath) {
    return { ok: false, reason: 'missing-project-path' };
  }

  const resolverResult = (urlResolverRegistry !== null && urlResolverRegistry !== undefined && urlResolverRegistry.resolve !== null && urlResolverRegistry.resolve !== undefined ? urlResolverRegistry.resolve(normalizedUrl, { projectPath }) : undefined) ?? null;
  if (!resolverResult) {
    return { ok: false, reason: 'not-files-url' };
  }
  if (!resolverResult.ok) {
    return { ok: false, reason: resolverResult.reason || 'resolve-failed' };
  }

  const fileKey = normalizeString(resolverResult.fileKey);
  if (!fileKey) {
    return { ok: false, reason: 'invalid-file-key' };
  }
  if (!isSafeFilesKey(fileKey)) {
    return { ok: false, reason: 'unsafe-file-key', fileKey };
  }

  const folderPaths = getProjectFolderPaths(projectPath);
  const mediaDir = (folderPaths !== null && folderPaths !== undefined ? folderPaths.media : undefined);
  if (!mediaDir) {
    return { ok: false, reason: 'missing-media-dir', fileKey };
  }

  const filePath = resolvePathWithin(mediaDir, fileKey);
  if (!filePath) {
    return { ok: false, reason: 'path-outside-media', fileKey, dir: mediaDir };
  }

  if (fs.existsSync(filePath)) {
    try {
      if (shell !== null && shell !== undefined && shell.showItemInFolder !== null && shell.showItemInFolder !== undefined) {
        shell.showItemInFolder(filePath);
      }
      return { ok: true, fileKey, dir: mediaDir, filePath };
    } catch {
      return { ok: false, reason: 'reveal-failed', fileKey, dir: mediaDir, filePath };
    }
  }

  if (isDirectory(mediaDir)) {
    try {
      if (shell !== null && shell !== undefined && shell.openPath !== null && shell.openPath !== undefined) {
        void shell.openPath(mediaDir)
          .then((err) => {
            if (err) {
              console.error('[desktop] open media dir failed', err);
            }
          })
          .catch((error) => {
            console.error('[desktop] open media dir failed', error);
          });
      }
    } catch (error) {
      console.error('[desktop] open media dir failed', error);
    }

    return { ok: false, reason: 'not-found', fileKey, dir: mediaDir, filePath };
  }

  return { ok: false, reason: 'dir-missing', fileKey, dir: mediaDir, filePath };
};

export { isSafeFilesKey, resolvePathWithin, pickProjectPath };
