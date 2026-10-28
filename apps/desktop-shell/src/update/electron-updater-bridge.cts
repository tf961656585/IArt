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
import { autoUpdater, CancellationToken, type ProgressInfo, type UpdateInfo } from "electron-updater";
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
  cancelDownload: () => Promise<AppUpdateCommandResult>;
  installUpdate: () => AppUpdateCommandResult;
  buildUpdateStateSnapshot: () => AppUpdateState;
  getUpdaterLogInfo: () => Promise<object>;
  revealUpdaterLog: () => Promise<object>;
  revealDownloadedUpdate: () => Promise<AppUpdateCommandResult>;
  getAppVersion: () => string;
};

const AUTO_CHECK_INTERVAL_MS = 30 * 60 * 1000;
const MANUAL_CHECK_INTERVAL_MS = 2 * 60 * 1000;

// 最近一次「发现新版本」的完整快照：取消下载、检查失败保留可行动状态时据此重建 available。
type AvailableSnapshot = {
  latestVersion: string;
  releaseDate: string | null;
  notes: string | null;
  files: AppUpdateFile[];
  mandatory: boolean;
  minimumVersion: string | null;
};

// 一次下载尝试的运行时事实：token 只在本次下载内有效；cancelRequested 是取消判据（不依赖异常类型）。
type ActiveDownload = {
  token: CancellationToken;
  version: string;
  cancelRequested: boolean;
  settled: Promise<AppUpdateCommandResult>;
};

const isActionableState = (state: AppUpdateState | null): state is AppUpdateState =>
  state !== null && (state.status === "available" || state.status === "downloaded");

// electron-updater 的 ElectronHttpExecutor.download 把 onCancel 交给 doDownload 后并未使用
// （builder-util-runtime 的 doDownload 从不调用 options.onCancel），所以 token.cancel() 只让
// promise reject、不会停掉底层网络请求。这里包一层 createRequest 来登记在途请求，取消时显式 abort。
type AbortableUpdateRequest = {
  abort: () => void;
  once: (event: string, listener: () => void) => unknown;
};

type UpdaterHttpExecutor = {
  createRequest: (options: unknown, callback: (response: unknown) => void) => unknown;
};

const isAbortableUpdateRequest = (value: unknown): value is AbortableUpdateRequest => {
  if (typeof value !== "object" || value === null) return false;
  if (!("abort" in value) || !("once" in value)) return false;
  return typeof value.abort === "function" && typeof value.once === "function";
};

