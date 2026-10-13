import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RuntimeStoreNS from '@/client/store/runtimeStore';

const getRuntimeProjectPathMock = vi.fn(() => '/tmp/demo.iartproj');

vi.mock('@/client/store/runtimeStore', async () => {
  const actual = await vi.importActual<typeof RuntimeStoreNS>('@/client/store/runtimeStore');
  return {
    ...actual,
    getRuntimeProjectPath: getRuntimeProjectPathMock,
  };
});

vi.mock('@/client/utils/hubFetch', () => ({
  isHubRuntime: vi.fn(() => false),
}));

describe('media processing api (非 Hub 兼容路径)', () => {
  beforeEach(() => {
    vi.resetModules();
    getRuntimeProjectPathMock.mockReturnValue('/tmp/demo.iartproj');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: vi.fn(() => null),
        setItem: vi.fn(),
        removeItem: vi.fn(),
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('thumbnail 兼容路径仍直连原有 /api/media/*/thumbnail HTTP 入口', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/media/image/thumbnail')) {
        return new Response(
          JSON.stringify({
            success: true,
            url: '/files/thumbnails/image-thumb.webp',
            meta: { sourceWidth: 100, sourceHeight: 50, sourceAspectRatio: 2 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/api/media/video/thumbnail')) {
        return new Response(
          JSON.stringify({
            success: true,
            url: '/files/thumbnails/video-thumb.jpg',
            meta: { width: 320, quality: 0.7, timeSec: 0 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { createImageThumbnail } = await import('@/client/api/imageThumbnail');
    const { createVideoThumbnail } = await import('@/client/api/videoThumbnail');

    const imageResult = await createImageThumbnail({
      projectPath: '/tmp/demo.iartproj',
      assetId: 'asset-image-1',
    });
    const videoResult = await createVideoThumbnail({
      projectPath: '/tmp/demo.iartproj',
      assetId: 'asset-video-1',
    });

    expect(imageResult.url).toBe('/files/thumbnails/image-thumb.webp');
    expect(videoResult.url).toBe('/files/thumbnails/video-thumb.jpg');
    const calledUrls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(calledUrls.some((url) => url.includes('/api/media/image/thumbnail'))).toBe(true);
    expect(calledUrls.some((url) => url.includes('/api/media/video/thumbnail'))).toBe(true);
  });

  it('本地图像处理兼容路径只直连统一 /api/image/process HTTP adapter', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/image/process')) {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { operation?: { type?: string } } : {};
        const operationType = body.operation?.type === 'edgeDetect' ? 'edgeDetect' : 'transform';
        const outputUrl = operationType === 'edgeDetect'
          ? '/project-media/prj_demo/edge.png'
          : '/project-media/prj_demo/transform.png';
        return new Response(
          JSON.stringify({
            resultType: 'single',
            operationType,
            success: true,
            assetId: 'asset-processed-1',
            mediaAsset: {
              id: 'asset-processed-1',
              mediaType: 'image',
              original: {
                url: outputUrl,
                projectRef: 'prj_demo',
                fileKey: outputUrl.replace('/project-media/prj_demo/', ''),
                sourceUrl: '/files/source.png',
                mimeType: 'image/png',
                sizeBytes: null,
                width: 512,
                height: 512,
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
              lifecycle: { createdAt: 1, updatedAt: 1 },
            },
            url: outputUrl,
            width: 512,
            height: 512,
            ...(operationType === 'edgeDetect' ? { mode: 'sobel', threshold: 128 } : {}),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { edgeDetectImage } = await import('@/client/api/imageEdgeDetect');
    const { transformImage } = await import('@/client/api/imageTransform');

    const edgeResult = await edgeDetectImage('/files/source.png', 128, 'sobel');
    const transformResult = await transformImage('/files/source.png', [{ type: 'mirrorX' }]);

    expect(edgeResult.url).toBe('/project-media/prj_demo/edge.png');
    expect(edgeResult.assetId).toBe('asset-processed-1');
    expect(transformResult.url).toBe('/project-media/prj_demo/transform.png');
    const calledUrls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(calledUrls.filter((url) => url.includes('/api/image/process'))).toHaveLength(2);
    expect(calledUrls.some((url) => url.includes('/api/image/edge-detect'))).toBe(false);
    expect(calledUrls.some((url) => url.includes('/api/image/transform'))).toBe(false);
  });
});
