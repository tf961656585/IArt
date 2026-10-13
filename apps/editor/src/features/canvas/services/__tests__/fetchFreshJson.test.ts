import { afterEach, describe, expect, it, vi } from 'vitest';
import { cast } from '@/lib/utils';

import { fetchFreshJson } from '../fetchFreshJson';
import { useRuntimeStore } from '@/client/store/runtimeStore';

describe('fetchFreshJson', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    useRuntimeStore.setState({
      backendBaseUrl: null,
      desktopBootstrap: null,
      bootstrapStatus: 'idle',
      bootstrapError: null,
      projectPath: null,
    });
  });

  it("对绝对 URL 仍以 cache: 'no-store' 发起请求", async () => {
    const mockFetch = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      } as Response;
    });

    globalThis.fetch = mockFetch as typeof fetch;

    const result = await fetchFreshJson('https://example.com/doc.json');
    expect(result).toEqual({ ok: true });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = cast<[unknown, RequestInit | undefined]>(mockFetch.mock.calls[0]);
    expect(String(url)).toBe('https://example.com/doc.json');
    expect(init).toMatchObject({ cache: 'no-store' });
  });

  it('缺失 runtime backend base 时，/files/* 请求应被明确阻断', async () => {
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as typeof fetch;

    await expect(fetchFreshJson('/files/doc.json')).rejects.toThrow(
      'editor runtime backend base url unavailable',
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('resolves /files/* against local hub base when enabled', async () => {
    const mockFetch = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      } as Response;
    });

    globalThis.fetch = mockFetch as typeof fetch;
    useRuntimeStore.setState({
      backendBaseUrl: 'http://127.0.0.1:43392',
    });

    const result = await fetchFreshJson('/files/doc.json');
    expect(result).toEqual({ ok: true });

    const [url] = cast<[unknown]>(mockFetch.mock.calls[0]);
    expect(String(url)).toBe('http://127.0.0.1:43392/files/doc.json');
  });
});
