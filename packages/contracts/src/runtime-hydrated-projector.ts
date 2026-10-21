import type {
  MediaAsset,
  MediaAssetOriginal,
  MediaAssetThumbnail,
  MediaAssetThumbnailError,
  MediaAssetThumbnailStatus,
  ProjectMediaAssets,
  ProjectMediaType,
} from './project-dto';
import type {
  RuntimeJsonObject,
  RuntimeMediaAssetRow,
  RuntimeMediaAssetView,
  RuntimeTaskFailure,
  RuntimeTaskRow,
  RuntimeTaskView,
} from './schemas/runtime-transaction.schema';
import {
  RuntimeJsonObjectSchema,
  RuntimeMediaAssetRowSchema,
  RuntimeMediaAssetViewSchema,
  RuntimeTaskRowSchema,
  RuntimeTaskViewSchema,
  RuntimeTaskFailureSchema,
} from './schemas/runtime-transaction.schema';

export type RuntimeHydrationIssue = {
  level: 'debug' | 'warn';
  scope: 'runtime-task' | 'runtime-media-asset';
  id: string | null;
  field: 'requestJson' | 'metadataJson' | 'failureJson' | 'payloadJson' | 'payload';
  message: string;
};

export type RuntimeHydrationIssueReporter = (issue: RuntimeHydrationIssue) => void;

export type RuntimeHydrationProjectorOptions = {
  now: number | undefined;
  onIssue: RuntimeHydrationIssueReporter | undefined;
};

type JsonRecord = Record<string, unknown>;

