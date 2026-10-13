import type {
  MediaAsset,
  MediaAssetOriginal,
  MediaAssetThumbnail,
  MediaAssetThumbnailError,
  MediaAssetThumbnailStatus,
  ProjectMediaAssets,
  ProjectMediaType,
} from './project-dto';

export type RuntimeMediaAssetPayloadProjection = {
  original: unknown | undefined;
  thumbnail: unknown | undefined;
  lifecycle: unknown | undefined;
};

export type ProjectRuntimeMediaAssetRowOptions = {
  now: number | undefined;
};

type JsonRecord = Record<string, unknown>;

type RuntimeMediaAssetRowProjection = JsonRecord & {
  assetId: unknown | undefined;
  mediaType: unknown | undefined;
  payloadJson: unknown | undefined;
  createdAt: unknown | undefined;
  updatedAt: unknown | undefined;
};

type RuntimeMediaAssetPayloadRecord = JsonRecord & RuntimeMediaAssetPayloadProjection;

type MediaAssetOriginalProjection = JsonRecord & {
  url: unknown | undefined;
  projectRef: unknown | undefined;
  fileKey: unknown | undefined;
  sourceUrl: unknown | undefined;
  sourceFileName: unknown | undefined;
  mimeType: unknown | undefined;
  sizeBytes: unknown | undefined;
  width: unknown | undefined;
  height: unknown | undefined;
  durationMs: unknown | undefined;
  fps: unknown | undefined;
};

type MediaAssetThumbnailProjection = JsonRecord & {
  url: unknown | undefined;
  mimeType: unknown | undefined;
  width: unknown | undefined;
  height: unknown | undefined;
  status: unknown | undefined;
  generatedAt: unknown | undefined;
  error: unknown | undefined;
};

type MediaAssetThumbnailErrorProjection = JsonRecord & {
  code: unknown | undefined;
  message: unknown | undefined;
  failedAt: unknown | undefined;
};

type MediaAssetLifecycleProjection = JsonRecord & {
  createdAt: unknown | undefined;
  updatedAt: unknown | undefined;
};

const THUMBNAIL_STATUSES: ReadonlySet<string> = new Set([
  'missing',
  'generating',
  'ready',
  'stale',
  'failed',
]);

const DECIMAL_NUMBER_PATTERN = /^[-+]?(?:(?:\d+\.?\d*)|(?:\.\d+))(?:e[-+]?\d+)?$/i;

const asRecord = <TRecord extends JsonRecord = JsonRecord>(value: unknown): TRecord | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as TRecord) : null;

const normalizeString = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const normalizeNullableString = (value: unknown): string | null => {
  const normalized = normalizeString(value);
  return normalized || null;
};

const normalizeFiniteNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || !DECIMAL_NUMBER_PATTERN.test(trimmed)) return null;
  const numeric = Number(trimmed);
  return Number.isFinite(numeric) ? numeric : null;
};

const normalizeProjectMediaType = (value: unknown): ProjectMediaType | null => {
  const normalized = normalizeString(value).toLowerCase();
  if (normalized === 'image' || normalized === 'video' || normalized === 'audio') {
    return normalized as ProjectMediaType;
  }
  return null;
};

const EMPTY_PAYLOAD_RECORD: RuntimeMediaAssetPayloadRecord = {
  original: undefined,
  thumbnail: undefined,
  lifecycle: undefined,
};

const parsePayloadJson = (row: RuntimeMediaAssetRowProjection): RuntimeMediaAssetPayloadRecord => {
  const raw = row.payloadJson;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return EMPTY_PAYLOAD_RECORD;
    try {
      return asRecord<RuntimeMediaAssetPayloadRecord>(JSON.parse(trimmed) as unknown) ?? EMPTY_PAYLOAD_RECORD;
    } catch {
      return EMPTY_PAYLOAD_RECORD;
    }
  }
  return asRecord<RuntimeMediaAssetPayloadRecord>(raw) ?? EMPTY_PAYLOAD_RECORD;
};

