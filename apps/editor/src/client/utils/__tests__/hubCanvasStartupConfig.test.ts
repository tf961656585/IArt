import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const hubFetchMock = {
  isHubRuntime: vi.fn(),
};

const localConfigMock = {
  fetchLocalBackendConfig: vi.fn(),
};

vi.mock('@/client/utils/hubFetch', () => hubFetchMock);
vi.mock('@/client/api/localConfig', () => localConfigMock);

const loadModule = async () => await import('../hubCanvasStartupConfig');
const defaultStartupConfigOptions = {
  force: undefined,
  timeoutMs: undefined,
  nonBlocking: undefined,
};
const startupConfigOptions = (patch: {
  force: boolean | undefined;
  timeoutMs: number | undefined;
  nonBlocking: boolean | undefined;
}) => ({
  force: patch.force,
  timeoutMs: patch.timeoutMs,
  nonBlocking: patch.nonBlocking,
});

beforeEach(() => {
  vi.resetModules();
  vi.useRealTimers();
  hubFetchMock.isHubRuntime.mockReset();
  localConfigMock.fetchLocalBackendConfig.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('hubCanvasStartupConfig.getResolvedExpandInlineParamsOnStartup', () => {
  it('非 Hub 环境直接返回默认值且不请求配置', async () => {
    hubFetchMock.isHubRuntime.mockReturnValue(false);
    const { getResolvedExpandInlineParamsOnStartup, DEFAULT_EXPAND_INLINE_PARAMS_ON_STARTUP } = await loadModule();

    const value = await getResolvedExpandInlineParamsOnStartup(defaultStartupConfigOptions);

    expect(value).toBe(DEFAULT_EXPAND_INLINE_PARAMS_ON_STARTUP);
    expect(localConfigMock.fetchLocalBackendConfig).not.toHaveBeenCalled();
  });

  it('优先读取 resolved 字段并在 TTL 内复用缓存', async () => {
    hubFetchMock.isHubRuntime.mockReturnValue(true);
    localConfigMock.fetchLocalBackendConfig.mockResolvedValue({
      config: { expandInlineParamsOnStartup: false },
      resolved: { expandInlineParamsOnStartup: true },
    });

    const { getResolvedExpandInlineParamsOnStartup } = await loadModule();

    const first = await getResolvedExpandInlineParamsOnStartup(
      startupConfigOptions({ force: undefined, timeoutMs: 50, nonBlocking: undefined })
    );
    expect(first).toBe(true);

    localConfigMock.fetchLocalBackendConfig.mockClear();
    const second = await getResolvedExpandInlineParamsOnStartup(defaultStartupConfigOptions);

    expect(second).toBe(true);
    expect(localConfigMock.fetchLocalBackendConfig).not.toHaveBeenCalled();
  });

  it('首次读取很慢时，仍应等待真实 Hub 值，而不是按 false 回退', async () => {
    hubFetchMock.isHubRuntime.mockReturnValue(true);
    localConfigMock.fetchLocalBackendConfig.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({
              config: { expandInlineParamsOnStartup: true },
              resolved: { expandInlineParamsOnStartup: true },
            });
          }, 200);
        })
    );

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-26T00:00:00.000Z'));

    const { getResolvedExpandInlineParamsOnStartup } = await loadModule();

    const pending = getResolvedExpandInlineParamsOnStartup(
      startupConfigOptions({ force: undefined, timeoutMs: 300, nonBlocking: undefined })
    );
    await vi.advanceTimersByTimeAsync(200);
    const value = await pending;

    expect(value).toBe(true);
  });

  it('首次读取悬挂时应在统一预算内抛错，而不是无限等待', async () => {
    hubFetchMock.isHubRuntime.mockReturnValue(true);
    localConfigMock.fetchLocalBackendConfig.mockImplementation(() => new Promise(() => {}));

    vi.useFakeTimers();

    const {
      getResolvedExpandInlineParamsOnStartup,
      HUB_CANVAS_STARTUP_CONFIG_TIMEOUT_MS,
      HUB_CANVAS_STARTUP_CONFIG_UNAVAILABLE_ERROR_NAME,
    } = await loadModule();

    const pending = getResolvedExpandInlineParamsOnStartup(
      startupConfigOptions({ force: undefined, timeoutMs: 0, nonBlocking: undefined })
    );
    const expectation = expect(pending).rejects.toMatchObject({
      name: HUB_CANVAS_STARTUP_CONFIG_UNAVAILABLE_ERROR_NAME,
    });
    await vi.advanceTimersByTimeAsync(HUB_CANVAS_STARTUP_CONFIG_TIMEOUT_MS);
    await expectation;
  });

  it('首次读取失败时应直接抛错，并在下次重试时重新读取真实 Hub 值', async () => {
    hubFetchMock.isHubRuntime.mockReturnValue(true);
    localConfigMock.fetchLocalBackendConfig
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({
        config: { expandInlineParamsOnStartup: true },
        resolved: { expandInlineParamsOnStartup: true },
      });

    const {
      getResolvedExpandInlineParamsOnStartup,
      HUB_CANVAS_STARTUP_CONFIG_UNAVAILABLE_ERROR_NAME,
      HUB_CANVAS_STARTUP_CONFIG_UNAVAILABLE_ERROR_CODE,
      HUB_CANVAS_STARTUP_CONFIG_KEY,
      HUB_CANVAS_STARTUP_CONFIG_ENDPOINT,
    } = await loadModule();

    await expect(
      getResolvedExpandInlineParamsOnStartup(
        startupConfigOptions({ force: undefined, timeoutMs: 100, nonBlocking: undefined })
      )
    ).rejects.toMatchObject({
      name: HUB_CANVAS_STARTUP_CONFIG_UNAVAILABLE_ERROR_NAME,
      code: HUB_CANVAS_STARTUP_CONFIG_UNAVAILABLE_ERROR_CODE,
      diagnostics: {
        subsource: 'hub_canvas_startup_config',
        configKey: HUB_CANVAS_STARTUP_CONFIG_KEY,
        configEndpoint: HUB_CANVAS_STARTUP_CONFIG_ENDPOINT,
        timeoutMs: 100,
        causeName: 'Error',
        causeMessage: 'network down',
      },
    });

    const value = await getResolvedExpandInlineParamsOnStartup(
      startupConfigOptions({ force: undefined, timeoutMs: 100, nonBlocking: undefined })
    );
    expect(value).toBe(true);
    expect(localConfigMock.fetchLocalBackendConfig).toHaveBeenCalledTimes(2);
  });

  it('已有可信缓存为 true 时，后续超时也应继续复用 true，而不是错判为 false', async () => {
    hubFetchMock.isHubRuntime.mockReturnValue(true);
    localConfigMock.fetchLocalBackendConfig.mockResolvedValueOnce({
      config: { expandInlineParamsOnStartup: true },
      resolved: { expandInlineParamsOnStartup: true },
    });

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-26T00:00:00.000Z'));

    const { getResolvedExpandInlineParamsOnStartup } = await loadModule();

    const first = await getResolvedExpandInlineParamsOnStartup(
      startupConfigOptions({ force: undefined, timeoutMs: 100, nonBlocking: undefined })
    );
    expect(first).toBe(true);

    localConfigMock.fetchLocalBackendConfig.mockImplementation(() => new Promise(() => {}));
    const pending = getResolvedExpandInlineParamsOnStartup(
      startupConfigOptions({ force: true, timeoutMs: 100, nonBlocking: undefined })
    );
    await vi.advanceTimersByTimeAsync(100);
    const value = await pending;

    expect(value).toBe(true);
  });

  it('nonBlocking 模式在已有可信缓存时应立即返回缓存值并异步刷新', async () => {
    hubFetchMock.isHubRuntime.mockReturnValue(true);
    localConfigMock.fetchLocalBackendConfig.mockResolvedValueOnce({
      config: { expandInlineParamsOnStartup: true },
      resolved: { expandInlineParamsOnStartup: true },
    });

    const { getResolvedExpandInlineParamsOnStartup } = await loadModule();
    const trusted = await getResolvedExpandInlineParamsOnStartup(
      startupConfigOptions({ force: undefined, timeoutMs: 100, nonBlocking: undefined })
    );
    expect(trusted).toBe(true);

    localConfigMock.fetchLocalBackendConfig.mockImplementation(() => new Promise(() => {}));

    const value = await getResolvedExpandInlineParamsOnStartup({
      force: true,
      nonBlocking: true,
      timeoutMs: 100,
    });

    expect(value).toBe(true);
    expect(localConfigMock.fetchLocalBackendConfig).toHaveBeenCalledTimes(2);
  });

  it('同步读取可信值时，未拿到 Hub 配置应直接抛错', async () => {
    hubFetchMock.isHubRuntime.mockReturnValue(true);
    const {
      requireTrustedResolvedExpandInlineParamsOnStartup,
      HUB_CANVAS_STARTUP_CONFIG_UNAVAILABLE_ERROR_NAME,
    } = await loadModule();

    expect(() => requireTrustedResolvedExpandInlineParamsOnStartup()).toThrowError(
      expect.objectContaining({
        name: HUB_CANVAS_STARTUP_CONFIG_UNAVAILABLE_ERROR_NAME,
      })
    );
  });

  it('同步读取可信值时，拿到过可信配置后应返回缓存值', async () => {
    hubFetchMock.isHubRuntime.mockReturnValue(true);
    localConfigMock.fetchLocalBackendConfig.mockResolvedValueOnce({
      config: { expandInlineParamsOnStartup: true },
      resolved: { expandInlineParamsOnStartup: true },
    });
    const {
      getResolvedExpandInlineParamsOnStartup,
      requireTrustedResolvedExpandInlineParamsOnStartup,
    } = await loadModule();

    await getResolvedExpandInlineParamsOnStartup(
      startupConfigOptions({ force: undefined, timeoutMs: 100, nonBlocking: undefined })
    );

    expect(requireTrustedResolvedExpandInlineParamsOnStartup()).toBe(true);
  });
});