type RuntimeMediaAssetPayloadProjection = {
  original: unknown | undefined;
  thumbnail: unknown | undefined;
  lifecycle: unknown | undefined;
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

const DEFAULT_PROJECTOR_OPTIONS: RuntimeHydrationProjectorOptions = {
  now: undefined,
  onIssue: undefined,
};

const reportIssue = (
  options: RuntimeHydrationProjectorOptions | undefined,
  issue: RuntimeHydrationIssue,
): void => {
  if (options !== null && options !== undefined && options.onIssue !== null && options.onIssue !== undefined) {
    options.onIssue(issue);
  }
};

const parseJsonObjectField = (
  raw: unknown,
  params: {
    scope: RuntimeHydrationIssue['scope'];
    id: string | null;
    field: 'requestJson' | 'metadataJson' | 'payloadJson';
    nullable: boolean;
  },
  options: RuntimeHydrationProjectorOptions | undefined,
): RuntimeJsonObject | null | undefined => {
  if (raw === null || raw === undefined || raw === '') {
    return params.nullable ? null : undefined;
  }
  if (typeof raw !== 'string') {
    const parsed = RuntimeJsonObjectSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    reportIssue(options, {
      level: 'warn',
      scope: params.scope,
      id: params.id,
      field: params.field,
      message: 'Expected JSON object field',
    });
    return params.nullable ? null : undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = RuntimeJsonObjectSchema.safeParse(parsed);
    if (result.success) return result.data;
    reportIssue(options, {
      level: 'warn',
      scope: params.scope,
      id: params.id,
      field: params.field,
      message: 'JSON field did not parse to object',
    });
  } catch (error) {
    reportIssue(options, {
      level: 'warn',
      scope: params.scope,
      id: params.id,
      field: params.field,
      message: error instanceof Error ? error.message : 'Invalid JSON field',
    });
  }
  return params.nullable ? null : undefined;
};

const parsePayloadJson = (
  row: RuntimeMediaAssetRow,
  options: RuntimeHydrationProjectorOptions | undefined,
): RuntimeMediaAssetPayloadRecord | null => {
  const parsed = parseJsonObjectField(
    row.payloadJson,
    {
      scope: 'runtime-media-asset',
      id: row.assetId,
      field: 'payloadJson',
      nullable: false,
    },
    options,
  );
  return asRecord<RuntimeMediaAssetPayloadRecord>(parsed) ?? null;
};

const parseTaskFailureJson = (
  raw: unknown,
  taskId: string,
  options: RuntimeHydrationProjectorOptions | undefined,
): RuntimeTaskFailure | null => {
  if (raw === null || raw === undefined || raw === '') return null;
  const parsedValue = typeof raw === 'string'
    ? (() => {
        try {
          return JSON.parse(raw) as unknown;
        } catch (error) {
          reportIssue(options, {
            level: 'warn',
            scope: 'runtime-task',
            id: taskId,
            field: 'failureJson',
            message: error instanceof Error ? error.message : 'Invalid failure JSON',
          });
          return null;
        }
      })()
    : raw;
  if (parsedValue === null) return null;
  const result = RuntimeTaskFailureSchema.safeParse(parsedValue);
  if (result.success) return result.data;
  reportIssue(options, {
    level: 'warn',
    scope: 'runtime-task',
    id: taskId,
    field: 'failureJson',
    message: 'Failure JSON did not match RuntimeTaskFailureSchema',
  });
  return null;
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

/**
 * task-state-machine.legal_combinations：failed / cancelled 只允许 progressPhase=null。
 *
 * 历史任务行可能残留 requesting / downloading 等阶段；共享投影是存储读（Main）
 * 与运行域视图的唯一水合咽喉，在这里按 status 归一，避免各消费方各修一套。
 * succeeded 的 `completed` 与 null 均合法，其他非终态保持原值，不做过度归一。
 */
const normalizeTaskProgressPhase = (
  status: RuntimeTaskRow['status'],
  progressPhase: string | null | undefined,
): string | null => {
  if (status === 'failed' || status === 'cancelled') return null;
  return progressPhase ?? null;
};

export const runtimeTaskRowToView = (
  rowInput: unknown,
  options: RuntimeHydrationProjectorOptions = DEFAULT_PROJECTOR_OPTIONS,
): RuntimeTaskView | null => {
  const rowResult = RuntimeTaskRowSchema.safeParse(rowInput);
  if (!rowResult.success) return null;
  const row = rowResult.data;
  const request = parseJsonObjectField(
    row.requestJson,
    {
      scope: 'runtime-task',
      id: row.taskId,
      field: 'requestJson',
      nullable: true,
    },
    options,
  );
  const metadata = parseJsonObjectField(
    row.metadataJson,
    {
      scope: 'runtime-task',
      id: row.taskId,
      field: 'metadataJson',
      nullable: false,
    },
    options,
  );

  return RuntimeTaskViewSchema.parse({
    taskId: row.taskId,
    status: row.status,
    projectPath: row.projectPath,
    sourceNodeId: row.sourceNodeId ?? null,
    targetNodeId: row.targetNodeId ?? null,
    batchId: row.batchId ?? null,
    request: request ?? null,
    metadata: metadata ?? {},
    remoteRequestId: row.remoteRequestId ?? null,
    progressPercent: row.progressPercent ?? null,
    progressMessage: row.progressMessage ?? null,
    progressPhase: normalizeTaskProgressPhase(row.status, row.progressPhase),
    errorMessage: row.errorMessage ?? null,
    errorCode: row.errorCode ?? null,
    failure: parseTaskFailureJson(row.failureJson, row.taskId, options),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    startedAt: row.startedAt ?? null,
    finishedAt: row.finishedAt ?? null,
  });
};

export const runtimeTaskRowsToViews = (
  rows: unknown,
  options: RuntimeHydrationProjectorOptions = DEFAULT_PROJECTOR_OPTIONS,
): RuntimeTaskView[] => {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => runtimeTaskRowToView(row, options))
    .filter((task): task is RuntimeTaskView => task !== null);
};

export const runtimeMediaAssetRowToView = (
  rowInput: unknown,
  options: RuntimeHydrationProjectorOptions = DEFAULT_PROJECTOR_OPTIONS,
): RuntimeMediaAssetView | null => {
  const rowResult = RuntimeMediaAssetRowSchema.safeParse(rowInput);
  if (!rowResult.success) return null;
  const row = rowResult.data;
  const mediaType = normalizeProjectMediaType(row.mediaType);
  if (!mediaType) return null;
  const payload = parsePayloadJson(row, options);
  const original = parseMediaAssetOriginal((payload !== null && payload !== undefined ? payload.original : undefined));
  if (!original) {
    reportIssue(options, {
      level: 'warn',
      scope: 'runtime-media-asset',
      id: row.assetId,
      field: 'payload',
      message: 'Missing media original payload',
    });
    return null;
  }
  const EMPTY_LIFECYCLE_PROJECTION: MediaAssetLifecycleProjection = { createdAt: undefined, updatedAt: undefined };

  const lifecycle = asRecord<MediaAssetLifecycleProjection>((payload !== null && payload !== undefined ? payload.lifecycle : undefined)) ?? EMPTY_LIFECYCLE_PROJECTION;
  const createdAt =
    normalizeFiniteNumber(lifecycle.createdAt) ??
    normalizeFiniteNumber(row.createdAt) ??
    normalizeFiniteNumber(options.now) ??
    Date.now();
  const updatedAt =
    normalizeFiniteNumber(lifecycle.updatedAt) ??
    normalizeFiniteNumber(row.updatedAt) ??
    createdAt;

  return RuntimeMediaAssetViewSchema.parse({
    assetId: row.assetId,
    mediaType,
    original,
    thumbnail: parseMediaAssetThumbnail((payload !== null && payload !== undefined ? payload.thumbnail : undefined)),
    lifecycle: {
      createdAt,
      updatedAt,
    },
  });
};

export const runtimeMediaAssetRowsToViews = (
  rows: unknown,
  options: RuntimeHydrationProjectorOptions = DEFAULT_PROJECTOR_OPTIONS,
): RuntimeMediaAssetView[] => {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => runtimeMediaAssetRowToView(row, options))
    .filter((asset): asset is RuntimeMediaAssetView => asset !== null);
};

