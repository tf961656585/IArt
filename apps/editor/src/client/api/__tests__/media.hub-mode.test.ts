import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ApiConfigNS from '@/client/utils/apiConfig';
import type * as RuntimeStoreNS from '@/client/store/runtimeStore';
import { MockBusinessActionWebSocket, type MockBusinessActionPayload } from './fixtures/businessActionWebSocket';

const resolveApiEndpointMock = vi.fn(() => 'http://127.0.0.1:4100/ws/business');

vi.mock('@/client/utils/apiConfig', async () => {
  const actual = await vi.importActual<typeof ApiConfigNS>('@/client/utils/apiConfig');
  return {
    ...actual,
    resolveApiEndpoint: resolveApiEndpointMock,
  };
});

vi.mock('@/client/utils/hubFetch', () => ({
  isHubRuntime: vi.fn(() => true),
}));

vi.mock('@/client/store/runtimeStore', async () => {
  const actual = await vi.importActual<typeof RuntimeStoreNS>('@/client/store/runtimeStore');
  return {
    ...actual,
    getRuntimeBackendBaseUrl: vi.fn(() => 'http://127.0.0.1:4100'),
    getRuntimeProjectPath: vi.fn(() => '/tmp/demo.iartproj'),
  };
});

const resolveMediaResult = (payload: MockBusinessActionPayload): Record<string, unknown> => {
    const isPersistResult = payload.actionName === 'media.persist_result';
    const requestUrl = payload.payload['url'];
    const resultUrl =
      isPersistResult && typeof requestUrl === 'string' && requestUrl.includes('.mp4')
        ? '/files/persisted.mp4'
        : '/files/localized.png';
    const originalUrl =
      isPersistResult && typeof requestUrl === 'string'
        ? requestUrl
        : 'https://example.com/demo.png';
    const mediaType =
      isPersistResult && typeof requestUrl === 'string' && requestUrl.includes('.mp4')
        ? 'video'
        : 'image';
    const mimeType = mediaType === 'video' ? 'video/mp4' : 'image/png';
    const assetId = mediaType === 'video' ? 'asset_video_persisted' : 'asset_image_localized';
    const mediaAsset = {
      id: assetId,
      mediaType,
      original: {
        url: resultUrl,
        mimeType,
        sizeBytes: 1024,
        width: null,
        height: null,
        durationMs: mediaType === 'video' ? 1000 : null,
        fps: null,
      },
      thumbnail: {
        url: null,
        mimeType: null,
        width: null,
        height: null,
        status: 'missing',
        generatedAt: null,
      },
      lifecycle: {
        createdAt: 1,
        updatedAt: 1,
      },
    };
    return {
            url: resultUrl,
            originalUrl,
            assetId,
            mediaAsset,
            mediaType,
            mimeType,
            sizeBytes: 1024,
    };
};

describe('localizeRemoteMedia (Hub 模式)', () => {
  beforeEach(() => {
    vi.resetModules();
    MockBusinessActionWebSocket.reset(resolveMediaResult);
    vi.stubGlobal('WebSocket', MockBusinessActionWebSocket);
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('测试失败：Hub 远端本地化不应直接走 fetch');
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('不再让 editor 直连 /api/media/localize，而是通过 ws business contract 触发 backend 本地化', async () => {
    const { localizeRemoteMedia } = await import('@/client/api/media');
    const result = await localizeRemoteMedia({
      url: 'https://example.com/demo.png',
      mediaType: 'image',
    });

    expect(result).toEqual({
      url: '/files/localized.png',
      originalUrl: 'https://example.com/demo.png',
      assetId: 'asset_image_localized',
      mediaAsset: {
        id: 'asset_image_localized',
        mediaType: 'image',
        original: {
          url: '/files/localized.png',
          mimeType: 'image/png',
          sizeBytes: 1024,
          width: null,
          height: null,
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
        },
        lifecycle: {
          createdAt: 1,
          updatedAt: 1,
        },
      },
      mediaType: 'image',
      mimeType: 'image/png',
      sizeBytes: 1024,
    });
    expect(MockBusinessActionWebSocket.instances[0]?.url).toBe('ws://127.0.0.1:4100/ws/business');
    expect(MockBusinessActionWebSocket.instances[0]?.sentPayloads[0]).toEqual(
      expect.objectContaining({
        actionName: 'media.localize',
        projectPath: '/tmp/demo.iartproj',
        payload: {
          url: 'https://example.com/demo.png',
          mediaType: 'image',
        },
      }),
    );
  });

  it('结果媒体落盘主路径通过统一 ws business contract 触发 backend owner，而不是 editor 自己抓远端并生成 /files', async () => {
    const { persistResultMedia } = await import('@/client/api/media');
    const result = await persistResultMedia({
      url: 'https://example.com/demo.mp4',
      mediaType: 'video',
      filenamePrefix: 'canvas',
      originalUrl: 'result://node_1',
    });

    expect(result).toEqual({
      url: '/files/persisted.mp4',
      originalUrl: 'https://example.com/demo.mp4',
      assetId: 'asset_video_persisted',
      mediaAsset: {
        id: 'asset_video_persisted',
        mediaType: 'video',
        original: {
          url: '/files/persisted.mp4',
          mimeType: 'video/mp4',
          sizeBytes: 1024,
          width: null,
          height: null,
          durationMs: 1000,
          fps: null,
        },
        thumbnail: {
          url: null,
          mimeType: null,
          width: null,
          height: null,
          status: 'missing',
          generatedAt: null,
        },
        lifecycle: {
          createdAt: 1,
          updatedAt: 1,
        },
      },
      mediaType: 'video',
      mimeType: 'video/mp4',
      sizeBytes: 1024,
    });
    expect(MockBusinessActionWebSocket.instances[0]?.sentPayloads[0]).toMatchObject({
      actionName: 'media.persist_result',
      projectPath: '/tmp/demo.iartproj',
    });
    expect(MockBusinessActionWebSocket.instances[0]?.sentPayloads[0]?.payload).toMatchObject({
      url: 'https://example.com/demo.mp4',
      mediaType: 'video',
      filenamePrefix: 'canvas',
      originalUrl: 'result://node_1',
    });
  });

  it('结果已经是 /files/... 时仍通过 ws business contract 补齐 formal assetId，而不是在 editor 侧短路返回', async () => {
    const { persistResultMedia } = await import('@/client/api/media');
    const result = await persistResultMedia({
      url: '/files/already-local.png',
      mediaType: 'image',
      filenamePrefix: 'canvas',
      originalUrl: 'result://node_local',
    });

    expect(result).toEqual({
      url: '/files/localized.png',
      originalUrl: '/files/already-local.png',
      assetId: 'asset_image_localized',
      mediaAsset: {
        id: 'asset_image_localized',
        mediaType: 'image',
        original: {
          url: '/files/localized.png',
          mimeType: 'image/png',
          sizeBytes: 1024,
          width: null,
          height: null,
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
        },
        lifecycle: {
          createdAt: 1,
          updatedAt: 1,
        },
      },
      mediaType: 'image',
      mimeType: 'image/png',
      sizeBytes: 1024,
    });
    expect(MockBusinessActionWebSocket.instances[0]?.sentPayloads[0]).toMatchObject({
      actionName: 'media.persist_result',
      projectPath: '/tmp/demo.iartproj',
    });
    expect(MockBusinessActionWebSocket.instances[0]?.sentPayloads[0]?.payload).toMatchObject({
      url: '/files/already-local.png',
      mediaType: 'image',
      filenamePrefix: 'canvas',
      originalUrl: 'result://node_local',
    });
  });
});
