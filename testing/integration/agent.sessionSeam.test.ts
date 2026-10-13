/**
 * Agent 域跨层接缝集成测试（Agent 域 / 批次 4）。
 *
 * 使命：本机没有可用的对话语言模型连接，无法做真实模型端到端验收；本用例在没有真实网络、
 * 没有真实 SQLite 的前提下，把「受理主链」首尾接起来跑一遍。
 *
 * 两端都是真实实现：Editor 侧为真实 `AgentSocketClient` + `agentSessionStore` +
 * `agentSessionStorage`（P 组通道）+ canvasStore 节点投影 + contracts schema；
 * Backend 侧为真实 `handleAgentMessage` / `executeAgentSubmitPrompt` / `cancelAgentRequest`
 * （含项目作用域裁定、历史读取、事件发送），只把语言推理底座换成假 core。
 * 替身与加载桥（假 WS、内存存储、已打开项目、数据根重定向）见
 * `helpers/agentSessionSeamHarness.ts`。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import {
  AGENT_WS_MESSAGE_TYPE,
  AgentClientMessageSchema,
  AgentServerMessageSchema,
  EDITOR_STORAGE_IPC_CHANNELS,
  StorageAppendAgentMessageParamsSchema,
  StorageAppendAgentSendRecordParamsSchema,
  StorageUpsertAgentSessionParamsSchema,
  type AgentMessageAppendParams,
  type AgentServerMessage,
} from '@iart/contracts';

import { useRuntimeStore } from '@/client/store/runtimeStore';
import {
  cancelAgentSessionForNode,
  loadAgentSessions,
  submitAgentPrompt,
  updateAgentSessionConfig,
  useAgentSessionStore,
  useAgentStreamingText,
  type AgentSubmitInput,
} from '@/features/agent/agentSessionStore';
import { agentSessionStorage } from '@/features/agent/agentSessionStorage';
import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import { createNodeGraph } from '@/features/canvas/types/nodeGraph';
import type { GraphNode } from '@/features/canvas/types/node';
import {
  assistantResult,
  createAgentSessionSeam,
  createGate,
  waitFor,
  type AgentSessionSeam,
  type WireFrame,
} from './helpers/agentSessionSeamHarness';

let seam: AgentSessionSeam;
let projectPath = '';

// ── Editor 侧画布 / 断言工具 ──

const resetCanvas = (): void => {
  useCanvasStore.setState((state) => {
    state.nodeGraph = createNodeGraph({
      name: 'agent-seam',
      description: undefined,
      tags: undefined,
      category: undefined,
    });
    state.ui.canvasContainerSize = { width: 1440, height: 900 };
    state.selectedNodeIds = [];
  });
};

const canvasNodes = (): GraphNode[] => useCanvasStore.getState().nodeGraph?.nodes ?? [];

const agentNodes = (): GraphNode[] => canvasNodes().filter((node) => node.type === 'agent');

const frameAt = (frames: WireFrame[], index: number): WireFrame => {
  const frame = frames[index];
  if (!frame) throw new Error(`wire frame #${index} is missing`);
  return frame;
};

const framesOfType = (frames: WireFrame[], type: string): WireFrame[] =>
  frames.filter((frame) => (frame.payload as { type?: unknown }).type === type);

/** 首个出站提交帧（Editor 真实写出的原始 JSON 帧）。 */
const submitFrame = (): WireFrame =>
  frameAt(framesOfType(seam.wire.outbound, AGENT_WS_MESSAGE_TYPE.SUBMIT_PROMPT), 0);

const submitFrames = (): WireFrame[] =>
  framesOfType(seam.wire.outbound, AGENT_WS_MESSAGE_TYPE.SUBMIT_PROMPT);

/** Backend 出站帧逐条过契约 schema：证明发出去的就是契约形状（含无多余字段）。 */
const serverMessages = (): AgentServerMessage[] =>
  seam.wire.inbound.map((frame, index) => {
    const parsed = AgentServerMessageSchema.safeParse(frame.payload);
    if (!parsed.success) {
      throw new Error(
        `backend frame #${index} violates AgentServerMessageSchema: ${parsed.error.message}`,
      );
    }
    expect(parsed.data).toEqual(frame.payload);
    return parsed.data;
  });

const storageCallAt = (channel: string, index: number): { params: unknown } => {
  const call = seam.memoryStorage.callsOf(channel)[index];
  if (!call) throw new Error(`storage call ${channel}#${index} is missing`);
  return call;
};

