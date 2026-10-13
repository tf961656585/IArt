import { describe, expect, it, vi } from 'vitest';
import type * as MediaUrl from '../../utils/mediaUrl';

vi.mock('../../utils/mediaUrl', async (importOriginal) => {
  const actual = await importOriginal() as typeof MediaUrl;
  return {
    ...actual,
    resolveRenderableMediaUrl: (url: string | null | undefined) =>
      url ?? null,
  };
});

vi.mock('@/client/store/runtimeStore', () => ({
  getRuntimeBackendBaseUrl: () => 'http://127.0.0.1:4100',
}));

import type { MediaAsset, ProjectMediaAssets } from '@iart/contracts';
import {
  createMediaAssetFixture,
  createMediaAssetMapFixture,
  createMediaAssetThumbnailFixture,
} from '../../components/__tests__/fixtures/canvasTestBuilders';
import { resolveMediaPresentation } from '../mediaPresentation';
import type { MediaPresentationResolverInput } from '../mediaPresentation';

const makeAsset = (
  overrides: Partial<MediaAsset> & { id: string },
): MediaAsset => {
  const { id, ...rest } = overrides;
  return createMediaAssetFixture({
  id,
  original: {
    url: `/project-media/project-a/images/${id}.png`,
    projectRef: 'project-a',
    fileKey: `images/${id}.png`,
    sourceUrl: `/files/${id}.png`,
    sourceFileName: null,
    mimeType: 'image/png',
    sizeBytes: 1024,
    width: 800,
    height: 600,
    durationMs: null,
    fps: null,
  },
  thumbnail: createMediaAssetThumbnailFixture({
    url: `/files/thumbnails/${id}.webp`,
    status: 'ready',
  }),
  ...rest,
  });
};

const readyAsset = makeAsset({ id: 'asset-1' });
const noThumbnailAsset: MediaAsset = {
  ...makeAsset({ id: 'asset-2' }),
  thumbnail: createMediaAssetThumbnailFixture({ status: 'missing' }),
};
const generatingThumbnailAsset: MediaAsset = {
  ...makeAsset({ id: 'asset-3' }),
  thumbnail: createMediaAssetThumbnailFixture({ status: 'generating' }),
};
const failedThumbnailAsset: MediaAsset = {
  ...makeAsset({ id: 'asset-4' }),
  thumbnail: createMediaAssetThumbnailFixture({
    status: 'failed',
    error: { code: 'decode_failed', message: '无法读取缩略图源', failedAt: 2 },
  }),
};

const videoReadyAsset: MediaAsset = {
  ...makeAsset({ id: 'video-1' }),
  mediaType: 'video',
  original: {
    url: '/project-media/project-a/videos/clip.mp4',
    projectRef: 'project-a',
    fileKey: 'videos/clip.mp4',
    sourceUrl: '/files/clip.mp4',
    sourceFileName: null,
    mimeType: 'video/mp4',
    sizeBytes: 2048,
    width: 1920,
    height: 1080,
    durationMs: 5000,
    fps: null,
  },
};

const localMediaAsset: MediaAsset = {
  ...makeAsset({ id: 'local-1' }),
  original: {
    url: '/project-media/project-a/images/local.png',
    projectRef: 'project-a',
    fileKey: 'images/local.png',
    sourceUrl: '/files/local.png',
    sourceFileName: null,
    mimeType: 'image/png',
    sizeBytes: 512,
    width: 640,
    height: 480,
    durationMs: null,
    fps: null,
  },
};

const mediaAssets: ProjectMediaAssets = createMediaAssetMapFixture([
  readyAsset,
  noThumbnailAsset,
  generatingThumbnailAsset,
  failedThumbnailAsset,
  videoReadyAsset,
  localMediaAsset,
]);

const createResolverInput = (
  overrides: Partial<MediaPresentationResolverInput>,
): MediaPresentationResolverInput => ({
  mediaAssets,
  mediaType: null,
  assetId: null,
  sourceUrl: null,
  projectRef: null,
  fileKey: null,
  ...overrides,
});

