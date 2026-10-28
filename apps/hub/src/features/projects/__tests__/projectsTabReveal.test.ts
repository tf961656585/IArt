import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

import {
  RevealProjectFolderResultSchema,
  StorageExportBundleResultSchema,
  type StorageListProjectsResult,
} from '@iart/contracts';
import type { HubPlatformBridge } from '../../../client/types';
// 用 client/projects 的同名工厂（features/projects/index.ts 会连带加载 ProjectsTab 组件树），
// 真实工厂实现 + platform 桩，工厂到桩的委托链保持真实。
import { createProjectsFeature } from '../../../client/projects';
import { useProjects } from '../ProjectsTab.hooks';

/**
 * Hub 项目域定位行为（spec docs/editor/本地文件快捷跳转.md）：
 * - 登记表「Hub 导出项目完成反馈」判据五历史特例：导出 .iarts.zip 后自动定位，
 *   定位目标是**文件**，主进程必须接受文件路径并高亮文件本身（回归点：旧 handler
 *   stat.isDirectory() 把文件路径一律拒成 path-missing，自动定位从未成功过）。
 * - LFJ-011：定位失败必须给可见反馈，不静默吞掉。
 * - LFJ-009：目录类定位文案统一「所在文件夹」口径。
 *
 * platform 用完整 HubPlatformBridge 桩（编译期钉住接口形状），经 vi.mock 注入
 * useHubRuntime；projectsFeature 用真实 createProjectsFeature 工厂包装该桩，
 * 夹具经 contracts schema parse 产生（与真实 IPC 响应同形）。
 */

const platformRef = vi.hoisted(() => ({ current: null as HubPlatformBridge | null }));

vi.mock('../../../components/providers/HubAppProvider', () => ({
  useHubRuntime: () => {
    const platform = platformRef.current;
    if (platform === null) throw new Error('用例没有装载 platform');
    return { platform, projectsFeature: createProjectsFeature(platform) };
  },
}));

const selectFolderSuccess = () => ({
  status: 'success' as const,
  path: '/dest',
  errorCode: null,
  userMessage: null,
  debugMessage: null,
});

