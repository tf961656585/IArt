import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RuntimeStoreNS from '@/client/store/runtimeStore';
import { MockBusinessActionWebSocket, type MockBusinessActionPayload } from './fixtures/businessActionWebSocket';

const getRuntimeBackendBaseUrlMock = vi.fn(() => 'http://127.0.0.1:4100');
const getRuntimeProjectPathMock = vi.fn(() => '/tmp/demo.iartproj');

const mediaAsset = (assetId: string, url: string) => ({
  id: assetId,
  mediaType: 'image',
  original: {
    url,
    projectRef: 'prj_demo',
    fileKey: url.replace('/project-media/prj_demo/', ''),
    sourceUrl: '/project-media/prj_demo/source.png',
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
});

vi.mock('@/client/store/runtimeStore', async () => {
  const actual = await vi.importActual<typeof RuntimeStoreNS>('@/client/store/runtimeStore');
  return {
    ...actual,
    getRuntimeBackendBaseUrl: getRuntimeBackendBaseUrlMock,
    getRuntimeProjectPath: getRuntimeProjectPathMock,
  };
});

vi.mock('@/client/utils/hubFetch', () => ({
  isHubRuntime: vi.fn(() => true),
}));

const resolveMediaProcessingResult = (payload: MockBusinessActionPayload): Record<string, unknown> => {
  return (
      payload.actionName === 'media.image_thumbnail'
        ? {
            success: true,
            url: '/files/thumbnails/image-thumb.webp',
            meta: { sourceWidth: 1024, sourceHeight: 768, sourceAspectRatio: 1.3333 },
          }
        : payload.actionName === 'media.video_thumbnail'
          ? {
              success: true,
              url: '/files/thumbnails/video-thumb.jpg',
              meta: { width: 512, quality: 0.7, timeSec: 0 },
            }
        : payload.actionName === 'media.image_process'
          ? (() => {
              const operation = (payload.payload as { operation?: { type?: string; kernel?: string } }).operation;
              if (operation?.type === 'split') {
                return {
                  resultType: 'split',
                  operationType: 'split',
                  success: true,
                  rows: 1,
                  cols: 2,
                  originalWidth: 512,
                  originalHeight: 512,
                  horizontalPercents: [],
                  verticalPercents: [50],
                  tiles: [
                    { index: 0, row: 0, col: 0, assetId: 'asset-tile-1', mediaAsset: mediaAsset('asset-tile-1', '/project-media/prj_demo/tile-1.png'), url: '/project-media/prj_demo/tile-1.png', width: 256, height: 512, x: 0, y: 0 },
                    { index: 1, row: 0, col: 1, assetId: 'asset-tile-2', mediaAsset: mediaAsset('asset-tile-2', '/project-media/prj_demo/tile-2.png'), url: '/project-media/prj_demo/tile-2.png', width: 256, height: 512, x: 256, y: 0 },
                  ],
                };
              }
              const url = operation?.type === 'edgeDetect'
                ? '/project-media/prj_demo/edge.png'
                : '/project-media/prj_demo/processed.png';
              return {
                resultType: 'single',
                operationType: operation?.type === 'edgeDetect' ? 'edgeDetect' : operation?.type === 'resize' ? 'resize' : operation?.type === 'crop' ? 'crop' : 'transform',
                success: true,
                assetId: 'asset-processed-1',
                mediaAsset: mediaAsset('asset-processed-1', url),
                url,
                width: operation?.type === 'transform' ? 640 : 512,
                height: operation?.type === 'transform' ? 480 : 512,
                ...(operation?.type === 'edgeDetect' ? { mode: 'sobel', threshold: 180 } : {}),
                ...(operation?.type === 'resize' ? { originalWidth: 1024, originalHeight: 768, percent: 50, kernel: operation.kernel } : {}),
                ...(operation?.type === 'crop' ? { originalWidth: 1024, originalHeight: 768, x: 0, y: 0 } : {}),
              };
            })()
          : {
              success: true,
              url: '/files/transforms/rotated.png',
              width: 640,
              height: 480,
            }
  );
};

describe('media processing api (Hub 模式)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    MockBusinessActionWebSocket.reset(resolveMediaProcessingResult);
    getRuntimeBackendBaseUrlMock.mockReturnValue('http://127.0.0.1:4100');
    getRuntimeProjectPathMock.mockReturnValue('/tmp/demo.iartproj');
    vi.stubGlobal('WebSocket', MockBusinessActionWebSocket);
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('测试失败：Hub 媒体处理主路径不应直连旧 HTTP 入口');
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('thumbnail 主路径改为通过 ws business contract 请求 backend，而不是直连旧 /api/media/*/thumbnail', async () => {
    const { createImageThumbnail } = await import('@/client/api/imageThumbnail');
    const { createVideoThumbnail } = await import('@/client/api/videoThumbnail');

    const imageResult = await createImageThumbnail({
      projectPath: '/tmp/demo.iartproj',
      assetId: 'asset-image-1',
      maxEdge: 320,
      quality: 0.75,
    });
    const videoResult = await createVideoThumbnail({
      projectPath: '/tmp/demo.iartproj',
      assetId: 'asset-video-1',
      width: 400,
      quality: 0.65,
      timeSec: 1.2,
    });

    expect(imageResult).toEqual({
      url: '/files/thumbnails/image-thumb.webp',
      meta: { sourceWidth: 1024, sourceHeight: 768, sourceAspectRatio: 1.3333 },
    });
    expect(videoResult).toEqual({
      url: '/files/thumbnails/video-thumb.jpg',
      meta: { width: 512, quality: 0.7, timeSec: 0 },
    });
    expect(MockBusinessActionWebSocket.instances).toHaveLength(2);
    expect(MockBusinessActionWebSocket.instances[0]?.sentPayloads[0]).toEqual(
      expect.objectContaining({
        actionName: 'media.image_thumbnail',
        projectPath: '/tmp/demo.iartproj',
        payload: {
          assetId: 'asset-image-1',
          maxEdge: 320,
          quality: 0.75,
        },
      }),
    );
    expect(MockBusinessActionWebSocket.instances[1]?.sentPayloads[0]).toEqual(
      expect.objectContaining({
        actionName: 'media.video_thumbnail',
        projectPath: '/tmp/demo.iartproj',
        payload: {
          assetId: 'asset-video-1',
          timeSec: 1.2,
          width: 400,
          quality: 0.65,
        },
      }),
    );
  });

  it('本地图像处理主路径统一通过 media.image_process 请求 backend', async () => {
    const { edgeDetectImage } = await import('@/client/api/imageEdgeDetect');
    const { transformImage } = await import('@/client/api/imageTransform');
    const { resizeImage } = await import('@/client/api/imageResize');
    const { cropImage } = await import('@/client/api/imageCrop');
    const { splitImage } = await import('@/client/api/imageSplit');

    const edgeResult = await edgeDetectImage('/project-media/prj_demo/source.png', 180, 'sobel');
    const transformResult = await transformImage('/project-media/prj_demo/source.png', [{ type: 'rotate', deg: 90 }]);
    const resizeResult = await resizeImage('local-media://source.png', 50, 'nearest');
    const cropResult = await cropImage('/files/source.png', { x: 0, y: 0, width: 100, height: 100 });
    const splitResult = await splitImage('/project-media/prj_demo/source.png', { horizontalPercents: [], verticalPercents: [50] });

    expect(edgeResult.url).toBe('/project-media/prj_demo/edge.png');
    expect(edgeResult.assetId).toBe('asset-processed-1');
    expect(transformResult.url).toBe('/project-media/prj_demo/processed.png');
    expect(resizeResult.assetId).toBe('asset-processed-1');
    expect(cropResult.assetId).toBe('asset-processed-1');
    expect(splitResult.tiles[0]?.assetId).toBe('asset-tile-1');
    expect(MockBusinessActionWebSocket.instances).toHaveLength(5);
    expect(MockBusinessActionWebSocket.instances[0]?.sentPayloads[0]).toEqual(
      expect.objectContaining({
        actionName: 'media.image_process',
        projectPath: '/tmp/demo.iartproj',
        payload: {
          source: { type: 'media-url', url: '/project-media/prj_demo/source.png' },
          operation: { type: 'edgeDetect', threshold: 180, mode: 'sobel' },
        },
      }),
    );
    expect(MockBusinessActionWebSocket.instances[1]?.sentPayloads[0]).toEqual(
      expect.objectContaining({
        actionName: 'media.image_process',
        projectPath: '/tmp/demo.iartproj',
        payload: {
          source: { type: 'media-url', url: '/project-media/prj_demo/source.png' },
          operation: { type: 'transform', ops: [{ type: 'rotate', deg: 90 }] },
        },
      }),
    );
    expect(MockBusinessActionWebSocket.instances[2]?.sentPayloads[0]).toEqual(
      expect.objectContaining({
        actionName: 'media.image_process',
        payload: {
          source: { type: 'media-url', url: 'local-media://source.png' },
          operation: { type: 'resize', percent: 50, kernel: 'nearest' },
        },
      }),
    );
  });
});
