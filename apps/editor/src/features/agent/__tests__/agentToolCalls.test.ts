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
  AgentToolCallAppendParams,
  AgentToolCallEvent,
  AgentToolCallRecord,
  AgentToolCallUpdateParams,
  AgentToolDecision,
  AgentToolResultEvent,
} from '@iart/contracts';
import { AGENT_WS_MESSAGE_TYPE } from '@iart/contracts';
import type { AgentNodeData, GraphNode } from '@/features/canvas/types/node';
import type { AgentInFlightRequest } from '../agentSessionState';
import type { AgentToolDecisionDelivery } from '../agentSocket';

/**
 * 工具调用事件的收口与批级决裁（spec docs/agent/04「工具调用循环语义」、05「Confirm 决裁流程」）。
 *
 * 覆盖：
 * - 事件乱序守卫：终态先到后，迟到的 proposed / dispatching 回写不得把 live 压回未收口状态；
 * - 同一 toolCallId 的写入串行化：提案落库未完成前的状态推进排队，不越过 append 空转；
 * - 串行链不因前序写入失败中断；
 * - 轮次收口时把未收口条目收敛为不可操作终态（未派发按未执行、在途按取消），不让条目静默消失；
 * - 批级决裁入口：submit 携带本批完整执行映射、reject_round 不带映射、只在匹配在途轮次时发送；
 * - 待决提案批的派生：按在途轮次过滤 proposed 条目并取批级最早截止时间。
 */

type SocketHandlers = {
  onAccepted: (message: AgentAccepted) => void;
  onToken: (message: AgentToken) => void;
  onToolCall: (message: AgentToolCallEvent) => void;
  onToolResult: (message: AgentToolResultEvent) => void;
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
    appendAgentToolCall:
      vi.fn<
        (projectPath: string, toolCall: AgentToolCallAppendParams) => Promise<AgentToolCallRecord>
      >(),
    updateAgentToolCall:
      vi.fn<
        (projectPath: string, update: AgentToolCallUpdateParams) => Promise<AgentToolCallRecord | null>
      >(),
  };
  const socket = {
    subscribe: vi.fn<(handlers: SocketHandlers) => () => void>(() => () => undefined),
    sendSubmitPrompt: vi.fn<(message: AgentSubmitPrompt) => void>(),
    sendCancel: vi.fn<(message: { type: string; agentSessionId: string; requestId: string; toolCallId?: string | null }) => void>(),
    sendToolDecision: vi.fn<(message: AgentToolDecision) => AgentToolDecisionDelivery>(() => ({
      delivered: true,
    })),
    isConnected: vi.fn(() => true),
    disconnect: vi.fn(),
  };
  return { log, canvas, storage, socket };
});

const canvasState = h.canvas;
const storageMocks = h.storage;
const socketMocks = h.socket;

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
  buildPendingToolProposalBatch,
  loadAgentSessions,
  rejectAgentToolRound,
  submitAgentPrompt,
  submitAgentToolDecisions,
  useAgentSessionStore,
} from '../agentSessionStore';

/** store 在模块加载时订阅一次 socket，句柄需在 beforeEach 的 clearAllMocks 之前捕获。 */
const socketHandlers: SocketHandlers = (() => {
  const call = socketMocks.subscribe.mock.calls[0];
  if (!call) throw new Error('agent socket handlers not registered');
  return call[0];
})();

const TOOL_CALL_ID = 'call-1';

const toolCallEvent = (params: {
  requestId: string;
  status: 'proposed' | 'dispatching' | 'running';
  toolCallId?: string;
}): AgentToolCallEvent => ({
  type: AGENT_WS_MESSAGE_TYPE.TOOL_CALL,
  requestId: params.requestId,
  agentSessionId: 'sess-1',
  toolCallId: params.toolCallId ?? TOOL_CALL_ID,
  toolName: 'generate_image',
  toolKind: 'generation',
  modelId: 'gpt-image-2',
  argsJson: '{"prompt":"一只柴犬"}',
  status: params.status,
  proposalExpiresAt: null,
});

