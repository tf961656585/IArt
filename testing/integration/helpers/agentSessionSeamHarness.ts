/**
 * Agent 受理主链接缝测试的传输/存储/项目替身（`agent.sessionSeam.test.ts` 专用）。
 *
 * 被测两端仍是真实实现，这里只提供最外层替身与加载桥：
 * - `WebSocket`：假传输层，把 Editor 真实 `AgentSocketClient` 写出的原始 JSON 帧喂给
 *   Backend 真实 `handleAgentMessage`，并把 Backend 写出的原始 JSON 帧回灌 Editor。
 * - `window.electron.storage`：P 组 7 通道内存替身（seq 分配、messageCount 与 lastMessageAt
 *   维护、读取语义对齐契约），保持「Editor 写入 → Backend 读历史」的读后写关系。
 * - Backend→Main IPC：走既有 `setBackendIpcTestHandler` 注入点接同一内存替身。
 * - 「已打开项目」：经 backend project-media-scope 真实 scope 注册表建立（临时目录下的最小合法项目）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Buffer as NodeBuffer } from 'node:buffer';
import { TextEncoder as NodeTextEncoder } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  AgentMessageRecordSchema,
  AgentToolCallRecordSchema,
  EDITOR_STORAGE_IPC_CHANNELS,
  StorageAppendAgentMessageParamsSchema,
  StorageAppendAgentSendRecordParamsSchema,
  StorageAppendAgentToolCallParamsSchema,
  StorageReadAgentMessagesParamsSchema,
  StorageReadAgentSendRecordsParamsSchema,
  StorageReadAgentSessionByNodeIdParamsSchema,
  StorageReadAgentSessionsParamsSchema,
  StorageReadAgentToolCallsParamsSchema,
  StorageUpdateAgentToolCallParamsSchema,
  StorageUpsertAgentSessionParamsSchema,
  type AgentMessageRecord,
  type AgentSendRecord,
  type AgentSessionRecord,
  type AgentToolCallRecord,
  type ChatMessageContent,
  type ReadAgentMessagesPayload,
  type RuntimeTransactionResult,
} from '@iart/contracts';

import { cjsRequireAs } from './cjs-mock';

const HELPER_FILE_PATH = fileURLToPath(import.meta.url);

// ── Backend 真实实现的加载桥 ──

/**
 * backend 是 `.cts` 源码（导入路径写 `.cjs`，由 TS 的 .cts→.cjs 映射解析），vitest 的 vite
 * 管线不转译 `.cts`，因此经 tsx 的作用域 CJS require 在进程内加载：来源仍是 apps/backend/src
 * 下的真实源码（不是 dist 产物），保证测的是当前实现。
 */
export type BackendCoreParams = {
  requestId: string;
  sessionId: string;
  modelId: string;
  thinkingTier: string;
  messages: Array<{ role: string; content: ChatMessageContent }>;
  /** 本轮声明的工具清单（轮数上限后为 undefined，spec 04「工具调用循环语义」）。 */
  tools?: Array<{ name: string }>;
  abortSignal: AbortSignal;
  onToken: (delta: string) => void;
  onModelConfigResolved?: () => void;
};

export type BackendCoreResult = {
  message: {
    content: ChatMessageContent;
    /** 模型请求的工具调用（中间轮；循环据此推进到工具执行）。 */
    toolCalls?: Array<{ id: string; name: string; argsJson: string }>;
  };
};

export type CoreBehavior = (params: BackendCoreParams) => Promise<BackendCoreResult>;

export type WireFrame = { raw: string; payload: unknown };

export type StorageCallLog = { channel: string; params: unknown };

export type Gate = { promise: Promise<void>; open: () => void };

type BackendBusinessClient = {
  ws: { OPEN: number; readyState: number; send: (payload: string) => void; on: () => void };
  actionIds: Set<string>;
  taskIds: Set<string>;
  closed: boolean;
};

type BackendAgentExecutionModule = {
  handleAgentMessage: (client: BackendBusinessClient, raw: unknown) => void;
  __test_only__: {
    setCoreExecutorForTests: (executor: CoreBehavior | null) => void;
    clearForTests: () => void;
  };
};

