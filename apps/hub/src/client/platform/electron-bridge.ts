import {
  checkForUpdates as sdkCheckForUpdates,
  fetchAppVersionFromElectron,
  isElectronEnvironment,
  openEditorWindow as sdkOpenEditorWindow,
  openExternal as sdkOpenExternal,
  revealProjectFolder as sdkRevealProjectFolder,
  selectFolder,
  selectProjectFolder,
} from '@iart/backend-sdk';
import type {
  StorageCreateProjectParams,
  StorageCreateProjectResult,
  StorageDeleteProjectParams,
  StorageDeleteProjectResult,
  StorageExportBundleParams,
  StorageExportBundleResult,
  StorageImportBundleParams,
  StorageImportBundleResult,
  StorageImportFolderParams,
  StorageImportFolderResult,
  StorageListProjectsResult,
  StorageOpenProjectParams,
  StorageOpenProjectResult,
  PackagesListResult,
  PackagesCreateResult,
  PackagesRenameResult,
  PackagesDeleteResult,
  PackagesRevealResult,
  PackagesListParams,
  PackagesCreateParams,
  PackagesRenameParams,
  PackagesDeleteParams,
  PackagesRevealParams,
} from '@iart/contracts';
import {
  AppUpdateCommandResultSchema,
  AppUpdateEventSchema,
  AppUpdateLogInfoResultSchema,
  AppUpdateRevealLogResultSchema,
  AppUpdateStateSchema,
  CliEntryOperationResultSchema,
  CliStatusDtoSchema,
  PACKAGE_IPC_CHANNELS,
  RevealBackendLogFolderResultSchema,
  SkillInstallResultSchema,
  SkillInstalledStateSchema,
  SkillRevealInstallFolderResultSchema,
  SkillListCustomTargetsResultSchema,
  SkillCustomTargetMutationResultSchema,
  SkillRemoveCustomTargetResultSchema,
  StorageListProjectsResultSchema,
  StorageCreateProjectResultSchema,
  StorageDeleteProjectResultSchema,
  StorageExportBundleResultSchema,
  StorageImportBundleResultSchema,
  StorageImportFolderResultSchema,
  StorageOpenProjectResultSchema,
  PackagesListResultSchema,
  PackagesCreateResultSchema,
  PackagesRenameResultSchema,
  PackagesDeleteResultSchema,
  PackagesRevealResultSchema,
  HubFocusSettingsNoticeSchema,
} from '@iart/contracts';
import type {
  SkillInstallRequest,
  SkillRevealInstallFolderRequest,
  SkillCustomTargetMutationResult,
  SkillListCustomTargetsResult,
  SkillRemoveCustomTargetResult,
} from '@iart/contracts';
import type { HubPlatformBridge } from '../types';

const getElectronApi = () => (typeof window !== 'undefined' ? window.electron ?? null : null);

const invokeStorageChannel = async <T>(channel: string, schema: { parse(value: unknown): unknown }, args: unknown | undefined): Promise<T> => {
  const api = getElectronApi();
  if (!api || !api.storage || typeof api.storage[channel] !== 'function') {
    throw new Error('Storage IPC channel not available: ' + channel);
  }
  return schema.parse(await api.storage[channel](args)) as T;
};

const invokePackageChannel = async <T>(channel: string, schema: { parse(value: unknown): unknown }, args: unknown | undefined): Promise<T> => {
  const api = getElectronApi();
  if (!api || !api.packages || typeof api.packages[channel] !== 'function') {
    throw new Error('Packages IPC channel not available: ' + channel);
  }
  return schema.parse(await api.packages[channel](args)) as T;
};

