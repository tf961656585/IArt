import { describe, expect, it } from 'vitest';

import {
  AGENT_WS_ERROR_CODES,
  AGENT_WS_MESSAGE_TYPE,
  AgentClientMessageSchema,
  AgentMessageAppendParamsSchema,
  AgentMessageRecordSchema,
  AgentSendRecordSchema,
  AgentServerMessageSchema,
  AgentSessionRecordSchema,
  AgentToolCallAppendParamsSchema,
  AgentToolCallRecordSchema,
} from '../src/agent-contract';
import { parseAgentTaskLineage } from '../src/agent-tools-contract';
import {
  StorageAppendAgentMessageResultSchema,
  StorageAppendAgentToolCallParamsSchema,
  StorageReadAgentMessagesParamsSchema,
  StorageReadAgentMessagesResultSchema,
  StorageReadAgentSessionsResultSchema,
  StorageReadAgentToolCallsResultSchema,
  StorageUpdateAgentToolCallParamsSchema,
  StorageUpsertAgentSessionParamsSchema,
} from '../src/agent-session-storage-contract';
import { ReadAgentMessagesPayloadSchema } from '../src/runtime-transaction';

const sessionRecord = {
  agentSessionId: 'agent-session-1',
  nodeId: 'node-agent-1',
  modelId: 'chat-model-1',
  thinkingTier: 'off',
  approvalMode: 'confirm',
  title: '会话标题',
  createdAt: 1,
  updatedAt: 2,
  messageCount: 1,
  lastMessageAt: 3,
};

const assistantMessage = {
  agentSessionId: 'agent-session-1',
  seq: 1,
  role: 'assistant',
  requestId: 'req-1',
  body: { kind: 'chat', content: '改写后的文字' },
  plan: {
    steps: [{ stepId: 'step-1', order: 1, title: '整理素材', status: 'pending' }],
  },
  createdAt: 3,
  isPartial: false,
};

const sendRecord = {
  recordId: 'send-1',
  agentSessionId: 'agent-session-1',
  nodeId: 'node-agent-1',
  requestId: 'req-1',
  createdAt: 4,
  content: [{ type: 'text', text: '你好' }],
  referenceAssetIds: ['asset-1'],
  snapshot: {
    modelId: 'chat-model-1',
    thinkingTier: 'off',
    approvalMode: 'yolo',
    referenceAssetIds: ['asset-1'],
    submittedAt: 4,
  },
};

