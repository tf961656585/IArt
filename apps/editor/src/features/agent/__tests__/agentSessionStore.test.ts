import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentAccepted,
  AgentAssistantMessageEvent,
  AgentComplete,
  AgentError,
  AgentMessageAppendParams,
  AgentMessageRecord,
  AgentSendRecord,
  AgentServerMessage,
  AgentSessionRecord,
  AgentSubmitPrompt,
  AgentToken,
} from '@iart/contracts';
import { AGENT_WS_MESSAGE_TYPE } from '@iart/contracts';
import type { AgentNodeData, GraphNode } from '@/features/canvas/types/node';

/** store 侧订阅的 socket 句柄形状（契约类型，与 agentSocket 一致；本文件只驱动涉及的事件）。 */
type SocketHandlers = {
  onAccepted: (message: AgentAccepted) => void;
  onToken: (message: AgentToken) => void;
  onAssistantMessage: (message: AgentAssistantMessageEvent) => void;
  onComplete: (message: AgentComplete) => void;
  onError: (message: AgentError) => void;
};

/** 测试用画布状态（只覆盖 store 消费的成员）。 */
type TestCanvasState = {
  nodeGraph: {
    id: string;
    nodes: GraphNode<AgentNodeData>[];
    viewport: { x: number; y: number; zoom: number };
  };
  ui: { canvasContainerSize: null };
  addNode: (key: string, position: { x: number; y: number }, customData: unknown) => GraphNode<AgentNodeData> | null;
  projectSelectionContract: (selection: { selectedNodeIds: string[] }) => void;
};

/**
 * Agent 会话核（store + 受理→投影）行为回归。
 *
 * 覆盖 spec 03/04 的写入语义：
 * - 本地发送留痕先写（发送点击后消息不在纯内存）；
 * - `agent:accepted` 是创建 Agent 节点、写会话记录与写 user 正式消息的唯一触发事实，且顺序固定；
 * - token 累加只在内存；complete 落 assistant 正式消息；error 带 partial 时按 isPartial 落库；
 * - 取消按 nodeId 找到在途请求并发出 `agent:cancel`；
 * - `loadAgentSessions` 只读元数据，消息与留痕按需读取。
 */

const now = 1_760_000_000_000;

/** vi.mock 工厂被提升到文件顶部，共享句柄必须走 vi.hoisted。 */
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
    sendCancel: vi.fn<(message: { type: string; agentSessionId: string; requestId: string; toolCallId?: string | null }) => void>(),
    isConnected: vi.fn(() => true),
    disconnect: vi.fn(),
  };
  return { log, canvas, storage, socket };
});

const canvasState: TestCanvasState = h.canvas;
const storageMocks = h.storage;
const socketMocks = h.socket;
/** 写入/建节点顺序日志（mock 实现与断言共用同一数组）。 */
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
  cancelAgentSessionForNode,
  cancelAgentToolCall,
  ensureAgentMessagesLoaded,
  loadAgentSessions,
  stopCurrentAgentRound,
  submitAgentPrompt,
  updateAgentSessionConfig,
  useAgentSessionStore,
} from '../agentSessionStore';

/**
 * store 在模块加载时订阅一次 socket，句柄需在 beforeEach 的 clearAllMocks 之前捕获。
 */
const socketHandlers: SocketHandlers = (() => {
  const call = socketMocks.subscribe.mock.calls[0];
  if (!call) throw new Error('agent socket handlers not registered');
  return call[0];
})();

let requestSeq = 0;
const nextRequestId = (): string => `req-${(requestSeq += 1)}`;

/** 等待该轮提交完成「留痕 → 发 socket」两步。 */
const waitForSubmitSent = async () => {
  await vi.waitFor(() => {
    expect(socketMocks.sendSubmitPrompt).toHaveBeenCalled();
  });
};

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  callLog.length = 0;
  canvasState.nodeGraph.nodes = [];
  useAgentSessionStore.getState().reset();

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

