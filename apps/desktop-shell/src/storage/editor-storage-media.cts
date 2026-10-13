/**
 * Editor Storage Service — Media Asset Management
 *
 * 迁移自 Backend media-asset-registry.cts 的 ensureProjectMediaAsset + importBundleMediaAssets。
 * 确定性 ID 生成 + 去重 + 写入 media_assets 表。
 */

import * as crypto from 'node:crypto';
import type { SqliteDatabase } from './sqlite-loader.cjs';
import mediaFileKeyModule = require('@iart/utils/media-file-key');
const { extractMediaFileKey, extractContentHashFromFileKey } = mediaFileKeyModule;

// ── Helpers ──

const normalizeString = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed || '';
};

type ProjectMediaType = 'image' | 'video' | 'audio';

const normalizeProjectMediaType = (value: unknown): ProjectMediaType | null => {
  const normalized = normalizeString(value).toLowerCase();
  if (normalized === 'image' || normalized === 'video' || normalized === 'audio') {
    return normalized as ProjectMediaType;
  }
  return null;
};

/**
 * 确定性 ID：sha256(mediaType:contentHash) 取前 16 字符（内容寻址单规则）。
 *
 * 唯一文档事实源：docs/architecture/contracts/storage-schema.md「资产 id 派生规则」，
 * 2026-10-07 收敛为单规则——旧来源寻址公式 sha256(mediaType:url) 已废除，与 Runtime
 * Backend 侧 deriveContentAddressedAssetId 同公式。contentHash 从登记 url 的 fileKey
 * 解析（local-media 地址的 fileKey 即 `<内容sha256>.<ext>`，导入写盘与运行域下载同构）；
 * url 非 local-media 形态或 fileKey 非内容指纹命名时返回 null，登记按非法输入拒绝。
 */
export const buildAssetId = (mediaType: ProjectMediaType, url: string): string | null => {
  const fileKey = extractMediaFileKey(url);
  const contentHash = fileKey === null ? null : extractContentHashFromFileKey(fileKey);
  if (contentHash === null || contentHash.length === 0) return null;
  return crypto.createHash('sha256').update(`${mediaType}:${contentHash}`).digest('hex').slice(0, 16);
};

// ── upsertMediaAsset ──

interface UpsertMediaAssetParams {
  mediaType: unknown | undefined;
  url: unknown | undefined;
  sourceFileName: unknown | undefined;
  mimeType: unknown | undefined;
  sizeBytes: unknown | undefined;
  width: unknown | undefined;
  height: unknown | undefined;
  durationMs: unknown | undefined;
  fps: unknown | undefined;
  thumbnailUrl: unknown | undefined;
  thumbnailStatus: unknown | undefined;
}

type MediaAssetMap = Record<string, unknown>;

interface MediaAssetPayload {
  thumbnail: unknown | undefined;
  original: unknown | undefined;
}

interface MediaAssetThumbnailRow {
  url: unknown | undefined;
  status: unknown | undefined;
}

interface MediaAssetOriginalRow {
  sourceFileName: unknown | undefined;
}

interface RawBundleAsset {
  mediaType: unknown | undefined;
  original: unknown | undefined;
}

interface RawBundleAssetOriginal {
  url: unknown | undefined;
  mimeType: unknown | undefined;
  sizeBytes: unknown | undefined;
}

interface UpsertMediaAssetResult {
  assetId: string;
  asset: MediaAssetMap;
  created: boolean;
}

const normalizeInteger = (value: unknown): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.trunc(parsed);
};

const normalizeFiniteNumber = (value: unknown): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
};

/**
 * upsertMediaAsset — 确定性 ID + 去重 + 写入 media_assets 表。
 * 返回 { assetId, asset, created }。
 */
