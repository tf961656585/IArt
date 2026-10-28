import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { AppUpdateCommandResultSchema, AppUpdateEventSchema, AppUpdateStateSchema } from '@iart/contracts';
import type { AppUpdateCommandResult, AppUpdateEvent, AppUpdatePlatform, AppUpdateState } from '@iart/contracts';
import type { HubPlatformBridge } from '../../../client/types';
import { UpdateBanner } from '../UpdateBanner';
import { UpdateSection } from '../UpdateSection';
import { resetUpdateBannerDismissed } from '../UpdateSection.hooks';

/**
 * Hub 更新交互（设计基准 docs/desktop-updates/更新交互重设计-design.md §3/§4）：
 * - 横幅是唯一提醒表面：available / downloading / downloaded / 就地转失败的 download-error 出现；
 *   检查失败（check-error）永不出现；Linux 永不出现；更新弹窗已删除。
 * - 「稍后」只收起本次提醒：任何更新事件、进入设置页触发的检查都不重置；仅显式「重新检查」清除。
 * - 设置页状态行永远渲染真实状态，取消/节流/检查失败提示走独立提示行。
 * - 安装主动作按下载文件类型派生（macOS zip → 打开文件所在位置 / dmg → 打开安装包 / Windows → 打开安装器）。
 * 事件夹具经 contracts schema parse 产生（与真实 IPC 事件同形）。
 */

const platformRef = vi.hoisted(() => ({ current: null as HubPlatformBridge | null }));

vi.mock('../../../components/providers/HubAppProvider', () => ({
  useHubRuntime: () => {
    const platform = platformRef.current;
    if (platform === null) throw new Error('用例没有装载 platform');
    return { platform };
  },
}));

const eventHandlers: Array<(event: AppUpdateEvent) => void> = [];

const baseState = {
  appVersion: '0.6.11',
  channel: 'stable',
  platform: 'darwin',
  arch: 'arm64',
  lastCheckedAt: 1_760_000_000_000,
  logPath: null,
} as const;

const idleState = (platform: AppUpdatePlatform = 'darwin'): AppUpdateState =>
  AppUpdateStateSchema.parse({ status: 'idle', ...baseState, platform });

const checkingState = (): AppUpdateState =>
  AppUpdateStateSchema.parse({ status: 'checking', ...baseState });

const notAvailableState = (): AppUpdateState =>
  AppUpdateStateSchema.parse({ status: 'not-available', ...baseState, latestVersion: '0.6.11' });

const availableState = (platform: AppUpdatePlatform = 'darwin'): AppUpdateState =>
  AppUpdateStateSchema.parse({
    status: 'available',
    ...baseState,
    platform,
    latestVersion: '0.6.12',
    releaseDate: null,
    notes: null,
    files: [],
    mandatory: false,
    minimumVersion: null,
  });

const downloadingState = (): AppUpdateState =>
  AppUpdateStateSchema.parse({
    status: 'downloading',
    ...baseState,
    latestVersion: '0.6.12',
    progress: { percent: 32, transferred: 1024, total: 4096, bytesPerSecond: 512 },
  });

const downloadedState = (
  downloadPath: string | null = '/tmp/IARTStudio-0.6.12.zip',
  platform: AppUpdatePlatform = 'darwin',
): AppUpdateState =>
  AppUpdateStateSchema.parse({
    status: 'downloaded',
    ...baseState,
    platform,
    latestVersion: '0.6.12',
    downloadPath,
    files: [],
    installActions: [],
  });

const errorState = (): AppUpdateState =>
  AppUpdateStateSchema.parse({
    status: 'error',
    ...baseState,
    latestVersion: null,
    error: { message: 'Cannot find channel "latest.yml" update info: HttpError: 404' },
  });

const commandResult = (value: unknown): AppUpdateCommandResult => AppUpdateCommandResultSchema.parse(value);

const skippedCommand = (state: AppUpdateState): AppUpdateCommandResult =>
  commandResult({ status: 'skipped', reason: 'already-checking', state });

const successCommand = (state: AppUpdateState): AppUpdateCommandResult =>
  commandResult({ status: 'success', state });

