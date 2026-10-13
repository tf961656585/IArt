import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockBusinessActionWebSocket, type MockBusinessActionPayload } from './fixtures/businessActionWebSocket';

const resolveApiEndpointMock = vi.fn(() => 'http://127.0.0.1:4100/ws/business');

vi.mock('@/client/utils/apiConfig', () => ({
  resolveApiEndpoint: resolveApiEndpointMock,
}));

vi.mock('@/client/utils/hubFetch', () => ({
  isHubRuntime: vi.fn(() => true),
}));

vi.mock('@/client/store/runtimeStore', () => ({
  getRuntimeProjectPath: vi.fn(() => '/tmp/demo.iartproj'),
  getRuntimeBackendBaseUrl: vi.fn(() => 'http://127.0.0.1:4100'),
}));

const resolveUploadResult = (payload: MockBusinessActionPayload): Record<string, unknown> => {
  const mode = payload.payload['mode'];
  const resultUrl =
    mode === 'project_local'
      ? '/files/uploaded.png'
      : 'https://cdn.example.com/a.png';
  return { success: true, url: resultUrl };
};

describe('upload api (Hub 模式)', () => {
  beforeEach(() => {
    vi.resetModules();
    MockBusinessActionWebSocket.reset(resolveUploadResult);
    vi.stubGlobal('WebSocket', MockBusinessActionWebSocket);
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('测试失败：Hub 上传不应直接走 fetch');
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('项目本地上传经统一 business contract，而不是直连 /api/upload*', async () => {
    const { uploadMediaBlob } = await import('@/client/api/upload');
    const localUrl = await uploadMediaBlob(new Blob(['hi'], { type: 'image/png' }), 'demo.png');

    expect(localUrl).toBe('/files/uploaded.png');
    expect(MockBusinessActionWebSocket.instances).toHaveLength(1);
    expect(MockBusinessActionWebSocket.instances[0]?.sentPayloads[0]?.payload).toMatchObject({
      mode: 'project_local',
    });
  });
});
