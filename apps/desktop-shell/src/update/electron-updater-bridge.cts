import { app, shell, type BrowserWindow } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  AppUpdateCommandResultSchema,
  AppUpdateEventSchema,
  AppUpdateStateSchema,
  type AppUpdateCommandResult,
  type AppUpdateEvent,
  type AppUpdateFile,
  type AppUpdateProgress,
  type AppUpdateState,
} from "@iart/contracts";
import { autoUpdater, type ProgressInfo, type UpdateInfo } from "electron-updater";
import { nodeRequire, ROOT_DIR, toErrorMessage } from "../desktop-shell-utils.cjs";
import { appendUpdaterLog, getUpdaterLogPath } from "./app-update-log.cjs";
import { clearPendingUpdate, readPendingUpdate, writePendingUpdate } from "./app-update-pending.cjs";
import {
  availableState,
  checkingState,
  createUpdateStateStore,
  downloadedState,
  downloadingState,
  errorState,
  notAvailableState,
  type UpdateStateStore,
} from "./app-update-state.cjs";
import {
  compareVersions,
  isSupportedUpdateTarget,
  resolveCurrentAppVersion,
  resolveUpdateArch,
  resolveUpdateChannel,
  resolveUpdatePlatform,
} from "./app-update-runtime.cjs";

export type UpdaterController = {
  setupAutoUpdater: () => void;
  scheduleStartupCheck: () => void;
  checkForUpdates: (manual: boolean | undefined) => Promise<AppUpdateCommandResult>;
  startDownload: () => Promise<AppUpdateCommandResult>;
  installUpdate: () => AppUpdateCommandResult;
  buildUpdateStateSnapshot: () => AppUpdateState;
  getUpdaterLogInfo: () => Promise<object>;
  revealUpdaterLog: () => Promise<object>;
  revealDownloadedUpdate: () => Promise<AppUpdateCommandResult>;
  getAppVersion: () => string;
};

const AUTO_CHECK_INTERVAL_MS = 30 * 60 * 1000;
const MANUAL_CHECK_INTERVAL_MS = 2 * 60 * 1000;

type PackageJsonFields = {
  build: { publish: unknown | undefined } | undefined;
};

// electron-builder 打包时会从产物 package.json 剥离 build 字段，
// 但会把 build.publish 生成到 Resources/app-update.yml；
// 因此打包后从 app-update.yml 读取，dev 模式读仓库根 package.json。
// electron-updater 打包态读取的是同一份 app-update.yml，此处解析仅用于门禁与诊断日志。
export const resolveUpdatePublishUrl = (): string => {
  if (app.isPackaged) {
    return readPublishUrlFromAppUpdateYml();
  }
  return readPublishUrlFromPackageJson();
};

const readPublishUrlFromAppUpdateYml = (): string => {
  try {
    const ymlPath = path.join(process.resourcesPath, "app-update.yml");
    const content = fs.readFileSync(ymlPath, "utf8");
    const match = /^url:\s*(\S+)\s*$/m.exec(content);
    return match?.[1]?.trim() ?? "";
  } catch {
    return "";
  }
};

const readPublishUrlFromPackageJson = (): string => {
  try {
    const pkg = nodeRequire(path.join(ROOT_DIR, "package.json")) as PackageJsonFields;
    const publish = (pkg.build !== null && pkg.build !== undefined ? pkg.build.publish : undefined);
    const entry: unknown = Array.isArray(publish) ? publish[0] : publish;
    return typeof entry === "object" && entry !== null && "url" in entry
      ? String((entry as { url: unknown | undefined }).url || "").trim()
      : "";
  } catch {
    return "";
  }
};

