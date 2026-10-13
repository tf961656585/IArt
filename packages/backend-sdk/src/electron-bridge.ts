export * from "./electron-bridge/types";
export {
  writeImageFromUrlToClipboard,
  writeTextToClipboard,
} from "./electron-bridge/clipboard";
export {
  revealFilesUrl,
  revealProjectFolder,
  revealTaskArchive,
} from "./electron-bridge/reveal";

import {
  AppUpdateCommandResultSchema,
  AppUpdateStateSchema,
  HubDesktopBootstrapSchema,
} from "@iart/contracts";
import { SELECT_FOLDER_ERROR_CODES } from "./electron-bridge/types";
import { normalizeOpenEditorWindowResult } from "./electron-bridge/open-editor-window";
import type {
  CheckForUpdatesResult,
  EditorDesktopBootstrap,
  ElectronBridge,
  ElectronRuntimeFlags,
  HubDesktopBootstrap,
  OpenDevConsoleResult,
  OpenEditorWindowRequest,
  OpenEditorWindowResult,
  SelectFolderErrorCode,
  SelectFolderOptions,
  SelectFolderResult,
} from "./electron-bridge/types";

const isString = (value: unknown): value is string => typeof value === "string";

const getBrowserElectronBridge = (): ElectronBridge | null => {
  if (typeof window === "undefined") {
    return null;
  }
  return window.electron ?? null;
};
const buildSelectFolderErrorResult = (
  errorCode: SelectFolderErrorCode,
  userMessage: string,
  debugMessage: string | null = null,
): SelectFolderResult => ({
  status: "error",
  path: null,
  errorCode,
  userMessage,
  debugMessage,
});

const isValidSelectFolderResult = (
  value: unknown,
): value is SelectFolderResult => {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<SelectFolderResult>;
  if (result.status === "success") {
    return typeof result.path === "string" && result.path.trim().length > 0;
  }
  if (result.status === "canceled") {
    return result.path === null;
  }
  if (result.status === "error") {
    return (
      result.path === null &&
      typeof result.errorCode === "string" &&
      typeof result.userMessage === "string"
    );
  }
  return false;
};
export const isElectronEnvironment = (): boolean => {
  return typeof window !== "undefined" && Boolean(window.electron);
};

export const fetchRuntimeFlagsFromElectron =
  async (): Promise<ElectronRuntimeFlags | null> => {
    const api = getBrowserElectronBridge();
    if (!api || typeof api.getRuntimeFlags !== "function") {
      return null;
    }

    try {
      const result = await api.getRuntimeFlags();
      if (!result || typeof result !== "object") {
        return null;
      }
      const flags = result as ElectronRuntimeFlags;
      return { isPackaged: Boolean(flags.isPackaged) };
    } catch (error) {
      console.warn(
        "fetchRuntimeFlagsFromElectron: failed to fetch runtime flags",
        error,
      );
      return null;
  }
};
export const fetchHubBootstrapFromElectron =
  async (): Promise<HubDesktopBootstrap | null> => {
    const api = getBrowserElectronBridge();
    if (!api || typeof api.getHubBootstrap !== "function") {
      return null;
    }

    try {
      const result = await api.getHubBootstrap();
      const parsed = HubDesktopBootstrapSchema.safeParse(result);
      return parsed.success ? parsed.data : null;
    } catch (error) {
      console.warn(
        "fetchHubBootstrapFromElectron: failed to fetch hub bootstrap",
        error,
      );
      return null;
    }
  };

const isValidEditorDesktopBootstrap = (
  value: unknown,
): value is EditorDesktopBootstrap => {
  if (!value || typeof value !== "object") return false;
  const bootstrap = value as Partial<EditorDesktopBootstrap>;
  if (bootstrap.runtime !== "desktop") return false;
  if (!isString(bootstrap.backendBaseUrl) || !bootstrap.backendBaseUrl.trim())
    return false;
  if (bootstrap.projectPath !== null && !isString(bootstrap.projectPath))
    return false;
  if (bootstrap.projectRef !== null && !isString(bootstrap.projectRef))
    return false;
  if (bootstrap.sessionToken !== null && !isString(bootstrap.sessionToken))
    return false;
  if (!isString(bootstrap.locale) || !bootstrap.locale.trim()) return false;
  if (!bootstrap.windowContext || typeof bootstrap.windowContext !== "object")
    return false;
  const windowContext = bootstrap.windowContext as Partial<
    EditorDesktopBootstrap["windowContext"]
  >;
  if (windowContext.entry !== "editor") return false;
  return true;
};

