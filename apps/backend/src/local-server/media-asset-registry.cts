import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import type {
  MediaAsset,
  MediaAssetThumbnailError,
} from '@iart/contracts';
import {
  executeImageThumbnail,
  executeVideoThumbnail,
} from './media-processing-actions.cts';
import {
  readProjectImageDimensions,
  resolveFilesUrlToFilePathInProject,
} from './image-processing.cts';
import { resolveExecutablePath } from './executable-path.cts';
import { logDebug } from './logging.cts';
import mediaFileKeyModule = require('@iart/utils/media-file-key');
import mediaConstantsModule = require('@iart/utils/media-constants');
import {
  createThumbnailError,
  normalizeDimension,
  normalizeFiniteNumber,
  normalizeProjectMediaType,
  normalizeString,
  parseRuntimeMediaAssetRowToMediaAsset,
  persistRuntimeMediaAsset,
  readAllRuntimeMediaAssets,
  readRuntimeMediaAssetById,
} from './runtime-media-assets.cts';

type ThumbnailExecutionResult = {
  success: unknown | undefined;
  url: unknown | undefined;
  meta: {
    thumbnailWidth: unknown | undefined;
    thumbnailHeight: unknown | undefined;
  } | undefined;
};

const requireOptional = createRequire(__filename);
let ffmpegStaticPath: string | null = null;
try {
  const resolvedFfmpegStaticPath: unknown = requireOptional('ffmpeg-static');
  ffmpegStaticPath = typeof resolvedFfmpegStaticPath === 'string' ? resolvedFfmpegStaticPath.trim() || null : null;
} catch {
  ffmpegStaticPath = null;
}

const THUMBNAIL_GENERATING_STALE_AFTER_MS = 10 * 60 * 1000;
const VIDEO_DIMENSION_REGEX = /(?:^|,|\s)(\d{1,5})x(\d{1,5})(?:[,\s]|$)/;
const VIDEO_FPS_REGEX = /(\d+(?:\.\d+)?)\s*(?:fps|tbr)|(\d+)\/(\d+)\s*(?:fps|tbr)/;
const inflightThumbnailRepairs = new Map<string, Promise<unknown>>();

const buildThumbnailRepairKey = (projectPath: string, assetId: string) => `${projectPath}::${assetId}`;

const hasErrorCode = (value: unknown): value is { code: unknown | undefined } =>
  Boolean(value && typeof value === 'object' && 'code' in value);

const hasErrorMessage = (value: unknown): value is { message: unknown | undefined } =>
  Boolean(value && typeof value === 'object' && 'message' in value);


const buildThumbnailError = (params: { code: unknown | undefined; message: unknown | undefined; failedAt: unknown | undefined }): MediaAssetThumbnailError => ({
  code: normalizeString(params.code) || 'thumbnail_failed',
  message: normalizeString(params.message) || 'Thumbnail generation failed',
  failedAt: normalizeFiniteNumber(params.failedAt, Date.now()),
});

const throwThumbnailStatePersistError = (code = 'thumbnail_formal_state_persist_failed'): never => {
  throw createThumbnailError(code, code, 500);
};

const resolveImageOriginalDimensions = (
  projectPath: string,
  params: { mediaType: unknown | undefined; url: unknown | undefined; width: unknown | undefined; height: unknown | undefined } = { mediaType: undefined, url: undefined, width: undefined, height: undefined },
) => {
  if (normalizeProjectMediaType(params.mediaType) !== 'image') return { width: null, height: null };
  const explicitWidth = normalizeDimension(params.width);
  const explicitHeight = normalizeDimension(params.height);
  if (explicitWidth && explicitHeight) return { width: explicitWidth, height: explicitHeight };
  const url = normalizeString(params.url);
  if (!projectPath || !url) return { width: explicitWidth, height: explicitHeight };
  const measured = readProjectImageDimensions(projectPath, url);
  return {
    width: explicitWidth ?? (measured !== null && measured !== undefined ? measured.width : undefined) ?? null,
    height: explicitHeight ?? (measured !== null && measured !== undefined ? measured.height : undefined) ?? null,
  };
};

