import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UploadFileItem } from '@/features/canvas/nodes/model/mediaHelpers';
import type { GenerationPayload } from '../types';
import type * as LocalEdgeAdapterNS from '../localEdgeAdapter';
import type * as ApiConfigNS from '@/client/utils/apiConfig';
import type * as RuntimeStoreNS from '@/client/store/runtimeStore';
import {
  MockBusinessActionWebSocket,
  type MockBusinessActionPayload,
} from '@/client/api/__tests__/fixtures/businessActionWebSocket';

let localEdgeAdapter: typeof LocalEdgeAdapterNS.localEdgeAdapter;

const LOCAL_API_BASE = 'http://127.0.0.1:3333';
const resolveApiEndpointMock = vi.fn(() => `${LOCAL_API_BASE}/ws/business`);
const getRuntimeBackendBaseUrlMock = vi.fn(() => LOCAL_API_BASE);
const getRuntimeProjectPathMock = vi.fn(() => 'C:\\tmp\\project');

const createGenerationPayload = (body: Record<string, unknown>): GenerationPayload => ({
  body,
  api: undefined,
  meta: undefined,
});

vi.mock('@/client/utils/apiConfig', async () => {
  const actual = await vi.importActual<typeof ApiConfigNS>('@/client/utils/apiConfig');
  return {
    ...actual,
    resolveApiEndpoint: resolveApiEndpointMock,
  };
});

vi.mock('@/client/store/runtimeStore', async () => {
  const actual = await vi.importActual<typeof RuntimeStoreNS>('@/client/store/runtimeStore');
  return {
    ...actual,
    getRuntimeBackendBaseUrl: getRuntimeBackendBaseUrlMock,
    getRuntimeProjectPath: getRuntimeProjectPathMock,
  };
});

const resolveLocalEdgeResult = (payload: MockBusinessActionPayload): Record<string, unknown> => {
    return (
      payload.actionName === 'media.upload'
        ? { success: true, url: '/files/uploaded.png' }
        : {
            resultType: 'single',
            operationType: 'edgeDetect',
            success: true,
            assetId: 'asset-edge',
            mediaAsset: {
              id: 'asset-edge',
              mediaType: 'image',
              original: {
                url: '/project-media/prj_demo/edge.png',
                projectRef: 'prj_demo',
                fileKey: 'edge.png',
                sourceUrl: '/files/input.png',
                mimeType: 'image/png',
                sizeBytes: null,
                width: 3,
                height: 3,
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
            url: '/project-media/prj_demo/edge.png',
            width: 3,
            height: 3,
            mode: 'sobel',
            threshold: 128,
          }
    );
};

const mockHubRuntime = () => {
  (window as { __IART_LOCAL_API_BASE__?: string }).__IART_LOCAL_API_BASE__ = LOCAL_API_BASE;
  (window as { electron?: unknown }).electron = {
    getCurrentProjectPath: vi.fn(async () => 'C:\\tmp\\project'),
  };
};

const cleanupHubRuntime = () => {
  try {
    delete (window as { __IART_LOCAL_API_BASE__?: string }).__IART_LOCAL_API_BASE__;
  } catch {
    // ignore
  }
  try {
    delete (window as { electron?: unknown }).electron;
  } catch {
    // ignore
  }
};

describe('localEdgeAdapter (Hub 后端)', () => {
  beforeEach(async () => {
    mockHubRuntime();
    getRuntimeBackendBaseUrlMock.mockReturnValue(LOCAL_API_BASE);
    getRuntimeProjectPathMock.mockReturnValue('C:\\tmp\\project');
    const { useRuntimeStore } = await import('@/client/store/runtimeStore');
    useRuntimeStore.setState({
      backendBaseUrl: LOCAL_API_BASE,
      projectPath: 'C:\\tmp\\project',
      projectRef: 'prj_demo',
    });
    MockBusinessActionWebSocket.reset(resolveLocalEdgeResult);
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: vi.fn(() => null),
        setItem: vi.fn(),
        removeItem: vi.fn(),
      },
    });
    window.sessionStorage.setItem('iarts_active_project_path', 'C:\\tmp\\project');
    vi.stubGlobal('WebSocket', MockBusinessActionWebSocket);
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('测试失败：localEdgeAdapter 的 Hub 主路径不应直连旧 HTTP 入口');
    }));

    const mod = await import('../localEdgeAdapter');
    localEdgeAdapter = mod.localEdgeAdapter;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    cleanupHubRuntime();
    window.sessionStorage.clear();
  });

  it('空输入抛出异常', async () => {
    await expect(localEdgeAdapter.generate(createGenerationPayload({}))).rejects.toThrow(/请先连接至少一张图片。/);
  });

  it('canny 模式抛出未实现', async () => {
    await expect(
      localEdgeAdapter.generate(createGenerationPayload({
        images: [{ src: '/files/input.png' }] as UploadFileItem[],
        mode: 'canny',
      })),
    ).rejects.toThrow(/当前不支持所选的检测方式，请换一种后再试。/);
  });

  it('调用 backend ws business contract 并返回 image_url', async () => {
    const result = (await localEdgeAdapter.generate(createGenerationPayload({
      images: [{ src: '/files/input.png' }] as UploadFileItem[],
      threshold: 200,
    }))) as Record<string, unknown>;

    expect(result['image_url']).toBe('/project-media/prj_demo/edge.png');
    expect(result).toHaveProperty('raw');
    expect((result['raw'] as { algorithm?: string })?.algorithm).toBe('sobel');
    expect((result['raw'] as { threshold?: number })?.threshold).toBe(200);
    expect(MockBusinessActionWebSocket.instances).toHaveLength(1);
    expect(MockBusinessActionWebSocket.instances[0]?.sentPayloads[0]).toEqual(
      expect.objectContaining({
        actionName: 'media.image_process',
        payload: {
          source: { type: 'media-url', url: '/files/input.png' },
          operation: { type: 'edgeDetect', threshold: 200, mode: 'sobel' },
        },
      }),
    );
  });

  it('file 输入会先经 media.upload 落盘，再经 media.image_process 处理', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'in.png', { type: 'image/png' });
    const result = (await localEdgeAdapter.generate(createGenerationPayload({
      images: [{ file }] as UploadFileItem[],
    }))) as Record<string, unknown>;

    expect(result['image_url']).toBe('/project-media/prj_demo/edge.png');
    expect(MockBusinessActionWebSocket.instances).toHaveLength(2);
    expect(MockBusinessActionWebSocket.instances[0]?.sentPayloads[0]).toEqual(
      expect.objectContaining({
        actionName: 'media.upload',
      }),
    );
    expect(MockBusinessActionWebSocket.instances[1]?.sentPayloads[0]).toEqual(
      expect.objectContaining({
        actionName: 'media.image_process',
        payload: {
          source: { type: 'media-url', url: '/files/uploaded.png' },
          operation: { type: 'edgeDetect', threshold: 128, mode: 'sobel' },
        },
      }),
    );
  });
});
