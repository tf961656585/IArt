import { contextBridge, ipcRenderer, webUtils } from "electron";

type E2eEventPayload = Record<string, unknown>;

import {
  CLI_GET_STATUS_CHANNEL,
  CLI_PROXY_REQUEST_CHANNEL,
  CLI_PROXY_RESPONSE_CHANNEL,
  CLI_REGISTER_ENTRY_CHANNEL,
  CLI_UNREGISTER_ENTRY_CHANNEL,
  CLIPBOARD_IPC_CHANNELS,
  EDITOR_STORAGE_IPC_CHANNELS,
  LOG_DIAGNOSTICS_IPC_CHANNELS,
  PACKAGE_IPC_CHANNELS,
  REVEAL_IPC_CHANNELS,
  SKILL_IPC_CHANNELS,
  WINDOW_CHROME_INSETS,
  WINDOW_CHROME_IPC_CHANNELS,
} from "@iart/contracts";
import type {
  CliProxyCommandResponse,
  StorageClearNodeOutputParams,
  StorageCreateProjectParams,
  StorageCreatePromptPresetParams,
  StorageDeleteProjectParams,
  StorageDeletePromptPresetParams,
  StorageDiscardPendingParams,
  StorageExportBundleParams,
  StorageFlushParams,
  StorageGetCharacterPinsParams,
  StorageGetNodeTypeUsageParams,
  StorageGetPendingSnapshotParams,
  StorageGetProjectParams,
  StorageGetPromptPresetParams,
  StorageImportBundleAssetsParams,
  StorageImportBundleParams,
  StorageImportFolderParams,
  StorageImportLocalMediaParams,
  StorageOpenProjectParams,
  StoragePersistDeltaParams,
  StorageReadFileBytesParams,
  StorageReadAllMediaAssetsResult,
  StorageReadAllMediaAssetsParams,
  StorageReadAllTasksResult,
  StorageReadAllTasksParams,
  StorageReadMediaAssetByIdResult,
  StorageReadMediaAssetByIdParams,
  StorageReadMediaAssetsByTaskResult,
  StorageReadMediaAssetsByTaskParams,
  StorageReadTaskByIdResult,
  StorageReadTaskByIdParams,
  StorageReadTaskOutputsResult,
  StorageReadTaskOutputsParams,
  StorageRemoveOutputItemParams,
  StorageSaveCharacterPinsParams,
  StorageSaveDeltaParams,
  StorageTrackNodeTypeUsageParams,
  StorageUpdatePromptPresetParams,
  StorageUpsertMediaAssetParams,
  StorageWriteTempFileParams,
  StorageListSystemPromptsParams,
  StorageGetSystemPromptParams,
  StorageCreateSystemPromptParams,
  StorageUpdateSystemPromptParams,
  StorageDeleteSystemPromptParams,
  StorageReadPackageAreaByGraphIdParams,
  StorageReadAgentSessionsParams,
  StorageReadAgentSessionsResult,
  StorageReadAgentSessionByNodeIdParams,
  StorageReadAgentSessionByNodeIdResult,
  StorageUpsertAgentSessionParams,
  StorageUpsertAgentSessionResult,
  StorageReadAgentMessagesParams,
  StorageReadAgentMessagesResult,
  StorageAppendAgentMessageParams,
  StorageAppendAgentMessageResult,
  StorageAppendAgentSendRecordParams,
  StorageAppendAgentSendRecordResult,
  StorageReadAgentSendRecordsParams,
  StorageReadAgentSendRecordsResult,
  StorageReadAgentToolCallsParams,
  StorageReadAgentToolCallsResult,
  StorageAppendAgentToolCallParams,
  StorageAppendAgentToolCallResult,
  StorageUpdateAgentToolCallParams,
  StorageUpdateAgentToolCallResult,
  PackageAreaMutationRequest,
  PackagesListParams,
  PackagesCreateParams,
  PackagesRenameParams,
  PackagesDeleteParams,
  PackagesRevealParams,
} from "@iart/contracts";

const invokeStorage = <TArgs, TResult>(
  channel: string,
  args: TArgs,
): Promise<TResult> => ipcRenderer.invoke(channel, args) as Promise<TResult>;

type UpdateEventType =
  | "checking"
  | "available"
  | "not-available"
  | "download-progress"
  | "downloaded"
  | "error";
