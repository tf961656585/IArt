import { beforeEach, describe, expect, it, vi } from 'vitest';

let runtimeBackendBaseUrl: string | null = null;

vi.mock('@/client/store/runtimeStore', () => ({
  getRuntimeBackendBaseUrl: () => runtimeBackendBaseUrl,
}));

const installStorage = () => {
  const data = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, String(value));
      },
      removeItem: (key: string) => {
        data.delete(key);
      },
      clear: () => {
        data.clear();
      },
      key: (index: number) => Array.from(data.keys())[index] ?? null,
      get length() {
        return data.size;
      },
    } satisfies Storage,
  });
};

describe('apiConfig desktop runtime boundary', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    runtimeBackendBaseUrl = null;
    installStorage();
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {},
    });
    (window as Window & { __IART_LOCAL_API_BASE__?: string }).__IART_LOCAL_API_BASE__ =
      'http://127.0.0.1:4999';
    window.localStorage.setItem('iarts_local_api_base', 'http://127.0.0.1:4888');
  });

  it('桌面态忽略 window/localStorage 本地地址覆写，只认 bootstrap backend base', async () => {
    runtimeBackendBaseUrl = 'http://127.0.0.1:39000';
    const { getLocalApiBase, resolveApiEndpoint } = await import('../apiConfig');

    expect(getLocalApiBase()).toBe('http://127.0.0.1:39000');
    expect(resolveApiEndpoint('/api/config')).toBe('http://127.0.0.1:39000/api/config');
  });

  it('桌面态缺失 bootstrap backend base 时，解析相对 backend endpoint 直接失败', async () => {
    runtimeBackendBaseUrl = null;
    const { resolveApiEndpoint } = await import('../apiConfig');

    expect(() => resolveApiEndpoint('/api/config')).toThrow(
      'desktop runtime backend base unavailable for endpoint: /api/config',
    );
  });

  it('buildHeaders 不再自动注入 new-api-user', async () => {
    runtimeBackendBaseUrl = null;
    const { buildHeaders, setStoredApiKey } = await import('../apiConfig');

    setStoredApiKey('sk-test-token');
    const headers = buildHeaders();

    expect(headers['new-api-user']).toBeUndefined();
    expect(headers['Authorization']).toBe('Bearer sk-test-token');
  });

  it('handleInvalidToken 不再清理旧 user 缓存键', async () => {
    runtimeBackendBaseUrl = null;
    const {
      handleInvalidToken,
      getStoredSystemToken,
      setStoredApiKey,
      setStoredSystemToken,
    } = await import('../apiConfig');

    window.localStorage.setItem('user', JSON.stringify({ id: 'legacy-user' }));
    setStoredSystemToken('sk-system-token');
    setStoredApiKey('sk-api-token');

    expect(getStoredSystemToken()).toBe('system-token');
    expect(handleInvalidToken()).toBe(true);
    expect(getStoredSystemToken()).toBe('');
    expect(window.localStorage.getItem('user')).toBe(JSON.stringify({ id: 'legacy-user' }));
  });
});
