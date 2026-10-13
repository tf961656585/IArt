import type {
  ClipboardWriteImageResponse,
  ClipboardWriteTextResponse,
  CliEntryOperationResult,
  CliProxyCommandResponse,
  CliStatusDto,
  EditorDesktopBootstrap,
  HubDesktopBootstrap,
  OpenEditorWindowResult,
  RevealProjectFolderResult as RevealFolderResult,
  WindowChromeInsets,
} from "@iart/contracts";
import type {
  AppUpdateCommandResult,
  AppUpdateEvent,
  AppUpdateLogInfoResult,
  AppUpdateProgress,
  AppUpdateRevealLogResult,
  AppUpdateState,
} from "@iart/contracts";

export type {
  AppUpdateCommandResult,
  AppUpdateEvent,
  AppUpdateErrorPayload,
  AppUpdateLogInfoResult,
  AppUpdateProgress,
  AppUpdateRevealLogResult,
  AppUpdateState,
  ClipboardWriteImageResponse,
  ClipboardWriteTextResponse,
  EditorDesktopBootstrap,
  HubDesktopBootstrap,
  OpenEditorWindowResult,
} from "@iart/contracts";

export interface SelectFolderOptions {
  title: string | undefined;
  defaultPath: string | undefined;
  buttonLabel: string | undefined;
}

export const SELECT_FOLDER_ERROR_CODES = {
  ENVIRONMENT_UNAVAILABLE: "environment_unavailable",
  INVALID_RESPONSE: "invalid_response",
  INVOKE_FAILED: "invoke_failed",
  WINDOW_UNAVAILABLE: "window_unavailable",
  DIALOG_OPEN_FAILED: "dialog_open_failed",
  UNKNOWN: "unknown",
} as const;

export type SelectFolderErrorCode =
  (typeof SELECT_FOLDER_ERROR_CODES)[keyof typeof SELECT_FOLDER_ERROR_CODES];

export type SelectFolderResult =
  | {
      status: "success";
      path: string;
      errorCode: null;
      userMessage: null;
      debugMessage: null;
    }
  | {
      status: "canceled";
      path: null;
      errorCode: null;
      userMessage: null;
      debugMessage: null;
    }
  | {
      status: "error";
      path: null;
      errorCode: SelectFolderErrorCode;
      userMessage: string;
      debugMessage: string | null;
    };

export type RevealTaskArchiveResult =
  | { ok: true; dir: string }
  | { ok: false; reason: string };

export type RevealFilesUrlResult =
  | { ok: true; fileKey: string; dir: string; filePath: string }
  | { ok: false; reason: string };

export interface OpenExternalResult {
  ok: boolean;
  reason: string | undefined;
}

export interface OpenDevConsoleResult {
  ok: boolean;
  reason: string | undefined;
}

export type OpenEditorWindowRequest = {
  projectPath: string;
  sessionToken: string;
};

export type { RevealProjectFolderResult as RevealFolderResult } from "@iart/contracts";
export type {
  RevealProjectFolderResult,
  RevealProjectFolderFailureReason,
} from "@iart/contracts";

export type CheckForUpdatesResult = AppUpdateCommandResult;
export type UpdateProgressSnapshot = AppUpdateProgress;
export type UpdateStateSnapshot = AppUpdateState;
export type UpdateAvailableInfo = AppUpdateState;
export type UpdateNotAvailableInfo = AppUpdateState;
export type UpdateDownloadedInfo = AppUpdateState;
export type UpdateErrorPayload = AppUpdateState;

export type UpdaterLogInfoResult = AppUpdateLogInfoResult;
export type RevealUpdaterLogResult = AppUpdateRevealLogResult;

export type ElectronRuntimeFlags = {
  isPackaged: boolean | undefined;
};