type BackendIpcSenderModule = {
  setBackendIpcTestHandler: (
    handler: ((message: unknown) => Promise<RuntimeTransactionResult>) | null,
  ) => void;
};

type BackendProjectStoreModule = {
  createProjectFolder: (
    parentDir: string,
    projectName: string,
  ) => { projectPath?: string; error?: string } | null;
};

type BackendProjectMediaScopeModule = {
  syncProjectScope: (entry: {
    stableProjectId: string;
    projectPath: string;
    projectRef: string;
  }) => unknown;
  clearRuntimeProjectScopesForTest: () => void;
};

export type MemoryStorageStub = {
  calls: StorageCallLog[];
  sessions: Map<string, AgentSessionRecord>;
  messages: Map<string, AgentMessageRecord[]>;
  sendRecords: Map<string, AgentSendRecord[]>;
  toolCalls: Map<string, AgentToolCallRecord[]>;
  reset: () => void;
  callsOf: (channel: string) => StorageCallLog[];
  readMessages: (projectPath: string, agentSessionId: string) => AgentMessageRecord[];
};

export type AgentSessionSeam = {
  wire: { outbound: WireFrame[]; inbound: WireFrame[] };
  memoryStorage: MemoryStorageStub;
  core: {
    calls: BackendCoreParams[];
    installSequence: (behaviors: CoreBehavior[]) => void;
    clear: () => void;
    historyReadRequests: Array<{ projectPath: string; agentSessionId: string }>;
    installHistoryReader: () => void;
  };
  /** 经 backend project-store 真实状态机把临时目录下的项目置为「已打开」。 */
  createOpenedProject: (projectName: string) => string;
  /** 每用例复位（wire / 存储替身 / 假 core / 历史读取替身）。 */
  reset: () => void;
  /** 进程级资源回收：还原 WebSocket 全局、删除临时目录与数据根。 */
  teardown: () => void;
};

/** Node realm 的 `Uint8Array` 构造器（jsdom 暴露的全局 `Uint8Array` 属于另一 realm）。 */
const resolveNodeUint8Array = (): Uint8ArrayConstructor => {
  const bufferPrototype: unknown = Object.getPrototypeOf(NodeBuffer.prototype);
  return (bufferPrototype as { constructor: Uint8ArrayConstructor }).constructor;
};

/** 临时数据根：backend 的 logging / config 均按 `IART_STORAGE_ROOT` 定位，不触真实用户目录。 */
const createDataRoot = (): string => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-seam-data-root-'));
  process.env['IART_STORAGE_ROOT'] = dataRoot;
  return dataRoot;
};

