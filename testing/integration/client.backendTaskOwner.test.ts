// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveApiEndpointMock = vi.fn((endpoint: string) =>
  endpoint,
);
const resolveLocalApiRequestTargetMock = vi.fn(async (endpoint: string) => ({
  endpoint,
  resolveEndpoint: false,
}));
const buildHeadersMock = vi.fn((headers?: Record<string, string>) => ({ ...(headers ?? {}) }));
const getRemoteApiBaseMock = vi.fn(() => 'https://remote.example.test');
const hasLocalHubBaseHintMock = vi.fn(() => false);
const isFormDataLikeMock = vi.fn(() => false);
const sleepMock = vi.fn(async () => undefined);
const normalizeHeadersMock = vi.fn((headers?: Record<string, unknown>) => ({ ...(headers ?? {}) }));
const emitBackendTaskAcceptedMock = vi.fn();
const getRuntimeAppVersionMock = vi.fn(() => 'test-app-version');
const getCurrentProjectPathFromElectronMock = vi.fn(async () => '/tmp/project.iartproj');
const emitBackendTaskNoticeMock = vi.fn();

vi.mock('@/client/utils/apiConfig', () => ({
  resolveApiEndpoint: resolveApiEndpointMock,
  resolveLocalApiRequestTarget: resolveLocalApiRequestTargetMock,
  buildHeaders: buildHeadersMock,
  getRemoteApiBase: getRemoteApiBaseMock,
  hasLocalHubBaseHint: hasLocalHubBaseHintMock,
}));

vi.mock('@/client/utils/http', () => ({
  isFormDataLike: isFormDataLikeMock,
  sleep: sleepMock,
  normalizeHeaders: normalizeHeadersMock,
}));

vi.mock('@/client/utils/streaming', () => ({
  consumeStreamingResponse: vi.fn(),
}));

vi.mock('@/client/utils/taskCreationEmitter', () => ({
  emitBackendTaskAccepted: emitBackendTaskAcceptedMock,
}));

vi.mock('@/client/utils/appVersion', () => ({
  getRuntimeAppVersion: getRuntimeAppVersionMock,
}));

vi.mock('@/client/utils/electronBridge', () => ({
  getCurrentProjectPathFromElectron: getCurrentProjectPathFromElectronMock,
}));

vi.mock('@/client/utils/hubMonitorNoticeEmitter', () => ({
  emitBackendTaskNotice: emitBackendTaskNoticeMock,
}));

describe('client backend task owner contract', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    (window as Window & { electron?: unknown }).electron = {};
    window.history.replaceState({}, '', '/editor?projectPath=%2Ftmp%2Fproject.iartproj');
  });

  it('HTTP task 创建成功时消费 Backend 返回的 taskId，而不是沿用前端 legacy taskId', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { metadata?: Record<string, unknown> };
      expect(body.metadata?.['taskId']).toBe('task-client-legacy');
      return new Response(JSON.stringify({ taskId: 'task-backend-http-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { backendRequest } = await import('@/client/api/client');
    const result = await backendRequest<Record<string, unknown>>({
      method: 'POST',
      endpoint: 'https://remote.example.test/generate',
      body: { prompt: 'demo' },
      taskMeta: {
        scope: 'canvas',
        projectPath: '/tmp/project.iartproj',
        taskId: 'task-client-legacy',
        modelId: 'demo-model',
      },
    });

    expect(result['__backend_task_pending']).toBe(true);
    expect(result['taskId']).toBe('task-backend-http-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(emitBackendTaskAcceptedMock).toHaveBeenCalledWith(
      'task-backend-http-1',
      expect.objectContaining({
        taskId: 'task-backend-http-1',
      }),
    );
  });

  it('HTTP task 创建失败时不会把前端 legacy taskId 提升为正式值', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ message: 'http task create failed' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { backendRequest } = await import('@/client/api/client');
    await expect(() =>
      backendRequest<Record<string, unknown>>({
        method: 'POST',
        endpoint: 'https://remote.example.test/generate',
        body: { prompt: 'demo' },
        taskMeta: {
          scope: 'canvas',
          projectPath: '/tmp/project.iartproj',
          taskId: 'task-client-legacy',
          modelId: 'demo-model',
        },
      }),
    ).rejects.toMatchObject({
      message: 'http task create failed',
    });
    expect(emitBackendTaskAcceptedMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
