import type {
  MediaAsset,
  ProjectMediaType,
  RuntimeMediaAssetRow,
} from '@iart/contracts';
import {
  mediaAssetToRuntimeMediaAssetRow,
  runtimeMediaAssetRowToView,
  runtimeMediaAssetViewToMediaAsset,
} from '@iart/contracts';
import {
  sendMediaAssetsChangedNotification,
  sendReadAllMediaAssets,
  sendReadMediaAssetById,
  sendRuntimeTransaction,
} from './backend-ipc-sender.cts';
import * as loggingModule from './logging.cts';
import {
  asUnknownObject,
  readUnknownField,
} from './unknown-object.cts';

type ThumbnailError = Error & {
  code: string | undefined;
  status: number | undefined;
};

const normalizeString = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

const normalizeFiniteNumber = <TFallback,>(value: unknown, fallback: TFallback): number | TFallback => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return fallback;
};

const normalizeDimension = (value: unknown) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const rounded = Math.round(numeric);
  return rounded > 0 ? rounded : null;
};

const normalizeProjectMediaType = (value: unknown): ProjectMediaType | null => {
  const normalized = normalizeString(value).toLowerCase();
  if (normalized === 'image' || normalized === 'video' || normalized === 'audio') return normalized as ProjectMediaType;
  return null;
};

const createThumbnailError = (code: string, message = code, status = 500): ThumbnailError => {
  const error = new Error(message) as ThumbnailError;
  error.code = code;
  error.status = status;
  return error;
};

const parseRuntimeMediaAssetRowToMediaAsset = (row: unknown): MediaAsset | null => {
  const direct = runtimeMediaAssetViewToMediaAsset(row);
  if (direct) return direct;
  const view = runtimeMediaAssetRowToView(row, {
    now: undefined,
    onIssue: (issue) => {
      loggingModule.logWarn('[runtime-media-assets] failed to hydrate media asset row', { issue });
    },
  });
  return view ? runtimeMediaAssetViewToMediaAsset(view) : null;
};

const readRuntimeMediaAssetById = async (projectPath: unknown, assetId: unknown) => {
  const normalizedProjectPath = normalizeString(projectPath);
  const normalizedAssetId = normalizeString(assetId);
  if (!normalizedProjectPath || !normalizedAssetId) return null;
  const result = await sendReadMediaAssetById({ projectPath: normalizedProjectPath, assetId: normalizedAssetId });
  if (!(result !== null && result !== undefined ? result.success : undefined)) {
    throw createThumbnailError('runtime_media_asset_read_failed', normalizeString((result !== null && result !== undefined ? result.error : undefined)) || 'runtime_media_asset_read_failed', 500);
  }
  return parseRuntimeMediaAssetRowToMediaAsset(result.data);
};

const readAllRuntimeMediaAssets = async (projectPath: unknown) => {
  const normalizedProjectPath = normalizeString(projectPath);
  if (!normalizedProjectPath) return [];
  const result = await sendReadAllMediaAssets({ projectPath: normalizedProjectPath });
  if (!(result !== null && result !== undefined ? result.success : undefined)) {
    throw createThumbnailError('runtime_media_asset_read_failed', normalizeString((result !== null && result !== undefined ? result.error : undefined)) || 'runtime_media_asset_read_failed', 500);
  }
  const dataRecord = asUnknownObject(result.data);
  const mediaAssetsField =
    dataRecord !== null ? readUnknownField(dataRecord, 'mediaAssets') : undefined;
  const rows = Array.isArray(result.data)
    ? result.data
    : Array.isArray(mediaAssetsField)
      ? mediaAssetsField
      : [];
  return (rows as unknown[])
    .map((row: unknown) => parseRuntimeMediaAssetRowToMediaAsset(row))
    .filter((asset: unknown): asset is MediaAsset => Boolean(asset));
};

const buildRuntimeMediaAssetRow = (asset: MediaAsset): RuntimeMediaAssetRow | null =>
  mediaAssetToRuntimeMediaAssetRow(asset);

const persistRuntimeMediaAsset = async (projectPath: string, asset: MediaAsset) => {
  const runtimeMediaAsset = buildRuntimeMediaAssetRow(asset);
  if (!projectPath || !runtimeMediaAsset) return false;
  try {
    const result = await sendRuntimeTransaction({ projectPath, mediaAssets: [runtimeMediaAsset] });
    if (!(result !== null && result !== undefined ? result.success : undefined)) {
      loggingModule.logError('[media-asset-registry] failed to persist thumbnail state via runtime transaction', {
        projectPath,
        assetId: asset.id,
        error: (result !== null && result !== undefined ? result.error : undefined) || 'unknown_runtime_transaction_error',
      });
      return false;
    }
    const runtimeMediaAssetView = runtimeMediaAssetRowToView(runtimeMediaAsset, {
      now: undefined,
      onIssue: (issue) => {
        loggingModule.logWarn('[runtime-media-assets] failed to hydrate persisted media asset row', { issue });
      },
    });
    if (runtimeMediaAssetView) {
      sendMediaAssetsChangedNotification({ type: 'media-assets:changed', projectPath, mediaAssets: [runtimeMediaAssetView] });
    }
    return true;
  } catch (error) {
    loggingModule.logError('[media-asset-registry] runtime transaction threw while persisting thumbnail state', {
      projectPath,
      assetId: asset.id,
      error,
    });
    return false;
  }
};

export {
  createThumbnailError,
  normalizeDimension,
  normalizeFiniteNumber,
  normalizeProjectMediaType,
  normalizeString,
  parseRuntimeMediaAssetRowToMediaAsset,
  persistRuntimeMediaAsset,
  readAllRuntimeMediaAssets,
  readRuntimeMediaAssetById,
};
