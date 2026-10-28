// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AppUpdateCommandResult,
  AppUpdateState,
} from '@iart/contracts';
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  cjsRequireAs,
  clearCjsCache,
  patchModuleLoad,
  sharedRequire,
} from './helpers/cjs-mock';

const updaterPath = path.join(process.cwd(), 'apps/desktop-shell/dist/desktop-shell-updater.cjs');
const bridgePath = path.join(process.cwd(), 'apps/desktop-shell/dist/update/electron-updater-bridge.cjs');
const updateStatePath = path.join(process.cwd(), 'apps/desktop-shell/dist/update/app-update-state.cjs');
const pendingPath = path.join(process.cwd(), 'apps/desktop-shell/dist/update/app-update-pending.cjs');
const logPath = path.join(process.cwd(), 'apps/desktop-shell/dist/update/app-update-log.cjs');

type UpdaterController = {
  setupAutoUpdater: () => void;
  scheduleStartupCheck: () => void;
  checkForUpdates: (manual: boolean | undefined) => Promise<AppUpdateCommandResult>;
  startDownload: () => Promise<AppUpdateCommandResult>;
  cancelDownload: () => Promise<AppUpdateCommandResult>;
  installUpdate: () => AppUpdateCommandResult;
  buildUpdateStateSnapshot: () => AppUpdateState;
  revealDownloadedUpdate: () => Promise<AppUpdateCommandResult>;
};

type UpdaterModule = {
  createUpdaterController: (options: {
    getMainWindow: () => MockBrowserWindow | null;
    setAllowQuit: (value: boolean) => void;
  }) => UpdaterController;
};

type MockUpdateFileInfo = {
  url: string;
  sha512?: string;
  size?: number;
};

type MockUpdateInfo = {
  version: string;
  files: MockUpdateFileInfo[];
  releaseDate: string;
  releaseNotes?: string | null;
  sha512?: string;
};

type UpdateRuntimeMock = {
  resolveUpdatePlatform: () => 'darwin' | 'win32' | 'linux';
  resolveUpdateArch: () => 'x64' | 'arm64' | 'ia32';
  resolveUpdateChannel: () => 'stable';
  resolveCurrentAppVersion: () => string;
  isSupportedUpdateTarget: () => boolean;
  compareVersions: (left: string, right: string) => number;
};

type MockBrowserWindow = {
  webContents: {
    send: ReturnType<typeof vi.fn>;
  };
  isDestroyed: () => boolean;
};

type MockAutoUpdater = {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  logger: MockUpdaterLogger | null;
  on: ReturnType<typeof vi.fn>;
  checkForUpdates: ReturnType<typeof vi.fn>;
  downloadUpdate: ReturnType<typeof vi.fn>;
  handlers: Map<string, Array<(payload?: unknown) => void>>;
  emit: (event: string, payload?: unknown) => void;
};

type MockUpdaterLogger = {
  info: (message?: unknown) => void;
  warn: (message?: unknown) => void;
  error: (message?: unknown) => void;
  debug: (message: string) => void;
};

// electron-updater 顶层导出的 CancellationToken 替身：
// 真实的 cancel() 只置位并触发监听回调，不是抛错；downloadUpdate 侧的 reject 由 mock 自行实现。
class MockCancellationToken {
  cancelled = false;

  private readonly cancelHandlers: Array<() => void> = [];

  onCancelRequested(handler: () => void): void {
    this.cancelHandlers.push(handler);
    if (this.cancelled) handler();
  }

  cancel(): void {
    this.cancelled = true;
    for (const handler of this.cancelHandlers) handler();
  }
}

type LoadedUpdater = {
  controller: UpdaterController;
  mockAutoUpdater: MockAutoUpdater;
  mainWindow: MockBrowserWindow;
  restore: () => void;
  tempRoot: string;
  appOn: ReturnType<typeof vi.fn>;
  showItemInFolder: ReturnType<typeof vi.fn>;
  openPath: ReturnType<typeof vi.fn>;
  emit: (event: string, payload?: unknown) => void;
  setCurrentVersion: (version: string) => void;
  setSupportedTarget: (supported: boolean) => void;
  setPlatform: (platform: 'darwin' | 'win32' | 'linux') => void;
  setArch: (arch: 'x64' | 'arm64' | 'ia32') => void;
};

let loaded: LoadedUpdater | null = null;

const clearUpdaterModules = (): void => {
  clearCjsCache(updaterPath);
  clearCjsCache(bridgePath);
  clearCjsCache(updateStatePath);
  clearCjsCache(pendingPath);
  clearCjsCache(logPath);
};

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const UPDATE_INFO_DARWIN: MockUpdateInfo = {
  version: '0.5.1',
  releaseDate: '2026-05-06T07:10:02.000Z',
  releaseNotes: 'bug fixes',
  files: [
    { url: 'IARTStudio-0.5.1-mac-arm64.dmg', sha512: 'c2hhNTEyLWRlbW8tZG1n', size: 2048 },
    { url: 'IARTStudio-0.5.1-mac-arm64.zip', sha512: 'c2hhNTEyLWRlbW8temlw', size: 1024 },
  ],
};

const UPDATE_INFO_WIN32: MockUpdateInfo = {
  version: '0.5.1',
  releaseDate: '2026-05-06T07:10:02.000Z',
  files: [
    { url: 'IARTStudio-Setup-0.5.1-x64.exe', sha512: 'c2hhNTEyLWRlbW8tZXhl', size: 3072 },
  ],
};

