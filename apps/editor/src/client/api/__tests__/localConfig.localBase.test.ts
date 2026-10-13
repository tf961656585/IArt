import { beforeEach, describe, expect, it, vi } from 'vitest';

const requestMock = vi.fn();

vi.mock('@/client/api/client', () => ({
  request: requestMock,
}));

const loadModules = async () => {
  const apiConfig = await import('@/client/utils/apiConfig');
  const localConfig = await import('../localConfig');
  return { ...apiConfig, ...localConfig };
};

describe('localConfig 本地 Hub 基座解析', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    const storageState = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => storageState.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storageState.set(key, String(value));
        },
        removeItem: (key: string) => {
          storageState.delete(key);
        },
        clear: () => {
          storageState.clear();
        },
        key: (index: number) => Array.from(storageState.keys())[index] ?? null,
        get length() {
          return storageState.size;
        },
      } satisfies Storage,
    });
    window.history.replaceState(null, '', '/');
    Reflect.deleteProperty(window, '__IART_LOCAL_API_BASE__');
    Reflect.deleteProperty(window, 'electron');
    requestMock.mockResolvedValue({
      config: {},
      resolved: {},
    });
  });

  it('window 本地地址提示存在时，/api/config 应命中该本地 Hub', async () => {
    (window as Window & { __IART_LOCAL_API_BASE__?: string }).__IART_LOCAL_API_BASE__ =
      'http://127.0.0.1:4100';
    const { fetchLocalBackendConfig, DEFAULT_API_BASE } = await loadModules();

    await fetchLocalBackendConfig();

    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'http://127.0.0.1:4100/api/config',
        resolveEndpoint: false,
      })
    );
    expect(requestMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: `${DEFAULT_API_BASE}/api/config`,
      })
    );
  });

  it('只有持久化本地地址时，/api/config 应命中持久化的本地 Hub', async () => {
    window.localStorage.setItem('iarts_local_api_base', 'http://127.0.0.1:4200');
    const { fetchLocalBackendConfig, DEFAULT_API_BASE } = await loadModules();

    await fetchLocalBackendConfig();

    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'http://127.0.0.1:4200/api/config',
        resolveEndpoint: false,
      })
    );
    expect(requestMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: `${DEFAULT_API_BASE}/api/config`,
      })
    );
  });

  it('setLocalApiBase 应压过已有持久化本地地址', async () => {
    window.localStorage.setItem('iarts_local_api_base', 'http://127.0.0.1:4400');
    const { fetchLocalBackendConfig, setLocalApiBase, DEFAULT_API_BASE } = await loadModules();
    setLocalApiBase('http://127.0.0.1:4500');

    await fetchLocalBackendConfig();

    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'http://127.0.0.1:4500/api/config',
        resolveEndpoint: false,
      })
    );
    expect(requestMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: `${DEFAULT_API_BASE}/api/config`,
      })
    );
  });

  it('桌面态缺失 bootstrap backend base 时，/api/config 应回落为相对路径请求', async () => {
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {},
    });
    const { fetchLocalBackendConfig } = await loadModules();

    await expect(fetchLocalBackendConfig()).resolves.toEqual({
      config: {},
      resolved: {},
    });
    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: '/api/config',
        resolveEndpoint: undefined,
      })
    );
  });

  it('拿不到本地 Hub 地址时，应回落为相对路径请求，不能回落到远端默认基座', async () => {
    window.history.replaceState(null, '', '/canvas');
    const { fetchLocalBackendConfig, DEFAULT_API_BASE } = await loadModules();

    await expect(fetchLocalBackendConfig()).resolves.toEqual({
      config: {},
      resolved: {},
    });
    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: '/api/config',
        resolveEndpoint: undefined,
      })
    );
    expect(requestMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: `${DEFAULT_API_BASE}/api/config`,
      })
    );
  });
});
