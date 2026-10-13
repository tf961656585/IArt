// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { clearCjsCache, patchModuleLoad, cast, sharedRequire } from './helpers/cjs-mock';
import { afterEach, describe, expect, it, vi } from 'vitest';
const mainPath = path.join(process.cwd(), 'apps/desktop-shell/dist/main.cjs');
const desktopShellDistDir = path.join(process.cwd(), 'apps/desktop-shell/dist');
const originalFetch = global.fetch;

type IpcHandler = (...args: unknown[]) => unknown;
type LoadMainWithE2EResult = Awaited<ReturnType<typeof loadMainWithE2E>>;
type MockFetchResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
  url: string;
  headers: Headers;
  redirected: boolean;
  statusText: string;
  type: 'basic';
  clone: () => MockFetchResponse;
};
type FetchMock = (input: string | URL, init?: RequestInit) => Promise<MockFetchResponse>;

type ForkArgs = [entry: string, ...rest: unknown[]];

class MockBrowserWindow extends EventEmitter {
  static instances: MockBrowserWindow[] = [];
  static nextWebContentsId = 3000;

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
    executeJavaScript: ReturnType<typeof vi.fn>;
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
      executeJavaScript: vi.fn(async () => true),
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
}

class MockTray extends EventEmitter {
  setToolTip = vi.fn();
  setContextMenu = vi.fn();
}

const flushMicrotasks = async (rounds = 6) => {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

const waitForCondition = async (
  predicate: () => boolean,
  options: { timeoutMs?: number; intervalMs?: number } = {},
) => {
  const timeoutMs = options.timeoutMs ?? 1200;
  const intervalMs = options.intervalMs ?? 10;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('condition_not_met_in_time');
};

const createMockResponse = (
  input: string | URL,
  body: unknown,
  init: { ok?: boolean; status?: number } = {},
): MockFetchResponse => ({
  ok: init.ok ?? true,
  status: init.status ?? 200,
  json: async () => body,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  url: String(input),
  headers: new Headers(),
  redirected: false,
  statusText: init.status === 503 ? 'Service Unavailable' : 'OK',
  type: 'basic' as const,
  clone: () => createMockResponse(input, body, init),
});

const clearDesktopShellDistCache = () => {
  for (const cachedPath of Object.keys(sharedRequire.cache)) {
    if (cachedPath.startsWith(desktopShellDistDir)) {
      clearCjsCache(cachedPath);
    }
  }
};

const actStartupFailure = async () => {
  for (let index = 0; index < 3; index += 1) {
    await Promise.resolve();
  }
  await vi.advanceTimersByTimeAsync(6000);
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
  }
};

const loadMainWithE2E = async (options: {
  fetchMock: FetchMock;
  healthMock?: FetchMock;
  forkBehavior?: 'listening' | 'startup-error' | 'silent' | 'exit-before-listening';
}) => {
  const handlers = new Map<string, IpcHandler>();
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

  const electronMock = {
    app,
    ipcMain,
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
      fetch: vi.fn(async () => createMockResponse('file://mock', '')),
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
  const forkMock = vi.fn((..._args: ForkArgs) => {
    if (options.forkBehavior === 'startup-error') {
      queueMicrotask(() => {
        backendProcess.emit('message', {
          type: 'startup-error',
          code: 'EADDRINUSE',
          message: 'listen EADDRINUSE: address already in use 127.0.0.1:39000',
        });
      });
    } else if (options.forkBehavior === 'exit-before-listening') {
      queueMicrotask(() => {
        backendProcess.emit('exit', 1, null);
      });
    } else if (options.forkBehavior !== 'silent') {
      queueMicrotask(() => {
        backendProcess.emit('message', {
          type: 'listening',
          port: 39000,
          baseUrl: 'http://127.0.0.1:39000',
        });
      });
    }
    return backendProcess;
  });

  global.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
    if (String(input).endsWith('/health')) {
      if (options.healthMock) {
        return options.healthMock(input, init);
      }
      return createMockResponse(input, { ok: false }, { ok: false, status: 503 });
    }
    return options.fetchMock(input, init);
  }) as typeof fetch;

  // vitest 的 Node 版本与 better-sqlite3 的 electron 预编译二进制 ABI 不一致，
  // 无法真实加载；这里用一个最小内存假实现替代（编辑器窗口打开链路只触及
  // pragma/exec/prepare/close，不依赖真实 SQL 语义）。
  const fakeSqliteRuntimeDir = path.join(
    process.cwd(),
    'apps/backend/native-modules/better-sqlite3/electron',
  );
  class FakeSqliteStatement {
    run() {
      return { changes: 0, lastInsertRowid: 0 };
    }
    get() {
      return undefined;
    }
    all() {
      return [];
    }
  }
  class FakeSqliteDatabase {
    prepare() {
      return new FakeSqliteStatement();
    }
    pragma() {
      return undefined;
    }
    transaction<TArgs extends unknown[]>(fn: (...args: TArgs) => void) {
      return (...args: TArgs) => fn(...args);
    }
    exec() {
      return undefined;
    }
    close() {
      return undefined;
    }
  }

  const restoreModuleLoad = patchModuleLoad({
    electron: electronMock,
    'electron-updater': { autoUpdater: { autoDownload: false, autoInstallOnAppQuit: false, logger: null, on: vi.fn() } },
    'node:child_process': { fork: forkMock },
    'child_process': { fork: forkMock },
    [fakeSqliteRuntimeDir]: FakeSqliteDatabase,
  });

  clearDesktopShellDistCache();
  sharedRequire(mainPath);

  return { handlers, backendProcess, forkMock, restoreModuleLoad };
};