const parseFpsFromFfmpegOutput = (text: string): number | undefined => {
  const match = VIDEO_FPS_REGEX.exec(text);
  if (!match) return undefined;
  if (match[2] !== undefined && match[3] !== undefined) {
    const numerator = parseFloat(match[2]);
    const denominator = parseFloat(match[3]);
    if (denominator === 0 || !Number.isFinite(numerator) || !Number.isFinite(denominator)) return undefined;
    return numerator / denominator;
  }
  if (match[1] !== undefined) {
    const value = parseFloat(match[1]);
    return Number.isFinite(value) ? value : undefined;
  }
  return undefined;
};

const resolveVideoMetadata = (
  projectPath: string,
  params: { mediaType: unknown | undefined; url: unknown | undefined; width: unknown | undefined; height: unknown | undefined } = { mediaType: undefined, url: undefined, width: undefined, height: undefined },
) => {
  if (normalizeProjectMediaType(params.mediaType) !== 'video') return { width: null, height: null, fps: undefined as number | undefined };
  const explicitWidth = normalizeDimension(params.width);
  const explicitHeight = normalizeDimension(params.height);
  if (explicitWidth && explicitHeight) return { width: explicitWidth, height: explicitHeight, fps: undefined as number | undefined };

  const normalizedProjectPath = normalizeString(projectPath);
  const url = normalizeString(params.url);
  if (!normalizedProjectPath || !url) return { width: explicitWidth, height: explicitHeight, fps: undefined as number | undefined };

  const resolved = resolveFilesUrlToFilePathInProject(normalizedProjectPath, url);
  const filePath = normalizeString((resolved !== null && resolved !== undefined ? resolved.filePath : undefined));
  const ffmpegPath = resolveExecutablePath(ffmpegStaticPath);
  if (!filePath || !ffmpegPath) return { width: explicitWidth, height: explicitHeight, fps: undefined as number | undefined };

  try {
    const result = spawnSync(ffmpegPath, ['-hide_banner', '-i', filePath], {
      encoding: 'utf-8',
      windowsHide: true,
    });
    const stderr = normalizeString(result.stderr);
    const stdout = normalizeString(result.stdout);
    const output = stderr || stdout;
    const dimMatch = VIDEO_DIMENSION_REGEX.exec(output);
    const fps = parseFpsFromFfmpegOutput(output);
    return {
      width: explicitWidth ?? normalizeDimension((dimMatch !== null && dimMatch !== undefined ? dimMatch[1] : undefined)),
      height: explicitHeight ?? normalizeDimension((dimMatch !== null && dimMatch !== undefined ? dimMatch[2] : undefined)),
      fps,
    };
  } catch {
    return { width: explicitWidth, height: explicitHeight, fps: undefined as number | undefined };
  }
};

