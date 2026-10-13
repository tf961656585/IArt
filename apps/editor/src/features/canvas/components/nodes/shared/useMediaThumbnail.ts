'use client';

import { useMemo } from 'react';
import type { MediaAsset, MediaAssetThumbnailStatus, ProjectMediaType } from '@iart/contracts';

import { useCanvasStore } from '../../../store/canvasStore';
import { resolveMediaAssetForThumbnail } from '../../../services/mediaThumbnailResolver';
import type { ImageMeta } from '../../../types';

export type MediaThumbnailView = {
  status: MediaAssetThumbnailStatus;
  kind: 'thumbnail' | 'original';
  mediaType: Extract<ProjectMediaType, 'image' | 'video'>;
  assetId: string | null;
  originalUrl: string | null;
  thumbnailUrl: string | null;
  displayUrl: string | null;
  error: string | null;
  sourceMeta: ImageMeta | null;
};

type MediaThumbnailOptions = {
  assetId: string | null | undefined | undefined;
  sourceUrl: string | null | undefined | undefined;
  mediaType: Extract<ProjectMediaType, 'image' | 'video'>;
  projectRef: string | null | undefined | undefined;
  fileKey: string | null | undefined | undefined;
  enabled: boolean | undefined;
  maxEdge: number | undefined;
  width: number | undefined;
  quality: number | undefined;
  timeSec: number | undefined;
};

const buildImageMetaFromAsset = (asset: MediaAsset | null | undefined): ImageMeta | null => {
  const width = Number((asset !== null && asset !== undefined && asset.original !== null && asset.original !== undefined ? asset.original.width : undefined));
  const height = Number((asset !== null && asset !== undefined && asset.original !== null && asset.original !== undefined ? asset.original.height : undefined));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return {
    width: Math.round(width),
    height: Math.round(height),
    aspectRatio: Number((width / height).toFixed(4)),
  };
};

export const useMediaThumbnail = ({
  assetId,
  sourceUrl,
  mediaType,
  projectRef,
  fileKey,
  enabled: _enabled = true,
  maxEdge: _maxEdge,
  width: _width,
  quality: _quality,
  timeSec: _timeSec,
}: MediaThumbnailOptions): MediaThumbnailView | null => {
  const mediaAssets = useCanvasStore((state) => state.mediaAssets);

  const resolved = useMemo(
    () =>
      resolveMediaAssetForThumbnail({
        mediaAssets,
        mediaType,
        assetId,
        sourceUrl,
        projectRef,
        fileKey,
      }),
    [assetId, fileKey, mediaAssets, mediaType, projectRef, sourceUrl],
  );

  const asset = resolved.asset;
  const assetThumbnail = asset !== null && asset !== undefined ? asset.thumbnail : null;
  const assetThumbnailUrl = assetThumbnail !== null && assetThumbnail !== undefined ? assetThumbnail.url : null;
  const assetOriginal = asset !== null && asset !== undefined ? asset.original : null;
  const assetOriginalUrl = (assetOriginal !== null && assetOriginal !== undefined ? assetOriginal.url : undefined);
  const status = (asset !== null && asset !== undefined && asset.thumbnail !== null && asset.thumbnail !== undefined ? asset.thumbnail.status : undefined) ?? 'missing';
  const originalUrl = assetOriginalUrl ?? resolved.sourceUrl;
  const thumbnailUrl =
    (assetThumbnail !== null && assetThumbnail !== undefined ? assetThumbnail.status : undefined) === 'ready' && assetThumbnailUrl
      ? assetThumbnailUrl
      : null;
  const displayUrl = thumbnailUrl ?? originalUrl;

  if (!originalUrl && !thumbnailUrl) return null;

  return {
    status,
    kind: thumbnailUrl ? 'thumbnail' : 'original',
    mediaType,
    assetId: (asset !== null && asset !== undefined ? asset.id : undefined) ?? resolved.assetId,
    originalUrl,
    thumbnailUrl,
    displayUrl,
    error: (asset !== null && asset !== undefined && asset.thumbnail !== null && asset.thumbnail !== undefined && asset.thumbnail.error !== null && asset.thumbnail.error !== undefined ? asset.thumbnail.error.message : undefined) ?? null,
    sourceMeta: mediaType === 'image' ? buildImageMetaFromAsset(asset) : null,
  };
};

export default useMediaThumbnail;
