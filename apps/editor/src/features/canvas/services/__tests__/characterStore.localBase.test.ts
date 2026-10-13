import { beforeEach, describe, expect, it, vi } from 'vitest';

const requestMock = vi.fn();
const submitBusinessSyncActionMock = vi.fn();
const isHubRuntimeMock = vi.fn(() => true);

vi.mock('@/client/api/client', () => ({
  request: requestMock,
  serializeFormDataForBusinessAction: vi.fn(),
}));

vi.mock('@/client/utils/businessActionSocket', () => ({
  submitBusinessSyncAction: submitBusinessSyncActionMock,
}));

vi.mock('@/client/utils/hubFetch', () => ({
  isHubRuntime: isHubRuntimeMock,
}));

const loadModules = async () => {
  const apiConfig = await import('@/client/utils/apiConfig');
  const characterStore = await import('../characterStore');
  return { ...apiConfig, CharacterStore: characterStore.CharacterStore };
};

describe('characterStore 本地 Hub 基座解析', () => {
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
    isHubRuntimeMock.mockReturnValue(true);
    (window as Window & { __IART_LOCAL_API_BASE__: string | undefined }).__IART_LOCAL_API_BASE__ =
      undefined;
    requestMock.mockResolvedValue({ success: true, characters: [] });
    submitBusinessSyncActionMock.mockRejectedValue({
      code: 'business_action_socket_unavailable',
      body: { code: 'business_action_socket_unavailable', message: 'socket unavailable' },
    });
  });

  it('business sync 不可用时，优先回退到 window 本地地址提示', async () => {
    (window as Window & { __IART_LOCAL_API_BASE__?: string }).__IART_LOCAL_API_BASE__ =
      'http://127.0.0.1:6100';
    const { CharacterStore, setLocalApiBase } = await loadModules();
    setLocalApiBase('http://127.0.0.1:6300');

    await CharacterStore.getAllIndex();

    expect(submitBusinessSyncActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        actionName: 'characters.list',
        projectPath: '__editor_workspace__',
      })
    );
    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'http://127.0.0.1:6100/api/characters/list',
        resolveEndpoint: false,
      })
    );
  });

  it('没有 window 提示时，回退请求使用持久化本地地址', async () => {
    const { CharacterStore, setLocalApiBase } = await loadModules();
    setLocalApiBase('http://127.0.0.1:6500');

    await CharacterStore.getAllIndex();

    expect(submitBusinessSyncActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        actionName: 'characters.list',
        projectPath: '__editor_workspace__',
      })
    );
    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'http://127.0.0.1:6500/api/characters/list',
        resolveEndpoint: false,
      })
    );
  });
});