describe('agent contract records round-trip', () => {
  it('会话的 lastMessageAt 为最后一条消息时间；零消息会话为 null', () => {
    expect(AgentSessionRecordSchema.parse(sessionRecord).lastMessageAt).toBe(3);
    expect(
      AgentSessionRecordSchema.parse({ ...sessionRecord, messageCount: 0, lastMessageAt: null })
        .lastMessageAt,
    ).toBeNull();
    // 字段缺失即契约违约（不静默收敛成 null）：避免调用方漏传而被当成「还没有消息」
    const missing = { ...sessionRecord } as Record<string, unknown>;
    delete missing['lastMessageAt'];
    expect(AgentSessionRecordSchema.safeParse(missing).success).toBe(false);
  });


  it('parses session / message / send record through structured clone round-trip', () => {
    expect(AgentSessionRecordSchema.parse(structuredClone(sessionRecord))).toEqual(sessionRecord);
    expect(AgentMessageRecordSchema.parse(structuredClone(assistantMessage))).toEqual(
      assistantMessage,
    );
    expect(AgentSendRecordSchema.parse(structuredClone(sendRecord))).toEqual(sendRecord);

    // 首条消息留痕在受理前写入：此时既无 Agent 节点，nodeId 为 null（不是空串哨兵）。
    const firstSendRecord = { ...sendRecord, nodeId: null };
    expect(AgentSendRecordSchema.parse(structuredClone(firstSendRecord))).toEqual(firstSendRecord);
    // nodeId 可空但不可缺省：调用方必须显式表达「有宿主 / 尚无宿主」。
    const { nodeId: _nodeId, ...withoutNodeId } = sendRecord;
    expect(AgentSendRecordSchema.safeParse(withoutNodeId).success).toBe(false);
  });

  it('parses tool call / tool result message bodies with tool kind and error summary', () => {
    const toolCall = AgentMessageRecordSchema.parse({
      ...assistantMessage,
      body: {
        kind: 'tool_call',
        toolCallId: 'tool-call-1',
        toolName: 'generate_image',
        toolKind: 'generation',
        modelId: 'image-model-1',
        argsJson: '{"prompt":"一只猫"}',
      },
      plan: null,
    });
    expect(toolCall.body.kind).toBe('tool_call');

    // 加工类工具不指向生成模型：modelId 为 null（不是缺省）。
    const processingToolCall = AgentMessageRecordSchema.parse({
      ...assistantMessage,
      seq: 3,
      body: {
        kind: 'tool_call',
        toolCallId: 'tool-call-2',
        toolName: 'crop_image',
        toolKind: 'processing',
        modelId: null,
        argsJson: '{"asset_id":"asset-1"}',
      },
      plan: null,
    });
    expect(
      processingToolCall.body.kind === 'tool_call' && processingToolCall.body.modelId,
    ).toBeNull();

    const toolResult = AgentMessageRecordSchema.parse({
      ...assistantMessage,
      seq: 2,
      role: 'user',
      body: {
        kind: 'tool_result',
        toolCallId: 'tool-call-1',
        toolName: 'generate_image',
        status: 'succeeded',
        summary: '已生成 1 张图片',
        assetIds: ['asset-2'],
        errorSummary: null,
      },
    });
    expect(toolResult.body.kind).toBe('tool_result');

    // skipped 覆盖用户跳过与提案超时两种未执行结算。
    expect(
      AgentMessageRecordSchema.parse({
        ...assistantMessage,
        seq: 4,
        role: 'user',
        body: {
          kind: 'tool_result',
          toolCallId: 'tool-call-2',
          toolName: 'crop_image',
          status: 'skipped',
          summary: '已跳过',
          assetIds: [],
          errorSummary: '提案超时未决',
        },
      }).body,
    ).toMatchObject({ status: 'skipped' });

    // toolKind 缺失即拒绝（工具类别是两类工具共路的第一判别字段）。
    expect(
      AgentMessageRecordSchema.safeParse({
        ...assistantMessage,
        body: {
          kind: 'tool_call',
          toolCallId: 'tool-call-3',
          toolName: 'generate_image',
          modelId: 'image-model-1',
          argsJson: '{}',
        },
      }).success,
    ).toBe(false);

    expect(
      AgentMessageRecordSchema.safeParse({
        ...assistantMessage,
        body: { kind: 'unknown', content: 'x' },
      }).success,
    ).toBe(false);
  });

  it('parses tool call record with lifecycle statuses', () => {
    const record = {
      toolCallId: 'tool-call-1',
      agentSessionId: 'agent-session-1',
      seq: 1,
      toolName: 'generate_image',
      toolKind: 'generation',
      modelId: 'image-model-1',
      status: 'running',
      batchId: 'batch-1',
      taskIds: ['task-1'],
      assetIds: [],
      errorSummary: null,
      createdAt: 10,
      updatedAt: 11,
    };
    expect(AgentToolCallRecordSchema.parse(structuredClone(record))).toEqual(record);

    // 加工类记录：无派生批次与任务，modelId 为 null。
    expect(
      AgentToolCallRecordSchema.parse({
        ...record,
        toolCallId: 'tool-call-2',
        toolName: 'trim_video',
        toolKind: 'processing',
        modelId: null,
        batchId: null,
        taskIds: [],
        status: 'succeeded',
        assetIds: ['asset-9'],
      }),
    ).toMatchObject({ toolKind: 'processing', modelId: null, batchId: null });

    // 状态集合封闭：未知状态与未执行结算语义一并钉住（跳过/超时都以 skipped 承载，来源经 errorSummary 区分）。
    expect(AgentToolCallRecordSchema.safeParse({ ...record, status: 'pending' }).success).toBe(
      false,
    );
    expect(
      AgentToolCallRecordSchema.parse({ ...record, status: 'skipped', errorSummary: '提案超时未决，已关闭' }),
    ).toMatchObject({ status: 'skipped', errorSummary: '提案超时未决，已关闭' });

    // 追加形状不含 seq（序号由存储写入端分配）。
    const { seq: _seq, ...appendParams } = record;
    expect('seq' in AgentToolCallAppendParamsSchema.parse(appendParams)).toBe(false);

    expect(
      StorageAppendAgentToolCallParamsSchema.parse({
        projectPath: '/tmp/p',
        toolCall: appendParams,
      }).toolCall.toolCallId,
    ).toBe('tool-call-1');
    expect(
      StorageReadAgentToolCallsResultSchema.parse({ toolCalls: [record] }).toolCalls,
    ).toHaveLength(1);
    expect(
      StorageUpdateAgentToolCallParamsSchema.parse({
        projectPath: '/tmp/p',
        update: {
          agentSessionId: 'agent-session-1',
          toolCallId: 'tool-call-1',
          status: 'succeeded',
          assetIds: ['asset-2'],
        },
      }).update.status,
    ).toBe('succeeded');
  });

  it('narrows agent task lineage from task metadata', () => {
    const lineage = { agentSessionId: 'agent-session-1', toolCallId: 'tool-call-1' };
    expect(parseAgentTaskLineage({ agentLineage: lineage })).toEqual(lineage);
    // 键不匹配或形状不完整一律 null（Editor 据此判定是否跳过任务节点投影，不猜测）。
    expect(parseAgentTaskLineage({ agentLineage: { agentSessionId: 's1' } })).toBeNull();
    expect(parseAgentTaskLineage({ otherKey: lineage })).toBeNull();
    expect(parseAgentTaskLineage(null)).toBeNull();
  });

  it('omits seq from append params and requires seq on records', () => {
    const { seq, ...appendParams } = assistantMessage;
    expect(seq).toBe(1);
    expect(AgentMessageAppendParamsSchema.parse(appendParams)).toEqual(appendParams);
    // 追加形状不含 seq（序号由存储写入端分配）；额外传入 seq 会被形状剥离。
    expect('seq' in AgentMessageAppendParamsSchema.parse(assistantMessage)).toBe(false);
    expect(AgentMessageAppendParamsSchema.safeParse({ ...appendParams, isPartial: 'yes' }).success)
      .toBe(false);
    expect(AgentSessionRecordSchema.safeParse({ ...sessionRecord, approvalMode: 'auto' }).success)
      .toBe(false);
  });
});

