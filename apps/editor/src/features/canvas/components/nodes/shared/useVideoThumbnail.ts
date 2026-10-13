'use client';

import { useMediaThumbnail } from './useMediaThumbnail';

export type VideoThumbnailResult = {
  kind: 'thumbnail' | 'original';
  url: string;
};

export const useVideoThumbnail = (
  sourceUrl: string | null | undefined,
  enabled = true
): VideoThumbnailResult | null => {
  const thumbnail = useMediaThumbnail({
    assetId: undefined,
    mediaType: 'video',
    sourceUrl,
    projectRef: undefined,
    fileKey: undefined,
    enabled,
    maxEdge: undefined,
    width: undefined,
    quality: undefined,
    timeSec: undefined,
  });
  if (!thumbnail && !sourceUrl) return null;

  return {
    kind: (thumbnail !== null && thumbnail !== undefined ? thumbnail.kind : undefined) ?? 'original',
    url: (thumbnail !== null && thumbnail !== undefined ? thumbnail.displayUrl : undefined) ?? sourceUrl ?? '',
  } satisfies VideoThumbnailResult;
};

export default useVideoThumbnail;
