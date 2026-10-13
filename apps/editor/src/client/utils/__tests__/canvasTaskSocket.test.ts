import { beforeEach, describe, expect, it, vi } from 'vitest';

const getRuntimeBackendBaseUrlMock = vi.fn();

vi.mock('@/client/store/runtimeStore', () => ({
  getRuntimeBackendBaseUrl: getRuntimeBackendBaseUrlMock,
}));

describe('buildCanvasTaskSocketUrl', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    getRuntimeBackendBaseUrlMock.mockReturnValue('http://127.0.0.1:4100');
  });

  it('本地 Hub 已解析时，返回本地 websocket 地址', async () => {
    const { buildCanvasTaskSocketUrl } = await import('../canvasTaskSocket');

    const resolved = buildCanvasTaskSocketUrl({
      projectPath: '/tmp/demo.iartproj',
    });

    expect(resolved).toBe(
      'ws://127.0.0.1:4100/ws/tasks?projectPath=%2Ftmp%2Fdemo.iartproj'
    );
  });

  it('解析结果不是本地回环地址时，直接返回 null，避免误连远端 websocket', async () => {
    getRuntimeBackendBaseUrlMock.mockReturnValue('https://backend.example.com');
    const { buildCanvasTaskSocketUrl } = await import('../canvasTaskSocket');

    const resolved = buildCanvasTaskSocketUrl({
      projectPath: '/tmp/demo.iartproj',
    });

    expect(resolved).toBeNull();
  });

  it('桌面 bootstrap 缺失 backend base 时返回 null，而不是猜 localhost', async () => {
    getRuntimeBackendBaseUrlMock.mockReturnValue(null);
    const { buildCanvasTaskSocketUrl } = await import('../canvasTaskSocket');

    const resolved = buildCanvasTaskSocketUrl({
      projectPath: '/tmp/demo.iartproj',
    });

    expect(resolved).toBeNull();
  });
});
