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
    'electron-updater': { autoUpdater: mockAutoUpdater },
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
  loaded.mainWindow.webContents.send.mock.calls.filter(
    (call) => (call[0] as unknown) === 'app-update:event' && (call[1] as { type: string }).type === type,
  ).length;

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

  it('发现更新后自动触发下载；下载失败时状态变为 error', async () => {
    loaded = await loadUpdater({ packaged: true, platform: undefined });
    loaded.controller.setupAutoUpdater();

    loaded.mockAutoUpdater.checkForUpdates.mockImplementation(async () => {
      loaded?.emit('checking-for-update');
      loaded?.emit('update-available', UPDATE_INFO_DARWIN);
      return null;
    });
    loaded.mockAutoUpdater.downloadUpdate.mockImplementation(async () => {
      throw new Error('download failed for test');
    });

    const result = await loaded.controller.checkForUpdates(false);
    await flushMicrotasks();

    expect(result.status).toBe('success');
    // 发现更新后自动触发下载（downloadUpdate 已被调用），下载失败落入 error 状态。
    expect(loaded.mockAutoUpdater.downloadUpdate).toHaveBeenCalledTimes(1);
    const state = loaded.controller.buildUpdateStateSnapshot();
    expect(['available', 'error', 'downloading', 'downloaded']).toContain(state.status);
    expect(state.status).toBe('error');
  });

  it('检查发现更新后自动下载：模拟下载进度，写入 downloaded 状态和 pending', async () => {
    loaded = await loadUpdater({ packaged: true, platform: undefined });
    loaded.controller.setupAutoUpdater();

    const downloadedFile = path.join(loaded.tempRoot, 'update-cache', 'IARTStudio-0.5.1-mac-arm64.dmg');

    loaded.mockAutoUpdater.checkForUpdates.mockImplementation(async () => {
      loaded?.emit('checking-for-update');
      loaded?.emit('update-available', UPDATE_INFO_DARWIN);
      return null;
    });
    loaded.mockAutoUpdater.downloadUpdate.mockImplementation(async () => {
      loaded?.emit('download-progress', { percent: 42, bytesPerSecond: 2048, transferred: 420, total: 2048 });
      loaded?.emit('update-downloaded', { ...UPDATE_INFO_DARWIN, downloadedFile: downloadedFile });
      return [downloadedFile];
    });

    const checkResp = await loaded.controller.checkForUpdates(false);
    await flushMicrotasks();

    expect(checkResp.status).toBe('success');
    const state = loaded.controller.buildUpdateStateSnapshot();
    expect(state.status).toBe('downloaded');
    if (state.status === 'downloaded') {
      expect(state.latestVersion).toBe('0.5.1');
      expect(state.downloadPath).toBe(downloadedFile);
      expect(state.installActions).toContain('open-installer');
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

    loaded.mockAutoUpdater.checkForUpdates.mockImplementation(async () => {
      loaded?.emit('checking-for-update');
      loaded?.emit('update-available', UPDATE_INFO_DARWIN);
      return null;
    });
    // 下载永远挂起，冻结在 available/downloading 以便检查 available 状态本身
    loaded.mockAutoUpdater.downloadUpdate.mockImplementation(
      () => new Promise<string[]>(() => undefined),
    );

    await loaded.controller.checkForUpdates(false);
    await flushMicrotasks();

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

    loaded.mockAutoUpdater.checkForUpdates.mockImplementation(async () => {
      loaded?.emit('checking-for-update');
      loaded?.emit('update-available', UPDATE_INFO_DARWIN);
      return null;
    });
    const downloadedDmg = path.join(loaded.tempRoot, 'IARTStudio-0.5.1-mac-arm64.dmg');
    loaded.mockAutoUpdater.downloadUpdate.mockImplementation(async () => [downloadedDmg]);

    await loaded.controller.checkForUpdates(false);
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
    loaded.mockAutoUpdater.checkForUpdates.mockImplementation(async () => {
      loaded?.emit('checking-for-update');
      loaded?.emit('update-available', zipOnlyInfo);
      return null;
    });
    const downloadedZip = path.join(loaded.tempRoot, 'IARTStudio-0.5.1-mac-arm64.zip');
    loaded.mockAutoUpdater.downloadUpdate.mockImplementation(async () => [downloadedZip]);

    await loaded.controller.checkForUpdates(false);
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

    loaded.mockAutoUpdater.checkForUpdates.mockImplementation(async () => {
      loaded?.emit('checking-for-update');
      loaded?.emit('update-available', UPDATE_INFO_WIN32);
      return null;
    });
    const downloadedExe = path.join(loaded.tempRoot, 'IARTStudio-Setup-0.5.1-x64.exe');
    loaded.mockAutoUpdater.downloadUpdate.mockImplementation(async () => [downloadedExe]);

    await loaded.controller.checkForUpdates(false);
    await flushMicrotasks();

    const state = loaded.controller.buildUpdateStateSnapshot();
    expect(state.status).toBe('downloaded');

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

  it('节流验证：连续两次 checkForUpdates，第二次被节流跳过', async () => {
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
    }

    // the library's checkForUpdates was only called once (first time)
    expect(loaded.mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
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
