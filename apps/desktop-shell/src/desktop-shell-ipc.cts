import { BrowserWindow, clipboard, dialog, ipcMain, nativeImage, nativeTheme, shell } from "electron";
import * as path from "node:path";
import * as fs from "node:fs";
import { createDefaultUrlResolverRegistry } from "./reveal/urlResolverRegistry.cjs";
import { revealFilesUrl } from "./reveal/revealFilesUrl.cjs";
import { revealProjectFolderTarget } from "./reveal/revealProjectFolderTarget.cjs";
import { writeTextClipboard } from "./clipboard/writeTextClipboard.cjs";
import { writeImageFromUrlClipboard } from "./clipboard/writeImageFromUrlClipboard.cjs";
import {
  getBooleanField,
  getStringField,
  normalizeDesktopString,
  resolveBackendLogDirHint,
  toErrorMessage,
} from "./desktop-shell-utils.cjs";
import {
  normalizeEditorWindowTarget,
  type WindowController,
} from "./desktop-shell-windows.cjs";
import type { RuntimeController } from "./desktop-shell-runtime.cjs";
import type { UpdaterController } from "./desktop-shell-updater.cjs";
import {
  AppUpdateCommandResultSchema,
  AppUpdateLogInfoResultSchema,
  AppUpdateRevealLogResultSchema,
  AppUpdateStateSchema,
  CLIPBOARD_IPC_CHANNELS,
  CLI_GET_STATUS_CHANNEL,
  CLI_PROXY_RESPONSE_CHANNEL,
  CLI_REGISTER_ENTRY_CHANNEL,
  CLI_UNREGISTER_ENTRY_CHANNEL,
  ClipboardWriteImageRequestSchema,
  ClipboardWriteTextRequestSchema,
  CliEntryOperationResultSchema,
  CliStatusDtoSchema,
  DesktopE2EEventPayloadSchema,
  HubDesktopBootstrapSchema,
  LOG_DIAGNOSTICS_IPC_CHANNELS,
  RevealBackendLogFolderResultSchema,
  FocusHubSettingsRequestSchema,
  HubFocusSettingsNoticeSchema,
  REVEAL_IPC_CHANNELS,
  RevealProjectFolderRequestSchema,
  RevealProjectFolderResultSchema,
  WINDOW_CHROME_IPC_CHANNELS,
} from "@iart/contracts";
import type { CliEntryOperationResult, CliStatusDto } from "@iart/contracts";
import { reportDesktopE2EEvent } from "./desktop-shell-e2e.cjs";
import {
  createSetNativeThemeSourceHandler,
  createSetTitleBarOverlayHandler,
} from "./window/window-chrome-ipc-handlers.cjs";
import { registerSkillStoreIpcHandlers } from "./skill-store/skill-store-ipc.cjs";

/** main → Hub renderer 的设置页锚点通知 channel（与 contracts WINDOW_CHROME_IPC_CHANNELS.FOCUS_HUB_SETTINGS 的 renderer 侧通知配对）。 */
const HUB_FOCUS_SETTINGS_CHANNEL = "hub:focus-settings";

const urlResolverRegistry = createDefaultUrlResolverRegistry();

/**
 * CLI 设置页与代理执行通道的 Main 侧控制器（spec docs/integrations/CLI与本地Agent集成.md
 * §6.3 / §8，批次四）。状态与注册闭包由 bootstrap 注入（控制服务句柄在 whenReady 后才存在，
 * 闭包运行期读取）。
 */
export interface DesktopCliIpcController {
  getStatus: () => Promise<CliStatusDto>;
  registerEntry: () => Promise<CliEntryOperationResult>;
  unregisterEntry: () => Promise<CliEntryOperationResult>;
  /** 画布窗口响应回传载荷入口（转发至代理分发器按 request_id 配对）。 */
  onProxyResponse: (payload: unknown) => void;
}

