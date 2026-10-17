import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  Tray,
} from "electron";
import type { BrowserWindowConstructorOptions } from "electron";
import * as path from "node:path";
import * as fs from "node:fs";
import type {
  EditorDesktopBootstrap,
  OpenEditorWindowResult,
} from "@iart/contracts/editor-backend-contract";
import {
  HUB_INITIAL_TITLE_BAR_OVERLAY,
  WINDOW_CHROME_INSETS,
} from "@iart/contracts";
import {
  getDb,
  validateProjectFolder,
} from "./storage/editor-storage-service.cjs";
import { resolveStableProjectId } from "./storage/stable-project-id-resolver.cjs";
import type { ProjectScopeCoordinator } from "./project-scope-coordinator.cjs";
import { createMainWindowLifecycle } from "./window/main-window-lifecycle.cjs";
import { attachDevToolsShortcuts } from "./window/devtools-shortcuts.cjs";
import {
  PRELOAD_PATH,
  ROOT_DIR,
  getStringField,
  normalizeDesktopString,
  resolveStaticErrorPageUrl,
} from "./desktop-shell-utils.cjs";
import type { RuntimeController } from "./desktop-shell-runtime.cjs";
import { resolveTaskStateRendererChannel } from "./task-message-channel.cjs";
import { revealTaskArchive } from "./task-archive-reveal.cjs";
import {
  bindDesktopE2EWindowLoaded,
  isDesktopE2EEnabled,
  reportDesktopE2EEvent,
} from "./desktop-shell-e2e.cjs";

type EditorWindowTarget = {
  projectPath: string | null;
  sessionToken: string;
  key: string;
};

/** 画布窗口 Map 键前缀（键全局唯一事实：`project:path:<projectPath>`，每项目至多一窗）。 */
const EDITOR_WINDOW_KEY_PREFIX = "project:path:";

export const normalizeEditorWindowTarget = (
  value: unknown,
): EditorWindowTarget | null => {
  if (!value || typeof value !== "object") return null;
  const raw = value as {
    projectPath: unknown | undefined;
    sessionToken: unknown | undefined;
  };
  const projectPath =
    typeof raw.projectPath === "string" && raw.projectPath.trim()
      ? raw.projectPath.trim()
      : null;
  const sessionToken =
    typeof raw.sessionToken === "string" && raw.sessionToken.trim()
      ? raw.sessionToken.trim()
      : "";
  if (!projectPath || !sessionToken) return null;
  return {
    projectPath,
    sessionToken,
    key: `${EDITOR_WINDOW_KEY_PREFIX}${projectPath}`,
  };
};

export type WindowController = ReturnType<typeof createWindowController>;

