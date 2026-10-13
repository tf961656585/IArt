import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockResolveStrictHubFetchTarget } = vi.hoisted(() => ({
  mockResolveStrictHubFetchTarget: vi.fn<(url: string, options?: { format?: 'blob' | 'base64' }) => unknown>(),
}));

vi.mock('@/client/utils/hubFetchTargetResolver', () => ({
  resolveStrictHubFetchTarget: (url: string, options?: { format?: 'blob' | 'base64' }) =>
    mockResolveStrictHubFetchTarget(url, options),
}));

import { fetchUrlAsBase64 } from '../contentCacheService';

describe('fetchUrlAsBase64 network guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps data URL without network request', async () => {
    const dataUrl = 'data:image/png;base64,Zm9v';
    const result = await fetchUrlAsBase64(dataUrl, undefined);

    expect(result).toMatchObject({
      data: dataUrl,
      mimeType: 'image/png',
      originalUrl: dataUrl,
    });
    expect(mockResolveStrictHubFetchTarget).not.toHaveBeenCalled();
  });

  it('fails close when remote target cannot be resolved by strict hub path', async () => {
    mockResolveStrictHubFetchTarget.mockReturnValue(null);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await fetchUrlAsBase64('https://example.com/demo.png', undefined);

    expect(result).toBeNull();
    expect(mockResolveStrictHubFetchTarget).toHaveBeenCalledWith(
      'https://example.com/demo.png',
      { format: 'blob' }
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('only fetches resolved hub proxy target instead of raw remote url', async () => {
    const proxyTarget =
      'http://localhost:4000/api/media-proxy?url=https%3A%2F%2Fexample.com%2Fdemo.png&format=blob';
    mockResolveStrictHubFetchTarget.mockReturnValue(proxyTarget);

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(new Blob(['hello'], { type: 'image/png' }), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        })
      );

    const result = await fetchUrlAsBase64('https://example.com/demo.png', undefined);

    expect(fetchMock).toHaveBeenCalledWith(
      proxyTarget,
      expect.objectContaining({ cache: 'no-store' })
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      'https://example.com/demo.png',
      expect.anything()
    );
    expect(result?.mimeType).toBe('image/png');
    expect(result?.data.startsWith('data:image/png;base64,')).toBe(true);
    fetchMock.mockRestore();
  });
});
