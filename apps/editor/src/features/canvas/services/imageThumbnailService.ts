'use client';

import { createImageThumbnail } from '@/client/api/imageThumbnail';
import { getCurrentProjectPath } from '../storage';
import { normalizeLocalFileUrl } from '../utils/mediaUrl';

const DEFAULT_THUMB_MAX_EDGE = 512;
const DEFAULT_THUMB_QUALITY = 0.8;

type ThumbnailOptions = {
  assetId: string | null | undefined;
  projectPath: string | null | undefined;
  maxEdge: number | undefined;
  quality: number | undefined;
};

const inflightRequests = new Map<string, Promise<void>>();

const clampQuality = (value: number): number => {
  if (!Number.isFinite(value)) return DEFAULT_THUMB_QUALITY;
  return Math.min(0.95, Math.max(0.1, value));
};

const clampMaxEdge = (value: number): number => {
  if (!Number.isFinite(value)) return DEFAULT_THUMB_MAX_EDGE;
  return Math.min(2048, Math.max(64, Math.round(value)));
};

const normalizeOptions = (options: ThumbnailOptions | undefined) => ({
  maxEdge: clampMaxEdge(Number((options !== null && options !== undefined ? options.maxEdge : undefined) ?? DEFAULT_THUMB_MAX_EDGE)),
  quality: clampQuality(Number((options !== null && options !== undefined ? options.quality : undefined) ?? DEFAULT_THUMB_QUALITY)),
});

const normalizeProjectPath = (value: string | null | undefined): string =>
  typeof value === 'string' && value.trim() ? value.trim() : '';

const buildRequestKey = (
  filesPath: string,
  options: ThumbnailOptions | undefined
): string => {
  const { maxEdge, quality } = normalizeOptions(options);
  const qualityToken = Math.round(quality * 100);
  return `${filesPath}|e=${maxEdge}|q=${qualityToken}`;
};

export const ensureImageThumbnail = async (
  sourceUrl: string,
  options: ThumbnailOptions | undefined
): Promise<void> => {
  const normalized = normalizeLocalFileUrl(sourceUrl);
  const rawAssetId = options !== undefined ? options.assetId : undefined;
  const assetId = typeof rawAssetId === 'string' && rawAssetId.trim() ? rawAssetId.trim() : '';
  if (!assetId) return;
  const optionProjectPath = normalizeProjectPath((options !== null && options !== undefined ? options.projectPath : undefined));

  const { maxEdge, quality } = normalizeOptions(options);
  const requestIdentity = `${optionProjectPath}|${normalized ?? `asset:${assetId}`}`;
  const requestKey = buildRequestKey(requestIdentity, {
    assetId: undefined,
    projectPath: undefined,
    maxEdge,
    quality,
  });
  const inflight = inflightRequests.get(requestKey);
  if (inflight) {
    await inflight;
    return;
  }

  const request = (async () => {
    const projectPath = optionProjectPath || (await getCurrentProjectPath().catch(() => null));
    if (!projectPath) return;
    await createImageThumbnail({
      projectPath,
      assetId,
      maxEdge,
      quality,
    });
  })();

  inflightRequests.set(requestKey, request);
  try {
    await request;
  } catch (error) {
    console.warn('[imageThumbnail] 请求缩略图修复失败', error);
  } finally {
    inflightRequests.delete(requestKey);
  }
};

export const DEFAULT_IMAGE_THUMBNAIL_OPTIONS = {
  maxEdge: DEFAULT_THUMB_MAX_EDGE,
  quality: DEFAULT_THUMB_QUALITY,
};
