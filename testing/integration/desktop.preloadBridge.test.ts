// @vitest-environment node
import path from 'node:path';
import { CLI_PROXY_REQUEST_CHANNEL, CLI_PROXY_RESPONSE_CHANNEL } from '@iart/contracts';
import { EDITOR_STORAGE_IPC_CHANNELS } from '@iart/contracts/editor-storage-contract';
import { clearCjsCache, patchModuleLoad } from './helpers/cjs-mock';
import { afterEach, describe, expect, it, vi } from 'vitest';

type ElectronExposeMap = Record<string, unknown>;

const preloadPath = path.join(process.cwd(), 'apps/desktop-shell/dist/preload.cjs');

let exposedApi: ElectronExposeMap | null = null;

const installElectronMock = () => {
  const invoke = vi.fn(async (_channel: string, _payload?: unknown) => null);
  const send = vi.fn();
  const on = vi.fn();
  const removeListener = vi.fn();
  const removeAllListeners = vi.fn();

  const restoreModuleLoad = patchModuleLoad({
    electron: {
      contextBridge: {
        exposeInMainWorld: vi.fn((name: string, api: ElectronExposeMap) => {
          if (name === 'electron') {
            exposedApi = api;
          }
        }),
      },
      ipcRenderer: {
        invoke,
        send,
        on,
        removeListener,
        removeAllListeners,
      },
    },
  });

  return {
    invoke,
    send,
    on,
    removeListener,
    removeAllListeners,
    restoreModuleLoad,
  };
};

describe('desktop preload bridge contract', () => {
  let electron: ReturnType<typeof installElectronMock> | null = null;

  afterEach(() => {
    electron?.restoreModuleLoad();
    exposedApi = null;
    clearCjsCache(preloadPath);
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('暴露 bootstrap-driven renderer contract，而不是旧 URL/query 桥接', async () => {
    electron = installElectronMock();

    await import(preloadPath);

    expect(exposedApi).not.toBeNull();
    expect(typeof exposedApi?.['getHubBootstrap']).toBe('function');
    expect(typeof exposedApi?.['getEditorBootstrap']).toBe('function');
    expect(typeof exposedApi?.['openEditorWindow']).toBe('function');
    expect(typeof exposedApi?.['reportDesktopE2EEvent']).toBe('function');
    expect(typeof exposedApi?.['revealTaskArchive']).toBe('function');
    expect(typeof exposedApi?.['revealFilesUrl']).toBe('function');
    // CLI 代理执行通道暴露面（spec docs/integrations/CLI与本地Agent集成.md §6.3）：
    // 请求订阅 + 响应回传成对登记，通道名以 contracts 为唯一事实源。
    expect(typeof exposedApi?.['onCliProxyRequest']).toBe('function');
    expect(typeof exposedApi?.['sendCliProxyResponse']).toBe('function');
    expect((exposedApi as ElectronExposeMap)).not.toHaveProperty('getLocalApiBase');
    expect((exposedApi as ElectronExposeMap)).not.toHaveProperty('revealRequestLog');
    expect((exposedApi as ElectronExposeMap)).not.toHaveProperty('revealJobResult');
    expect((exposedApi as ElectronExposeMap)).not.toHaveProperty('revealTaskRequestLog');
    expect((exposedApi as ElectronExposeMap)).not.toHaveProperty('revealTaskResult');

    await (exposedApi?.['getHubBootstrap'] as () => Promise<unknown>)();
    await (exposedApi?.['getEditorBootstrap'] as () => Promise<unknown>)();
    await (exposedApi?.['openEditorWindow'] as (target: unknown) => Promise<unknown>)({
      projectPath: '/tmp/demo.iartproj',
      sessionToken: 'session-demo',
    });
    await (exposedApi?.['reportDesktopE2EEvent'] as (payload: unknown) => Promise<unknown>)({
      type: 'renderer-bootstrap-ready',
      detail: { projectPath: '/tmp/demo.iartproj' },
    });
    await (exposedApi?.['revealTaskArchive'] as (taskId: string, projectPath?: string) => Promise<unknown>)(
      'task-demo',
      '/tmp/demo.iartproj',
    );
    await (exposedApi?.['revealFilesUrl'] as (url: string, projectPath?: string) => Promise<unknown>)(
      'local-media://demo-file',
      '/tmp/demo.iartproj',
    );

    // CLI 代理执行通道行为断言（spec §6.3）：请求经登记通道订阅，响应经登记通道 send 回传
    const cliProxyCallback = vi.fn();
    (exposedApi?.['onCliProxyRequest'] as (callback: (payload: unknown) => void) => void)(
      cliProxyCallback,
    );
    (exposedApi?.['sendCliProxyResponse'] as (payload: unknown) => void)({ ok: true });
    expect(electron.on).toHaveBeenCalledWith(CLI_PROXY_REQUEST_CHANNEL, expect.any(Function));
    expect(electron.send).toHaveBeenCalledWith(CLI_PROXY_RESPONSE_CHANNEL, { ok: true });

    expect(electron.invoke.mock.calls).toEqual([
      ['get-editor-bootstrap'],
      ['get-hub-bootstrap'],
      [
        'open-editor-window',
        {
          projectPath: '/tmp/demo.iartproj',
          sessionToken: 'session-demo',
        },
      ],
      [
        'report-desktop-e2e-event',
        {
          type: 'renderer-bootstrap-ready',
          detail: { projectPath: '/tmp/demo.iartproj' },
        },
      ],
      [
        'reveal-task-archive',
        {
          taskId: 'task-demo',
          projectPath: '/tmp/demo.iartproj',
        },
      ],
      [
        'reveal-files-url',
        {
          url: 'local-media://demo-file',
          projectPath: '/tmp/demo.iartproj',
        },
      ],
    ]);
  });

  describe('storage contract exposure', () => {
    const storageChannels = Object.values(EDITOR_STORAGE_IPC_CHANNELS).filter((channel) =>
      channel.startsWith('storage:'),
    );

    it('覆盖 contracts 中定义的全部 storage channel，包含 persist-delta', async () => {
      electron = installElectronMock();

      await import(preloadPath);

      const storageBridge = (exposedApi as { storage?: Record<string, unknown> } | null)?.storage;

      expect(storageBridge).toBeDefined();

      storageChannels.forEach((channel) => {
        expect(typeof storageBridge?.[channel], `${channel} 应在 preload storage 中暴露`).toBe('function');
      });
    });
  });

  it('editor close bridge 使用事件订阅与显式回执，而不是页面导航语义', async () => {
    electron = installElectronMock();

    await import(preloadPath);

    const callback = vi.fn();
    (exposedApi?.['onPrepareClose'] as (cb: () => void) => void)(callback);
    (exposedApi?.['sendCloseReady'] as () => void)();
    (exposedApi?.['sendCloseError'] as (error: unknown) => void)(new Error('flush failed'));
    (exposedApi?.['removePrepareCloseListener'] as () => void)();

    expect(electron.on).toHaveBeenCalledWith('editor:prepare-close', expect.any(Function));
    expect(electron.send).toHaveBeenCalledWith('editor:close-ready');
    expect(electron.send).toHaveBeenCalledWith('editor:close-error', { message: 'flush failed' });
    expect(electron.removeAllListeners).toHaveBeenCalledWith('editor:prepare-close');
  });
});
