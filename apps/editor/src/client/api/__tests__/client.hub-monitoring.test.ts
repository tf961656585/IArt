// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearBackendTaskNoticeListeners,
  onBackendTaskNotice,
  type BackendTaskNotice,
} from '@/client/utils/hubMonitorNoticeEmitter';

const loadRequest = async () => {
  const mod = await import('@/client/api/client');
  return mod.request;
};

const jsonResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const createMockStorage = (): Storage => {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear() {
      data.clear();
    },
    getItem(key: string) {
      return data.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(data.keys())[index] ?? null;
    },
    removeItem(key: string) {
      data.delete(key);
    },
    setItem(key: string, value: string) {
      data.set(key, value);
    },
  };
};

const installMockStorage = (storage: Storage): void => {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: storage,
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  });
};

describe('request backend task notice visibility', () => {
  beforeEach(() => {
    installMockStorage(createMockStorage());
  });

  afterEach(() => {
    Reflect.deleteProperty(window, '__IART_LOCAL_API_BASE__');
    window.history.replaceState(null, '', '/');
    window.localStorage.clear();
    clearBackendTaskNoticeListeners();
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('Hub 本地端点不接入后端任务主链时，会发出“未写入后端任务状态”通知', async () => {
    (
      window as Window & {
        __IART_LOCAL_API_BASE__?: string;
      }
    ).__IART_LOCAL_API_BASE__ = 'http://localhost:4000';
    const notices: BackendTaskNotice[] = [];
    onBackendTaskNotice((notice) => {
      notices.push(notice);
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
          ? input.toString()
          : typeof (input as Request).url === 'string'
          ? (input as Request).url
          : '';
      if (url.endsWith('/api/local-run')) {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ error: `unexpected url: ${url}` }, 500);
    });
    vi.stubGlobal('fetch', fetchMock);
    const request = await loadRequest();

    const result = await request<{ ok: boolean }>({
      method: 'POST',
      endpoint: '/api/local-run',
      body: { ping: true },
      responseType: 'json',
      taskMeta: {
        taskId: 'task-local-1',
        scope: 'canvas',
      },
    });
    expect(result.ok).toBe(true);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.reasonCode).toBe('local_endpoint');
    expect(notices[0]?.taskId).toBe('task-local-1');
    expect(notices[0]?.taskScope).toBe('canvas');
    expect(notices[0]?.taskCreateDecision).toBe('bypass_backend_task');
  });

  it('非画板远端请求会通过 HTTP /api/tasks 创建任务，且不会发出 bypass 通知', async () => {
    (
      window as Window & {
        __IART_LOCAL_API_BASE__?: string;
      }
    ).__IART_LOCAL_API_BASE__ = 'http://localhost:4000';
    const notices: BackendTaskNotice[] = [];
    onBackendTaskNotice((notice) => {
      notices.push(notice);
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String((input as Request).url || '');
      expect(url).toBe('http://localhost:4000/api/tasks');
      const body = JSON.parse(String(init?.body ?? '{}')) as { prebuilt_payload?: { body?: unknown; api?: { endpoint?: unknown } }; metadata?: Record<string, unknown> };
      expect(body.prebuilt_payload?.api?.endpoint).toBe('https://example.com/remote-endpoint');
      expect(body.prebuilt_payload?.body).toEqual({ ping: true });
      return jsonResponse({ taskId: 'task-remote-1' });
    });
    vi.stubGlobal('fetch', fetchMock);
    const request = await loadRequest();

    const result = await request<{ __backend_task_pending: boolean; taskId: string }>({
      method: 'POST',
      endpoint: 'https://example.com/remote-endpoint',
      body: { ping: true },
      responseType: 'json',
      taskMeta: {
        taskId: 'task-remote-1',
        modelId: 'demo-model',
        projectPath: '/tmp/demo.iartproj',
        scope: 'project',
      },
    });
    expect(result.__backend_task_pending).toBe(true);
    expect(result.taskId).toBe('task-remote-1');
    expect(notices).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('画板 push 托管请求只创建 HTTP runtime task，不再主动等待结果', async () => {
    (
      window as Window & {
        __IART_LOCAL_API_BASE__?: string;
      }
    ).__IART_LOCAL_API_BASE__ = 'http://localhost:4000';

    const fetchMock = vi.fn(async () => jsonResponse({ taskId: 'task-canvas-1' }));
    vi.stubGlobal('fetch', fetchMock);
    const request = await loadRequest();

    const result = await request<{ __backend_task_pending: boolean; taskId: string }>({
      method: 'POST',
      endpoint: 'https://example.com/remote-endpoint',
      body: { ping: true },
      responseType: 'json',
      taskMeta: {
        taskId: 'task-canvas-1',
        modelId: 'demo-model',
        projectPath: '/tmp/demo.iartproj',
        scope: 'canvas',
        canvasPushManaged: true,
      },
    });

    expect(result.__backend_task_pending).toBe(true);
    expect(result.taskId).toBe('task-canvas-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('画板 task 元数据缺少 projectPath 时，会从当前编辑器 URL 补齐项目路径', async () => {
    (
      window as Window & {
        __IART_LOCAL_API_BASE__?: string;
      }
    ).__IART_LOCAL_API_BASE__ = 'http://localhost:4000';
    window.history.replaceState(
      null,
      '',
      '/zh-CN/canvas?projectPath=%2Ftmp%2Fdemo.iartproj'
    );

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { metadata?: Record<string, unknown> };
      expect(body.metadata?.['projectPath']).toBe('/tmp/demo.iartproj');
      expect(body.metadata?.['nodeGraphId']).toBe('graph-url-fallback');
      return jsonResponse({ taskId: 'task-canvas-url-1' });
    });
    vi.stubGlobal('fetch', fetchMock);
    const request = await loadRequest();

    const result = await request<{ __backend_task_pending: boolean; taskId: string }>({
      method: 'POST',
      endpoint: 'https://example.com/remote-endpoint',
      body: { ping: true },
      responseType: 'json',
      taskMeta: {
        taskId: 'task-canvas-url-1',
        modelId: 'demo-model',
        nodeGraphId: 'graph-url-fallback',
        scope: 'canvas',
        canvasPushManaged: true,
      },
    });

    expect(result.__backend_task_pending).toBe(true);
    expect(result.taskId).toBe('task-canvas-url-1');
  });
});
