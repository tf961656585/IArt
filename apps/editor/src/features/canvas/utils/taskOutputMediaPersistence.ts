import { ContentCacheManager } from '../services/contentCacheManager';
import { storeBase64Media } from '../services/mediaStorage';
import { commitImportedMediaAsset, registerAndCommitMediaAsset } from '../services/localMediaImport';
import { normalizeLocalFileUrlWithQuery } from './mediaUrl';
import { ensureLocalFilesImageUrl } from './mediaUtils';
import type { TaskOutputMediaType } from './taskOutputMedia';
import { persistResultMedia } from '@/client/api/media';
import { isHubRuntime } from '@/client/utils/hubFetch';
import type { MediaAsset } from '@iart/contracts';

export type TaskOutputMediaPersistenceSource = 'execution' | 'result-reload';

const isBase64DataUrl = (value: string): boolean => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.startsWith('data:') && trimmed.includes('base64,');
};

const normalizeCandidates = (candidates: string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of candidates) {
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
};

const resolveCandidatesWithFallback = async <T>(
  candidates: string[],
  resolveOne: (candidate: string) => Promise<T | null>
): Promise<T | null> => {
  const normalized = normalizeCandidates(candidates);
  if (normalized.length === 0) return null;

  for (const candidate of normalized) {
    try {
      const resolved = await resolveOne(candidate);
      if (resolved) return resolved;
    } catch {
      // try next candidate
    }
  }

  // persistence failed for all candidates
  return null;
};

export type ResolvedResultAreaOutputMedia = {
  url: string;
  assetId: string | null;
  mediaAsset: MediaAsset | null;
  mediaType: TaskOutputMediaType;
  mimeType: string | null;
  sizeBytes: number | null;
};

type ResolvedResultAreaOutputMediaExtras = {
  assetId: string | null | undefined;
  mediaAsset: MediaAsset | null | undefined;
  mimeType: string | null | undefined;
  sizeBytes: number | null | undefined;
};

const buildResolvedResultAreaOutputMedia = (
  url: string,
  mediaType: TaskOutputMediaType,
  extras: Partial<ResolvedResultAreaOutputMediaExtras> = {},
): ResolvedResultAreaOutputMedia => ({
  url,
  assetId: typeof extras.assetId === 'string' ? extras.assetId : null,
  mediaAsset: extras.mediaAsset ?? null,
  mediaType,
  mimeType: typeof extras.mimeType === 'string' ? extras.mimeType : null,
  sizeBytes: typeof extras.sizeBytes === 'number' ? extras.sizeBytes : null,
});

export type ResolvedNodeMediaOutput = {
  url: string;
  assetId: string | null;
};

export async function resolveTaskOutputMediaCandidatesForNode(params: {
  candidates: string[];
  nodeGraphId: string;
  nodeId: string;
  mediaType: TaskOutputMediaType;
  source: TaskOutputMediaPersistenceSource;
  originalUrl: string;
  filenamePrefix: string | undefined;
}): Promise<ResolvedNodeMediaOutput | null> {
  return resolveCandidatesWithFallback(params.candidates, async (candidate) => {
    const normalizedLocal = normalizeLocalFileUrlWithQuery(candidate);
    if (normalizedLocal) {
      const registered = await registerAndCommitMediaAsset(normalizedLocal, params.mediaType, undefined);
      return { url: normalizedLocal, assetId: registered.assetId };
    }

    if (isBase64DataUrl(candidate)) {
      const stored = await storeBase64Media(candidate, {
        nodeGraphId: params.nodeGraphId,
        nodeId: params.nodeId,
        source: params.source,
        originalUrl: params.originalUrl,
        filenamePrefix: params.filenamePrefix ?? 'canvas',
      });
      const nextUrl = normalizeLocalFileUrlWithQuery(stored.url) ?? stored.url;
      const registered = await registerAndCommitMediaAsset(nextUrl, params.mediaType, {
        sizeBytes: stored.sizeBytes,
        mimeType: stored.mimeType,
        width: undefined,
        height: undefined,
        durationMs: undefined,
      });
      return { url: nextUrl, assetId: registered.assetId };
    }

    if (/^https?:\/\//i.test(candidate)) {
      if (isHubRuntime()) {
        try {
          const stored = await persistResultMedia({
            url: candidate,
            mediaType: params.mediaType,
            filenamePrefix: params.filenamePrefix ?? 'canvas',
            originalUrl: params.originalUrl,
          });
          const nextUrl = normalizeLocalFileUrlWithQuery(stored.url) ?? stored.url;
          let assetId: string | null = stored.assetId ?? null;
          if (stored.mediaAsset) {
            commitImportedMediaAsset(stored.mediaAsset);
          }
          if (!assetId) {
            const registered = await registerAndCommitMediaAsset(nextUrl, params.mediaType, {
              sizeBytes: stored.sizeBytes,
              mimeType: stored.mimeType,
              width: undefined,
              height: undefined,
              durationMs: undefined,
            });
            assetId = registered.assetId;
          }
          return { url: nextUrl, assetId };
        } catch {
          return null;
        }
      }
      try {
        ContentCacheManager.enqueue({
          nodeId: params.nodeId,
          nodeGraphId: params.nodeGraphId,
          url: candidate,
          mediaType: params.mediaType,
        });
      } catch {
        // ignore
      }
      return null;
    }

    return null;
  });
}