const updateThumbnailState = async (
  projectPath: unknown,
  params: { assetId: unknown | undefined },
  updater: (targetAsset: MediaAsset, now: number) => MediaAsset,
) => {
  const normalizedProjectPath = normalizeString(projectPath);
  const assetId = normalizeString(params.assetId);
  if (!normalizedProjectPath || !assetId) return null;

  const targetAsset = await readRuntimeMediaAssetById(normalizedProjectPath, assetId);
  if (targetAsset === null || targetAsset === undefined) return null;
  if (!targetAsset.id) return null;

  const originalDimensions =
    targetAsset.mediaType === 'image'
      ? resolveImageOriginalDimensions(normalizedProjectPath, {
          mediaType: targetAsset.mediaType,
          url: (targetAsset.original !== null && targetAsset.original !== undefined ? targetAsset.original.url : undefined),
          width: (targetAsset.original !== null && targetAsset.original !== undefined ? targetAsset.original.width : undefined),
          height: (targetAsset.original !== null && targetAsset.original !== undefined ? targetAsset.original.height : undefined),
        })
      : resolveVideoMetadata(normalizedProjectPath, {
          mediaType: targetAsset.mediaType,
          url: (targetAsset.original !== null && targetAsset.original !== undefined ? targetAsset.original.url : undefined),
          width: (targetAsset.original !== null && targetAsset.original !== undefined ? targetAsset.original.width : undefined),
          height: (targetAsset.original !== null && targetAsset.original !== undefined ? targetAsset.original.height : undefined),
        });

  const originalFps = ('fps' in originalDimensions && typeof originalDimensions.fps === 'number')
    ? originalDimensions.fps
    : undefined;
  const targetAssetWithDimensions: MediaAsset = {
    ...targetAsset,
    original: {
      ...targetAsset.original,
      ...(originalDimensions.width ? { width: originalDimensions.width } : {}),
      ...(originalDimensions.height ? { height: originalDimensions.height } : {}),
      ...(originalFps !== undefined ? { fps: originalFps } : {}),
    },
  };
  const now = Date.now();
  const nextAsset = updater(targetAssetWithDimensions, now);
  if (!(nextAsset !== null && nextAsset !== undefined ? nextAsset.id : undefined)) return null;
  const persisted = await persistRuntimeMediaAsset(normalizedProjectPath, nextAsset);
  if (!persisted) return null;

  const mediaAssets = { [nextAsset.id]: nextAsset };
  return {
    assetId: nextAsset.id,
    asset: nextAsset,
    mediaAssets,
  };
};

const markProjectMediaAssetThumbnailGenerating = async (
  projectPath: unknown,
  params: { assetId: unknown | undefined } = { assetId: undefined },
) =>
  updateThumbnailState(projectPath, params, (targetAsset, now) => ({
    ...targetAsset,
    thumbnail: {
      ...targetAsset.thumbnail,
      status: 'generating',
      error: null,
    },
    lifecycle: { createdAt: (targetAsset.lifecycle !== null && targetAsset.lifecycle !== undefined ? targetAsset.lifecycle.createdAt : undefined) ?? now, updatedAt: now },
  }));

const markProjectMediaAssetThumbnailReady = async (
  projectPath: unknown,
  params: {
    assetId: unknown | undefined;
    thumbnailUrl: unknown | undefined;
    mimeType: unknown | undefined;
    width: unknown | undefined;
    height: unknown | undefined;
    generatedAt: unknown | undefined;
  } = { assetId: undefined, thumbnailUrl: undefined, mimeType: undefined, width: undefined, height: undefined, generatedAt: undefined },
) => {
  const thumbnailUrl = normalizeString(params.thumbnailUrl);
  if (!thumbnailUrl) return null;
  return updateThumbnailState(projectPath, params, (targetAsset, now) => ({
    ...targetAsset,
    thumbnail: {
      url: thumbnailUrl,
      mimeType: normalizeString(params.mimeType) || normalizeString((targetAsset.thumbnail !== null && targetAsset.thumbnail !== undefined ? targetAsset.thumbnail.mimeType : undefined)) || null,
      width: normalizeFiniteNumber(params.width, (targetAsset.thumbnail !== null && targetAsset.thumbnail !== undefined ? targetAsset.thumbnail.width : undefined) ?? null),
      height: normalizeFiniteNumber(params.height, (targetAsset.thumbnail !== null && targetAsset.thumbnail !== undefined ? targetAsset.thumbnail.height : undefined) ?? null),
      status: 'ready',
      generatedAt: normalizeFiniteNumber(params.generatedAt, now),
      error: null,
    },
    lifecycle: { createdAt: (targetAsset.lifecycle !== null && targetAsset.lifecycle !== undefined ? targetAsset.lifecycle.createdAt : undefined) ?? now, updatedAt: now },
  }));
};

const markProjectMediaAssetThumbnailFailed = async (
  projectPath: unknown,
  params: { assetId: unknown | undefined; code: unknown | undefined; message: unknown | undefined; failedAt: unknown | undefined } = { assetId: undefined, code: undefined, message: undefined, failedAt: undefined },
) =>
  updateThumbnailState(projectPath, params, (targetAsset, now) => ({
    ...targetAsset,
    thumbnail: {
      ...targetAsset.thumbnail,
      status: 'failed',
      error: buildThumbnailError(params),
    },
    lifecycle: { createdAt: (targetAsset.lifecycle !== null && targetAsset.lifecycle !== undefined ? targetAsset.lifecycle.createdAt : undefined) ?? now, updatedAt: now },
  }));