const toolResultEvent = (params: {
  requestId: string;
  status: 'succeeded' | 'failed' | 'skipped' | 'cancelled';
  toolCallId?: string;
}): AgentToolResultEvent => ({
  type: AGENT_WS_MESSAGE_TYPE.TOOL_RESULT,
  requestId: params.requestId,
  agentSessionId: 'sess-1',
  toolCallId: params.toolCallId ?? TOOL_CALL_ID,
  toolName: 'generate_image',
  status: params.status,
  summary: '已结算',
  assetIds: [],
  assets: [],
  batchId: null,
  taskIds: [],
  errorSummary: null,
});

const toolCallRecord = (update: AgentToolCallUpdateParams): AgentToolCallRecord => ({
  toolCallId: update.toolCallId,
  agentSessionId: update.agentSessionId,
  seq: 1,
  toolName: 'generate_image',
  toolKind: 'generation',
  modelId: 'gpt-image-2',
  status: update.status,
  batchId: update.batchId ?? null,
  taskIds: update.taskIds ?? [],
  assetIds: update.assetIds ?? [],
  errorSummary: update.errorSummary ?? null,
  createdAt: 0,
  updatedAt: 0,
});

const liveStatusOf = (toolCallId: string): string | undefined =>
  useAgentSessionStore.getState().toolCallsLiveBySessionId['sess-1']?.[toolCallId]?.status;

const flushMicrotasks = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

let requestSeq = 0;

/** 受理一轮提交（首条消息），返回 requestId：工具调用事件都挂在这一轮的 requestId 上。 */
const startAcceptedRound = async (): Promise<string> => {
  await loadAgentSessions('/proj');
  socketMocks.sendSubmitPrompt.mockImplementation(() => undefined);
  const input = {
    requestId: `req-${(requestSeq += 1)}`,
    agentSessionId: 'sess-1',
    nodeId: null as string | null,
    modelId: 'llm-fast-1',
    thinkingTier: 'off',
    approvalMode: 'confirm' as const,
    content: '帮我把这张图改成夜景',
    referenceAssetIds: [],
    referenceAssets: [],
  };
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
  return input.requestId;
};

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  canvasState.nodeGraph.nodes = [];
  useAgentSessionStore.getState().reset();

  storageMocks.readAgentSessions.mockResolvedValue([]);
  storageMocks.readAgentSessionByNodeId.mockResolvedValue(null);
  storageMocks.readAgentMessages.mockResolvedValue([]);
  storageMocks.readAgentSendRecords.mockResolvedValue([]);
  storageMocks.appendAgentSendRecord.mockImplementation(async (_path, record) => record);
  storageMocks.appendAgentMessage.mockImplementation(async (_path, message) => ({
    ...message,
    seq: 1,
  }));
  storageMocks.upsertAgentSession.mockImplementation(async (_path, session) => session);
  storageMocks.appendAgentToolCall.mockImplementation(async (_path, toolCall) => ({
    ...toolCall,
    seq: 1,
  }));
  storageMocks.updateAgentToolCall.mockImplementation(async (_path, update) =>
    toolCallRecord(update),
  );
  socketMocks.sendToolDecision.mockImplementation(() => ({ delivered: true }));
});

