'use client';

import { useMemo } from 'react';
import {
  DEFAULT_IMAGE_THUMBNAIL_OPTIONS,
} from '../../../services/imageThumbnailService';
import type { ImageMeta } from '../../../types';
import { useMediaThumbnail } from './useMediaThumbnail';

export type ImageThumbnailResult = {
  kind: 'thumbnail' | 'original';
  url: string;
  sourceMeta: ImageMeta | null;
};

export const useImageThumbnail = (
  sourceUrl: string | null | undefined,
  options: { maxEdge: number | undefined; quality: number | undefined } | undefined,
  enabled = true
): ImageThumbnailResult | null => {
  const optionsMaxEdge = (options !== null && options !== undefined ? options.maxEdge : undefined);
  const optionsQuality = (options !== null && options !== undefined ? options.quality : undefined);
  const maxEdge = useMemo(
    () => Number(optionsMaxEdge ?? DEFAULT_IMAGE_THUMBNAIL_OPTIONS.maxEdge),
    [optionsMaxEdge],
  );
  const quality = useMemo(
    () => Number(optionsQuality ?? DEFAULT_IMAGE_THUMBNAIL_OPTIONS.quality),
    [optionsQuality],
  );
  const thumbnail = useMediaThumbnail({
    assetId: undefined,
    mediaType: 'image',
    sourceUrl,
    projectRef: undefined,
    fileKey: undefined,
    enabled,
    maxEdge,
    width: undefined,
    quality,
    timeSec: undefined,
  });
  if (!thumbnail && !sourceUrl) return null;

  return {
    kind: (thumbnail !== null && thumbnail !== undefined ? thumbnail.kind : undefined) ?? 'original',
    url: (thumbnail !== null && thumbnail !== undefined ? thumbnail.displayUrl : undefined) ?? sourceUrl ?? '',
    sourceMeta: (thumbnail !== null && thumbnail !== undefined ? thumbnail.sourceMeta : undefined) ?? null,
  } satisfies ImageThumbnailResult;
};

export default useImageThumbnail;