const markProjectMediaAssetThumbnailStale = async (
  projectPath: unknown,
  params: { assetId: unknown | undefined } = { assetId: undefined },
) =>
  updateThumbnailState(projectPath, params, (targetAsset, now) => ({
    ...targetAsset,
    thumbnail: {
      ...targetAsset.thumbnail,
      status: 'stale',
      error: null,
    },
    lifecycle: { createdAt: (targetAsset.lifecycle !== null && targetAsset.lifecycle !== undefined ? targetAsset.lifecycle.createdAt : undefined) ?? now, updatedAt: now },
  }));

const resolveThumbnailDimensions = (result: ThumbnailExecutionResult) => ({
  width: normalizeDimension((result.meta !== null && result.meta !== undefined ? result.meta.thumbnailWidth : undefined)),
  height: normalizeDimension((result.meta !== null && result.meta !== undefined ? result.meta.thumbnailHeight : undefined)),
});

const thumbnailFileExistsInProject = (projectPath: string, thumbnailUrl: unknown) => {
  const normalizedProjectPath = normalizeString(projectPath);
  const normalizedThumbnailUrl = normalizeString(thumbnailUrl);
  if (!normalizedProjectPath || !normalizedThumbnailUrl) {
    logDebug('[thumbnail-reconcile] skip file existence check: missing project or url', {
      hasProjectPath: Boolean(normalizedProjectPath),
      hasThumbnailUrl: Boolean(normalizedThumbnailUrl),
    });
    return false;
  }
  const resolved = resolveFilesUrlToFilePathInProject(normalizedProjectPath, normalizedThumbnailUrl);
  const filePath = resolved !== null && resolved !== undefined ? resolved.filePath : undefined;
  return Boolean(filePath && fs.existsSync(filePath));
};

const isThumbnailGeneratingExpired = (asset: MediaAsset, now: number) => {
  const updatedAt = normalizeFiniteNumber((asset.lifecycle !== null && asset.lifecycle !== undefined ? asset.lifecycle.updatedAt : undefined), null);
  return typeof updatedAt === 'number' && now - updatedAt > THUMBNAIL_GENERATING_STALE_AFTER_MS;
};

const repairMissingReadyThumbnailState = async (projectPath: string, asset: MediaAsset | null) => {
  if (asset === null || asset === undefined) {
    logDebug('[thumbnail-reconcile] skip ready repair: missing asset', { projectPath });
    return asset;
  }
  if (!(asset !== null && asset !== undefined ? asset.id : undefined)) {
    logDebug('[thumbnail-reconcile] skip ready repair: missing asset id', { projectPath });
    return asset;
  }
  const status = normalizeString((asset.thumbnail !== null && asset.thumbnail !== undefined ? asset.thumbnail.status : undefined)).toLowerCase();
  if (status !== 'ready') {
    logDebug('[thumbnail-reconcile] skip ready repair: thumbnail is not ready', {
      projectPath,
      assetId: asset.id,
      status,
    });
    return asset;
  }
  if (thumbnailFileExistsInProject(projectPath, (asset.thumbnail !== null && asset.thumbnail !== undefined ? asset.thumbnail.url : undefined))) {
    logDebug('[thumbnail-reconcile] skip ready repair: thumbnail file exists', {
      projectPath,
      assetId: asset.id,
    });
    return asset;
  }
  const repaired = await markProjectMediaAssetThumbnailStale(projectPath, { assetId: asset.id });
  return (repaired !== null && repaired !== undefined ? repaired.asset : undefined) ?? asset;
};