export const fetchEditorBootstrapFromElectron =
  async (): Promise<EditorDesktopBootstrap | null> => {
    const api = getBrowserElectronBridge();
    if (!api || typeof api.getEditorBootstrap !== "function") {
      console.warn(
        "[editor:bridge] getEditorBootstrap unavailable, no electron bridge API",
      );
      return null;
    }

    try {
      const __t0 = Date.now();
      console.info("[editor:bridge] getEditorBootstrap invoke start");
      const result = await api.getEditorBootstrap();
      const valid = isValidEditorDesktopBootstrap(result);
      console.info("[editor:bridge] getEditorBootstrap invoke done", {
        elapsed: Date.now() - __t0,
        valid,
      });
      return valid ? result : null;
    } catch (error) {
      console.error("[editor:bridge] getEditorBootstrap invoke failed", {
        error,
      });
      return null;
    }
  };

export const fetchAppVersionFromElectron = async (): Promise<string | null> => {
  const api = getBrowserElectronBridge();
  if (!api || typeof api.getAppVersion !== "function") {
    return null;
  }

  try {
    const result = await api.getAppVersion();
    const trimmed = isString(result) ? result.trim() : "";
    return trimmed ? trimmed : null;
  } catch (error) {
    console.warn(
      "fetchAppVersionFromElectron: failed to fetch app version",
      error,
    );
    return null;
  }
};

export const openExternal = async (target: string): Promise<boolean> => {
  const api = getBrowserElectronBridge();
  if (!api || typeof api.openExternal !== "function") {
    return false;
  }

  try {
    const result = await api.openExternal(target);
    if (typeof result === "boolean") {
      return result;
    }
    return Boolean(
      result && typeof result === "object" && "ok" in result
        ? result.ok
        : false,
    );
  } catch (error) {
    console.warn("openExternal: failed to open external target", error);
    return false;
  }
};

const isValidOpenEditorWindowRequest = (
  value: unknown,
): value is OpenEditorWindowRequest => {
  if (!value || typeof value !== "object") return false;
  const target = value as Partial<OpenEditorWindowRequest>;
  if (!isString(target.projectPath) || !target.projectPath.trim()) {
    return false;
  }
  if (!isString(target.sessionToken) || !target.sessionToken.trim()) {
    return false;
  }
  return true;
};

export const openEditorWindow = async (
  target: OpenEditorWindowRequest,
): Promise<OpenEditorWindowResult> => {
  const api = getBrowserElectronBridge();
  if (
    !api ||
    typeof api.openEditorWindow !== "function" ||
    !isValidOpenEditorWindowRequest(target)
  ) {
    return {
      ok: false,
      code: "invalid-editor-window-target",
      message: "open-editor-window request invalid",
      projectPath: isString(target.projectPath) ? target.projectPath : null,
    };
  }

  try {
    const result = await api.openEditorWindow({
      projectPath: target.projectPath.trim(),
      sessionToken: target.sessionToken.trim(),
    });
    return normalizeOpenEditorWindowResult(result, target.projectPath.trim());
  } catch (error) {
    console.warn("openEditorWindow: failed to open editor window", error);
    return {
      ok: false,
      code: "open-editor-window-failed",
      message: error instanceof Error ? error.message : "invoke-failed",
      projectPath: target.projectPath.trim(),
    };
  }
};

export const openDevConsoleFromElectron =
  async (): Promise<OpenDevConsoleResult> => {
    const api = getBrowserElectronBridge();
    if (!api || typeof api.openDevConsole !== "function") {
      return { ok: false, reason: "not-in-electron" };
    }

    try {
      const result = await api.openDevConsole();
      if (
        !result ||
        typeof result !== "object" ||
        typeof result.ok !== "boolean"
      ) {
        return { ok: false, reason: "invalid-response" };
      }
      return {
        ok: result.ok,
        reason: isString(result.reason) ? result.reason : undefined,
      };
    } catch (error) {
      console.warn(
        "openDevConsoleFromElectron: failed to open DevConsole",
        error,
      );
      return { ok: false, reason: "invoke-failed" };
    }
  };

