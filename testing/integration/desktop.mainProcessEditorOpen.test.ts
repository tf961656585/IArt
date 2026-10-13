// @vitest-environment node
import { EventEmitter } from 'node:events';
import { clearCjsCache, patchModuleLoad, cast, sharedRequire } from './helpers/cjs-mock';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
const mainPath = path.join(process.cwd(), 'apps/desktop-shell/dist/main.cjs');
const bootstrapPath = path.join(process.cwd(), 'apps/desktop-shell/dist/desktop-shell-bootstrap.cjs');
const windowsPath = path.join(process.cwd(), 'apps/desktop-shell/dist/desktop-shell-windows.cjs');
const ipcPath = path.join(process.cwd(), 'apps/desktop-shell/dist/desktop-shell-ipc.cjs');
const devToolsShortcutsPath = path.join(
  process.cwd(),
  'apps/desktop-shell/dist/window/devtools-shortcuts.cjs',
);

type IpcHandler = (...args: unknown[]) => unknown;
type LoadMainWithMocksResult = Awaited<ReturnType<typeof loadMainWithMocks>>;
type BeforeInputHandler = (
  event: { preventDefault: () => void },
  input: Record<string, unknown>,
) => void;

class MockBrowserWindow extends EventEmitter {
  static instances: MockBrowserWindow[] = [];
  static nextWebContentsId = 1000;
  static getAllWindows() {
    return MockBrowserWindow.instances.filter((win) => !win.destroyed);
  }

  destroyed = false;
  minimized = false;
  shown = false;
  focused = false;
  options: Record<string, unknown>;
  loadedUrls: string[] = [];
  webContents: {
    id: number;
    getURL: () => string;
    isDestroyed: () => boolean;
    on: ReturnType<typeof vi.fn>;
    once: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    toggleDevTools: ReturnType<typeof vi.fn>;
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
      toggleDevTools: vi.fn(),
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
    return this.minimized;
  }

  restore() {
    this.minimized = false;
  }

  show() {
    this.shown = true;
  }

  focus() {
    this.focused = true;
  }

  close() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('closed');
  }
}

const getBeforeInputHandler = (win: MockBrowserWindow) => {
  const call = win.webContents.on.mock.calls.find(
    ([eventName]) => eventName === 'before-input-event',
  );
  return call?.[1] as BeforeInputHandler | undefined;
};

const clearDesktopShellMainCaches = () => {
  clearCjsCache(mainPath);
  clearCjsCache(bootstrapPath);
  clearCjsCache(windowsPath);
  clearCjsCache(ipcPath);
  clearCjsCache(devToolsShortcutsPath);
};