const submitInput = (overrides: Record<string, unknown> = {}) => ({
  // 每个用例独立 requestId：失败用例遗留的在途提交不污染后续用例。
  requestId: nextRequestId(),
  agentSessionId: 'sess-1',
  nodeId: null as string | null,
  modelId: 'llm-fast-1',
  thinkingTier: 'off',
  approvalMode: 'confirm' as const,
  content: '帮我把这张图改成夜景，先给我一个分步计划',
  referenceAssetIds: ['asset-a'],
  referenceAssets: [],
  ...overrides,
});

describe('Agent 会话核：提交与受理', () => {
  it('留痕先写：发送点击即落库，且早于 socket 发送与节点创建', async () => {
    await loadAgentSessions('/proj');
    socketMocks.sendSubmitPrompt.mockImplementation(() => {
      callLog.push('socket-submit');
    });

    const input = submitInput();
    const pending = submitAgentPrompt(input);
    await waitForSubmitSent();

    expect(callLog).toEqual(['append-send-record', 'socket-submit']);
    // 受理前不得建节点、不得写正式消息
    expect(callLog).not.toContain('add-node');
    expect(canvasState.nodeGraph.nodes).toHaveLength(0);

    expect(storageMocks.appendAgentSendRecord.mock.calls[0]?.[1]).toMatchObject({
      agentSessionId: 'sess-1',
      // 首条消息受理前无节点宿主：留痕 nodeId 为 null（不是空串哨兵）
      nodeId: null,
      requestId: input.requestId,
      content: '帮我把这张图改成夜景，先给我一个分步计划',
      referenceAssetIds: ['asset-a'],
      snapshot: {
        modelId: 'llm-fast-1',
        thinkingTier: 'off',
        approvalMode: 'confirm',
        referenceAssetIds: ['asset-a'],
      },
    });
    expect(
      typeof storageMocks.appendAgentSendRecord.mock.calls[0]?.[1]?.snapshot.submittedAt,
    ).toBe('number');
    // 提交消息显式携带当前项目路径（不用兜底猜测）
    expect(socketMocks.sendSubmitPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ projectPath: '/proj' }),
    );

    socketHandlers.onAccepted({
      type: AGENT_WS_MESSAGE_TYPE.ACCEPTED,
      requestId: input.requestId,
      agentSessionId: 'sess-1',
    });
    await expect(pending).resolves.toEqual({ agentSessionId: 'sess-1', nodeId: 'agent-node-1' });
  });

  it('受理后按序：创建节点 → 写会话记录 → 写 user 正式消息', async () => {
    await loadAgentSessions('/proj');
    socketMocks.sendSubmitPrompt.mockImplementation(() => {
      callLog.push('socket-submit');
    });

    const input = submitInput();
    const pending = submitAgentPrompt(input);
    await waitForSubmitSent();
    callLog.length = 0;

    socketHandlers.onAccepted({
      type: AGENT_WS_MESSAGE_TYPE.ACCEPTED,
      requestId: input.requestId,
      agentSessionId: 'sess-1',
    });
    const result = await pending;

    expect(callLog).toEqual(['add-node', 'upsert-session', 'append-message:user']);
    expect(result).toEqual({ agentSessionId: 'sess-1', nodeId: 'agent-node-1' });

    // 创建的节点只持会话稳定引用（不塞历史）
    expect(canvasState.nodeGraph.nodes[0]?.data).toEqual({ agentSessionId: 'sess-1' });
    // 一次提交恰好一个节点，且创建后选中
    expect(canvasState.addNode).toHaveBeenCalledTimes(1);
    expect(canvasState.projectSelectionContract).toHaveBeenCalledWith(
      expect.objectContaining({ selectedNodeIds: ['agent-node-1'] }),
    );

    expect(storageMocks.upsertAgentSession.mock.calls[0]?.[1]).toMatchObject({
      agentSessionId: 'sess-1',
      nodeId: 'agent-node-1',
      modelId: 'llm-fast-1',
      thinkingTier: 'off',
      approvalMode: 'confirm',
      messageCount: 0,
    });
    expect(
      storageMocks.upsertAgentSession.mock.calls[0]?.[1]?.title.length,
    ).toBeLessThanOrEqual(31);

    const userMessage = storageMocks.appendAgentMessage.mock.calls[0]?.[1];
    expect(userMessage).toMatchObject({
      agentSessionId: 'sess-1',
      role: 'user',
      requestId: input.requestId,
      body: { kind: 'chat', content: '帮我把这张图改成夜景，先给我一个分步计划' },
      plan: null,
      isPartial: false,
    });
  });

  it('续作（已有 nodeId）：只写 user 正式消息，不建节点、不重复写会话记录', async () => {
    await loadAgentSessions('/proj');
    socketMocks.sendSubmitPrompt.mockImplementation(() => {
      callLog.push('socket-submit');
    });

    const input = submitInput({ nodeId: 'agent-node-1', content: '继续，把灯换成暖色' });
    const pending = submitAgentPrompt(input);
    await waitForSubmitSent();
    callLog.length = 0;
    socketHandlers.onAccepted({
      type: AGENT_WS_MESSAGE_TYPE.ACCEPTED,
      requestId: input.requestId,
      agentSessionId: 'sess-1',
    });

    await expect(pending).resolves.toEqual({ agentSessionId: 'sess-1', nodeId: 'agent-node-1' });
    expect(callLog).toEqual(['append-message:user']);
    expect(canvasState.addNode).not.toHaveBeenCalled();

    // 续作留痕写真实节点 id；提交消息显式携带 projectPath（Backend 据此读会话历史）
    expect(storageMocks.appendAgentSendRecord.mock.calls[0]?.[1]).toMatchObject({
      nodeId: 'agent-node-1',
      agentSessionId: 'sess-1',
    });
    expect(socketMocks.sendSubmitPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ projectPath: '/proj' }),
    );
  });

  it('连接不可用（socket 以 agent:error 收口）：提交 promise 拒绝，留痕保留', async () => {
    await loadAgentSessions('/proj');
    const input = submitInput();
    socketMocks.sendSubmitPrompt.mockImplementation(() => {
      callLog.push('socket-submit');
      socketHandlers.onError({
        type: AGENT_WS_MESSAGE_TYPE.ERROR,
        requestId: input.requestId,
        agentSessionId: 'sess-1',
        code: 'execution_failed',
        message: 'Agent 服务连接已断开，本轮请求已中断，请重试。',
        partialContent: null,
      });
    });

    await expect(submitAgentPrompt(input)).rejects.toThrow(
      'Agent 服务连接已断开，本轮请求已中断，请重试。',
    );

    // 失败不重试、不补发；留痕保留，且未创建节点
    expect(socketMocks.sendSubmitPrompt).toHaveBeenCalledTimes(1);
    expect(storageMocks.appendAgentSendRecord).toHaveBeenCalledTimes(1);
    expect(canvasState.nodeGraph.nodes).toHaveLength(0);
    expect(storageMocks.appendAgentMessage).not.toHaveBeenCalled();
  });
});