export const createHubPlatformBridge = (): HubPlatformBridge => {
  return {
    isElectron: () => isElectronEnvironment(),
    openEditorWindow: async (target) => sdkOpenEditorWindow(target),
    openExternal: async (target) => sdkOpenExternal(target),
    selectFolder,
    selectProjectFolder,
    revealProjectFolder: async (projectPath) => sdkRevealProjectFolder(projectPath),
    isStorageReady: () => {
      const api = getElectronApi();
      return Boolean(api !== null && api.storage && api.storage['storage:list-projects']);
    },
    getAppVersion: async () => fetchAppVersionFromElectron(),
    checkForUpdates: async (manual: boolean) => {
      const api = getElectronApi();
      if (!api || typeof api.checkForUpdates !== 'function') {
        return AppUpdateCommandResultSchema.parse({
          status: 'failed',
          error: { message: 'not-in-electron' },
          state: emptyUpdateState(),
        });
      }
      return AppUpdateCommandResultSchema.parse(await sdkCheckForUpdates(manual));
    },
    startUpdateDownload: async () => {
      const api = getElectronApi();
      if (!api || typeof api.startUpdateDownload !== 'function') {
        return AppUpdateCommandResultSchema.parse({
          status: 'failed',
          error: { message: 'not-in-electron' },
          state: emptyUpdateState(),
        });
      }
      return AppUpdateCommandResultSchema.parse(await api.startUpdateDownload());
    },
    cancelUpdateDownload: async () => {
      const api = getElectronApi();
      if (!api || typeof api.cancelUpdateDownload !== 'function') {
        return AppUpdateCommandResultSchema.parse({
          status: 'failed',
          error: { message: 'not-in-electron' },
          state: emptyUpdateState(),
        });
      }
      return AppUpdateCommandResultSchema.parse(await api.cancelUpdateDownload());
    },
    installUpdate: async () => {
      const api = getElectronApi();
      if (!api || typeof api.installUpdate !== 'function') {
        return AppUpdateCommandResultSchema.parse({
          status: 'failed',
          error: { message: 'not-in-electron' },
          state: emptyUpdateState(),
        });
      }
      return AppUpdateCommandResultSchema.parse(await api.installUpdate());
    },
    revealDownloadedUpdate: async () => {
      const api = getElectronApi();
      if (!api || typeof api.revealDownloadedUpdate !== 'function') {
        return AppUpdateCommandResultSchema.parse({
          status: 'failed',
          error: { message: 'not-in-electron' },
          state: emptyUpdateState(),
        });
      }
      return AppUpdateCommandResultSchema.parse(await api.revealDownloadedUpdate());
    },
    getUpdateState: async () => {
      const api = getElectronApi();
      if (!api || typeof api.getUpdateState !== 'function') {
        return null;
      }
      return AppUpdateStateSchema.parse(await api.getUpdateState());
    },
    getUpdaterLogInfo: async () => {
      const api = getElectronApi();
      if (!api || typeof api.getUpdaterLogInfo !== 'function') {
        return null;
      }
      return AppUpdateLogInfoResultSchema.parse(await api.getUpdaterLogInfo());
    },
    revealUpdaterLog: async () => {
      const api = getElectronApi();
      if (!api || typeof api.revealUpdaterLog !== 'function') {
        return { success: false, error: 'not-in-electron' };
      }
      return AppUpdateRevealLogResultSchema.parse(await api.revealUpdaterLog());
    },
    revealBackendLogFolder: async () => {
      const api = getElectronApi();
      if (!api || typeof api.revealBackendLogFolder !== 'function') {
        return RevealBackendLogFolderResultSchema.parse({ success: false, error: 'not-in-electron' });
      }
      return RevealBackendLogFolderResultSchema.parse(await api.revealBackendLogFolder());
    },
    onAppUpdateEvent: (callback) => {
      const api = getElectronApi();
      if (!api || typeof api.onAppUpdateEvent !== 'function') return;
      api.onAppUpdateEvent((event) => callback(AppUpdateEventSchema.parse(event)));
    },
    onUpdateChecking: (callback) => {
      bindUpdateEvent('checking', callback);
    },
    onUpdateAvailable: (callback) => {
      bindUpdateEvent('available', callback);
    },
    onUpdateNotAvailable: (callback) => {
      bindUpdateEvent('not-available', callback);
    },
    onUpdateDownloadProgress: (callback) => {
      bindUpdateEvent('download-progress', callback);
    },
    onUpdateDownloaded: (callback) => {
      bindUpdateEvent('downloaded', callback);
    },
    onUpdateError: (callback) => {
      bindUpdateEvent('error', callback);
    },

    // ========== Storage IPC (项目 CRUD) ==========
    storageListProjects: () => invokeStorageChannel<StorageListProjectsResult>('storage:list-projects', StorageListProjectsResultSchema, undefined),
    storageCreateProject: (params: StorageCreateProjectParams) =>
      invokeStorageChannel<StorageCreateProjectResult>('storage:create-project', StorageCreateProjectResultSchema, params),
    storageOpenProject: (params: StorageOpenProjectParams) =>
      invokeStorageChannel<StorageOpenProjectResult>('storage:open-project', StorageOpenProjectResultSchema, params),
    storageDeleteProject: (params: StorageDeleteProjectParams) =>
      invokeStorageChannel<StorageDeleteProjectResult>('storage:delete-project', StorageDeleteProjectResultSchema, params),
    storageImportFolder: (params: StorageImportFolderParams) =>
      invokeStorageChannel<StorageImportFolderResult>('storage:import-folder', StorageImportFolderResultSchema, params),
    storageImportBundle: (params: StorageImportBundleParams) =>
      invokeStorageChannel<StorageImportBundleResult>('storage:import-bundle', StorageImportBundleResultSchema, params),
    storageExportBundle: (params: StorageExportBundleParams) =>
      invokeStorageChannel<StorageExportBundleResult>('storage:export-bundle', StorageExportBundleResultSchema, params),

    // ========== 包管理 IPC ==========
    packagesList: (params: PackagesListParams) =>
      invokePackageChannel<PackagesListResult>(PACKAGE_IPC_CHANNELS.LIST_PACKAGES, PackagesListResultSchema, params),
    packagesCreate: (params: PackagesCreateParams) =>
      invokePackageChannel<PackagesCreateResult>(PACKAGE_IPC_CHANNELS.CREATE_PACKAGE, PackagesCreateResultSchema, params),
    packagesRename: (params: PackagesRenameParams) =>
      invokePackageChannel<PackagesRenameResult>(PACKAGE_IPC_CHANNELS.RENAME_PACKAGE, PackagesRenameResultSchema, params),
    packagesDelete: (params: PackagesDeleteParams) =>
      invokePackageChannel<PackagesDeleteResult>(PACKAGE_IPC_CHANNELS.DELETE_PACKAGE, PackagesDeleteResultSchema, params),
    packagesReveal: (params: PackagesRevealParams) =>
      invokePackageChannel<PackagesRevealResult>(PACKAGE_IPC_CHANNELS.REVEAL_PACKAGE, PackagesRevealResultSchema, params),

    // ========== Task IPC ==========
    onTaskStateChanged: (callback) => {
      const api = getElectronApi();
      if (!api || typeof api.onTaskStateChanged !== 'function') return;
      api.onTaskStateChanged(callback);
    },
    onTaskStateSnapshot: (callback) => {
      const api = getElectronApi();
      if (!api || typeof api.onTaskStateSnapshot !== 'function') return;
      api.onTaskStateSnapshot(callback);
    },
    removeTaskStateListeners: () => {
      const api = getElectronApi();
      if (!api || typeof api.removeTaskStateListeners !== 'function') return;
      api.removeTaskStateListeners();
    },

    // ========== 首次指引（docs/hub/首次指引-design.md §4.3） ==========
    // main → Hub 通知：Editor 请求聚焦主窗口并定位设置页子单元。
    // 载荷经 HubFocusSettingsNoticeSchema 边界校验（AGENTS.md IPC 边界用 Zod parse）。
    onHubFocusSettings: (callback) => {
      const api = getElectronApi();
      if (!api || typeof api.onHubFocusSettings !== 'function') return;
      api.onHubFocusSettings((notice) => {
        const parsed = HubFocusSettingsNoticeSchema.safeParse(notice);
        if (parsed.success) callback(parsed.data);
      });
    },
    removeHubFocusSettingsListener: () => {
      const api = getElectronApi();
      if (!api || typeof api.removeHubFocusSettingsListener !== 'function') return;
      api.removeHubFocusSettingsListener();
    },

    // ========== Skill 商店 IPC ==========
    getSkillInstalledState: async () => {
      const api = getElectronApi();
      if (!api || typeof api.getSkillInstalledState !== 'function') {
        return SkillInstalledStateSchema.parse({ skills: [] });
      }
      return SkillInstalledStateSchema.parse(await api.getSkillInstalledState());
    },
    installSkill: async (request: SkillInstallRequest) => {
      const api = getElectronApi();
      if (!api || typeof api.installSkill !== 'function') {
        return SkillInstallResultSchema.parse({ ok: false, error: '请在桌面应用中安装 Skill' });
      }
      return SkillInstallResultSchema.parse(
        await api.installSkill(request.bundleUrl, request.sha512, request.target, request.skillId),
      );
    },
    revealSkillInstallFolder: async (request: SkillRevealInstallFolderRequest) => {
      const api = getElectronApi();
      if (!api || typeof api.revealSkillInstallFolder !== 'function') {
        return SkillRevealInstallFolderResultSchema.parse({ ok: false, reason: 'not-in-electron' });
      }
      try {
        return SkillRevealInstallFolderResultSchema.parse(
          await api.revealSkillInstallFolder(request.skillId, request.target),
        );
      } catch (error: unknown) {
        console.warn('[skills] revealSkillInstallFolder failed:', error);
        return SkillRevealInstallFolderResultSchema.parse({ ok: false, reason: 'invoke-failed' });
      }
    },
    // 自定义安装目标注册表（Hub 弹层统一管理）：响应两个分支均过 contracts schema 边界校验。
    listCustomSkillInstallTargets: async (): Promise<SkillListCustomTargetsResult> => {
      const api = getElectronApi();
      if (!api || typeof api.listCustomSkillInstallTargets !== 'function') {
        return SkillListCustomTargetsResultSchema.parse({ targets: [] });
      }
      return SkillListCustomTargetsResultSchema.parse(await api.listCustomSkillInstallTargets());
    },
    addCustomSkillInstallTarget: async (name: string, dir: string): Promise<SkillCustomTargetMutationResult> => {
      const api = getElectronApi();
      if (!api || typeof api.addCustomSkillInstallTarget !== 'function') {
        return SkillCustomTargetMutationResultSchema.parse({ ok: false, error: 'invoke-failed' });
      }
      try {
        return SkillCustomTargetMutationResultSchema.parse(await api.addCustomSkillInstallTarget(name, dir));
      } catch (error: unknown) {
        console.warn('[skills] addCustomSkillInstallTarget failed:', error);
        return SkillCustomTargetMutationResultSchema.parse({ ok: false, error: 'invoke-failed' });
      }
    },
    updateCustomSkillInstallTarget: async (
      id: string,
      name: string,
      skillsDir: string,
    ): Promise<SkillCustomTargetMutationResult> => {
      const api = getElectronApi();
      if (!api || typeof api.updateCustomSkillInstallTarget !== 'function') {
        return SkillCustomTargetMutationResultSchema.parse({ ok: false, error: 'invoke-failed' });
      }
      try {
        return SkillCustomTargetMutationResultSchema.parse(
          await api.updateCustomSkillInstallTarget(id, name, skillsDir),
        );
      } catch (error: unknown) {
        console.warn('[skills] updateCustomSkillInstallTarget failed:', error);
        return SkillCustomTargetMutationResultSchema.parse({ ok: false, error: 'invoke-failed' });
      }
    },
    removeCustomSkillInstallTarget: async (id: string): Promise<SkillRemoveCustomTargetResult> => {
      const api = getElectronApi();
      if (!api || typeof api.removeCustomSkillInstallTarget !== 'function') {
        return SkillRemoveCustomTargetResultSchema.parse({ ok: false, error: 'invoke-failed' });
      }
      try {
        return SkillRemoveCustomTargetResultSchema.parse(await api.removeCustomSkillInstallTarget(id));
      } catch (error: unknown) {
        console.warn('[skills] removeCustomSkillInstallTarget failed:', error);
        return SkillRemoveCustomTargetResultSchema.parse({ ok: false, error: 'invoke-failed' });
      }
    },

    // ========== CLI 设置页「命令行工具」子单元（docs/integrations/CLI与本地Agent集成.md §8） ==========
    // 子单元只读展示 + 入口注册，不承载 CLI 行为配置，不提供令牌查看或重置（spec §7/§13）。
    getCliStatus: async () => {
      const api = getElectronApi();
      if (!api || typeof api.getCliStatus !== 'function') {
        return null;
      }
      return CliStatusDtoSchema.parse(await api.getCliStatus());
    },
    registerCliEntry: async () => {
      const api = getElectronApi();
      if (!api || typeof api.registerCliEntry !== 'function') {
        return CliEntryOperationResultSchema.parse({ ok: false, message: '请在桌面应用中注册 iart 命令' });
      }
      return CliEntryOperationResultSchema.parse(await api.registerCliEntry());
    },
    unregisterCliEntry: async () => {
      const api = getElectronApi();
      if (!api || typeof api.unregisterCliEntry !== 'function') {
        return CliEntryOperationResultSchema.parse({ ok: false, message: '请在桌面应用中卸除注册' });
      }
      return CliEntryOperationResultSchema.parse(await api.unregisterCliEntry());
    },
  };
};

const emptyUpdateState = () => AppUpdateStateSchema.parse({
  status: 'idle',
  appVersion: 'unknown',
  channel: 'stable',
  platform: 'linux',
  arch: 'x64',
  lastCheckedAt: null,
  logPath: null,
});

const bindUpdateEvent = (type: Parameters<HubPlatformBridge['onAppUpdateEvent']>[0] extends (event: infer T) => void ? T extends { type: infer U } ? U : never : never, callback: (state: ReturnType<typeof emptyUpdateState>) => void) => {
  const api = getElectronApi();
  if (!api || typeof api.onAppUpdateEvent !== 'function') return;
  api.onAppUpdateEvent((event) => {
    const parsed = AppUpdateEventSchema.parse(event);
    if (parsed.type === type) callback(AppUpdateStateSchema.parse(parsed.state));
  });
};