const createPlatform = (
  overrides: Partial<Pick<HubPlatformBridge, 'revealProjectFolder' | 'selectFolder' | 'storageExportBundle' | 'isElectron'>>,
): HubPlatformBridge => {
  const bridge: HubPlatformBridge = {
    isElectron: overrides.isElectron ?? (() => true),
    openEditorWindow: vi.fn(),
    openExternal: vi.fn(() => Promise.resolve(true)),
    selectFolder:
      overrides.selectFolder ?? vi.fn(() => Promise.resolve(selectFolderSuccess())),
    selectProjectFolder: vi.fn(),
    revealProjectFolder:
      overrides.revealProjectFolder ??
      vi.fn((projectPath: string) =>
        Promise.resolve(RevealProjectFolderResultSchema.parse({ ok: true, path: projectPath })),
      ),
    isStorageReady: () => true,
    getAppVersion: vi.fn(() => Promise.resolve('9.9.9')),
    checkForUpdates: vi.fn(),
    startUpdateDownload: vi.fn(),
    cancelUpdateDownload: vi.fn(),
    installUpdate: vi.fn(),
    revealDownloadedUpdate: vi.fn(),
    getUpdateState: vi.fn(() => Promise.resolve(null)),
    getUpdaterLogInfo: vi.fn(() => Promise.resolve(null)),
    revealUpdaterLog: vi.fn(() => Promise.resolve({ success: true, path: '/logs/updater.log' })),
    revealBackendLogFolder: vi.fn(() => Promise.resolve({ success: true, path: '/logs' })),
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
    // fixture 以 contracts 接口格式为事实源（ProjectIndexItemSchema infer 的 optional 键
    // 与接口 required-with-undefined 在 exactOptionalPropertyTypes 下不兼容，schema parse
    // 产物喂不进本桩；空列表 fixture 无元素形状需校验，直接按接口格式标注）。
    storageListProjects: vi.fn(
      (): Promise<StorageListProjectsResult> => Promise.resolve({ projects: [] }),
    ),
    storageCreateProject: vi.fn(),
    storageOpenProject: vi.fn(),
    storageDeleteProject: vi.fn(),
    storageImportFolder: vi.fn(),
    storageImportBundle: vi.fn(),
    storageExportBundle:
      overrides.storageExportBundle ??
      vi.fn(() => Promise.resolve(StorageExportBundleResultSchema.parse({}))),
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

const renderProjects = (platform: HubPlatformBridge) => {
  platformRef.current = platform;
  return renderHook(() => useProjects());
};

afterEach(() => {
  cleanup();
  platformRef.current = null;
});

describe('useProjects 导出完成反馈自动定位（判据五历史特例）', () => {
  it('导出成功后以 .iarts.zip 文件路径调用定位，定位成功不覆盖成功文案', async () => {
    // @spec: LFJ-010
    const revealProjectFolder = vi.fn((projectPath: string) =>
      Promise.resolve(RevealProjectFolderResultSchema.parse({ ok: true, path: projectPath })),
    );
    const platform = createPlatform({ revealProjectFolder });
    const { result } = renderProjects(platform);

    await act(async () => {
      await result.current.exportProject('/projects/my-project', 'My Project');
    });

    // 回归点：定位目标是**文件**（.iarts.zip），不是目录
    expect(revealProjectFolder).toHaveBeenCalledWith('/dest/my-project.iarts.zip');
    expect(result.current.statusMessage).toBe('项目「My Project」已导出到所选文件夹');
  });

  it('导出成功但定位失败时给可见反馈，不静默（LFJ-011）', async () => {
    // @spec: LFJ-011
    const revealProjectFolder = vi.fn(() =>
      Promise.resolve(
        RevealProjectFolderResultSchema.parse({
          ok: false,
          reason: 'path-missing',
          path: '/dest/my-project.iarts.zip',
        }),
      ),
    );
    const platform = createPlatform({ revealProjectFolder });
    const { result } = renderProjects(platform);

    await act(async () => {
      await result.current.exportProject('/projects/my-project', 'My Project');
    });

    expect(result.current.statusMessage).toBe(
      '项目「My Project」已导出到所选文件夹，但没能打开文件所在位置',
    );
  });
});

describe('useProjects 项目目录定位文案（LFJ-009 目录类「所在文件夹」口径）', () => {
  it('定位成功提示「已打开项目所在文件夹」', async () => {
    // @spec: LFJ-009
    const revealProjectFolder = vi.fn((projectPath: string) =>
      Promise.resolve(RevealProjectFolderResultSchema.parse({ ok: true, path: projectPath })),
    );
    const platform = createPlatform({ revealProjectFolder });
    const { result } = renderProjects(platform);

    await act(async () => {
      await result.current.revealProjectFolder('/projects/my-project');
    });

    expect(revealProjectFolder).toHaveBeenCalledWith('/projects/my-project');
    expect(result.current.statusMessage).toBe('已打开项目所在文件夹');
  });

  it('目标目录不存在时提示目录已被移动或删除，不静默', async () => {
    // @spec: LFJ-011
    const revealProjectFolder = vi.fn(() =>
      Promise.resolve(
        RevealProjectFolderResultSchema.parse({
          ok: false,
          reason: 'path-missing',
          path: '/projects/gone',
        }),
      ),
    );
    const platform = createPlatform({ revealProjectFolder });
    const { result } = renderProjects(platform);

    await act(async () => {
      await result.current.revealProjectFolder('/projects/gone');
    });

    expect(result.current.statusMessage).toBe('项目目录已不在原来的位置，请检查它是否被移动或删除');
  });

  it('非桌面应用环境提示需在桌面应用中打开所在文件夹', async () => {
    // @spec: LFJ-009
    const revealProjectFolder = vi.fn();
    const platform = createPlatform({ revealProjectFolder, isElectron: () => false });
    const { result } = renderProjects(platform);

    await act(async () => {
      await result.current.revealProjectFolder('/projects/my-project');
    });

    expect(revealProjectFolder).not.toHaveBeenCalled();
    expect(result.current.statusMessage).toBe('请在桌面应用中打开所在文件夹');
  });
});