describe('Agent 会话核：流式、完成与中断', () => {
  const seedAcceptedSession = async (): Promise<string> => {
    await loadAgentSessions('/proj');
    socketMocks.sendSubmitPrompt.mockImplementation(() => {
      callLog.push('socket-submit');
    });
    const input = submitInput();
    const pending = submitAgentPrompt(input);
    await waitForSubmitSent();
    socketHandlers.onAccepted({
      type: AGENT_WS_MESSAGE_TYPE.ACCEPTED,
      requestId: input.requestId,
      agentSessionId: 'sess-1',
    });
    await pending;
    callLog.length = 0;
    return input.requestId;
  };

  it('token 累加只在内存（不落库）', async () => {
    const requestId = await seedAcceptedSession();
    const handlers = socketHandlers;

    handlers.onToken({
      type: AGENT_WS_MESSAGE_TYPE.TOKEN,
      requestId,
      agentSessionId: 'sess-1',
      delta: '第一',
    });
    handlers.onToken({
      type: AGENT_WS_MESSAGE_TYPE.TOKEN,
      requestId,
      agentSessionId: 'sess-1',
      delta: '段',
    });

    expect(useAgentSessionStore.getState().streamingBySessionId['sess-1']).toBe('第一段');
    expect(storageMocks.appendAgentMessage).toHaveBeenCalledTimes(1); // 只有 user 消息
  });

  it('中间轮 assistant_message 定稿即消费流式缓冲：下一轮 token 从空缓冲累加', async () => {
    const requestId = await seedAcceptedSession();
    const handlers = socketHandlers;

    // 第 1 轮流式 token 累加
    handlers.onToken({
      type: AGENT_WS_MESSAGE_TYPE.TOKEN,
      requestId,
      agentSessionId: 'sess-1',
      delta: '第一轮思路',
    });
    expect(useAgentSessionStore.getState().streamingBySessionId['sess-1']).toBe('第一轮思路');

    // 中间轮定稿（该轮以工具调用结尾）：正式消息落库，流式缓冲随之清零
    handlers.onAssistantMessage({
      type: AGENT_WS_MESSAGE_TYPE.ASSISTANT_MESSAGE,
      requestId,
      agentSessionId: 'sess-1',
      content: [{ type: 'text', text: '第一轮思路' }],
      toolCalls: [{ id: 'tool-1', name: 'generate_image', argsJson: '{}' }],
    });
    await vi.waitFor(() => {
      expect(useAgentSessionStore.getState().streamingBySessionId['sess-1']).toBe('');
    });
    expect(callLog).toContain('append-message:assistant');

    // 第 2 轮 token 从空缓冲累加：不复读第 1 轮全文
    handlers.onToken({
      type: AGENT_WS_MESSAGE_TYPE.TOKEN,
      requestId,
      agentSessionId: 'sess-1',
      delta: '第二轮',
    });
    expect(useAgentSessionStore.getState().streamingBySessionId['sess-1']).toBe('第二轮');
    // 工具循环仍在途：轮次未收口，在途请求保留
    expect(useAgentSessionStore.getState().inFlightBySessionId['sess-1']).toBeTruthy();
  });

  it('complete 落 assistant 正式消息（isPartial=false）并清在途态', async () => {
    const requestId = await seedAcceptedSession();
    socketHandlers.onComplete({
      type: AGENT_WS_MESSAGE_TYPE.COMPLETE,
      requestId,
      agentSessionId: 'sess-1',
      content: [{ type: 'text', text: '第一步：换夜景底' }],
    });

    await vi.waitFor(() => {
      expect(callLog).toContain('append-message:assistant');
    });
    const assistant = storageMocks.appendAgentMessage.mock.calls[1]?.[1];
    expect(assistant).toMatchObject({
      agentSessionId: 'sess-1',
      role: 'assistant',
      requestId,
      body: { kind: 'chat', content: [{ type: 'text', text: '第一步：换夜景底' }] },
      isPartial: false,
    });
    expect(useAgentSessionStore.getState().streamingBySessionId['sess-1']).toBe('');
    expect(useAgentSessionStore.getState().inFlightBySessionId['sess-1']).toBeUndefined();
  });

  it('error 带 partialContent：按 isPartial=true 落库，并把可读错误暴露给 UI', async () => {
    const requestId = await seedAcceptedSession();
    socketHandlers.onError({
      type: AGENT_WS_MESSAGE_TYPE.ERROR,
      requestId,
      agentSessionId: 'sess-1',
      code: 'cancelled',
      message: '这轮回复被中断了。',
      partialContent: '我先给出前半段',
    });

    await vi.waitFor(() => {
      expect(callLog).toContain('append-message:assistant:partial');
    });
    const partial = storageMocks.appendAgentMessage.mock.calls[1]?.[1];
    expect(partial).toMatchObject({
      role: 'assistant',
      requestId,
      isPartial: true,
      body: { kind: 'chat', content: '我先给出前半段' },
    });
    const state = useAgentSessionStore.getState();
    expect(state.inFlightBySessionId['sess-1']).toBeUndefined();
    expect(state.errorsBySessionId['sess-1']).toMatchObject({
      code: 'cancelled',
      message: '这轮回复被中断了。',
    });
  });

  it('error 无 partialContent：不写 assistant 消息，错误仍暴露', async () => {
    const requestId = await seedAcceptedSession();
    socketHandlers.onError({
      type: AGENT_WS_MESSAGE_TYPE.ERROR,
      requestId,
      agentSessionId: 'sess-1',
      code: 'execution_failed',
      message: '语言模型暂时不可用，请稍后重试。',
      partialContent: null,
    });

    await vi.waitFor(() => {
      expect(useAgentSessionStore.getState().errorsBySessionId['sess-1']).toBeTruthy();
    });
    expect(callLog).toEqual([]);
  });
});