const reconcileProjectThumbnails = async (projectPath: string) => {
  const normalizedProjectPath = normalizeString(projectPath);
  if (!normalizedProjectPath) {
    logDebug('[thumbnail-reconcile] skip project reconcile: missing project path', undefined);
    return { projectPath: normalizedProjectPath, downgradedAssetIds: [] };
  }

  const downgradedAssetIds: string[] = [];
  const mediaAssets = await readAllRuntimeMediaAssets(normalizedProjectPath);
  const now = Date.now();
  for (const asset of mediaAssets) {
    if (!(asset !== null && asset !== undefined ? asset.id : undefined)) {
      logDebug('[thumbnail-reconcile] skip project asset: missing asset id', { projectPath: normalizedProjectPath });
      continue;
    }
    const status = normalizeString((asset.thumbnail !== null && asset.thumbnail !== undefined ? asset.thumbnail.status : undefined)).toLowerCase();
    let downgraded: MediaAsset | null = asset;
    if (status === 'ready') {
      downgraded = await repairMissingReadyThumbnailState(normalizedProjectPath, asset);
    } else if (status === 'generating' && isThumbnailGeneratingExpired(asset, now)) {
      const staleResult = await markProjectMediaAssetThumbnailStale(normalizedProjectPath, { assetId: asset.id });
      downgraded = (staleResult !== null && staleResult !== undefined ? staleResult.asset : undefined) ?? asset;
    } else {
      logDebug('[thumbnail-reconcile] skip project asset: no reconcile action', {
        projectPath: normalizedProjectPath,
        assetId: asset.id,
        status,
      });
    }
    if (status === 'ready' && normalizeString((downgraded !== null && downgraded !== undefined && downgraded.thumbnail !== null && downgraded.thumbnail !== undefined ? downgraded.thumbnail.status : undefined)).toLowerCase() !== 'ready') {
      downgradedAssetIds.push(asset.id);
    }
    if (status === 'generating' && normalizeString((downgraded !== null && downgraded !== undefined && downgraded.thumbnail !== null && downgraded.thumbnail !== undefined ? downgraded.thumbnail.status : undefined)).toLowerCase() === 'stale') {
      downgradedAssetIds.push(asset.id);
    }
  }
  return { projectPath: normalizedProjectPath, downgradedAssetIds };
};

const precleanProjectMissingReadyThumbnails = reconcileProjectThumbnails;