const createPlatform = (
  overrides: Partial<
    Pick<
      HubPlatformBridge,
      | 'checkForUpdates'
      | 'startUpdateDownload'
      | 'cancelUpdateDownload'
      | 'installUpdate'
      | 'openExternal'
      | 'getUpdateState'
    >
  > = {},
): HubPlatformBridge => {
  const bridge: HubPlatformBridge = {
    isElectron: () => true,
    openEditorWindow: vi.fn(),
    openExternal: overrides.openExternal ?? vi.fn(() => Promise.resolve(true)),
    selectFolder: vi.fn(),
    selectProjectFolder: vi.fn(),
    revealProjectFolder: vi.fn(),
    isStorageReady: () => true,
    getAppVersion: vi.fn(() => Promise.resolve('9.9.9')),
    // 挂载触发的检查返回可解析结果（不用永不落定的 Promise）：默认 skipped，用例按需覆盖
    checkForUpdates: overrides.checkForUpdates ?? vi.fn(() => Promise.resolve(skippedCommand(idleState()))),
    startUpdateDownload:
      overrides.startUpdateDownload ?? vi.fn(() => Promise.resolve(skippedCommand(idleState()))),
    cancelUpdateDownload:
      overrides.cancelUpdateDownload ?? vi.fn(() => Promise.resolve(skippedCommand(idleState()))),
    installUpdate: overrides.installUpdate ?? vi.fn(() => Promise.resolve(skippedCommand(idleState()))),
    revealDownloadedUpdate: vi.fn(),
    getUpdateState: overrides.getUpdateState ?? vi.fn(() => Promise.resolve(null)),
    getUpdaterLogInfo: vi.fn(() => Promise.resolve(null)),
    revealUpdaterLog: vi.fn(() => Promise.resolve({ success: true, path: '/logs/updater.log' })),
    revealBackendLogFolder: vi.fn(() => Promise.resolve({ success: true, path: '/logs' })),
    onAppUpdateEvent: vi.fn((handler: (event: AppUpdateEvent) => void) => {
      eventHandlers.push(handler);
    }),
    onUpdateChecking: vi.fn(),
    onUpdateAvailable: vi.fn(),
    onUpdateNotAvailable: vi.fn(),
    onUpdateDownloadProgress: vi.fn(),
    onUpdateDownloaded: vi.fn(),
    onUpdateError: vi.fn(),
    onTaskStateChanged: vi.fn(),
    onTaskStateSnapshot: vi.fn(),
    removeTaskStateListeners: vi.fn(),
    onHubFocusSettings: vi.fn(),
    removeHubFocusSettingsListener: vi.fn(),
    storageListProjects: vi.fn(),
    storageCreateProject: vi.fn(),
    storageOpenProject: vi.fn(),
    storageDeleteProject: vi.fn(),
    storageImportFolder: vi.fn(),
    storageImportBundle: vi.fn(),
    storageExportBundle: vi.fn(),
    packagesList: vi.fn(),
    packagesCreate: vi.fn(),
    packagesRename: vi.fn(),
    packagesDelete: vi.fn(),
    packagesReveal: vi.fn(),
    getSkillInstalledState: vi.fn(),
    installSkill: vi.fn(),
    revealSkillInstallFolder: vi.fn(),
    listCustomSkillInstallTargets: vi.fn(),
    addCustomSkillInstallTarget: vi.fn(),
    updateCustomSkillInstallTarget: vi.fn(),
    removeCustomSkillInstallTarget: vi.fn(),
    getCliStatus: vi.fn(() => Promise.resolve(null)),
    registerCliEntry: vi.fn(),
    unregisterCliEntry: vi.fn(),
  };
  return bridge;
};

const emit = (type: AppUpdateEvent['type'], state: AppUpdateState): void => {
  const event = AppUpdateEventSchema.parse({ type, state });
  act(() => {
    for (const handler of eventHandlers) handler(event);
  });
};

// 挂载 initialize（getAppVersion/getUpdateState/getUpdaterLogInfo/检查链）是微任务链，
// 用一个宏任务把所有已排队的微任务冲刷干净，保证测试事件不会与初始化快照交错
const flushInit = async (): Promise<void> => {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
};

afterEach(() => {
  cleanup();
  platformRef.current = null;
  eventHandlers.length = 0;
  resetUpdateBannerDismissed();
});