const parseMediaAssetOriginal = (value: unknown): MediaAssetOriginal | null => {
  const raw = asRecord<MediaAssetOriginalProjection>(value);
  const url = normalizeString((raw !== null && raw !== undefined ? raw.url : undefined));
  if (!raw || !url) return null;

  return {
    url,
    projectRef: normalizeNullableString(raw.projectRef),
    fileKey: normalizeNullableString(raw.fileKey),
    sourceUrl: normalizeNullableString(raw.sourceUrl),
    sourceFileName: normalizeNullableString(raw.sourceFileName),
    mimeType: normalizeNullableString(raw.mimeType),
    sizeBytes: normalizeFiniteNumber(raw.sizeBytes),
    width: normalizeFiniteNumber(raw.width),
    height: normalizeFiniteNumber(raw.height),
    durationMs: normalizeFiniteNumber(raw.durationMs),
    fps: normalizeFiniteNumber(raw.fps),
  };
};

const parseThumbnailError = (value: unknown): MediaAssetThumbnailError | null => {
  const raw = asRecord<MediaAssetThumbnailErrorProjection>(value);
  if (!raw) return null;
  return {
    code: normalizeNullableString(raw.code),
    message: normalizeNullableString(raw.message),
    failedAt: normalizeFiniteNumber(raw.failedAt),
  };
};

const EMPTY_THUMBNAIL_PROJECTION: MediaAssetThumbnailProjection = {
  url: undefined,
  mimeType: undefined,
  width: undefined,
  height: undefined,
  status: undefined,
  generatedAt: undefined,
  error: undefined,
};

const parseMediaAssetThumbnail = (value: unknown): MediaAssetThumbnail => {
  const raw = asRecord<MediaAssetThumbnailProjection>(value) ?? EMPTY_THUMBNAIL_PROJECTION;
  const status = normalizeString(raw.status).toLowerCase();
  return {
    url: normalizeNullableString(raw.url),
    mimeType: normalizeNullableString(raw.mimeType),
    width: normalizeFiniteNumber(raw.width),
    height: normalizeFiniteNumber(raw.height),
    status: THUMBNAIL_STATUSES.has(status) ? (status as MediaAssetThumbnailStatus) : 'missing',
    generatedAt: normalizeFiniteNumber(raw.generatedAt),
    error: parseThumbnailError(raw.error),
  };
};

export function projectRuntimeMediaAssetRowToMediaAsset(
  row: unknown,
  options: ProjectRuntimeMediaAssetRowOptions = {} as ProjectRuntimeMediaAssetRowOptions,
): MediaAsset | null {
  const rowRecord = asRecord<RuntimeMediaAssetRowProjection>(row);
  if (!rowRecord) return null;

  const id = normalizeString(rowRecord.assetId);
  const mediaType = normalizeProjectMediaType(rowRecord.mediaType);
  if (!id || !mediaType) return null;

  const payload = parsePayloadJson(rowRecord);
  const payloadRecord = asRecord<RuntimeMediaAssetPayloadRecord>(payload);
  const original = parseMediaAssetOriginal((payloadRecord !== null && payloadRecord !== undefined ? payloadRecord.original : undefined));
  if (!original) return null;

  const EMPTY_LIFECYCLE_PROJECTION: MediaAssetLifecycleProjection = { createdAt: undefined, updatedAt: undefined };

  const lifecycle = asRecord<MediaAssetLifecycleProjection>((payloadRecord !== null && payloadRecord !== undefined ? payloadRecord.lifecycle : undefined)) ?? EMPTY_LIFECYCLE_PROJECTION;
  const createdAt =
    normalizeFiniteNumber(lifecycle.createdAt) ??
    normalizeFiniteNumber(rowRecord.createdAt) ??
    normalizeFiniteNumber(options.now) ??
    Date.now();
  const updatedAt =
    normalizeFiniteNumber(lifecycle.updatedAt) ??
    normalizeFiniteNumber(rowRecord.updatedAt) ??
    createdAt;

  return {
    id,
    mediaType,
    original,
    thumbnail: parseMediaAssetThumbnail((payloadRecord !== null && payloadRecord !== undefined ? payloadRecord.thumbnail : undefined)),
    lifecycle: {
      createdAt,
      updatedAt,
    },
  };
}

export function projectRuntimeMediaAssetRowsToProjectMediaAssets(
  rows: unknown,
  options: ProjectRuntimeMediaAssetRowOptions = {} as ProjectRuntimeMediaAssetRowOptions,
): ProjectMediaAssets {
  const mediaAssets: ProjectMediaAssets = {};
  if (!Array.isArray(rows)) return mediaAssets;

  for (const row of rows) {
    const asset = projectRuntimeMediaAssetRowToMediaAsset(row, options);
    if (!asset) continue;
    mediaAssets[asset.id] = asset;
  }

  return mediaAssets;
}