const repairProjectMediaAssetThumbnail = async (
  projectPath: unknown,
  params: {
    assetId: unknown | undefined;
    mediaType: unknown | undefined;
    maxEdge: unknown | undefined;
    quality: unknown | undefined;
    width: unknown | undefined;
    timeSec: unknown | undefined;
  } = { assetId: undefined, mediaType: undefined, maxEdge: undefined, quality: undefined, width: undefined, timeSec: undefined },
) => {
  const normalizedProjectPath = normalizeString(projectPath);
  if (!normalizedProjectPath) throw createThumbnailError('invalid_project_path', 'invalid_project_path', 400);

  const assetId = normalizeString(params.assetId);
  if (!assetId) throw createThumbnailError('missing_media_asset_id', 'missing_media_asset_id', 400);

  let target = await readRuntimeMediaAssetById(normalizedProjectPath, assetId);
  if (target === null || target === undefined || !target.id || !target.original || !target.original.url) {
    throw createThumbnailError('media_asset_not_found', 'media_asset_not_found', 404);
  }

  const expectedMediaType = normalizeProjectMediaType(params.mediaType);
  if (expectedMediaType && target.mediaType !== expectedMediaType) {
    throw createThumbnailError('media_asset_type_mismatch', 'media_asset_type_mismatch', 400);
  }
  if (target.mediaType !== 'image' && target.mediaType !== 'video') {
    throw createThumbnailError(`unsupported_media_type:${target.mediaType}`, `unsupported_media_type:${target.mediaType}`, 400);
  }

  target = await repairMissingReadyThumbnailState(normalizedProjectPath, target);
  if (target === null || target === undefined || !target.id || !target.original || !target.original.url) {
    throw createThumbnailError('media_asset_not_found', 'media_asset_not_found', 404);
  }

  if (!target.original.url.startsWith(mediaConstantsModule.LOCAL_MEDIA_SCHEME)) {
    throw createThumbnailError(
      'invalid_url_form',
      `Media asset URL must be local-media:// form, got: ${target.original.url.slice(0, 100)}`,
      400,
    );
  }
  const localMediaFileKey = mediaFileKeyModule.extractMediaFileKey(target.original.url);
  if (!localMediaFileKey) {
    throw createThumbnailError(
      'invalid_url_form',
      `Failed to extract media file key from URL: ${target.original.url.slice(0, 100)}`,
      400,
    );
  }
  const localFilePath = path.join(normalizedProjectPath, 'media', localMediaFileKey);
  if (!fs.existsSync(localFilePath)) {
    throw createThumbnailError('file_not_found', `Local media file not found: ${localMediaFileKey}`, 404);
  }

  const repairTarget = { ...target };
  const repairKey = buildThumbnailRepairKey(normalizedProjectPath, repairTarget.id);
  const existingRepair = inflightThumbnailRepairs.get(repairKey);
  if (existingRepair) return await existingRepair;

  const repairPromise = (async () => {
    const generating = await markProjectMediaAssetThumbnailGenerating(normalizedProjectPath, {
      assetId: repairTarget.id,
    });
    if (!(generating !== null && generating !== undefined ? generating.assetId : undefined) || !(generating !== null && generating !== undefined ? generating.asset : undefined)) throwThumbnailStatePersistError();

    try {
      const result =
        repairTarget.mediaType === 'image'
          ? await executeImageThumbnail({
              projectPath: normalizedProjectPath,
              sourceUrl: repairTarget.original.url,
              maxEdge: params.maxEdge,
              quality: params.quality,
            })
          : await executeVideoThumbnail({
              projectPath: normalizedProjectPath,
              sourceUrl: repairTarget.original.url,
              width: params.width,
              quality: params.quality,
              timeSec: params.timeSec,
            });
      const dimensions = resolveThumbnailDimensions(result);
      const ready = await markProjectMediaAssetThumbnailReady(normalizedProjectPath, {
        assetId: repairTarget.id,
        thumbnailUrl: normalizeString(result.url),
        mimeType: repairTarget.mediaType === 'image' ? 'image/webp' : 'image/jpeg',
        width: dimensions.width,
        height: dimensions.height,
        generatedAt: Date.now(),
      });
      const readyAssetId = normalizeString((ready !== null && ready !== undefined ? ready.assetId : undefined));
      const readyAsset = (ready !== null && ready !== undefined ? ready.asset : undefined) ?? null;
      if (!readyAssetId || !readyAsset) throwThumbnailStatePersistError();
      return { assetId: readyAssetId, asset: readyAsset, result };
    } catch (error) {
      const code = hasErrorCode(error) ? normalizeString(error.code) || 'thumbnail_failed' : 'thumbnail_failed';
      const message = hasErrorMessage(error)
        ? normalizeString(error.message) || 'Thumbnail generation failed'
        : 'Thumbnail generation failed';
      const failed = await markProjectMediaAssetThumbnailFailed(normalizedProjectPath, {
        assetId: repairTarget.id,
        code,
        message,
        failedAt: Date.now(),
      });
      if (!(failed !== null && failed !== undefined ? failed.assetId : undefined) || !(failed !== null && failed !== undefined ? failed.asset : undefined)) throwThumbnailStatePersistError();
      throw error;
    }
  })();

  inflightThumbnailRepairs.set(repairKey, repairPromise);
  try {
    return await repairPromise;
  } finally {
    inflightThumbnailRepairs.delete(repairKey);
  }
};

export {
  markProjectMediaAssetThumbnailGenerating,
  markProjectMediaAssetThumbnailReady,
  markProjectMediaAssetThumbnailFailed,
  markProjectMediaAssetThumbnailStale,
  parseRuntimeMediaAssetRowToMediaAsset,
  precleanProjectMissingReadyThumbnails,
  reconcileProjectThumbnails,
  readAllRuntimeMediaAssets,
  readRuntimeMediaAssetById,
  repairProjectMediaAssetThumbnail,
  repairMissingReadyThumbnailState,
  resolveVideoMetadata,
  thumbnailFileExistsInProject,
};
