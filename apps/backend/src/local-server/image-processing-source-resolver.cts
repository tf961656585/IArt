import * as fs from 'node:fs';

import mediaConstants = require('@iart/utils/media-constants');
import mediaFileKeyModule = require('@iart/utils/media-file-key');
import * as loggingModule from './logging.cts';
import * as projectMediaScopeModule from './project-media-scope.cts';
import * as safePathModule from './safe-path.cts';
import * as storageModule from './storage.cts';

type ImageProcessingSourceResolveError = Error & {
  code: string;
  status: number;
};

type ResolvedImageProcessingSource = {
  projectPath: string;
  sourceUrl: string;
  sourceFileKey: string;
  sourceFilePath: string;
  mediaDir: string;
};

const LOCAL_MEDIA_GLOBAL_REF = mediaConstants.LOCAL_MEDIA_GLOBAL_REF;

const {
  getGlobalMediaDir,
  isSafeProjectMediaFileKey,
} = projectMediaScopeModule;
const { safeJoin } = safePathModule;
const { getProjectFolderPaths } = storageModule;
const { logDebug } = loggingModule;

const normalizeString = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : '';

const createImageProcessingSourceError = (
  code: string,
  message: string,
  status = 400,
): ImageProcessingSourceResolveError => {
  const error = new Error(message) as ImageProcessingSourceResolveError;
  error.code = code;
  error.status = status;
  return error;
};

const stripUrlSuffix = (value: string) => {
  const queryIndex = value.indexOf('?');
  const hashIndex = value.indexOf('#');
  const cutIndexes = [queryIndex, hashIndex].filter((index) => index >= 0);
  if (cutIndexes.length === 0) return value;
  return value.slice(0, Math.min(...cutIndexes));
};

/**
 * Parse a `local-media://{scope}/{fileKey}` URL into its parts.
 * Returns `{ scope, fileKey }` or `null` if the URL is not a valid local-media URL
 * with a scope segment.
 *
 * 复用 @iart/utils/media-file-key 的 parseLocalMediaUrl 单一解析入口，
 * 认 V1（prj_）、V2（spid_）、global（__global__）三种 scope。
 */
const parseLocalMediaUrlParts = (sourceUrl: string): {
  scope: string;
  fileKey: string;
} | null => {
  const parsed = mediaFileKeyModule.parseLocalMediaUrl(stripUrlSuffix(sourceUrl));
  if (parsed === null || parsed.scope === null) return null;
  return { scope: parsed.scope, fileKey: parsed.fileKey };
};

const isRemoteHttpUrl = (sourceUrl: string) => /^https?:\/\//i.test(sourceUrl);

/**
 * Resolve a `local-media://` URL to a file path on disk.
 * Extracts scope and fileKey from the URL, looks up the corresponding
 * projectPath or global mediaDir, and joins with fileKey.
 */
const resolveLocalMediaSource = (sourceUrl: string) => {
  const parts = parseLocalMediaUrlParts(sourceUrl);
  if (!parts) return null;

  const { scope, fileKey } = parts;

  // __global__ scope: mediaDir is stored via registerGlobalMediaScope
  if (scope === LOCAL_MEDIA_GLOBAL_REF) {
    const mediaDir = getGlobalMediaDir();
    if (!mediaDir) return null;
    return {
      projectPath: mediaDir,
      fileKey,
      filePath: safeJoin(mediaDir, fileKey),
      mediaDir,
    };
  }

  // Normal project scope: resolve projectPath → mediaDir（V2 spid_ 或 V1 prj_）
  const resolvedProjectPath = projectMediaScopeModule.resolveRuntimeProjectPathByRef(scope);
  if (!resolvedProjectPath) return null;

  const folderPaths = getProjectFolderPaths(resolvedProjectPath);
  const mediaDir = (folderPaths !== null && folderPaths !== undefined ? folderPaths.media : undefined) ?? '';
  if (!mediaDir) return null;

  return {
    projectPath: resolvedProjectPath,
    fileKey,
    filePath: safeJoin(mediaDir, fileKey),
    mediaDir,
  };
};

const resolveImageProcessingSource = (
  _projectPathInput: unknown,
  sourceUrlInput: unknown,
): ResolvedImageProcessingSource => {
  const sourceUrl = normalizeString(sourceUrlInput);
  if (!sourceUrl) {
    logDebug('[image-processing-source] missing source url', undefined);
    throw createImageProcessingSourceError('INVALID_URL', 'Missing source url', 400);
  }
  if (isRemoteHttpUrl(sourceUrl)) {
    logDebug('[image-processing-source] reject remote image processing source', { sourceUrl });
    throw createImageProcessingSourceError(
      'REMOTE_NOT_SUPPORTED',
      'Remote URLs are not supported for local image processing; localize media first',
      400,
    );
  }

  const resolved = resolveLocalMediaSource(sourceUrl);

  if (!resolved || !resolved.fileKey || !resolved.filePath || !resolved.mediaDir || !resolved.projectPath) {
    logDebug('[image-processing-source] unsupported source url', { sourceUrl });
    throw createImageProcessingSourceError('INVALID_URL', 'Unsupported image processing source url; only local-media:// URLs are accepted', 400);
  }

  if (!isSafeProjectMediaFileKey(resolved.fileKey)) {
    logDebug('[image-processing-source] reject unsafe source file key', {
      sourceUrl,
      fileKey: resolved.fileKey,
    });
    throw createImageProcessingSourceError('INVALID_FILE_KEY', 'Invalid source file key', 400);
  }

  if (!fs.existsSync(resolved.filePath)) {
    logDebug('[image-processing-source] source file not found', {
      sourceUrl,
      fileKey: resolved.fileKey,
      filePath: resolved.filePath,
    });
    throw createImageProcessingSourceError('FILE_NOT_FOUND', 'Source file not found', 404);
  }

  try {
    if (!fs.statSync(resolved.filePath).isFile()) {
      logDebug('[image-processing-source] source path is not a file', {
        sourceUrl,
        fileKey: resolved.fileKey,
      });
      throw createImageProcessingSourceError('FILE_NOT_FOUND', 'Source file not found', 404);
    }
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error) {
      throw error;
    }
    logDebug('[image-processing-source] source stat failed', {
      sourceUrl,
      fileKey: resolved.fileKey,
    });
    throw createImageProcessingSourceError('FILE_NOT_FOUND', 'Source file not found', 404);
  }

  return {
    projectPath: resolved.projectPath,
    sourceUrl,
    sourceFileKey: resolved.fileKey,
    sourceFilePath: resolved.filePath,
    mediaDir: resolved.mediaDir,
  };
};

export {
  type ResolvedImageProcessingSource,
  createImageProcessingSourceError,
  resolveImageProcessingSource,
};