type UpdateEventPayload = { type: unknown | undefined; state: unknown | undefined };

let editorBootstrapPromise: Promise<unknown> | null = null;

const getEditorBootstrapFromMain = (): Promise<unknown> => {
  if (editorBootstrapPromise !== null) {
    return editorBootstrapPromise;
  }
  editorBootstrapPromise = ipcRenderer.invoke("get-editor-bootstrap");
  return editorBootstrapPromise;
};

void getEditorBootstrapFromMain();

const isUpdateEventOfType = (
  value: unknown,
  type: UpdateEventType,
): value is { type: UpdateEventType; state: unknown } => {
  if (!value || typeof value !== "object") return false;
  const event = value as UpdateEventPayload;
  return event.type === type && "state" in event;
};

contextBridge.exposeInMainWorld("electron", {
  getHubBootstrap: () => ipcRenderer.invoke("get-hub-bootstrap"),
  getEditorBootstrap: () => getEditorBootstrapFromMain(),
  getRuntimeFlags: () => ipcRenderer.invoke("get-runtime-flags"),
  reportDesktopE2EEvent: (payload: E2eEventPayload) =>
    ipcRenderer.invoke("report-desktop-e2e-event", payload),
  openEditorWindow: (target: string) =>
    ipcRenderer.invoke("open-editor-window", target),
  openExternal: (url: string) => ipcRenderer.invoke("open-external", url),
  openDevConsole: () => ipcRenderer.invoke("open-dev-console"),
  revealTaskArchive: (taskId: string, projectPath: string) =>
    ipcRenderer.invoke("reveal-task-archive", { taskId, projectPath }),
  revealFilesUrl: (url: string, projectPath: string) =>
    ipcRenderer.invoke("reveal-files-url", { url, projectPath }),
  revealProjectFolder: (projectPath: string) =>
    ipcRenderer.invoke(REVEAL_IPC_CHANNELS.REVEAL_PROJECT_FOLDER, { path: projectPath }),
  writeTextToClipboard: (text: string) =>
    ipcRenderer.invoke(CLIPBOARD_IPC_CHANNELS.WRITE_TEXT, { text }),
  writeImageFromUrlToClipboard: (url: string, projectPath: string | null) =>
    ipcRenderer.invoke(CLIPBOARD_IPC_CHANNELS.WRITE_IMAGE_FROM_URL, {
      url,
      projectPath,
    }),

  // ========== Skill 商店 API ==========
  // 查询已安装 skill 状态（扫描 ~/.agents/skills 与 ~/.claude/skills 及注册表自定义目标）
  getSkillInstalledState: () =>
    ipcRenderer.invoke(SKILL_IPC_CHANNELS.GET_INSTALLED_STATE),
  // 安装 skill 到指定目标目录（内置 targets: agents/claude；自定义 target 为注册表 id）
  installSkill: (
    bundleUrl: string,
    sha512: string,
    target: string,
    skillId: string,
  ) =>
    ipcRenderer.invoke(SKILL_IPC_CHANNELS.INSTALL, {
      bundleUrl,
      sha512,
      target,
      skillId,
    }),
  // 定位 skill 安装目录（docs/editor/本地文件快捷跳转.md LFJ-007）
  revealSkillInstallFolder: (skillId: string, target: string) =>
    ipcRenderer.invoke(SKILL_IPC_CHANNELS.REVEAL_INSTALL_FOLDER, { skillId, target }),
  // 自定义安装目标注册表（Hub 弹层统一管理；目录来源为系统选择框 selectFolder）
  listCustomSkillInstallTargets: () =>
    ipcRenderer.invoke(SKILL_IPC_CHANNELS.LIST_CUSTOM_TARGETS),
  addCustomSkillInstallTarget: (name: string, dir: string) =>
    ipcRenderer.invoke(SKILL_IPC_CHANNELS.ADD_CUSTOM_TARGET, { name, dir }),
  updateCustomSkillInstallTarget: (id: string, name: string, skillsDir: string) =>
    ipcRenderer.invoke(SKILL_IPC_CHANNELS.UPDATE_CUSTOM_TARGET, { id, name, skillsDir }),
  removeCustomSkillInstallTarget: (id: string) =>
    ipcRenderer.invoke(SKILL_IPC_CHANNELS.REMOVE_CUSTOM_TARGET, { id }),

  // ========== 自动更新 API ==========
  // 获取当前应用版本
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),
  // 检查更新
  checkForUpdates: (manual: boolean) => ipcRenderer.invoke("check-for-updates", manual),
  // 开始下载更新
  startUpdateDownload: () => ipcRenderer.invoke("start-update-download"),
  // 安装更新并重启
  installUpdate: () => ipcRenderer.invoke("install-update"),
  revealDownloadedUpdate: () => ipcRenderer.invoke("reveal-downloaded-update"),
  // 获取更新状态快照（用于刷新/重载后恢复 UI）
  getUpdateState: () => ipcRenderer.invoke("get-update-state"),
  // 获取更新日志信息（落盘路径等）
  getUpdaterLogInfo: () => ipcRenderer.invoke("get-updater-log-info"),
  // 在文件管理器中打开/选中更新日志文件
  revealUpdaterLog: () => ipcRenderer.invoke("reveal-updater-log"),
  // 打开 backend 业务日志目录（docs/editor/本地文件快捷跳转.md LFJ-008）
  revealBackendLogFolder: () =>
    ipcRenderer.invoke(LOG_DIAGNOSTICS_IPC_CHANNELS.REVEAL_BACKEND_LOG_FOLDER),

  // 监听更新事件
  onAppUpdateEvent: (callback: (event: unknown) => void) => {
    ipcRenderer.on(
      "app-update:event",
      (_event: Electron.IpcRendererEvent, payload: unknown) =>
        callback(payload),
    );
  },
  onUpdateChecking: (callback: (state: unknown) => void) => {
    ipcRenderer.on(
      "app-update:event",
      (_event: Electron.IpcRendererEvent, payload: unknown) => {
        if (isUpdateEventOfType(payload, "checking")) callback(payload.state);
      },
    );
  },
  onUpdateAvailable: (callback: (state: unknown) => void) => {
    ipcRenderer.on(
      "app-update:event",
      (_event: Electron.IpcRendererEvent, payload: unknown) => {
        if (isUpdateEventOfType(payload, "available")) callback(payload.state);
      },
    );
  },
  onUpdateNotAvailable: (callback: (state: unknown) => void) => {
    ipcRenderer.on(
      "app-update:event",
      (_event: Electron.IpcRendererEvent, payload: unknown) => {
        if (isUpdateEventOfType(payload, "not-available"))
          callback(payload.state);
      },
    );
  },
  onUpdateDownloadProgress: (callback: (state: unknown) => void) => {
    ipcRenderer.on(
      "app-update:event",
      (_event: Electron.IpcRendererEvent, payload: unknown) => {
        if (isUpdateEventOfType(payload, "download-progress"))
          callback(payload.state);
      },
    );
  },
  onUpdateDownloaded: (callback: (state: unknown) => void) => {
    ipcRenderer.on(
      "app-update:event",
      (_event: Electron.IpcRendererEvent, payload: unknown) => {
        if (isUpdateEventOfType(payload, "downloaded")) callback(payload.state);
      },
    );
  },
  onUpdateError: (callback: (state: unknown) => void) => {
    ipcRenderer.on(
      "app-update:event",
      (_event: Electron.IpcRendererEvent, payload: unknown) => {
        if (isUpdateEventOfType(payload, "error")) callback(payload.state);
      },
    );
  },
  // 移除更新事件监听
  removeUpdateListeners: () => {
    ipcRenderer.removeAllListeners("app-update:event");
  },

  // ========== Task State Notification IPC ==========
  onTaskStateChanged: (callback: (message: unknown) => void) => {
    ipcRenderer.on(
      "task:state-changed",
      (_event: Electron.IpcRendererEvent, message: unknown) =>
        callback(message),
    );
  },
  onTaskStateSnapshot: (callback: (message: unknown) => void) => {
    ipcRenderer.on(
      "task:state-snapshot",
      (_event: Electron.IpcRendererEvent, message: unknown) =>
        callback(message),
    );
  },
  onMediaAssetsChanged: (callback: (message: unknown) => void) => {
    ipcRenderer.on(
      "media-assets:changed",
      (_event: Electron.IpcRendererEvent, message: unknown) =>
        callback(message),
    );
  },
  removeTaskStateListeners: () => {
    ipcRenderer.removeAllListeners("task:state-changed");
    ipcRenderer.removeAllListeners("task:state-snapshot");
    ipcRenderer.removeAllListeners("media-assets:changed");
  },

  // ========== CLI 代理执行通道（spec docs/integrations/CLI与本地Agent集成.md §6.3） ==========
  // 主进程 → 画布窗口的命令请求订阅：载荷原样透传，schema 校验由渲染层消费端负责
  //（沿 onTaskStateChanged 的既有惯例：preload 不 parse）。
  onCliProxyRequest: (callback: (payload: unknown) => void) => {
    ipcRenderer.on(
      CLI_PROXY_REQUEST_CHANNEL,
      (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload),
    );
  },
  // 画布窗口 → 主进程的命令响应回传：载荷由渲染层构造并经 CliProxyCommandResponseSchema
  // 校验后传入，preload 只负责按登记通道发送。
  sendCliProxyResponse: (payload: CliProxyCommandResponse) => {
    ipcRenderer.send(CLI_PROXY_RESPONSE_CHANNEL, payload);
  },

  // ========== CLI 设置页「命令行工具」子单元（spec docs/integrations/CLI与本地Agent集成.md §8） ==========
  // 只读状态查询（在役状态/发现文件有效性/入口注册状态/最近命令记录）
  getCliStatus: () => ipcRenderer.invoke(CLI_GET_STATUS_CHANNEL),
  // 命令入口一键注册（幂等，CLI-016）
  registerCliEntry: () => ipcRenderer.invoke(CLI_REGISTER_ENTRY_CHANNEL),
  // 命令入口卸除注册（仅删除本应用 shim，CLI-016）
  unregisterCliEntry: () => ipcRenderer.invoke(CLI_UNREGISTER_ENTRY_CHANNEL),

  // ========== 文件路径工具 API ==========
  getPathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },

  // ========== 文件夹选择 API ==========
  // 选择文件夹（用于创建新项目时选择保存位置）；
  // showHiddenFiles 为可选扩展（默认关）：为 true 时主进程在系统选择框 properties 追加
  // 'showHiddenFiles'（Skill 安装目录等需要选到隐藏文件夹的场景），不传则行为不变。
  selectFolder: (options: (Electron.OpenDialogOptions & { showHiddenFiles?: boolean }) | undefined) =>
    ipcRenderer.invoke("select-folder", options),
  // 选择项目文件夹（用于打开现有项目）；不开放 showHiddenFiles 扩展
  selectProjectFolder: (options: Electron.OpenDialogOptions | undefined) =>
    ipcRenderer.invoke("select-project-folder", options),

  // ========== 项目路径管理 API ==========
  // 获取当前项目路径（由 hub 管理）
  getCurrentProjectPath: () => ipcRenderer.invoke("get-current-project-path"),
  // 设置当前项目路径（由 hub 管理）
  setCurrentProjectPath: (path: string) =>
    ipcRenderer.invoke("set-current-project-path", path),

  // ========== Window lifecycle bridge ==========
  closeWindow: () => ipcRenderer.invoke("window-close"),
  // 窗口 chrome（spec docs/hub/window-chrome.md）：主题同步 overlay + 平台/让位常量
  setTitleBarOverlay: (color: string, symbolColor: string) =>
    ipcRenderer.invoke(WINDOW_CHROME_IPC_CHANNELS.SET_TITLE_BAR_OVERLAY, { color, symbolColor }),
  // 应用主题偏好直写到主进程 nativeTheme.themeSource（原生标题栏/菜单/对话框跟随）；
  // system 直写不解析（spec docs/hub/window-chrome.md §7.5）
  setNativeThemeSource: (theme: 'light' | 'dark' | 'system') =>
    ipcRenderer.invoke(WINDOW_CHROME_IPC_CHANNELS.SET_NATIVE_THEME_SOURCE, { theme }),
  // 聚焦主窗口并定位设置页子单元（首次指引随批修补，docs/hub/首次指引-design.md §4.4）；
  // Editor 拦截/空态文案的可点击动作经此触发
  focusHubSettings: (sectionId: string) =>
    ipcRenderer.invoke(WINDOW_CHROME_IPC_CHANNELS.FOCUS_HUB_SETTINGS, { sectionId }),
  onHubFocusSettings: (callback: (notice: { sectionId: string }) => void) => {
    ipcRenderer.on("hub:focus-settings", (_event, notice) => callback(notice));
  },
  removeHubFocusSettingsListener: () => {
    ipcRenderer.removeAllListeners("hub:focus-settings");
  },
  platform: process.platform,
  windowChromeInsets: WINDOW_CHROME_INSETS,

  // ========== Editor Close Protocol ==========
  onPrepareClose: (callback: () => void) => {
    ipcRenderer.on("editor:prepare-close", () => callback());
  },
  removePrepareCloseListener: () => {
    ipcRenderer.removeAllListeners("editor:prepare-close");
  },
  sendCloseReady: () => {
    ipcRenderer.send("editor:close-ready");
  },
  sendCloseError: (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    ipcRenderer.send("editor:close-error", { message });
  },

  // ========== Editor Storage API ==========
  storage: {
    "storage:list-projects": () => ipcRenderer.invoke("storage:list-projects"),
    "storage:create-project": (args: StorageCreateProjectParams) =>
      invokeStorage("storage:create-project", args),
    "storage:open-project": (args: StorageOpenProjectParams) =>
      invokeStorage("storage:open-project", args),
    "storage:get-project": (args: StorageGetProjectParams) =>
      invokeStorage("storage:get-project", args),
    "storage:delete-project": (args: StorageDeleteProjectParams) =>
      invokeStorage("storage:delete-project", args),
    "storage:get-meta-index": () =>
      ipcRenderer.invoke("storage:get-meta-index"),
    "storage:import-folder": (args: StorageImportFolderParams) =>
      invokeStorage("storage:import-folder", args),
    "storage:save-delta": (args: StorageSaveDeltaParams) =>
      invokeStorage("storage:save-delta", args),
    "storage:persist-delta": (args: StoragePersistDeltaParams) =>
      invokeStorage("storage:persist-delta", args),
    "storage:flush": (args: StorageFlushParams) =>
      invokeStorage("storage:flush", args),
    "storage:discard-pending": (args: StorageDiscardPendingParams) =>
      invokeStorage("storage:discard-pending", args),
    "storage:get-pending-snapshot": (args: StorageGetPendingSnapshotParams) =>
      invokeStorage("storage:get-pending-snapshot", args),
    "storage:upsert-media-asset": (args: StorageUpsertMediaAssetParams) =>
      invokeStorage("storage:upsert-media-asset", args),
    "storage:import-bundle-assets": (args: StorageImportBundleAssetsParams) =>
      invokeStorage("storage:import-bundle-assets", args),
    "storage:get-node-type-usage": (args: StorageGetNodeTypeUsageParams) =>
      invokeStorage("storage:get-node-type-usage", args),
    "storage:track-node-type-usage": (args: StorageTrackNodeTypeUsageParams) =>
      invokeStorage("storage:track-node-type-usage", args),
    "storage:get-character-pins": (args: StorageGetCharacterPinsParams) =>
      invokeStorage("storage:get-character-pins", args),
    "storage:save-character-pins": (args: StorageSaveCharacterPinsParams) =>
      invokeStorage("storage:save-character-pins", args),
    "storage:export-bundle": (args: StorageExportBundleParams) =>
      invokeStorage("storage:export-bundle", args),
    "storage:import-bundle": (args: StorageImportBundleParams) =>
      invokeStorage("storage:import-bundle", args),
    "storage:read-file-bytes": (args: StorageReadFileBytesParams) =>
      invokeStorage("storage:read-file-bytes", args),
    "storage:write-temp-file": (args: StorageWriteTempFileParams) =>
      invokeStorage("storage:write-temp-file", args),
    "storage:clear-node-output": (args: StorageClearNodeOutputParams) =>
      invokeStorage("storage:clear-node-output", args),
    "storage:remove-output-item": (args: StorageRemoveOutputItemParams) =>
      invokeStorage("storage:remove-output-item", args),
    "storage:read-task-by-id": (
      args: StorageReadTaskByIdParams,
    ): Promise<StorageReadTaskByIdResult> =>
      invokeStorage(EDITOR_STORAGE_IPC_CHANNELS.READ_TASK_BY_ID, args),
    "storage:read-task-outputs": (
      args: StorageReadTaskOutputsParams,
    ): Promise<StorageReadTaskOutputsResult> =>
      invokeStorage(EDITOR_STORAGE_IPC_CHANNELS.READ_TASK_OUTPUTS, args),
    "storage:read-media-assets-by-task": (
      args: StorageReadMediaAssetsByTaskParams,
    ): Promise<StorageReadMediaAssetsByTaskResult> =>
      invokeStorage(EDITOR_STORAGE_IPC_CHANNELS.READ_MEDIA_ASSETS_BY_TASK, args),
    "storage:read-all-tasks": (
      args: StorageReadAllTasksParams,
    ): Promise<StorageReadAllTasksResult> =>
      invokeStorage(EDITOR_STORAGE_IPC_CHANNELS.READ_ALL_TASKS, args),
    "storage:read-all-media-assets": (
      args: StorageReadAllMediaAssetsParams,
    ): Promise<StorageReadAllMediaAssetsResult> =>
      invokeStorage(EDITOR_STORAGE_IPC_CHANNELS.READ_ALL_MEDIA_ASSETS, args),
    "storage:read-media-asset-by-id": (
      args: StorageReadMediaAssetByIdParams,
    ): Promise<StorageReadMediaAssetByIdResult> =>
      invokeStorage(EDITOR_STORAGE_IPC_CHANNELS.READ_MEDIA_ASSET_BY_ID, args),
    "storage:get-cache-statistics": () =>
      ipcRenderer.invoke("storage:get-cache-statistics"),
    "storage:list-prompt-presets": () =>
      ipcRenderer.invoke("storage:list-prompt-presets"),
    "storage:get-prompt-preset": (args: StorageGetPromptPresetParams) =>
      invokeStorage("storage:get-prompt-preset", args),
    "storage:create-prompt-preset": (args: StorageCreatePromptPresetParams) =>
      invokeStorage("storage:create-prompt-preset", args),
    "storage:update-prompt-preset": (args: StorageUpdatePromptPresetParams) =>
      invokeStorage("storage:update-prompt-preset", args),
    "storage:delete-prompt-preset": (args: StorageDeletePromptPresetParams) =>
      invokeStorage("storage:delete-prompt-preset", args),
    "storage:import-local-media": (args: StorageImportLocalMediaParams) =>
      invokeStorage("storage:import-local-media", args),

    // N 组：系统提示词库
    "storage:list-system-prompts": (args: StorageListSystemPromptsParams) =>
      invokeStorage("storage:list-system-prompts", args),
    "storage:get-system-prompt": (args: StorageGetSystemPromptParams) =>
      invokeStorage("storage:get-system-prompt", args),
    "storage:create-system-prompt": (args: StorageCreateSystemPromptParams) =>
      invokeStorage("storage:create-system-prompt", args),
    "storage:update-system-prompt": (args: StorageUpdateSystemPromptParams) =>
      invokeStorage("storage:update-system-prompt", args),
    "storage:delete-system-prompt": (args: StorageDeleteSystemPromptParams) =>
      invokeStorage("storage:delete-system-prompt", args),

    // O 组：打包区（画布级素材归集工作区）
    [EDITOR_STORAGE_IPC_CHANNELS.READ_PACKAGE_AREA_BY_GRAPH_ID]: (args: StorageReadPackageAreaByGraphIdParams) =>
      invokeStorage(EDITOR_STORAGE_IPC_CHANNELS.READ_PACKAGE_AREA_BY_GRAPH_ID, args),
    [EDITOR_STORAGE_IPC_CHANNELS.APPLY_PACKAGE_AREA_MUTATION]: (args: PackageAreaMutationRequest) =>
      invokeStorage(EDITOR_STORAGE_IPC_CHANNELS.APPLY_PACKAGE_AREA_MUTATION, args),

    // P 组：agent 会话
    [EDITOR_STORAGE_IPC_CHANNELS.READ_AGENT_SESSIONS]: (
      args: StorageReadAgentSessionsParams,
    ): Promise<StorageReadAgentSessionsResult> =>
      invokeStorage(EDITOR_STORAGE_IPC_CHANNELS.READ_AGENT_SESSIONS, args),
    [EDITOR_STORAGE_IPC_CHANNELS.READ_AGENT_SESSION_BY_NODE_ID]: (
      args: StorageReadAgentSessionByNodeIdParams,
    ): Promise<StorageReadAgentSessionByNodeIdResult> =>
      invokeStorage(EDITOR_STORAGE_IPC_CHANNELS.READ_AGENT_SESSION_BY_NODE_ID, args),
    [EDITOR_STORAGE_IPC_CHANNELS.UPSERT_AGENT_SESSION]: (
      args: StorageUpsertAgentSessionParams,
    ): Promise<StorageUpsertAgentSessionResult> =>
      invokeStorage(EDITOR_STORAGE_IPC_CHANNELS.UPSERT_AGENT_SESSION, args),
    [EDITOR_STORAGE_IPC_CHANNELS.READ_AGENT_MESSAGES]: (
      args: StorageReadAgentMessagesParams,
    ): Promise<StorageReadAgentMessagesResult> =>
      invokeStorage(EDITOR_STORAGE_IPC_CHANNELS.READ_AGENT_MESSAGES, args),
    [EDITOR_STORAGE_IPC_CHANNELS.APPEND_AGENT_MESSAGE]: (
      args: StorageAppendAgentMessageParams,
    ): Promise<StorageAppendAgentMessageResult> =>
      invokeStorage(EDITOR_STORAGE_IPC_CHANNELS.APPEND_AGENT_MESSAGE, args),
    [EDITOR_STORAGE_IPC_CHANNELS.APPEND_AGENT_SEND_RECORD]: (
      args: StorageAppendAgentSendRecordParams,
    ): Promise<StorageAppendAgentSendRecordResult> =>
      invokeStorage(EDITOR_STORAGE_IPC_CHANNELS.APPEND_AGENT_SEND_RECORD, args),
    [EDITOR_STORAGE_IPC_CHANNELS.READ_AGENT_SEND_RECORDS]: (
      args: StorageReadAgentSendRecordsParams,
    ): Promise<StorageReadAgentSendRecordsResult> =>
      invokeStorage(EDITOR_STORAGE_IPC_CHANNELS.READ_AGENT_SEND_RECORDS, args),
    [EDITOR_STORAGE_IPC_CHANNELS.READ_AGENT_TOOL_CALLS]: (
      args: StorageReadAgentToolCallsParams,
    ): Promise<StorageReadAgentToolCallsResult> =>
      invokeStorage(EDITOR_STORAGE_IPC_CHANNELS.READ_AGENT_TOOL_CALLS, args),
    [EDITOR_STORAGE_IPC_CHANNELS.APPEND_AGENT_TOOL_CALL]: (
      args: StorageAppendAgentToolCallParams,
    ): Promise<StorageAppendAgentToolCallResult> =>
      invokeStorage(EDITOR_STORAGE_IPC_CHANNELS.APPEND_AGENT_TOOL_CALL, args),
    [EDITOR_STORAGE_IPC_CHANNELS.UPDATE_AGENT_TOOL_CALL]: (
      args: StorageUpdateAgentToolCallParams,
    ): Promise<StorageUpdateAgentToolCallResult> =>
      invokeStorage(EDITOR_STORAGE_IPC_CHANNELS.UPDATE_AGENT_TOOL_CALL, args),
  },

  // ========== 包管理（执行打包产物：项目路径 packages/ 下的自描述包文件夹） ==========
  packages: {
    [PACKAGE_IPC_CHANNELS.LIST_PACKAGES]: (args: PackagesListParams) =>
      ipcRenderer.invoke(PACKAGE_IPC_CHANNELS.LIST_PACKAGES, args),
    [PACKAGE_IPC_CHANNELS.CREATE_PACKAGE]: (args: PackagesCreateParams) =>
      ipcRenderer.invoke(PACKAGE_IPC_CHANNELS.CREATE_PACKAGE, args),
    [PACKAGE_IPC_CHANNELS.RENAME_PACKAGE]: (args: PackagesRenameParams) =>
      ipcRenderer.invoke(PACKAGE_IPC_CHANNELS.RENAME_PACKAGE, args),
    [PACKAGE_IPC_CHANNELS.DELETE_PACKAGE]: (args: PackagesDeleteParams) =>
      ipcRenderer.invoke(PACKAGE_IPC_CHANNELS.DELETE_PACKAGE, args),
    [PACKAGE_IPC_CHANNELS.REVEAL_PACKAGE]: (args: PackagesRevealParams) =>
      ipcRenderer.invoke(PACKAGE_IPC_CHANNELS.REVEAL_PACKAGE, args),
  },
});