const appendedMessages = (): AgentMessageAppendParams[] =>
  seam.memoryStorage.callsOf(EDITOR_STORAGE_IPC_CHANNELS.APPEND_AGENT_MESSAGE).map((call) => {
    return StorageAppendAgentMessageParamsSchema.parse(call.params).message;
  });

/** 写入类通道的调用顺序（读取类通道属于投影补全，不参与顺序断言）。 */
const writeChannelOrder = (): string[] =>
  seam.memoryStorage.calls
    .map((call) => call.channel)
    .filter(
      (channel) =>
        channel === EDITOR_STORAGE_IPC_CHANNELS.APPEND_AGENT_SEND_RECORD ||
        channel === EDITOR_STORAGE_IPC_CHANNELS.UPSERT_AGENT_SESSION ||
        channel === EDITOR_STORAGE_IPC_CHANNELS.APPEND_AGENT_MESSAGE,
    );

const buildSubmitInput = (overrides: Partial<AgentSubmitInput>): AgentSubmitInput => ({
  requestId: 'req-seam',
  agentSessionId: 'sess-seam',
  nodeId: null,
  modelId: 'llm-seam-1',
  thinkingTier: 'high',
  approvalMode: 'confirm',
  content: '把这张图改成夜景',
  referenceAssetIds: ['asset-a'],
  referenceAssets: [],
  ...overrides,
});

// ── 生命周期 ──

beforeAll(async () => {
  seam = await createAgentSessionSeam();
  projectPath = seam.createOpenedProject('agent-seam');
  useRuntimeStore.setState({ backendBaseUrl: 'http://127.0.0.1:51999', projectPath });
});

afterAll(() => {
  seam.teardown();
});

beforeEach(() => {
  seam.reset();
  useAgentSessionStore.getState().reset();
  resetCanvas();
});