describe('agent WS contract', () => {
  it('parses client submit / cancel / tool decision messages', () => {
    const submit = AgentClientMessageSchema.parse({
      type: AGENT_WS_MESSAGE_TYPE.SUBMIT_PROMPT,
      requestId: 'req-1',
      agentSessionId: 'agent-session-1',
      projectPath: '/tmp/p',
      modelId: 'chat-model-1',
      thinkingTier: 'off',
      approvalMode: 'confirm',
      content: '帮我整理素材',
      referenceAssetIds: ['asset-1'],
    });
    expect(submit.type).toBe('agent:submit_prompt');
    expect(submit.projectPath).toBe('/tmp/p');
    // 旧版提交载荷无 referenceAssets 简报：按空清单收敛，不拒绝。
    expect(submit.referenceAssets).toEqual([]);

    // projectPath 是 Backend 定位项目库的唯一来源，缺失即不可受理。
    expect(
      AgentClientMessageSchema.safeParse({
        type: AGENT_WS_MESSAGE_TYPE.SUBMIT_PROMPT,
        requestId: 'req-1',
        agentSessionId: 'agent-session-1',
        modelId: 'chat-model-1',
        thinkingTier: 'off',
        approvalMode: 'confirm',
        content: '帮我整理素材',
        referenceAssetIds: [],
      }).success,
    ).toBe(false);

    const cancel = AgentClientMessageSchema.parse({
      type: AGENT_WS_MESSAGE_TYPE.CANCEL,
      agentSessionId: 'agent-session-1',
      requestId: 'req-1',
    });
    expect(cancel.type).toBe('agent:cancel');

    // 批量决裁形态：`submit` 携带整批执行/不执行映射，`reject_round` 不带 decisions。
    const submitDecision = {
      type: AGENT_WS_MESSAGE_TYPE.TOOL_DECISION,
      requestId: 'req-1',
      agentSessionId: 'agent-session-1',
      decision: 'submit',
      decisions: [
        { toolCallId: 'tool-call-1', execute: true },
        { toolCallId: 'tool-call-2', execute: false },
      ],
    } as const;
    expect(AgentClientMessageSchema.parse(submitDecision)).toEqual(submitDecision);

    expect(
      AgentClientMessageSchema.safeParse({
        type: AGENT_WS_MESSAGE_TYPE.TOOL_DECISION,
        requestId: 'req-1',
        agentSessionId: 'agent-session-1',
        decision: 'reject_round',
      }).success,
    ).toBe(true);

    // 空执行映射、未知 decision、以及已退场的单条决裁（confirm/skip + toolCallId）一律拒绝。
    expect(AgentClientMessageSchema.safeParse({ ...submitDecision, decisions: [] }).success).toBe(false);
    expect(AgentClientMessageSchema.safeParse({ ...submitDecision, decision: 'edit' }).success).toBe(false);
    expect(
      AgentClientMessageSchema.safeParse({
        type: AGENT_WS_MESSAGE_TYPE.TOOL_DECISION,
        requestId: 'req-1',
        agentSessionId: 'agent-session-1',
        toolCallId: 'tool-call-1',
        decision: 'confirm',
      }).success,
    ).toBe(false);
  });

  it('parses accepted / token / complete / error server messages', () => {
    const accepted = AgentServerMessageSchema.parse({
      type: AGENT_WS_MESSAGE_TYPE.ACCEPTED,
      requestId: 'req-1',
      agentSessionId: 'agent-session-1',
    });
    expect(accepted.type).toBe('agent:accepted');

    const token = AgentServerMessageSchema.parse({
      type: AGENT_WS_MESSAGE_TYPE.TOKEN,
      requestId: 'req-1',
      agentSessionId: 'agent-session-1',
      delta: '改写',
    });
    expect(token.type).toBe('agent:token');

    // 中间轮助手消息：只在携带 toolCalls 的轮次发出，落一条带工具调用的 assistant 消息。
    const assistantMessageEvent = AgentServerMessageSchema.parse({
      type: AGENT_WS_MESSAGE_TYPE.ASSISTANT_MESSAGE,
      requestId: 'req-1',
      agentSessionId: 'agent-session-1',
      content: '我先裁剪这张图',
      toolCalls: [{ id: 'call-9', name: 'crop_image', argsJson: '{"asset_id":"a1"}' }],
    });
    expect(assistantMessageEvent.type).toBe('agent:assistant_message');

    const toolCall = AgentServerMessageSchema.parse({
      type: AGENT_WS_MESSAGE_TYPE.TOOL_CALL,
      requestId: 'req-1',
      agentSessionId: 'agent-session-1',
      toolCallId: 'tool-call-1',
      toolName: 'generate_image',
      toolKind: 'generation',
      modelId: 'image-model-1',
      argsJson: '{"prompt":"一只猫"}',
      status: 'proposed',
      proposalExpiresAt: 1_000,
    });
    expect(toolCall.type).toBe('agent:tool_call');
    // yolo 直派发无提案超时基准；加工类无目标模型。
    expect(
      AgentServerMessageSchema.parse({
        type: AGENT_WS_MESSAGE_TYPE.TOOL_CALL,
        requestId: 'req-1',
        agentSessionId: 'agent-session-1',
        toolCallId: 'tool-call-2',
        toolName: 'crop_image',
        toolKind: 'processing',
        modelId: null,
        argsJson: '{}',
        status: 'running',
        proposalExpiresAt: null,
      }),
    ).toMatchObject({ status: 'running', proposalExpiresAt: null });

    const toolResult = AgentServerMessageSchema.parse({
      type: AGENT_WS_MESSAGE_TYPE.TOOL_RESULT,
      requestId: 'req-1',
      agentSessionId: 'agent-session-1',
      toolCallId: 'tool-call-1',
      toolName: 'generate_image',
      status: 'succeeded',
      summary: '已生成 1 张图片',
      assetIds: ['asset-2'],
      batchId: 'batch-1',
      taskIds: ['task-1'],      assets: [
        {
          assetId: 'asset-2',
          mediaType: 'image',
          url: 'local-media://project-1/media/generated/a.png',
          thumbnailUrl: 'local-media://project-1/media/thumbnails/t.webp',
          width: 1024,
          height: 768,
          durationMs: null,
        },
      ],
      errorSummary: null,
    });
    expect(toolResult.type).toBe('agent:tool_result');
    expect(
      AgentServerMessageSchema.safeParse({
        type: AGENT_WS_MESSAGE_TYPE.TOOL_RESULT,
        requestId: 'req-1',
        agentSessionId: 'agent-session-1',
        toolCallId: 'tool-call-1',
        status: 'running',
        summary: '',
        assetIds: [],
        assets: [],
        errorSummary: null,
      }).success,
    ).toBe(false);

    const complete = AgentServerMessageSchema.parse({
      type: AGENT_WS_MESSAGE_TYPE.COMPLETE,
      requestId: 'req-1',
      agentSessionId: 'agent-session-1',
      content: '改写后的文字',
    });
    expect(complete.type).toBe('agent:complete');

    const error = AgentServerMessageSchema.parse({
      type: AGENT_WS_MESSAGE_TYPE.ERROR,
      requestId: 'req-1',
      agentSessionId: 'agent-session-1',
      code: 'execution_failed',
      message: '模型调用失败',
      partialContent: '改写后',
    });
    expect(error.type).toBe('agent:error');

    expect(AgentServerMessageSchema.parse({
      type: AGENT_WS_MESSAGE_TYPE.ERROR,
      requestId: 'req-1',
      agentSessionId: 'agent-session-1',
      code: 'cancelled',
      message: '已取消',
      partialContent: null,
    })).toMatchObject({ code: 'cancelled', partialContent: null });

    expect(
      AgentServerMessageSchema.safeParse({
        type: AGENT_WS_MESSAGE_TYPE.ERROR,
        requestId: 'req-1',
        agentSessionId: 'agent-session-1',
        code: 'not_a_code',
        message: 'x',
        partialContent: null,
      }).success,
    ).toBe(false);
    expect(AGENT_WS_ERROR_CODES).toContain('model_unavailable');
  });
});

