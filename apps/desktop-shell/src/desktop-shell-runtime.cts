import { fork, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { app, safeStorage, session } from "electron";
import {
  resolveDesktopBackendRuntimeBootstrap,
} from "./utils/backend-runtime-bootstrap.cjs";
import { attachChildProcessStartupGuard } from "./utils/child-process-startup-guard.cjs";
import { appendUpdaterLog } from "./update/app-update-log.cjs";
import {
  cloneDesktopEnv,
  getStringField,
  probeHttpHealth,
  resolveAppVersion,
  resolveBackendEntry,
  resolveEditorStaticRoot,
  toErrorMessage,
  type DesktopEnv,
} from "./desktop-shell-utils.cjs";
import {
  asRuntimeMessageCandidate,
  createRuntimeStorageMessageHandler,
  type RuntimeMessageCandidate,
} from "./desktop-shell-runtime-storage.cjs";
import {
  HUB_LOCAL_WRITE_TOKEN_ENV,
  HUB_LOCAL_WRITE_TOKEN_HEADER,
  HubLocalWriteTrustProbeResponseSchema,
  MediaAssetsChangedNotificationSchema,
  TaskStateNotificationSchema,
  TaskStateSnapshotSchema,
  CredentialCryptoEncryptPayloadSchema,
  CredentialCryptoDecryptPayloadSchema,
  CredentialCryptoAvailablePayloadSchema,
  ProxyDecisionNotificationSchema,
} from "@iart/contracts";
import type { ProjectScopeCoordinator } from "./project-scope-coordinator.cjs";
import {
  createProxyDecisionApplier,
  extractProxyCredentials,
  UPDATER_SESSION_PARTITION,
} from "./proxy/proxy-decision-applier.cjs";

export type RuntimeControllerOptions = {
  coordinator: ProjectScopeCoordinator;
};

export type RuntimeController = ReturnType<typeof createRuntimeController>;

/**
 * 将模型能力包目录注入 backend 子进程 env（**退役中**：模型包不再是模型来源）。
 *
 * 模型唯一来源是用户模型记录（spec 03 PC-15），backend 的 `resolveModelPackagesRoot` 已不再
 * 探测仓库/安装包目录，因此这里也不再自动指向任何仓库内包目录：dev 与打包态行为一致，
 * 都不注入。唯一保留的是开发者显式设置 `IART_MODEL_ASSET_PACKAGES_DIR` 的场景（模型包构建工具、
 * 依赖真实夹具的排查），该值原样透传。
 *
 * 待「模型能力包」子系统整体删除时，本函数与其调用点一并退场。
 *
 * `isPackaged` 作为参数注入（来自 `app.isPackaged`），使该决策函数可在脱离 Electron 运行时的单测中验证。
 */
export const injectModelAssetPackagesDir = (
  env: DesktopEnv,
  isPackaged: boolean,
): void => {
  if (env.IART_MODEL_ASSET_PACKAGES_DIR === undefined) {
    appendUpdaterLog("debug", "model-asset: packages dir not injected (model source is user records)", {
      isPackaged,
    });
    return;
  }
  appendUpdaterLog("debug", "model-asset: explicit packages dir kept", {
    envValue: env.IART_MODEL_ASSET_PACKAGES_DIR,
  });
};

/**
 * 清理用户数据目录下的历史远端同步目录（model-assets-synced 及其临时目录残留）。
 *
 * 远端热更新通道已下线：模型能力包只随软件安装包内置分发，backend 只读内置目录，
 * 已同步的包不再被任何消费方读取。目录内容是可再生的模型能力包，删除无数据损失。
 *
 * `userDataDir` 由调用方传入（app.getPath("userData")），使该函数可在脱离 Electron 运行时的单测中验证。
 */
export const cleanupLegacyModelAssetSyncedDirectory = (userDataDir: string): void => {
  const LEGACY_SYNC_DIR_NAME = "model-assets-synced";
  const LEGACY_TEMP_DIR_PREFIX = "model-assets-synced.tmp-";
  let entries: string[];
  try {
    entries = fs
      .readdirSync(userDataDir, { withFileTypes: true })
      .filter(
        (entry) =>
          (entry.isDirectory() || entry.isSymbolicLink()) &&
          (entry.name === LEGACY_SYNC_DIR_NAME || entry.name.startsWith(LEGACY_TEMP_DIR_PREFIX)),
      )
      .map((entry) => entry.name);
  } catch (error) {
    appendUpdaterLog("warn", "model-asset: failed to list userData for legacy sync dir cleanup", {
      userDataDir,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  if (entries.length === 0) {
    appendUpdaterLog("debug", "model-asset: no legacy model-assets-synced directory to clean", {
      userDataDir,
    });
    return;
  }
  for (const name of entries) {
    const fullPath = path.join(userDataDir, name);
    try {
      fs.rmSync(fullPath, { recursive: true, force: true });
      appendUpdaterLog("info", "model-asset: removed legacy model-assets-synced directory", {
        path: fullPath,
      });
    } catch (error) {
      appendUpdaterLog("warn", "model-asset: failed to remove legacy model-assets-synced directory", {
        path: fullPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
};

export const createRuntimeController = (
  options: RuntimeControllerOptions,
) => {
  const coordinator = options.coordinator;
  const hubWriteToken = randomBytes(24).toString("hex");
  let backendProcess: ChildProcess | null = null;
  let backendReady: Promise<string | null> | null = null;
  let backendBaseUrl: string | null = null;
  let backendPortHint: number | null = null;
  let taskForwarder: ((message: RuntimeMessageCandidate) => void) | null = null;
  let recoverHubWindow: (() => void) | null = null;

  const sendResult = (transactionId: string, result: object) => {
    if (
      backendProcess !== null &&
      backendProcess !== undefined &&
      backendProcess.send !== null &&
      backendProcess.send !== undefined
    ) {
      backendProcess.send({
        type: "runtime:transaction-result",
        transactionId,
        ...result,
      });
    }
  };

  const sendRuntimeMessage = (
    message: Parameters<NonNullable<ChildProcess["send"]>>[0],
  ) => {
    if (
      backendProcess !== null &&
      backendProcess !== undefined &&
      backendProcess.send !== null &&
      backendProcess.send !== undefined
    ) {
      backendProcess.send(message);
    }
  };

  /**
   * 向 backend 发送任意 MainToBackendMessage。
   * 供 coordinator 的 scope 同步事件回调使用（由 bootstrap 绑定）。
   */
  const sendToBackend = (
    message: Parameters<NonNullable<ChildProcess["send"]>>[0],
  ): void => {
    sendRuntimeMessage(message);
  };

  const handleStorageMessage = createRuntimeStorageMessageHandler({
    sendMessage: sendRuntimeMessage,
    sendResult,
  });

  // ---- 生效代理决策应用（spec docs/runtime/远端请求执行治理原则.md「代理治理」）----
  // 默认 session：Hub/Editor 窗口与主进程出站请求（net.fetch）共用；更新器 session 与
  // electron-updater 库内 fromPartition 同名同对象。主进程不解析代理，只消费决策。
  const proxyDecisionApplier = createProxyDecisionApplier({
    getProxySessionTargets: () => [
      session.defaultSession,
      session.fromPartition(UPDATER_SESSION_PARTITION, { cache: false }),
    ],
    log: (level, message, meta) => {
      if (level === "warn") {
        console.warn(message, meta);
      } else {
        console.log(message, meta);
      }
    },
  });

  // 手动档代理含 user:pass 时 Chromium proxyRules 不解析凭据，由代理质询（authInfo.isProxy）
  // 经 app 'login' 回填最近一次决策的凭据；非代理质询一律按取消处理（与无监听时的
  // 默认行为一致，不改变网站 401 流程）。
  app.on("login", (_event, _webContents, _authenticationResponseDetails, authInfo, callback) => {
    if (!authInfo.isProxy) {
      callback();
      return;
    }
    const credentials = extractProxyCredentials(proxyDecisionApplier.getLatestDecision());
    if (credentials === null) {
      callback();
      return;
    }
    callback(credentials.username, credentials.password);
  });

  const normalizeProjectScope = (projectPath: string | null | undefined) =>
    typeof projectPath === "string" && projectPath.trim()
      ? projectPath.trim()
      : "";

  /**
   * 向 backend 发送全量 scope 同步（ProjectScopeSyncMessage）。
   * 在 backend (re)listening 时调用，确保 backend 影子表与 coordinator 一致。
   */
  const replayProjectScopes = () => {
    const scopes = coordinator.getAllScopes();
    if (scopes.length === 0) return;
    if (
      backendProcess !== null &&
      backendProcess !== undefined &&
      backendProcess.send !== null &&
      backendProcess.send !== undefined
    ) {
      backendProcess.send({
        type: "runtime:project-scope-sync",
        scopes,
      });
      console.log("[desktop-runtime] replayProjectScopes -> sync", {
        scopeCount: scopes.length,
      });
    }
  };

  const readUnknownJson = async (response: Response): Promise<unknown> => {
    return response
      .json()
      .then((value: unknown) => value)
      .catch((): null => null);
  };

  const probeHubLocalWriteTrust = async (origin: string) => {
    const base = origin.trim().replace(/\/+$/, "");
    if (!base || typeof fetch !== "function") {
      return { ok: false, url: "", error: "fetch not available" };
    }
    const url = `${base}/api/hub/local-write-trust/probe`;
    try {
      const response = await fetch(url, {
        method: "GET",
        cache: "no-store",
        headers: {
          [HUB_LOCAL_WRITE_TOKEN_HEADER]: hubWriteToken,
        },
      });
      const payload: unknown = await readUnknownJson(response);
      if (!response.ok) {
        return { ok: false, url, status: response.status, payload };
      }
      const parsed = HubLocalWriteTrustProbeResponseSchema.safeParse(payload);
      return parsed.success
        ? { ok: true, url, status: response.status }
        : { ok: false, url, status: response.status, payload };
    } catch (error) {
      return { ok: false, url, error: toErrorMessage(error) };
    }
  };

  const startBackend = () => {
    if (backendReady) return backendReady;
    backendReady = new Promise((resolve, reject) => {
      const backendEntry = resolveBackendEntry();
      if (!fs.existsSync(backendEntry)) {
        backendReady = null;
        reject(new Error(`Backend entry not found: ${backendEntry}`));
        return;
      }
      const env = cloneDesktopEnv();
      env.IART_HUB_DEV_URL = undefined;
      env.IART_HUB_STATIC_DIR = undefined;
      env.IART_DEV_EDITOR_URL = undefined;
      env.IART_EDITOR_STATIC_DIR = resolveEditorStaticRoot();
      env.IART_APP_VERSION = env.IART_APP_VERSION || resolveAppVersion();
      env.IART_SQLITE_RUNTIME = "electron";
      env[HUB_LOCAL_WRITE_TOKEN_ENV] = hubWriteToken;
      cleanupLegacyModelAssetSyncedDirectory(app.getPath("userData"));
      injectModelAssetPackagesDir(env, app.isPackaged);
      const bootstrap = resolveDesktopBackendRuntimeBootstrap({
        env,
        backendPortHint,
        backendBaseUrl: undefined,
        gatewayPortHint: undefined,
      });
      backendPortHint = bootstrap.backendPort;
      Object.assign(env, bootstrap.envOverrides);
      void probeHttpHealth(bootstrap.backendBaseUrl).then(async (health) => {
        const trust = health.ok
          ? await probeHubLocalWriteTrust(bootstrap.backendBaseUrl)
          : { ok: false, url: "" };
        if (health.ok && trust.ok) {
          backendBaseUrl = bootstrap.backendBaseUrl;
          replayProjectScopes();
          if (
            recoverHubWindow !== null &&
            recoverHubWindow !== undefined
          ) {
            recoverHubWindow();
          }
          resolve(backendBaseUrl);
          return;
        }
        if (health.ok && !trust.ok) {
          backendReady = null;
          reject(
            new Error(
              "当前 Backend 端口已被非本次 Desktop Shell 信任域实例占用，请退出旧实例后重试",
            ),
          );
          return;
        }
        backendProcess = fork(backendEntry, [], {
          env,
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        });
        const startupGuard = attachChildProcessStartupGuard(backendProcess, {
          processName: "Backend",
          reject,
          onProcessExited: () => {
            backendProcess = null;
            backendReady = null;
            backendBaseUrl = null;
          },
        });
        backendProcess.on("message", (message: unknown) => {
          try {
            const msg = asRuntimeMessageCandidate(message);
            if (!msg) return;
            if (handleStorageMessage(msg)) return;
            if (
              msg.type === "media-assets:changed" ||
              msg.type === "task:state-changed" ||
              msg.type === "task:state-snapshot"
            ) {
              const parsed =
                msg.type === "media-assets:changed"
                  ? MediaAssetsChangedNotificationSchema.safeParse(msg)
                  : msg.type === "task:state-changed"
                    ? TaskStateNotificationSchema.safeParse(msg)
                    : TaskStateSnapshotSchema.safeParse(msg);
              if (!parsed.success) {
                console.warn("[desktop-runtime] invalid backend notification", msg.type);
                return;
              }
              if (
                taskForwarder !== null &&
                taskForwarder !== undefined
              ) {
                taskForwarder(parsed.data as RuntimeMessageCandidate);
              }
              return;
            }
            if (msg.type === "proxy:decision-changed") {
              const parsed = ProxyDecisionNotificationSchema.safeParse(msg);
              if (!parsed.success) {
                console.warn("[desktop-runtime] invalid backend notification", msg.type);
                return;
              }
              void proxyDecisionApplier.apply(parsed.data.decision);
              return;
            }
            // 凭证加解密（spec 03 §5.1）：Backend 是纯 Node fork 子进程、禁止 import('electron')，
            // 由 Desktop Main（本进程）用 electron.safeStorage 提供 OS 级凭证加解密能力。
            // 请求-响应用 transactionId 关联，经 sendResult 回传（与 storage runtime:read-* 同模式）。
            // **不设超时**（AGENTS.md「远端请求与项目内接口不设超时」）。
            if (msg.type === "runtime:credential-crypto-encrypt") {
              const parsed = CredentialCryptoEncryptPayloadSchema.safeParse(msg);
              if (!parsed.success) {
                console.warn("[desktop-runtime] invalid runtime:credential-crypto-encrypt payload", parsed.error);
                sendResult(
                  typeof msg.transactionId === "string" ? msg.transactionId : "",
                  { success: false, error: "invalid runtime:credential-crypto-encrypt payload" },
                );
                return;
              }
              const payload = parsed.data;
              try {
                if (!safeStorage.isEncryptionAvailable()) {
                  console.warn("[desktop-runtime] runtime:credential-crypto-encrypt: safeStorage unavailable");
                  sendResult(payload.transactionId, { success: false, error: "safeStorage unavailable" });
                  return;
                }
                const encrypted = safeStorage.encryptString(payload.value);
                sendResult(payload.transactionId, {
                  success: true,
                  data: { encryptedBase64: encrypted.toString("base64") },
                });
              } catch (error) {
                sendResult(payload.transactionId, {
                  success: false,
                  error: toErrorMessage(error),
                });
              }
              return;
            }
            if (msg.type === "runtime:credential-crypto-decrypt") {
              const parsed = CredentialCryptoDecryptPayloadSchema.safeParse(msg);
              if (!parsed.success) {
                console.warn("[desktop-runtime] invalid runtime:credential-crypto-decrypt payload", parsed.error);
                sendResult(
                  typeof msg.transactionId === "string" ? msg.transactionId : "",
                  { success: false, error: "invalid runtime:credential-crypto-decrypt payload" },
                );
                return;
              }
              const payload = parsed.data;
              try {
                if (!safeStorage.isEncryptionAvailable()) {
                  console.warn("[desktop-runtime] runtime:credential-crypto-decrypt: safeStorage unavailable");
                  sendResult(payload.transactionId, { success: false, error: "safeStorage unavailable" });
                  return;
                }
                const plaintext = safeStorage.decryptString(Buffer.from(payload.encryptedBase64, "base64"));
                sendResult(payload.transactionId, {
                  success: true,
                  data: { plaintext },
                });
              } catch (error) {
                sendResult(payload.transactionId, {
                  success: false,
                  error: toErrorMessage(error),
                });
              }
              return;
            }
            if (msg.type === "runtime:credential-crypto-available") {
              const parsed = CredentialCryptoAvailablePayloadSchema.safeParse(msg);
              if (!parsed.success) {
                console.warn("[desktop-runtime] invalid runtime:credential-crypto-available payload", parsed.error);
                sendResult(
                  typeof msg.transactionId === "string" ? msg.transactionId : "",
                  { success: false, error: "invalid runtime:credential-crypto-available payload" },
                );
                return;
              }
              const payload = parsed.data;
              try {
                sendResult(payload.transactionId, {
                  success: true,
                  data: { available: safeStorage.isEncryptionAvailable() },
                });
              } catch (error) {
                sendResult(payload.transactionId, {
                  success: false,
                  error: toErrorMessage(error),
                });
              }
              return;
            }
            if (msg.type === "listening") {
              startupGuard.markStartupSettled();
              backendBaseUrl =
                typeof msg.baseUrl === "string"
                  ? msg.baseUrl
                  : msg.port
                    ? `http://127.0.0.1:${msg.port}`
                    : bootstrap.backendBaseUrl;
              backendPortHint =
                typeof msg.port === "number" ? msg.port : backendPortHint;
              replayProjectScopes();
              if (
                recoverHubWindow !== null &&
                recoverHubWindow !== undefined
              ) {
                recoverHubWindow();
              }
              resolve(backendBaseUrl);
              return;
            }
            if (msg.type === "startup-error") {
              startupGuard.markStartupSettled();
              const code = typeof msg.code === "string" ? msg.code : "unknown";
              const detail = getStringField(msg, "message") || "startup failed";
              reject(new Error(`Backend startup failed (${code}): ${detail}`));
            }
          } catch (error) {
            console.error("[desktop-runtime] unhandled error in backend message handler", error);
            const msg = asRuntimeMessageCandidate(message);
            const txId = msg !== null && typeof msg.transactionId === "string"
              ? msg.transactionId
              : "";
            if (txId) {
              sendResult(txId, { success: false, error: "internal error in message handler" });
            } else {
              console.error("[desktop-runtime] unhandled error but cannot extract transactionId from message");
            }
          }
        });
      });
    });
    return backendReady;
  };

  const stopBackend = () => {
    if (
      backendProcess !== null &&
      backendProcess !== undefined &&
      backendProcess.send !== null &&
      backendProcess.send !== undefined
    ) {
      backendProcess.send({ type: "shutdown" });
    }
    if (
      backendProcess !== null &&
      backendProcess !== undefined &&
      backendProcess.kill !== null &&
      backendProcess.kill !== undefined
    ) {
      backendProcess.kill();
    }
    backendProcess = null;
    backendReady = null;
    backendBaseUrl = null;
  };

  return {
    get backendBaseUrl() {
      return backendBaseUrl;
    },
    get backendReady() {
      return backendReady;
    },
    get hubWriteToken() {
      return hubWriteToken;
    },
    setTaskForwarder: (
      forwarder: (message: RuntimeMessageCandidate) => void,
    ) => {
      taskForwarder = forwarder;
    },
    setRecoverHubWindow: (recover: () => void) => {
      recoverHubWindow = recover;
    },
    /**
     * 窗口聚焦保鲜触发（spec docs/runtime/远端请求执行治理原则.md「代理治理」）：
     * 请求 backend 重新解析系统代理。fire-and-forget；backend 检出变化才推回新决策。
     * backend 未运行时静默（sendRuntimeMessage 内部判空）。
     */
    requestProxyRefresh: () => {
      sendRuntimeMessage({ type: "runtime:refresh-proxy" });
    },
    /**
     * 注册项目 scope 到 coordinator。
     * coordinator 的 onScopeRegistered 事件回调（由 bootstrap 绑定到 sendToBackend）
     * 会向 backend 发送 ProjectScopeRegisterMessage 增量同步。
     * 幂等：同一 projectPath 重复注册不会重复发消息。
     */
    registerProjectScope: (projectPath: string | null | undefined) => {
      const normalized = normalizeProjectScope(projectPath);
      if (!normalized) {
        console.warn("[desktop-runtime] registerProjectScope skipped: invalid path", { projectPath: typeof projectPath === 'string' ? projectPath.slice(0, 80) : typeof projectPath });
        return;
      }
      const entry = coordinator.registerScope(normalized);
      if (entry === null) {
        console.warn("[desktop-runtime] registerProjectScope: coordinator registerScope returned null", { projectPath: normalized.slice(-60) });
      }
    },
    /**
     * 注销项目 scope（仅当无活跃 session 时真正清除）。
     * coordinator 的 onScopeUnregistered 事件回调会向 backend 发送 ProjectScopeUnregisterMessage。
     */
    unregisterProjectScope: (stableProjectId: string) => {
      coordinator.unregisterScopeIfIdle(stableProjectId);
    },
    /**
     * 暴露给 coordinator events 绑定的 IPC 发送句柄。
     */
    sendToBackend,
    startBackend,
    stopBackend,
  };
};
