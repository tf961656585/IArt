import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentAccepted,
  AgentComplete,
  AgentError,
  AgentMessageAppendParams,
  AgentMessageRecord,
  AgentSendRecord,
  AgentSessionRecord,
  AgentSubmitPrompt,
  AgentToken,
} from '@iart/contracts';
import { AGENT_WS_MESSAGE_TYPE } from '@iart/contracts';
import type { AgentNodeData, GraphNode } from '@/features/canvas/types/node';
import {
  runNodeRemovalPreflight,
  unregisterNodeRemovalPreflight,
} from '@/features/canvas/store/internal/nodeRemovalPreflight';

/**
 * 删除 Agent 节点：先在途终止再删除 + 作废后事件收口（spec docs/agent/02「撤销重做与删除」）。
 *
 * 覆盖：
 * - 画布删除咽喉的前置钩子注册与触发（同步派发 `agent:cancel`、立即作废会话）；
 * - 幂等注册（重复注册不叠加，一次删除只派发一次取消）；
 * - 删除后残留的 `agent:accepted` / `agent:token` / `agent:complete` 被丢弃：
 *   不产生任何 storage 写调用、不产生用户可见错误；
 * - 作废后同一 nodeId 的新会话可正常创建与受理（守卫不误伤正常路径）。
 */

type SocketHandlers = {
  onAccepted: (message: AgentAccepted) => void;
  onToken: (message: AgentToken) => void;
  onComplete: (message: AgentComplete) => void;
  onError: (message: AgentError) => void;
};

const h = vi.hoisted(() => {
  const log: string[] = [];
  const nodes: GraphNode<AgentNodeData>[] = [];
  const canvas = {
    nodeGraph: {
      id: 'graph-1',
      nodes,
      viewport: { x: 0, y: 0, zoom: 1 },
    },
    ui: { canvasContainerSize: null },
    addNode: vi.fn(
      (
        _key: string,
        _position: { x: number; y: number },
        customData: unknown,
      ): GraphNode<AgentNodeData> | null => {
        log.push('add-node');
        const node = {
          id: `agent-node-${canvas.nodeGraph.nodes.length + 1}`,
          type: 'agent' as const,
          position: { x: 0, y: 0 },
          data: customData as AgentNodeData,
          draggable: true,
          size: undefined,
          style: undefined,
          groupId: undefined,
        };
        canvas.nodeGraph.nodes.push(node);
        return node;
      },
    ),
    projectSelectionContract: vi.fn<(selection: { selectedNodeIds: string[] }) => void>(),
  };
  const storage = {
    readAgentSessions: vi.fn<(projectPath: string) => Promise<AgentSessionRecord[]>>(),
    readAgentSessionByNodeId:
      vi.fn<(projectPath: string, nodeId: string) => Promise<AgentSessionRecord | null>>(),
    upsertAgentSession:
      vi.fn<(projectPath: string, session: AgentSessionRecord) => Promise<AgentSessionRecord>>(),
    readAgentMessages:
      vi.fn<(projectPath: string, agentSessionId: string) => Promise<AgentMessageRecord[]>>(),
    appendAgentMessage:
      vi.fn<
        (projectPath: string, message: AgentMessageAppendParams) => Promise<AgentMessageRecord>
      >(),
    appendAgentSendRecord:
      vi.fn<(projectPath: string, sendRecord: AgentSendRecord) => Promise<AgentSendRecord>>(),
    readAgentSendRecords:
      vi.fn<(projectPath: string, agentSessionId: string) => Promise<AgentSendRecord[]>>(),
  };
  const socket = {
    subscribe: vi.fn<(handlers: SocketHandlers) => () => void>(() => () => undefined),
    sendSubmitPrompt: vi.fn<(message: AgentSubmitPrompt) => void>(),
    sendCancel:
      vi.fn<(message: { type: string; agentSessionId: string; requestId: string }) => void>(),
    isConnected: vi.fn(() => true),
    disconnect: vi.fn(),
  };
  return { log, canvas, storage, socket };
});

const canvasState = h.canvas;
const storageMocks = h.storage;
const socketMocks = h.socket;
const callLog: string[] = h.log;