export const createWindowController = ({
  runtime,
  coordinator,
  resolveEditorStartUrl,
  resolveHubStartUrl,
}: {
  runtime: RuntimeController;
  coordinator: ProjectScopeCoordinator;
  resolveEditorStartUrl: () => string | null;
  resolveHubStartUrl: () => string | null;
}) => {
  let mainWindow: BrowserWindow | null = null;
  let tray: Tray | null = null;
  let isQuitting = false;
  let allowQuit = false;
  let quitDialogVisible = false;
  const editorWindows = new Map<string, BrowserWindow>();
  const editorProjectPaths = new Map<number, string>();
  const editorBootstraps = new Map<number, EditorDesktopBootstrap>();

  const buildWindowWebPreferences = (): NonNullable<
    BrowserWindowConstructorOptions["webPreferences"]
  > => ({
    preload: PRELOAD_PATH,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    devTools: true,
  });

  const attachStaticFailureFallback = (
    win: BrowserWindow,
    options: {
      title: string;
      loadFailureTitle: string;
      renderFailureTitle: string;
      unresponsiveTitle: string;
      reloadUrl: () => string | null;
    },
  ) => {
    let showingStaticErrorPage = false;
    const showStaticErrorPage = async ({
      title,
      detail,
      error,
      currentUrl,
      details,
    }: {
      title: string;
      detail: string;
      error: unknown | undefined;
      currentUrl: string | null | undefined;
      details: readonly {
        label: string;
        value: string | number | boolean | null | undefined;
      }[] | undefined;
    }) => {
      if (win.isDestroyed() || showingStaticErrorPage) return;
      showingStaticErrorPage = true;
      const url = currentUrl || win.webContents.getURL() || options.reloadUrl();
      try {
        await win.loadURL(
          resolveStaticErrorPageUrl({
            title,
            detail,
            error,
            currentUrl: url,
            reloadUrl: options.reloadUrl(),
            details,
          }),
        );
      } catch (loadError) {
        console.error(
          "[desktop] static diagnostics page failed to load",
          loadError,
        );
      }
    };

    win.webContents.on(
      "did-start-navigation",
      (_event, url, isInPlace, isMainFrame) => {
        if (isInPlace || isMainFrame === false) return;
        if (!url.startsWith("data:text/html")) {
          showingStaticErrorPage = false;
        }
      },
    );
    win.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (isMainFrame === false) return;
        void showStaticErrorPage({
          title: options.loadFailureTitle,
          detail: `${options.title} 前端入口加载失败。`,
          error: undefined,
          currentUrl: validatedURL,
          details: [
            { label: "事件", value: "did-fail-load" },
            { label: "错误码", value: errorCode },
            { label: "错误描述", value: errorDescription },
            { label: "URL", value: validatedURL },
          ],
        });
      },
    );
    win.webContents.on(
      "did-fail-provisional-load",
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (isMainFrame === false) return;
        void showStaticErrorPage({
          title: options.loadFailureTitle,
          detail: `${options.title} 前端入口预加载失败。`,
          error: undefined,
          currentUrl: validatedURL,
          details: [
            { label: "事件", value: "did-fail-provisional-load" },
            { label: "错误码", value: errorCode },
            { label: "错误描述", value: errorDescription },
            { label: "URL", value: validatedURL },
          ],
        });
      },
    );
    win.webContents.on("render-process-gone", (_event, details) => {
      void showStaticErrorPage({
        title: options.renderFailureTitle,
        detail: `${options.title} 渲染进程异常退出。`,
        error: undefined,
        currentUrl: win.webContents.getURL(),
        details: [
          { label: "事件", value: "render-process-gone" },
          { label: "reason", value: details.reason },
          { label: "exitCode", value: details.exitCode },
        ],
      });
    });
    win.on("unresponsive", () => {
      void showStaticErrorPage({
        title: options.unresponsiveTitle,
        detail: `${options.title} 渲染进程无响应。`,
        error: undefined,
        currentUrl: win.webContents.getURL(),
        details: [{ label: "事件", value: "unresponsive" }],
      });
    });
  };

  /**
   * macOS 交通灯自定义定位（spec docs/hub/window-chrome.md §4.2）。
   *
   * 目标：灯组圆心垂直居中于顶栏带（hubTopBandHeight/2 = 28px），与品牌 wordmark、
   * 各 tab 首行控件同一水平轴。语义：position 为灯组（关闭键）左上角坐标。
   * 本机实测灯径 ≈13.6px（含抗锯齿边缘）→ 圆心 ≈ position + 6.8；
   * y = 28 − 6.8 ≈ 21.2 → 取 21（预测圆心 27.8，容差 ±0.5 内）。
   * 系统默认定位按 ~32px 标题带居中（圆心 y≈16），在 56px 顶栏带下高于品牌轴 12px，
   * 故显式锚定，不得回退为"系统自动定位"。
   * 核验方式：dev 真机截图像素扫描红灯圆心 y 应为 28±0.5（spec §13，不在 DOM 内，无法 CDP 量取）。
   */
  const HUB_TRAFFIC_LIGHT_POSITION = { x: 10, y: 21 } as const;

  const createBrowserWindow = (startUrl = "about:blank") => {
    const win = new BrowserWindow({
      width: 1280,
      height: 800,
      show: false,
      // Hub 窗口 chrome（spec docs/hub/window-chrome.md §4/§5）：移除原生标题栏条，
      // 保留平台原生控件（macOS 交通灯 / Windows overlay）。Editor 窗口不经此工厂，不受影响。
      titleBarStyle: "hidden",
      ...(process.platform === "darwin" ? { trafficLightPosition: HUB_TRAFFIC_LIGHT_POSITION } : {}),
      ...(process.platform === "win32"
        ? {
            titleBarOverlay: {
              // 初始取默认深色主题令牌的 sRGB hex 折算值（主进程创建窗口时读不到 renderer
              // localStorage 偏好）。必须走 hex：Electron 原生颜色解析器不认 oklch，
              // 静默回落浅色白条（2026-10-16 实证）。值由 contracts 单一事实源
              // HUB_INITIAL_TITLE_BAR_OVERLAY 承载（Chromium 渲染像素实测折算），与
              // globals.css 令牌的一致性由 hub 令牌漂移守卫测试看护；renderer bootstrap
              // 后经 window:set-title-bar-overlay IPC 按实际主题校正（spec §7.3）。
              ...HUB_INITIAL_TITLE_BAR_OVERLAY,
              height: WINDOW_CHROME_INSETS.hubTopBandHeight,
            },
          }
        : {}),
      webPreferences: buildWindowWebPreferences(),
    });
    attachDevToolsShortcuts(win);
    attachStaticFailureFallback(win, {
      title: "Hub",
      loadFailureTitle: "Hub 加载失败",
      renderFailureTitle: "Hub 渲染进程异常",
      unresponsiveTitle: "Hub 无响应",
      reloadUrl: () => startUrl,
    });
    win.on("ready-to-show", () => win.show());
    win.on("close", (event) => {
      if (isQuitting || !tray) return;
      event.preventDefault();
      win.hide();
    });
    bindDesktopE2EWindowLoaded(win, "hub-window-loaded");
    void win.loadURL(startUrl);
    return win;
  };

  const lifecycle = createMainWindowLifecycle<BrowserWindow>({
    createWindow: createBrowserWindow,
    onWindowBound: (win) => {
      mainWindow = win;
    },
    onWindowCleared: (win) => {
      if (mainWindow === win) mainWindow = null;
    },
  });

  const buildEditorBootstrap = (target: EditorWindowTarget) => {
    const backendBaseUrl = (runtime.backendBaseUrl ?? "").trim();
    if (!backendBaseUrl) return null;
    // projectRef/stableProjectId 优先从已注册 scope 获取（单一事实源一致）；
    // scope 未注册时 fallback 只读解析（旧项目首次打开 stableProjectId 可能为 null）。
    const scope = target.projectPath ? coordinator.getScopeByPath(target.projectPath) : null;
    const stableProjectId = scope !== null ? scope.stableProjectId : resolveStableProjectId(target.projectPath);
    return {
      runtime: "desktop" as const,
      backendBaseUrl,
      projectPath: target.projectPath || null,
      projectRef: scope !== null ? scope.projectRef : null,
      stableProjectId,
      sessionToken: target.sessionToken,
      locale: "zh-CN",
      windowContext: {
        entry: "editor" as const,
      },
    };
  };

  const syncEditorBootstrap = (
    webContentsId: number | null,
    target: EditorWindowTarget,
  ) => {
    if (!webContentsId) return null;
    if (target.projectPath) {
      editorProjectPaths.set(webContentsId, target.projectPath);
      // 注册 scope 到 coordinator（单一事实源 + backend 增量同步）；attachSession 以 webContentsId 做 session 引用计数。
      runtime.registerProjectScope(target.projectPath);
      const scope = coordinator.getScopeByPath(target.projectPath);
      if (scope !== null) {
        coordinator.attachSession(scope.stableProjectId, String(webContentsId));
      } else {
        console.warn("[desktop] syncEditorBootstrap: coordinator scope missing after register", { projectPath: target.projectPath });
      }
    }
    const bootstrap = buildEditorBootstrap(target);
    if (bootstrap) editorBootstraps.set(webContentsId, bootstrap);
    else editorBootstraps.delete(webContentsId);
    return bootstrap;
  };

  const openOrFocusEditorWindow = async (
    target: EditorWindowTarget | null,
  ): Promise<OpenEditorWindowResult> => {
    if (!target) {
      return {
        ok: false,
        code: "invalid-editor-window-target",
        message: "editor window target invalid",
        projectPath: null,
      };
    }
    if (!target.projectPath) {
      return {
        ok: false,
        code: "invalid-editor-window-target",
        message: "editor window target missing project path",
        projectPath: null,
      };
    }
    const projectValidation = validateProjectFolder(target.projectPath);
    if (!projectValidation.ok) {
      console.error("[desktop] open editor blocked by invalid project folder", {
        projectPath: target.projectPath,
        failure: projectValidation.failure,
      });
      return {
        ok: false,
        code: "invalid-project-folder",
        message: projectValidation.failure.message,
        projectPath: target.projectPath,
      };
    }
    if (runtime.backendReady !== null && runtime.backendReady !== undefined) {
      await runtime.backendReady.catch(() => null);
    }
    const startUrl = resolveEditorStartUrl();
    if (!startUrl) {
      return {
        ok: false,
        code: "open-editor-window-failed",
        message: "editor start url unavailable",
        projectPath: target.projectPath,
      };
    }
    const existing = editorWindows.get(target.key);
    if (existing && !existing.isDestroyed()) {
      existing.show();
      existing.focus();
      syncEditorBootstrap(existing.webContents.id, target);
      return { ok: true };
    }
    const win = new BrowserWindow({
      width: 1280,
      height: 800,
      show: false,
      webPreferences: buildWindowWebPreferences(),
    });
    attachDevToolsShortcuts(win);
    attachStaticFailureFallback(win, {
      title: "编辑器",
      loadFailureTitle: "编辑器加载失败",
      renderFailureTitle: "编辑器渲染进程异常",
      unresponsiveTitle: "编辑器无响应",
      reloadUrl: () => startUrl,
    });
    const webContentsId = win.webContents.id;
    editorWindows.set(target.key, win);
    syncEditorBootstrap(webContentsId, target);
    if (target.projectPath) {
      try {
        getDb(target.projectPath);
      } catch (error) {
        console.error("[desktop] storage db pre-init failed", error);
      }
    }
    win.on("ready-to-show", () => {
      win.show();
      win.focus();
    });
    bindDesktopE2EWindowLoaded(win, "editor-window-loaded");
    win.webContents.once("did-finish-load", () => {
      if (!isDesktopE2EEnabled()) {
        return;
      }
      const bootstrap = editorBootstraps.get(webContentsId) || null;
      if (bootstrap) {
        reportDesktopE2EEvent({
          type: "renderer-bootstrap-ready",
          detail: {
            backendBaseUrl: bootstrap.backendBaseUrl,
            projectPath: bootstrap.projectPath,
            sessionToken: bootstrap.sessionToken,
          },
        });
        return;
      }
      reportDesktopE2EEvent({
        type: "renderer-bootstrap-error",
        detail: {
          message: "editor_bootstrap_missing_after_window_load",
        },
      });
    });
    win.on("closed", () => {
      editorWindows.delete(target.key);
      editorProjectPaths.delete(webContentsId);
      editorBootstraps.delete(webContentsId);
      // detach session；无活跃 session 时注销 scope（coordinator 向 backend 发 unregister）
      const scope = target.projectPath
        ? coordinator.getScopeByPath(target.projectPath)
        : null;
      if (scope !== null) {
        coordinator.detachSession(scope.stableProjectId, String(webContentsId));
        runtime.unregisterProjectScope(scope.stableProjectId);
      }
    });
    try {
      await win.loadURL(startUrl);
      return { ok: true };
    } catch (error) {
      await win.loadURL(
        resolveStaticErrorPageUrl({
          title: "画板加载失败",
          detail: `无法加载画板页面：${startUrl}`,
          error,
          currentUrl: startUrl,
          reloadUrl: startUrl,
          details: [{ label: "事件", value: "loadURL catch" }],
        }),
      );
      return {
        ok: false,
        code: "open-editor-window-failed",
        message:
          error instanceof Error ? error.message : "load editor url failed",
        projectPath: target.projectPath,
      };
    }
  };

  const getProjectPathForEvent = (
    event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent,
    payload: unknown,
  ) => {
    const hinted = normalizeDesktopString(
      getStringField(payload, "projectPath"),
    );
    if (hinted) return hinted;
    const webContentsId = (event.sender !== null && event.sender !== undefined ? event.sender.id : undefined);
    return webContentsId ? editorProjectPaths.get(webContentsId) || "" : "";
  };

  const loadTrayImage = () => {
    const iconPath = path.join(
      ROOT_DIR,
      "apps",
      "desktop-shell",
      "resources",
      "icons",
      process.platform === "darwin" ? "tray-icon.png" : "icon-512.png",
    );
    if (!fs.existsSync(iconPath)) return null;
    const image = nativeImage.createFromPath(iconPath);
    if (image.isEmpty()) return null;
    if (process.platform === "darwin") return image;
    return image.resize({ width: 16, height: 16 });
  };

  const showMainWindow = (startUrl: string | null = resolveHubStartUrl()) => {
    const fallback =
      startUrl || resolveStaticErrorPageUrl({ title: "Hub 入口不可用", detail: undefined, error: undefined, currentUrl: undefined, reloadUrl: undefined, details: undefined });
    if (!app.isReady()) {
      void app.whenReady().then(() => lifecycle.showOrRestore(fallback));
      return;
    }
    void lifecycle.showOrRestore(fallback);
  };

  const createTray = () => {
    const image = loadTrayImage();
    if (!image) return;
    tray = new Tray(image);
    tray.setToolTip("IARTStudio");
    tray.on("click", () => showMainWindow(resolveHubStartUrl()));
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: "显示主窗口",
          click: () => showMainWindow(resolveHubStartUrl()),
        },
        {
          label: "退出",
          click: () => {
            void confirmAndQuit();
          },
        },
      ]),
    );
  };

  const confirmAndQuit = async () => {
    if (allowQuit || quitDialogVisible) {
      app.quit();
      return;
    }
    quitDialogVisible = true;
    try {
      const { response } = await dialog.showMessageBox({
        type: "question",
        buttons: ["退出", "取消"],
        defaultId: 0,
        cancelId: 1,
        title: "确认退出",
        message: "确认退出 IARTStudio？",
        detail: "退出后本地后台服务将停止。",
      });
      if (response === 0) {
        allowQuit = true;
        app.quit();
      }
    } finally {
      quitDialogVisible = false;
    }
  };

  return {
    getMainWindow: () => mainWindow,
    getEditorBootstrap: (webContentsId: number) =>
      editorBootstraps.get(webContentsId) ?? null,
    /**
     * 按项目路径查画布窗口（CLI project status/close 消费；键与 openOrFocusEditorWindow
     * 的窗口 Map 一致：`project:path:${projectPath}`）。
     */
    getEditorWindowByProjectPath: (projectPath: string): BrowserWindow | null => {
      const win = editorWindows.get(`${EDITOR_WINDOW_KEY_PREFIX}${projectPath}`);
      if (win === undefined || win.isDestroyed()) return null;
      return win;
    },
    /**
     * 枚举全部已打开画布窗口的项目快照（CLI app status 消费，spec §5.5/CLI-020/CLI-021）：
     * 每项目至多一窗（Map 键 `project:path:<path>`），同项目在集合中至多出现一项。
     * 焦点（isFocused）与加载态（webContents.isLoading：画布页面仍在加载 = 画布尚未就绪）
     * 均按查询时点判定，不维护任何历史（spec §5.5）。
     */
    listOpenEditorProjects: (): { projectPath: string; focused: boolean; canvasLoading: boolean }[] => {
      const snapshots: { projectPath: string; focused: boolean; canvasLoading: boolean }[] = [];
      for (const [key, win] of editorWindows) {
        if (win.isDestroyed()) continue;
        const projectPath = key.slice(EDITOR_WINDOW_KEY_PREFIX.length);
        if (projectPath.length === 0) continue;
        snapshots.push({
          projectPath,
          focused: win.isFocused(),
          canvasLoading: win.webContents.isLoading(),
        });
      }
      return snapshots;
    },
    /**
     * 关闭承载该项目的画布窗口（复用既有窗口关闭链：BrowserWindow.close 触发 closed 事件，
     * 由既有 on("closed") 完成会话注销与投影清理——不新造清理逻辑）；返回是否找到存活窗口。
     */
    closeEditorWindowByProjectPath: (projectPath: string): boolean => {
      const win = editorWindows.get(`${EDITOR_WINDOW_KEY_PREFIX}${projectPath}`);
      if (win === undefined || win.isDestroyed()) return false;
      win.close();
      return true;
    },
    getProjectPathForEvent,
    setCurrentProjectPath: (
      webContentsId: number,
      projectPath: string | null,
    ) => {
      if (projectPath) editorProjectPaths.set(webContentsId, projectPath);
      else editorProjectPaths.delete(webContentsId);
    },
    openOrFocusEditorWindow,
    revealTaskArchive,
    showMainWindow,
    createTray,
    hasTray: () => Boolean(tray),
    windowCount: () => BrowserWindow.getAllWindows().length,
    confirmAndQuit,
    canQuit: () => allowQuit,
    setAllowQuit: (value: boolean) => {
      allowQuit = value;
    },
    markQuitting: () => {
      isQuitting = true;
    },
    forwardTaskMessage: (message: unknown) => {
      const channel = resolveTaskStateRendererChannel(message);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, message);
      }
      for (const win of editorWindows.values()) {
        if (!win.isDestroyed()) win.webContents.send(channel, message);
      }
    },
  };
};
