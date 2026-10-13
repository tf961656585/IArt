// @vitest-environment node
import { EventEmitter } from 'node:events';
import { clearCjsCache, patchModuleLoad, cast } from './helpers/cjs-mock';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
const originalFetch = global.fetch;

const mainPath = path.join(process.cwd(), 'apps/desktop-shell/dist/main.cjs');
const preloadPath = path.join(process.cwd(), 'apps/desktop-shell/dist/preload.cjs');

type IpcHandler = (...args: unknown[]) => unknown;
type ElectronExposeMap = Record<string, unknown>;
type LoadHostChainResult = Awaited<ReturnType<typeof loadHostChain>>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

class MockBrowserWindow extends EventEmitter {
  static instances: MockBrowserWindow[] = [];
  static nextWebContentsId = 2000;
  static getAllWindows() {
    return MockBrowserWindow.instances.filter((win) => !win.destroyed);
  }

  destroyed = false;
  options: Record<string, unknown>;
  loadedUrls: string[] = [];
  webContents: {
    id: number;
    getURL: () => string;
    isDestroyed: () => boolean;
    on: ReturnType<typeof vi.fn>;
    once: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
  };

  constructor(options: Record<string, unknown>) {
    super();
    this.options = options;
    let currentUrl = 'about:blank';
    this.webContents = {
      id: MockBrowserWindow.nextWebContentsId++,
      getURL: () => currentUrl,
      isDestroyed: () => this.destroyed,
      on: vi.fn(),
      once: vi.fn(),
      send: vi.fn(),
    };
    this.loadURL = vi.fn(async (url: string) => {
      currentUrl = url;
      this.loadedUrls.push(url);
      return undefined;
    });
    MockBrowserWindow.instances.push(this);
  }

  loadURL: ReturnType<typeof vi.fn>;

  isDestroyed() {
    return this.destroyed;
  }

  isMinimized() {
    return false;
  }

  restore() {}

  show() {}

  focus() {}

  close() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('closed');
  }
}

class MockTray extends EventEmitter {
  setToolTip = vi.fn();
  setContextMenu = vi.fn();
}

