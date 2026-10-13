import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentError } from '@iart/contracts';
import { AGENT_WS_MESSAGE_TYPE } from '@iart/contracts';
import { AgentSocketClient } from '../agentSocket';

/**
 * Agent WS 客户端错误收口回归（spec 04-执行管道与WS协议.md）：
 * 连接不可用 / socket error / socket 断开时，在途请求必须立刻收到 `agent:error`
 * （不静默挂起、不自动重连、不补发）；非 agent 消息被留痕跳过。
 */

const buildSocketUrl = vi.fn<() => string | null>(() => 'ws://127.0.0.1:8080/ws/business');

vi.mock('@/client/utils/businessActionSocket', () => ({
  buildBusinessActionSocketUrl: () => buildSocketUrl(),
}));

type Listener = (event: { data?: unknown }) => void;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly listeners = new Map<string, Listener[]>();
  readonly sent: string[] = [];
  closed = false;

  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    const current = this.listeners.get(type) ?? [];
    this.listeners.set(type, [...current, listener]);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, event: { data?: unknown } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

const errors: AgentError[] = [];
const tokens: string[] = [];

const subscribeClient = (client: AgentSocketClient) =>
  client.subscribe({
    onAccepted: () => undefined,
    onToken: (message) => tokens.push(message.delta),
    onAssistantMessage: () => undefined,
    onToolCall: () => undefined,
    onToolResult: () => undefined,
    onComplete: () => undefined,
    onError: (message) => errors.push(message),
  });

const submitMessage = (requestId: string) => ({
  type: AGENT_WS_MESSAGE_TYPE.SUBMIT_PROMPT,
  requestId,
  agentSessionId: 'sess-1',
  projectPath: '/proj',
  modelId: 'llm-fast-1',
  thinkingTier: 'off',
  approvalMode: 'confirm' as const,
  content: '你好',
  referenceAssetIds: [],
  referenceAssets: [],
});