describe('Agent 会话核：取消与按需加载', () => {
  it('cancelAgentSessionForNode 按 nodeId 找到在途请求并发出 agent:cancel', async () => {
    await loadAgentSessions('/proj');
    socketMocks.sendSubmitPrompt.mockImplementation(() => {
      callLog.push('socket-submit');
    });
    const input = submitInput();
    const pending = submitAgentPrompt(input);
    await waitForSubmitSent();
    socketHandlers.onAccepted({
      type: AGENT_WS_MESSAGE_TYPE.ACCEPTED,
      requestId: input.requestId,
      agentSessionId: 'sess-1',
    });
    await pending;

    await cancelAgentSessionForNode('agent-node-1');

    expect(socketMocks.sendCancel).toHaveBeenCalledWith({
      type: AGENT_WS_MESSAGE_TYPE.CANCEL,
      agentSessionId: 'sess-1',
      requestId: input.requestId,
      toolCallId: null,
    });
  });

  it('无在途请求时取消是留痕跳过，不发命令', async () => {
    await loadAgentSessions('/proj');
    await cancelAgentSessionForNode('agent-node-unknown');
    expect(socketMocks.sendCancel).not.toHaveBeenCalled();
  });

  it('stopCurrentAgentRound 停止在途轮次：发整请求 agent:cancel（不带条目标识，spec 06 运行中停止）', async () => {
    await loadAgentSessions('/proj');
    const input = submitInput();
    const pending = submitAgentPrompt(input);
    await waitForSubmitSent();
    socketHandlers.onAccepted({
      type: AGENT_WS_MESSAGE_TYPE.ACCEPTED,
      requestId: input.requestId,
      agentSessionId: 'sess-1',
    });
    await pending;

    stopCurrentAgentRound('sess-1');

    expect(socketMocks.sendCancel).toHaveBeenCalledWith({
      type: AGENT_WS_MESSAGE_TYPE.CANCEL,
      agentSessionId: 'sess-1',
      requestId: input.requestId,
      toolCallId: null,
    });
  });

  it('stopCurrentAgentRound 无在途轮次时留痕跳过，不发命令', async () => {
    await loadAgentSessions('/proj');
    stopCurrentAgentRound('sess-1');
    expect(socketMocks.sendCancel).not.toHaveBeenCalled();
  });

  it('cancelAgentToolCall 发携带条目标识的单条取消（spec 05 yolo 单条取消）', async () => {
    await loadAgentSessions('/proj');
    const input = submitInput();
    const pending = submitAgentPrompt(input);
    await waitForSubmitSent();
    socketHandlers.onAccepted({
      type: AGENT_WS_MESSAGE_TYPE.ACCEPTED,
      requestId: input.requestId,
      agentSessionId: 'sess-1',
    });
    await pending;

    cancelAgentToolCall('sess-1', 'call-1');

    expect(socketMocks.sendCancel).toHaveBeenCalledWith({
      type: AGENT_WS_MESSAGE_TYPE.CANCEL,
      agentSessionId: 'sess-1',
      requestId: input.requestId,
      toolCallId: 'call-1',
    });
  });

  it('cancelAgentToolCall 无在途轮次时留痕跳过，不发命令', async () => {
    await loadAgentSessions('/proj');
    cancelAgentToolCall('sess-1', 'call-1');
    expect(socketMocks.sendCancel).not.toHaveBeenCalled();
  });

  it('loadAgentSessions 只读元数据；消息与留痕在 ensureAgentMessagesLoaded 按需读', async () => {
    storageMocks.readAgentSessions.mockResolvedValue([
      {
        agentSessionId: 'sess-1',
        nodeId: 'agent-node-1',
        modelId: 'llm-fast-1',
        thinkingTier: 'off',
        approvalMode: 'confirm',
        title: '夜景改造',
        createdAt: now,
        updatedAt: now,
        messageCount: 2,
        // 最近一次对话时间（updatedAt 可被配置变更抬升，二者不是一个口径）
        lastMessageAt: now,
      },
    ]);

    await loadAgentSessions('/proj');

    expect(storageMocks.readAgentSessions).toHaveBeenCalledWith('/proj');
    expect(storageMocks.readAgentMessages).not.toHaveBeenCalled();
    expect(storageMocks.readAgentSendRecords).not.toHaveBeenCalled();

    const meta = useAgentSessionStore.getState().sessionsById['sess-1'];
    expect(meta?.modelId).toBe('llm-fast-1');
    expect(meta?.title).toBe('夜景改造');

    await ensureAgentMessagesLoaded('sess-1');
    expect(storageMocks.readAgentMessages).toHaveBeenCalledWith('/proj', 'sess-1');
    expect(storageMocks.readAgentSendRecords).toHaveBeenCalledWith('/proj', 'sess-1');

    // 已加载再调用不重复读取
    await ensureAgentMessagesLoaded('sess-1');
    expect(storageMocks.readAgentMessages).toHaveBeenCalledTimes(1);
  });

  it('消息读取失败：记为读取失败（视图可给出口），不置「已加载」、不停在加载态', async () => {
    await loadAgentSessions('/proj');
    storageMocks.readAgentMessages.mockRejectedValue(new Error('storage read failed'));

    await ensureAgentMessagesLoaded('sess-1');

    const state = useAgentSessionStore.getState();
    expect(state.messagesLoadFailedSessionIds['sess-1']).toBe(true);
    expect(state.messagesLoadedSessionIds['sess-1']).toBeUndefined();

    // 失败后重新打开面板可重试：读取成功则失败标记与加载态一并收口
    storageMocks.readAgentMessages.mockResolvedValue([]);
    await ensureAgentMessagesLoaded('sess-1');

    const retried = useAgentSessionStore.getState();
    expect(retried.messagesLoadFailedSessionIds['sess-1']).toBeUndefined();
    expect(retried.messagesLoadedSessionIds['sess-1']).toBe(true);
  });

  it('updateAgentSessionConfig 合并思考/审批/标题并落库，不动 modelId', async () => {
    storageMocks.readAgentSessions.mockResolvedValue([
      {
        agentSessionId: 'sess-1',
        nodeId: 'agent-node-1',
        modelId: 'llm-fast-1',
        thinkingTier: 'off',
        approvalMode: 'confirm',
        title: '夜景改造',
        createdAt: now,
        updatedAt: now,
        messageCount: 2,
        lastMessageAt: now - 1000,
      },
    ]);
    await loadAgentSessions('/proj');

    await updateAgentSessionConfig('sess-1', { thinkingTier: 'high', approvalMode: 'yolo' });

    const stored = storageMocks.upsertAgentSession.mock.calls[0]?.[1];
    expect(stored).toMatchObject({
      agentSessionId: 'sess-1',
      modelId: 'llm-fast-1',
      thinkingTier: 'high',
      approvalMode: 'yolo',
      title: '夜景改造',
      // 配置变更不碰「最近一次对话」的时间口径（只抬升 updatedAt，由存储写入端裁定）
      lastMessageAt: now - 1000,
    });
    expect(useAgentSessionStore.getState().sessionsById['sess-1']?.thinkingTier).toBe('high');
  });
});

describe('Agent socket 消息类型契约', () => {
  it('服务端消息类型常量与 spec 04 一致', () => {
    const serverTypes: AgentServerMessage['type'][] = [
      'agent:accepted',
      'agent:token',
      'agent:complete',
      'agent:error',
    ];
    expect(serverTypes).toEqual([
      AGENT_WS_MESSAGE_TYPE.ACCEPTED,
      AGENT_WS_MESSAGE_TYPE.TOKEN,
      AGENT_WS_MESSAGE_TYPE.COMPLETE,
      AGENT_WS_MESSAGE_TYPE.ERROR,
    ]);
  });
});