export const runtimeMediaAssetViewToMediaAsset = (
  viewInput: unknown,
): MediaAsset | null => {
  const viewResult = RuntimeMediaAssetViewSchema.safeParse(viewInput);
  if (!viewResult.success) return null;
  const view = viewResult.data;
  const original: MediaAssetOriginal = {
    url: view.original.url,
    projectRef: view.original.projectRef,
    fileKey: view.original.fileKey,
    sourceUrl: view.original.sourceUrl,
    sourceFileName: view.original.sourceFileName,
    mimeType: view.original.mimeType,
    sizeBytes: view.original.sizeBytes,
    width: view.original.width,
    height: view.original.height,
    durationMs: view.original.durationMs,
    fps: view.original.fps,
  };

  const thumbnail: MediaAssetThumbnail = {
    url: view.thumbnail.url,
    mimeType: view.thumbnail.mimeType,
    width: view.thumbnail.width,
    height: view.thumbnail.height,
    status: view.thumbnail.status,
    generatedAt: view.thumbnail.generatedAt,
    error: view.thumbnail.error !== undefined
      ? (view.thumbnail.error === null
          ? null
          : {
              code: view.thumbnail.error.code,
              message: view.thumbnail.error.message,
              failedAt: view.thumbnail.error.failedAt,
            })
      : undefined,
  };

  return {
    id: view.assetId,
    mediaType: view.mediaType,
    original,
    thumbnail,
    lifecycle: view.lifecycle,
  };
};

export const runtimeMediaAssetViewsToProjectMediaAssets = (
  views: unknown,
): ProjectMediaAssets => {
  const mediaAssets: ProjectMediaAssets = {};
  if (!Array.isArray(views)) return mediaAssets;

  for (const view of views) {
    const asset = runtimeMediaAssetViewToMediaAsset(view);
    if (!asset) continue;
    mediaAssets[asset.id] = asset;
  }

  return mediaAssets;
};

export const mediaAssetToRuntimeMediaAssetRow = (
  asset: MediaAsset,
): RuntimeMediaAssetRow | null => {
  if (!(asset !== null && asset !== undefined ? asset.id : undefined) || !asset.mediaType || !(asset.original !== null && asset.original !== undefined ? asset.original.url : undefined)) return null;
  return RuntimeMediaAssetRowSchema.parse({
    assetId: asset.id,
    mediaType: asset.mediaType,
    payloadJson: JSON.stringify({
      original: asset.original,
      thumbnail: asset.thumbnail,
      lifecycle: asset.lifecycle,
    }),
    createdAt: (asset.lifecycle !== null && asset.lifecycle !== undefined ? asset.lifecycle.createdAt : undefined) ?? null,
    updatedAt: (asset.lifecycle !== null && asset.lifecycle !== undefined ? asset.lifecycle.updatedAt : undefined) ?? null,
  });
};
