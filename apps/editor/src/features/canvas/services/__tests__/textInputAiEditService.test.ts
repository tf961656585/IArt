import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CHAT_WS_MESSAGE_TYPE, type ChatTemporaryCompletion } from '@iart/contracts';
import { runTextInputAiEdit } from '../textInputAiEditService';

const {
  requestTemporaryCompletionMock,
  resolveSystemPromptTextMock,
  submitBusinessSyncActionMock,
} = vi.hoisted(() => ({
  requestTemporaryCompletionMock: vi.fn(),
  resolveSystemPromptTextMock: vi.fn(),
  submitBusinessSyncActionMock: vi.fn(() => {
    throw new Error('text input ai edit must not use business sync action');
  }),
}));

vi.mock('@/client/utils/chatActionSocket', () => ({
  chatActionSocket: {
    requestTemporaryCompletion: requestTemporaryCompletionMock,
  },
}));

vi.mock('../systemPromptStore', () => ({
  SystemPromptStore: {
    resolveSystemPromptText: resolveSystemPromptTextMock,
  },
}));

vi.mock('@/client/utils/businessActionSocket', () => ({
  submitBusinessSyncAction: submitBusinessSyncActionMock,
}));

describe('runTextInputAiEdit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveSystemPromptTextMock.mockResolvedValue('会话系统提示词');
    requestTemporaryCompletionMock.mockResolvedValue({
      message: {
        messageId: 'assistant-1',
        role: 'assistant',
        content: ' 改写后的文本 ',
        createdAt: 2,
        tokenCount: 4,
      },
      usage: { inputTokens: 12, outputTokens: 4 },
    });
  });

  it('uses the selected model config through temporary chat completion', async () => {
    const onToken = vi.fn();

    const result = await runTextInputAiEdit({
      modelId: 'chat-model-1',
      systemPromptId: 'system-prompt-1',
      sourceText: '原始文本',
      userInstruction: '更具体',
      templateId: 'json',
      onToken,
    });

    expect(result).toEqual({ modelId: 'chat-model-1', content: '改写后的文本' });
    expect(submitBusinessSyncActionMock).not.toHaveBeenCalled();
    expect(resolveSystemPromptTextMock).toHaveBeenCalledWith('system-prompt-1');
    expect(requestTemporaryCompletionMock).toHaveBeenCalledOnce();

    const [payload, handlers] = requestTemporaryCompletionMock.mock.calls[0] as [
      ChatTemporaryCompletion,
      { onToken: (text: string) => void },
    ];
    expect(payload.type).toBe(CHAT_WS_MESSAGE_TYPE.TEMPORARY_COMPLETION);
    expect(payload.modelId).toBe('chat-model-1');
    expect(payload.systemPrompt).toContain('会话系统提示词');
    expect(payload.systemPrompt).toContain('"task": "generate_image"');
    expect(payload.messages).toHaveLength(1);
    expect(payload.messages[0]?.content).toContain('原始文本');
    expect(payload.messages[0]?.content).toContain('更具体');
    expect(payload.userParams).toEqual({});

    handlers.onToken('片段');
    expect(onToken).toHaveBeenCalledWith('片段');
  });

  it('throws when the temporary completion returns empty assistant content', async () => {
    requestTemporaryCompletionMock.mockResolvedValueOnce({
      message: {
        messageId: 'assistant-empty',
        role: 'assistant',
        content: '   ',
        createdAt: 2,
      },
      usage: { inputTokens: 1, outputTokens: 0 },
    });

    await expect(
      runTextInputAiEdit({
        modelId: 'chat-model-1',
        systemPromptId: undefined,
        sourceText: '原始文本',
        userInstruction: '',
        templateId: undefined,
        onToken: vi.fn(),
      }),
    ).rejects.toThrow('模型这次没有返回内容，请重试');
  });
});
