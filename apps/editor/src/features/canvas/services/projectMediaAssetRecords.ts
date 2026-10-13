import type {
  MediaAsset,
  ProjectMediaAssets,
  ProjectMediaType,
} from "@iart/contracts";

import type { UnknownRecord } from "@/client/utils/typeGuards";
import type { ResultAreaSlotView } from "../types";
import {
  asUnknownRecord,
  normalizeFiniteNumber,
  normalizeMediaType,
  normalizeString,
  requireUnknownRecord,
  throwInvalidMediaAssetError,
} from "./projectMediaAssetUtils";

type RawProjectMediaAssetRecord = UnknownRecord & {
  id: unknown | undefined;
  lifecycle: unknown | undefined;
  mediaType: unknown | undefined;
  original: unknown | undefined;
  thumbnail: unknown | undefined;
};

type RawMediaFileRecord = UnknownRecord & {
  durationMs: unknown | undefined;
  fileKey: unknown | undefined;
  fps: unknown | undefined;
  height: unknown | undefined;
  mimeType: unknown | undefined;
  projectRef: unknown | undefined;
  sizeBytes: unknown | undefined;
  sourceUrl: unknown | undefined;
  url: unknown | undefined;
  width: unknown | undefined;
};

type RawMediaLifecycleRecord = UnknownRecord & {
  createdAt: unknown | undefined;
  updatedAt: unknown | undefined;
};

type RawMediaThumbnailRecord = RawMediaFileRecord & {
  error: unknown | undefined;
  generatedAt: unknown | undefined;
  status: unknown | undefined;
};

type RawMediaThumbnailErrorRecord = UnknownRecord & {
  code: unknown | undefined;
  failedAt: unknown | undefined;
  message: unknown | undefined;
};

const normalizeProjectMediaAssetsUncached = (
  raw: unknown,
): ProjectMediaAssets => {
  const out: ProjectMediaAssets = {};
  if (raw === null || raw === undefined) {
    throwInvalidMediaAssetError();
  }
  const entries: Array<readonly [string, unknown]> = Array.isArray(raw)
    ? (raw as unknown[]).map((value) => {
        const record = asUnknownRecord(
          value,
        ) as RawProjectMediaAssetRecord | null;
        return [normalizeString((record !== null && record !== undefined ? record.id : undefined)), value] as const;
      })
    : (() => {
        const rawRecord = requireUnknownRecord(raw, undefined);
        return Object.entries(rawRecord);
      })();

  for (const [assetId, value] of entries) {
    const record = requireUnknownRecord(value, undefined) as RawProjectMediaAssetRecord;
    const id = normalizeString(record.id) || normalizeString(assetId);
    const mediaType = normalizeMediaType(record.mediaType);
    const original = asUnknownRecord(record.original);
    if (!id || !mediaType) {
      throwInvalidMediaAssetError();
    }
    const originalRecord = requireUnknownRecord(original, undefined) as RawMediaFileRecord;
    const resolvedMediaType = mediaType as ProjectMediaType;
    const originalUrl = normalizeString(originalRecord.url);
    if (!originalUrl) {
      throwInvalidMediaAssetError();
    }

    const thumbnail = (asUnknownRecord(record.thumbnail) ??
      {}) as RawMediaThumbnailRecord;
    const lifecycle = (asUnknownRecord(record.lifecycle) ??
      {}) as RawMediaLifecycleRecord;
    const thumbnailError = asUnknownRecord(
      thumbnail.error,
    ) as RawMediaThumbnailErrorRecord | null;
    const createdAt =
      normalizeFiniteNumber(lifecycle.createdAt) ?? Date.now();
    const updatedAt =
      normalizeFiniteNumber(lifecycle.updatedAt) ?? createdAt;
    const thumbnailStatus = normalizeString(thumbnail.status).toLowerCase();

    out[id] = {
      id,
      mediaType: resolvedMediaType,
      original: {
        url: originalUrl,
        projectRef: normalizeString(originalRecord.projectRef) || null,
        fileKey: normalizeString(originalRecord.fileKey) || null,
        sourceUrl: normalizeString(originalRecord.sourceUrl) || null,
        sourceFileName: null,
        mimeType: normalizeString(originalRecord.mimeType) || null,
        sizeBytes: normalizeFiniteNumber(originalRecord.sizeBytes),
        width: normalizeFiniteNumber(originalRecord.width),
        height: normalizeFiniteNumber(originalRecord.height),
        durationMs: normalizeFiniteNumber(originalRecord.durationMs),
        fps: normalizeFiniteNumber(originalRecord.fps),
      },
      thumbnail: {
        url: normalizeString(thumbnail.url) || null,
        mimeType: normalizeString(thumbnail.mimeType) || null,
        width: normalizeFiniteNumber(thumbnail.width),
        height: normalizeFiniteNumber(thumbnail.height),
        status:
          thumbnailStatus === "ready" ||
          thumbnailStatus === "stale" ||
          thumbnailStatus === "missing" ||
          thumbnailStatus === "generating" ||
          thumbnailStatus === "failed"
            ? (thumbnailStatus as MediaAsset["thumbnail"]["status"])
            : "missing",
        generatedAt: normalizeFiniteNumber(thumbnail.generatedAt),
        error: thumbnailError
          ? {
              code: normalizeString(thumbnailError.code) || null,
              message: normalizeString(thumbnailError.message) || null,
              failedAt: normalizeFiniteNumber(thumbnailError.failedAt),
            }
          : null,
      },
      lifecycle: {
        createdAt,
        updatedAt,
      },
    };
  }

  return out;
};