describe('desktop open project editor-ready smoke contract', () => {
  let reportFile: string | null = null;
  let previousReportPath: string | undefined;
  let previousAutoExit: string | undefined;
  let loadResult: LoadMainWithE2EResult | null = null;
  const projectDirsToClean: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
    loadResult?.restoreModuleLoad();
    global.fetch = originalFetch;
    clearDesktopShellDistCache();
    MockBrowserWindow.instances = [];
    MockBrowserWindow.nextWebContentsId = 3000;
    vi.clearAllMocks();

    if (previousReportPath === undefined) {
      delete process.env['IART_E2E_REPORT_PATH'];
    } else {
      process.env['IART_E2E_REPORT_PATH'] = previousReportPath;
    }
    delete process.env['IART_E2E_OPEN_EDITOR_PROJECT_PATH'];
    if (previousAutoExit === undefined) {
      delete process.env['IART_E2E_AUTO_EXIT'];
    } else {
      process.env['IART_E2E_AUTO_EXIT'] = previousAutoExit;
    }

    if (reportFile) {
      fs.rmSync(reportFile, { force: true });
      reportFile = null;
    }

    while (projectDirsToClean.length > 0) {
      const dir = projectDirsToClean.pop();
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('desktop E2E 启动链路不再直调 /api/projects/open，也不会自动执行 openEditorWindow', async () => {
    previousReportPath = process.env['IART_E2E_REPORT_PATH'];
    previousAutoExit = process.env['IART_E2E_AUTO_EXIT'];

    reportFile = path.join(
      process.cwd(),
      `.tmp-desktop-e2e-report-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`,
    );
    process.env['IART_E2E_REPORT_PATH'] = reportFile;
    process.env['IART_E2E_AUTO_EXIT'] = '0';

    const fetchMock = vi.fn(async (input: string | URL) => createMockResponse(input, { config: {} }));

    loadResult = await loadMainWithE2E({ fetchMock });
    await waitForCondition(() => MockBrowserWindow.instances.length > 0);

    expect(MockBrowserWindow.instances.length).toBeGreaterThan(0);
    const hubWindow = MockBrowserWindow.instances[0];
    expect(hubWindow).toBeDefined();
    if (!hubWindow) {
      throw new Error('hub_window_not_found');
    }
    await flushMicrotasks();

    expect(
      fetchMock.mock.calls.some(([requestUrl]) => String(requestUrl).includes('/api/projects/open')),
    ).toBe(false);
    expect(hubWindow.webContents.executeJavaScript).not.toHaveBeenCalled();
  });

  it('同端口已有健康 backend 时仍优先复用，但不会为了 E2E 自动打开项目', async () => {
    previousReportPath = process.env['IART_E2E_REPORT_PATH'];
    previousAutoExit = process.env['IART_E2E_AUTO_EXIT'];
    reportFile = path.join(
      process.cwd(),
      `.tmp-desktop-e2e-report-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`,
    );
    process.env['IART_E2E_REPORT_PATH'] = reportFile;
    process.env['IART_E2E_AUTO_EXIT'] = '0';

    const fetchMock = vi.fn(async (input: string | URL) => createMockResponse(input, { config: {} }));
    const healthMock = vi.fn(async (input: string | URL) =>
      createMockResponse(input, { ok: true }, { ok: true, status: 200 }),
    );

    const { forkMock, ...rest } = await loadMainWithE2E({
      fetchMock,
      healthMock,
    });
    loadResult = { forkMock, ...rest };
    await waitForCondition(() => MockBrowserWindow.instances.length > 0);

    const hubWindow = MockBrowserWindow.instances[0];
    expect(hubWindow).toBeDefined();
    if (!hubWindow) {
      throw new Error('hub_window_not_found');
    }
    const didFinishLoadHandler = hubWindow.webContents.once.mock.calls.find(
      ([eventName]) => eventName === 'did-finish-load',
    )?.[1] as (() => void) | undefined;

    expect(typeof didFinishLoadHandler).toBe('function');
    didFinishLoadHandler?.();
    await flushMicrotasks();

    expect(healthMock).toHaveBeenCalledWith(
      'http://127.0.0.1:39000/health',
      expect.objectContaining({ method: 'GET' }),
    );
    const backendForkCalls = (forkMock.mock.calls as ForkArgs[]).filter(([entry]) =>
      String(entry || "").includes("/apps/backend/dist/main.cjs"),
    );
    expect(backendForkCalls).toHaveLength(0);
    expect(
      fetchMock.mock.calls.some(([requestUrl]) => String(requestUrl).includes('/api/projects/open')),
    ).toBe(false);
    expect(hubWindow.webContents.executeJavaScript).not.toHaveBeenCalled();
  });

  it('显式 E2E 项目路径会走 open-editor-window 主链并写入可观测事件', async () => {
    previousReportPath = process.env['IART_E2E_REPORT_PATH'];
    previousAutoExit = process.env['IART_E2E_AUTO_EXIT'];
    reportFile = path.join(
      process.cwd(),
      `.tmp-desktop-e2e-report-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`,
    );
    const projectPath = path.join(
      process.cwd(),
      `.tmp-desktop-e2e-project-${Date.now()}-${Math.random().toString(16).slice(2)}.iartproj`,
    );
    // openOrFocusEditorWindow 会校验项目目录必须存在且包含 project.sqlite。
    fs.mkdirSync(projectPath, { recursive: true });
    fs.writeFileSync(path.join(projectPath, 'project.sqlite'), '');
    projectDirsToClean.push(projectPath);
    process.env['IART_E2E_REPORT_PATH'] = reportFile;
    process.env['IART_E2E_AUTO_EXIT'] = '0';
    process.env['IART_E2E_OPEN_EDITOR_PROJECT_PATH'] = projectPath;

    const fetchMock = vi.fn(async (input: string | URL) => createMockResponse(input, { config: {} }));

    loadResult = await loadMainWithE2E({ fetchMock });
    await waitForCondition(() => MockBrowserWindow.instances.length > 1);
    await flushMicrotasks();

    const editorWindow = MockBrowserWindow.instances[1];
    expect(editorWindow).toBeDefined();
    expect(editorWindow?.loadedUrls[0] ?? '').toBe('http://127.0.0.1:39000/editor/');

    const events = fs
      .readFileSync(reportFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type?: unknown; detail?: { backendBaseUrl?: unknown } });
    expect(events.map((event) => event.type)).toContain('app-ready');
    expect(events.map((event) => event.type)).toContain('backend-listening');
    expect(events.map((event) => event.type)).toContain('hub-open-editor-succeeded');
  });

  it('fork 出来的 backend 主动上报启动失败时会明确收口，不再无限等待 listening', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (input: string | URL) =>
      createMockResponse(input, { editorOpenTarget: null }),
    );

    loadResult = await loadMainWithE2E({
      fetchMock,
      forkBehavior: 'startup-error',
    });
    await actStartupFailure();

    expect(MockBrowserWindow.instances.length).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(MockBrowserWindow.instances[0]?.loadedUrls[0] ?? '').toContain('data:text/html');
  }, 15000);

  it('fork 出来的 backend 未上报即退出时显示启动失败页', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (input: string | URL) =>
      createMockResponse(input, { editorOpenTarget: null }),
    );

    loadResult = await loadMainWithE2E({
      fetchMock,
      forkBehavior: 'exit-before-listening',
    });
    await actStartupFailure();

    expect(MockBrowserWindow.instances.length).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(MockBrowserWindow.instances[0]?.loadedUrls[0] ?? '').toContain('data:text/html');
  }, 15000);

  it('fork 路径迟迟不 ready 时不创建假成功窗口，也不直调业务 API', async () => {
    const fetchMock = vi.fn(async (input: string | URL) =>
      createMockResponse(input, { editorOpenTarget: null }),
    );

    loadResult = await loadMainWithE2E({
      fetchMock,
      forkBehavior: 'silent',
    });
    await flushMicrotasks();

    expect(MockBrowserWindow.instances).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  }, 15000);
});
