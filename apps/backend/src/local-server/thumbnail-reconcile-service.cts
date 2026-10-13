import type { MediaAsset } from '@iart/contracts';

import { logDebug } from './logging.cts';
import {
  markProjectMediaAssetThumbnailStale,
  readAllRuntimeMediaAssets,
  readRuntimeMediaAssetById,
  reconcileProjectThumbnails as reconcileProjectThumbnailsInRegistry,
  repairProjectMediaAssetThumbnail,
  thumbnailFileExistsInProject,
} from './media-asset-registry.cts';
import {
  normalizeProjectMediaType,
  normalizeString,
} from './runtime-media-assets.cts';

const THUMBNAIL_REPAIR_CONCURRENCY = 2;

const scheduledProjectRepairState = new Map<string, { running: boolean; rerunRequested: boolean }>();

const downgradeAssetThumbnailIfCurrentUrlMatches = async (
  projectPath: string,
  asset: MediaAsset,
  thumbnailUrl: string | null,
) => {
  if (asset.mediaType !== 'image' && asset.mediaType !== 'video') {
    logDebug('[thumbnail-reconcile] skip report: unsupported media type', { projectPath, assetId: asset.id });
    return null;
  }
  const status = normalizeString((asset.thumbnail !== null && asset.thumbnail !== undefined ? asset.thumbnail.status : undefined)).toLowerCase();
  if (status !== 'ready' && status !== 'generating') {
    logDebug('[thumbnail-reconcile] skip report: thumbnail is already repairable', { projectPath, assetId: asset.id, status });
    return null;
  }
  const currentUrl = normalizeString((asset.thumbnail !== null && asset.thumbnail !== undefined ? asset.thumbnail.url : undefined));
  if (thumbnailUrl && currentUrl && currentUrl !== thumbnailUrl) {
    logDebug('[thumbnail-reconcile] skip report: url mismatch', { projectPath, assetId: asset.id });
    return null;
  }
  const staleResult = await markProjectMediaAssetThumbnailStale(projectPath, { assetId: asset.id });
  return (staleResult !== null && staleResult !== undefined ? staleResult.asset : undefined) ?? null;
};

const runProjectThumbnailRepairPass = async (projectPath: string) => {
  const normalizedProjectPath = normalizeString(projectPath);
  if (!normalizedProjectPath) {
    logDebug('[thumbnail-repair] skip pass: missing project path', undefined);
    return;
  }
  const mediaAssets = await readAllRuntimeMediaAssets(normalizedProjectPath);
  const candidates = mediaAssets.filter((asset) => {
    if (!(asset !== null && asset !== undefined ? asset.id : undefined)) {
      logDebug('[thumbnail-repair] skip candidate: missing asset id', { projectPath: normalizedProjectPath });
      return false;
    }
    if (asset.mediaType !== 'image' && asset.mediaType !== 'video') {
      logDebug('[thumbnail-repair] skip candidate: unsupported media type', {
        projectPath: normalizedProjectPath,
        assetId: asset.id,
        mediaType: asset.mediaType,
      });
      return false;
    }
    const status = normalizeString((asset.thumbnail !== null && asset.thumbnail !== undefined ? asset.thumbnail.status : undefined)).toLowerCase();
    if (status === 'ready') {
      const shouldRepairReady = !thumbnailFileExistsInProject(normalizedProjectPath, (asset.thumbnail !== null && asset.thumbnail !== undefined ? asset.thumbnail.url : undefined));
      if (!shouldRepairReady) {
        logDebug('[thumbnail-repair] skip candidate: ready thumbnail file exists', {
          projectPath: normalizedProjectPath,
          assetId: asset.id,
        });
      }
      return shouldRepairReady;
    }
    const shouldRepair = status === 'missing' || status === 'stale' || status === 'failed';
    if (!shouldRepair) {
      logDebug('[thumbnail-repair] skip candidate: status is not repairable', {
        projectPath: normalizedProjectPath,
        assetId: asset.id,
        status,
      });
    }
    return shouldRepair;
  });
  if (candidates.length <= 0) {
    logDebug('[thumbnail-repair] skip pass: no candidates', { projectPath: normalizedProjectPath });
    return;
  }

  let cursor = 0;
  const workerCount = Math.min(THUMBNAIL_REPAIR_CONCURRENCY, candidates.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < candidates.length) {
      const currentIndex = cursor;
      cursor += 1;
      const asset = candidates[currentIndex];
      if (asset === null || asset === undefined || !asset.id) continue;
      try {
        await repairProjectMediaAssetThumbnail(normalizedProjectPath, {
          assetId: asset.id,
          mediaType: asset.mediaType,
          maxEdge: undefined,
          quality: undefined,
          width: undefined,
          timeSec: undefined,
        });
      } catch {
        logDebug('[thumbnail-repair] candidate repair failed', { projectPath: normalizedProjectPath, assetId: asset.id });
      }
    }
  });
  await Promise.all(workers);
};