const upsertMediaAsset = (
  db: SqliteDatabase,
  params: UpsertMediaAssetParams,
): UpsertMediaAssetResult | null => {
  const mediaType = normalizeProjectMediaType(params.mediaType);
  const url = normalizeString(params.url);
  if (!mediaType || !url) {
    return null;
  }

  const assetId = buildAssetId(mediaType, url);
  if (assetId === null) return null;
  const now = Date.now();

  const existing = db
    .prepare(
      `SELECT assetId, mediaType, payloadJson, createdAt, updatedAt
         FROM media_assets
        WHERE assetId = ?`,
    )
    .get(assetId) as
    | {
        assetId: string;
        mediaType: string;
        payloadJson: string;
        createdAt: number | null;
        updatedAt: number | null;
      }
    | undefined;

  const existingPayloadRaw = (existing !== null && existing !== undefined && existing.payloadJson !== undefined) ? JSON.parse(existing.payloadJson) as unknown : {};
  const existingPayload =
    typeof existingPayloadRaw === 'object' && existingPayloadRaw !== null
      ? (existingPayloadRaw as MediaAssetPayload)
      : ({} as MediaAssetPayload);
  const existingThumbnail =
    typeof existingPayload.thumbnail === 'object' && existingPayload.thumbnail !== null
      ? (existingPayload.thumbnail as MediaAssetThumbnailRow)
      : ({} as MediaAssetThumbnailRow);
  // sourceFileName 是导入素材的语义标注：同内容跨路径收敛为一行后，后写的生成/加工
  // 登记不携带文件名，保留既有值防覆盖丢失（与 thumbnail 字段同款保留语义）。
  const existingOriginal =
    typeof existingPayload.original === 'object' && existingPayload.original !== null
      ? (existingPayload.original as MediaAssetOriginalRow)
      : ({} as MediaAssetOriginalRow);
  const sourceFileName = normalizeString(params.sourceFileName) || normalizeString(existingOriginal.sourceFileName) || null;
  const thumbnailUrl = normalizeString(params.thumbnailUrl) || normalizeString(existingThumbnail.url) || null;
  const thumbnailStatus = normalizeString(params.thumbnailStatus) || normalizeString(existingThumbnail.status) || 'missing';
  const asset: MediaAssetMap = {
    id: assetId,
    mediaType,
    original: {
      url,
      fileKey: extractMediaFileKey(url),
      sourceFileName,
      mimeType: normalizeString(params.mimeType) || null,
      sizeBytes: normalizeInteger(params.sizeBytes),
      width: normalizeInteger(params.width),
      height: normalizeInteger(params.height),
      durationMs: normalizeInteger(params.durationMs),
      fps: normalizeFiniteNumber(params.fps),
    },
    thumbnail: {
      url: thumbnailUrl,
      mimeType: null,
      width: null,
      height: null,
      status: thumbnailStatus,
      generatedAt: null,
      error: null,
    },
    lifecycle: {
      createdAt: (existing !== null && existing !== undefined ? existing.createdAt : undefined) ?? now,
      updatedAt: now,
    },
  };

  const { mediaType: _mt, id: _id, ...payload } = asset;
  db.prepare(
    `INSERT OR REPLACE INTO media_assets (
      assetId, mediaType, payloadJson, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    assetId,
    mediaType,
    JSON.stringify(payload),
    (existing !== null && existing !== undefined ? existing.createdAt : undefined) ?? now,
    now,
  );

  return {
    assetId,
    asset,
    created: !existing,
  };
};

// ── importBundleAssets ──

/**
 * importBundleAssets — 批量导入 media assets。
 * 返回 { assetIdMap, mediaAssetsPatch }。
 */
const importBundleAssets = (
  db: SqliteDatabase,
  mediaAssets: MediaAssetMap,
): { assetIdMap: Record<string, string>; mediaAssetsPatch: MediaAssetMap } => {
  const assetIdMap: Record<string, string> = {};
  const mediaAssetsPatch: MediaAssetMap = {};

  if (!mediaAssets || typeof mediaAssets !== 'object' || Array.isArray(mediaAssets)) {
    return { assetIdMap, mediaAssetsPatch };
  }

  for (const [sourceAssetId, rawAsset] of Object.entries(mediaAssets)) {
    if (!rawAsset || typeof rawAsset !== 'object') continue;
    const asset = rawAsset as RawBundleAsset;
    const original =
      typeof asset.original === 'object' && asset.original !== null
        ? (asset.original as RawBundleAssetOriginal)
        : ({} as RawBundleAssetOriginal);

    const result = upsertMediaAsset(db, {
      mediaType: asset.mediaType,
      url: original.url,
      sourceFileName: undefined,
      mimeType: original.mimeType,
      sizeBytes: original.sizeBytes,
      width: undefined,
      height: undefined,
      durationMs: undefined,
      fps: undefined,
      thumbnailUrl: undefined,
      thumbnailStatus: undefined,
    });

    if (!result) continue;
    if (!result.assetId || !result.asset) continue;
    assetIdMap[sourceAssetId] = result.assetId;
    mediaAssetsPatch[result.assetId] = result.asset;
  }

  return { assetIdMap, mediaAssetsPatch };
};

export { upsertMediaAsset, importBundleAssets };