const loadUpdater = async (options: {
  packaged: boolean | undefined;
  platform: 'darwin' | 'win32' | 'linux' | undefined;
  withAppUpdateYml?: boolean;
}): Promise<LoadedUpdater> => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iart-updater-test-'));
  const appOn = vi.fn();
  const showItemInFolder = vi.fn();
  const openPath = vi.fn();
  let currentVersion = '0.5.0';
  let supportedTarget = true;
  let currentPlatform = options.platform || 'darwin';
  let currentArch: 'x64' | 'arm64' | 'ia32' = options.platform === 'win32' ? 'x64' : 'arm64';
  let allowQuit = false;

  const appMock = {
    isPackaged: options.packaged ?? true,
    getVersion: () => currentVersion,
    getPath: (name: string) => {
      if (name === 'logs') return path.join(tempRoot, 'logs');
      return path.join(tempRoot, 'userData');
    },
    on: appOn,
  };

  const runtimeMock: UpdateRuntimeMock = {
    resolveUpdatePlatform: () => currentPlatform,
    resolveUpdateArch: () => currentArch,
    resolveUpdateChannel: () => 'stable',
    resolveCurrentAppVersion: () => currentVersion,
    isSupportedUpdateTarget: () => supportedTarget,
    compareVersions: (left: string, right: string) => {
      const toParts = (value: string) =>
        value.replace(/^v/, '').split('.').map((part) => Number.parseInt(part, 10) || 0);
      const leftParts = toParts(left);
      const rightParts = toParts(right);
      const length = Math.max(leftParts.length, rightParts.length);
      for (let index = 0; index < length; index += 1) {
        const leftValue = leftParts[index] || 0;
        const rightValue = rightParts[index] || 0;
        if (leftValue > rightValue) return 1;
        if (leftValue < rightValue) return -1;
      }
      return 0;
    },
  };

  // autoUpdater 替身打在 electron-updater 模块边界；状态机、契约 parse、事件发送在桥接中真实执行。
  const mockAutoUpdater: MockAutoUpdater = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    logger: null,
    handlers: new Map(),
    emit: (event: string, payload?: unknown) => {
      for (const listener of mockAutoUpdater.handlers.get(event) ?? []) {
        listener(payload);
      }
    },
    on: vi.fn((event: string, listener: (payload?: unknown) => void) => {
      const list = mockAutoUpdater.handlers.get(event) ?? [];
      list.push(listener);
      mockAutoUpdater.handlers.set(event, list);
    }),
    checkForUpdates: vi.fn(async () => {
      mockAutoUpdater.emit('checking-for-update');
      mockAutoUpdater.emit('update-not-available', {
        version: currentVersion,
        releaseDate: '2026-01-01T00:00:00.000Z',
        files: [],
      });
      return null;
    }),
    downloadUpdate: vi.fn(async () => []),
  };

  // 打包态下 resolveUpdatePublishUrl 从 process.resourcesPath/app-update.yml 读取发布地址，
  // 这里为打包态测试提供对应的 resources 目录与 app-update.yml 夹具。
  const resourcesDir = path.join(tempRoot, 'resources');
  fs.mkdirSync(resourcesDir, { recursive: true });
  if (options.withAppUpdateYml !== false) {
    fs.writeFileSync(
      path.join(resourcesDir, 'app-update.yml'),
      'provider: generic\nurl: https://update.test/releases\n',
      'utf8',
    );
  }
  const resourcesPathDescriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
  Object.defineProperty(process, 'resourcesPath', {
    value: resourcesDir,
    configurable: true,
    writable: true,
  });

  const restoreModuleLoad = patchModuleLoad({
    electron: {
      app: appMock,
      shell: { showItemInFolder, openPath },
    },
    './update/app-update-runtime.cjs': runtimeMock,
    './app-update-runtime.cjs': runtimeMock,
    'electron-updater': { autoUpdater: mockAutoUpdater, CancellationToken: MockCancellationToken },
  });
  const restore = (): void => {
    restoreModuleLoad();
    if (resourcesPathDescriptor) {
      Object.defineProperty(process, 'resourcesPath', resourcesPathDescriptor);
    } else {
      Reflect.deleteProperty(process, 'resourcesPath');
    }
  };

  clearUpdaterModules();
  const mod = cjsRequireAs<UpdaterModule>(sharedRequire(updaterPath));
  const mainWindow: MockBrowserWindow = {
    webContents: { send: vi.fn() },
    isDestroyed: () => false,
  };
  const controller = mod.createUpdaterController({
    getMainWindow: () => mainWindow,
    setAllowQuit: (value: boolean) => {
      allowQuit = value;
    },
  });

  const result: LoadedUpdater = {
    controller,
    mockAutoUpdater,
    mainWindow,
    restore,
    tempRoot,
    appOn,
    showItemInFolder,
    openPath,
    emit: (event: string, payload?: unknown) => mockAutoUpdater.emit(event, payload),
    setCurrentVersion: (version: string) => {
      currentVersion = version;
    },
    setSupportedTarget: (supported: boolean) => {
      supportedTarget = supported;
    },
    setPlatform: (platform: 'darwin' | 'win32' | 'linux') => {
      currentPlatform = platform;
    },
    setArch: (arch: 'x64' | 'arm64' | 'ia32') => {
      currentArch = arch;
    },
  };

  Object.defineProperty(result, 'allowQuit', {
    get: () => allowQuit,
  });

  return result;
};

