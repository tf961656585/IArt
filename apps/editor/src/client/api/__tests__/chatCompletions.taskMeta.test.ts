import { beforeEach, describe, expect, it, vi } from 'vitest';

const requestMock = vi.fn();

vi.mock('../client', () => ({
  request: requestMock,
}));

describe('chatCompletions taskMeta bridge', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('createChatCompletion 会把 body.model 桥接到 taskMeta.modelId', async () => {
    const { CHAT_COMPLETIONS_ENDPOINT, createChatCompletion } = await import('../chatCompletions');
    const response = { id: 'chatcmpl-demo' };
    requestMock.mockResolvedValueOnce(response);
    const body = {
      model: 'demo-model',
      messages: [{ role: 'user' as const, content: 'hello' }],
      stream: false as const,
    };

    const result = await createChatCompletion(body);

    expect(result).toBe(response);
    expect(requestMock).toHaveBeenCalledWith({
      method: 'POST',
      endpoint: CHAT_COMPLETIONS_ENDPOINT,
      body,
      taskMeta: {
        modelId: 'demo-model',
      },
      includeAuth: true,
      responseType: 'json',
    });
  });

  it('createChatCompletionWithModel 会沿用 trim 后模型到 taskMeta.modelId', async () => {
    const { createChatCompletionWithModel } = await import('../chatCompletions');
    const messages = [{ role: 'user' as const, content: 'prompt' }];
    requestMock.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: 'ok',
          },
        },
      ],
    });

    await createChatCompletionWithModel({
      model: '  demo-model-trimmed  ',
      messages,
    });

    expect(requestMock).toHaveBeenCalledWith({
      method: 'POST',
      endpoint: '/v1/chat/completions',
      body: {
        model: 'demo-model-trimmed',
        messages,
        stream: false,
      },
      taskMeta: {
        modelId: 'demo-model-trimmed',
      },
      includeAuth: true,
      responseType: 'json',
    });
  });
});