// electron-updater 事件里的 file.url 可能是相对文件名，也可能是已解析的完整 URL。
const baseNameFromUrl = (url: string): string => {
  const withoutQuery = url.split(/[?#]/, 1)[0] ?? url;
  const segments = withoutQuery.split("/");
  return segments[segments.length - 1] || url;
};

const normalizeReleaseDate = (releaseDate: UpdateInfo["releaseDate"]): string | null =>
  typeof releaseDate === "string" && releaseDate ? releaseDate : null;

const normalizeReleaseNotes = (notes: UpdateInfo["releaseNotes"]): string | null =>
  typeof notes === "string" && notes.trim() ? notes : null;

const toAppUpdateFiles = (info: UpdateInfo): AppUpdateFile[] =>
  info.files.map((file) => {
    const name = baseNameFromUrl(file.url);
    const sha512 = typeof file.sha512 === "string" && file.sha512 ? file.sha512 : (info.sha512 || "unknown");
    const size = typeof file.size === "number" && Number.isFinite(file.size) && file.size >= 0 ? file.size : 0;
    return {
      platform: resolveUpdatePlatform(),
      arch: resolveUpdateArch(),
      kind: "installer" as const,
      name,
      path: name,
      r2Key: name,
      sha512,
      size,
      ...(typeof file.url === "string" && file.url ? { url: file.url } : {}),
    };
  });

const progressFromDownload = (progress: ProgressInfo): AppUpdateProgress => ({
  percent: Math.min(progress.percent, 100),
  bytesPerSecond: progress.bytesPerSecond,
  transferred: progress.transferred,
  total: progress.total,
});

const pickInstallerPath = (downloadedPaths: readonly string[]): string | null => {
  const platform = resolveUpdatePlatform();
  if (platform === "darwin") {
    const dmg = downloadedPaths.find((candidate) => candidate.endsWith(".dmg"));
    if (dmg) return dmg;
    const zip = downloadedPaths.find((candidate) => candidate.endsWith(".zip"));
    if (zip) return zip;
  }
  if (platform === "win32") {
    const exe = downloadedPaths.find((candidate) => candidate.endsWith(".exe"));
    if (exe) return exe;
  }
  return downloadedPaths[0] ?? null;
};

const toLogText = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack || value.message;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

export const createElectronUpdaterController = ({
  getMainWindow,
  setAllowQuit: _setAllowQuit,
}: {
  getMainWindow: () => BrowserWindow | null;
  setAllowQuit: (value: boolean) => void;
}): UpdaterController => {
  const store: UpdateStateStore = createUpdateStateStore();
  let latestVersion: string | null = null;
  let latestFiles: AppUpdateFile[] = [];
  let downloadedPath: string | null = null;
  let startupCheckScheduled = false;
  let initialized = false;
  let listenersAttached = false;
  let lastCheckAt = 0;
  let resolvedPublishUrl = "";

  const sendToMain = (event: AppUpdateEvent["type"], state: AppUpdateState) => {
    const payload = AppUpdateEventSchema.parse({ type: event, state });
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send("app-update:event", payload);
  };

  const setAndSend = (event: AppUpdateEvent["type"], state: AppUpdateState) => {
    const parsed = store.setState(state);
    sendToMain(event, parsed);
    return parsed;
  };

  const command = (result: AppUpdateCommandResult): AppUpdateCommandResult => AppUpdateCommandResultSchema.parse(result);

  // electron-updater 失败时会同时 emit error 事件并 reject 调用方 promise，
  // 同一失败只允许发出一次 error 状态（按 message + version 去重）。
  const handleUpdateError = (error: unknown, version: string | null): string => {
    const message = toErrorMessage(error);
    const current = store.state;
    if (current.status === "error" && current.error.message === message && current.latestVersion === version) {
      appendUpdaterLog("debug", "duplicate updater error suppressed", { message, version });
      return message;
    }
    setAndSend("error", errorState(version, message, undefined));
    return message;
  };

  const shouldThrottle = (manual: boolean): boolean => {
    if (lastCheckAt === 0) return false;
    const interval = manual ? MANUAL_CHECK_INTERVAL_MS : AUTO_CHECK_INTERVAL_MS;
    const elapsed = Date.now() - lastCheckAt;
    if (elapsed < interval) {
      appendUpdaterLog("debug", "update check throttled", { manual, elapsed, interval });
      return true;
    }
    return false;
  };

  const settlePendingIfInstalled = () => {
    const pending = readPendingUpdate();
    if (!pending) return;
    if (pending.downloadPath && !fs.existsSync(pending.downloadPath)) {
      appendUpdaterLog("debug", "pending update download file missing, clearing pending", {
        downloadPath: pending.downloadPath,
        version: pending.version,
      });
      clearPendingUpdate();
      return;
    }
    const current = resolveCurrentAppVersion();
    if (compareVersions(current, pending.version) >= 0) {
      clearPendingUpdate();
      appendUpdaterLog("info", "pending update settled", { current, pendingVersion: pending.version });
      return;
    }
    store.setState(downloadedState(pending.version, pending.downloadPath, []));
    appendUpdaterLog("debug", "pending update restored", pending);
  };

  const currentDownloadVersion = (): string => {
    if (latestVersion) return latestVersion;
    const state = store.state;
    if (state.status === "downloading") return state.latestVersion;
    return resolveCurrentAppVersion();
  };

  const attachAutoUpdaterListeners = () => {
    if (listenersAttached) return;
    listenersAttached = true;

    autoUpdater.on("checking-for-update", () => {
      if (store.state.status === "checking") {
        appendUpdaterLog("debug", "skip duplicate checking-for-update event because state is already checking", undefined);
        return;
      }
      setAndSend("checking", checkingState(Date.now()));
    });

    autoUpdater.on("update-available", (info: UpdateInfo) => {
      const version = info.version || resolveCurrentAppVersion();
      latestVersion = version;
      latestFiles = toAppUpdateFiles(info);
      lastCheckAt = Date.now();
      setAndSend("available", availableState({
        lastCheckedAt: Date.now(),
        latestVersion: version,
        releaseDate: normalizeReleaseDate(info.releaseDate),
        notes: normalizeReleaseNotes(info.releaseNotes),
        files: latestFiles,
        mandatory: false,
        minimumVersion: null,
      }));
      appendUpdaterLog("info", "update available", { version });
      // autoDownload=false：由桥接显式触发下载，维持「检查到更新即后台下载」的产品语义。
      void startDownload();
    });

    autoUpdater.on("update-not-available", (info: UpdateInfo) => {
      lastCheckAt = Date.now();
      latestVersion = null;
      const version = typeof info.version === "string" && info.version ? info.version : null;
      setAndSend("not-available", notAvailableState(Date.now(), version));
    });

    autoUpdater.on("download-progress", (progress: ProgressInfo) => {
      setAndSend("download-progress", downloadingState(currentDownloadVersion(), progressFromDownload(progress)));
    });

    // 下载完成的状态落定由 startDownload 中 downloadUpdate() 的 promise 驱动（单一 finalize 点），
    // electron-updater 先 emit update-downloaded 再 resolve promise，此处只留痕。
    autoUpdater.on("update-downloaded", (event: UpdateInfo & { downloadedFile?: string }) => {
      appendUpdaterLog("info", "update downloaded (electron-updater event)", {
        version: event.version,
        downloadedFile: typeof event.downloadedFile === "string" ? event.downloadedFile : null,
      });
    });

    autoUpdater.on("error", (error: unknown) => {
      handleUpdateError(error, latestVersion);
    });
  };

  const setupAutoUpdater = () => {
    initialized = true;
    resolvedPublishUrl = resolveUpdatePublishUrl();
    attachAutoUpdaterListeners();

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.logger = {
      info: (message?: unknown) => appendUpdaterLog("info", toLogText(message), undefined),
      warn: (message?: unknown) => appendUpdaterLog("warn", toLogText(message), undefined),
      error: (message?: unknown) => appendUpdaterLog("error", toLogText(message), undefined),
      debug: (message: string) => appendUpdaterLog("debug", toLogText(message), undefined),
    };

    settlePendingIfInstalled();
    appendUpdaterLog("info", "updater initialized (electron-updater)", {
      logPath: getUpdaterLogPath(),
      publishUrl: resolvedPublishUrl,
      platform: resolveUpdatePlatform(),
      arch: resolveUpdateArch(),
      channel: resolveUpdateChannel(),
      autoDownload: autoUpdater.autoDownload,
      autoInstallOnAppQuit: autoUpdater.autoInstallOnAppQuit,
    });
    if (!resolvedPublishUrl) {
      appendUpdaterLog("error", "update publish URL unresolved; update check and download will fail", {
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
      });
    }
  };

  const checkForUpdates = async (manual: boolean = false): Promise<AppUpdateCommandResult> => {
    if (!app.isPackaged) {
      appendUpdaterLog("debug", "skip update check in dev mode", undefined);
      return command({ status: "skipped", reason: "dev-mode", state: store.state });
    }
    if (!isSupportedUpdateTarget()) {
      appendUpdaterLog("debug", "skip update check for unsupported target", {
        platform: resolveUpdatePlatform(),
        arch: resolveUpdateArch(),
      });
      return command({ status: "skipped", reason: "unsupported-target", state: store.state });
    }
    if (store.state.status === "checking" || store.state.status === "downloading") {
      appendUpdaterLog("debug", "skip update check because updater is busy", { status: store.state.status });
      return command({ status: "skipped", reason: "busy", state: store.state });
    }
    if (!initialized) {
      appendUpdaterLog("debug", "skip update check because updater is not initialized", undefined);
      return command({ status: "skipped", reason: "not-initialized", state: store.state });
    }
    if (!resolvedPublishUrl) {
      appendUpdaterLog("error", "skip update check because publish URL is unresolved", undefined);
      return command({ status: "skipped", reason: "publish-url-unresolved", state: store.state });
    }
    if (shouldThrottle(manual)) {
      return command({ status: "skipped", reason: "throttled", state: store.state });
    }

    try {
      setAndSend("checking", checkingState(Date.now()));
      appendUpdaterLog("info", "checkForUpdates invoked", {
        appVersion: resolveCurrentAppVersion(),
        manual,
      });

      // 状态推进由 electron-updater 事件驱动（checking / update-available / update-not-available）。
      await autoUpdater.checkForUpdates();
      return command({ status: "success", state: store.state });
    } catch (error) {
      const message = handleUpdateError(error, latestVersion);
      return command({ status: "failed", error: { message }, state: store.state });
    }
  };

  const startDownload = async (): Promise<AppUpdateCommandResult> => {
    if (store.state.status === "downloading") {
      appendUpdaterLog("debug", "skip download because already downloading", undefined);
      return command({ status: "skipped", reason: "already-downloading", state: store.state });
    }
    if (store.state.status !== "available" && store.state.status !== "error") {
      appendUpdaterLog("debug", "skip download because no available update", { status: store.state.status });
      return command({ status: "skipped", reason: "no-update-available", state: store.state });
    }
    if (!initialized) {
      appendUpdaterLog("debug", "skip download because updater is not initialized", undefined);
      return command({ status: "skipped", reason: "not-initialized", state: store.state });
    }

    const version = latestVersion || (store.state.status === "available" ? store.state.latestVersion : resolveCurrentAppVersion());

    try {
      setAndSend("download-progress", downloadingState(version, null));

      // downloadUpdate() 的返回值是已下载文件路径数组（electron-updater 6.x API 形状）。
      const downloadedPaths = await autoUpdater.downloadUpdate();
      const installerPath = pickInstallerPath(downloadedPaths);
      if (!installerPath) {
        const message = "no suitable download file found for current platform";
        const state = setAndSend("error", errorState(version, message, undefined));
        return command({ status: "failed", error: { message }, state });
      }

      downloadedPath = installerPath;
      const next = setAndSend("downloaded", downloadedState(version, downloadedPath, latestFiles));
      writePendingUpdate({ version, downloadPath: downloadedPath, createdAt: Date.now() });
      appendUpdaterLog("info", "update downloaded", { version, downloadedPath });
      return command({ status: "success", state: next });
    } catch (error) {
      const message = handleUpdateError(error, version);
      return command({ status: "failed", error: { message }, state: store.state });
    }
  };

  const installUpdate = (): AppUpdateCommandResult => {
    if (store.state.status !== "downloaded") {
      appendUpdaterLog("debug", "skip install because update is not downloaded", { status: store.state.status });
      return command({ status: "skipped", reason: "not-downloaded", state: store.state });
    }
    if (!downloadedPath && store.state.status === "downloaded") {
      downloadedPath = store.state.downloadPath;
    }
    if (!downloadedPath) {
      appendUpdaterLog("debug", "skip install because download path is missing", undefined);
      return command({ status: "skipped", reason: "missing-download-path", state: store.state });
    }
    if (!fs.existsSync(downloadedPath)) {
      appendUpdaterLog("debug", "skip install because download file does not exist", { downloadPath: downloadedPath });
      return command({ status: "skipped", reason: "missing-download-file", state: store.state });
    }

    const platform = resolveUpdatePlatform();
    if (platform === "darwin") {
      // 未签名 mac 应用不能走 electron-updater 的 quitAndInstall（Squirrel.Mac 拒绝未签名包），
      // 保持「打开已下载安装器」语义：dmg 直接打开，zip 定位到文件夹。
      if (downloadedPath.endsWith(".dmg")) {
        void shell.openPath(downloadedPath);
        appendUpdaterLog("info", "opened dmg installer", { path: downloadedPath });
      } else {
        shell.showItemInFolder(downloadedPath);
        appendUpdaterLog("info", "revealed download file in folder", { path: downloadedPath });
      }
      return command({ status: "success", state: store.state });
    }

    // Windows: open the installer exe
    if (downloadedPath.endsWith(".exe")) {
      try {
        void shell.openPath(downloadedPath);
        appendUpdaterLog("info", "opened windows installer", { path: downloadedPath });
        return command({ status: "success", state: store.state });
      } catch (error) {
        appendUpdaterLog("error", "failed to open windows installer, showing in folder", { error: toErrorMessage(error) });
        shell.showItemInFolder(downloadedPath);
        return command({ status: "failed", error: { message: toErrorMessage(error) }, state: store.state });
      }
    }

    // Fallback: show in folder
    shell.showItemInFolder(downloadedPath);
    appendUpdaterLog("info", "revealed download file in folder (fallback)", { path: downloadedPath });
    return command({ status: "success", state: store.state });
  };

  const revealDownloadedUpdate = async (): Promise<AppUpdateCommandResult> => {
    if (!downloadedPath && store.state.status === "downloaded") downloadedPath = store.state.downloadPath;
    if (!downloadedPath) {
      appendUpdaterLog("debug", "skip reveal downloaded update because path is missing", undefined);
      return command({ status: "skipped", reason: "missing-download-path", state: store.state });
    }
    try {
      shell.showItemInFolder(downloadedPath);
      return command({ status: "success", state: store.state });
    } catch (error) {
      return command({ status: "failed", error: { message: toErrorMessage(error) }, state: store.state });
    }
  };

  const scheduleStartupCheck = () => {
    if (startupCheckScheduled) {
      appendUpdaterLog("debug", "skip scheduling startup update check because it is already scheduled", undefined);
      return;
    }
    startupCheckScheduled = true;
    setTimeout(() => {
      void checkForUpdates(false);
    }, 15_000);
  };

  const getUpdaterLogInfo = async () => {
    const logPath = getUpdaterLogPath();
    try {
      const stat = await fs.promises.stat(logPath);
      return { success: true, path: logPath, exists: true, size: stat.size, updatedAt: stat.mtimeMs };
    } catch {
      return { success: true, path: logPath, exists: false, size: 0, updatedAt: null };
    }
  };

  const revealUpdaterLog = async () => {
    const logPath = getUpdaterLogPath();
    try {
      await fs.promises.mkdir(path.dirname(logPath), { recursive: true });
      await fs.promises.appendFile(logPath, "", "utf8");
      shell.showItemInFolder(logPath);
      return { success: true, path: logPath };
    } catch (error) {
      return { success: false, error: toErrorMessage(error) };
    }
  };

  return {
    setupAutoUpdater,
    scheduleStartupCheck,
    checkForUpdates,
    startDownload,
    installUpdate,
    buildUpdateStateSnapshot: () => AppUpdateStateSchema.parse(store.state),
    getUpdaterLogInfo,
    revealUpdaterLog,
    revealDownloadedUpdate,
    getAppVersion: () => resolveCurrentAppVersion(),
  };
};