describe('resolveMediaPresentation', () => {
  it('asset 存在且 thumbnail ready → dormant 使用 thumbnail render URL，active 使用 original render URL', () => {
    const result = resolveMediaPresentation(createResolverInput({
      mediaAssets,
      mediaType: 'image',
      assetId: 'asset-1',
    }));

    expect(result.assetId).toBe('asset-1');
    expect(result.contentState).toBe('asset-ready');
    expect(result.dormant).toEqual({ kind: 'thumbnail', url: readyAsset.thumbnail.url });
    expect(result.active).toEqual({ kind: 'original', url: readyAsset.original.url });
    expect(result.thumbnailStatus).toBe('ready');
    expect(result.dormantDisplayUrl).toBe(readyAsset.thumbnail.url);
    expect(result.activeDisplayUrl).toBe(readyAsset.original.url);
  });

  it('asset 存在但 thumbnail missing → content 存在，dormant 为 thumbnail-status 占位，active 使用 original', () => {
    const result = resolveMediaPresentation(createResolverInput({
      mediaAssets,
      mediaType: 'image',
      assetId: 'asset-2',
    }));

    expect(result.assetId).toBe('asset-2');
    expect(result.contentState).toBe('asset-ready');
    expect(result.thumbnailStatus).toBe('missing');
    expect(result.dormant).toEqual({
      kind: 'thumbnail-status',
      status: 'missing',
      message: '缩略图还没生成',
      error: null,
    });
    expect(result.active).toEqual({ kind: 'original', url: noThumbnailAsset.original.url });
    expect(result.dormantDisplayUrl).toBeNull();
    expect(result.activeDisplayUrl).toBe(noThumbnailAsset.original.url);
  });

  it('asset 存在但 thumbnail generating → content 存在，dormant 为 thumbnail-status 占位', () => {
    const result = resolveMediaPresentation(createResolverInput({
      mediaAssets,
      mediaType: 'image',
      assetId: 'asset-3',
    }));

    expect(result.contentState).toBe('asset-ready');
    expect(result.dormant).toEqual({
      kind: 'thumbnail-status',
      status: 'generating',
      message: '缩略图生成中',
      error: null,
    });
    expect(result.activeDisplayUrl).toBe(generatingThumbnailAsset.original.url);
  });

  it('asset 存在但 thumbnail failed → content 存在，dormant 为 thumbnail-status 占位', () => {
    const result = resolveMediaPresentation(createResolverInput({
      mediaAssets,
      mediaType: 'image',
      assetId: 'asset-4',
    }));

    expect(result.contentState).toBe('asset-ready');
    expect(result.dormant).toEqual({
      kind: 'thumbnail-status',
      status: 'failed',
      message: '缩略图生成失败：无法读取缩略图源',
      error: { code: 'decode_failed', message: '无法读取缩略图源', failedAt: 2 },
    });
    expect(result.thumbnailError?.message).toBe('无法读取缩略图源');
    expect(result.activeDisplayUrl).toBe(failedThumbnailAsset.original.url);
  });

  it('hoverMeta 来自 MediaAsset.original（sizeBytes, width, height）', () => {
    const result = resolveMediaPresentation(createResolverInput({
      mediaAssets,
      mediaType: 'video',
      assetId: 'video-1',
    }));

    expect(result.hoverMeta).toEqual({
      sizeBytes: 2048,
      width: 1920,
      height: 1080,
      durationMs: 5000,
      mimeType: 'video/mp4',
    });
  });

  it('没有 asset 且 sourceUrl 为旧 /project-media/ 协议地址 → 归一为不可用（asset-missing）', () => {
    const sourceUrl = '/project-media/project-b/images/missing.png';
    const result = resolveMediaPresentation(createResolverInput({
      mediaAssets,
      mediaType: 'image',
      sourceUrl,
    }));

    expect(result.assetId).toBeNull();
    expect(result.mediaType).toBe('image');
    expect(result.contentState).toBe('asset-missing');
    expect(result.dormant).toEqual({
      kind: 'unavailable',
      message: '素材还没准备好',
    });
    expect(result.active).toEqual({
      kind: 'unavailable',
      message: '素材还没准备好',
    });
    expect(result.originalFormalUrl).toBeNull();
    expect(result.dormantDisplayUrl).toBeNull();
    expect(result.activeDisplayUrl).toBeNull();
    expect(result.thumbnailStatus).toBe('missing');
    expect(result.hoverMeta).toBeNull();
  });

  it('downloadUrl / previewUrl 都指向 originalFormalUrl', () => {
    const result = resolveMediaPresentation(createResolverInput({
      mediaAssets,
      mediaType: 'video',
      assetId: 'video-1',
    }));

    expect(result.originalFormalUrl).toBe(videoReadyAsset.original.url);
    expect(result.downloadUrl).toBe(result.originalFormalUrl);
    expect(result.previewUrl).toBe(result.originalFormalUrl);
  });

  it('local-media asset 也能正常输出 presentation', () => {
    const result = resolveMediaPresentation(createResolverInput({
      mediaAssets,
      mediaType: 'image',
      assetId: 'local-1',
      sourceUrl: 'local-media://image/imported.png',
    }));

    expect(result.assetId).toBe('local-1');
    expect(result.mediaType).toBe('image');
    expect(result.originalFormalUrl).toBe(localMediaAsset.original.url);
    expect(result.thumbnailStatus).toBe('ready');
    expect(result.dormantDisplayUrl).toBe(localMediaAsset.thumbnail.url);
    expect(result.activeDisplayUrl).toBe(localMediaAsset.original.url);
    expect(result.hoverMeta).toEqual({
      sizeBytes: 512,
      width: 640,
      height: 480,
      durationMs: null,
      mimeType: 'image/png',
    });
  });
});
