import { describe, expect, it } from 'vitest';

import {
  CHAT_WS_MESSAGE_TYPE,
  ChatClientMessageSchema,
  ChatServerMessageSchema,
  ChatTemporaryCompleteSchema,
  InternalMessageSchema,
} from '../src/chat-contract';

const userMessage = {
  messageId: 'msg-user-1',
  role: 'user',
  content: '改写这段文字',
  createdAt: 1,
};

const assistantMessage = {
  messageId: 'msg-assistant-1',
  role: 'assistant',
  content: '改写后的文字',
  createdAt: 2,
  tokenCount: 6,
};

describe('chat contract temporary completion schemas', () => {
  it('parses temporary completion client messages', () => {
    const parsed = ChatClientMessageSchema.parse({
      type: CHAT_WS_MESSAGE_TYPE.TEMPORARY_COMPLETION,
      requestId: 'req-temp-1',
      modelId: 'chat-model-1',
      systemPrompt: '系统提示词',
      messages: [userMessage],
      userParams: { temperature: 0.2 },
    });

    expect(parsed.type).toBe(CHAT_WS_MESSAGE_TYPE.TEMPORARY_COMPLETION);
    expect(parsed.modelId).toBe('chat-model-1');
  });

  it('parses temporary token, complete and error server messages', () => {
    expect(
      ChatServerMessageSchema.parse({
        type: CHAT_WS_MESSAGE_TYPE.TEMPORARY_TOKEN,
        requestId: 'req-temp-1',
        text: '改写',
      }).type,
    ).toBe(CHAT_WS_MESSAGE_TYPE.TEMPORARY_TOKEN);

    const complete = ChatTemporaryCompleteSchema.parse({
      type: CHAT_WS_MESSAGE_TYPE.TEMPORARY_COMPLETE,
      requestId: 'req-temp-1',
      message: assistantMessage,
      usage: { inputTokens: 10, outputTokens: 6 },
    });
    expect(complete.type).toBe(CHAT_WS_MESSAGE_TYPE.TEMPORARY_COMPLETE);
    expect(complete.message.content).toBe('改写后的文字');

    expect(
      ChatServerMessageSchema.parse({
        type: CHAT_WS_MESSAGE_TYPE.TEMPORARY_ERROR,
        requestId: 'req-temp-1',
        error: '模型调用失败',
      }).type,
    ).toBe(CHAT_WS_MESSAGE_TYPE.TEMPORARY_ERROR);
  });

  it('rejects temporary completion without requestId', () => {
    expect(
      ChatClientMessageSchema.safeParse({
        type: CHAT_WS_MESSAGE_TYPE.TEMPORARY_COMPLETION,
        modelId: 'chat-model-1',
        messages: [userMessage],
      }).success,
    ).toBe(false);
  });
});

describe('internal message discriminated union', () => {
  it('parses chat roles and keeps base fields on every branch', () => {
    expect(InternalMessageSchema.parse(structuredClone(userMessage))).toEqual(userMessage);
    expect(InternalMessageSchema.parse(structuredClone(assistantMessage))).toEqual(assistantMessage);
    expect(
      InternalMessageSchema.parse({ ...userMessage, role: 'system', messageId: 'msg-sys-1' }),
    ).toMatchObject({ role: 'system' });
  });

  it('parses assistant toolCalls and tool result messages', () => {
    const withToolCalls = InternalMessageSchema.parse({
      messageId: 'msg-assistant-2',
      role: 'assistant',
      content: '',
      createdAt: 3,
      toolCalls: [{ id: 'call-1', name: 'generate_image', argsJson: '{"prompt":"一只猫"}' }],
    });
    expect(withToolCalls.role === 'assistant' && withToolCalls.toolCalls).toHaveLength(1);

    const toolResult = InternalMessageSchema.parse({
      messageId: 'msg-tool-1',
      role: 'tool',
      content: '已生成 1 张图片 asset-2',
      createdAt: 4,
      toolCallId: 'call-1',
      toolName: 'generate_image',
    });
    expect(toolResult.role === 'tool' && toolResult.toolCallId).toBe('call-1');

    // tool 角色必须指明被结算的 tool_call，缺 toolCallId / toolName 即拒绝。
    expect(
      InternalMessageSchema.safeParse({
        messageId: 'msg-tool-2',
        role: 'tool',
        content: 'x',
        createdAt: 5,
      }).success,
    ).toBe(false);
  });
});
