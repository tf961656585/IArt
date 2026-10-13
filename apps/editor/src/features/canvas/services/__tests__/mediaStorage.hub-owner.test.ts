import { beforeEach, describe, expect, it, vi } from 'vitest';
import { storeBase64Media } from '../mediaStorage';
import { isHubRuntime } from '@/client/utils/hubFetch';
import { persistResultMedia } from '@/client/api/media';
import { uploadMediaBlob } from '@/client/api/upload';
import type * as RuntimeStoreModule from '@/client/store/runtimeStore';

vi.mock('@/client/store/runtimeStore', async () => {
  const actual = await vi.importActual<typeof RuntimeStoreModule>('@/client/store/runtimeStore');
  return {
    ...actual,
    getRuntimeBackendBaseUrl: vi.fn(() => 'http://127.0.0.1:3000'),
    getRuntimeProjectPath: vi.fn(() => '/tmp/demo.iartproj'),
  };
});

vi.mock('@/client/utils/hubFetch', () => ({
  isHubRuntime: vi.fn(() => true),
}));

vi.mock('@/client/api/media', () => ({
  persistResultMedia: vi.fn(),
}));

vi.mock('@/client/api/upload', () => ({
  uploadMediaBlob: vi.fn(),
}));

describe('mediaStorage Hub owner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isHubRuntime).mockReturnValue(true);
    vi.mocked(persistResultMedia).mockResolvedValue({
      url: '/files/hub-result.wav',
      originalUrl: 'result://node_1',
      assetId: null,
      mediaAsset: null,
      mediaType: 'audio',
      mimeType: 'audio/wav',
      sizeBytes: 128,
    });
  });

  it('Hub 主路径下 base64 结果媒体通过统一 ws business contract 落盘，而不是前端直传 upload adapter', async () => {
    const result = await storeBase64Media('data:audio/L16;codec=pcm;rate=24000;base64,AQIDBA==', {
      nodeGraphId: 'graph_1',
      nodeId: 'node_1',
      source: 'execution',
      originalUrl: 'result://node_1',
      filenamePrefix: 'gemini-tts',
    });

    expect(result).toMatchObject({
      kind: 'url',
      url: '/files/hub-result.wav',
      mimeType: 'audio/wav',
    });
    expect(vi.mocked(persistResultMedia)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(persistResultMedia).mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        filenamePrefix: 'gemini-tts',
        originalUrl: 'result://node_1',
      }),
    );
    expect((vi.mocked(persistResultMedia).mock.calls[0]?.[0] as { blob?: Blob } | undefined)?.blob?.type).toBe(
      'audio/wav',
    );
    expect(vi.mocked(uploadMediaBlob)).not.toHaveBeenCalled();
  });
});
