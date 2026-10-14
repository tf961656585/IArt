import { buildMediaFileResponse } from "./media-file-response.cjs";
import { registerPackageManagementIpcHandlers } from "./package-management-ipc.cjs";
import { resolvePackageFolderById } from "./storage/editor-storage-packages.cjs";
import { app, protocol, Menu } from "electron";
import * as path from "node:path";
import {
  getMediaDirByRef,
  registerMediaDir,
} from "./storage/editor-storage-local-media.cjs";
import projectRefUtils = require("@iart/utils/project-ref");
const stableProjectIdUtils = require("@iart/utils/stable-project-id") as {
  isStableProjectId: (value: unknown) => boolean;
};
const mediaConstants = require("@iart/utils/media-constants") as { LOCAL_MEDIA_GLOBAL_REF: string };
const { LOCAL_MEDIA_GLOBAL_REF } = mediaConstants;
import { registerStorageIpcHandlers } from "./storage/editor-storage-ipc.cjs";
import { setPresetsFilePath } from "./storage/editor-storage-prompt-presets.cjs";
import { setSystemPromptsDbPath } from "./storage/editor-storage-system-prompts.cjs";
import { closeAll, createProject, deleteProject, getDbForExistingProject } from "./storage/editor-storage-service.cjs";
import { readRecentProjects } from "./storage/editor-storage-recent-projects.cjs";
import {
  loadRuntimeEnvOnce,
  resolveBackendEntry,
  resolveDefaultStorageRootHint,
  resolveEditorStartUrl,
  resolveHubStartUrl,
  resolvePromptPresetsFilePathHint,
  resolveStaticErrorPageUrl,
} from "./desktop-shell-utils.cjs";
import { createRuntimeController } from "./desktop-shell-runtime.cjs";
import {
  createWindowController,
  normalizeEditorWindowTarget,
} from "./desktop-shell-windows.cjs";
import { createProjectScopeCoordinator } from "./project-scope-coordinator.cjs";
import { createMainWindowOpenCoordinator } from "./window/main-window-open-coordinator.cjs";
import { createUpdaterController } from "./desktop-shell-updater.cjs";
import { registerDesktopIpcHandlers, type DesktopCliIpcController } from "./desktop-shell-ipc.cjs";
import {
  maybeAutoExitAfterDesktopE2E,
  reportDesktopE2EEvent,
  resolveDesktopE2EOpenEditorRequest,
} from "./desktop-shell-e2e.cjs";
import { startCliControlService, type CliControlServiceHandle } from "./cli/cli-control-service.cjs";
import { createCliBackendForwarder } from "./cli/cli-backend-forwarder.cjs";
import { createCliProxyDispatcher, type CliProxyCommandCandidate } from "./cli/cli-proxy-dispatcher.cjs";
import {
  createCliEntryRegistration,
  resolveDefaultCliEntryTargetDir,
} from "./cli/cli-entry-registration.cjs";
import { appendMainLog } from "./main-log.cjs";
import { buildCliStatusDto } from "./cli/cli-status-snapshot.cjs";
import { resolveDefaultDiscoveryFilePath } from "./cli/cli-discovery.cjs";
import { CLI_PROXY_REQUEST_CHANNEL } from "@iart/contracts";
import {
  readCliAssetGenerationIndex,
  readCliAssetTaskIndex,
  readCliCanvasNodePayloads,
  readCliProjectMediaAssetById,
  readCliProjectMediaAssets,
  readCliTaskOutputAssets,
  touchCliProjectOpenedAt,
} from "./cli/cli-storage-queries.cjs";

loadRuntimeEnvOnce();

// 本地控制服务句柄（spec docs/integrations/CLI与本地Agent集成.md §6.2：app.whenReady 后启动、
// will-quit 停止并删除发现文件；启动失败不阻断 GUI 启动）
let cliControlService: CliControlServiceHandle | null = null;

// 仅 dev 模式（未打包）开启 CDP 远程调试端口，便于开发期经 Playwright / Chrome DevTools
// 通过 http://127.0.0.1:<port> 连接到运行中的 Hub / Editor 窗口做访问与排查。
// 打包构建（app.isPackaged === true）完全不开启，避免生产环境暴露调试面。
if (!app.isPackaged) {
  const cdpPort = (() => {
    const raw = String(process.env.IART_CDP_PORT ?? "").trim();
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 && parsed < 65536 ? String(parsed) : "9222";
  })();
  app.commandLine.appendSwitch("remote-debugging-port", cdpPort);
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
  console.log(`[desktop] CDP remote debugging enabled on 127.0.0.1:${cdpPort}`);
}