describe('工具调用事件收口：乱序与写入串行', () => {
  it('终态不被迟到的 proposed 回写覆盖（终态先到、提案重放后到）', async () => {
    const requestId = await startAcceptedRound();

    socketHandlers.onToolResult(toolResultEvent({ requestId, status: 'skipped' }));
    await vi.waitFor(() => {
      expect(liveStatusOf(TOOL_CALL_ID)).toBe('skipped');
    });

    // 迟到的提案事件（乱序）：终态是运行域已收口的事实，live 不得被压回 proposed。
    socketHandlers.onToolCall(toolCallEvent({ requestId, status: 'proposed' }));
    await vi.waitFor(() => {
      expect(storageMocks.appendAgentToolCall).toHaveBeenCalledTimes(1);
    });
    await flushMicrotasks();

    expect(liveStatusOf(TOOL_CALL_ID)).toBe('skipped');
  });

  it('提案落库未完成前的状态推进排队：append 完成后 update 才执行，且命中记录（不空转）', async () => {
    const requestId = await startAcceptedRound();

    // 存储层替身按真实语义：记录不存在时 update 返回 null（按 toolCallId 定位不到行）。
    const persistedIds = new Set<string>();
    const appliedUpdates: string[] = [];
    let releaseAppend: () => void = () => undefined;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = () => resolve();
    });
    storageMocks.appendAgentToolCall.mockImplementation(async (_path, toolCall) => {
      await appendGate;
      persistedIds.add(toolCall.toolCallId);
      return { ...toolCall, seq: 1 };
    });
    storageMocks.updateAgentToolCall.mockImplementation(async (_path, update) => {
      if (!persistedIds.has(update.toolCallId)) return null;
      appliedUpdates.push(update.status);
      return toolCallRecord(update);
    });

    socketHandlers.onToolCall(toolCallEvent({ requestId, status: 'proposed' }));
    await vi.waitFor(() => {
      expect(storageMocks.appendAgentToolCall).toHaveBeenCalledTimes(1);
    });
    socketHandlers.onToolCall(toolCallEvent({ requestId, status: 'dispatching' }));
    await flushMicrotasks();

    // 提案 append 未完成：状态推进排在链上，不越过提案落库先跑（否则记录推进空转、状态丢失）。
    expect(storageMocks.updateAgentToolCall).not.toHaveBeenCalled();

    releaseAppend();
    await vi.waitFor(() => {
      expect(appliedUpdates).toEqual(['dispatching']);
    });
    expect(liveStatusOf(TOOL_CALL_ID)).toBe('dispatching');
  });

  it('提案落库失败不阻断后续状态推进（串行链不因前序失败中断）', async () => {
    const requestId = await startAcceptedRound();
    storageMocks.appendAgentToolCall.mockRejectedValue(new Error('storage down'));
    const appliedUpdates: string[] = [];
    storageMocks.updateAgentToolCall.mockImplementation(async (_path, update) => {
      appliedUpdates.push(update.status);
      return toolCallRecord(update);
    });

    socketHandlers.onToolCall(toolCallEvent({ requestId, status: 'proposed' }));
    socketHandlers.onToolCall(toolCallEvent({ requestId, status: 'running' }));

    await vi.waitFor(() => {
      expect(appliedUpdates).toEqual(['running']);
    });
    expect(liveStatusOf(TOOL_CALL_ID)).toBe('running');
  });

  it('轮次收口收敛未收口条目：未派发提案按未执行结算、在途按取消呈现（不让条目静默消失）', async () => {
    const requestId = await startAcceptedRound();

    socketHandlers.onToolCall(toolCallEvent({ requestId, status: 'proposed', toolCallId: 'call-1' }));
    socketHandlers.onToolCall(toolCallEvent({ requestId, status: 'running', toolCallId: 'call-2' }));
    await vi.waitFor(() => {
      expect(liveStatusOf('call-1')).toBe('proposed');
      expect(liveStatusOf('call-2')).toBe('running');
    });

    socketHandlers.onComplete({
      type: AGENT_WS_MESSAGE_TYPE.COMPLETE,
      requestId,
      agentSessionId: 'sess-1',
      content: '这一轮到这里',
    });

    await vi.waitFor(() => {
      expect(liveStatusOf('call-1')).toBe('skipped');
      expect(liveStatusOf('call-2')).toBe('cancelled');
    });
    expect(useAgentSessionStore.getState().inFlightBySessionId['sess-1']).toBeUndefined();
  });
});

