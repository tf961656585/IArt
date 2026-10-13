import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RuntimeStoreNS from '@/client/store/runtimeStore';
import { MockBusinessActionWebSocket, type MockBusinessActionPayload } from './fixtures/businessActionWebSocket';

const getJsonMock = vi.fn();
const requestMock = vi.fn();
const resolveApiEndpointMock = vi.fn(() => 'http://127.0.0.1:4100/ws/business');

vi.mock('@/client/api/client', () => ({
  getJson: getJsonMock,
  request: requestMock,
}));

vi.mock('@/client/utils/apiConfig', () => ({
  resolveApiEndpoint: resolveApiEndpointMock,
}));

vi.mock('@/client/utils/hubFetch', () => ({
  isHubRuntime: vi.fn(() => true),
}));

vi.mock('@/client/store/runtimeStore', async () => {
  const actual = await vi.importActual<typeof RuntimeStoreNS>('@/client/store/runtimeStore');
  return {
    ...actual,
    getRuntimeBackendBaseUrl: vi.fn(() => 'http://127.0.0.1:4100'),
    getRuntimeProjectPath: vi.fn(() => '/tmp/demo.iartproj'),
  };
});

const resolveWorkersProxyResult = (payload: MockBusinessActionPayload): Record<string, unknown> => {
    const resultByActionName: Record<string, Record<string, unknown>> = {
      'workers_proxy.announcement': {
        enabled: true,
        title: 'Maintenance',
        message: '<p>Hub backend announcement</p>',
        severity: 'warning',
        updatedAt: '2026-03-19T08:30:00.000Z',
      },
    };
    return resultByActionName[payload.actionName] ?? { success: true };
};

describe('workers-proxy api (Hub 模式)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    MockBusinessActionWebSocket.reset(resolveWorkersProxyResult);
    vi.stubGlobal('WebSocket', MockBusinessActionWebSocket);
    window.history.replaceState(null, '', '/canvas?hubBase=http://127.0.0.1:6001');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('announcement 在 Hub 主路径下统一走 ws business sync，而不是旧 /api/workers-proxy/*', async () => {
    const { fetchAnnouncement } = await import('../announcement');

    const announcement = await fetchAnnouncement();

    expect(announcement).toEqual({
      enabled: true,
      title: 'Maintenance',
      message: '<p>Hub backend announcement</p>',
      severity: 'warning',
      updatedAt: '2026-03-19T08:30:00.000Z',
    });
    expect(MockBusinessActionWebSocket.instances).toHaveLength(1);
    expect(MockBusinessActionWebSocket.instances[0]?.sentPayloads[0]).toEqual(
      expect.objectContaining({
        actionName: 'workers_proxy.announcement',
        projectPath: '__editor_workspace__',
        payload: {},
      }),
    );
    expect(getJsonMock).not.toHaveBeenCalled();
    expect(requestMock).not.toHaveBeenCalled();
  });
});