vi.mock('@/features/canvas/store/canvasStore', () => ({
  useCanvasStore: {
    getState: () => h.canvas,
  },
}));

vi.mock('@/client/store/runtimeStore', () => ({
  getRuntimeProjectPath: () => null,
  getRuntimeBackendBaseUrl: () => null,
}));

vi.mock('../agentSessionStorage', () => ({
  agentSessionStorage: h.storage,
  readAgentSessions: h.storage.readAgentSessions,
  readAgentSessionByNodeId: h.storage.readAgentSessionByNodeId,
  upsertAgentSession: h.storage.upsertAgentSession,
  readAgentMessages: h.storage.readAgentMessages,
  appendAgentMessage: h.storage.appendAgentMessage,
  appendAgentSendRecord: h.storage.appendAgentSendRecord,
  readAgentSendRecords: h.storage.readAgentSendRecords,
}));

vi.mock('../agentSocket', () => ({
  agentSocket: h.socket,
  AgentSocketClient: class {},
  isAgentWsMessageType: () => true,
}));

import {
  cancelAndForgetAgentSessions,
  ensureAgentNodeRemovalPreflightRegistered,
  loadAgentSessions,
  submitAgentPrompt,
  useAgentSessionStore,
} from '../agentSessionStore';

const socketHandlers: SocketHandlers = (() => {
  const call = socketMocks.subscribe.mock.calls[0];
  if (!call) throw new Error('agent socket handlers not registered');
  return call[0];
})();

let requestSeq = 0;
const nextRequestId = (): string => `req-removal-${(requestSeq += 1)}`;

const submitInput = (overrides: Record<string, unknown> = {}) => ({
  requestId: nextRequestId(),
  agentSessionId: 'sess-1',
  nodeId: null as string | null,
  modelId: 'llm-fast-1',
  thinkingTier: 'off',
  approvalMode: 'confirm' as const,
  content: '帮我把这张图改成夜景',
  referenceAssetIds: [],
  referenceAssets: [],
  ...overrides,
});

/** 发提交 → 受理：得到「已建会话 + 在途请求」的稳定起点。 */
const seedAcceptedSession = async (
  overrides: Record<string, unknown> = {},
): Promise<string> => {
  await loadAgentSessions('/proj');
  socketMocks.sendSubmitPrompt.mockImplementation(() => {
    callLog.push('socket-submit');
  });
  const input = submitInput(overrides);
  const pending = submitAgentPrompt(input);
  await vi.waitFor(() => {
    expect(socketMocks.sendSubmitPrompt).toHaveBeenCalled();
  });
  socketHandlers.onAccepted({
    type: AGENT_WS_MESSAGE_TYPE.ACCEPTED,
    requestId: input.requestId,
    agentSessionId: 'sess-1',
  });
  await pending;
  callLog.length = 0;
  vi.clearAllMocks();
  socketMocks.sendSubmitPrompt.mockImplementation(() => {
    callLog.push('socket-submit');
  });
  return input.requestId;
};

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  callLog.length = 0;
  canvasState.nodeGraph.nodes = [];
  useAgentSessionStore.getState().reset();
  unregisterNodeRemovalPreflight();

  storageMocks.readAgentSessions.mockResolvedValue([]);
  storageMocks.readAgentSessionByNodeId.mockResolvedValue(null);
  storageMocks.readAgentMessages.mockResolvedValue([]);
  storageMocks.readAgentSendRecords.mockResolvedValue([]);
  storageMocks.appendAgentSendRecord.mockImplementation(async (_path, record) => {
    callLog.push('append-send-record');
    return record;
  });
  storageMocks.appendAgentMessage.mockImplementation(async (_path, message) => {
    callLog.push(`append-message:${message.role}${message.isPartial ? ':partial' : ''}`);
    return { ...message, seq: callLog.length };
  });
  storageMocks.upsertAgentSession.mockImplementation(async (_path, session) => {
    callLog.push('upsert-session');
    return session;
  });
});

