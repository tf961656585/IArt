import type {
  MainToBackendMessage,
  RuntimeTransactionPayload,
  TaskEventPayload,
  RuntimeTransactionResult,
  MediaAssetsChangedNotification,
  TaskStateNotification,
  TaskStateSnapshot,
  ProxyDecisionNotification,
  ReadTasksPayload,
  ReadTaskByIdPayload,
  ReadBatchByIdPayload,
  ReadTaskOutputsPayload,
  ReadMediaAssetsByTaskPayload,
  ReadMediaAssetByIdPayload,
  ReadAllMediaAssetsPayload,
  ReadAgentMessagesPayload,
  DeleteTaskPayload,
  CredentialCryptoEncryptPayload,
  CredentialCryptoDecryptPayload,
  CredentialCryptoAvailablePayload,
} from '@iart/contracts';
import {
  RuntimeTransactionResultSchema,
  CredentialCryptoEncryptResultSchema,
  CredentialCryptoDecryptResultSchema,
  CredentialCryptoAvailableResultSchema,
} from '@iart/contracts';
import * as loggingModule from './logging.cts';
import type { UnifiedGenerationStatus } from '@iart/contracts';

// 项目内接口（Backend↔Main Process IPC）一律不设超时（AGENTS.md「远端请求与项目内接口不设超时」）。
// pendingRequests 只保留 transactionId 关联的 resolve/reject：reject 仅由 disconnect/exit 与
// process.send 回调 error 触发，没有任何计时器或清理路径。
const pendingRequests = new Map<
  string,
  {
    resolve: (result: RuntimeTransactionResult) => void;
    reject: (error: Error) => void;
  }
>();

const rejectPendingRequest = (transactionId: string, error: Error) => {
  const pending = pendingRequests.get(transactionId);
  if (!pending) return;
  pendingRequests.delete(transactionId);
  pending.reject(error);
};

const rejectAllPendingRequests = (error: Error) => {
  if (pendingRequests.size === 0) return;
  const pendingEntries = [...pendingRequests.entries()];
  pendingRequests.clear();
  for (const [, pending] of pendingEntries) {
    pending.reject(error);
  }
};

if (process.send) {
  process.on('message', (message: MainToBackendMessage) => {
    const parsed = RuntimeTransactionResultSchema.safeParse(message);
    if (!parsed.success) return;
    const transactionResult = parsed.data;

    const pending = pendingRequests.get(transactionResult.transactionId);
    if (!pending) return;

    pendingRequests.delete(transactionResult.transactionId);
    pending.resolve(transactionResult);
  });

  process.on('disconnect', () => {
    rejectAllPendingRequests(new Error('Backend IPC channel disconnected'));
  });

  process.on('exit', () => {
    rejectAllPendingRequests(new Error('Backend process exited before IPC reply'));
  });
}

let transactionCounter = 0;

/** Backend→Main 请求-响应类 IPC 消息全集（storage 读写 / 凭证加解密）。 */
type BackendIpcRequestMessage =
  | RuntimeTransactionPayload
  | TaskEventPayload
  | ReadTasksPayload
  | ReadTaskByIdPayload
  | ReadBatchByIdPayload
  | ReadTaskOutputsPayload
  | ReadMediaAssetsByTaskPayload
  | ReadMediaAssetByIdPayload
  | ReadAllMediaAssetsPayload
  | ReadAgentMessagesPayload
  | DeleteTaskPayload
  | CredentialCryptoEncryptPayload
  | CredentialCryptoDecryptPayload
  | CredentialCryptoAvailablePayload;

let backendIpcTestHandler:
  | ((message: BackendIpcRequestMessage) => Promise<RuntimeTransactionResult>)
  | null = null;

const generateTransactionId = () => `txn_${Date.now()}_${++transactionCounter}`;

/**
 * Backend→Main 请求-响应 IPC 唯一发送路径。
 *
 * **严格不设超时**（AGENTS.md「远端请求与项目内接口不设超时」）：reply 只靠 transactionId 关联；
 * reject 仅由 disconnect/exit 与 process.send 回调 error 触发，不设计时器。
 */
