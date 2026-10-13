/**
 * Agent 工具调用循环接缝集成测试（spec 04「规划与工具调用编排 / 工具调用循环语义」）。
 *
 * 使命：复用受理主链接缝的两端真实实现（Editor 真实 AgentSocketClient / 会话 store /
 * 存储封装；Backend 真实 handleAgentMessage / 工具调用循环编排 / 审批裁定 / 工具执行分派），
 * 验证「模型请求工具 → 提案 → 决裁 → 执行 → 结果回灌 → 下一轮模型调用」的首尾闭环。
 *
 * 工具本身不执行真实生成/加工（本机没有可用目录与媒体文件）：用「已注册工具但参数非法」
 * 「未勾选提交」「轮数上限」三条路径覆盖循环、裁定与回写语义——失败回灌也是循环语义的一部分
 * （spec 04：单条工具失败仅阻断该条目，错误摘要交回模型，不自动重试）。
 * 未注册工具名不进提案（早失败分支，无 proposal 事件），不作为本表覆盖面。
 *
 * 时序注意：submitAgentPrompt 的 promise 在**受理时** resolve（不是轮次终态）；
 * 断言轮次终态前必须等 `agent:complete` 帧到达。
 * 替身与加载桥见 helpers/agentSessionSeamHarness.ts（工具调用记录通道已随本批补齐）。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  AGENT_WS_MESSAGE_TYPE,
  EDITOR_STORAGE_IPC_CHANNELS,
  StorageAppendAgentMessageParamsSchema,
  StorageAppendAgentToolCallParamsSchema,
  type AgentMessageAppendParams,
} from '@iart/contracts';

import { useRuntimeStore } from '@/client/store/runtimeStore';
import { loadAgentSessions, submitAgentPrompt, useAgentSessionStore, type AgentSubmitInput } from '@/features/agent/agentSessionStore';
import { agentSocket } from '@/features/agent/agentSocket';
import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import { createNodeGraph } from '@/features/canvas/types/nodeGraph';
import {
  assistantResult,
  createAgentSessionSeam,
  toolCallResult,
  waitFor,
  type AgentSessionSeam,
  type WireFrame,
} from './helpers/agentSessionSeamHarness';

let seam: AgentSessionSeam;
let projectPath = '';

const resetCanvas = (): void => {
  useCanvasStore.setState((state) => {
    state.nodeGraph = createNodeGraph({
      name: 'agent-tool-seam',
      description: undefined,
      tags: undefined,
      category: undefined,
    });
    state.ui.canvasContainerSize = { width: 1440, height: 900 };
    state.selectedNodeIds = [];
  });
};

const framesOfType = (frames: WireFrame[], type: string): WireFrame[] =>
  frames.filter((frame) => (frame.payload as { type?: unknown }).type === type);

/** 等待本轮终态（complete 帧到达；提交 promise 在受理时即 resolve，不等待轮次）。 */
const awaitRoundComplete = async (): Promise<void> => {
  await waitFor(
    () => framesOfType(seam.wire.inbound, AGENT_WS_MESSAGE_TYPE.COMPLETE).length === 1,
    'round complete frame',
  );
};

const appendedMessages = (): AgentMessageAppendParams[] =>
  seam.memoryStorage.callsOf(EDITOR_STORAGE_IPC_CHANNELS.APPEND_AGENT_MESSAGE).map((call) => {
    return StorageAppendAgentMessageParamsSchema.parse(call.params).message;
  });

const appendedToolCalls = () =>
  seam.memoryStorage.callsOf(EDITOR_STORAGE_IPC_CHANNELS.APPEND_AGENT_TOOL_CALL).map((call) => {
    return StorageAppendAgentToolCallParamsSchema.parse(call.params).toolCall;
  });

const updatedToolCallParams = (): Array<Record<string, unknown>> =>
  seam.memoryStorage.callsOf(EDITOR_STORAGE_IPC_CHANNELS.UPDATE_AGENT_TOOL_CALL).flatMap((call) => {
    const params = call.params as { update?: Record<string, unknown> };
    return params.update ? [params.update] : [];
  });

const buildSubmitInput = (overrides: Partial<AgentSubmitInput>): AgentSubmitInput => ({
  requestId: 'req-tool-seam',
  agentSessionId: 'sess-tool-seam',
  nodeId: null,
  modelId: 'llm-seam-1',
  thinkingTier: 'high',
  approvalMode: 'yolo',
  content: '帮我把这张图裁一下',
  referenceAssetIds: ['asset-a'],
  referenceAssets: [
    {
      assetId: 'asset-a',
      mediaType: 'image',
      url: 'local-media://prj-demo/media/a.png',
      width: 1024,
      height: 768,
      durationMs: null,
      summary: 'a.png',
    },
  ],
  ...overrides,
});