const loadHostChain = async () => {
  const handlers = new Map<string, IpcHandler>();
  let exposedApi: ElectronExposeMap | null = null;
  let currentSender: { id: number } | null = null;

  const appEmitter = new EventEmitter();
  const readyPromise = Promise.resolve();
  const app = Object.assign(appEmitter, {
    isPackaged: true,
    isReady: () => true,
    whenReady: () => readyPromise,
    requestSingleInstanceLock: () => true,
    quit: vi.fn(),
    getPath: vi.fn(() => process.cwd()),
    getAppPath: vi.fn(() => process.cwd()),
    getVersion: vi.fn(() => '0.4.5'),
    getLoginItemSettings: vi.fn(() => ({ openAtLogin: false })),
    setLoginItemSettings: vi.fn(),
    dock: { hide: vi.fn() },
  });

  const ipcMain = {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
    }),
    on: vi.fn(),
  };

  const ipcRenderer = {
    invoke: vi.fn(async (channel: string, payload?: unknown) => {
      const handler = handlers.get(channel);
      if (!handler) {
        throw new Error(`Missing ipcMain handler: ${channel}`);
      }
      const result: unknown = await handler({ sender: currentSender }, payload);
      return result;
    }),
    send: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
    removeAllListeners: vi.fn(),
  };

  const electronMock = {
    app,
    ipcMain,
    ipcRenderer,
    contextBridge: {
      exposeInMainWorld: vi.fn((name: string, api: ElectronExposeMap) => {
        if (name === 'electron') {
          exposedApi = api;
        }
      }),
    },
    BrowserWindow: cast<typeof MockBrowserWindow>(MockBrowserWindow),
    Tray: MockTray,
    Menu: {
      buildFromTemplate: vi.fn(() => ({ items: [] })),
      setApplicationMenu: vi.fn(),
    },
    dialog: {
      showMessageBox: vi.fn(async () => ({ response: 1 })),
    },
    shell: {
      showItemInFolder: vi.fn(),
      openExternal: vi.fn(async () => true),
    },
    nativeImage: {
      createFromPath: vi.fn(() => ({
        isEmpty: () => false,
        resize: () => ({ isEmpty: () => false }),
      })),
    },
    protocol: {
      registerSchemesAsPrivileged: vi.fn(),
      handle: vi.fn(),
    },
    net: {
      fetch: vi.fn(async () => new Response('')),
    },
  };

  const backendProcess = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    send: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
  };
  backendProcess.stdout = new EventEmitter();
  backendProcess.stderr = new EventEmitter();
  backendProcess.send = vi.fn();
  backendProcess.kill = vi.fn();

  const forkMock = vi.fn(() => {
    queueMicrotask(() => {
      backendProcess.emit('message', {
        type: 'listening',
        port: 39000,
        baseUrl: 'http://127.0.0.1:39000',
      });
    });
    return backendProcess;
  });

  global.fetch = vi.fn(async (input: string | URL) => {
    const requestUrl = String(input);
    if (requestUrl.endsWith('/health')) {
      return new Response(JSON.stringify({ ok: false }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (requestUrl.includes('/api/hub/local-write-trust/probe')) {
      return new Response(JSON.stringify({ success: false }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  const restoreModuleLoad = patchModuleLoad({
    electron: electronMock,
    'node:child_process': { fork: forkMock },
    'child_process': { fork: forkMock },
    'electron-updater': { autoUpdater: { autoDownload: false, autoInstallOnAppQuit: false, logger: null, on: vi.fn() } },
    './storage/editor-storage-service.cjs': {
      closeAll: vi.fn(),
      getDb: vi.fn(),
      validateProjectFolder: vi.fn((projectPath: string) => ({
        ok: true,
        normalizedPath: projectPath,
        db: {},
      })),
    },
  });

  clearCjsCache(mainPath);
  clearCjsCache(preloadPath);
  await import(mainPath);
  await import(preloadPath);
  // 等待 app.whenReady() 回调同步段执行（其中注册了全部 IPC handler）。
  await new Promise((resolve) => setTimeout(resolve, 0));

  return {
    handlers,
    getExposedApi: () => exposedApi,
    setCurrentSender: (sender: { id: number } | null) => {
      currentSender = sender;
    },
    restoreModuleLoad,
  };
};

describe('desktop host chain bootstrap contract', () => {
  let loadResult: LoadHostChainResult | null = null;

  afterEach(() => {
    loadResult?.restoreModuleLoad();
    global.fetch = originalFetch;
    clearCjsCache(mainPath);
    clearCjsCache(preloadPath);
    MockBrowserWindow.instances = [];
    MockBrowserWindow.nextWebContentsId = 2000;
    vi.clearAllMocks();
  });

  it('preload 通过 main IPC 打开 editor，并让 editor 窗口读取对应 bootstrap', async () => {
    const host = await loadHostChain();
    loadResult = host;
    const api = host.getExposedApi();
    expect(api).not.toBeNull();

    await Promise.resolve();
    await Promise.resolve();
    const beforeOpenCount = MockBrowserWindow.instances.length;

    host.setCurrentSender({ id: 1 });
    const opened = await (api?.['openEditorWindow'] as (payload: unknown) => Promise<unknown>)({
      projectPath: '/tmp/demo.iartproj',
      sessionToken: 'session-demo',
    });

    expect(opened).toEqual({ ok: true });
    expect(MockBrowserWindow.instances.length).toBeGreaterThan(beforeOpenCount);

    const editorWindow = MockBrowserWindow.instances.find((win) =>
      win.loadedUrls.some((url) => url === 'http://127.0.0.1:39000/editor/'),
    );
    expect(editorWindow).toBeDefined();
    if (!editorWindow) {
      throw new Error('editor_window_not_found');
    }
    const getEditorBootstrap = host.handlers.get('get-editor-bootstrap');
    expect(typeof getEditorBootstrap).toBe('function');
    if (!getEditorBootstrap) {
      throw new Error('get_editor_bootstrap_handler_not_found');
    }

    const bootstrap = await getEditorBootstrap({ sender: editorWindow.webContents });

    expect(bootstrap).toMatchObject({
      runtime: 'desktop',
      projectPath: '/tmp/demo.iartproj',
      sessionToken: 'session-demo',
      locale: 'zh-CN',
      windowContext: {
        entry: 'editor',
      },
    });
    if (!isRecord(bootstrap) || typeof bootstrap['backendBaseUrl'] !== 'string') {
      throw new Error('Expected backendBaseUrl');
    }
    expect(bootstrap['backendBaseUrl']).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect(editorWindow.loadedUrls[0]).toBe('http://127.0.0.1:39000/editor/');
  });
});
