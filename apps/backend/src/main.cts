import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { HOST } from './local-server/constants.cjs';
import { resolveListenPort } from './local-server/config-store.cjs';
import { ensureStorageDirs } from './local-server/storage.cjs';
import { initFetchDispatcher, rebuildFetchDispatcher } from './local-server/fetch-dispatcher.cjs';
import { getProjectIndex } from './local-server/project-store.cjs';
import { logInfo, logError } from './local-server/logging.cjs';
import * as routerModule from './local-server/router.cjs';
import * as businessActionsModule from './local-server/business-actions.cjs';
import * as taskEngineModule from './local-server/task-engine.cjs';
import * as backendIpcSenderModule from './local-server/backend-ipc-sender.cjs';
import {
  registerRuntimeProjectScope,
  registerGlobalMediaScope,
  syncProjectScope,
  syncAllProjectScopes,
  removeProjectScope,
} from './local-server/project-media-scope.cjs';
import storageRootHints = require('@iart/utils/storage-root-hints');
import {
  reconcileProjectThumbnails,
  scheduleProjectThumbnailRepair,
} from './local-server/thumbnail-reconcile-service.cjs';
import { loadRuntimeEnv } from './runtime-env-loader.cjs';
import { writeSkillRuntimeConfig } from './local-server/skill-runtime/skill-runtime-config-store.cts';
import {
  setCredentialCryptoProvider,
} from './local-server/provider-connection/credential-store.cjs';
import type { CredentialCrypto } from './local-server/provider-connection/credential-store.cjs';
import type { RuntimeMediaAssetView, RuntimeTaskOutputRow, RuntimeTaskView } from '@iart/contracts';
import {
  ProjectScopeRegisterMessageSchema,
  ProjectScopeUnregisterMessageSchema,
  ProjectScopeSyncMessageSchema,
  ProxyRefreshRequestSchema,
} from '@iart/contracts';
import { buildTaskStateSnapshotPayload } from './runtime-snapshot-builder.cjs';

interface RouterModule {
  createRequestHandler: (options: { baseDir: string; editorStaticRoot: string | null }) => http.RequestListener;
  setServerPort: (port: number | null) => void;
}

interface BusinessActionsModule {
  attachBusinessActionWebSocketServer: (server: http.Server) => void;
}

interface TaskEngineModule {
  resumeIncompletePollingTasks: (options: { projectPath: string | undefined; limit: number | undefined }) => Promise<void>;
  isTaskFinalStatus: (status: string) => boolean;
  normalizeTaskStatus: (status: unknown) => string;
  cancelTaskExecution: () => void;
}

interface BackendIpcSenderModule {
  sendTaskStateSnapshot: (payload: unknown) => void;
  sendReadTasks: (payload: { projectPath: string; status: string | null | undefined; limit: number | null | undefined; offset: number | null | undefined }) => Promise<{ success: boolean | undefined; data: unknown | undefined; error: unknown | undefined }>;
  sendReadTaskOutputs: (payload: { projectPath: string; taskId: string }) => Promise<{ success: boolean | undefined; data: unknown | undefined; error: unknown | undefined }>;
  sendReadMediaAssetsByTask: (payload: { projectPath: string; taskId: string }) => Promise<{ success: boolean | undefined; data: unknown | undefined; error: unknown | undefined }>;
}

type DynamicModuleNamespace = Record<string, unknown>;

function castModule<T>(mod: DynamicModuleNamespace): T {
  return mod as T;
}

const typedRouter = castModule<RouterModule>(routerModule);
const typedBusinessActions = castModule<BusinessActionsModule>(businessActionsModule);
const typedTaskEngine = castModule<TaskEngineModule>(taskEngineModule);
const typedBackendIpcSender = castModule<BackendIpcSenderModule>(backendIpcSenderModule);

const normalizeString = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : '';

const { createRequestHandler, setServerPort } = typedRouter;
const {
  attachBusinessActionWebSocketServer,
} = typedBusinessActions;
const activeProjectScopes = new Set<string>();

loadRuntimeEnv();

// ---- 网络代理 dispatcher 初始化（Hub「设置 → 网络代理」）----
// 按 backend.json 的 proxyMode/proxyUrl 异步重建出站 dispatcher（system 模式需探测 OS 代理）。
// 完成前请求按直连执行；失败保守回落直连（fetch-dispatcher.cts 内部留痕）。
void initFetchDispatcher().catch(() => undefined);