describe('agent storage IPC contract', () => {
  it('parses P 组 params / results', () => {
    expect(
      StorageReadAgentMessagesParamsSchema.parse({
        projectPath: '/tmp/p',
        agentSessionId: 'agent-session-1',
      }),
    ).toEqual({ projectPath: '/tmp/p', agentSessionId: 'agent-session-1' });
    expect(StorageReadAgentMessagesParamsSchema.safeParse({ projectPath: '/tmp/p' }).success).toBe(
      false,
    );

    expect(StorageReadAgentSessionsResultSchema.parse({ sessions: [sessionRecord] })).toEqual({
      sessions: [sessionRecord],
    });
    expect(StorageReadAgentMessagesResultSchema.parse({ messages: [assistantMessage] })).toEqual({
      messages: [assistantMessage],
    });

    const upsert = StorageUpsertAgentSessionParamsSchema.parse({
      projectPath: '/tmp/p',
      session: sessionRecord,
    });
    expect(upsert.session.agentSessionId).toBe('agent-session-1');

    expect(
      StorageAppendAgentMessageResultSchema.parse({ message: assistantMessage }).message.seq,
    ).toBe(1);
  });

  it('parses Backend → Main 会话历史读取入参', () => {
    const payload = ReadAgentMessagesPayloadSchema.parse({
      type: 'runtime:read-agent-messages',
      transactionId: 'tx-1',
      projectPath: '/tmp/p',
      agentSessionId: 'agent-session-1',
    });
    expect(payload.agentSessionId).toBe('agent-session-1');
  });
});