describe('Agent 受理主链接缝：Editor ↔ Backend', () => {
  it('出站载荷过契约且字段不被 strip → Backend 真实受理 → 事件回灌 → 节点/会话/消息收口（含续作历史回流）', async () => {
    await loadAgentSessions(projectPath);
    const coreStarted = createGate();
    const coreRelease = createGate();
    const firstTurnText = '夜景改造完成';
    seam.core.installSequence([
      async (params) => {
        params.onModelConfigResolved?.();
        params.onToken('夜景');
        params.onToken('改造');
        coreStarted.open();
        await coreRelease.promise;
        return assistantResult(firstTurnText);
      },
      async (params) => {
        params.onModelConfigResolved?.();
        params.onToken('第二');
        params.onToken('轮');
        return assistantResult('第二轮完成');
      },
    ]);

    // ── 接缝 1：Editor 出站 → Backend 入站 ──
    const submitInput = buildSubmitInput({ requestId: 'req-seam-1', agentSessionId: 'sess-seam-1' });
    const pending = submitAgentPrompt(submitInput);
    await waitFor(() => submitFrames().length === 1, 'editor outbound submit frame');

    const outboundFrame = submitFrame();
    const clientMessage = AgentClientMessageSchema.parse(outboundFrame.payload);
    // 出站对象与契约解析结果一致：证明发送的是调用方构造的原对象，字段没有被 zod strip 掉。
    expect(clientMessage).toEqual(outboundFrame.payload);
    expect(Object.prototype.hasOwnProperty.call(outboundFrame.payload, 'projectPath')).toBe(true);
    expect(clientMessage).toMatchObject({
      type: AGENT_WS_MESSAGE_TYPE.SUBMIT_PROMPT,
      requestId: 'req-seam-1',
      agentSessionId: 'sess-seam-1',
      projectPath,
      modelId: 'llm-seam-1',
      thinkingTier: 'high',
      approvalMode: 'confirm',
      content: '把这张图改成夜景',
      referenceAssetIds: ['asset-a'],
    });

    // ── 接缝 2：Backend 真实受理（假 core 产出若干 token 后返回终态） ──
    await waitFor(() => seam.core.calls.length === 1, 'backend core executed');
    const firstCoreCall = seam.core.calls[0];
    expect(firstCoreCall?.requestId).toBe('req-seam-1');
    expect(firstCoreCall?.sessionId).toBe('sess-seam-1');
    expect(firstCoreCall?.modelId).toBe('llm-seam-1');
    expect(firstCoreCall?.thinkingTier).toBe('high');
    expect(firstCoreCall?.messages.map((message) => message.content)).toEqual(['把这张图改成夜景']);
    // 受理作用域 = payload 的 projectPath
    expect(seam.core.historyReadRequests).toEqual([{ projectPath, agentSessionId: 'sess-seam-1' }]);

    // ── 接缝 4（流式期）：节点 / 会话 / user 消息 / 留痕 ──
    await waitFor(() => agentNodes().length === 1, 'agent node created for acceptance');
    await waitFor(
      () => useAgentSessionStore.getState().inFlightBySessionId['sess-seam-1'] !== undefined,
      'in-flight request registered',
    );

    expect(canvasNodes()).toHaveLength(1);
    const agentNode = agentNodes()[0];
    expect(agentNode?.data).toMatchObject({ agentSessionId: 'sess-seam-1' });

    const sessionWrite = StorageUpsertAgentSessionParamsSchema.parse(
      storageCallAt(EDITOR_STORAGE_IPC_CHANNELS.UPSERT_AGENT_SESSION, 0).params,
    ).session;
    expect(sessionWrite).toMatchObject({
      agentSessionId: 'sess-seam-1',
      nodeId: agentNode?.id,
      modelId: 'llm-seam-1',
      thinkingTier: 'high',
      approvalMode: 'confirm',
    });

    const userMessage = appendedMessages()[0];
    expect(userMessage).toMatchObject({
      agentSessionId: 'sess-seam-1',
      role: 'user',
      requestId: 'req-seam-1',
      body: { kind: 'chat', content: '把这张图改成夜景' },
      isPartial: false,
    });

    // 留痕先于受理落库，且首条留痕 nodeId 为 null（受理前无节点宿主）。
    const sendRecord = StorageAppendAgentSendRecordParamsSchema.parse(
      storageCallAt(EDITOR_STORAGE_IPC_CHANNELS.APPEND_AGENT_SEND_RECORD, 0).params,
    ).sendRecord;
    expect(sendRecord).toMatchObject({
      agentSessionId: 'sess-seam-1',
      nodeId: null,
      requestId: 'req-seam-1',
      content: '把这张图改成夜景',
      snapshot: { modelId: 'llm-seam-1', thinkingTier: 'high', approvalMode: 'confirm' },
    });
    expect(writeChannelOrder()).toEqual([
      EDITOR_STORAGE_IPC_CHANNELS.APPEND_AGENT_SEND_RECORD,
      EDITOR_STORAGE_IPC_CHANNELS.UPSERT_AGENT_SESSION,
      EDITOR_STORAGE_IPC_CHANNELS.APPEND_AGENT_MESSAGE,
    ]);

    // 流式期间：pinned hook 反映累积文本（真实 store 投影，非落库）
    await coreStarted.promise;
    const streaming = renderHook(() => useAgentStreamingText('sess-seam-1'));
    await act(async () => undefined);
    expect(streaming.result.current).toBe('夜景改造');

    // ── 接缝 3：Backend 出站 → Editor 入站 ──
    coreRelease.open();
    await expect(pending).resolves.toEqual({
      agentSessionId: 'sess-seam-1',
      nodeId: agentNode?.id,
    });
    await waitFor(
      () => serverMessages().some((message) => message.type === AGENT_WS_MESSAGE_TYPE.COMPLETE),
      'agent:complete delivered',
    );

    expect(serverMessages().map((message) => message.type)).toEqual([
      AGENT_WS_MESSAGE_TYPE.ACCEPTED,
      AGENT_WS_MESSAGE_TYPE.TOKEN,
      AGENT_WS_MESSAGE_TYPE.TOKEN,
      AGENT_WS_MESSAGE_TYPE.COMPLETE,
    ]);
    const tokenDeltas = serverMessages()
      .filter((message) => message.type === AGENT_WS_MESSAGE_TYPE.TOKEN)
      .map((message) => message.delta);
    expect(tokenDeltas).toEqual(['夜景', '改造']);

    // ── 接缝 4（收口）：assistant 正式消息 + 流式态清空 + 在途收口 ──
    await waitFor(
      () => appendedMessages().some((message) => message.role === 'assistant'),
      'assistant message persisted',
    );
    await act(async () => undefined);
    const assistantMessage = appendedMessages().find((message) => message.role === 'assistant');
    expect(assistantMessage).toMatchObject({
      agentSessionId: 'sess-seam-1',
      role: 'assistant',
      requestId: 'req-seam-1',
      body: { kind: 'chat', content: firstTurnText },
      isPartial: false,
    });
    expect(streaming.result.current).toBe('');
    expect(useAgentSessionStore.getState().inFlightBySessionId['sess-seam-1']).toBeUndefined();

    // ── 续作一轮：Backend 读到的历史 = Editor 上一轮写入的正式消息 ──
    const followUp = submitAgentPrompt(
      buildSubmitInput({
        requestId: 'req-seam-2',
        agentSessionId: 'sess-seam-1',
        nodeId: agentNode?.id ?? null,
        content: '继续第二轮',
      }),
    );
    await waitFor(() => submitFrames().length === 2, 'second turn submitted');
    await waitFor(() => seam.core.calls.length === 2, 'second turn core executed');
    await expect(followUp).resolves.toEqual({
      agentSessionId: 'sess-seam-1',
      nodeId: agentNode?.id,
    });
    const secondCoreCall = seam.core.calls[1];
    expect(secondCoreCall?.messages.map((message) => [message.role, message.content])).toEqual([
      ['user', '把这张图改成夜景'],
      ['assistant', firstTurnText],
      ['user', '继续第二轮'],
    ]);
    await waitFor(
      () => appendedMessages().filter((message) => message.role === 'assistant').length === 2,
      'second turn assistant message persisted',
    );
    // 会话 1:1 节点：续作不重复建节点、不重复写会话记录
    expect(agentNodes()).toHaveLength(1);
    expect(seam.memoryStorage.callsOf(EDITOR_STORAGE_IPC_CHANNELS.UPSERT_AGENT_SESSION)).toHaveLength(
      1,
    );
  });

  it('执行失败且无 partialContent：agent:error 收口，Editor 不落 assistant 正式消息、不自动重试', async () => {
    await loadAgentSessions(projectPath);
    seam.core.installSequence([
      async () => {
        // 未调用 onModelConfigResolved = 模型部署解析阶段失败
        throw new Error('chat model has no usable active deployment: llm-seam-1');
      },
    ]);

    const pending = submitAgentPrompt(
      buildSubmitInput({ requestId: 'req-seam-fail-1', agentSessionId: 'sess-seam-fail-1' }),
    );
    // 受理先于模型解析失败发生：提交 promise 在受理时即已 resolve（失败经 agent:error 收口）。
    await expect(pending).resolves.toMatchObject({ agentSessionId: 'sess-seam-fail-1' });
    await waitFor(
      () => serverMessages().some((message) => message.type === AGENT_WS_MESSAGE_TYPE.ERROR),
      'agent:error delivered',
    );

    const errorMessage = serverMessages().find(
      (message) => message.type === AGENT_WS_MESSAGE_TYPE.ERROR,
    );
    expect(errorMessage).toMatchObject({
      requestId: 'req-seam-fail-1',
      agentSessionId: 'sess-seam-fail-1',
      code: 'model_unavailable',
      partialContent: null,
    });

    // 受理已发生（节点/会话/user 消息），但该轮没有 assistant 正式消息
    await waitFor(() => agentNodes().length === 1, 'agent node created');
    await waitFor(() => appendedMessages().length === 1, 'user message persisted');
    expect(appendedMessages().map((message) => message.role)).toEqual(['user']);
    // 修复后：受理续作与终态收口由受理屏障定序（error 处理排在受理落库之后），
    // 「受理续作补写 in-flight」的残留不再存在——该闪现发生在同一微任务批次内，外部不可观测。
    // 因此这里等的是修复后的不变量：终态已落定且无在途残留（写坏修复会在本行超时红）。
    await waitFor(
      () =>
        useAgentSessionStore.getState().errorsBySessionId['sess-seam-fail-1'] !== undefined &&
        useAgentSessionStore.getState().inFlightBySessionId['sess-seam-fail-1'] === undefined,
      'terminal error state settled',
    );
    // ❌ 缺陷断言 1（保留失败，见交付报告「发现的缺陷」）：失败收口写下的错误态被受理续作清掉了
    expect
      .soft(useAgentSessionStore.getState().errorsBySessionId['sess-seam-fail-1'])
      .toMatchObject({ code: 'model_unavailable' });
    // ❌ 缺陷断言 2（保留失败，同一根因）：失败轮次已收口，不应残留 in-flight
    expect
      .soft(useAgentSessionStore.getState().inFlightBySessionId['sess-seam-fail-1'])
      .toBeUndefined();
    // 不自动重试：出站只有一次提交
    expect(submitFrames()).toHaveLength(1);
  });

  it('执行失败但已有流式内容：agent:error.partialContent 按 isPartial=true 落库', async () => {
    await loadAgentSessions(projectPath);
    seam.core.installSequence([
      async (params) => {
        params.onModelConfigResolved?.();
        params.onToken('半截');
        params.onToken('回答');
        throw new Error('stream broke');
      },
    ]);

    const pending = submitAgentPrompt(
      buildSubmitInput({ requestId: 'req-seam-partial-1', agentSessionId: 'sess-seam-partial-1' }),
    );
    await expect(pending).resolves.toMatchObject({ agentSessionId: 'sess-seam-partial-1' });
    await waitFor(
      () => appendedMessages().some((message) => message.role === 'assistant'),
      'partial assistant message persisted',
    );

    const errorMessage = serverMessages().find(
      (message) => message.type === AGENT_WS_MESSAGE_TYPE.ERROR,
    );
    expect(errorMessage).toMatchObject({
      code: 'execution_failed',
      partialContent: '半截回答',
    });

    const partialMessage = appendedMessages().find((message) => message.role === 'assistant');
    expect(partialMessage).toMatchObject({
      agentSessionId: 'sess-seam-partial-1',
      requestId: 'req-seam-partial-1',
      body: { kind: 'chat', content: '半截回答' },
      isPartial: true,
    });
    // ❌ 缺陷断言 1（保留失败，见交付报告「发现的缺陷」）：正式消息顺序应为 user → partial assistant
    expect.soft(appendedMessages().map((message) => message.role)).toEqual(['user', 'assistant']);
    // ❌ 缺陷断言 2（保留失败，同一根因）：失败轮次已收口，不应残留 in-flight
    expect
      .soft(useAgentSessionStore.getState().inFlightBySessionId['sess-seam-partial-1'])
      .toBeUndefined();
    expect(submitFrames()).toHaveLength(1);
  });

  it('取消（agent:cancel）：按节点终止在途轮次，不产生新轮次消息、不自动重试', async () => {
    await loadAgentSessions(projectPath);
    const coreReached = createGate();
    seam.core.installSequence([
      async (params) => {
        params.onModelConfigResolved?.();
        params.onToken('截断');
        coreReached.open();
        await new Promise<never>((_resolve, reject) => {
          params.abortSignal.addEventListener('abort', () => {
            reject(new Error('aborted by client'));
          });
        });
        throw new Error('unreachable: core must reject after abort');
      },
    ]);

    const pending = submitAgentPrompt(
      buildSubmitInput({ requestId: 'req-seam-cancel-1', agentSessionId: 'sess-seam-cancel-1' }),
    );
    await waitFor(() => agentNodes().length === 1, 'agent node created');
    const agentNodeId = agentNodes()[0]?.id ?? '';
    await coreReached.promise;
    await expect(pending).resolves.toMatchObject({ agentSessionId: 'sess-seam-cancel-1' });

    await cancelAgentSessionForNode(agentNodeId);
    await waitFor(
      () => serverMessages().some((message) => message.type === AGENT_WS_MESSAGE_TYPE.ERROR),
      'cancelled error delivered',
    );

    const cancelFrame = frameAt(
      framesOfType(seam.wire.outbound, AGENT_WS_MESSAGE_TYPE.CANCEL),
      0,
    );
    expect(AgentClientMessageSchema.parse(cancelFrame.payload)).toEqual(cancelFrame.payload);

    const errorMessage = serverMessages().find(
      (message) => message.type === AGENT_WS_MESSAGE_TYPE.ERROR,
    );
    expect(errorMessage).toMatchObject({
      requestId: 'req-seam-cancel-1',
      agentSessionId: 'sess-seam-cancel-1',
      code: 'cancelled',
      partialContent: '截断',
    });
    expect(useAgentSessionStore.getState().errorsBySessionId['sess-seam-cancel-1']).toMatchObject({
      code: 'cancelled',
    });
    expect(useAgentSessionStore.getState().inFlightBySessionId['sess-seam-cancel-1']).toBeUndefined();
    // 只有一轮：user + 中断的 partial assistant，没有新轮次消息，也没有补发/重试
    expect(appendedMessages().map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(appendedMessages()[1]?.isPartial).toBe(true);
    expect(submitFrames()).toHaveLength(1);
  });

  it('消息落库链：存储写入端维护 lastMessageAt，Editor 读回与内存投影取同一值（配置变更不移动它）', async () => {
    await loadAgentSessions(projectPath);
    seam.core.installSequence([
      async (params) => {
        params.onModelConfigResolved?.();
        params.onToken('夜景');
        return assistantResult('夜景改造完成');
      },
    ]);

    const agentSessionId = 'sess-seam-last-message';
    const pending = submitAgentPrompt(
      buildSubmitInput({ requestId: 'req-seam-lm-1', agentSessionId }),
    );
    const accepted = await pending;
    await waitFor(
      () => appendedMessages().filter((message) => message.role === 'assistant').length === 1,
      'assistant message persisted',
    );

    // ── 环 1：写入端（存储替身按生产写入端语义维护）→ 读回契约记录 ──
    const readBack = await agentSessionStorage.readAgentSessionByNodeId(
      projectPath,
      accepted.nodeId,
    );
    const persistedMessages = appendedMessages();
    const lastMessageCreatedAt = Math.max(...persistedMessages.map((message) => message.createdAt));
    expect(readBack).not.toBeNull();
    expect(readBack?.messageCount).toBe(persistedMessages.length);
    expect(readBack?.lastMessageAt).toBe(lastMessageCreatedAt);
    // 与 updatedAt 是两个口径：创建时的 updatedAt 更早，消息追加后 lastMessageAt 与最后一条消息一致。
    expect(readBack?.lastMessageAt).toBeGreaterThan(0);

    // ── 环 2：Editor 内存投影同步推进（会话记录创建时为 null，不靠刷新兜） ──
    const projected = useAgentSessionStore.getState().sessionsById[agentSessionId];
    expect(projected?.lastMessageAt).toBe(lastMessageCreatedAt);

    // ── 环 3：配置变更不改写「最近一次对话」时间（Editor 只透传存储值，不自造时间） ──
    await updateAgentSessionConfig(agentSessionId, { thinkingTier: 'high' });
    const upsertCalls = seam.memoryStorage.callsOf(EDITOR_STORAGE_IPC_CHANNELS.UPSERT_AGENT_SESSION);
    const configUpsert = StorageUpsertAgentSessionParamsSchema.parse(
      upsertCalls[upsertCalls.length - 1]?.params,
    ).session;
    expect(configUpsert.thinkingTier).toBe('high');
    expect(configUpsert.lastMessageAt).toBe(lastMessageCreatedAt);
    expect(useAgentSessionStore.getState().sessionsById[agentSessionId]?.lastMessageAt).toBe(
      lastMessageCreatedAt,
    );
  });

  it('作用域失败面：projectPath 不是已打开项目 → invalid_request，不读历史、不建节点、不写会话与正式消息', async () => {
    const notOpenedPath = `${projectPath}-not-opened`;
    await loadAgentSessions(notOpenedPath);
    seam.core.installSequence([async () => assistantResult('never')]);

    const pending = submitAgentPrompt(
      buildSubmitInput({ requestId: 'req-seam-scope-1', agentSessionId: 'sess-seam-scope-1' }),
    );
    await expect(pending).rejects.toThrow(/not an open project/);
    await waitFor(
      () => serverMessages().some((message) => message.type === AGENT_WS_MESSAGE_TYPE.ERROR),
      'invalid_request error delivered',
    );

    expect(submitFrame().payload).toMatchObject({ projectPath: notOpenedPath });
    const errorMessage = serverMessages().find(
      (message) => message.type === AGENT_WS_MESSAGE_TYPE.ERROR,
    );
    expect(errorMessage).toMatchObject({ code: 'invalid_request', partialContent: null });
    // 未发起历史读取、未执行模型
    expect(seam.core.historyReadRequests).toEqual([]);
    expect(seam.core.calls).toEqual([]);
    // Editor 未创建节点、未写会话与正式消息；只有发送留痕保留（供用户手动重试）
    expect(agentNodes()).toEqual([]);
    expect(
      seam.memoryStorage.callsOf(EDITOR_STORAGE_IPC_CHANNELS.UPSERT_AGENT_SESSION),
    ).toEqual([]);
    expect(seam.memoryStorage.callsOf(EDITOR_STORAGE_IPC_CHANNELS.APPEND_AGENT_MESSAGE)).toEqual([]);
    expect(writeChannelOrder()).toEqual([EDITOR_STORAGE_IPC_CHANNELS.APPEND_AGENT_SEND_RECORD]);
    expect(
      StorageAppendAgentSendRecordParamsSchema.parse(
        storageCallAt(EDITOR_STORAGE_IPC_CHANNELS.APPEND_AGENT_SEND_RECORD, 0).params,
      ).sendRecord.nodeId,
    ).toBeNull();
    expect(useAgentSessionStore.getState().errorsBySessionId['sess-seam-scope-1']).toMatchObject({
      code: 'invalid_request',
    });
  });
});