const isUpdaterHttpExecutor = (value: unknown): value is UpdaterHttpExecutor => {
  if (typeof value !== "object" || value === null) return false;
  if (!("createRequest" in value)) return false;
  return typeof value.createRequest === "function";
};

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
  let availableSnapshot: AvailableSnapshot | null = null;
  let activeDownload: ActiveDownload | null = null;
  let downloadedPath: string | null = null;
  let downloadedVersion: string | null = null;
  let startupCheckScheduled = false;
  let initialized = false;
  let listenersAttached = false;
  let lastCheckAt = 0;
  let resolvedPublishUrl = "";
  // 检查相位：用于区分「检查失败」与「下载失败」的 error 呈现，以及检查等待期 error 事件的抑制。
  let checkInFlight = false;
  let stateBeforeCheck: AppUpdateState | null = null;
  // 在一次下载内创建、尚未关闭的网络请求；取消时逐个 abort 才是真中止。
  const activeDownloadRequests = new Set<AbortableUpdateRequest>();
  let requestAbortHookAttached = false;

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

  // 返回 null 表示未节流；返回数字表示距可再次检查的剩余毫秒（最小 0）。
  const shouldThrottle = (manual: boolean): number | null => {
    if (lastCheckAt === 0) return null;
    const interval = manual ? MANUAL_CHECK_INTERVAL_MS : AUTO_CHECK_INTERVAL_MS;
    const elapsed = Date.now() - lastCheckAt;
    if (elapsed < interval) {
      const retryAfterMs = Math.max(0, interval - elapsed);
      appendUpdaterLog("debug", "update check throttled", { manual, elapsed, interval, retryAfterMs });
      return retryAfterMs;
    }
    return null;
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
    downloadedVersion = pending.version;
    downloadedPath = pending.downloadPath;
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
      availableSnapshot = {
        latestVersion: version,
        releaseDate: normalizeReleaseDate(info.releaseDate),
        notes: normalizeReleaseNotes(info.releaseNotes),
        files: latestFiles,
        mandatory: false,
        minimumVersion: null,
      };

      // 检查会把状态推进到 checking，因此「当前是否 downloaded」取检查前的快照（或直接处于 downloaded 的场景）。
      const downloadedStateBefore =
        stateBeforeCheck !== null && stateBeforeCheck.status === "downloaded"
          ? stateBeforeCheck
          : store.state.status === "downloaded"
            ? store.state
            : null;
      const downloadedFile = downloadedStateBefore?.downloadPath ?? downloadedPath;
      const downloadedFileExists =
        typeof downloadedFile === "string" && downloadedFile.length > 0 && fs.existsSync(downloadedFile);

      if (downloadedStateBefore !== null && downloadedStateBefore.latestVersion === version && downloadedFileExists) {
        // 同版本且安装包仍在：保持 downloaded，不重下、不回退到 available，只刷新 lastCheckedAt。
        downloadedVersion = version;
        downloadedPath = downloadedFile;
        const files = downloadedStateBefore.files.length > 0 ? downloadedStateBefore.files : latestFiles;
        setAndSend("downloaded", downloadedState(version, downloadedFile, files));
        appendUpdaterLog("debug", "update-available matches downloaded version; keeping downloaded state", {
          version,
          downloadPath: downloadedFile,
        });
        return;
      }

      if (downloadedStateBefore !== null && downloadedStateBefore.latestVersion === version && !downloadedFileExists) {
        appendUpdaterLog("debug", "downloaded update file missing; falling back to available", {
          version,
          downloadPath: downloadedFile ?? null,
        });
      }

      // 不同（更高）版本或安装包缺失：清理旧 pending，避免重启后把旧安装包当作最新。
      const pendingBefore = readPendingUpdate();
      if (pendingBefore) {
        clearPendingUpdate();
        appendUpdaterLog("debug", "cleared stale pending update", {
          pendingVersion: pendingBefore.version,
          availableVersion: version,
        });
      }
      downloadedVersion = null;
      downloadedPath = null;

      setAndSend("available", availableState({
        lastCheckedAt: Date.now(),
        latestVersion: version,
        releaseDate: availableSnapshot.releaseDate,
        notes: availableSnapshot.notes,
        files: latestFiles,
        mandatory: false,
        minimumVersion: null,
      }));
      appendUpdaterLog("info", "update available", { version });
      // 发现更新只停在 available；下载由 start-update-download 显式触发。
    });

    autoUpdater.on("update-not-available", (info: UpdateInfo) => {
      lastCheckAt = Date.now();
      latestVersion = null;
      availableSnapshot = null;
      const version = typeof info.version === "string" && info.version ? info.version : null;
      setAndSend("not-available", notAvailableState(Date.now(), version));
    });

    autoUpdater.on("download-progress", (progress: ProgressInfo) => {
      // 取消后可能仍有在途进度事件；没有活动下载时不得把状态拉回 downloading。
      if (activeDownload === null) {
        appendUpdaterLog("debug", "ignore download-progress without active download", {
          status: store.state.status,
        });
        return;
      }
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
      // 检查相位且检查前已持有可行动更新时，error 事件可能先于 checkForUpdates 的 catch 到达；
      // 此处只留痕，由 catch 恢复 available / downloaded，避免状态被 error 覆盖。
      if (checkInFlight && isActionableState(stateBeforeCheck)) {
        appendUpdaterLog("debug", "suppress updater error event during check with actionable update state", {
          message: toErrorMessage(error),
          status: stateBeforeCheck.status,
        });
        return;
      }
      handleUpdateError(error, latestVersion);
    });
  };

  // 给 autoUpdater.httpExecutor.createRequest 包一层：登记每个在途请求，使其可被取消真正 abort。
  // httpExecutor 不在 AppUpdater.d.ts 里（运行时存在），因此用单次结构化读取 + 类型守卫。
  const attachRequestAbortHook = () => {
    if (requestAbortHookAttached) return;
    if (!("httpExecutor" in autoUpdater)) {
      appendUpdaterLog("debug", "skip download abort hook because httpExecutor is unavailable", undefined);
      return;
    }
    const executor: unknown = autoUpdater.httpExecutor;
    if (!isUpdaterHttpExecutor(executor)) {
      appendUpdaterLog("debug", "skip download abort hook because httpExecutor.createRequest is unavailable", undefined);
      return;
    }

    const originalCreateRequest = executor.createRequest.bind(executor);
    executor.createRequest = (options, callback) => {
      const request = originalCreateRequest(options, callback);
      if (isAbortableUpdateRequest(request)) {
        activeDownloadRequests.add(request);
        const forget = () => {
          activeDownloadRequests.delete(request);
        };
        request.once("close", forget);
        request.once("aborted", forget);
      }
      return request;
    };
    requestAbortHookAttached = true;
    appendUpdaterLog("debug", "download abort hook attached to httpExecutor.createRequest", undefined);
  };

  // 取消时对全部在途请求调用 abort（依赖层面不会替我们做这件事）。
  const abortActiveDownloadRequests = () => {
    if (activeDownloadRequests.size === 0) {
      appendUpdaterLog("debug", "no active update request to abort on cancel", undefined);
      return;
    }
    const count = activeDownloadRequests.size;
    for (const request of activeDownloadRequests) {
      try {
        request.abort();
      } catch (error) {
        appendUpdaterLog("debug", "abort active update request failed", { error: toErrorMessage(error) });
      }
    }
    activeDownloadRequests.clear();
    appendUpdaterLog("info", "aborted active update requests on cancel", { count });
  };

  const setupAutoUpdater = () => {
    initialized = true;
    resolvedPublishUrl = resolveUpdatePublishUrl();
    attachAutoUpdaterListeners();
    attachRequestAbortHook();

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
    const throttleRetryAfterMs = shouldThrottle(manual);
    if (throttleRetryAfterMs !== null) {
      return command({
        status: "skipped",
        reason: "throttled",
        retryAfterMs: throttleRetryAfterMs,
        state: store.state,
      });
    }

    stateBeforeCheck = store.state;
    checkInFlight = true;
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
      // 节流按检查尝试计：失败同样占用窗口，避免连续失败期间无节流反复请求 feed
      lastCheckAt = Date.now();
      return recoverOrFailCheck(error);
    } finally {
      checkInFlight = false;
      stateBeforeCheck = null;
    }
  };

  // 检查失败不覆盖已有可行动更新：available / downloaded 保留（含入口），其余落入 error（check-error）。
  const recoverOrFailCheck = (error: unknown): AppUpdateCommandResult => {
    const message = toErrorMessage(error);
    const current = store.state;
    const actionable =
      current.status === "available" || current.status === "downloaded"
        ? current
        : isActionableState(stateBeforeCheck)
          ? stateBeforeCheck
          : null;
    if (actionable !== null) {
      const restored = setAndSend(
        actionable.status === "available" ? "available" : "downloaded",
        actionable,
      );
      appendUpdaterLog("info", "check failed but actionable update state preserved", {
        message,
        status: restored.status,
        latestVersion: restored.status === "downloaded" || restored.status === "available" ? restored.latestVersion : null,
      });
      return command({ status: "failed", error: { message }, state: restored });
    }
    const handledMessage = handleUpdateError(error, latestVersion);
    return command({ status: "failed", error: { message: handledMessage }, state: store.state });
  };

  // 取消后的恢复点：不写 pending、不落 error、不算失败，回到可重新下载的 available。
  const restoreAvailableAfterCancel = (version: string): AppUpdateCommandResult => {
    const snapshot: AvailableSnapshot = availableSnapshot ?? {
      latestVersion: version,
      releaseDate: null,
      notes: null,
      files: latestFiles,
      mandatory: false,
      minimumVersion: null,
    };
    const restored = setAndSend("available", availableState({ lastCheckedAt: Date.now(), ...snapshot }));
    appendUpdaterLog("info", "download cancelled; back to available", {
      version,
      latestVersion: snapshot.latestVersion,
    });
    return command({ status: "skipped", reason: "download-cancelled", state: restored });
  };

  const runDownload = async (active: ActiveDownload, files: AppUpdateFile[]): Promise<AppUpdateCommandResult> => {
    const version = active.version;
    setAndSend("download-progress", downloadingState(version, null));
    appendUpdaterLog("info", "download started", { version });

    try {
      // downloadUpdate() 的返回值是已下载文件路径数组（electron-updater 6.x API 形状）。
      const downloadedPaths = await autoUpdater.downloadUpdate(active.token);
      const installerPath = pickInstallerPath(downloadedPaths);
      if (!installerPath) {
        const message = "no suitable download file found for current platform";
        const state = setAndSend("error", errorState(version, message, undefined));
        return command({ status: "failed", error: { message }, state });
      }

      downloadedPath = installerPath;
      downloadedVersion = version;
      const downloadedFiles = files.length > 0 ? files : latestFiles;
      const next = setAndSend("downloaded", downloadedState(version, downloadedPath, downloadedFiles));
      writePendingUpdate({ version, downloadPath: downloadedPath, createdAt: Date.now() });
      appendUpdaterLog("info", "update downloaded", { version, downloadedPath });
      return command({ status: "success", state: next });
    } catch (error) {
      // 取消判定以本地标志为准：CancellationError 的类型/名字不可靠，且用户取消是唯一取消来源。
      if (active.cancelRequested) {
        return restoreAvailableAfterCancel(version);
      }
      const message = handleUpdateError(error, version);
      return command({ status: "failed", error: { message }, state: store.state });
    }
  };

  const startDownload = async (): Promise<AppUpdateCommandResult> => {
    const state = store.state;
    if (state.status === "downloading") {
      appendUpdaterLog("debug", "skip download because already downloading", undefined);
      return command({ status: "skipped", reason: "already-downloading", state });
    }
    if (state.status !== "available" && state.status !== "error") {
      appendUpdaterLog("debug", "skip download because no available update", { status: state.status });
      return command({ status: "skipped", reason: "no-update-available", state });
    }
    if (!initialized) {
      appendUpdaterLog("debug", "skip download because updater is not initialized", undefined);
      return command({ status: "skipped", reason: "not-initialized", state });
    }

    const version = latestVersion ?? state.latestVersion ?? resolveCurrentAppVersion();
    const files = state.status === "available" ? state.files : latestFiles;

    const token = new CancellationToken();
    let resolveSettled: (result: AppUpdateCommandResult) => void = () => undefined;
    const settled = new Promise<AppUpdateCommandResult>((resolve) => {
      resolveSettled = resolve;
    });
    const active: ActiveDownload = { token, version, cancelRequested: false, settled };
    activeDownload = active;

    // runDownload 内部已收口全部失败分支；额外的 catch 只兜底意外抛出，保证 settled 一定 resolve。
    const result = await runDownload(active, files).catch(
      (error: unknown): AppUpdateCommandResult =>
        command({ status: "failed", error: { message: toErrorMessage(error) }, state: store.state }),
    );
    resolveSettled(result);
    if (activeDownload === active) activeDownload = null;
    return result;
  };

  const cancelDownload = async (): Promise<AppUpdateCommandResult> => {
    const active = activeDownload;
    if (store.state.status !== "downloading" || active === null) {
      appendUpdaterLog("debug", "skip cancel download because no active download", {
        status: store.state.status,
      });
      return command({ status: "skipped", reason: "no-active-download", state: store.state });
    }

    active.cancelRequested = true;
    appendUpdaterLog("info", "cancel download requested", { version: active.version });
    active.token.cancel();
    abortActiveDownloadRequests();
    await active.settled;

    const finalState = AppUpdateStateSchema.parse(store.state);
    if (finalState.status === "downloaded") {
      // 取消与下载完成竞争：以已落盘的安装包为准，不丢弃。
      appendUpdaterLog("debug", "cancel download lost race to completed download", {
        version: finalState.latestVersion,
      });
      return command({ status: "skipped", reason: "download-completed", state: finalState });
    }
    if (finalState.status === "available") {
      return command({ status: "success", state: finalState });
    }
    // 取消请求在真实失败之后才生效：保留真实失败，不把它伪装成取消成功。
    appendUpdaterLog("warn", "cancel download observed non-cancelled terminal state", {
      status: finalState.status,
    });
    const message = finalState.status === "error" ? finalState.error.message : "download did not stop";
    return command({ status: "failed", error: { message }, state: finalState });
  };

  const installUpdate = (): AppUpdateCommandResult => {
    if (store.state.status !== "downloaded") {
      appendUpdaterLog("debug", "skip install because update is not downloaded", { status: store.state.status });
      return command({ status: "skipped", reason: "not-downloaded", state: store.state });
    }
    if (!downloadedPath) {
      downloadedPath = store.state.downloadPath;
    }
    if (!downloadedVersion) {
      downloadedVersion = store.state.latestVersion;
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
    if (!downloadedPath && store.state.status === "downloaded") downloadedPath = store.state.downloadPath;    if (!downloadedPath) {
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
    cancelDownload,
    installUpdate,
    buildUpdateStateSnapshot: () => AppUpdateStateSchema.parse(store.state),
    getUpdaterLogInfo,
    revealUpdaterLog,
    revealDownloadedUpdate,
    getAppVersion: () => resolveCurrentAppVersion(),
  };
};