const sendIpcMessage = (
  message: BackendIpcRequestMessage,
): Promise<RuntimeTransactionResult> => {
  if (backendIpcTestHandler) {
    return backendIpcTestHandler(message);
  }
  return new Promise((resolve, reject) => {
    if (!process.send) {
      reject(new Error('process.send is not available — not running as forked child'));
      return;
    }

    const transactionId = message.transactionId;
    pendingRequests.set(transactionId, { resolve, reject });
    try {
      process.send(message, undefined, undefined, (error: Error | null) => {
        if (error) rejectPendingRequest(transactionId, error);
      });
    } catch (error) {
      rejectPendingRequest(
        transactionId,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  });
};

export const setBackendIpcTestHandler = (
  handler: ((message: BackendIpcRequestMessage) => Promise<RuntimeTransactionResult>) | null,
): void => {
  backendIpcTestHandler = handler;
};

export const sendRuntimeTransaction = (
  payload: Omit<RuntimeTransactionPayload, 'type' | 'transactionId'>,
): Promise<RuntimeTransactionResult> => {
  return sendIpcMessage({
    ...payload,
    type: 'runtime:execute-transaction',
    transactionId: generateTransactionId(),
  });
};

export const sendTaskEvent = (
  payload: Omit<TaskEventPayload, 'type' | 'transactionId'>,
): Promise<RuntimeTransactionResult> => {
  return sendIpcMessage({
    ...payload,
    type: 'runtime:write-task-event',
    transactionId: generateTransactionId(),
  });
};

export const sendTaskStateNotification = (notification: TaskStateNotification): void => {
  if (!process.send) return;
  try {
    process.send(notification);
  } catch {
    // fire-and-forget
  }
};

export const sendTaskStateSnapshot = (snapshot: TaskStateSnapshot): void => {
  if (!process.send) return;
  try {
    process.send(snapshot);
  } catch {
    // fire-and-forget
  }
};

export const sendMediaAssetsChangedNotification = (notification: MediaAssetsChangedNotification): void => {
  if (!process.send) return;
  try {
    process.send(notification);
  } catch {
    // fire-and-forget
  }
};

/**
 * 生效代理决策推送（spec docs/runtime/远端请求执行治理原则.md「代理治理」）。
 * fire-and-forget：主进程消费决策应用 session 代理；发送失败静默丢弃（下个触发点重推）。
 */
export const sendProxyDecisionNotification = (notification: ProxyDecisionNotification): void => {
  if (!process.send) return;
  try {
    process.send(notification);
  } catch {
    // fire-and-forget
  }
};

export const sendReadTasks = (
  payload: {
    projectPath: string;
    status: UnifiedGenerationStatus | null | undefined;
    limit: number | null | undefined;
    offset: number | null | undefined;
  },
): Promise<RuntimeTransactionResult> => {
  const message = {
    type: 'runtime:read-tasks' as const,
    transactionId: generateTransactionId(),
    projectPath: payload.projectPath,
  };
  return sendIpcMessage({
    ...message,
    ...(payload.status == null ? {} : { status: payload.status }),
    ...(payload.limit == null ? {} : { limit: payload.limit }),
    ...(payload.offset == null ? {} : { offset: payload.offset }),
  });
};

export const sendReadTaskById = (
  payload: {
    projectPath: string;
    taskId: string;
  },
): Promise<RuntimeTransactionResult> => {
  return sendIpcMessage({
    type: 'runtime:read-task-by-id',
    transactionId: generateTransactionId(),
    projectPath: payload.projectPath,
    taskId: payload.taskId,
  });
};

export const sendReadBatchById = (
  payload: {
    projectPath: string;
    batchId: string;
  },
): Promise<RuntimeTransactionResult> => {
  return sendIpcMessage({
    type: 'runtime:read-batch-by-id',
    transactionId: generateTransactionId(),
    projectPath: payload.projectPath,
    batchId: payload.batchId,
  });
};

export const sendReadTaskOutputs = (
  payload: {
    projectPath: string;
    taskId: string;
  },
): Promise<RuntimeTransactionResult> => {
  return sendIpcMessage({
    type: 'runtime:read-task-outputs',
    transactionId: generateTransactionId(),
    projectPath: payload.projectPath,
    taskId: payload.taskId,
  });
};

export const sendReadMediaAssetsByTask = (
  payload: {
    projectPath: string;
    taskId: string;
  },
): Promise<RuntimeTransactionResult> => {
  return sendIpcMessage({
    type: 'runtime:read-media-assets-by-task',
    transactionId: generateTransactionId(),
    projectPath: payload.projectPath,
    taskId: payload.taskId,
  });
};

export const sendReadMediaAssetById = (
  payload: {
    projectPath: string;
    assetId: string;
  },
): Promise<RuntimeTransactionResult> => {
  return sendIpcMessage({
    type: 'runtime:read-media-asset-by-id',
    transactionId: generateTransactionId(),
    projectPath: payload.projectPath,
    assetId: payload.assetId,
  });
};

export const sendReadAllMediaAssets = (
  payload: {
    projectPath: string;
  },
): Promise<RuntimeTransactionResult> => {
  return sendIpcMessage({
    type: 'runtime:read-all-media-assets',
    transactionId: generateTransactionId(),
    projectPath: payload.projectPath,
  });
};

/**
 * 读取 agent 会话正式历史（Backend → Main，供 `agent:submit_prompt` 执行前加载上下文）。
 *
 * 结果经 RuntimeTransactionResult.data 返回 `AgentMessageRecord[]`（按 seq 升序），
 * 消费端（agent-execution）以 `AgentMessageRecordSchema` 数组解析后再投影；
 * 本函数只负责发送与超时口径，不做数据解释。
 */
export const sendReadAgentMessages = (
  payload: {
    projectPath: string;
    agentSessionId: string;
  },
): Promise<RuntimeTransactionResult> => {
  return sendIpcMessage({
    type: 'runtime:read-agent-messages',
    transactionId: generateTransactionId(),
    projectPath: payload.projectPath,
    agentSessionId: payload.agentSessionId,
  });
};

export const sendDeleteTask = (
  payload: {
    projectPath: string;
    taskId: string;
  },
): Promise<RuntimeTransactionResult> => {
  return sendIpcMessage({
    type: 'runtime:delete-task',
    transactionId: generateTransactionId(),
    projectPath: payload.projectPath,
    taskId: payload.taskId,
  });
};

// ==================== 凭证加解密请求（Desktop Main safeStorage 宿主能力） ====================
//
// spec 03 §5.1：真实 API Key 只进入操作系统安全凭证存储；Desktop Main 持有 electron.safeStorage
// （主进程能力），Backend 是纯 Node fork 子进程、禁止 import('electron')。Backend 经
// runtime:credential-crypto-* 请求-响应通道向 Desktop Main 借道加解密
// （packages/contracts credential-crypto-ipc.ts）。
//
// **严格不设超时**（AGENTS.md「远端请求与项目内接口不设超时」）：复用 sendIpcMessage
// 的无超时发送路径，IPC reply 关联靠 transactionId。

/**
 * 请求 Desktop Main 用 electron.safeStorage 加密明文（spec 03 §5.1）。
 * 成功返回 base64 密文；safeStorage 不可用 / 注入失败 / IPC 失败返回 null（调用方回退 0600 文件 base64）。
 */
export const credentialCryptoEncrypt = async (value: string): Promise<string | null> => {
  const message: CredentialCryptoEncryptPayload = {
    type: 'runtime:credential-crypto-encrypt',
    transactionId: generateTransactionId(),
    value,
  };
  try {
    const result = await sendIpcMessage(message);
    if (!result.success) {
      loggingModule.logDebug('[backend-ipc] credentialCryptoEncrypt unsuccessful', { error: result.error });
      return null;
    }
    const parsed = CredentialCryptoEncryptResultSchema.safeParse(result.data);
    if (!parsed.success) {
      loggingModule.logDebug('[backend-ipc] credentialCryptoEncrypt invalid data', { error: parsed.error.toString() });
      return null;
    }
    return parsed.data.encryptedBase64;
  } catch (error) {
    loggingModule.logDebug('[backend-ipc] credentialCryptoEncrypt failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
};

/**
 * 请求 Desktop Main 用 electron.safeStorage 解密 base64 密文。
 * 成功返回明文字符串；safeStorage 不可用 / 注入失败 / IPC 失败返回 null（调用方回退 0600 文件 base64）。
 */
export const credentialCryptoDecrypt = async (encryptedBase64: string): Promise<string | null> => {
  const message: CredentialCryptoDecryptPayload = {
    type: 'runtime:credential-crypto-decrypt',
    transactionId: generateTransactionId(),
    encryptedBase64,
  };
  try {
    const result = await sendIpcMessage(message);
    if (!result.success) {
      loggingModule.logDebug('[backend-ipc] credentialCryptoDecrypt unsuccessful', { error: result.error });
      return null;
    }
    const parsed = CredentialCryptoDecryptResultSchema.safeParse(result.data);
    if (!parsed.success) {
      loggingModule.logDebug('[backend-ipc] credentialCryptoDecrypt invalid data', { error: parsed.error.toString() });
      return null;
    }
    return parsed.data.plaintext;
  } catch (error) {
    loggingModule.logDebug('[backend-ipc] credentialCryptoDecrypt failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
};

/**
 * 查询 Desktop Main 的 electron.safeStorage 是否可用。
 * IPC 失败视为不可用（false），调用方回退 0600 文件方案。
 */
export const credentialCryptoIsAvailable = async (): Promise<boolean> => {
  const message: CredentialCryptoAvailablePayload = {
    type: 'runtime:credential-crypto-available',
    transactionId: generateTransactionId(),
  };
  try {
    const result = await sendIpcMessage(message);
    if (!result.success) return false;
    const parsed = CredentialCryptoAvailableResultSchema.safeParse(result.data);
    if (!parsed.success) return false;
    return parsed.data.available;
  } catch {
    return false;
  }
};