export const registerDesktopIpcHandlers = ({
  runtime,
  windows,
  updater,
  cli,
}: {
  runtime: RuntimeController;
  windows: WindowController;
  updater: UpdaterController;
  cli: DesktopCliIpcController;
}) => {
  ipcMain.handle("get-hub-bootstrap", async () => {
    if (runtime.backendReady !== null && runtime.backendReady !== undefined) {
      await runtime.backendReady.catch(() => null);
    }
    let backendBaseUrl = "";
    if (runtime.backendBaseUrl !== null && runtime.backendBaseUrl !== undefined) {
      backendBaseUrl = runtime.backendBaseUrl.trim();
    }
    if (!backendBaseUrl) return null;
    return HubDesktopBootstrapSchema.parse({
      runtime: "desktop-hub",
      backendBaseUrl,
      hubWriteToken: runtime.hubWriteToken,
    });
  });

  ipcMain.handle("get-editor-bootstrap", async (event) => {
    if (runtime.backendReady !== null && runtime.backendReady !== undefined) {
      await runtime.backendReady.catch(() => null);
    }
    const webContentsId = (event.sender !== null && event.sender !== undefined ? event.sender.id : undefined);
    return webContentsId ? windows.getEditorBootstrap(webContentsId) : null;
  });

  ipcMain.handle("get-runtime-flags", async () => ({
    isPackaged: Boolean(process.defaultApp === false),
  }));

  ipcMain.handle("open-editor-window", async (_event, payload) => {
    return await windows.openOrFocusEditorWindow(
      normalizeEditorWindowTarget(payload),
    );
  });

  ipcMain.handle("report-desktop-e2e-event", async (_event, payload) => {
    return reportDesktopE2EEvent(DesktopE2EEventPayloadSchema.parse(payload));
  });

  ipcMain.handle("check-for-updates", async (_event, manual: unknown) => {
    try {
      return AppUpdateCommandResultSchema.parse(
        await updater.checkForUpdates(manual === true),
      );
    } catch (error) {
      return AppUpdateCommandResultSchema.parse({
        status: "failed",
        error: { message: toErrorMessage(error) },
        state: updater.buildUpdateStateSnapshot(),
      });
    }
  });

  ipcMain.handle("start-update-download", async () => {
    try {
      return AppUpdateCommandResultSchema.parse(await updater.startDownload());
    } catch (error) {
      return AppUpdateCommandResultSchema.parse({
        status: "failed",
        error: { message: toErrorMessage(error) },
        state: updater.buildUpdateStateSnapshot(),
      });
    }
  });

  ipcMain.handle("cancel-update-download", async () => {
    try {
      return AppUpdateCommandResultSchema.parse(await updater.cancelDownload());
    } catch (error) {
      return AppUpdateCommandResultSchema.parse({
        status: "failed",
        error: { message: toErrorMessage(error) },
        state: updater.buildUpdateStateSnapshot(),
      });
    }
  });

  ipcMain.handle("install-update", () => {
    return AppUpdateCommandResultSchema.parse(updater.installUpdate());
  });
  ipcMain.handle("get-update-state", () =>
    AppUpdateStateSchema.parse(updater.buildUpdateStateSnapshot()),
  );
  ipcMain.handle("get-app-version", () => updater.getAppVersion());
  ipcMain.handle("get-updater-log-info", async () =>
    AppUpdateLogInfoResultSchema.parse(await updater.getUpdaterLogInfo()),
  );
  ipcMain.handle("reveal-updater-log", async () =>
    AppUpdateRevealLogResultSchema.parse(await updater.revealUpdaterLog()),
  );
  ipcMain.handle("reveal-downloaded-update", async () =>
    AppUpdateCommandResultSchema.parse(await updater.revealDownloadedUpdate()),
  );

  // 定位 backend 业务日志目录（spec docs/editor/本地文件快捷跳转.md LFJ-008）：
  // 路径知识归主进程（与 reveal-updater-log 同模式），渲染层不自持路径。
  // 目录不存在时先创建再定位（updater 先例：appendFile 兜底），定位目录本身。
  ipcMain.handle(LOG_DIAGNOSTICS_IPC_CHANNELS.REVEAL_BACKEND_LOG_FOLDER, async () => {
    const logDir = resolveBackendLogDirHint();
    if (!logDir) {
      console.debug("[desktop] reveal-backend-log-folder: storage root unresolved");
      return RevealBackendLogFolderResultSchema.parse({
        success: false,
        error: "storage-root-unresolved",
      });
    }
    try {
      await fs.promises.mkdir(logDir, { recursive: true });
      shell.showItemInFolder(logDir);
      return RevealBackendLogFolderResultSchema.parse({ success: true, path: logDir });
    } catch (error) {
      console.debug("[desktop] reveal-backend-log-folder failed", error);
      return RevealBackendLogFolderResultSchema.parse({
        success: false,
        error: toErrorMessage(error),
      });
    }
  });

  ipcMain.handle("open-external", async (_event, url) => {
    if (!url || typeof url !== "string") return false;
    await shell.openExternal(url);
    return true;
  });

  ipcMain.handle("open-dev-console", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) {
      return { ok: false, reason: "window-unavailable" };
    }
    win.webContents.openDevTools();
    return { ok: true };
  });

  const selectDirectory = async (
    title: string,
    defaultPath: string,
    buttonLabel: string,
    showHiddenFiles: boolean,
  ) => {
    const win = BrowserWindow.getFocusedWindow() || windows.getMainWindow();
    if (!win || win.isDestroyed()) {
      return {
        status: "error",
        path: null,
        errorCode: "window_unavailable",
        userMessage: "当前窗口不可用，请返回主窗口后重试",
        debugMessage: "No available browser window",
      };
    }
    // showHiddenFiles 为可选扩展（默认关）：仅当调用方显式请求时才放宽隐藏项可见性，
    // 未传该字段的既有调用方 properties 与历史行为完全一致。
    const dialogProperties: NonNullable<Electron.OpenDialogOptions["properties"]> = [
      "openDirectory",
      "createDirectory",
    ];
    if (showHiddenFiles) {
      dialogProperties.push("showHiddenFiles");
    }
    const result = await dialog.showOpenDialog(win, {
      title,
      defaultPath,
      properties: dialogProperties,
      buttonLabel,
    });
    const selectedPath = (result.filePaths[0] !== null && result.filePaths[0] !== undefined ? result.filePaths[0].trim() : undefined) || "";
    return result.canceled || !selectedPath
      ? {
          status: "canceled",
          path: null,
          errorCode: null,
          userMessage: null,
          debugMessage: null,
        }
      : {
          status: "success",
          path: selectedPath,
          errorCode: null,
          userMessage: null,
          debugMessage: null,
        };
  };

  // select-folder 支持可选 showHiddenFiles（默认关，仅 Hub「选择 Skill 安装文件夹」等
  // 显式请求的调用方放宽隐藏项）；select-project-folder 不开放该扩展，行为不变。
  ipcMain.handle("select-folder", async (_event, options) =>
    selectDirectory(
      getStringField(options, "title").trim() || "选择文件夹",
      getStringField(options, "defaultPath").trim(),
      getStringField(options, "buttonLabel").trim() || "选择此文件夹",
      getBooleanField(options, "showHiddenFiles"),
    ),
  );
  ipcMain.handle("select-project-folder", async (_event, options) =>
    selectDirectory(
      getStringField(options, "title").trim() || "选择项目文件夹",
      getStringField(options, "defaultPath").trim(),
      getStringField(options, "buttonLabel").trim() || "打开项目",
      false,
    ),
  );

  ipcMain.handle("get-current-project-path", async (event) => {
    return windows.getProjectPathForEvent(event, null) || null;
  });
  ipcMain.handle("set-current-project-path", async (event, projectPath) => {
    const webContentsId = (event.sender !== null && event.sender !== undefined ? event.sender.id : undefined);
    if (webContentsId) {
      windows.setCurrentProjectPath(
        webContentsId,
        typeof projectPath === "string" ? projectPath : null,
      );
    }
  });

  // 定位项目目录或导出文件（spec docs/editor/本地文件快捷跳转.md）：
  // 目录类（Hub 项目卡「打开所在文件夹」）与文件类（Hub 导出项目完成后自动定位
  // .iarts.zip，判据五历史特例）共用本通道；stat 语义与 showItemInFolder 高亮规则
  // 见 revealProjectFolderTarget。目标不存在时返回 path-missing（LFJ-003/LFJ-011）。
  ipcMain.handle(REVEAL_IPC_CHANNELS.REVEAL_PROJECT_FOLDER, async (_event, payload) => {
    const parsed = RevealProjectFolderRequestSchema.safeParse(payload);
    if (!parsed.success) {
      return RevealProjectFolderResultSchema.parse({ ok: false, reason: "not-absolute" });
    }
    return await revealProjectFolderTarget({
      targetPath: parsed.data.path,
      shell,
    });
  });

  ipcMain.handle("reveal-task-archive", async (event, payload) => {
    const taskId = normalizeDesktopString(
      getStringField(payload, "taskId") || payload,
    );
    const projectPath = windows.getProjectPathForEvent(event, payload);
    if (!taskId) return { ok: false, reason: "missing-task-id" };
    if (!projectPath) return { ok: false, reason: "missing-project-path" };
    if (!path.isAbsolute(projectPath)) {
      return {
        ok: false,
        reason: "not-absolute-project-path",
        path: projectPath,
      };
    }
    return windows.revealTaskArchive(projectPath, taskId);
  });

  ipcMain.handle("reveal-files-url", async (event, payload) => {
    const url = normalizeDesktopString(
      getStringField(payload, "url") || payload,
    );
    if (!url) return { ok: false, reason: "missing-url" };
    return await revealFilesUrl({
      url,
      storedProjectPath: windows.getProjectPathForEvent(event, payload) || null,
      hintedProjectPath: normalizeDesktopString(
        getStringField(payload, "projectPath"),
      ),
      shell,
      urlResolverRegistry,
    });
  });

  ipcMain.handle(CLIPBOARD_IPC_CHANNELS.WRITE_TEXT, (_event, payload) => {
    const text = normalizeDesktopString(getStringField(payload, "text"));
    const parsed = ClipboardWriteTextRequestSchema.safeParse({ text });
    if (!parsed.success) {
      // safeParse 失败说明 text 为空（Schema 要求非空），归一到 empty-text
      return writeTextClipboard({ text: "", clipboard });
    }
    return writeTextClipboard({ text: parsed.data.text, clipboard });
  });

  ipcMain.handle(
    CLIPBOARD_IPC_CHANNELS.WRITE_IMAGE_FROM_URL,
    async (event, payload) => {
      const url = normalizeDesktopString(getStringField(payload, "url"));
      const hintedProjectPath = normalizeDesktopString(
        getStringField(payload, "projectPath"),
      );
      const storedProjectPath =
        windows.getProjectPathForEvent(event, payload) || null;
      const parsed = ClipboardWriteImageRequestSchema.safeParse({
        url,
        projectPath: hintedProjectPath || null,
      });
      if (!parsed.success) {
        // url 为空归一到 missing-url；其它失败归一到 missing-project-path
        if (!url) {
          return { ok: false, reason: "missing-url" };
        }
        return { ok: false, reason: "missing-project-path" };
      }
      return await writeImageFromUrlClipboard({
        url: parsed.data.url,
        storedProjectPath,
        hintedProjectPath: parsed.data.projectPath,
        clipboard,
        nativeImage,
        urlResolverRegistry,
      });
    },
  );

  ipcMain.handle("window-close", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win !== null && win !== undefined) {
      win.close();
    }
  });

  // window:set-title-bar-overlay / window:set-native-theme-source（spec docs/hub/window-chrome.md §7.4/§7.5）：
  // handler 逻辑在 window/window-chrome-ipc-handlers.cjs（可注入单元：边界校验 + 主进程留痕）。
  // 仅作用于 Hub 主窗口：显式取 getMainWindow，不用 fromWebContents，防误广播到 Editor 窗口。
  ipcMain.handle(
    WINDOW_CHROME_IPC_CHANNELS.SET_TITLE_BAR_OVERLAY,
    createSetTitleBarOverlayHandler({ getMainWindow: () => windows.getMainWindow() }),
  );
  ipcMain.handle(
    WINDOW_CHROME_IPC_CHANNELS.SET_NATIVE_THEME_SOURCE,
    createSetNativeThemeSourceHandler({ nativeTheme }),
  );

  // window:focus-hub-settings（首次指引随批存量修补，docs/hub/首次指引-design.md §4.4）：
  // Editor 聚焦 Hub 主窗口并定位设置页子单元。显示/还原/聚焦走 showMainWindow（已有生命周期
  // 管理与托盘恢复同路径），锚点 id 经 hub:focus-settings 通知转发给 Hub renderer；
  // Hub renderer 收到后切设置 tab 并滚动定位（apps/hub/src/features/settings/SettingsTab.tsx）。
  ipcMain.handle(WINDOW_CHROME_IPC_CHANNELS.FOCUS_HUB_SETTINGS, (_event, payload) => {
    const parsed = FocusHubSettingsRequestSchema.safeParse(payload);
    if (!parsed.success) return { ok: false as const };
    windows.showMainWindow();
    const win = windows.getMainWindow();
    if (win !== null && win !== undefined && !win.isDestroyed()) {
      const notice = HubFocusSettingsNoticeSchema.parse({ sectionId: parsed.data.sectionId });
      win.webContents.send(HUB_FOCUS_SETTINGS_CHANNEL, notice);
      return { ok: true as const };
    }
    return { ok: false as const };
  });

  // CLI 设置页「命令行工具」子单元（spec docs/integrations/CLI与本地Agent集成.md §8）：
  // 只读状态 + 一键注册/卸除（幂等，CLI-016）。响应出站经契约 schema 校验（IPC 边界纪律）。
  ipcMain.handle(CLI_GET_STATUS_CHANNEL, async () => CliStatusDtoSchema.parse(await cli.getStatus()));
  ipcMain.handle(CLI_REGISTER_ENTRY_CHANNEL, async () =>
    CliEntryOperationResultSchema.parse(await cli.registerEntry()),
  );
  ipcMain.handle(CLI_UNREGISTER_ENTRY_CHANNEL, async () =>
    CliEntryOperationResultSchema.parse(await cli.unregisterEntry()),
  );

  // CLI 代理执行通道 · 画布窗口响应回传（spec §6.3）：本仓首个 ipcMain.on 通道——
  // 命令响应是主进程主动等待的回传（不是 handle 调用），载荷转发至分发器按 request_id 配对；
  // 契约校验与配对留痕在分发器内完成（cli-proxy-dispatcher）。
  ipcMain.on(CLI_PROXY_RESPONSE_CHANNEL, (_event, payload: unknown) => {
    cli.onProxyResponse(payload);
  });

  // skill 商店安装 IPC（skills:get-installed-state / skills:install）
  registerSkillStoreIpcHandlers();
};