describe('批级决裁入口与待决提案批', () => {
  const inFlightFor = (requestId: string): AgentInFlightRequest => ({
    requestId,
    agentSessionId: 'sess-1',
    nodeId: 'agent-node-1',
  });

  it('无匹配在途轮次：不发送决裁，按「该轮已收口」回报（重试恒无效的理由）', async () => {
    await loadAgentSessions('/proj');

    expect(
      submitAgentToolDecisions('sess-1', 'req-x', [{ toolCallId: TOOL_CALL_ID, execute: true }]),
    ).toEqual({ delivered: false, reason: 'round_closed' });
    expect(rejectAgentToolRound('sess-1', 'req-x')).toEqual({
      delivered: false,
      reason: 'round_closed',
    });
    expect(socketMocks.sendToolDecision).not.toHaveBeenCalled();
  });

  it('请求号不匹配在途轮次：不发送（决裁只对本轮生效）', async () => {
    const requestId = await startAcceptedRound();

    expect(
      submitAgentToolDecisions('sess-1', `${requestId}-other`, [
        { toolCallId: TOOL_CALL_ID, execute: true },
      ]),
    ).toEqual({ delivered: false, reason: 'round_closed' });
    expect(socketMocks.sendToolDecision).not.toHaveBeenCalled();
  });

  it('submitAgentToolDecisions 发送批级提交：载荷携带完整执行映射', async () => {
    const requestId = await startAcceptedRound();

    const result = submitAgentToolDecisions('sess-1', requestId, [
      { toolCallId: 'call-1', execute: true },
      { toolCallId: 'call-2', execute: false },
    ]);

    expect(result).toEqual({ delivered: true });
    expect(socketMocks.sendToolDecision).toHaveBeenCalledWith({
      type: AGENT_WS_MESSAGE_TYPE.TOOL_DECISION,
      requestId,
      agentSessionId: 'sess-1',
      decision: 'submit',
      decisions: [
        { toolCallId: 'call-1', execute: true },
        { toolCallId: 'call-2', execute: false },
      ],
    });
  });

  it('空映射不发送（契约要求至少一个条目，本端不构造非法载荷）', async () => {
    const requestId = await startAcceptedRound();

    expect(submitAgentToolDecisions('sess-1', requestId, [])).toEqual({
      delivered: false,
      reason: 'round_closed',
    });
    expect(socketMocks.sendToolDecision).not.toHaveBeenCalled();
  });

  it('rejectAgentToolRound 发送整轮驳回（不带条目映射）', async () => {
    const requestId = await startAcceptedRound();

    expect(rejectAgentToolRound('sess-1', requestId)).toEqual({ delivered: true });
    expect(socketMocks.sendToolDecision).toHaveBeenCalledWith({
      type: AGENT_WS_MESSAGE_TYPE.TOOL_DECISION,
      requestId,
      agentSessionId: 'sess-1',
      decision: 'reject_round',
    });
  });

  it('投递结果原样透传连接态：发不出去时带上「连接不可用」原因（面板按原因给出口）', async () => {
    const requestId = await startAcceptedRound();
    socketMocks.sendToolDecision.mockImplementation(() => ({
      delivered: false,
      reason: 'connection_unavailable',
    }));

    expect(
      submitAgentToolDecisions('sess-1', requestId, [{ toolCallId: TOOL_CALL_ID, execute: true }]),
    ).toEqual({ delivered: false, reason: 'connection_unavailable' });
  });

  it('buildPendingToolProposalBatch：取本轮 proposed 条目并给出批级最早截止时间', () => {
    const liveEntry = (
      toolCallId: string,
      requestId: string,
      status: 'proposed' | 'running',
      proposalExpiresAt: number,
    ) => ({
      toolCallId,
      requestId,
      toolName: 'generate_image',
      toolKind: 'generation' as const,
      modelId: 'gpt-image-2',
      argsJson: '{}',
      status,
      proposalExpiresAt,
    });
    const live = {
      a: liveEntry('a', 'req-1', 'proposed', 2000),
      b: liveEntry('b', 'req-1', 'proposed', 1000),
      c: liveEntry('c', 'req-1', 'running', 1000),
      d: liveEntry('d', 'req-2', 'proposed', 1000),
    };

    const batch = buildPendingToolProposalBatch(live, inFlightFor('req-1'));
    // 只取本轮未决条目（已派发的 c 与下一轮的 d 不在批内），截止时间取批内最早。
    expect(batch?.items.map((item) => item.toolCallId)).toEqual(['a', 'b']);
    expect(batch?.expiresAt).toBe(1000);
    // 无在途轮次 / 无未决条目：不给批（面板据此不出现）。
    expect(buildPendingToolProposalBatch(live, null)).toBeNull();
    expect(buildPendingToolProposalBatch({}, inFlightFor('req-1'))).toBeNull();
  });
});