describe('删除 Agent 节点：咽喉前置钩子注册与在途终止', () => {
  it('注册后：画布删除咽喉触发即同步派发 agent:cancel 并把会话作废', async () => {
    ensureAgentNodeRemovalPreflightRegistered();
    const requestId = await seedAcceptedSession();
    expect(useAgentSessionStore.getState().sessionsById['sess-1']).toBeTruthy();

    const handled = runNodeRemovalPreflight(['agent-node-1']);

    expect(handled).toBe(true);
    expect(socketMocks.sendCancel).toHaveBeenCalledWith({
      type: AGENT_WS_MESSAGE_TYPE.CANCEL,
      agentSessionId: 'sess-1',
      requestId,
      toolCallId: null,
    });
    const state = useAgentSessionStore.getState();
    // 同步作废：元数据 / 节点引用 / 消息缓存 / 留痕 / 流式 / 在途 / 错误态一并摘除
    expect(state.sessionsById['sess-1']).toBeUndefined();
    expect(state.sessionIdByNodeId['agent-node-1']).toBeUndefined();
    expect(state.messagesBySessionId['sess-1']).toBeUndefined();
    expect(state.sendRecordsBySessionId['sess-1']).toBeUndefined();
    expect(state.streamingBySessionId['sess-1']).toBeUndefined();
    expect(state.inFlightBySessionId['sess-1']).toBeUndefined();
    expect(state.errorsBySessionId['sess-1']).toBeUndefined();
  });

  it('幂等注册：重复注册不叠加，一次删除只派发一次取消', async () => {
    ensureAgentNodeRemovalPreflightRegistered();
    ensureAgentNodeRemovalPreflightRegistered();
    ensureAgentNodeRemovalPreflightRegistered();
    await seedAcceptedSession();

    runNodeRemovalPreflight(['agent-node-1']);

    expect(socketMocks.sendCancel).toHaveBeenCalledTimes(1);
  });

  it('非 Agent 节点：不发取消、不动会话，且不阻断删除', async () => {
    ensureAgentNodeRemovalPreflightRegistered();
    await seedAcceptedSession();

    runNodeRemovalPreflight(['plain-node']);

    expect(socketMocks.sendCancel).not.toHaveBeenCalled();
    expect(useAgentSessionStore.getState().sessionsById['sess-1']).toBeTruthy();
  });

  it('受理前的在途轮次（尚未 accepted）同样被按节点取消并作废', async () => {
    ensureAgentNodeRemovalPreflightRegistered();
    await loadAgentSessions('/proj');
    socketMocks.sendSubmitPrompt.mockImplementation(() => {
      callLog.push('socket-submit');
    });
    // 续作轮次：nodeId 已存在，受理前不挂在 inFlight 上
    const input = submitInput({ nodeId: 'agent-node-9' });
    const pending = submitAgentPrompt(input);
    await vi.waitFor(() => {
      expect(socketMocks.sendSubmitPrompt).toHaveBeenCalled();
    });

    runNodeRemovalPreflight(['agent-node-9']);

    expect(socketMocks.sendCancel).toHaveBeenCalledWith({
      type: AGENT_WS_MESSAGE_TYPE.CANCEL,
      agentSessionId: 'sess-1',
      requestId: input.requestId,
      toolCallId: null,
    });
    // 未受理的提交被取消：等待中的 promise 收口（带错误码，界面按码取文案），不悬挂
    await expect(pending).rejects.toMatchObject({
      name: 'AgentSubmitFailure',
      code: 'cancelled',
    });
  });
});

