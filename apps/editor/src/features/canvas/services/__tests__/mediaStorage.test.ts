import { beforeEach, describe, expect, it, vi } from 'vitest';
import { storeBase64Media } from '../mediaStorage';
import { uploadMediaBlob } from '@/client/api/upload';
import type * as RuntimeStoreModule from '@/client/store/runtimeStore';

vi.mock('@/client/api/upload', () => ({
  uploadMediaBlob: vi.fn(),
}));

vi.mock('@/client/store/runtimeStore', async () => {
  const actual = await vi.importActual<typeof RuntimeStoreModule>('@/client/store/runtimeStore');
  return {
    ...actual,
    getRuntimeBackendBaseUrl: vi.fn(() => 'http://127.0.0.1:3000'),
    getRuntimeProjectPath: vi.fn(() => null),
  };
});

describe('mediaStorage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('会把 Gemini PCM 音频封装成 wav 再上传', async () => {
    vi.mocked(uploadMediaBlob).mockResolvedValue('/files/gemini-tts.wav');

    const result = await storeBase64Media(
      'data:audio/L16;codec=pcm;rate=24000;base64,AQIDBA==',
      {
        nodeGraphId: 'graph_1',
        nodeId: 'node_1',
        source: 'execution',
        originalUrl: 'result://node_1',
        filenamePrefix: 'gemini-tts',
      }
    );

    expect(result).toMatchObject({
      kind: 'url',
      url: '/files/gemini-tts.wav',
      mimeType: 'audio/wav',
    });

    expect(vi.mocked(uploadMediaBlob)).toHaveBeenCalledTimes(1);
    const [blob, filename] = vi.mocked(uploadMediaBlob).mock.calls[0] ?? [];
    expect(filename).toMatch(/\.wav$/);
    expect(blob).toBeInstanceOf(Blob);
    expect(blob?.type).toBe('audio/wav');
    expect(blob?.size).toBeGreaterThan(44);
  });
});
