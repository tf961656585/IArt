'use client';

import { createVideoThumbnail } from '@/client/api/videoThumbnail';
import { getCurrentProjectPath } from '../storage';
import { normalizeLocalFileUrl } from '../utils/mediaUrl';

const DEFAULT_THUMB_WIDTH = 512;
const DEFAULT_THUMB_QUALITY = 0.7;
const DEFAULT_THUMB_TIME_SEC = 0;

type ThumbnailOptions = {
  assetId: string | null | undefined;
  projectPath: string | null | undefined;
  width: number | undefined;
  quality: number | undefined;
  timeSec: number | undefined;
};

const inflightRequests = new Map<string, Promise<void>>();

const clampQuality = (value: number): number => {
  if (!Number.isFinite(value)) return DEFAULT_THUMB_QUALITY;
  return Math.min(0.95, Math.max(0.1, value));
};

const clampWidth = (value: number): number => {
  if (!Number.isFinite(value)) return DEFAULT_THUMB_WIDTH;
  return Math.min(DEFAULT_THUMB_WIDTH, Math.max(64, Math.round(value)));
};

const normalizeOptions = (options: ThumbnailOptions | undefined) => ({
  width: clampWidth(Number((options !== null && options !== undefined ? options.width : undefined) ?? DEFAULT_THUMB_WIDTH)),
  quality: clampQuality(Number((options !== null && options !== undefined ? options.quality : undefined) ?? DEFAULT_THUMB_QUALITY)),
  timeSec: Math.max(0, Number((options !== null && options !== undefined ? options.timeSec : undefined) ?? DEFAULT_THUMB_TIME_SEC)),
});

const normalizeProjectPath = (value: string | null | undefined): string =>
  typeof value === 'string' && value.trim() ? value.trim() : '';

const buildRequestKey = (
  filesPath: string,
  options: ThumbnailOptions | undefined
): string => {
  const { width, quality, timeSec } = normalizeOptions(options);
  const qualityToken = Math.round(quality * 100);
  return `${filesPath}|w=${width}|q=${qualityToken}|t=${timeSec}`;
};

export const ensureVideoThumbnail = async (
  sourceUrl: string,
  options: ThumbnailOptions | undefined
): Promise<void> => {
  const normalized = normalizeLocalFileUrl(sourceUrl);
  const rawAssetId = options !== undefined ? options.assetId : undefined;
  const assetId = typeof rawAssetId === 'string' && rawAssetId.trim() ? rawAssetId.trim() : '';
  if (!assetId) return;
  const optionProjectPath = normalizeProjectPath((options !== null && options !== undefined ? options.projectPath : undefined));

  const { width, quality, timeSec } = normalizeOptions(options);
  const requestIdentity = `${optionProjectPath}|${normalized ?? `asset:${assetId}`}`;
  const requestKey = buildRequestKey(requestIdentity, {
    assetId: undefined,
    projectPath: undefined,
    width,
    quality,
    timeSec,
  });
  const inflight = inflightRequests.get(requestKey);
  if (inflight) {
    await inflight;
    return;
  }

  const request = (async () => {
    const projectPath = optionProjectPath || (await getCurrentProjectPath().catch(() => null));
    if (!projectPath) return;
    await createVideoThumbnail({
      projectPath,
      assetId,
      width,
      quality,
      timeSec,
    });
  })();

  inflightRequests.set(requestKey, request);
  try {
    await request;
  } catch (error) {
    console.warn('[videoThumbnail] 请求缩略图修复失败', error);
  } finally {
    inflightRequests.delete(requestKey);
  }
};

export const DEFAULT_VIDEO_THUMBNAIL_OPTIONS = {
  width: DEFAULT_THUMB_WIDTH,
  quality: DEFAULT_THUMB_QUALITY,
  timeSec: DEFAULT_THUMB_TIME_SEC,
};