const scheduleProjectThumbnailRepair = (projectPath: unknown, reason: unknown = 'unspecified') => {
  const normalizedProjectPath = normalizeString(projectPath);
  const normalizedReason = normalizeString(reason) || 'unspecified';
  if (!normalizedProjectPath) {
    logDebug('[thumbnail-repair] skip schedule: missing project path', { reason: normalizedReason });
    return false;
  }
  const existing = scheduledProjectRepairState.get(normalizedProjectPath) || {
    running: false,
    rerunRequested: false,
  };
  if (existing.running) {
    existing.rerunRequested = true;
    scheduledProjectRepairState.set(normalizedProjectPath, existing);
    logDebug('[thumbnail-repair] schedule coalesced', { projectPath: normalizedProjectPath, reason: normalizedReason });
    return true;
  }
  existing.running = true;
  existing.rerunRequested = false;
  scheduledProjectRepairState.set(normalizedProjectPath, existing);
  logDebug('[thumbnail-repair] scheduled pass', { projectPath: normalizedProjectPath, reason: normalizedReason });
  setTimeout(async () => {
    const state = scheduledProjectRepairState.get(normalizedProjectPath);
    if (!state) return;
    try {
      do {
        state.rerunRequested = false;
        await runProjectThumbnailRepairPass(normalizedProjectPath);
      } while (state.rerunRequested);
    } catch {
      logDebug('[thumbnail-repair] scheduled pass failed', { projectPath: normalizedProjectPath });
    } finally {
      scheduledProjectRepairState.delete(normalizedProjectPath);
    }
  }, 0).unref();
  return true;
};

const reconcileProjectThumbnails = async (projectPath: unknown) => {
  const normalizedProjectPath = normalizeString(projectPath);
  return reconcileProjectThumbnailsInRegistry(normalizedProjectPath);
};

const reportMissingThumbnailByUrl = async (projectPath: unknown, thumbnailUrl: unknown) => {
  const normalizedProjectPath = normalizeString(projectPath);
  const normalizedThumbnailUrl = normalizeString(thumbnailUrl);
  if (!normalizedProjectPath || !normalizedThumbnailUrl) {
    logDebug('[thumbnail-reconcile] skip report by url: missing project or url', undefined);
    return { accepted: false, scheduled: false, downgradedAssetIds: [] };
  }
  const mediaAssets = await readAllRuntimeMediaAssets(normalizedProjectPath);
  const downgradedAssetIds: string[] = [];
  for (const asset of mediaAssets) {
    if (!(asset !== null && asset !== undefined ? asset.id : undefined) || normalizeString((asset.thumbnail !== null && asset.thumbnail !== undefined ? asset.thumbnail.url : undefined)) !== normalizedThumbnailUrl) continue;
    const downgraded = await downgradeAssetThumbnailIfCurrentUrlMatches(normalizedProjectPath, asset, normalizedThumbnailUrl);
    if (downgraded !== null && downgraded !== undefined && downgraded.id) downgradedAssetIds.push(downgraded.id);
  }
  const scheduled = downgradedAssetIds.length > 0
    ? scheduleProjectThumbnailRepair(normalizedProjectPath, 'thumbnail_report_missing_url')
    : false;
  return { accepted: true, scheduled, downgradedAssetIds };
};

const reportThumbnailRenderFailure = async (
  projectPath: unknown,
  params: { assetId: unknown | undefined; mediaType: unknown | undefined; failedUrl: unknown | undefined } = { assetId: undefined, mediaType: undefined, failedUrl: undefined },
) => {
  const normalizedProjectPath = normalizeString(projectPath);
  const assetId = normalizeString(params.assetId);
  if (!normalizedProjectPath || !assetId) {
    logDebug('[thumbnail-reconcile] skip render failure report: missing project or asset', undefined);
    return { accepted: false, scheduled: false, downgradedAssetIds: [] };
  }
  const asset = await readRuntimeMediaAssetById(normalizedProjectPath, assetId);
  if (asset === null || asset === undefined || !asset.id) {
    logDebug('[thumbnail-reconcile] skip render failure report: asset not found', { projectPath: normalizedProjectPath, assetId });
    return { accepted: false, scheduled: false, downgradedAssetIds: [] };
  }
  const expectedMediaType = normalizeProjectMediaType(params.mediaType);
  if (expectedMediaType && asset.mediaType !== expectedMediaType) {
    logDebug('[thumbnail-reconcile] skip render failure report: media type mismatch', { projectPath: normalizedProjectPath, assetId });
    return { accepted: false, scheduled: false, downgradedAssetIds: [] };
  }
  const downgraded = await downgradeAssetThumbnailIfCurrentUrlMatches(
    normalizedProjectPath,
    asset,
    normalizeString(params.failedUrl) || null,
  );
  const downgradedAssetIds = (downgraded !== null && downgraded !== undefined && downgraded.id) ? [downgraded.id] : [];
  const scheduled = downgradedAssetIds.length > 0
    ? scheduleProjectThumbnailRepair(normalizedProjectPath, 'thumbnail_render_failure')
    : false;
  return { accepted: true, scheduled, downgradedAssetIds };
};

export {
  reconcileProjectThumbnails,
  reportMissingThumbnailByUrl,
  reportThumbnailRenderFailure,
  runProjectThumbnailRepairPass,
  scheduleProjectThumbnailRepair,
};