// 渲染期引用缓存：mediaAssets 由 zustand+immer 不可变更新，输入引用不变时内容必然不变，
// 相同输入直接复用上次的归一化结果（结果区 N 个 item 渲染一轮由 O(N×A) 降为 O(A)）。
// WeakMap 以输入引用为 key，输入对象被 GC 后缓存自动回收；仅对象（数组/Record）可缓存，
// 原始值输入不缓存、走原逻辑（会按原路径抛错）。
// 零拷贝返回：已全量排查调用方（mediaThumbnailResolver / projectMediaAssetSelection /
// projectMediaAssetMerge / projectMediaAssetImport / insertBundleIntoCanvas / importBundle /
// storage / mediaProjector / canvasStore.loadActions），均为只读消费或写时拷贝（immer），
// 无 mutate 返回值的调用方；调用方不得 mutate 返回值。
// 附带语义变化：输入中缺失 lifecycle.createdAt 的资产，同一输入引用多次调用现在返回相同的
// Date.now() 兜底值（原先每次调用重新取），属于稳定性改善，无调用方依赖旧行为。
const normalizedProjectMediaAssetsCache = new WeakMap<
  object,
  ProjectMediaAssets
>();

export const normalizeProjectMediaAssets = (
  raw: unknown,
): ProjectMediaAssets => {
  if (raw !== null && typeof raw === "object") {
    const cached = normalizedProjectMediaAssetsCache.get(raw);
    if (cached !== undefined) return cached;
  }
  const out = normalizeProjectMediaAssetsUncached(raw);
  if (raw !== null && typeof raw === "object") {
    normalizedProjectMediaAssetsCache.set(raw, out);
  }
  return out;
};

export const buildProjectMediaAssetRecord = (params: {
  assetId: string | null | undefined;
  mediaType: ResultAreaSlotView["mediaType"] | undefined;
  url: string | null | undefined;
  projectRef: string | null | undefined;
  fileKey: string | null | undefined;
  sourceUrl: string | null | undefined;
  sourceFileName: string | null | undefined;
  mimeType: string | null | undefined;
  sizeBytes: number | null | undefined;
  existingAsset: MediaAsset | null | undefined;
}): MediaAsset | null => {
  const assetId = normalizeString(params.assetId);
  const mediaType = normalizeMediaType(params.mediaType);
  const url = normalizeString(params.url);
  if (!assetId || !mediaType || !url) return null;

  const now = Date.now();
  const existing = params.existingAsset ?? null;
  return {
    id: assetId,
    mediaType,
    original: {
      url,
      projectRef:
        normalizeString(params.projectRef) ||
        (existing !== null && existing !== undefined && existing.original !== null && existing.original !== undefined ? existing.original.projectRef : undefined) ||
        null,
      fileKey:
        normalizeString(params.fileKey) ||
        (existing !== null && existing !== undefined && existing.original !== null && existing.original !== undefined ? existing.original.fileKey : undefined) ||
        null,
      sourceUrl:
        normalizeString(params.sourceUrl) ||
        (existing !== null && existing !== undefined && existing.original !== null && existing.original !== undefined ? existing.original.sourceUrl : undefined) ||
        null,
      sourceFileName:
        normalizeString(params.sourceFileName) ||
        (existing !== null && existing !== undefined && existing.original !== null && existing.original !== undefined ? existing.original.sourceFileName : undefined) ||
        null,
      mimeType:
        normalizeString(params.mimeType) ||
        (existing !== null && existing !== undefined && existing.original !== null && existing.original !== undefined ? existing.original.mimeType : undefined) ||
        null,
      sizeBytes:
        normalizeFiniteNumber(params.sizeBytes) ??
        (existing !== null && existing !== undefined && existing.original !== null && existing.original !== undefined ? existing.original.sizeBytes : undefined) ??
        null,
      width: (existing !== null && existing !== undefined && existing.original !== null && existing.original !== undefined ? existing.original.width : undefined) ?? null,
      height: (existing !== null && existing !== undefined && existing.original !== null && existing.original !== undefined ? existing.original.height : undefined) ?? null,
      durationMs: (existing !== null && existing !== undefined && existing.original !== null && existing.original !== undefined ? existing.original.durationMs : undefined) ?? null,
      fps: (existing !== null && existing !== undefined && existing.original !== null && existing.original !== undefined ? existing.original.fps : undefined) ?? null,
    },
    thumbnail: (existing !== null && existing !== undefined ? existing.thumbnail : undefined) ?? {
      url: null,
      mimeType: null,
      width: null,
      height: null,
      status: "missing",
      generatedAt: null,
      error: null,
    },
    lifecycle: {
      createdAt: (existing !== null && existing !== undefined && existing.lifecycle !== null && existing.lifecycle !== undefined ? existing.lifecycle.createdAt : undefined) ?? now,
      updatedAt: now,
    },
  };
};