// ---- 凭证加解密宿主能力接线（spec 03 §5.1）----
// Backend 是纯 Node fork 子进程、禁止 import('electron')（guard:desktop-runtime-deps）。
// Desktop Main 持有 electron.safeStorage（主进程能力），Backend 经 runtime:credential-crypto-*
// 请求-响应通道借道加解密（backend-ipc-sender.cts）。进程 fork 模式下（process.send 存在）
// 注入 IPC 版 CredentialCrypto；纯 Node 单测/CI 下（无 process.send）保持 null → 0600 文件 fallback。
const installCredentialCryptoProvider = (): void => {
  if (typeof process.send !== 'function') {
    logInfo('credential-crypto: not running as forked child, keep 0600 file fallback', undefined);
    return;
  }
  const { credentialCryptoEncrypt, credentialCryptoDecrypt, credentialCryptoIsAvailable } = backendIpcSenderModule;
  const provider: CredentialCrypto = {
    encryptString: async (value: string): Promise<Buffer> => {
      const encryptedBase64 = await credentialCryptoEncrypt(value);
      if (encryptedBase64 === null) {
        throw new Error('credential-crypto-encrypt unavailable (safeStorage not ready)');
      }
      return Buffer.from(encryptedBase64, 'base64');
    },
    decryptString: async (buffer: Buffer): Promise<string> => {
      const plaintext = await credentialCryptoDecrypt(buffer.toString('base64'));
      if (plaintext === null) {
        throw new Error('credential-crypto-decrypt unavailable (safeStorage not ready)');
      }
      return plaintext;
    },
    isEncryptionAvailable: async (): Promise<boolean> => credentialCryptoIsAvailable(),
  };
  setCredentialCryptoProvider(provider);
  logInfo('credential-crypto: injected IPC safeStorage provider', undefined);
};
installCredentialCryptoProvider();

// 注册 __global__ scope，使 local-media://__global__/... URL 可解析
const storageRoot = storageRootHints.resolveDefaultStorageRoot();
registerGlobalMediaScope(path.join(storageRoot, 'media'));