describe('删除 Agent 节点：残留事件收口守卫', () => {
  it('删除后残留的 token / complete 被丢弃：不写库、无用户可见错误', async () => {
    ensureAgentNodeRemovalPreflightRegistered();
    const requestId = await seedAcceptedSession();
    runNodeRemovalPreflight(['agent-node-1']);

    vi.clearAllMocks();
    callLog.length = 0;

    socketHandlers.onToken({
      type: AGENT_WS_MESSAGE_TYPE.TOKEN,
      requestId,
      agentSessionId: 'sess-1',
      delta: '第一',
    });
    socketHandlers.onComplete({
      type: AGENT_WS_MESSAGE_TYPE.COMPLETE,
      requestId,
      agentSessionId: 'sess-1',
      content: [{ type: 'text', text: '第一步：换夜景底' }],
    });
    await flushMicrotasks();

    expect(storageMocks.appendAgentMessage).not.toHaveBeenCalled();
    expect(storageMocks.upsertAgentSession).not.toHaveBeenCalled();
    expect(storageMocks.appendAgentSendRecord).not.toHaveBeenCalled();
    const state = useAgentSessionStore.getState();
    expect(state.streamingBySessionId['sess-1']).toBeUndefined();
    expect(state.errorsBySessionId['sess-1']).toBeUndefined();
    expect(state.inFlightBySessionId['sess-1']).toBeUndefined();
  });

  it('删除后残留的 error 被丢弃：不设错误态、不向用户抛错', async () => {
    ensureAgentNodeRemovalPreflightRegistered();
    const requestId = await seedAcceptedSession();
    runNodeRemovalPreflight(['agent-node-1']);

    vi.clearAllMocks();
    socketHandlers.onError({
      type: AGENT_WS_MESSAGE_TYPE.ERROR,
      requestId,
      agentSessionId: 'sess-1',
      code: 'cancelled',
      message: '这轮回复被中断了。',
      partialContent: '前半段',
    });
    await flushMicrotasks();

    expect(storageMocks.appendAgentMessage).not.toHaveBeenCalled();
    expect(useAgentSessionStore.getState().errorsBySessionId['sess-1']).toBeUndefined();
  });

  it('删除后残留的 accepted（同 requestId）被忽略：不建节点、不写库', async () => {
    ensureAgentNodeRemovalPreflightRegistered();
    const requestId = await seedAcceptedSession();
    runNodeRemovalPreflight(['agent-node-1']);

    vi.clearAllMocks();
    callLog.length = 0;
    socketHandlers.onAccepted({
      type: AGENT_WS_MESSAGE_TYPE.ACCEPTED,
      requestId,
      agentSessionId: 'sess-1',
    });
    await flushMicrotasks();

    expect(callLog).toEqual([]);
    expect(canvasState.addNode).not.toHaveBeenCalled();
    expect(useAgentSessionStore.getState().sessionsById['sess-1']).toBeUndefined();
  });

  it('作废后同一 nodeId 的新会话不受影响：可正常创建、受理并接收流式', async () => {
    ensureAgentNodeRemovalPreflightRegistered();
    // 先建一个已受理会话，再删除节点（作废旧会话）
    const oldSessionId = 'sess-1';
    await seedAcceptedSession({ agentSessionId: oldSessionId });
    runNodeRemovalPreflight(['agent-node-1']);
    expect(useAgentSessionStore.getState().sessionsById[oldSessionId]).toBeUndefined();

    // 同一 nodeId 上开新会话
    callLog.length = 0;
    const newRequestId = 'req-removal-new';
    const pending = submitAgentPrompt(
      submitInput({ requestId: newRequestId, agentSessionId: 'sess-2', nodeId: 'agent-node-1' }),
    );
    await vi.waitFor(() => {
      expect(socketMocks.sendSubmitPrompt).toHaveBeenCalled();
    });
    socketHandlers.onAccepted({
      type: AGENT_WS_MESSAGE_TYPE.ACCEPTED,
      requestId: newRequestId,
      agentSessionId: 'sess-2',
    });
    await expect(pending).resolves.toEqual({ agentSessionId: 'sess-2', nodeId: 'agent-node-1' });

    // 新会话的在途与元数据都在；token 不被守卫误丢弃
    socketHandlers.onToken({
      type: AGENT_WS_MESSAGE_TYPE.TOKEN,
      requestId: newRequestId,
      agentSessionId: 'sess-2',
      delta: '好的',
    });

    const state = useAgentSessionStore.getState();
    expect(state.inFlightBySessionId['sess-2']).toMatchObject({ requestId: newRequestId });
    expect(state.streamingBySessionId['sess-2']).toBe('好的');
    expect(callLog).toContain('append-message:user');
  });
});

describe('删除 Agent 节点：直接调用（无咽喉）也保持同一语义', () => {
  it('cancelAndForgetAgentSessions 对无会话节点是留痕跳过，不抛错', () => {
    expect(() => cancelAndForgetAgentSessions(['no-such-node'])).not.toThrow();
    expect(socketMocks.sendCancel).not.toHaveBeenCalled();
  });
});