const coordinator = createProjectScopeCoordinator();
const runtime = createRuntimeController({ coordinator });
// coordinator events 后绑定到 runtime.sendToBackend，打破循环依赖
coordinator.bindEvents({
  onScopeRegistered: (entry) => {
    runtime.sendToBackend({
      type: "runtime:project-scope-register",
      stableProjectId: entry.stableProjectId,
      projectPath: entry.projectPath,
      projectRef: entry.projectRef,
    });
  },
  onScopeUnregistered: (entry) => {
    runtime.sendToBackend({
      type: "runtime:project-scope-unregister",
      stableProjectId: entry.stableProjectId,
    });
  },
});
const windows = createWindowController({
  runtime,
  coordinator,
  resolveEditorStartUrl: () => resolveEditorStartUrl(runtime.backendBaseUrl),
  resolveHubStartUrl,
});
const updater = createUpdaterController({
  getMainWindow: windows.getMainWindow,
  setAllowQuit: windows.setAllowQuit,
});
const mainWindowOpenCoordinator = createMainWindowOpenCoordinator({
  openMainWindow: (startUrl) => windows.showMainWindow(startUrl),
});

/**
 * CLI 命令执行器依赖（spec docs/integrations/CLI与本地Agent集成.md §4.2 分派规则）：
 * 项目生命周期 → 主进程存储服务与窗口控制（既有实现）；只读查询 → 运行域代理转发或
 * 存储只读投影；task.wait → 运行域轮询 + 存储产物投影；画布命令/生成提交/画布侧 task.cancel
 * → 代理执行通道（批次四）。全部复用既有链，不新增第二执行路径。
 */