const PORT = resolveListenPort();
const resolveEditorStaticRoot = (baseDir: string) => {
  const configured = typeof process.env['IART_EDITOR_STATIC_DIR'] === 'string'
    ? process.env['IART_EDITOR_STATIC_DIR'].trim()
    : '';
  const candidates = [
    configured,
    path.resolve(baseDir, '..', '..', 'editor', 'dist-static'),
    path.resolve(baseDir, '..', '..', '..', 'editor', 'dist-static'),
    path.resolve(process.cwd(), 'apps', 'editor', 'dist-static'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const indexPath = path.join(candidate, 'index.html');
    if (fs.existsSync(indexPath)) {
      return candidate;
    }
  }
  return configured || null;
};

const handler = createRequestHandler({
  baseDir: __dirname,
  editorStaticRoot: resolveEditorStaticRoot(__dirname),
});
const server = http.createServer(handler);
let backendStartupSettled = false;
attachBusinessActionWebSocketServer(server);

const formatErrorForLog = (value: unknown) => {
  if (value instanceof Error) {
    return String(value.stack || value.message || value);
  }
  return String(value);
};

const reportFatal = (kind: string, errorLike: unknown) => {
  const error = formatErrorForLog(errorLike);
  try {
    logError(kind, { error });
  } catch {
    // ignore
  }
};

// 避免因未捕获异常导致本地后台进程退出（Hub 将表现为"连接中断/导入失败"）
process.on('uncaughtException', (error) => {
  reportFatal('uncaughtException', error);
});
process.on('unhandledRejection', (reason) => {
  reportFatal('unhandledRejection', reason);
});

const readArrayData = <T,>(result: { data: unknown | undefined } | null | undefined): T[] =>
  Array.isArray(result !== null && result !== undefined ? result.data : undefined) ? (result !== null && result !== undefined ? result.data : []) as T[] : [];

const resumeIncompleteTasksForProject = async (projectPath: string) => {
  const { resumeIncompletePollingTasks, isTaskFinalStatus, normalizeTaskStatus } = typedTaskEngine;
  const { sendTaskStateSnapshot, sendReadTasks, sendReadTaskOutputs, sendReadMediaAssetsByTask } = typedBackendIpcSender;
  const resolvedProjectPath = normalizeString(projectPath);
  if (!resolvedProjectPath) return;

  try {
    if (typeof resumeIncompletePollingTasks === 'function') {
      await resumeIncompletePollingTasks({ projectPath: resolvedProjectPath, limit: 200 });
    }
  } catch {
    // ignore
  }

  try {
    if (typeof sendTaskStateSnapshot !== 'function') return;
    const readTasksResult = await sendReadTasks({
      projectPath: resolvedProjectPath,
      status: null,
      limit: 1000,
      offset: 0,
    });
    const tasks = readArrayData<RuntimeTaskView>(readTasksResult).filter((record) => {
      return !isTaskFinalStatus(normalizeTaskStatus((record !== null && record !== undefined ? record.status : undefined)));
    });
    if (tasks.length === 0) return;

    const taskOutputsByTaskId: Record<string, RuntimeTaskOutputRow[]> = {};
    const mediaAssetsByTaskId: Record<string, RuntimeMediaAssetView[]> = {};
    for (const task of tasks) {
      const taskId = normalizeString(task.taskId);
      if (!taskId) continue;
      const [outputsResult, mediaAssetsResult] = await Promise.all([
        sendReadTaskOutputs({ projectPath: resolvedProjectPath, taskId }),
        sendReadMediaAssetsByTask({ projectPath: resolvedProjectPath, taskId }),
      ]);
      taskOutputsByTaskId[taskId] = readArrayData<RuntimeTaskOutputRow>(outputsResult);
      mediaAssetsByTaskId[taskId] = readArrayData<RuntimeMediaAssetView>(mediaAssetsResult);
    }

    const snapshot = buildTaskStateSnapshotPayload({
      projectPath: resolvedProjectPath,
      tasks,
      taskOutputsByTaskId,
      mediaAssetsByTaskId,
      normalizeTaskStatus,
      isTaskFinalStatus,
    });
    if (snapshot) sendTaskStateSnapshot(snapshot);
  } catch {
    // snapshot 发送失败不阻断启动
  }
};

const reconcileRuntimeProjectThumbnails = async (projectPath: string, reason: string) => {
  const resolvedProjectPath = normalizeString(projectPath);
  if (!resolvedProjectPath) return;
  try {
    await reconcileProjectThumbnails(resolvedProjectPath);
    scheduleProjectThumbnailRepair(resolvedProjectPath, reason);
  } catch (error) {
    logError('thumbnail reconcile failed during project scope open', {
      projectPath: resolvedProjectPath,
      reason,
      error: formatErrorForLog(error),
    });
  }
};

const resumeIncompleteTasks = async () => {
  if (activeProjectScopes.size === 0) {
    try {
      logInfo('backend runtime snapshot skipped: no project scope registered', undefined);
    } catch {
      // ignore
    }
    return;
  }
  for (const projectPath of activeProjectScopes) {
    await resumeIncompleteTasksForProject(projectPath);
  }
};

/**
 * 处理 Desktop Shell → Backend 的 scope 同步消息。
 *
 * 三种消息类型（contracts Zod schema 校验，替代旧 `as` 断言）：
 * - runtime:project-scope-register: 增量注册单个 scope
 * - runtime:project-scope-sync: 全量同步（backend 重启后恢复影子表）
 * - runtime:project-scope-unregister: 移除 scope
 *
 * register/sync 会触发缩略图恢复与未完成任务续跑。
 * 返回 true 表示消息已消费，false 表示非 scope 消息（交由后续 handler）。
 */
const handleProjectScopeMessage = (rawMessage: unknown): boolean => {
  if (rawMessage === null || typeof rawMessage !== 'object') return false;
  const message = rawMessage as { type: unknown };
  const type = typeof message.type === 'string' ? message.type : '';

  if (type === 'runtime:project-scope-register') {
    const parsed = ProjectScopeRegisterMessageSchema.safeParse(rawMessage);
    if (!parsed.success) {
      logError('backend project scope register: invalid message', { error: parsed.error.message });
      return true;
    }
    const { projectPath, projectRef, stableProjectId } = parsed.data;
    syncProjectScope({ stableProjectId, projectPath, projectRef });
    activeProjectScopes.add(projectPath);
    void (async () => {
      await reconcileRuntimeProjectThumbnails(projectPath, 'project_scope_registered');
      await resumeIncompleteTasksForProject(projectPath);
    })();
    return true;
  }

  if (type === 'runtime:project-scope-sync') {
    const parsed = ProjectScopeSyncMessageSchema.safeParse(rawMessage);
    if (!parsed.success) {
      logError('backend project scope sync: invalid message', { error: parsed.error.message });
      return true;
    }
    syncAllProjectScopes(parsed.data.scopes);
    for (const scope of parsed.data.scopes) {
      activeProjectScopes.add(scope.projectPath);
    }
    logInfo('backend project scope sync applied', { scopeCount: parsed.data.scopes.length });
    return true;
  }

  if (type === 'runtime:project-scope-unregister') {
    const parsed = ProjectScopeUnregisterMessageSchema.safeParse(rawMessage);
    if (!parsed.success) {
      logError('backend project scope unregister: invalid message', { error: parsed.error.message });
      return true;
    }
    removeProjectScope(parsed.data.stableProjectId);
    return true;
  }

  // 兼容旧 runtime:project-scope-opened 消息（desktop-shell 旧版本可能仍发送）
  if (type === 'runtime:project-scope-opened') {
    const legacyMessage = rawMessage as { projectPath: unknown };
    const projectPath = normalizeString(legacyMessage.projectPath);
    if (projectPath) {
      registerRuntimeProjectScope(projectPath);
      activeProjectScopes.add(projectPath);
      void (async () => {
        await reconcileRuntimeProjectThumbnails(projectPath, 'project_scope_opened_legacy');
        await resumeIncompleteTasksForProject(projectPath);
      })();
    }
    return true;
  }

  return false;
};

const shutdown = () => {
  try {
    const { cancelTaskExecution } = typedTaskEngine;
    if (typeof cancelTaskExecution === 'function') {
      // Shutdown 只需要取消已知的 in-flight tasks，
      // 不再通过 listTaskRecords 扫描文件系统
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  } catch {
    process.exit(0);
  }
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('message', (message) => {
  if (handleProjectScopeMessage(message)) {
    return;
  }
  // 窗口聚焦保鲜触发（spec docs/runtime/远端请求执行治理原则.md「代理治理」）：
  // 主进程请求重新解析系统代理；非跟随系统档位下解析结果不变、不推送（dedupe）。
  const parsedProxyRefresh = ProxyRefreshRequestSchema.safeParse(message);
  if (parsedProxyRefresh.success) {
    void rebuildFetchDispatcher('focus-refresh').catch(() => undefined);
    return;
  }
  const shutdownMessage = message as { type: string | undefined } | null;
  if (shutdownMessage && shutdownMessage.type === 'shutdown') {
    shutdown();
  }
});
process.on('disconnect', shutdown);

server.on('error', (error) => {
  const code = typeof ((error as NodeJS.ErrnoException) !== null && (error as NodeJS.ErrnoException) !== undefined ? (error as NodeJS.ErrnoException).code : undefined) === 'string'
    ? (error as NodeJS.ErrnoException).code
    : null;
  const message = error instanceof Error ? error.message : String(error);
  if (!backendStartupSettled) {
    reportFatal('server.listen.failed', error);
    if (typeof process.send === 'function') {
      process.send({
        type: 'startup-error',
        phase: 'listen',
        code,
        message,
      });
    }
    const exitTimer = setTimeout(() => process.exit(1), 0);
    exitTimer.unref();
    return;
  }
  reportFatal('server.error', error);
});

server.listen({ host: HOST, port: PORT }, () => {
  backendStartupSettled = true;
  const address = server.address();
  const serverPort = typeof address === 'object' && address ? address.port : null;
  setServerPort(serverPort);
  const baseUrl = serverPort ? `http://${HOST}:${serverPort}` : null;
  try {
    ensureStorageDirs();
    getProjectIndex();
  } catch {
    // ignore
  }
  logInfo('backend listening', { port: serverPort, baseUrl });
  if (typeof process.send === 'function') {
    process.send({ type: 'listening', port: serverPort, baseUrl });
  }

  // skill 运行时配置文件刷新触发点：listen 回调后端口确定，写入真实端口。
  // spec docs/hub/skill-store.md：端口漂移由该机制解决。
  // 刷新为异步（需异步读取服务商凭证明文）；失败只记日志，不阻塞监听。
  void writeSkillRuntimeConfig(serverPort).catch((error: unknown) => {
    logInfo('skill-runtime: refresh on listen failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  // Hub 重启后自动续跑未完成的 Task
  setTimeout(() => {
    void resumeIncompleteTasks();
  }, 500).unref();
});