export type ElectronBridge = {
  getHubBootstrap: () =>
    | Promise<HubDesktopBootstrap | null | undefined>
    | HubDesktopBootstrap
    | null
    | undefined | undefined;
  getEditorBootstrap: () =>
    | Promise<EditorDesktopBootstrap | null | undefined>
    | EditorDesktopBootstrap
    | null
    | undefined | undefined;
  getAppVersion: () =>
    | Promise<string | null | undefined>
    | string
    | null
    | undefined | undefined;
  getRuntimeFlags: () =>
    | Promise<ElectronRuntimeFlags | null | undefined>
    | ElectronRuntimeFlags
    | null
    | undefined | undefined;
  openEditorWindow: (
    target: OpenEditorWindowRequest,
  ) =>
    | Promise<OpenEditorWindowResult | OpenExternalResult>
    | OpenEditorWindowResult
    | OpenExternalResult | undefined;
  openExternal: (
    target: string,
  ) => Promise<boolean | OpenExternalResult> | boolean | OpenExternalResult | undefined;
  openDevConsole: () => Promise<OpenDevConsoleResult> | OpenDevConsoleResult | undefined;
  selectFolder: (options: SelectFolderOptions | undefined) => Promise<SelectFolderResult> | undefined;
  selectProjectFolder: (
    options: SelectFolderOptions | undefined,
  ) => Promise<SelectFolderResult> | undefined;
  getCurrentProjectPath: () => Promise<string | null> | undefined;
  setCurrentProjectPath: (path: string | null) => Promise<void> | undefined;
  revealTaskArchive: (
    taskId: string,
    projectPath: string | null | undefined,
  ) => Promise<RevealTaskArchiveResult> | undefined;
  revealFilesUrl: (
    url: string,
    projectPath: string | null | undefined,
  ) => Promise<RevealFilesUrlResult> | undefined;
  revealProjectFolder: (projectPath: string) => Promise<RevealFolderResult> | undefined;
  writeTextToClipboard: (
    text: string,
  ) => Promise<ClipboardWriteTextResponse> | undefined;
  writeImageFromUrlToClipboard: (
    url: string,
    projectPath: string | null,
  ) => Promise<ClipboardWriteImageResponse> | undefined;
  checkForUpdates: (manual: boolean) => Promise<AppUpdateCommandResult> | undefined;
  startUpdateDownload: () => Promise<AppUpdateCommandResult> | undefined;
  installUpdate: () =>
    | Promise<AppUpdateCommandResult>
    | AppUpdateCommandResult | undefined;
  revealDownloadedUpdate: () => Promise<AppUpdateCommandResult> | undefined;
  getUpdateState: () => Promise<UpdateStateSnapshot | null | undefined> | undefined;
  getUpdaterLogInfo: () => Promise<UpdaterLogInfoResult | null | undefined> | undefined;
  revealUpdaterLog: () => Promise<RevealUpdaterLogResult> | undefined;
  onUpdateChecking: (
    callback: (snapshot: UpdateStateSnapshot) => void,
  ) => void | undefined;
  onUpdateAvailable: (callback: (info: UpdateAvailableInfo) => void) => void | undefined;
  onUpdateNotAvailable: (
    callback: (info: UpdateNotAvailableInfo) => void,
  ) => void | undefined;
  onUpdateDownloadProgress: (
    callback: (progress: UpdateProgressSnapshot) => void,
  ) => void | undefined;
  onUpdateDownloaded: (callback: (info: UpdateDownloadedInfo) => void) => void | undefined;
  onUpdateError: (callback: (error: UpdateErrorPayload) => void) => void | undefined;
  onAppUpdateEvent: (callback: (event: AppUpdateEvent) => void) => void | undefined;
  closeWindow: () => Promise<void> | undefined;
  // 窗口 chrome（spec docs/hub/window-chrome.md）：主题同步 overlay + 平台让位常量
  setTitleBarOverlay: ((color: string, symbolColor: string) => Promise<void>) | undefined;
  // 应用生效主题同步到主进程 nativeTheme.themeSource（原生标题栏/菜单/对话框跟随）
  setNativeThemeSource: ((theme: 'light' | 'dark') => Promise<void>) | undefined;
  // 聚焦主窗口并定位设置页子单元（首次指引随批修补，docs/hub/首次指引-design.md §4.4）
  focusHubSettings: ((sectionId: string) => Promise<{ ok: boolean }>) | undefined;
  // main → Hub renderer 的设置页锚点通知（Editor 触发聚焦后 Hub 侧接收）
  onHubFocusSettings: ((callback: (notice: { sectionId: string }) => void) => void) | undefined;
  removeHubFocusSettingsListener: (() => void) | undefined;
  platform: string | undefined;
  windowChromeInsets: WindowChromeInsets | undefined;
  storage: Record<string, (args: unknown | undefined) => Promise<unknown>> | undefined;
  packages: Record<string, (args: unknown | undefined) => Promise<unknown>> | undefined;
  getPathForFile: (file: File) => string | undefined;
  onTaskStateChanged: (callback: (message: unknown) => void) => void | undefined;
  onTaskStateSnapshot: (callback: (message: unknown) => void) => void | undefined;
  onMediaAssetsChanged: (callback: (message: unknown) => void) => void | undefined;
  removeTaskStateListeners: () => void | undefined;
  // Skill 商店 IPC（target 为安装目标 id：内置 agents/claude 或注册表自定义 id）
  getSkillInstalledState: (() => Promise<unknown>) | undefined;
  installSkill: ((bundleUrl: string, sha512: string, target: string, skillId: string) => Promise<unknown>) | undefined;
  // 定位 skill 安装目录（docs/editor/本地文件快捷跳转.md LFJ-007）
  revealSkillInstallFolder: ((skillId: string, target: string) => Promise<unknown>) | undefined;
  // 自定义安装目标注册表（Hub 弹层统一管理；目录来源为系统选择框 selectFolder）
  listCustomSkillInstallTargets: (() => Promise<unknown>) | undefined;
  addCustomSkillInstallTarget: ((name: string, dir: string) => Promise<unknown>) | undefined;
  updateCustomSkillInstallTarget: ((id: string, name: string) => Promise<unknown>) | undefined;
  removeCustomSkillInstallTarget: ((id: string) => Promise<unknown>) | undefined;
  // 打开 backend 业务日志目录（docs/editor/本地文件快捷跳转.md LFJ-008）
  revealBackendLogFolder: (() => Promise<unknown>) | undefined;
  // CLI 代理执行通道（spec docs/integrations/CLI与本地Agent集成.md §6.3）：
  // 主进程 → 画布窗口的命令请求订阅；画布窗口 → 主进程的命令响应回传。
  onCliProxyRequest: ((callback: (payload: unknown) => void) => void) | undefined;
  sendCliProxyResponse: ((payload: CliProxyCommandResponse) => void) | undefined;
  // CLI 设置页「命令行工具」子单元（spec §8）：只读状态查询与命令入口注册/卸除（幂等）
  getCliStatus: (() => Promise<CliStatusDto>) | undefined;
  registerCliEntry: (() => Promise<CliEntryOperationResult>) | undefined;
  unregisterCliEntry: (() => Promise<CliEntryOperationResult>) | undefined;
};

declare global {
  interface Window {
    electron: ElectronBridge | undefined;
  }
}