const countSentEvents = (loaded: LoadedUpdater, type: string): number =>
  loaded.mainWindow.webContents.send.mock.calls.filter((call) => (call[0] as unknown) === 'app-update:event' && (call[1] as { type: string }).type === type).length;

const pendingFileOf = (seam: LoadedUpdater): string => path.join(seam.tempRoot, 'userData', 'pending-update.json');
const downloadedFilePath = (seam: LoadedUpdater, fileName: string): string => path.join(seam.tempRoot, fileName);
const advancePastAutoCheckWindow = (): void => { vi.setSystemTime(new Date(Date.now() + 31 * 60 * 1000)); };

const mockAvailableCheck = (seam: LoadedUpdater, info: MockUpdateInfo = UPDATE_INFO_DARWIN): void => {
  seam.mockAutoUpdater.checkForUpdates.mockImplementation(async () => {
    seam.emit('checking-for-update');
    seam.emit('update-available', info);
    return null;
  });
};
const mockFailingCheck = (seam: LoadedUpdater, message: string): void => {
  seam.mockAutoUpdater.checkForUpdates.mockImplementation(async () => {
    seam.emit('checking-for-update');
    seam.emit('error', new Error(message));
    throw new Error(message);
  });
};

describe('desktop updater lifecycle (electron-updater bridge)', () => {
  afterEach(() => {
    if (loaded) {
      loaded.restore();
      fs.rmSync(loaded.tempRoot, { recursive: true, force: true });
    }
    loaded = null;
    clearUpdaterModules();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('开发态检查更新会跳过，并保留 idle 状态', async () => {
    loaded = await loadUpdater({ packaged: false, platform: undefined });
    loaded.controller.setupAutoUpdater();

    const result = await loaded.controller.checkForUpdates(false);

    expect(result.status).toBe('skipped');
    if (result.status === 'skipped') {
      expect(result.reason).toBe('dev-mode');
    }
    expect(loaded.mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(loaded.controller.buildUpdateStateSnapshot().status).toBe('idle');
  });

  it('桥接在初始化时禁用自动下载与退出时自动安装', async () => {
    loaded = await loadUpdater({ packaged: true, platform: undefined });

    loaded.controller.setupAutoUpdater();

    expect(loaded.mockAutoUpdater.autoDownload).toBe(false);
    expect(loaded.mockAutoUpdater.autoInstallOnAppQuit).toBe(false);
  });

  it('启动检查计划会在打包态 15 秒后触发 checkForUpdates，且不再监听 browser-window-focus', async () => {
    vi.useFakeTimers();
    loaded = await loadUpdater({ packaged: true, platform: undefined });
    loaded.controller.setupAutoUpdater();

    loaded.controller.scheduleStartupCheck();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(loaded.mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(loaded.appOn).not.toHaveBeenCalledWith('browser-window-focus', expect.any(Function));
  });

  it('检查发现更新后停在 available，不自动下载；显式 startDownload 后才下载，失败落 error', async () => {
    loaded = await loadUpdater({ packaged: true, platform: undefined });
    loaded.controller.setupAutoUpdater();

    mockAvailableCheck(loaded, UPDATE_INFO_DARWIN);
    loaded.mockAutoUpdater.downloadUpdate.mockImplementation(async () => {
      throw new Error('download failed for test');
    });

    const result = await loaded.controller.checkForUpdates(false);
    await flushMicrotasks();

    expect(result.status).toBe('success');
    // 发现更新只停在 available：桥接不得自动触发下载。
    expect(loaded.mockAutoUpdater.downloadUpdate).not.toHaveBeenCalled();
    expect(loaded.controller.buildUpdateStateSnapshot().status).toBe('available');

    const downloadResult = await loaded.controller.startDownload();
    await flushMicrotasks();

    expect(loaded.mockAutoUpdater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(downloadResult.status).toBe('failed');
    const state = loaded.controller.buildUpdateStateSnapshot();
    expect(state.status).toBe('error');
  });

  it('显式 startDownload 后模拟下载进度，写入 downloaded 状态和 pending', async () => {
    loaded = await loadUpdater({ packaged: true, platform: undefined });
    loaded.controller.setupAutoUpdater();

    const downloadedFile = path.join(loaded.tempRoot, 'update-cache', 'IARTStudio-0.5.1-mac-arm64.dmg');

    mockAvailableCheck(loaded, UPDATE_INFO_DARWIN);
    loaded.mockAutoUpdater.downloadUpdate.mockImplementation(async () => {
      loaded?.emit('download-progress', { percent: 42, bytesPerSecond: 2048, transferred: 420, total: 2048 });
      loaded?.emit('update-downloaded', { ...UPDATE_INFO_DARWIN, downloadedFile: downloadedFile });
      return [downloadedFile];
    });

    const checkResp = await loaded.controller.checkForUpdates(false);
    expect(checkResp.status).toBe('success');
    expect(loaded.controller.buildUpdateStateSnapshot().status).toBe('available');

    const downloadResp = await loaded.controller.startDownload();
    await flushMicrotasks();

    expect(downloadResp.status).toBe('success');
    const state = loaded.controller.buildUpdateStateSnapshot();
    expect(state.status).toBe('downloaded');
    if (state.status === 'downloaded') {
      expect(state.latestVersion).toBe('0.5.1');
      expect(state.downloadPath).toBe(downloadedFile);
      expect(state.installActions).toContain('open-installer');
      // 安装动作投影不再产出 quit-and-install（枚举保留在契约里）。
      expect(state.installActions).not.toContain('quit-and-install');
    }
    expect(loaded.mainWindow.webContents.send).toHaveBeenCalledWith(
      'app-update:event',
      expect.objectContaining({ type: 'downloaded' }),
    );
    // 进度事件应已通过状态机发出
    expect(countSentEvents(loaded, 'download-progress')).toBeGreaterThan(0);

    const pending = JSON.parse(
      fs.readFileSync(path.join(loaded.tempRoot, 'userData', 'pending-update.json'), 'utf8'),
    ) as { version: string | null; downloadPath: string | null; createdAt: number };
    expect(pending.version).toBe('0.5.1');
    expect(pending.downloadPath).toBe(downloadedFile);
  });

  it('available 状态携带版本、发布日期、说明与映射后的文件列表', async () => {
    loaded = await loadUpdater({ packaged: true, platform: undefined });
    loaded.controller.setupAutoUpdater();

    mockAvailableCheck(loaded, UPDATE_INFO_DARWIN);

    await loaded.controller.checkForUpdates(false);
    await flushMicrotasks();

    expect(loaded.mockAutoUpdater.downloadUpdate).not.toHaveBeenCalled();
    expect(loaded.controller.buildUpdateStateSnapshot().status).toBe('available');

    const events = loaded.mainWindow.webContents.send.mock.calls.filter(
      (call) => (call[0] as unknown) === 'app-update:event',
    );
    const availableEvent = events
      .map((call) => call[1] as { type: string; state: AppUpdateState })
      .filter((payload) => payload.type === 'available')
      .pop();
    expect(availableEvent).toBeDefined();
    const availableState = availableEvent?.state;
    expect(availableState?.status).toBe('available');
    if (availableState?.status === 'available') {
      expect(availableState.latestVersion).toBe('0.5.1');
      expect(availableState.releaseDate).toBe('2026-05-06T07:10:02.000Z');
      expect(availableState.notes).toBe('bug fixes');
      expect(availableState.mandatory).toBe(false);
      expect(availableState.minimumVersion).toBe(null);
      expect(availableState.files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            platform: 'darwin',
            arch: 'arm64',
            kind: 'installer',
            name: 'IARTStudio-0.5.1-mac-arm64.dmg',
            path: 'IARTStudio-0.5.1-mac-arm64.dmg',
            r2Key: 'IARTStudio-0.5.1-mac-arm64.dmg',
            sha512: 'c2hhNTEyLWRlbW8tZG1n',
            size: 2048,
          }),
          expect.objectContaining({
            name: 'IARTStudio-0.5.1-mac-arm64.zip',
            sha512: 'c2hhNTEyLWRlbW8temlw',
            size: 1024,
          }),
        ]),
      );
    }
  });

  it('Mac darwin 安装行为：dmg 文件调用 shell.openPath', async () => {
    loaded = await loadUpdater({ packaged: true, platform: 'darwin' });
    loaded.controller.setupAutoUpdater();

    mockAvailableCheck(loaded, UPDATE_INFO_DARWIN);
    const downloadedDmg = path.join(loaded.tempRoot, 'IARTStudio-0.5.1-mac-arm64.dmg');
    loaded.mockAutoUpdater.downloadUpdate.mockImplementation(async () => [downloadedDmg]);

    await loaded.controller.checkForUpdates(false);
    await loaded.controller.startDownload();
    await flushMicrotasks();

    const state = loaded.controller.buildUpdateStateSnapshot();
    expect(state.status).toBe('downloaded');

    // Now test install - need to make the file "exist" for installUpdate
    fs.mkdirSync(path.dirname(downloadedDmg), { recursive: true });
    fs.writeFileSync(downloadedDmg, 'fake-dmg', 'utf8');

    const result = loaded.controller.installUpdate();

    expect(result.status).toBe('success');
    expect(loaded.openPath).toHaveBeenCalledWith(downloadedDmg);
  });

  it('Mac darwin zip 安装行为：调用 shell.showItemInFolder', async () => {
    loaded = await loadUpdater({ packaged: true, platform: 'darwin' });
    loaded.controller.setupAutoUpdater();

    const zipOnlyInfo: MockUpdateInfo = {
      version: '0.5.1',
      releaseDate: '2026-05-06T07:10:02.000Z',
      files: [
        { url: 'IARTStudio-0.5.1-mac-arm64.zip', sha512: 'c2hhNTEyLWRlbW8temlw', size: 1024 },
      ],
    };
    mockAvailableCheck(loaded, zipOnlyInfo);
    const downloadedZip = path.join(loaded.tempRoot, 'IARTStudio-0.5.1-mac-arm64.zip');
    loaded.mockAutoUpdater.downloadUpdate.mockImplementation(async () => [downloadedZip]);

    await loaded.controller.checkForUpdates(false);
    await loaded.controller.startDownload();
    await flushMicrotasks();

    const state = loaded.controller.buildUpdateStateSnapshot();
    expect(state.status).toBe('downloaded');

    fs.mkdirSync(path.dirname(downloadedZip), { recursive: true });
    fs.writeFileSync(downloadedZip, 'fake-zip', 'utf8');

    const result = loaded.controller.installUpdate();

    expect(result.status).toBe('success');
    expect(loaded.showItemInFolder).toHaveBeenCalledWith(downloadedZip);
  });

  it('Windows win32 安装行为：exe 文件调用 shell.openPath', async () => {
    loaded = await loadUpdater({ packaged: true, platform: 'win32' });
    loaded.controller.setupAutoUpdater();

    mockAvailableCheck(loaded, UPDATE_INFO_WIN32);
    const downloadedExe = path.join(loaded.tempRoot, 'IARTStudio-Setup-0.5.1-x64.exe');
    loaded.mockAutoUpdater.downloadUpdate.mockImplementation(async () => [downloadedExe]);

    await loaded.controller.checkForUpdates(false);
    await loaded.controller.startDownload();
    await flushMicrotasks();

    const state = loaded.controller.buildUpdateStateSnapshot();
    expect(state.status).toBe('downloaded');
    if (state.status === 'downloaded') {
      expect(state.installActions).not.toContain('quit-and-install');
    }

    fs.mkdirSync(path.dirname(downloadedExe), { recursive: true });
    fs.writeFileSync(downloadedExe, 'fake-exe', 'utf8');

    const result = loaded.controller.installUpdate();

    expect(result.status).toBe('success');
    expect(loaded.openPath).toHaveBeenCalledWith(downloadedExe);
  });

  it('未下载完成时禁止安装', async () => {
    loaded = await loadUpdater({ packaged: true, platform: undefined });
    loaded.controller.setupAutoUpdater();

    const result = loaded.controller.installUpdate();
    expect(result.status).toBe('skipped');
    if (result.status === 'skipped') {
      expect(result.reason).toBe('not-downloaded');
    }
  });

  it('节流验证：连续两次 checkForUpdates，第二次被节流跳过并携带 retryAfterMs', async () => {
    loaded = await loadUpdater({ packaged: true, platform: undefined });
    loaded.controller.setupAutoUpdater();

    // First check succeeds (mock emits update-not-available)
    const first = await loaded.controller.checkForUpdates(false);
    expect(first.status).toBe('success');

    // Second immediate check is throttled by the bridge's real throttle logic
    const second = await loaded.controller.checkForUpdates(false);
    expect(second.status).toBe('skipped');
    if (second.status === 'skipped') {
      expect(second.reason).toBe('throttled');
      // 剩余等待时间：未超过 30 分钟自动检查窗口，且非负。
      expect(second.retryAfterMs).toBeGreaterThan(0);
      expect(second.retryAfterMs).toBeLessThanOrEqual(30 * 60 * 1000);
    }

    // 非节流的跳过路径不带 retryAfterMs。
    loaded.setSupportedTarget(false);
    const unsupported = await loaded.controller.checkForUpdates(true);
    expect(unsupported.status).toBe('skipped');
    if (unsupported.status === 'skipped') {
      expect(unsupported.reason).toBe('unsupported-target');
      expect(unsupported.retryAfterMs).toBeUndefined();
    }

    // the library's checkForUpdates was only called once (first time)
    expect(loaded.mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('手动检查节流的 retryAfterMs 是 2 分钟窗口内的剩余毫秒', async () => {
    vi.useFakeTimers();
    loaded = await loadUpdater({ packaged: true, platform: undefined });
    loaded.controller.setupAutoUpdater();

    const first = await loaded.controller.checkForUpdates(true);
    expect(first.status).toBe('success');

    vi.setSystemTime(new Date(Date.now() + 60_000));
    const second = await loaded.controller.checkForUpdates(true);
    expect(second.status).toBe('skipped');
    if (second.status === 'skipped') {
      expect(second.reason).toBe('throttled');
      expect(second.retryAfterMs).toBe(60_000);
    }

    // 窗口过去后可再次检查。
    vi.setSystemTime(new Date(Date.now() + 61_000));
    const third = await loaded.controller.checkForUpdates(true);
    expect(third.status).toBe('success');
  });

  it('节流按尝试计：检查失败后立即二次 check 也被节流跳过', async () => {
    loaded = await loadUpdater({ packaged: true, platform: undefined });
    loaded.controller.setupAutoUpdater();

    loaded.mockAutoUpdater.checkForUpdates.mockImplementation(async () => {
      loaded?.emit('checking-for-update');
      throw new Error('feed 404');
    });

    const first = await loaded.controller.checkForUpdates(false);
    expect(first.status).toBe('failed');
    const firstState = loaded.controller.buildUpdateStateSnapshot();
    expect(firstState.status).toBe('error');

    // 失败同样占用节流窗口（按尝试计），紧随的检查被跳过
    const second = await loaded.controller.checkForUpdates(false);
    expect(second.status).toBe('skipped');
    if (second.status === 'skipped') {
      expect(second.reason).toBe('throttled');
    }
    expect(loaded.mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('electron-updater 失败同时触发 error 事件与 promise rejection 时，error 状态只发送一次', async () => {
    loaded = await loadUpdater({ packaged: true, platform: undefined });
    loaded.controller.setupAutoUpdater();

    loaded.mockAutoUpdater.checkForUpdates.mockImplementation(async () => {
      loaded?.emit('checking-for-update');
      loaded?.emit('error', new Error('network failure'));
      throw new Error('network failure');
    });

    const result = await loaded.controller.checkForUpdates(false);

    expect(result.status).toBe('failed');
    const state = loaded.controller.buildUpdateStateSnapshot();
    expect(state.status).toBe('error');
    if (state.status === 'error') {
      expect(state.error.message).toBe('network failure');
    }
    expect(countSentEvents(loaded, 'error')).toBe(1);
  });

  it('下载中取消：回到 available、无 error、不写 pending，可再次下载；非下载态取消 skipped', async () => {
    loaded = await loadUpdater({ packaged: true, platform: 'darwin' });
    loaded.controller.setupAutoUpdater();
    mockAvailableCheck(loaded);
    let downloadCalls = 0;
    const downloadRoot = loaded.tempRoot;
    loaded.mockAutoUpdater.downloadUpdate.mockImplementation((token: MockCancellationToken) => {
      downloadCalls += 1;
      if (downloadCalls === 1) {
        // 首次下载：等待取消，并在取消时以普通 Error reject（取消判定不得依赖异常类型）。
        return new Promise<string[]>((_resolve, reject) => {
          token.onCancelRequested(() => reject(new Error('cancelled')));
        });
      }
      return Promise.resolve([path.join(downloadRoot, 'IARTStudio-0.5.1-mac-arm64.dmg')]);
    });

    await loaded.controller.checkForUpdates(false);
    expect(loaded.controller.buildUpdateStateSnapshot().status).toBe('available');
    const downloadPromise = loaded.controller.startDownload();
    expect(loaded.controller.buildUpdateStateSnapshot().status).toBe('downloading');
    const cancelResult = await loaded.controller.cancelDownload();
    const downloadResult = await downloadPromise;
    expect(cancelResult.status).toBe('success');
    expect(cancelResult.state.status).toBe('available');
    expect(downloadResult.status).toBe('skipped');
    if (downloadResult.status === 'skipped') expect(downloadResult.reason).toBe('download-cancelled');
    expect(countSentEvents(loaded, 'error')).toBe(0);
    expect(fs.existsSync(pendingFileOf(loaded))).toBe(false);
    // 取消后保留「下载」入口：可以再次下载并正常完成。
    const retry = await loaded.controller.startDownload();
    expect(retry.status).toBe('success');
    expect(loaded.controller.buildUpdateStateSnapshot().status).toBe('downloaded');
    expect(loaded.mockAutoUpdater.downloadUpdate).toHaveBeenCalledTimes(2);
    // 非下载态取消是幂等的：返回 skipped 且不改变当前状态。
    const idleCancel = await loaded.controller.cancelDownload();
    expect(idleCancel.status).toBe('skipped');
    if (idleCancel.status === 'skipped') {
      expect(idleCancel.reason).toBe('no-active-download');
      expect(idleCancel.state.status).toBe('downloaded');
    }
  });

  it('取消与下载完成竞争：以已落盘的 downloaded 为准，返回 skipped（download-completed）', async () => {
    loaded = await loadUpdater({ packaged: true, platform: 'darwin' });
    loaded.controller.setupAutoUpdater();
    mockAvailableCheck(loaded);
    const dmgPath = downloadedFilePath(loaded, 'IARTStudio-0.5.1-mac-arm64.dmg');
    let resolveDownload: (paths: string[]) => void = () => undefined;
    loaded.mockAutoUpdater.downloadUpdate.mockImplementation(
      () => new Promise<string[]>((resolve) => {
        resolveDownload = resolve;
      }),
    );
    await loaded.controller.checkForUpdates(false);
    const downloadPromise = loaded.controller.startDownload();
    // 取消请求先发出（置本地标志并 cancel），但下载已完成落盘：不得丢弃安装包。
    const cancelPromise = loaded.controller.cancelDownload();
    resolveDownload([dmgPath]);
    const [downloadResult, cancelResult] = await Promise.all([downloadPromise, cancelPromise]);
    expect(downloadResult.status).toBe('success');
    expect(cancelResult.status).toBe('skipped');
    if (cancelResult.status === 'skipped') {
      expect(cancelResult.reason).toBe('download-completed');
      expect(cancelResult.state.status).toBe('downloaded');
    }
    expect(loaded.controller.buildUpdateStateSnapshot().status).toBe('downloaded');
    expect(countSentEvents(loaded, 'error')).toBe(0);
    expect(fs.existsSync(pendingFileOf(loaded))).toBe(true);
  });

  it('同版本检查保持 downloaded：不回到 available、不重复下载、刷新 lastCheckedAt', async () => {
    vi.useFakeTimers();
    loaded = await loadUpdater({ packaged: true, platform: 'darwin' });
    loaded.controller.setupAutoUpdater();
    mockAvailableCheck(loaded);
    const dmgPath = downloadedFilePath(loaded, 'IARTStudio-0.5.1-mac-arm64.dmg');
    loaded.mockAutoUpdater.downloadUpdate.mockImplementation(async () => [dmgPath]);
    await loaded.controller.checkForUpdates(false);
    await loaded.controller.startDownload();
    fs.writeFileSync(dmgPath, 'fake-dmg', 'utf8');
    const before = loaded.controller.buildUpdateStateSnapshot();
    expect(before.status).toBe('downloaded');
    const downloadCallsAfterFirst = loaded.mockAutoUpdater.downloadUpdate.mock.calls.length;
    const firstCheckedAt = before.lastCheckedAt ?? 0;
    // 越过 30 分钟自动检查窗口后再次检查，feed 仍是同一版本。
    advancePastAutoCheckWindow();
    const second = await loaded.controller.checkForUpdates(false);
    expect(second.status).toBe('success');
    const after = loaded.controller.buildUpdateStateSnapshot();
    expect(after.status).toBe('downloaded');
    expect(after.latestVersion).toBe('0.5.1');
    expect(after.lastCheckedAt ?? 0).toBeGreaterThan(firstCheckedAt);
    expect(loaded.mockAutoUpdater.downloadUpdate.mock.calls.length).toBe(downloadCallsAfterFirst);
    // 下载完成一次 + 同版本检查重发一次 downloaded 事件。
    expect(countSentEvents(loaded, 'downloaded')).toBe(2);
    expect(fs.existsSync(pendingFileOf(loaded))).toBe(true);
  });

  it('检查发现更高版本时清理旧 pending 并进入 available，不自动下载', async () => {
    vi.useFakeTimers();
    loaded = await loadUpdater({ packaged: true, platform: 'darwin' });
    loaded.controller.setupAutoUpdater();
    mockAvailableCheck(loaded);
    const dmgPath = downloadedFilePath(loaded, 'IARTStudio-0.5.1-mac-arm64.dmg');
    loaded.mockAutoUpdater.downloadUpdate.mockImplementation(async () => [dmgPath]);
    await loaded.controller.checkForUpdates(false);
    await loaded.controller.startDownload();
    fs.writeFileSync(dmgPath, 'fake-dmg', 'utf8');
    expect(fs.existsSync(pendingFileOf(loaded))).toBe(true);
    mockAvailableCheck(loaded, {
      version: '0.5.2',
      releaseDate: '2026-06-01T00:00:00.000Z',
      files: [{ url: 'IARTStudio-0.5.2-mac-arm64.dmg', sha512: 'c2hhNTEyLWRlbW8tMDVyMg==', size: 4096 }],
    });
    advancePastAutoCheckWindow();
    const second = await loaded.controller.checkForUpdates(false);
    expect(second.status).toBe('success');
    const state = loaded.controller.buildUpdateStateSnapshot();
    expect(state.status).toBe('available');
    if (state.status === 'available') expect(state.latestVersion).toBe('0.5.2');
    expect(fs.existsSync(pendingFileOf(loaded))).toBe(false);
    expect(loaded.mockAutoUpdater.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it('已下载文件缺失时清理 pending 并回到 available，允许重新下载', async () => {
    vi.useFakeTimers();
    loaded = await loadUpdater({ packaged: true, platform: 'darwin' });
    loaded.controller.setupAutoUpdater();
    mockAvailableCheck(loaded);
    const dmgPath = downloadedFilePath(loaded, 'IARTStudio-0.5.1-mac-arm64.dmg');
    loaded.mockAutoUpdater.downloadUpdate.mockImplementation(async () => [dmgPath]);
    await loaded.controller.checkForUpdates(false);
    await loaded.controller.startDownload();
    fs.writeFileSync(dmgPath, 'fake-dmg', 'utf8');
    expect(fs.existsSync(pendingFileOf(loaded))).toBe(true);
    // 安装包被外部清理：同版本检查不得假装仍可安装。
    fs.rmSync(dmgPath, { force: true });
    advancePastAutoCheckWindow();
    const second = await loaded.controller.checkForUpdates(false);
    expect(second.status).toBe('success');
    const state = loaded.controller.buildUpdateStateSnapshot();
    expect(state.status).toBe('available');
    if (state.status === 'available') expect(state.latestVersion).toBe('0.5.1');
    expect(fs.existsSync(pendingFileOf(loaded))).toBe(false);
    const retry = await loaded.controller.startDownload();
    expect(retry.status).toBe('success');
    expect(loaded.controller.buildUpdateStateSnapshot().status).toBe('downloaded');
  });

  it('检查失败在 available 时保留状态（error 事件先到也不覆盖），命令返回 failed', async () => {
    vi.useFakeTimers();
    loaded = await loadUpdater({ packaged: true, platform: 'darwin' });
    loaded.controller.setupAutoUpdater();
    mockAvailableCheck(loaded);
    const first = await loaded.controller.checkForUpdates(false);
    expect(first.status).toBe('success');
    expect(loaded.controller.buildUpdateStateSnapshot().status).toBe('available');
    mockFailingCheck(loaded, 'feed 502');
    advancePastAutoCheckWindow();
    const second = await loaded.controller.checkForUpdates(false);
    expect(second.status).toBe('failed');
    if (second.status === 'failed') {
      expect(second.error.message).toBe('feed 502');
      expect(second.state.status).toBe('available');
    }
    const state = loaded.controller.buildUpdateStateSnapshot();
    expect(state.status).toBe('available');
    if (state.status === 'available') expect(state.latestVersion).toBe('0.5.1');
    expect(countSentEvents(loaded, 'error')).toBe(0);
    // 首次 available + 检查失败后恢复 available。
    expect(countSentEvents(loaded, 'available')).toBe(2);
  });

  it('检查失败在 downloaded 时保留状态（含安装入口），命令返回 failed', async () => {
    vi.useFakeTimers();
    loaded = await loadUpdater({ packaged: true, platform: 'darwin' });
    loaded.controller.setupAutoUpdater();
    mockAvailableCheck(loaded);
    const zipPath = downloadedFilePath(loaded, 'IARTStudio-0.5.1-mac-arm64.zip');
    loaded.mockAutoUpdater.downloadUpdate.mockImplementation(async () => [zipPath]);
    await loaded.controller.checkForUpdates(false);
    await loaded.controller.startDownload();
    fs.writeFileSync(zipPath, 'fake-zip', 'utf8');
    expect(loaded.controller.buildUpdateStateSnapshot().status).toBe('downloaded');
    mockFailingCheck(loaded, 'feed 503');
    advancePastAutoCheckWindow();
    const second = await loaded.controller.checkForUpdates(false);
    expect(second.status).toBe('failed');
    const state = loaded.controller.buildUpdateStateSnapshot();
    expect(state.status).toBe('downloaded');
    if (state.status === 'downloaded') {
      expect(state.latestVersion).toBe('0.5.1');
      expect(state.downloadPath).toBe(zipPath);
    }
    expect(countSentEvents(loaded, 'error')).toBe(0);
    expect(countSentEvents(loaded, 'downloaded')).toBe(2);
  });

  it('检查失败在 not-available 时进入 error（check-error）', async () => {
    vi.useFakeTimers();
    loaded = await loadUpdater({ packaged: true, platform: 'darwin' });
    loaded.controller.setupAutoUpdater();
    const first = await loaded.controller.checkForUpdates(false);
    expect(first.status).toBe('success');
    expect(loaded.controller.buildUpdateStateSnapshot().status).toBe('not-available');
    mockFailingCheck(loaded, 'feed 404');
    advancePastAutoCheckWindow();
    const second = await loaded.controller.checkForUpdates(false);
    expect(second.status).toBe('failed');
    const state = loaded.controller.buildUpdateStateSnapshot();
    expect(state.status).toBe('error');
    if (state.status === 'error') expect(state.error.message).toBe('feed 404');
    expect(countSentEvents(loaded, 'error')).toBe(1);
  });

  it('pending 文件不存在时的清理：settlePendingIfInstalled 中 downloadPath 文件不存在时清理 pending', async () => {
    loaded = await loadUpdater({ packaged: true, platform: undefined });
    const pendingFile = path.join(loaded.tempRoot, 'userData', 'pending-update.json');
    fs.mkdirSync(path.dirname(pendingFile), { recursive: true });
    fs.writeFileSync(
      pendingFile,
      JSON.stringify({ version: '0.5.1', downloadPath: '/tmp/nonexistent-IARTStudio.zip', createdAt: Date.now() }),
      'utf8',
    );
    // Keep version below pending version so it would normally restore
    loaded.setCurrentVersion('0.5.0');

    loaded.controller.setupAutoUpdater();

    // The pending should be cleared because downloadPath file does not exist
    expect(fs.existsSync(pendingFile)).toBe(false);
    expect(loaded.controller.buildUpdateStateSnapshot().status).toBe('idle');
  });

  it('重启后当前版本已覆盖 pending 版本时清理 pending 状态', async () => {
    loaded = await loadUpdater({ packaged: true, platform: undefined });
    const pendingFile = path.join(loaded.tempRoot, 'userData', 'pending-update.json');
    fs.mkdirSync(path.dirname(pendingFile), { recursive: true });
    fs.writeFileSync(
      pendingFile,
      JSON.stringify({ version: '0.5.1', downloadPath: '/tmp/IARTStudio.zip', createdAt: Date.now() }),
      'utf8',
    );
    loaded.setCurrentVersion('0.5.1');

    loaded.controller.setupAutoUpdater();

    expect(fs.existsSync(pendingFile)).toBe(false);
    expect(loaded.controller.buildUpdateStateSnapshot().status).toBe('idle');
  });

  it('重启后 pending 版本仍高于当前版本时恢复 downloaded 状态', async () => {
    loaded = await loadUpdater({ packaged: true, platform: 'darwin' });
    const pendingFile = path.join(loaded.tempRoot, 'userData', 'pending-update.json');
    const restoredPath = path.join(loaded.tempRoot, 'IARTStudio-0.5.1-mac-arm64.zip');
    fs.mkdirSync(path.dirname(pendingFile), { recursive: true });
    fs.writeFileSync(
      pendingFile,
      JSON.stringify({ version: '0.5.1', downloadPath: restoredPath, createdAt: Date.now() }),
      'utf8',
    );
    // The pending download file must exist so the record is not cleared
    fs.writeFileSync(restoredPath, 'fake-zip', 'utf8');
    loaded.setCurrentVersion('0.5.0');

    loaded.controller.setupAutoUpdater();

    const state = loaded.controller.buildUpdateStateSnapshot();
    expect(state.status).toBe('downloaded');
    if (state.status === 'downloaded') {
      expect(state.latestVersion).toBe('0.5.1');
      expect(state.downloadPath).toBe(restoredPath);
    }
  });

  it('不支持的更新目标平台跳过检查', async () => {
    loaded = await loadUpdater({ packaged: true, platform: 'linux' });
    loaded.setSupportedTarget(false);
    loaded.controller.setupAutoUpdater();

    const result = await loaded.controller.checkForUpdates(false);

    expect(result.status).toBe('skipped');
    if (result.status === 'skipped') {
      expect(result.reason).toBe('unsupported-target');
    }
    expect(loaded.mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('打包态缺失 app-update.yml 时跳过检查，不抛出 Invalid URL', async () => {
    loaded = await loadUpdater({ packaged: true, platform: undefined, withAppUpdateYml: false });
    loaded.controller.setupAutoUpdater();

    const result = await loaded.controller.checkForUpdates(false);

    expect(result.status).toBe('skipped');
    if (result.status === 'skipped') {
      expect(result.reason).toBe('publish-url-unresolved');
    }
    expect(loaded.mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(loaded.controller.buildUpdateStateSnapshot().status).toBe('idle');
  });
});