beforeAll(async () => {
  seam = await createAgentSessionSeam();
  projectPath = seam.createOpenedProject('agent-tool-seam');
  useRuntimeStore.setState({ backendBaseUrl: 'http://127.0.0.1:51998', projectPath });
});

afterAll(() => {
  seam.teardown();
});

beforeEach(() => {
  seam.reset();
  useAgentSessionStore.getState().reset();
  resetCanvas();
});

describe('Agent 工具调用循环接缝：Editor ↔ Backend', () => {
  it('yolo：已注册工具提案直派发 → 参数非法按失败回灌 → 第二轮收到 tool 消息（提案/记录/消息三层齐写）', async () => {
    await loadAgentSessions(projectPath);
    seam.core.installSequence([
      async (params) => {
        params.onModelConfigResolved?.();
        return toolCallResult('我先处理一下', [
          { id: 'call-1', name: 'crop_image', argsJson: '{"asset_id":"asset-a"}' },
        ]);
      },
      async (params) => {
        params.onModelConfigResolved?.();
        return assistantResult('这个工具没能执行，换个说法。');
      },
    ]);

    const pending = submitAgentPrompt(buildSubmitInput({ requestId: 'req-tool-1', agentSessionId: 'sess-tool-1' }));
    await expect(pending).resolves.toMatchObject({ agentSessionId: 'sess-tool-1' });
    await awaitRoundComplete();

    // ── 出站事件顺序：提案 proposed → 派发 dispatching → 终态 failed ──
    const toolCallFrames = framesOfType(seam.wire.inbound, AGENT_WS_MESSAGE_TYPE.TOOL_CALL).map(
      (frame) => frame.payload as { status: string; toolKind: string; modelId: unknown; proposalExpiresAt: unknown },
    );
    expect(toolCallFrames.map((frame) => frame.status)).toEqual(['proposed', 'dispatching']);
    // 加工类工具：无目标模型（modelId null）、无提案超时基准（yolo 直派发）。
    expect(toolCallFrames[0]).toMatchObject({
      toolKind: 'processing',
      modelId: null,
      proposalExpiresAt: null,
    });

    const resultFrames = framesOfType(seam.wire.inbound, AGENT_WS_MESSAGE_TYPE.TOOL_RESULT).map(
      (frame) => frame.payload as { status: string; errorSummary: string | null },
    );
    expect(resultFrames).toHaveLength(1);
    expect(resultFrames[0]).toMatchObject({ status: 'failed' });
    // 失败摘要可读（不是 zod 原文 JSON dump），列明缺失的裁剪参数。
    expect(resultFrames[0]?.errorSummary ?? '').toContain('裁剪参数');

    // ── 中间轮助手消息定稿事件（携带 toolCalls）──
    const assistantMessageFrames = framesOfType(
      seam.wire.inbound,
      AGENT_WS_MESSAGE_TYPE.ASSISTANT_MESSAGE,
    ).map((frame) => frame.payload as { content: unknown; toolCalls: unknown[] });
    expect(assistantMessageFrames).toHaveLength(1);
    expect(assistantMessageFrames[0]).toMatchObject({ content: '我先处理一下' });
    expect(assistantMessageFrames[0]?.toolCalls).toHaveLength(1);

    // ── 第二轮模型上下文：assistant toolCalls + role tool 结果都在 ──
    expect(seam.core.calls).toHaveLength(2);
    const secondCall = seam.core.calls[1];
    expect(secondCall?.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
    ]);
    const toolMessage = secondCall?.messages[2];
    expect(
      toolMessage && 'toolCallId' in toolMessage ? String(toolMessage.content) : '',
    ).toContain('crop_image');

    // ── 落库四层：user 消息（受理）+ chat 中间轮消息 + tool_call 消息 + tool_result 消息
    //    + 最终 assistant 消息（complete 收口，等落库完成后再断言全序）──
    await waitFor(
      () => appendedMessages().length >= 5,
      'all round messages persisted',
    );
    const messages = appendedMessages();
    expect(messages.map((message) => message.body.kind)).toEqual([
      'chat',
      'chat',
      'tool_call',
      'tool_result',
      'chat',
    ]);
    expect(messages[0]).toMatchObject({ role: 'user', body: { kind: 'chat', content: '帮我把这张图裁一下' } });
    expect(messages[1]).toMatchObject({ role: 'assistant', body: { kind: 'chat', content: '我先处理一下' } });
    expect(messages[2]).toMatchObject({
      role: 'assistant',
      body: { kind: 'tool_call', toolName: 'crop_image', toolKind: 'processing', modelId: null },
    });
    expect(messages[3]).toMatchObject({
      role: 'system',
      body: { kind: 'tool_result', status: 'failed' },
    });
    expect(messages[4]).toMatchObject({ role: 'assistant', body: { kind: 'chat' } });

    const records = appendedToolCalls();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ toolCallId: 'call-1', status: 'proposed' });
    // 工具调用记录的状态推进与消息落库是两条独立的异步写：Editor 侧按 toolCallId 串行落在
    // 提案 append 之后（`agentRoundEvents` 的写入链），不保证早于消息落库。断言记录终态前
    // 先等这条写到达（等待条件只补同步，断言口径不变）。
    await waitFor(
      () => updatedToolCallParams().some((params) => params.status === 'failed'),
      'tool call record settled to failed',
    );
    expect(updatedToolCallParams().map((params) => params.status)).toContain('failed');
  });

  it('confirm：待决提案携带批级超时基准 → 批量勾选提交（未勾选）→ 结果 skipped 回灌且记录落 skipped', async () => {
    await loadAgentSessions(projectPath);
    seam.core.installSequence([
      async (params) => {
        params.onModelConfigResolved?.();
        return toolCallResult('', [
          { id: 'call-skip-1', name: 'crop_image', argsJson: '{"asset_id":"asset-a"}' },
        ]);
      },
      async (params) => {
        params.onModelConfigResolved?.();
        return assistantResult('已跳过，直接说明。');
      },
    ]);

    const pending = submitAgentPrompt(
      buildSubmitInput({
        requestId: 'req-tool-2',
        agentSessionId: 'sess-tool-2',
        approvalMode: 'confirm',
      }),
    );
    await expect(pending).resolves.toMatchObject({ agentSessionId: 'sess-tool-2' });

    // 提案到达（confirm 档带批级超时基准）后由 Editor 侧按批提交勾选结果（本条未勾选）。
    await waitFor(
      () => framesOfType(seam.wire.inbound, AGENT_WS_MESSAGE_TYPE.TOOL_CALL).length >= 1,
      'proposal frame',
    );
    const proposal = framesOfType(seam.wire.inbound, AGENT_WS_MESSAGE_TYPE.TOOL_CALL)[0]
      ?.payload as { proposalExpiresAt: number | null };
    expect(proposal?.proposalExpiresAt).toBeGreaterThan(Date.now() - 1000);

    agentSocket.sendToolDecision({
      type: AGENT_WS_MESSAGE_TYPE.TOOL_DECISION,
      requestId: 'req-tool-2',
      agentSessionId: 'sess-tool-2',
      decision: 'submit',
      decisions: [{ toolCallId: 'call-skip-1', execute: false }],
    });

    await awaitRoundComplete();

    const resultFrames = framesOfType(seam.wire.inbound, AGENT_WS_MESSAGE_TYPE.TOOL_RESULT).map(
      (frame) => frame.payload as { status: string; errorSummary: string | null },
    );
    expect(resultFrames).toHaveLength(1);
    expect(resultFrames[0]).toMatchObject({ status: 'skipped', errorSummary: '未勾选，未执行' });

    expect(updatedToolCallParams().map((params) => params.status)).toContain('skipped');
    // 决裁为跳过：工具从未派发，dispatching 状态不出现。
    const statuses = framesOfType(seam.wire.inbound, AGENT_WS_MESSAGE_TYPE.TOOL_CALL).map(
      (frame) => (frame.payload as { status: string }).status,
    );
    expect(statuses).toEqual(['proposed']);
  });

  it('轮数上限：工具轮达到 8 轮后，下一轮请求不再携带 tools，强制文本收口', async () => {
    await loadAgentSessions(projectPath);
    const toolRound = async (params: {
      onModelConfigResolved?: () => void;
    }): Promise<{ message: { content: string; toolCalls: Array<{ id: string; name: string; argsJson: string }> } }> => {
      params.onModelConfigResolved?.();
      return toolCallResult('', [
        { id: `call-loop-${Math.random()}`, name: 'unknown_tool', argsJson: '{}' },
      ]);
    };
    seam.core.installSequence([
      toolRound,
      toolRound,
      toolRound,
      toolRound,
      toolRound,
      toolRound,
      toolRound,
      toolRound,
      async (params) => {
        params.onModelConfigResolved?.();
        return assistantResult('收口。');
      },
    ]);

    const pending = submitAgentPrompt(buildSubmitInput({ requestId: 'req-tool-3', agentSessionId: 'sess-tool-3' }));
    await expect(pending).resolves.toMatchObject({ agentSessionId: 'sess-tool-3' });
    await awaitRoundComplete();

    // 前 8 轮携带 tools；第 9 轮（达上限后）不再携带。
    expect(seam.core.calls).toHaveLength(9);
    for (let index = 0; index < 8; index += 1) {
      expect(seam.core.calls[index]?.tools).toBeDefined();
    }
    expect(seam.core.calls[8]?.tools).toBeUndefined();
  });
});