beforeEach(() => {
  errors.length = 0;
  tokens.length = 0;
  FakeWebSocket.instances = [];
  buildSocketUrl.mockReturnValue('ws://127.0.0.1:8080/ws/business');
  vi.stubGlobal('WebSocket', FakeWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Agent WS 客户端', () => {
  it('socket 不可用（无本地回环 URL）：在途提交立即收到 agent:error', () => {
    buildSocketUrl.mockReturnValue(null);
    const client = new AgentSocketClient();
    subscribeClient(client);

    client.sendSubmitPrompt(submitMessage('req-1'));

    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      type: 'agent:error',
      requestId: 'req-1',
      code: 'execution_failed',
      partialContent: null,
    });
  });

  it('建连后按序发送；accepted/token 分发；断开时在途请求收口且不自动重连', () => {
    const client = new AgentSocketClient();
    subscribeClient(client);

    client.sendSubmitPrompt(submitMessage('req-1'));
    const socket = FakeWebSocket.instances[0];
    expect(socket).toBeDefined();
    expect(client.isConnected()).toBe(false);

    // 建连前入队，open 后 flush
    expect(socket?.sent).toHaveLength(0);
    socket?.emit('open');
    expect(client.isConnected()).toBe(true);
    expect(socket?.sent).toHaveLength(1);
    expect(JSON.parse(socket?.sent[0] ?? '{}')).toMatchObject({
      type: 'agent:submit_prompt',
      requestId: 'req-1',
      // 出站校验只校验、不替换原对象：契约未登记的新字段不得被 strip 掉
      projectPath: '/proj',
    });

    socket?.emit('message', {
      data: JSON.stringify({
        type: 'agent:accepted',
        requestId: 'req-1',
        agentSessionId: 'sess-1',
      }),
    });
    socket?.emit('message', {
      data: JSON.stringify({
        type: 'agent:token',
        requestId: 'req-1',
        agentSessionId: 'sess-1',
        delta: '先',
      }),
    });
    expect(tokens).toEqual(['先']);
    expect(errors).toHaveLength(0);

    // 断开：在途请求收口为 agent:error，且不自动建新连接
    socket?.emit('close');
    expect(client.isConnected()).toBe(false);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.requestId).toBe('req-1');
  });

  it('complete 后同一 requestId 断开不再产生 error（生命周期已收口）', () => {
    const client = new AgentSocketClient();
    subscribeClient(client);

    client.sendSubmitPrompt(submitMessage('req-1'));
    const socket = FakeWebSocket.instances[0];
    socket?.emit('open');
    socket?.emit('message', {
      data: JSON.stringify({
        type: 'agent:complete',
        requestId: 'req-1',
        agentSessionId: 'sess-1',
        content: '完成内容',
      }),
    });
    socket?.emit('close');

    expect(errors).toHaveLength(0);
  });

  it('非 agent 消息留痕跳过；形如 agent:* 的坏消息按失败收口', () => {
    const client = new AgentSocketClient();
    subscribeClient(client);

    client.sendSubmitPrompt(submitMessage('req-1'));
    const socket = FakeWebSocket.instances[0];
    socket?.emit('open');

    socket?.emit('message', { data: JSON.stringify({ type: 'task:state-changed', taskId: 't1' }) });
    expect(errors).toHaveLength(0);

    socket?.emit('message', { data: JSON.stringify({ type: 'agent:token', requestId: 'req-1' }) });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.requestId).toBe('req-1');
  });

  it('取消命令走同一连接（不注册在途收口）', () => {
    const client = new AgentSocketClient();
    subscribeClient(client);

    client.sendSubmitPrompt(submitMessage('req-1'));
    const socket = FakeWebSocket.instances[0];
    socket?.emit('open');
    client.sendCancel({
      type: AGENT_WS_MESSAGE_TYPE.CANCEL,
      agentSessionId: 'sess-1',
      requestId: 'req-1',
      toolCallId: null,
    });

    expect(socket?.sent).toHaveLength(2);
    expect(JSON.parse(socket?.sent[1] ?? '{}')).toMatchObject({
      type: 'agent:cancel',
      agentSessionId: 'sess-1',
      requestId: 'req-1',
    });
  });

  it('批级决裁走同一连接：submit 携带完整执行映射，reject_round 不带映射，均回报已送达', () => {
    const client = new AgentSocketClient();
    subscribeClient(client);

    client.sendSubmitPrompt(submitMessage('req-1'));
    const socket = FakeWebSocket.instances[0];
    socket?.emit('open');

    const submitted = client.sendToolDecision({
      type: AGENT_WS_MESSAGE_TYPE.TOOL_DECISION,
      requestId: 'req-1',
      agentSessionId: 'sess-1',
      decision: 'submit',
      decisions: [
        { toolCallId: 'call-1', execute: true },
        { toolCallId: 'call-2', execute: false },
      ],
    });
    const rejected = client.sendToolDecision({
      type: AGENT_WS_MESSAGE_TYPE.TOOL_DECISION,
      requestId: 'req-1',
      agentSessionId: 'sess-1',
      decision: 'reject_round',
    });

    expect(submitted).toEqual({ delivered: true });
    expect(rejected).toEqual({ delivered: true });
    expect(socket?.sent).toHaveLength(3);
    expect(JSON.parse(socket?.sent[1] ?? '{}')).toMatchObject({
      type: 'agent:tool_decision',
      requestId: 'req-1',
      agentSessionId: 'sess-1',
      decision: 'submit',
      decisions: [
        { toolCallId: 'call-1', execute: true },
        { toolCallId: 'call-2', execute: false },
      ],
    });
    const rejectPayload = JSON.parse(socket?.sent[2] ?? '{}') as Record<string, unknown>;
    expect(rejectPayload).toMatchObject({
      type: 'agent:tool_decision',
      requestId: 'req-1',
      decision: 'reject_round',
    });
    // 批级驳回不是单条决裁：不携带条目映射（两个变体按 decision 判别，字段不串）。
    expect(rejectPayload).not.toHaveProperty('decisions');
    expect(rejectPayload).not.toHaveProperty('toolCallId');
  });

  it('批级决裁连接不可用：回报未送达并给出原因（调用方按原因给对应出口）', () => {
    buildSocketUrl.mockReturnValue(null);
    const client = new AgentSocketClient();
    subscribeClient(client);

    const delivery = client.sendToolDecision({
      type: AGENT_WS_MESSAGE_TYPE.TOOL_DECISION,
      requestId: 'req-1',
      agentSessionId: 'sess-1',
      decision: 'submit',
      decisions: [{ toolCallId: 'call-1', execute: true }],
    });

    // 本层只产出「连接不可用」这一种原因；「该轮已收口」由调用方按在途轮次判据产出。
    expect(delivery).toEqual({ delivered: false, reason: 'connection_unavailable' });
    expect(FakeWebSocket.instances).toHaveLength(0);
    // 决裁不经在途收口集：不因为发不出去就造一条 agent:error。
    expect(errors).toHaveLength(0);
  });
});