const createElectronMock = (appReady: boolean) => {
  const appEmitter = new EventEmitter();
  const readyPromise = appReady ? Promise.resolve() : new Promise<void>(() => {});
  const app = Object.assign(appEmitter, {
    isPackaged: false,
    commandLine: { appendSwitch: vi.fn() },
    isReady: () => appReady,
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

  return {
    app,
    ipcMain: {
      handle: vi.fn(),
      on: vi.fn(),
    },
    protocol: {
      registerSchemesAsPrivileged: vi.fn(),
      handle: vi.fn(),
    },
    net: {
      fetch: vi.fn(),
    },
    BrowserWindow: cast<typeof MockBrowserWindow>(MockBrowserWindow),
    Tray: vi.fn(),
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
    session: { fromPartition: vi.fn() },
  };
};

const loadMainWithMocks = async () => {
  const handlers = new Map<string, IpcHandler>();
  const electronMock = createElectronMock(false);

  const ipcMain = {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
    }),
    on: vi.fn(),
  };

  electronMock.ipcMain = ipcMain;

  const restoreModuleLoad = patchModuleLoad({
    electron: electronMock,
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

  clearDesktopShellMainCaches();
  sharedRequire(mainPath);

  return {
    handlers,
    app: electronMock.app,
    ipcMain,
    restoreModuleLoad,
  };
};

const loadWindowControllerWithMocks = async () => {
  const electronMock = createElectronMock(true);
  const restoreModuleLoad = patchModuleLoad({
    electron: electronMock,
    './storage/editor-storage-service.cjs': {
      getDb: vi.fn(),
      validateProjectFolder: vi.fn((projectPath: string) => ({
        ok: true,
        normalizedPath: projectPath,
        db: {},
      })),
    },
    './storage/editor-storage-local-media.cjs': { registerMediaDir: vi.fn(), unregisterMediaDir: vi.fn() },
  });
  clearDesktopShellMainCaches();
  const mod = sharedRequire(windowsPath) as {
    createWindowController: (options: Record<string, unknown>) => {
      showMainWindow: (startUrl: string | null) => void;
    };
  };
  return {
    createWindowController: mod.createWindowController,
    electronMock,
    restoreModuleLoad,
  };
};

describe('desktop main process editor open contract', () => {
  let loadResult: LoadMainWithMocksResult | null = null;
  let restoreWindowController: (() => void) | null = null;

  afterEach(() => {
    delete process.env['IART_DEV_EDITOR_URL'];
    loadResult?.restoreModuleLoad();
    restoreWindowController?.();
    clearDesktopShellMainCaches();
    MockBrowserWindow.instances = [];
    MockBrowserWindow.nextWebContentsId = 1000;
    restoreWindowController = null;
    loadResult = null;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('open-editor-window 在开发态固定加载 editor HTTP 根入口', async () => {
    process.env['IART_DEV_EDITOR_URL'] = 'http://127.0.0.1:3300/editor-dev?legacy=1';
    const { handlers, ...rest } = await loadMainWithMocks();
    loadResult = { handlers, ...rest };

    const openEditorWindow = handlers.get('open-editor-window');
    expect(typeof openEditorWindow).toBe('function');

    const result = await openEditorWindow?.({}, {
      projectPath: '/tmp/demo.iartproj',
      sessionToken: 'session-demo',
    });

    expect(result).toEqual({ ok: true });
    expect(MockBrowserWindow.instances).toHaveLength(1);

    const win = MockBrowserWindow.instances[0];
    expect(win).toBeDefined();
    if (!win) {
      throw new Error('editor_window_not_found');
    }
    expect(win.options['webPreferences']).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    });
    const preloadPath = String((win.options['webPreferences'] as Record<string, unknown>)['preload'])
      .split(path.sep)
      .join('/');
    expect(preloadPath).toContain('apps/desktop-shell/dist/preload.cjs');
    expect(win.loadedUrls).toHaveLength(1);
    expect(win.loadedUrls[0]).toBe('http://127.0.0.1:3300/');
    expect(getBeforeInputHandler(win)).toBeTypeOf('function');
  });

  it('Hub 主窗口创建后挂载 DevTools 快捷键', async () => {
    const { createWindowController, restoreModuleLoad } = await loadWindowControllerWithMocks();
    restoreWindowController = restoreModuleLoad;
    const controller = createWindowController({
      runtime: {},
      resolveEditorStartUrl: () => 'http://127.0.0.1:3300/',
      resolveHubStartUrl: () => 'http://127.0.0.1:3200/',
    });

    controller.showMainWindow('http://127.0.0.1:3200/');
    const win = MockBrowserWindow.instances[0];

    expect(win).toBeDefined();
    if (!win) {
      throw new Error('hub_window_not_found');
    }
    expect(win.loadedUrls).toEqual(['http://127.0.0.1:3200/']);
    expect(getBeforeInputHandler(win)).toBeTypeOf('function');
  });

  it('DevTools 快捷键只响应 F12 与 Cmd/Ctrl+Shift+I', async () => {
    process.env['IART_DEV_EDITOR_URL'] = 'http://127.0.0.1:3300/editor-dev?legacy=1';
    const { handlers, ...rest } = await loadMainWithMocks();
    loadResult = { handlers, ...rest };

    const openEditorWindow = handlers.get('open-editor-window');
    await openEditorWindow?.({}, {
      projectPath: '/tmp/demo.iartproj',
      sessionToken: 'session-demo',
    });

    const win = MockBrowserWindow.instances[0];
    expect(win).toBeDefined();
    if (!win) {
      throw new Error('editor_window_not_found');
    }
    const handler = getBeforeInputHandler(win);
    expect(handler).toBeTypeOf('function');
    if (!handler) {
      throw new Error('devtools_shortcut_handler_not_found');
    }

    const f12Event = { preventDefault: vi.fn() };
    handler(f12Event, { type: 'keyDown', key: 'F12' });
    expect(f12Event.preventDefault).toHaveBeenCalledTimes(1);
    expect(win.webContents.toggleDevTools).toHaveBeenCalledTimes(1);

    const ctrlShiftIEvent = { preventDefault: vi.fn() };
    handler(ctrlShiftIEvent, { type: 'keyDown', key: 'I', control: true, shift: true });
    expect(ctrlShiftIEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(win.webContents.toggleDevTools).toHaveBeenCalledTimes(2);

    const metaShiftIEvent = { preventDefault: vi.fn() };
    handler(metaShiftIEvent, { type: 'keyDown', code: 'KeyI', meta: true, shift: true });
    expect(metaShiftIEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(win.webContents.toggleDevTools).toHaveBeenCalledTimes(3);

    const ordinaryEvent = { preventDefault: vi.fn() };
    handler(ordinaryEvent, { type: 'keyDown', key: 'A', control: true, shift: true });
    expect(ordinaryEvent.preventDefault).not.toHaveBeenCalled();
    expect(win.webContents.toggleDevTools).toHaveBeenCalledTimes(3);
  });

  it('open-editor-window 对无效 payload 直接拒绝，不创建窗口', async () => {
    const { handlers, ...rest } = await loadMainWithMocks();
    loadResult = { handlers, ...rest };

    const openEditorWindow = handlers.get('open-editor-window');
    const result = await openEditorWindow?.({}, {
      projectPath: '',
      sessionToken: '',
    });

    expect(result).toEqual({
      ok: false,
      code: 'invalid-editor-window-target',
      message: 'editor window target invalid',
      projectPath: null,
    });
    expect(MockBrowserWindow.instances).toHaveLength(0);
  });

});