describe('横幅展示规则（§3.2）', () => {
  it('发现新版本横幅展示「下载 / 稍后」', async () => {
    platformRef.current = createPlatform();
    render(<UpdateBanner />);
    await flushInit();

    emit('available', availableState());

    expect(screen.getByText('发现新版本')).toBeInTheDocument();
    expect(screen.getByText('版本 0.6.12 可以下载')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下载' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '稍后' })).toBeInTheDocument();
  });

  it('下载中横幅展示「取消下载」与进度', async () => {
    platformRef.current = createPlatform();
    render(<UpdateBanner />);
    await flushInit();

    emit('available', availableState());
    emit('download-progress', downloadingState());

    expect(screen.getByText('正在下载更新')).toBeInTheDocument();
    expect(screen.getByText('正在下载版本 0.6.12')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '取消下载' })).toBeInTheDocument();
  });

  it('已下载 macOS zip：主动作为「打开文件所在位置」', async () => {
    platformRef.current = createPlatform();
    render(<UpdateBanner />);
    await flushInit();

    emit('downloaded', downloadedState('/tmp/IARTStudio-0.6.12.zip', 'darwin'));

    expect(screen.getByText('更新已就绪')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '打开文件所在位置' })).toBeInTheDocument();
  });

  it('已下载 macOS dmg：主动作为「打开安装包」', async () => {
    platformRef.current = createPlatform();
    render(<UpdateBanner />);
    await flushInit();

    emit('downloaded', downloadedState('/tmp/IARTStudio-0.6.12.dmg', 'darwin'));

    expect(screen.getByRole('button', { name: '打开安装包' })).toBeInTheDocument();
  });

  it('已下载 Windows exe：主动作为「打开安装器」', async () => {
    platformRef.current = createPlatform();
    render(<UpdateBanner />);
    await flushInit();

    emit('downloaded', downloadedState('C:\\temp\\IARTStudio-0.6.12.exe', 'win32'));

    expect(screen.getByRole('button', { name: '打开安装器' })).toBeInTheDocument();
  });

  it('下载失败横幅展示「重试下载」，点击触发下载命令', async () => {
    const startUpdateDownload = vi.fn(() => Promise.resolve(skippedCommand(downloadingState())));
    platformRef.current = createPlatform({ startUpdateDownload });
    render(<UpdateBanner />);
    await flushInit();

    emit('available', availableState());
    emit('download-progress', downloadingState());
    emit('error', errorState());

    expect(screen.getByText('更新没能完成')).toBeInTheDocument();
    expect(screen.getByText('下载没有完成，可重试')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '重试下载' }));
    await vi.waitFor(() => {
      expect(startUpdateDownload).toHaveBeenCalledTimes(1);
    });
  });

  it('检查阶段失败不唤起横幅', async () => {
    platformRef.current = createPlatform();
    render(<UpdateBanner />);
    await flushInit();

    emit('checking', checkingState());
    emit('error', errorState());

    expect(screen.queryByText('更新没能完成')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('发现新版本横幅展示中触发的检查失败，不就地转失败态', async () => {
    platformRef.current = createPlatform();
    render(<UpdateBanner />);
    await flushInit();

    emit('available', availableState());
    expect(screen.getByText('发现新版本')).toBeInTheDocument();

    emit('checking', checkingState());
    emit('error', errorState());

    expect(screen.queryByText('更新没能完成')).not.toBeInTheDocument();
  });

  it('点「稍后」后下载完成事件不弹回横幅', async () => {
    platformRef.current = createPlatform();
    render(<UpdateBanner />);
    await flushInit();

    emit('available', availableState());
    expect(screen.getByText('发现新版本')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '稍后' }));
    expect(screen.queryByText('发现新版本')).not.toBeInTheDocument();

    emit('download-progress', downloadingState());
    emit('downloaded', downloadedState());

    expect(screen.queryByText('更新已就绪')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('更新已就绪状态下遇到失败，横幅收起且不显示失败态', async () => {
    platformRef.current = createPlatform();
    render(<UpdateBanner />);
    await flushInit();

    emit('downloaded', downloadedState());
    expect(screen.getByText('更新已就绪')).toBeInTheDocument();

    emit('error', errorState());

    expect(screen.queryByText('更新已就绪')).not.toBeInTheDocument();
    expect(screen.queryByText('更新没能完成')).not.toBeInTheDocument();
  });

  it('再次收到 available 事件也不重置「稍后」', async () => {    platformRef.current = createPlatform();
    render(<UpdateBanner />);
    await flushInit();

    emit('available', availableState());
    fireEvent.click(screen.getByRole('button', { name: '稍后' }));
    emit('available', availableState());

    expect(screen.queryByText('发现新版本')).not.toBeInTheDocument();
  });

  it('点击「重新检查」立即清除「稍后」，横幅按真实状态恢复', async () => {
    const checkForUpdates = vi.fn(() => Promise.resolve(skippedCommand(availableState())));
    platformRef.current = createPlatform({ checkForUpdates });
    render(
      <>
        <UpdateBanner />
        <UpdateSection />
      </>,
    );
    await flushInit();

    emit('available', availableState());
    fireEvent.click(screen.getByRole('button', { name: '稍后' }));
    expect(screen.queryByText('发现新版本')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '重新检查' }));

    expect(await screen.findByText('发现新版本')).toBeInTheDocument();
  });

  it('进入设置页触发的检查不重置「稍后」', async () => {
    const checkForUpdates = vi.fn(() => Promise.resolve(skippedCommand(availableState())));
    platformRef.current = createPlatform({ checkForUpdates });
    render(<UpdateBanner />);
    await flushInit();

    emit('available', availableState());
    fireEvent.click(screen.getByRole('button', { name: '稍后' }));
    expect(screen.queryByText('发现新版本')).not.toBeInTheDocument();

    render(<UpdateSection />);
    await flushInit();

    expect(checkForUpdates).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('发现新版本')).not.toBeInTheDocument();
  });

  it('不再渲染更新弹窗（快照为 available 时也只出现横幅）', async () => {
    platformRef.current = createPlatform({
      getUpdateState: vi.fn(() => Promise.resolve(availableState())),
    });
    render(<UpdateBanner />);
    await flushInit();

    expect(screen.getByText('发现新版本')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('取消下载（§4.3）', () => {
  it('取消成功回到 available 并在设置页提示「已取消下载」', async () => {
    const cancelUpdateDownload = vi.fn(() => Promise.resolve(successCommand(availableState())));
    platformRef.current = createPlatform({ cancelUpdateDownload });
    render(<UpdateSection />);
    await flushInit();

    emit('download-progress', downloadingState());
    fireEvent.click(screen.getByRole('button', { name: '取消下载' }));

    expect(await screen.findByText('已取消下载')).toBeInTheDocument();
    expect(cancelUpdateDownload).toHaveBeenCalledTimes(1);
    expect(screen.getByText('发现新版本 0.6.12')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下载' })).toBeInTheDocument();
  });

  it('横幅取消后回到「发现新版本」，重新出现「下载」', async () => {
    const cancelUpdateDownload = vi.fn(() => Promise.resolve(successCommand(availableState())));
    platformRef.current = createPlatform({ cancelUpdateDownload });
    render(<UpdateBanner />);
    await flushInit();

    emit('download-progress', downloadingState());
    fireEvent.click(screen.getByRole('button', { name: '取消下载' }));

    expect(await screen.findByText('发现新版本')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下载' })).toBeInTheDocument();
  });
});

describe('安装与取消的失败反馈', () => {
  it('安装包缺失：提示「安装包已不存在，请重新检查更新」并保留「重新检查」入口', async () => {
    const installUpdate = vi.fn(() =>
      Promise.resolve(commandResult({ status: 'skipped', reason: 'missing-download-file', state: downloadedState() })),
    );
    platformRef.current = createPlatform({ installUpdate });
    render(<UpdateSection />);
    await flushInit();

    emit('downloaded', downloadedState());
    fireEvent.click(screen.getByRole('button', { name: '打开文件所在位置' }));

    expect(await screen.findByText('安装包已不存在，请重新检查更新')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重新检查' })).toBeInTheDocument();
  });

  it('安装失败：提示「没能打开安装包，请重试」', async () => {
    const installUpdate = vi.fn(() =>
      Promise.resolve(
        commandResult({
          status: 'failed',
          error: { message: 'open-failed' },
          state: downloadedState(),
        }),
      ),
    );
    platformRef.current = createPlatform({ installUpdate });
    render(<UpdateSection />);
    await flushInit();

    emit('downloaded', downloadedState());
    fireEvent.click(screen.getByRole('button', { name: '打开文件所在位置' }));

    expect(await screen.findByText('没能打开安装包，请重试')).toBeInTheDocument();
  });

  it('取消晚于真实下载失败：不提示「没能取消下载」', async () => {
    const cancelUpdateDownload = vi.fn(() =>
      Promise.resolve(
        commandResult({
          status: 'failed',
          error: { message: 'download-failed' },
          state: errorState(),
        }),
      ),
    );
    platformRef.current = createPlatform({ cancelUpdateDownload });
    render(<UpdateSection />);
    await flushInit();

    emit('download-progress', downloadingState());
    fireEvent.click(screen.getByRole('button', { name: '取消下载' }));

    expect(await screen.findByText('更新下载没能完成，可重试')).toBeInTheDocument();
    expect(screen.queryByText('没能取消下载，请重试')).not.toBeInTheDocument();
  });
});

describe('设置页状态行与动作（§3.3）', () => {
  it('checking：状态行「正在检查更新…」，只有禁用的「重新检查」', async () => {
    platformRef.current = createPlatform();
    render(<UpdateSection />);
    await flushInit();

    emit('checking', checkingState());

    expect(screen.getByText('正在检查更新…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重新检查' })).toBeDisabled();
  });

  it('not-available：状态行含上次检查时间，动作为「重新检查」', async () => {
    platformRef.current = createPlatform();
    render(<UpdateSection />);
    await flushInit();

    emit('not-available', notAvailableState());

    expect(screen.getByText(/^已是最新版本；上次检查：/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重新检查' })).toBeEnabled();
  });

  it('available：状态行与「下载 / 重新检查」两个动作', async () => {
    platformRef.current = createPlatform();
    render(<UpdateSection />);
    await flushInit();

    emit('available', availableState());

    expect(screen.getByText('发现新版本 0.6.12')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下载' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重新检查' })).toBeEnabled();
  });

  it('downloading：「取消下载」可用，「重新检查」禁用', async () => {
    platformRef.current = createPlatform();
    render(<UpdateSection />);
    await flushInit();

    emit('download-progress', downloadingState());

    expect(screen.getByText('正在下载更新 0.6.12')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '取消下载' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重新检查' })).toBeDisabled();
  });

  it('downloaded：状态行与安装动作（macOS zip 为「打开文件所在位置」）', async () => {
    platformRef.current = createPlatform();
    render(<UpdateSection />);
    await flushInit();

    emit('downloaded', downloadedState());

    expect(screen.getByText('新版本 0.6.12 已下载完成')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '打开文件所在位置' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重新检查' })).toBeInTheDocument();
  });

  it('check-error：状态行失败文案与「重新检查」，不出现「重试下载」', async () => {
    platformRef.current = createPlatform();
    render(<UpdateSection />);
    await flushInit();

    emit('checking', checkingState());
    emit('error', errorState());

    expect(screen.getByText('没能检查更新，可稍后重新检查')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重新检查' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重试下载' })).not.toBeInTheDocument();
  });

  it('download-error：状态行失败文案与「重试下载 / 重新检查」', async () => {
    platformRef.current = createPlatform();
    render(<UpdateSection />);
    await flushInit();

    emit('download-progress', downloadingState());
    emit('error', errorState());

    expect(screen.getByText('更新下载没能完成，可重试')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试下载' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重新检查' })).toBeInTheDocument();
  });

  it('节流提示按 retryAfterMs 就地提示，不覆盖状态行', async () => {
    const checkForUpdates = vi.fn(() => Promise.resolve(skippedCommand(idleState())));
    platformRef.current = createPlatform({ checkForUpdates });
    render(<UpdateSection />);
    await flushInit();

    emit('not-available', notAvailableState());
    expect(screen.getByText(/^已是最新版本；上次检查：/)).toBeInTheDocument();

    checkForUpdates.mockImplementation(() =>
      Promise.resolve(
        commandResult({ status: 'skipped', reason: 'throttled', retryAfterMs: 5_000, state: notAvailableState() }),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: '重新检查' }));

    expect(await screen.findByText('刚刚检查过，5 秒后可再次检查')).toBeInTheDocument();
    expect(screen.getByText(/^已是最新版本；上次检查：/)).toBeInTheDocument();
  });

  it('Linux：无应用内检查、无横幅，设置页只保留「前往下载页」', async () => {
    const checkForUpdates = vi.fn(() => Promise.resolve(skippedCommand(idleState('linux'))));
    const openExternal = vi.fn(() => Promise.resolve(true));
    platformRef.current = createPlatform({
      checkForUpdates,
      openExternal,
      getUpdateState: vi.fn(() => Promise.resolve(idleState('linux'))),
    });
    render(
      <>
        <UpdateBanner />
        <UpdateSection />
      </>,
    );
    await flushInit();

    expect(checkForUpdates).not.toHaveBeenCalled();
    expect(screen.getByText('Linux 版需要从下载页获取新版本')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重新检查' })).not.toBeInTheDocument();

    emit('available', availableState('linux'));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '前往下载页' }));
    await vi.waitFor(() => {
      expect(openExternal).toHaveBeenCalledWith('https://github.com/tf961656585/IArt/releases/latest');
    });
  });
});

describe('设置页诊断数据源初始化', () => {
  it('挂载后显示初始化的应用版本，不显示未知', async () => {
    platformRef.current = createPlatform();
    render(<UpdateSection />);
    expect(await screen.findByText('v9.9.9')).toBeInTheDocument();
  });
});