export const checkForUpdates = async (manual: boolean): Promise<CheckForUpdatesResult> => {
  const api = getBrowserElectronBridge();
  if (!api || typeof api.checkForUpdates !== "function") {
    return AppUpdateCommandResultSchema.parse({
      status: "failed",
      error: { message: "not-in-electron" },
      state: AppUpdateStateSchema.parse({
        status: "idle",
        appVersion: "unknown",
        channel: "stable",
        platform: "linux",
        arch: "x64",
        lastCheckedAt: null,
        logPath: null,
      }),
    });
  }

  try {
    const result = await api.checkForUpdates(manual);
    return AppUpdateCommandResultSchema.parse(result);
  } catch (error) {
    console.warn("checkForUpdates: failed to check updates", error);
    return AppUpdateCommandResultSchema.parse({
      status: "failed",
      error: {
        message: error instanceof Error ? error.message : "invoke-failed",
      },
      state: AppUpdateStateSchema.parse({
        status: "idle",
        appVersion: "unknown",
        channel: "stable",
        platform: "linux",
        arch: "x64",
        lastCheckedAt: null,
        logPath: null,
      }),
    });
  }
};

export const selectFolder = async (
  options: SelectFolderOptions | undefined,
): Promise<SelectFolderResult> => {
  const api = getBrowserElectronBridge();
  if (
    typeof window === "undefined" ||
    !api ||
    typeof api.selectFolder !== "function"
  ) {
    return buildSelectFolderErrorResult(
      SELECT_FOLDER_ERROR_CODES.ENVIRONMENT_UNAVAILABLE,
      "请在桌面应用中选择保存位置",
    );
  }

  try {
    const result = await api.selectFolder(options);
    if (isValidSelectFolderResult(result)) {
      return result;
    }
    return buildSelectFolderErrorResult(
      SELECT_FOLDER_ERROR_CODES.INVALID_RESPONSE,
      "文件夹选择结果无效，请重试",
    );
  } catch (error) {
    console.warn("selectFolder: failed to select folder", error);
    return buildSelectFolderErrorResult(
      SELECT_FOLDER_ERROR_CODES.INVOKE_FAILED,
      "无法打开文件夹选择窗口，请重试",
      error instanceof Error ? error.message : null,
    );
  }
};

export const selectProjectFolder = async (
  options: SelectFolderOptions | undefined,
): Promise<SelectFolderResult> => {
  const api = getBrowserElectronBridge();
  if (
    typeof window === "undefined" ||
    !api ||
    typeof api.selectProjectFolder !== "function"
  ) {
    return buildSelectFolderErrorResult(
      SELECT_FOLDER_ERROR_CODES.ENVIRONMENT_UNAVAILABLE,
      "请在桌面应用中打开项目文件夹",
    );
  }

  try {
    const result = await api.selectProjectFolder(options);
    if (isValidSelectFolderResult(result)) {
      return result;
    }
    return buildSelectFolderErrorResult(
      SELECT_FOLDER_ERROR_CODES.INVALID_RESPONSE,
      "项目文件夹选择结果无效，请重试",
    );
  } catch (error) {
    console.warn("selectProjectFolder: failed to select project folder", error);
    return buildSelectFolderErrorResult(
      SELECT_FOLDER_ERROR_CODES.INVOKE_FAILED,
      "项目文件夹选择器调用失败，请重试",
      error instanceof Error ? error.message : null,
    );
  }
};

export const getCurrentProjectPathFromElectron = async (): Promise<
  string | null
> => {
  const api = getBrowserElectronBridge();
  if (!api || typeof api.getCurrentProjectPath !== "function") {
    return null;
  }

  try {
    const result = await api.getCurrentProjectPath();
    const trimmed = isString(result) ? result.trim() : "";
    return trimmed ? trimmed : null;
  } catch (error) {
    console.warn(
      "getCurrentProjectPath: failed to get current project path",
      error,
    );
    return null;
  }
};

export const setCurrentProjectPathToElectron = async (
  path: string | null,
): Promise<void> => {
  const api = getBrowserElectronBridge();
  if (!api || typeof api.setCurrentProjectPath !== "function") {
    return;
  }

  try {
    await api.setCurrentProjectPath(path);
  } catch (error) {
    console.warn(
      "setCurrentProjectPath: failed to set current project path",
      error,
    );
  }
};