export async function resolveTaskOutputMediaCandidatesForResultAreaItem(params: {
  candidates: string[];
  nodeGraphId: string;
  resultAreaNodeId: string;
  itemId: string;
  mediaType: TaskOutputMediaType;
  source: TaskOutputMediaPersistenceSource;
  originalUrl: string;
  filenamePrefix: string | undefined;
  allowDiskWrite: boolean | undefined;
  resolveAssetId: (url: string, mediaType: TaskOutputMediaType) => string | null | undefined | undefined;
}): Promise<ResolvedResultAreaOutputMedia | null> {
  const allowDiskWrite = params.allowDiskWrite ?? true;
  const resolveFormalAssetId = (url: string): string | null => {
    const assetId = (params.resolveAssetId !== null && params.resolveAssetId !== undefined ? params.resolveAssetId(url, params.mediaType) : undefined);
    return typeof assetId === 'string' && assetId.trim() ? assetId.trim() : null;
  };
  const buildFormalResolvedResultAreaOutputMedia = (
    url: string,
    extras: Partial<ResolvedResultAreaOutputMediaExtras> = {},
  ): ResolvedResultAreaOutputMedia | null => {
    const assetId =
      typeof extras.assetId === 'string' && extras.assetId.trim()
        ? extras.assetId.trim()
        : resolveFormalAssetId(url);
    if (!assetId) return null;
    return buildResolvedResultAreaOutputMedia(url, params.mediaType, {
      ...extras,
      assetId,
    });
  };

  return resolveCandidatesWithFallback(params.candidates, async (candidate) => {
    const normalizedLocal = normalizeLocalFileUrlWithQuery(candidate);
    if (normalizedLocal) {
      if (isHubRuntime()) {
        try {
          const stored = await persistResultMedia({
            url: normalizedLocal,
            mediaType: params.mediaType,
            filenamePrefix: params.filenamePrefix ?? 'canvas',
            originalUrl: params.originalUrl,
          });
          const nextUrl = normalizeLocalFileUrlWithQuery(stored.url) ?? normalizedLocal;
          return buildFormalResolvedResultAreaOutputMedia(nextUrl, stored);
        } catch {
          return buildFormalResolvedResultAreaOutputMedia(normalizedLocal);
        }
      }
      return buildFormalResolvedResultAreaOutputMedia(normalizedLocal);
    }

    // 避免在不支持/不期望落盘的运行时阻塞 UI（如非 Hub 环境）
    if (!allowDiskWrite) {
      return null;
    }

    if (isBase64DataUrl(candidate)) {
      const stored = await storeBase64Media(candidate, {
        nodeGraphId: params.nodeGraphId,
        nodeId: params.resultAreaNodeId,
        source: params.source,
        originalUrl: params.originalUrl,
        filenamePrefix: params.filenamePrefix ?? 'canvas',
      });
      const storedUrl = normalizeLocalFileUrlWithQuery(stored.url) ?? stored.url;
      if (isHubRuntime()) {
        try {
          const persisted = await persistResultMedia({
            url: storedUrl,
            mediaType: params.mediaType,
            filenamePrefix: params.filenamePrefix ?? 'canvas',
            originalUrl: params.originalUrl,
          });
          return buildFormalResolvedResultAreaOutputMedia(
            normalizeLocalFileUrlWithQuery(persisted.url) ?? storedUrl,
            persisted,
          );
        } catch {
          return buildFormalResolvedResultAreaOutputMedia(storedUrl, stored);
        }
      }
      return buildFormalResolvedResultAreaOutputMedia(storedUrl, stored);
    }

    if (params.mediaType === 'image') {
      if (isHubRuntime()) {
        try {
          const stored = await persistResultMedia({
            url: candidate,
            mediaType: params.mediaType,
            filenamePrefix: params.filenamePrefix ?? 'canvas',
            originalUrl: params.originalUrl,
          });
          const nextUrl = normalizeLocalFileUrlWithQuery(stored.url) ?? null;
          return nextUrl ? buildFormalResolvedResultAreaOutputMedia(nextUrl, stored) : null;
        } catch {
          return null;
        }
      }
      try {
        const stored = await ensureLocalFilesImageUrl(candidate);
        const nextUrl = normalizeLocalFileUrlWithQuery(stored) ?? stored;
        return buildFormalResolvedResultAreaOutputMedia(nextUrl);
      } catch {
        return null;
      }
    }

    if (/^https?:\/\//i.test(candidate)) {
      if (isHubRuntime()) {
        try {
          const stored = await persistResultMedia({
            url: candidate,
            mediaType: params.mediaType,
            filenamePrefix: params.filenamePrefix ?? 'canvas',
            originalUrl: params.originalUrl,
          });
          const nextUrl = normalizeLocalFileUrlWithQuery(stored.url) ?? null;
          return nextUrl ? buildFormalResolvedResultAreaOutputMedia(nextUrl, stored) : null;
        } catch {
          return null;
        }
      }
      return null;
    }

    return null;
  });
}
