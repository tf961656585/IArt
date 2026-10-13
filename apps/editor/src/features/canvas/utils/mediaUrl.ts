import { classifyMediaUrl } from '@/features/models/shared/mediaResolutionTypes';

import mediaConstantsModule from '@iart/utils/media-constants';
const { LOCAL_MEDIA_SCHEME } = mediaConstantsModule;

export { LOCAL_MEDIA_SCHEME };

export const LOCAL_FILES_RENDER_ONLY_ERROR = '结果还没取回本地，暂时无法预览';

/**
 * Normalize a local-media URL. Returns the URL as-is if it is a local-media:// URL.
 * Legacy /project-media/ and /files/ paths are no longer supported.
 */
export const normalizeLocalFileUrl = (
  rawUrl: string | null | undefined
): string | null => {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith(LOCAL_MEDIA_SCHEME)) return trimmed;
  return null;
};

/**
 * Normalize a local-media URL with query/hash preserved.
 * Returns the URL as-is if it is a local-media:// URL.
 */
export const normalizeLocalFileUrlWithQuery = (
  rawUrl: string | null | undefined
): string | null => {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith(LOCAL_MEDIA_SCHEME)) return trimmed;
  return null;
};

import mediaFileKeyModule from '@iart/utils/media-file-key';
const { extractMediaFileKey } = mediaFileKeyModule;

export { extractMediaFileKey as extractFileKeyFromRuntimeMediaUrl };

export const resolveRenderableMediaUrl = (
  rawUrl: string | null | undefined
): string | null => {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  return trimmed;
};

export type LocalRenderableMediaSource = {
  formalUrl: string | null;
  renderUrl: string | null;
  error: string | null;
};

export const resolveLocalRenderableMediaSource = (
  rawUrl: string | null | undefined
): LocalRenderableMediaSource => {
  const trimmed = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  const classified = classifyMediaUrl(trimmed);
  if (classified.kind === 'local-media') {
    return { formalUrl: trimmed, renderUrl: trimmed, error: null };
  }
  const formalUrl = normalizeLocalFileUrlWithQuery(trimmed);
  return {
    formalUrl,
    renderUrl: formalUrl ? resolveRenderableMediaUrl(formalUrl) : null,
    error: trimmed && !formalUrl ? LOCAL_FILES_RENDER_ONLY_ERROR : null,
  };
};

export const pickRenderableLocalMediaSource = (
  rawUrls: Array<string | null | undefined>
): LocalRenderableMediaSource => {
  for (const rawUrl of rawUrls) {
    const resolved = resolveLocalRenderableMediaSource(rawUrl);
    if (resolved.formalUrl) {
      return resolved;
    }
  }
  return {
    formalUrl: null,
    renderUrl: null,
    error: null,
  };
};
