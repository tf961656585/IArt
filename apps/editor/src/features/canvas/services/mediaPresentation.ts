import type {
  MediaAsset,
  MediaAssetThumbnailError,
  MediaAssetThumbnailStatus,
  ProjectMediaAssets,
  ProjectMediaType,
} from '@iart/contracts';
import { resolveRenderableMediaUrl } from '../utils/mediaUrl';
import { resolveMediaAssetForThumbnail } from './mediaThumbnailResolver';

export interface MediaPresentationHoverMeta {
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  mimeType: string | null;
}

export type MediaPresentationContentState =
  | 'asset-ready'
  | 'asset-missing'
  | 'source-only';

export type MediaPresentationDormantState =
  | { kind: 'thumbnail'; url: string }
  | {
      kind: 'thumbnail-status';
      status: MediaAssetThumbnailStatus;
      message: string;
      error: MediaAssetThumbnailError | null;
    }
  | { kind: 'source'; url: string; message: string }
  | { kind: 'unavailable'; message: string };

export type MediaPresentationActiveState =
  | { kind: 'original'; url: string }
  | { kind: 'source'; url: string; message: string }
  | { kind: 'unavailable'; message: string };

export interface MediaPresentation {
  assetId: string | null;
  mediaType: ProjectMediaType | null;
  contentState: MediaPresentationContentState;
  dormant: MediaPresentationDormantState;
  active: MediaPresentationActiveState;
  originalFormalUrl: string | null;
  originalRenderUrl: string | null;
  thumbnailFormalUrl: string | null;
  thumbnailRenderUrl: string | null;
  dormantDisplayUrl: string | null;
  activeDisplayUrl: string | null;
  downloadUrl: string | null;
  previewUrl: string | null;
  hoverMeta: MediaPresentationHoverMeta | null;
  thumbnailStatus: MediaAssetThumbnailStatus;
  thumbnailError: MediaAssetThumbnailError | null;
}

export interface MediaPresentationResolverInput {
  mediaAssets: ProjectMediaAssets;
  mediaType: ProjectMediaType | null | undefined;
  assetId: string | null | undefined;
  sourceUrl: string | null | undefined;
  projectRef: string | null | undefined;
  fileKey: string | null | undefined;
}

const extractHoverMeta = (asset: MediaAsset): MediaPresentationHoverMeta => ({
  sizeBytes: asset.original.sizeBytes ?? null,
  width: asset.original.width ?? null,
  height: asset.original.height ?? null,
  durationMs: asset.original.durationMs ?? null,
  mimeType: asset.original.mimeType ?? null,
});

export const resolveThumbnailStatusMessage = (
  status: MediaAssetThumbnailStatus,
  error: MediaAssetThumbnailError | null,
): string => {
  if (status === 'generating') return '缩略图生成中';
  if (status === 'stale') return '缩略图等待更新';
  if (status === 'failed') {
    const errorMessage = error !== null ? error.message : undefined;
    const message = typeof errorMessage === 'string' ? errorMessage.trim() : '';
    return message ? `缩略图生成失败：${message}` : '缩略图生成失败';
  }
  if (status === 'ready') return '缩略图有问题';
  return '缩略图还没生成';
};

const noAssetPresentation = (
  sourceUrl: string | null,
  mediaType: ProjectMediaType | null,
  assetId: string | null,
): MediaPresentation => {
  const renderUrl = sourceUrl ? resolveRenderableMediaUrl(sourceUrl) : null;
  const contentState: MediaPresentationContentState = renderUrl ? 'source-only' : 'asset-missing';
  const dormant: MediaPresentationDormantState = renderUrl
    ? { kind: 'source', url: renderUrl, message: '这个素材还没保存到项目里' }
    : { kind: 'unavailable', message: '素材还没准备好' };
  const active: MediaPresentationActiveState = renderUrl
    ? { kind: 'source', url: renderUrl, message: '这个素材还没保存到项目里' }
    : { kind: 'unavailable', message: '素材还没准备好' };
  return {
    assetId,
    mediaType,
    contentState,
    dormant,
    active,
    originalFormalUrl: sourceUrl,
    originalRenderUrl: renderUrl,
    thumbnailFormalUrl: null,
    thumbnailRenderUrl: null,
    dormantDisplayUrl: renderUrl,
    activeDisplayUrl: renderUrl,
    downloadUrl: sourceUrl,
    previewUrl: sourceUrl,
    hoverMeta: null,
    thumbnailStatus: 'missing',
    thumbnailError: null,
  };
};

const fromAsset = (asset: MediaAsset): MediaPresentation => {
  const originalFormalUrl = typeof asset.original.url === 'string' && asset.original.url.trim()
    ? asset.original.url
    : null;
  const originalRenderUrl = resolveRenderableMediaUrl(originalFormalUrl);
  const thumbnailReady = asset.thumbnail.status === 'ready' && Boolean(asset.thumbnail.url);
  const thumbnailFormalUrl = thumbnailReady ? asset.thumbnail.url : null;
  const thumbnailRenderUrl = thumbnailReady ? resolveRenderableMediaUrl(asset.thumbnail.url) : null;
  const thumbnailError = asset.thumbnail.error ?? null;
  const contentState: MediaPresentationContentState = originalRenderUrl
    ? 'asset-ready'
    : 'asset-missing';
  const thumbnailStatus = asset.thumbnail.status;
  const thumbnailStatusMessage = resolveThumbnailStatusMessage(thumbnailStatus, thumbnailError);
  const isThumbnailNonReadyStatus = thumbnailStatus !== 'ready';
  const dormant: MediaPresentationDormantState = thumbnailRenderUrl
    ? { kind: 'thumbnail', url: thumbnailRenderUrl }
    : isThumbnailNonReadyStatus
      ? { kind: 'thumbnail-status', status: thumbnailStatus, message: thumbnailStatusMessage, error: thumbnailError }
      : originalRenderUrl
        ? { kind: 'source', url: originalRenderUrl, message: '缩略图还没生成，先显示原图' }
        : { kind: 'unavailable', message: '原文件不可用，请重新导入' };
  const active: MediaPresentationActiveState = originalRenderUrl
    ? { kind: 'original', url: originalRenderUrl }
    : { kind: 'unavailable', message: '原文件不可用，请重新导入' };

  return {
    assetId: asset.id,
    mediaType: asset.mediaType,
    contentState,
    dormant,
    active,
    originalFormalUrl,
    originalRenderUrl,
    thumbnailFormalUrl,
    thumbnailRenderUrl,
    dormantDisplayUrl: dormant.kind === 'thumbnail' ? thumbnailRenderUrl : (dormant.kind === 'source' ? originalRenderUrl : null),
    activeDisplayUrl: originalRenderUrl,
    downloadUrl: originalFormalUrl,
    previewUrl: originalFormalUrl,
    hoverMeta: extractHoverMeta(asset),
    thumbnailStatus: asset.thumbnail.status,
    thumbnailError,
  };
};

export const resolveMediaPresentation = (input: MediaPresentationResolverInput): MediaPresentation => {
  const resolved = resolveMediaAssetForThumbnail({
    mediaAssets: input.mediaAssets,
    mediaType: input.mediaType ?? 'image',
    assetId: input.assetId,
    sourceUrl: input.sourceUrl,
    projectRef: input.projectRef,
    fileKey: input.fileKey,
  });

  if (!resolved.asset) {
    return noAssetPresentation(resolved.sourceUrl, input.mediaType ?? null, resolved.assetId);
  }

  return fromAsset(resolved.asset);
};
