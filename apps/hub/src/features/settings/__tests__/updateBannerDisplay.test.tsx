import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { AppUpdateEventSchema, AppUpdateStateSchema } from '@iart/contracts';
import type { AppUpdateCommandResult, AppUpdateEvent, AppUpdateState } from '@iart/contracts';
import type { HubPlatformBridge } from '../../../client/types';
import { UpdateBanner } from '../UpdateBanner';
import { UpdateSection } from '../UpdateSection';

/**
 * 更新失败打扰收敛的展示规则（spec docs/desktop-updates/README.md「自动更新策略」）：
 * - 失败不主动唤起全局横幅：检查阶段失败（启动自动检查、路过设置页触发的检查）横幅不出；
 * - 横幅已展示发现/下载流程时，失败允许就地转为失败态（信息降级，不算新增打扰）；
 * - error 事件不重置「稍后」忽略标记；available/downloaded 仍重置（正向新信号）；
 * - downloaded（更新已就绪）遇失败横幅收起，不降级也不顶掉安装引导。
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

const createPlatform = (): HubPlatformBridge => {
  const bridge: HubPlatformBridge = {
    isElectron: () => true,
    openEditorWindow: vi.fn(),
    openExternal: vi.fn(() => Promise.resolve(true)),
    selectFolder: vi.fn(),
    selectProjectFolder: vi.fn(),
    revealProjectFolder: vi.fn(),
    isStorageReady: () => true,
    getAppVersion: vi.fn(() => Promise.resolve('9.9.9')),
    // 挂载自动检查永不落定：测试用例显式经事件驱动状态，避免命令结果异步插入打乱事件序列
    checkForUpdates: vi.fn(() => new Promise<AppUpdateCommandResult>(() => {})),
    startUpdateDownload: vi.fn(),
    installUpdate: vi.fn(),
    revealDownloadedUpdate: vi.fn(),
    getUpdateState: vi.fn(() => Promise.resolve(null)),
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

const baseState = {
  appVersion: '0.6.11',
  channel: 'stable',
  platform: 'darwin',
  arch: 'arm64',
  lastCheckedAt: 1,
  logPath: null,
} as const;

const checkingState = (): AppUpdateState =>
  AppUpdateStateSchema.parse({ status: 'checking', ...baseState });

const availableState = (): AppUpdateState =>
  AppUpdateStateSchema.parse({
    status: 'available',
    ...baseState,
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
    progress: null,
  });

const downloadedState = (): AppUpdateState =>
  AppUpdateStateSchema.parse({
    status: 'downloaded',
    ...baseState,
    latestVersion: '0.6.12',
    downloadPath: '/tmp/IARTStudio-0.6.12.dmg',
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

const emit = (type: AppUpdateEvent['type'], state: AppUpdateState): void => {
  const event = AppUpdateEventSchema.parse({ type, state });
  act(() => {
    for (const handler of eventHandlers) handler(event);
  });
};

// 挂载 initialize（getAppVersion/getUpdateState/getUpdaterLogInfo 链）是微任务链，
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
});

describe('更新失败打扰收敛：横幅展示规则', () => {
  it('检查阶段失败不唤起横幅，失败详情归设置页', async () => {
    platformRef.current = createPlatform();
    render(
      <>
        <UpdateBanner />
        <UpdateSection />
      </>,
    );
    await flushInit();

    emit('checking', checkingState());
    emit('error', errorState());

    expect(screen.queryByText('更新没能完成')).not.toBeInTheDocument();
    expect(screen.getByText('没能检查更新，可稍后重新检查')).toBeInTheDocument();
  });

  it('横幅展示发现/下载流程时，失败就地转为失败态', async () => {
    platformRef.current = createPlatform();
    render(
      <>
        <UpdateBanner />
        <UpdateSection />
      </>,
    );
    await flushInit();

    emit('available', availableState());
    expect(screen.getByText('发现新版本')).toBeInTheDocument();

    emit('download-progress', downloadingState());
    emit('error', errorState());

    expect(screen.getByText('更新没能完成')).toBeInTheDocument();
    expect(screen.getByText('下载没有完成，可稍后重试')).toBeInTheDocument();
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

  it('点击稍后后，失败不再唤起横幅', async () => {
    platformRef.current = createPlatform();
    render(<UpdateBanner />);
    await flushInit();

    emit('available', availableState());
    expect(screen.getByText('发现新版本')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '稍后' }));

    emit('download-progress', downloadingState());
    emit('error', errorState());

    expect(screen.queryByText('更新没能完成')).not.toBeInTheDocument();
    expect(screen.queryByText('发现新版本')).not.toBeInTheDocument();
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

  it('available 正向信号仍会重新唤起被忽略的横幅', async () => {
    platformRef.current = createPlatform();
    render(<UpdateBanner />);
    await flushInit();

    emit('available', availableState());
    fireEvent.click(screen.getByRole('button', { name: '稍后' }));
    emit('error', errorState());
    expect(screen.queryByText('发现新版本')).not.toBeInTheDocument();

    emit('available', availableState());
    expect(screen.getByText('发现新版本')).toBeInTheDocument();
  });
});

describe('设置页诊断数据源初始化', () => {
  it('挂载后显示初始化的应用版本，不显示未知', async () => {
    platformRef.current = createPlatform();
    render(<UpdateSection />);
    expect(await screen.findByText('v9.9.9')).toBeInTheDocument();
  });
});