export const createAgentSessionSeam = async (): Promise<AgentSessionSeam> => {
  // esbuild（tsx 的转译器）自检 `new TextEncoder().encode("") instanceof Uint8Array`；
  // jsdom 的 TextEncoder / Uint8Array 属另一 realm，会把该自检判假，故两个全局都换成 Node realm 实现。
  globalThis.Uint8Array = resolveNodeUint8Array();
  globalThis.TextEncoder = NodeTextEncoder;

  const dataRoot = createDataRoot();
  const tsx = await import('tsx/cjs/api');
  const scoped = tsx.register({ namespace: 'agent-session-seam' });
  const sourcePath = (...segments: string[]): string =>
    path.join(process.cwd(), 'apps', 'backend', 'src', 'local-server', ...segments);
  let backend: {
    execution: BackendAgentExecutionModule;
    ipcSender: BackendIpcSenderModule;
    projectStore: BackendProjectStoreModule;
    projectMediaScope: BackendProjectMediaScopeModule;
  };
  try {
    backend = {
      execution: cjsRequireAs<BackendAgentExecutionModule>(
        scoped.require(sourcePath('agent-execution.cts'), HELPER_FILE_PATH),
      ),
      ipcSender: cjsRequireAs<BackendIpcSenderModule>(
        scoped.require(sourcePath('backend-ipc-sender.cts'), HELPER_FILE_PATH),
      ),
      projectStore: cjsRequireAs<BackendProjectStoreModule>(
        scoped.require(sourcePath('project-store.cts'), HELPER_FILE_PATH),
      ),
      projectMediaScope: cjsRequireAs<BackendProjectMediaScopeModule>(
        scoped.require(sourcePath('project-media-scope.cts'), HELPER_FILE_PATH),
      ),
    };
  } finally {
    // 模块已进 require cache：注销钩子只影响后续 require，不影响已加载的 backend 实现。
    scoped.unregister();
  }

  // ── 假 WS 传输层：Editor 真实 AgentSocketClient ⇄ Backend 真实 handleAgentMessage ──

  const wire = {
    /** Editor → Backend 的原始帧（真实 socket 写出的 JSON 字符串）。 */
    outbound: [] as WireFrame[],
    /** Backend → Editor 的原始帧。 */
    inbound: [] as WireFrame[],
  };
  const editorSockets: SeamWebSocketStub[] = [];

  class SeamWebSocketStub {
    static readonly OPEN = 1;
    static readonly CLOSED = 3;
    readonly OPEN = 1;
    readonly url: string;
    readyState: number = SeamWebSocketStub.OPEN;
    private readonly listeners = new Map<string, Set<(event: { data?: string }) => void>>();

    constructor(url: string) {
      this.url = url;
      editorSockets.push(this);
      // 建连成功：`AgentSocketClient` 在 open 后 flush outbox（真实时序，不是同步伪造）。
      queueMicrotask(() => {
        this.dispatch('open', {});
      });
    }

    addEventListener(type: string, listener: (event: { data?: string }) => void): void {
      const set = this.listeners.get(type) ?? new Set();
      set.add(listener);
      this.listeners.set(type, set);
    }

    removeEventListener(type: string, listener: (event: { data?: string }) => void): void {
      this.listeners.get(type)?.delete(listener);
    }

    /** Editor 出站：原始 JSON 字符串即 WS 帧；同时按 WS 边界（序列化再解析）喂给 Backend 入口。 */
    send(raw: string): void {
      wire.outbound.push({ raw, payload: JSON.parse(raw) as unknown });
      backend.execution.handleAgentMessage(backendClient, JSON.parse(raw) as unknown);
    }

    close(): void {
      this.readyState = SeamWebSocketStub.CLOSED;
      this.dispatch('close', {});
    }

    receiveFromBackend(payload: string): void {
      this.dispatch('message', { data: payload });
    }

    private dispatch(type: string, event: { data?: string }): void {
      for (const listener of this.listeners.get(type) ?? []) {
        listener(event);
      }
    }
  }

  /** Backend 侧 client：send 的载荷即 Backend 真实实现写出的 JSON 帧。 */
  const backendClient: BackendBusinessClient = {
    ws: {
      OPEN: 1,
      readyState: 1,
      send: (payload: string): void => {
        wire.inbound.push({ raw: payload, payload: JSON.parse(payload) as unknown });
        for (const socket of editorSockets) {
          socket.receiveFromBackend(payload);
        }
      },
      on: () => undefined,
    },
    actionIds: new Set<string>(),
    taskIds: new Set<string>(),
    closed: false,
  };

  const originalWebSocketDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  Object.defineProperty(globalThis, 'WebSocket', {
    value: SeamWebSocketStub,
    configurable: true,
    writable: true,
  });

  // ── 内存存储替身（window.electron.storage，P 组 7 通道） ──

  const scopeKey = (projectPath: string, id: string): string => `${projectPath}\u0000${id}`;

  const memoryStorage: MemoryStorageStub = {
    calls: [],
    sessions: new Map<string, AgentSessionRecord>(),
    messages: new Map<string, AgentMessageRecord[]>(),
    sendRecords: new Map<string, AgentSendRecord[]>(),
    toolCalls: new Map<string, AgentToolCallRecord[]>(),
    reset(): void {
      memoryStorage.calls.length = 0;
      memoryStorage.sessions.clear();
      memoryStorage.messages.clear();
      memoryStorage.sendRecords.clear();
      memoryStorage.toolCalls.clear();
    },
    callsOf(channel: string): StorageCallLog[] {
      return memoryStorage.calls.filter((call) => call.channel === channel);
    },
    readMessages(projectPath: string, agentSessionId: string): AgentMessageRecord[] {
      return [...(memoryStorage.messages.get(scopeKey(projectPath, agentSessionId)) ?? [])];
    },
  };

  const readSession = (projectPath: string, agentSessionId: string): AgentSessionRecord | null =>
    memoryStorage.sessions.get(scopeKey(projectPath, agentSessionId)) ?? null;

  /** 通道封装：入参过契约 schema（写入调用日志）后再交给内存实现，出参按 P 组结果形状回包。 */
  const storageChannel = <T>(
    channel: string,
    schema: { parse: (value: unknown) => T },
    handle: (params: T) => Promise<unknown>,
  ): ((args: unknown) => Promise<unknown>) => {
    return async (args) => {
      const params = schema.parse(args);
      memoryStorage.calls.push({ channel, params });
      return handle(params);
    };
  };

  const storageBridge: Record<string, (args: unknown) => Promise<unknown>> = {
    [EDITOR_STORAGE_IPC_CHANNELS.READ_AGENT_SESSIONS]: storageChannel(
      EDITOR_STORAGE_IPC_CHANNELS.READ_AGENT_SESSIONS,
      StorageReadAgentSessionsParamsSchema,
      async (params) => ({
        sessions: [...memoryStorage.sessions.entries()]
          .filter(([key]) => key.startsWith(`${params.projectPath}\u0000`))
          .map(([, session]) => session),
      }),
    ),
    [EDITOR_STORAGE_IPC_CHANNELS.READ_AGENT_SESSION_BY_NODE_ID]: storageChannel(
      EDITOR_STORAGE_IPC_CHANNELS.READ_AGENT_SESSION_BY_NODE_ID,
      StorageReadAgentSessionByNodeIdParamsSchema,
      async (params) => ({
        session:
          [...memoryStorage.sessions.entries()]
            .filter(([key]) => key.startsWith(`${params.projectPath}\u0000`))
            .map(([, record]) => record)
            .find((record) => record.nodeId === params.nodeId) ?? null,
      }),
    ),
    [EDITOR_STORAGE_IPC_CHANNELS.UPSERT_AGENT_SESSION]: storageChannel(
      EDITOR_STORAGE_IPC_CHANNELS.UPSERT_AGENT_SESSION,
      StorageUpsertAgentSessionParamsSchema,
      async (params) => {
        memoryStorage.sessions.set(
          scopeKey(params.projectPath, params.session.agentSessionId),
          params.session,
        );
        return { session: params.session };
      },
    ),
    [EDITOR_STORAGE_IPC_CHANNELS.READ_AGENT_MESSAGES]: storageChannel(
      EDITOR_STORAGE_IPC_CHANNELS.READ_AGENT_MESSAGES,
      StorageReadAgentMessagesParamsSchema,
      async (params) => ({
        messages: memoryStorage.readMessages(params.projectPath, params.agentSessionId),
      }),
    ),
    [EDITOR_STORAGE_IPC_CHANNELS.APPEND_AGENT_MESSAGE]: storageChannel(
      EDITOR_STORAGE_IPC_CHANNELS.APPEND_AGENT_MESSAGE,
      StorageAppendAgentMessageParamsSchema,
      async (params) => {
        const key = scopeKey(params.projectPath, params.message.agentSessionId);
        const existing = memoryStorage.messages.get(key) ?? [];
        // seq 与 messageCount 由存储写入端维护（替身保持同一契约）。
        const record = AgentMessageRecordSchema.parse({
          ...params.message,
          seq: existing.length + 1,
        });
        memoryStorage.messages.set(key, [...existing, record]);
        const session = readSession(params.projectPath, params.message.agentSessionId);
        if (session) {
          memoryStorage.sessions.set(key, {
            ...session,
            messageCount: existing.length + 1,
            updatedAt: record.createdAt,
            // 与生产写入端（editor-storage-agent-writer.appendAgentMessage）同语义：
            // 同一事务推进「最后一条正式消息时间」，取单调更大值（补写历史消息不回退）。
            lastMessageAt:
              session.lastMessageAt === null
                ? record.createdAt
                : Math.max(session.lastMessageAt, record.createdAt),
          });
        }
        return { message: record };
      },
    ),
    [EDITOR_STORAGE_IPC_CHANNELS.APPEND_AGENT_SEND_RECORD]: storageChannel(
      EDITOR_STORAGE_IPC_CHANNELS.APPEND_AGENT_SEND_RECORD,
      StorageAppendAgentSendRecordParamsSchema,
      async (params) => {
        const key = scopeKey(params.projectPath, params.sendRecord.agentSessionId);
        memoryStorage.sendRecords.set(key, [
          ...(memoryStorage.sendRecords.get(key) ?? []),
          params.sendRecord,
        ]);
        return { sendRecord: params.sendRecord };
      },
    ),
    [EDITOR_STORAGE_IPC_CHANNELS.READ_AGENT_SEND_RECORDS]: storageChannel(
      EDITOR_STORAGE_IPC_CHANNELS.READ_AGENT_SEND_RECORDS,
      StorageReadAgentSendRecordsParamsSchema,
      async (params) => ({
        sendRecords: [
          ...(memoryStorage.sendRecords.get(
            scopeKey(params.projectPath, params.agentSessionId),
          ) ?? []),
        ],
      }),
    ),
    // 工具调用记录（seq 分配语义与生产写入端一致：会话内单调递增，独立于消息 seq）。
    [EDITOR_STORAGE_IPC_CHANNELS.READ_AGENT_TOOL_CALLS]: storageChannel(
      EDITOR_STORAGE_IPC_CHANNELS.READ_AGENT_TOOL_CALLS,
      StorageReadAgentToolCallsParamsSchema,
      async (params) => ({
        toolCalls: [
          ...(memoryStorage.toolCalls.get(scopeKey(params.projectPath, params.agentSessionId)) ?? []),
        ],
      }),
    ),
    [EDITOR_STORAGE_IPC_CHANNELS.APPEND_AGENT_TOOL_CALL]: storageChannel(
      EDITOR_STORAGE_IPC_CHANNELS.APPEND_AGENT_TOOL_CALL,
      StorageAppendAgentToolCallParamsSchema,
      async (params) => {
        const key = scopeKey(params.projectPath, params.toolCall.agentSessionId);
        const existing = memoryStorage.toolCalls.get(key) ?? [];
        const record = AgentToolCallRecordSchema.parse({
          ...params.toolCall,
          seq: existing.length + 1,
        });
        memoryStorage.toolCalls.set(key, [...existing, record]);
        return { toolCall: record };
      },
    ),
    [EDITOR_STORAGE_IPC_CHANNELS.UPDATE_AGENT_TOOL_CALL]: storageChannel(
      EDITOR_STORAGE_IPC_CHANNELS.UPDATE_AGENT_TOOL_CALL,
      StorageUpdateAgentToolCallParamsSchema,
      async (params) => {
        const key = scopeKey(params.projectPath, params.update.agentSessionId);
        const existing = memoryStorage.toolCalls.get(key) ?? [];
        const target = existing.find((record) => record.toolCallId === params.update.toolCallId);
        if (target === undefined) return { toolCall: null };
        const updated = AgentToolCallRecordSchema.parse({
          ...target,
          status: params.update.status,
          ...(params.update.batchId !== undefined ? { batchId: params.update.batchId } : {}),
          ...(params.update.taskIds !== undefined ? { taskIds: params.update.taskIds } : {}),
          ...(params.update.assetIds !== undefined ? { assetIds: params.update.assetIds } : {}),
          ...(params.update.errorSummary !== undefined
            ? { errorSummary: params.update.errorSummary }
            : {}),
          updatedAt: Date.now(),
        });
        memoryStorage.toolCalls.set(
          key,
          existing.map((record) =>
            record.toolCallId === params.update.toolCallId ? updated : record,
          ),
        );
        return { toolCall: updated };
      },
    ),
  };

  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { storage: storageBridge },
  });

  // ── Backend 侧假 core 与历史读取替身 ──

  const coreCalls: BackendCoreParams[] = [];
  const historyReadRequests: Array<{ projectPath: string; agentSessionId: string }> = [];

  const installHistoryReader = (): void => {
    historyReadRequests.length = 0;
    backend.ipcSender.setBackendIpcTestHandler(async (message: unknown) => {
      const payload = message as Partial<ReadAgentMessagesPayload> & { transactionId?: string };
      if (payload.type !== 'runtime:read-agent-messages') {
        throw new Error(`unexpected backend ipc message: ${String(payload.type)}`);
      }
      const projectPath = String(payload.projectPath ?? '');
      const agentSessionId = String(payload.agentSessionId ?? '');
      historyReadRequests.push({ projectPath, agentSessionId });
      return {
        type: 'runtime:transaction-result',
        transactionId: String(payload.transactionId ?? ''),
        success: true,
        data: memoryStorage.readMessages(projectPath, agentSessionId),
      };
    });
  };
  installHistoryReader();

  const temporaryDirs: string[] = [];

  return {
    wire,
    memoryStorage,
    core: {
      calls: coreCalls,
      installSequence: (behaviors: CoreBehavior[]): void => {
        coreCalls.length = 0;
        let callIndex = 0;
        backend.execution.__test_only__.setCoreExecutorForTests(async (params) => {
          // 快照拷贝：循环复用同一 messages 数组实例逐轮追加，调用点捕获的是当轮切片。
          coreCalls.push({ ...params, messages: [...params.messages] });
          const behavior = behaviors[Math.min(callIndex, behaviors.length - 1)];
          callIndex += 1;
          if (!behavior) throw new Error('core behavior is not configured');
          return behavior(params);
        });
      },
      clear: (): void => {
        backend.execution.__test_only__.clearForTests();
      },
      historyReadRequests,
      installHistoryReader,
    },
    createOpenedProject: (projectName: string): string => {
      const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-seam-project-'));
      temporaryDirs.push(parentDir);
      const created = backend.projectStore.createProjectFolder(parentDir, projectName);
      if (!created || !created.projectPath) {
        throw new Error('project folder creation failed');
      }
      const projectPath = created.projectPath;
      fs.writeFileSync(
        path.join(projectPath, 'manifest.json'),
        JSON.stringify({ version: 1, name: projectName }),
        'utf-8',
      );
      // 与生产同表：经 runtime:project-scope-register 同步的 scope 注册表（V2 spid + V1 ref 双索引）。
      const projectRef = `prj_${crypto.randomBytes(16).toString('hex').slice(0, 32)}`;
      const synced = backend.projectMediaScope.syncProjectScope({
        stableProjectId: `spid_${crypto.randomBytes(12).toString('hex')}`,
        projectPath,
        projectRef,
      });
      if (!synced) throw new Error('project scope register failed');
      return projectPath;
    },
    reset: (): void => {
      memoryStorage.reset();
      wire.outbound.length = 0;
      wire.inbound.length = 0;
      coreCalls.length = 0;
      installHistoryReader();
      backend.execution.__test_only__.clearForTests();
    },
    teardown: (): void => {
      if (originalWebSocketDescriptor) {
        Object.defineProperty(globalThis, 'WebSocket', originalWebSocketDescriptor);
      }
      backend.projectMediaScope.clearRuntimeProjectScopesForTest();
      fs.rmSync(dataRoot, { recursive: true, force: true });
      for (const dir of temporaryDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  };
};

/** 一次性 gate：`open()` 前 `promise` 不落定（用于制造确定的流式窗口）。 */
export const createGate = (): Gate => {
  const gate: Gate = { promise: Promise.resolve(), open: () => undefined };
  gate.promise = new Promise<void>((resolve) => {
    gate.open = resolve;
  });
  return gate;
};

let fakeMessageSeq = 0;

/** 引擎真实返回形状：assistant 消息带 role / messageId / createdAt。 */
const fakeAssistantMessage = (
  content: ChatMessageContent,
  toolCalls?: Array<{ id: string; name: string; argsJson: string }>,
): { role: 'assistant'; content: ChatMessageContent; createdAt: number; toolCalls?: Array<{ id: string; name: string; argsJson: string }> } => {
  fakeMessageSeq += 1;
  return {
    role: 'assistant',
    content,
    createdAt: Date.now() + fakeMessageSeq,
    ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
  };
};

export const assistantResult = (content: ChatMessageContent): BackendCoreResult => ({
  message: fakeAssistantMessage(content),
});

/** 中间轮结果：助手消息携带工具调用（工具循环据此推进到执行编排）。 */
export const toolCallResult = (
  content: ChatMessageContent,
  toolCalls: Array<{ id: string; name: string; argsJson: string }>,
): BackendCoreResult => ({
  message: fakeAssistantMessage(content, toolCalls),
});

export const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
  throw new Error(`waitFor timed out: ${label}`);
};
