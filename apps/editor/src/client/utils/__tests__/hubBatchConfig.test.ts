import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const hubFetchMock = {
  isHubRuntime: vi.fn(),
};

const localConfigMock = {
  fetchLocalBackendConfig: vi.fn(),
};

vi.mock('@/client/utils/hubFetch', () => hubFetchMock);
vi.mock('@/client/api/localConfig', () => localConfigMock);

const loadModule = async () => await import('../hubBatchConfig');

beforeEach(() => {
  vi.resetModules();
  vi.useRealTimers();
  hubFetchMock.isHubRuntime.mockReset();
  localConfigMock.fetchLocalBackendConfig.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('hubBatchConfig.getResolvedMaxBatchTasks', () => {
  it('非 Hub 环境直接返回默认值且不请求配置', async () => {
    hubFetchMock.isHubRuntime.mockReturnValue(false);
    const { getResolvedMaxBatchTasks, DEFAULT_MAX_BATCH_TASKS } = await loadModule();

    const value = await getResolvedMaxBatchTasks();

    expect(value).toBe(DEFAULT_MAX_BATCH_TASKS);
    expect(localConfigMock.fetchLocalBackendConfig).not.toHaveBeenCalled();
  });

  it('在 TTL 内复用缓存，不重复请求', async () => {
    hubFetchMock.isHubRuntime.mockReturnValue(true);
    localConfigMock.fetchLocalBackendConfig.mockResolvedValue({
      resolved: { maxBatchTasks: 12 },
    });

    const { getResolvedMaxBatchTasks } = await loadModule();

    const first = await getResolvedMaxBatchTasks({ force: undefined, timeoutMs: 50, nonBlocking: undefined });
    expect(first).toBe(12);

    localConfigMock.fetchLocalBackendConfig.mockClear();
    const second = await getResolvedMaxBatchTasks();

    expect(second).toBe(12);
    expect(localConfigMock.fetchLocalBackendConfig).not.toHaveBeenCalled();
  });

  it('配置请求超时后返回缓存默认值', async () => {
    hubFetchMock.isHubRuntime.mockReturnValue(true);
    localConfigMock.fetchLocalBackendConfig.mockImplementation(
      () => new Promise(() => {})
    );

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-26T00:00:00.000Z'));

    const { getResolvedMaxBatchTasks, DEFAULT_MAX_BATCH_TASKS } = await loadModule();

    const pending = getResolvedMaxBatchTasks({ force: undefined, timeoutMs: 100, nonBlocking: undefined });
    await vi.advanceTimersByTimeAsync(100);
    const value = await pending;

    expect(value).toBe(DEFAULT_MAX_BATCH_TASKS);
  });

  it('nonBlocking 模式立即返回缓存值，不等待配置请求', async () => {
    hubFetchMock.isHubRuntime.mockReturnValue(true);
    localConfigMock.fetchLocalBackendConfig.mockImplementation(
      () => new Promise(() => {})
    );

    const { getResolvedMaxBatchTasks, DEFAULT_MAX_BATCH_TASKS } = await loadModule();

    const value = await getResolvedMaxBatchTasks({ force: undefined, nonBlocking: true, timeoutMs: 100 });

    expect(value).toBe(DEFAULT_MAX_BATCH_TASKS);
    expect(localConfigMock.fetchLocalBackendConfig).toHaveBeenCalledTimes(1);
  });
});