const buildCliSessionToken = (): string => `cli-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

/**
 * CLI 代理执行通道分发端（spec §6.3）：窗口发送面适配 BrowserWindow.webContents.send；
 * 响应回传经 desktop-shell-ipc 的 ipcMain.on(CLI_PROXY_RESPONSE_CHANNEL) 转发至
 * dispatcher.consumeResponsePayload 按 request_id 配对。
 */
const cliProxyDispatcher = createCliProxyDispatcher({
  getWindow: (projectPath) => {
    const win = windows.getEditorWindowByProjectPath(projectPath);
    if (win === null) return null;
    return {
      sendCommand: (payload) => {
        win.webContents.send(CLI_PROXY_REQUEST_CHANNEL, payload);
      },
      onClosed: (listener) => {
        win.once("closed", listener);
      },
    };
  },
});

/**
 * CLI 轻量入口脚本绝对路径（spec §3 / CLI-025：shim 以 ELECTRON_RUN_AS_NODE=1 以纯 Node
 * 运行该脚本，不注入 --cli、不进入 browser 进程）。打包态经 electron-builder extraResources
 * 落在 app.asar 外（`<resources>/cli/cli-node-entry.cjs`，纯 Node 启动 asar 内文件未经实测、
 * asar 外保真）；dev 态为与 main.cjs 同级的构建产物（dist/cli/cli-node-entry.cjs——npm
 * script 以相对路径启动 dev，shim 里的相对路径会按用户执行 iart 时的 cwd 解析而失灵
 * （2026-10-07 实锤），shim 内路径必须绝对）。
 */
const resolveCliNodeEntryScriptPath = (): string => {
  // resourcesPath 仅在 Electron 运行时存在；打包判据同时要求它为字符串——纯 Node 环境
  // （集成测试 cjs-mock 等价物）isPackaged 可能为 true 而 resourcesPath 缺失，落到 dev 解析。
  const resourcesPath = process.resourcesPath;
  if (app.isPackaged === true && typeof resourcesPath === "string" && resourcesPath.length > 0) {
    return path.join(resourcesPath, "cli", "cli-node-entry.cjs");
  }
  const mainEntry = typeof process.argv[1] === "string" && process.argv[1].length > 0 ? path.resolve(process.argv[1]) : "";
  const devEntryDir = mainEntry.length > 0 ? path.dirname(mainEntry) : app.getAppPath();
  return path.join(devEntryDir, "cli", "cli-node-entry.cjs");
};

/**
 * CLI 命令入口注册（spec §3/§8，CLI-016/CLI-024）：shim 以 ELECTRON_RUN_AS_NODE=1 把应用
 * 可执行文件作为纯 Node 运行时启动轻量入口脚本（保证经入口启动一律走轻量 CLI 客户端形态，
 * 不进入 browser 进程）；dev 态 app-exec 为 Electron 可执行文件（run-as-node 下等价纯 Node
 * 二进制）+ 上述入口脚本路径。目标目录按平台默认解析（macOS /usr/local/bin；Windows
 * %LOCALAPPDATA%\Microsoft\WindowsApps），一键注册无写权限时结构化失败并引导手动注册。
 */
const cliEntryRegistration = createCliEntryRegistration({
  targetDir: resolveDefaultCliEntryTargetDir() ?? "",
  appExecPath: process.execPath,
  cliEntryScriptPath: resolveCliNodeEntryScriptPath(),
});

/**
 * shim 自动自愈（spec §3 / CLI-031）：应用启动时检测 Windows 双形态注册目录下的入口 shim
 * 是否为指向本应用可执行文件的过期模板（如 0.6.5/0.6.6 的 --cli 注入 + unset 形态），是则
 * 按当前模板重写（幂等，轻量入口形态翻转的存量自愈窗口）。写失败仅留痕不阻断 GUI 启动；
 * 非结果性分支（缺失/他物/已一致）静默跳过，模块内已留 debug 痕。
 */
const healCliEntryShims = (): void => {
  void cliEntryRegistration.healEntryShims().then((result) => {
    if (!result.ok) {
      appendMainLog("warn", "[cli-entry] shim 自愈失败（不阻断启动）", { detail: result.message });
      return;
    }
    if (result.rewrittenForms.length > 0 || result.foreignForms.length > 0) {
      appendMainLog("info", "[cli-entry] shim 自愈扫描完成", {
        rewrittenForms: result.rewrittenForms,
        foreignForms: result.foreignForms,
        missingForms: result.missingForms,
        currentForms: result.currentForms,
      });
    }
  });
};

/** 注册/卸除结果 → 设置页操作结果（用户视角消息；模块内已留 debug 痕）。 */
const toCliEntryOperationResult = (
  result:
    | { ok: true; action: "created" | "overwritten" | "noop" }
    | { ok: false; message: string }
    | { ok: true; removed: boolean; reason: "removed" | "absent" | "foreign_content" },
): { ok: boolean; message?: string } => {
  if (!result.ok) return { ok: false, message: result.message };
  if ("action" in result) {
    if (result.action === "created") return { ok: true, message: "iart 命令已可在终端直接使用。" };
    if (result.action === "overwritten") return { ok: true, message: "命令入口已更新，iart 现在连接本应用。" };
    return { ok: true, message: "命令入口已是最新，无需更改。" };
  }
  if (result.reason === "removed") return { ok: true, message: "已卸除命令入口，终端里的 iart 不再可用。" };
  if (result.reason === "absent") return { ok: true, message: "命令入口本就未注册，无需卸除。" };
  // foreign_content 聚合可能伴随本应用形态已删除（混合场景），消息不得声称「未做改动」。
  return { ok: true, message: "检测到指向其他程序的 iart 文件，为避免误删已保留。" };
};

const cliExecutorDeps = {
  readProjects: readRecentProjects,
  windows: {
    openOrFocus: async (projectPath: string) =>
      windows.openOrFocusEditorWindow({
        projectPath,
        sessionToken: buildCliSessionToken(),
        key: `project:path:${projectPath}`,
      }),
    hasOpenWindow: (projectPath: string) => windows.getEditorWindowByProjectPath(projectPath) !== null,
    closeByProjectPath: (projectPath: string) => windows.closeEditorWindowByProjectPath(projectPath),
    // app status 数据源（spec §5.5/CLI-020/CLI-021）：枚举已打开项目快照（焦点/加载态按查询时点）。
    listOpenEditorProjects: () => windows.listOpenEditorProjects(),
  },
  forwarder: createCliBackendForwarder({ getBaseUrl: () => runtime.backendBaseUrl }),
  storage: {
    // 空白项目创建：不预置画布图与资产（nodeGraph/mediaAssets 显式 undefined，与 CLI 语义一致）
    createProject: (params: { parentDir: string; name: string }) =>
      createProject({ parentDir: params.parentDir, name: params.name, nodeGraph: undefined, mediaAssets: undefined }),
    deleteProject: (params: { projectPath: string }) => deleteProject(params),
    touchProjectOpenedAt: touchCliProjectOpenedAt,
    readMediaAssets: readCliProjectMediaAssets,
    readMediaAssetById: readCliProjectMediaAssetById,
    readAssetTaskIndex: readCliAssetTaskIndex,
    readAssetGenerationIndex: readCliAssetGenerationIndex,
    readTaskOutputAssets: readCliTaskOutputAssets,
    readCanvasNodePayloads: readCliCanvasNodePayloads,
  },
  proxy: {
    dispatch: (projectPath: string, candidate: CliProxyCommandCandidate) =>
      cliProxyDispatcher.dispatch(projectPath, candidate),
  },
};

/**
 * CLI 设置页与代理响应入口（spec §8/§6.3）：状态闭包运行期读取控制服务句柄（whenReady 后
 * 才存在），注册/卸除转发入口注册模块，响应回传转发至分发器配对。
 */
const cliIpcController: DesktopCliIpcController = {
  getStatus: async () =>
    buildCliStatusDto({
      serviceRunning: cliControlService !== null,
      port: cliControlService?.port ?? null,
      discoveryFilePath: cliControlService?.discoveryFilePath ?? resolveDefaultDiscoveryFilePath(),
      entryRegistered: await cliEntryRegistration.getEntryStatus().then((status) =>
        status.supported ? status.registered : null,
      ),
      commandLog: cliControlService?.getCommandLog() ?? [],
    }),
  registerEntry: async () => toCliEntryOperationResult(await cliEntryRegistration.registerEntry()),
  unregisterEntry: async () => toCliEntryOperationResult(await cliEntryRegistration.unregisterEntry()),
  onProxyResponse: (payload) => {
    cliProxyDispatcher.consumeResponsePayload(payload);
  },
};

// IPC 注册在模块加载期完成，保持「加载即可用」契约
// （测试通过 sharedRequire 加载 main.cjs 后即可断言 handler 已注册）。
registerDesktopIpcHandlers({
  runtime,
  windows,
  updater,
  cli: cliIpcController,
});

runtime.setTaskForwarder((message) => {
  windows.forwardTaskMessage(message);
});
runtime.setRecoverHubWindow(() => {
  const hubUrl = resolveHubStartUrl();
  if (hubUrl) windows.showMainWindow(hubUrl);
});

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  console.error(
    "[desktop] 检测到已有 IARTStudio 实例在运行：请在系统托盘右键 -> 退出 后再重试启动。",
  );
  app.quit();
} else {
  app.on("second-instance", () => mainWindowOpenCoordinator.requestOpen());
}

app.on("before-quit", (event) => {
  if (!windows.canQuit()) {
    event.preventDefault();
    void windows.confirmAndQuit();
    return;
  }
  windows.markQuitting();
});

app.on("will-quit", () => {
  // 本地控制服务随 GUI 生命周期停止并删除发现文件（spec §6.2；发现文件删除在 stop 同步段完成）
  void cliControlService?.stop();
  cliControlService = null;
  closeAll();
  runtime.stopBackend();
});

// ---- 跟随系统档保鲜（spec docs/runtime/远端请求执行治理原则.md「代理治理」）----
// 窗口聚焦时请求 backend 重新解析系统代理，检出变化经 proxy:decision-changed 推回并
// 应用到 session。尾随去抖 1 秒：焦点切换密集时不重复触发；非跟随系统档位下 backend
// 解析结果不变、不会推送。
let proxyRefreshTimer: NodeJS.Timeout | null = null;
app.on("browser-window-focus", () => {
  if (proxyRefreshTimer !== null) return;
  proxyRefreshTimer = setTimeout(() => {
    proxyRefreshTimer = null;
    runtime.requestProxyRefresh();
  }, 1000);
  proxyRefreshTimer.unref();
});

protocol.registerSchemesAsPrivileged([
  {
    scheme: "local-media",
    privileges: { stream: true, standard: true, supportFetchAPI: true },
  },
  {
    scheme: "package-media",
    privileges: { stream: true, standard: true, supportFetchAPI: true },
  },
]);


void app.whenReady().then(async () => {
  reportDesktopE2EEvent({ type: "app-ready" });
  // shim 自动自愈（spec §3 / CLI-031）：不阻塞启动主链，结果与失败均落 main.log。
  healCliEntryShims();
  if (process.platform !== "darwin") {
    try {
      Menu.setApplicationMenu(null);
    } catch (error) {
      console.warn("[desktop] disable app menu failed", error);
    }
  }

  // 本地控制服务（spec docs/integrations/CLI与本地Agent集成.md §6.2/CLI-001）：app.whenReady 后启动。
  // 启动失败不阻断 GUI 启动——CLI 通道缺席时客户端按 not_running 呈现。
  try {
    cliControlService = await startCliControlService({
      version: app.getVersion(),
      executorDeps: cliExecutorDeps,
    });
  } catch (error) {
    console.error("[cli-control] 启动失败（GUI 继续启动）", error instanceof Error ? error.message : error);
  }

  const globalStorageRoot = resolveDefaultStorageRootHint();
  if (globalStorageRoot) {
    registerMediaDir(LOCAL_MEDIA_GLOBAL_REF, path.join(globalStorageRoot, "media"));
  } else {
    console.warn("[desktop] storage root 未解析，跳过 __global__ scope 注册");
  }

  // 媒体文件响应构建器已提取至 media-file-response.cts（local-media 与 package-media 双协议复用）。

  /**
   * local-media:// 协议处理器（双格式）。
   *
   * hostname 解析优先级：
   * 1. __global__ → global scope mediaDirRegistry（global 不属于项目 scope）
   * 2. stableProjectId（spid_ 前缀，V2）→ coordinator.getMediaDir
   * 3. projectRef（prj_ 前缀，V1 兼容）→ coordinator.getMediaDirByRef
   *
   * 细粒度错误码通过 X-Scope-Error header 暴露，便于排查：
   * - bad_request: hostname 格式非法或 fileKey 非法
   * - scope_unregistered: scope 未注册（项目未打开或已注销）
   * - file_missing: 文件在磁盘上不存在
   */
  // package-media:// 协议处理器：包管理预览媒体。
  // URL 形如 package-media://{packageId}/{fileName}；packageId 经包管理注册表
  // （editor-storage-packages 的 list/create/reveal 调用填充）解析到包文件夹，
  // 不依赖项目是否在 Editor 中打开。fileName 严格单段，禁路径逃逸。
  protocol.handle("package-media", async (request) => {
    try {
      const url = new URL(request.url);
      const packageId = decodeURIComponent(url.hostname);
      const fileName = decodeURIComponent(url.pathname).replace(/^\/+/, "").replace(/\/+$/, "");

      const buildErrorResponse = (status: number, body: string) =>
        new Response(body, { status, headers: { "Cache-Control": "no-store" } });

      if (!packageId || !fileName || fileName.includes("/") || fileName.includes("\\")) {
        return buildErrorResponse(400, "Invalid package-media URL");
      }
      const folderPath = resolvePackageFolderById(packageId);
      if (folderPath === null) {
        return buildErrorResponse(404, "Package not registered");
      }
      const filePath = path.join(folderPath, fileName);
      const resolved = path.resolve(filePath);
      if (!resolved.startsWith(folderPath + path.sep)) {
        return buildErrorResponse(400, "Invalid file path");
      }
      const fileResponse = await buildMediaFileResponse(resolved, request);
      if (fileResponse === null) {
        return buildErrorResponse(404, "File not found");
      }
      return fileResponse;
    } catch (error: unknown) {
      console.error("[package-media] 500 internal error", {
        url: request.url,
        error: error instanceof Error ? error.message : String(error),
      });
      return new Response("Internal error", { status: 500 });
    }
  });

  protocol.handle("local-media", async (request) => {
    try {
      const url = new URL(request.url);
      const hostname = decodeURIComponent(url.hostname);

      const fileKey = decodeURIComponent(url.pathname)
        .replace(/^\/+/, "")
        .replace(/\/+$/, "");

      const buildErrorResponse = (
        status: number,
        body: string,
        errorCode: string,
      ) => {
        console.warn(`[local-media] ${status} ${errorCode}`, { hostname, fileKey, url: request.url });
        return new Response(body, {
          status,
          // 404 属默认可启发式缓存的状态码；错误响应禁缓存，
          // 避免 file_missing 被缓存后掩盖后续落盘的文件（如 thumbnail repair）。
          headers: { "X-Scope-Error": errorCode, "Cache-Control": "no-store" },
        });
      };

      if (!fileKey || fileKey.includes("..") || path.isAbsolute(fileKey)) {
        return buildErrorResponse(400, "Invalid file key", "bad_request");
      }

      // __global__ scope：不属于项目 scope，仍走 global mediaDirRegistry
      if (hostname === LOCAL_MEDIA_GLOBAL_REF) {
        const globalMediaDir = getMediaDirByRef(hostname);
        if (globalMediaDir === null) {
          return buildErrorResponse(404, "Global scope not registered", "scope_unregistered");
        }
        const filePath = path.join(globalMediaDir, fileKey);
        const globalResponse = await buildMediaFileResponse(filePath, request);
        if (globalResponse === null) {
          return buildErrorResponse(404, "File not found", "file_missing");
        }
        return globalResponse;
      }

      // V2 stableProjectId（spid_）或 V1 projectRef（prj_）→ coordinator 统一解析
      const mediaDir = coordinator.resolveMediaDirByHostname(hostname);
      if (mediaDir === null) {
        const isStable = stableProjectIdUtils.isStableProjectId(hostname);
        const isProjectRefValue = projectRefUtils.isProjectRef(hostname);
        const isKnownFormat = isStable || isProjectRefValue;
        // 细粒度诊断：区分 404 来自哪种 scope（spid_/prj_/unknown），
        // 与 coordinator 的 [scope-coordinator] resolve miss 日志联动定位根因。
        console.debug("[local-media] scope resolve miss detail", {
          hostnameType: isStable ? "spid_" : isProjectRefValue ? "prj_" : "unknown",
          hostname: hostname.slice(0, 48),
          fileKey: fileKey.slice(0, 80),
        });
        return buildErrorResponse(
          404,
          isKnownFormat ? "Project not open" : "Invalid local-media URL: expected stableProjectId (spid_), projectRef (prj_) or __global__",
          isKnownFormat ? "scope_unregistered" : "bad_request",
        );
      }

      const filePath = path.join(mediaDir, fileKey);
      const fileResponse = await buildMediaFileResponse(filePath, request);
      if (fileResponse === null) {
        return buildErrorResponse(404, "File not found", "file_missing");
      }
      return fileResponse;
    } catch (error: unknown) {
      console.error("[local-media] 500 internal error", { url: request.url, error: error instanceof Error ? error.message : String(error) });
      return new Response("Internal error", { status: 500 });
    }
  });

  registerStorageIpcHandlers();
  registerPackageManagementIpcHandlers(getDbForExistingProject);
  setPresetsFilePath(resolvePromptPresetsFilePathHint());
  setSystemPromptsDbPath(app.getPath("userData"));
  updater.setupAutoUpdater();
  updater.scheduleStartupCheck();

  let hubUrl = "about:blank";
  try {
    await runtime.startBackend();
    reportDesktopE2EEvent({
      type: "backend-listening",
      detail: { backendBaseUrl: runtime.backendBaseUrl },
    });
    hubUrl =
      resolveHubStartUrl() ||
      resolveStaticErrorPageUrl({
        title: "Hub 入口不可用",
        detail: "Desktop Shell 未找到可用的 Hub 静态产物或开发服务。",
        error: undefined,
        currentUrl: undefined,
        reloadUrl: undefined,
        details: undefined,
      });
  } catch (error) {
    console.error("[desktop] backend start failed", error);
    hubUrl = resolveStaticErrorPageUrl({
      title: "IARTStudio 启动失败",
      detail: `本地后台服务未能启动，入口：${resolveBackendEntry()}`,
      error,
      currentUrl: undefined,
      reloadUrl: undefined,
      details: undefined,
    });
  }

  windows.createTray();
  mainWindowOpenCoordinator.markStartupReady(hubUrl, { openNow: true });
  const e2eEditorRequest = resolveDesktopE2EOpenEditorRequest();
  if (e2eEditorRequest) {
    void windows
      .openOrFocusEditorWindow(normalizeEditorWindowTarget(e2eEditorRequest))
      .then((opened) => {
      if (opened.ok) {
        reportDesktopE2EEvent({ type: "hub-open-editor-succeeded" });
      } else {
        reportDesktopE2EEvent({ type: "hub-open-editor-failed" });
        maybeAutoExitAfterDesktopE2E();
      }
    });
  }
});

app.on("activate", () => {
  if (windows.windowCount() === 0) {
    mainWindowOpenCoordinator.requestOpen();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && !windows.hasTray()) {
    void windows.confirmAndQuit();
  }
});
