import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { AppUpdateCommandResultSchema, AppUpdateStateSchema } from '@iart/contracts';
import type { HubPlatformBridge } from '../../../client/types';
import { UpdateSection } from '../UpdateSection';

/**
 * 设置页「检查更新」子单元的诊断入口（spec docs/editor/本地文件快捷跳转.md LFJ-008）：
 * 「打开日志文件夹」定位 backend 业务日志目录（存储根 logs/），路径解析归主进程；
 * 失败必须给可见反馈，不静默。
 *
 * platform 用完整 HubPlatformBridge 桩（编译期钉住接口形状），经 vi.mock 注入 useHubRuntime。
 * 更新夹具经 contracts schema parse 产生（与真实 IPC 响应同形）。
 */

const platformRef = vi.hoisted(() => ({ current: null as HubPlatformBridge | null }));

vi.mock('../../../components/providers/HubAppProvider', () => ({
  useHubRuntime: () => {
    const platform = platformRef.current;
    if (platform === null) throw new Error('用例没有装载 platform');
    return { platform };
  },
}));

const idleState = () =>
  AppUpdateStateSchema.parse({
    status: 'idle',
    appVersion: '9.9.9',
    channel: 'stable',
    platform: 'darwin',
    arch: 'arm64',
    lastCheckedAt: null,
    logPath: null,
  });

const skippedCommand = () =>
  AppUpdateCommandResultSchema.parse({
    status: 'skipped',
    reason: 'already-checking',
    state: idleState(),
  });

const createPlatform = (
  overrides: Partial<Pick<HubPlatformBridge, 'revealBackendLogFolder' | 'revealUpdaterLog'>>,
): HubPlatformBridge => {
  const bridge: HubPlatformBridge = {
    isElectron: () => true,
    openEditorWindow: vi.fn(),
    openExternal: vi.fn(() => Promise.resolve(true)),
    selectFolder: vi.fn(),
    selectProjectFolder: vi.fn(),
    revealProjectFolder: vi.fn(),
    isStorageReady: () => true,
    getAppVersion: vi.fn(() => Promise.resolve('9.9.9')),
    checkForUpdates: vi.fn(() => Promise.resolve(skippedCommand())),
    startUpdateDownload: vi.fn(),
    installUpdate: vi.fn(),
    revealDownloadedUpdate: vi.fn(),
    getUpdateState: vi.fn(() => Promise.resolve(null)),
    getUpdaterLogInfo: vi.fn(() => Promise.resolve(null)),
    revealUpdaterLog:
      overrides.revealUpdaterLog ??
      vi.fn(() => Promise.resolve({ success: true, path: '/logs/updater.log' })),
    revealBackendLogFolder:
      overrides.revealBackendLogFolder ??
      vi.fn(() => Promise.resolve({ success: true, path: '/logs' })),
    onAppUpdateEvent: vi.fn(),
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

afterEach(() => {
  cleanup();
  platformRef.current = null;
});

describe('UpdateSection 日志目录入口（LFJ-008）', () => {
  // @spec: LFJ-008
it('提供「打开日志文件夹」入口，点击调用业务日志目录定位通道', async () => {
    const revealBackendLogFolder =
      vi.fn<HubPlatformBridge['revealBackendLogFolder']>(() => Promise.resolve({ success: true, path: '/logs' }));
    platformRef.current = createPlatform({ revealBackendLogFolder });

    render(<UpdateSection />);

    const button = await screen.findByRole('button', { name: '打开日志文件夹' });
    expect(screen.getByRole('button', { name: '打开更新日志' })).toBeInTheDocument();

    fireEvent.click(button);
    await vi.waitFor(() => {
      expect(revealBackendLogFolder).toHaveBeenCalledTimes(1);
    });
  });

  // @spec: LFJ-008
// @spec: LFJ-011
it('定位失败给可见反馈，不静默', async () => {
    const revealBackendLogFolder =
      vi.fn<HubPlatformBridge['revealBackendLogFolder']>(() =>
        Promise.resolve({ success: false, error: 'storage-root-unresolved' }),
      );
    platformRef.current = createPlatform({ revealBackendLogFolder });

    render(<UpdateSection />);

    fireEvent.click(await screen.findByRole('button', { name: '打开日志文件夹' }));
    expect(await screen.findByText('没能打开日志文件夹，请重试')).toBeInTheDocument();
  });
});
