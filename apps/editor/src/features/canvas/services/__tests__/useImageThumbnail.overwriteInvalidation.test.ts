import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCanvasStore } from '../../store/canvasStore';

const createImageThumbnailMock = vi.fn<(...args: unknown[]) => Promise<unknown>>();
vi.mock('@/client/api/imageThumbnail', () => ({
  createImageThumbnail: (...args: unknown[]) => createImageThumbnailMock(...args),
}));

const getCurrentProjectPathMock = vi.fn<(...args: unknown[]) => Promise<string>>();
vi.mock('../../storage', () => ({
  getCurrentProjectPath: (...args: unknown[]) => getCurrentProjectPathMock(...args),
}));

const buildMediaAsset = (status: 'missing' | 'generating' | 'ready') => ({
  id: 'asset-image-1',
  mediaType: 'image' as const,
  original: {
    url: 'local-media://project-a/images/foo.png',
    projectRef: 'project-a',
    fileKey: 'images/foo.png',
    sourceUrl: null,
    sourceFileName: null,
    mimeType: 'image/png',
    sizeBytes: 128,
    width: 400,
    height: 200,
    durationMs: null,
    fps: null,
  },
  thumbnail: {
    url: status === 'ready' ? 'local-media://project-a/thumbnails/foo.webp' : null,
    mimeType: status === 'ready' ? 'image/webp' : null,
    width: status === 'ready' ? 256 : null,
    height: status === 'ready' ? 128 : null,
    status,
    generatedAt: status === 'ready' ? 2 : null,
    error: null,
  },
  lifecycle: {
    createdAt: 1,
    updatedAt: 2,
  },
});

describe('useImageThumbnail project-state flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCurrentProjectPathMock.mockResolvedValue('/tmp/project');
    useCanvasStore.setState((state) => {
      state.mediaAssets = {
        'asset-image-1': buildMediaAsset('missing'),
      };
    });
  });

  it('missing -> generating -> ready 时渲染结果从 original 切到正式 thumbnail', async () => {
    const { useImageThumbnail } = await import('../../components/nodes/shared/useImageThumbnail');
    const { result } = renderHook(() =>
      useImageThumbnail('local-media://project-a/images/foo.png', { maxEdge: 512, quality: 0.8 }, true)
    );

    await waitFor(() =>
      expect(result.current).toMatchObject({
        kind: 'original',
        url: 'local-media://project-a/images/foo.png',
      })
    );

    act(() => {
      useCanvasStore.setState((state) => {
        state.mediaAssets = {
          'asset-image-1': buildMediaAsset('generating'),
        };
      });
    });

    await waitFor(() =>
      expect(result.current).toMatchObject({
        kind: 'original',
        url: 'local-media://project-a/images/foo.png',
      })
    );

    act(() => {
      useCanvasStore.setState((state) => {
        state.mediaAssets = {
          'asset-image-1': buildMediaAsset('ready'),
        };
      });
    });

    await waitFor(() =>
      expect(result.current).toMatchObject({
        kind: 'thumbnail',
        url: 'local-media://project-a/thumbnails/foo.webp',
        sourceMeta: {
          width: 400,
          height: 200,
          aspectRatio: 2,
        },
      })
    );
  });

  it('assetId 优先时解析到对应资产的 original', async () => {
    useCanvasStore.setState((state) => {
      state.mediaAssets = {
        'asset-image-1': buildMediaAsset('missing'),
        'asset-image-2': {
          ...buildMediaAsset('missing'),
          id: 'asset-image-2',
      original: {
        ...buildMediaAsset('missing').original,
        url: '/files/other.png',
        projectRef: null,
        fileKey: null,
        sourceUrl: null,
      },
        },
      };
    });

    const { useMediaThumbnail } = await import('../../components/nodes/shared/useMediaThumbnail');
    const { result } = renderHook(() =>
      useMediaThumbnail({
        mediaType: 'image',
        assetId: 'asset-image-2',
        sourceUrl: '/files/foo.png',
        projectRef: undefined,
        fileKey: undefined,
        enabled: true,
        maxEdge: undefined,
        width: undefined,
        quality: undefined,
        timeSec: undefined,
      }),
    );

    await waitFor(() =>
      expect(result.current).toMatchObject({
        assetId: 'asset-image-2',
        kind: 'original',
        originalUrl: '/files/other.png',
      }),
    );
  });

  it('local-media 地址无 assetId 时返回 original 且不触发缩略图修复', async () => {
    useCanvasStore.setState((state) => {
      state.mediaAssets = {};
    });

    const { useImageThumbnail } = await import('../../components/nodes/shared/useImageThumbnail');
    const { result } = renderHook(() =>
      useImageThumbnail('local-media://image/imported.png', undefined, true),
    );

    await waitFor(() =>
      expect(result.current).toMatchObject({
        kind: 'original',
        url: 'local-media://image/imported.png',
      })
    );
    expect(createImageThumbnailMock).not.toHaveBeenCalled();
  });

  it('local-media 地址有 assetId 时返回 original 等待后端缩略图就绪', async () => {
    useCanvasStore.setState((state) => {
      state.mediaAssets = {
        'asset-local-1': {
          id: 'asset-local-1',
          mediaType: 'image',
          original: {
            url: '/project-media/project-a/images/local.png',
            projectRef: 'project-a',
            fileKey: 'images/local.png',
            sourceUrl: 'local-media://image/imported.png',
            sourceFileName: null,
            mimeType: 'image/png',
            sizeBytes: 256,
            width: 400,
            height: 200,
            durationMs: null,
            fps: null,
          },
          thumbnail: {
            url: null,
            mimeType: null,
            width: null,
            height: null,
            status: 'missing',
            generatedAt: null,
            error: null,
          },
          lifecycle: {
            createdAt: 1,
            updatedAt: 1,
          },
        },
      };
    });

    const { useMediaThumbnail } = await import('../../components/nodes/shared/useMediaThumbnail');
    const { result } = renderHook(() =>
      useMediaThumbnail({
        mediaType: 'image',
        assetId: 'asset-local-1',
        sourceUrl: 'local-media://image/imported.png',
        projectRef: undefined,
        fileKey: undefined,
        enabled: true,
        maxEdge: undefined,
        width: undefined,
        quality: undefined,
        timeSec: undefined,
      }),
    );

    await waitFor(() =>
      expect(result.current).toMatchObject({
        assetId: 'asset-local-1',
        kind: 'original',
        originalUrl: '/project-media/project-a/images/local.png',
      }),
    );
  });
});
