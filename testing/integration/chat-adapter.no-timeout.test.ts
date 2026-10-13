// @vitest-environment node

import type OpenAI from 'openai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAnthropicClient, createOpenAIClient } from '../../packages/chat-adapter/src/sdk-clients';
import { geminiAdapter } from '../../packages/chat-adapter/src/gemini';
import { consumeOpenAIResponsesStream } from '../../packages/chat-adapter/src/openai-responses';

const geminiMocks = vi.hoisted(() => {
  const sendMessageStream = vi.fn();
  const create = vi.fn();
  const GoogleGenAI = vi.fn();
  return { GoogleGenAI, create, sendMessageStream };
});

vi.mock('@google/genai', () => ({
  GoogleGenAI: geminiMocks.GoogleGenAI,
}));

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function headersFromInit(init: RequestInit | undefined): Headers {
  if (init === undefined || init.headers === undefined) {
    return new Headers();
  }
  return new Headers(init.headers);
}

async function* responseStreamEvents(
  events: OpenAI.Responses.ResponseStreamEvent[],
): AsyncIterable<OpenAI.Responses.ResponseStreamEvent> {
  for (const event of events) {
    yield event;
  }
}

function buildResponseCompletedEvent(
  outputText: string,
  inputTokens: number,
  outputTokens: number,
): OpenAI.Responses.ResponseCompletedEvent {
  const response: OpenAI.Responses.Response = {
    id: 'resp_test',
    created_at: 1,
    output_text: outputText,
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    model: 'test-model',
    object: 'response',
    output: [],
    parallel_tool_calls: false,
    temperature: null,
    tool_choice: 'auto',
    tools: [],
    top_p: null,
    status: 'completed',
    usage: {
      input_tokens: inputTokens,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: outputTokens,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: inputTokens + outputTokens,
    },
  };

  return {
    type: 'response.completed',
    sequence_number: 1,
    response,
  };
}

describe('chat adapter SDK clients', () => {
  it('disables OpenAI local request timers', async () => {
    const client = createOpenAIClient(
      { apiKey: 'test-key', baseUrl: 'https://example.test/v1' },
      {
        fetch: async () => jsonResponse({ ok: true }, 200),
      },
    );
    const timerSpy = vi.spyOn(globalThis, 'setTimeout');

    try {
      await client.fetchWithTimeout(
        'https://example.test/v1/models',
        { method: 'get' },
        Number.POSITIVE_INFINITY,
        new AbortController(),
      );
      expect(timerSpy).not.toHaveBeenCalled();
    } finally {
      timerSpy.mockRestore();
    }
  });

  it('disables OpenAI automatic retries and timeout headers', async () => {
    let calls = 0;
    const client = createOpenAIClient(
      { apiKey: 'test-key', baseUrl: 'https://example.test/v1' },
      {
        fetch: async (_url, init) => {
          calls += 1;
          const headers = headersFromInit(init);
          expect(headers.has('x-stainless-timeout')).toBe(false);
          return jsonResponse({ error: { message: 'boom', type: 'server_error' } }, 500);
        },
      },
    );

    await expect(client.get('/models')).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it('propagates OpenAI explicit abort signals without local timer aborts', async () => {
    const sourceController = new AbortController();
    let capturedSignal: AbortSignal | null | undefined;
    const client = createOpenAIClient(
      { apiKey: 'test-key', baseUrl: 'https://example.test/v1' },
      {
        fetch: async (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            capturedSignal = init === undefined ? undefined : init.signal;
            if (capturedSignal === undefined || capturedSignal === null) {
              reject(new Error('fetch signal missing'));
              return;
            }
            capturedSignal.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
              { once: true },
            );
          }),
      },
    );

    const request = client.fetchWithTimeout(
      'https://example.test/v1/models',
      { signal: sourceController.signal },
      Number.POSITIVE_INFINITY,
      new AbortController(),
    );
    sourceController.abort();

    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    if (capturedSignal === undefined || capturedSignal === null) {
      throw new Error('fetch signal missing after abort');
    }
    expect(capturedSignal.aborted).toBe(true);
  });

  it('disables Anthropic local request timers', async () => {
    const client = createAnthropicClient(
      { apiKey: 'test-key', baseUrl: 'https://example.test' },
      {
        fetch: async () => jsonResponse({ ok: true }, 200),
      },
    );
    const timerSpy = vi.spyOn(globalThis, 'setTimeout');

    try {
      await client.fetchWithTimeout(
        'https://example.test/v1/models',
        { method: 'get' },
        Number.POSITIVE_INFINITY,
        new AbortController(),
      );
      expect(timerSpy).not.toHaveBeenCalled();
    } finally {
      timerSpy.mockRestore();
    }
  });

  it('disables Anthropic automatic retries and timeout headers', async () => {
    let calls = 0;
    const client = createAnthropicClient(
      { apiKey: 'test-key', baseUrl: 'https://example.test' },
      {
        fetch: async (_url, init) => {
          calls += 1;
          const headers = headersFromInit(init);
          expect(headers.has('x-stainless-timeout')).toBe(false);
          return jsonResponse({ error: { type: 'api_error', message: 'boom' } }, 500);
        },
      },
    );

    await expect(client.get('/v1/models')).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

describe('openai responses stream consumption', () => {
  it('emits text from output_text.done when no delta events were streamed', async () => {
    const tokens: string[] = [];
    const doneEvent: OpenAI.Responses.ResponseTextDoneEvent = {
      type: 'response.output_text.done',
      content_index: 0,
      item_id: 'msg_test',
      logprobs: [],
      output_index: 0,
      sequence_number: 1,
      text: '你好，我在。',
    };

    await consumeOpenAIResponsesStream(responseStreamEvents([doneEvent]), {
      onToken: (text) => {
        tokens.push(text);
      },
      onUsage: undefined,
    });

    expect(tokens).toEqual(['你好，我在。']);
  });

  it('emits completed output_text and usage when provider omits deltas', async () => {
    const tokens: string[] = [];
    const usage: Array<{ inputTokens: number; outputTokens: number }> = [];

    await consumeOpenAIResponsesStream(
      responseStreamEvents([buildResponseCompletedEvent('完整回复', 11, 7)]),
      {
        onToken: (text) => {
          tokens.push(text);
        },
        onUsage: (nextUsage) => {
          usage.push(nextUsage);
        },
      },
    );

    expect(tokens).toEqual(['完整回复']);
    expect(usage).toEqual([{ inputTokens: 11, outputTokens: 7 }]);
  });

  it('does not duplicate final text when delta events already streamed', async () => {
    const tokens: string[] = [];
    const deltaEvent: OpenAI.Responses.ResponseTextDeltaEvent = {
      type: 'response.output_text.delta',
      content_index: 0,
      delta: '已',
      item_id: 'msg_test',
      logprobs: [],
      output_index: 0,
      sequence_number: 1,
    };
    const doneEvent: OpenAI.Responses.ResponseTextDoneEvent = {
      type: 'response.output_text.done',
      content_index: 0,
      item_id: 'msg_test',
      logprobs: [],
      output_index: 0,
      sequence_number: 2,
      text: '已完成',
    };

    await consumeOpenAIResponsesStream(
      responseStreamEvents([deltaEvent, doneEvent, buildResponseCompletedEvent('已完成', 3, 4)]),
      {
        onToken: (text) => {
          tokens.push(text);
        },
        onUsage: undefined,
      },
    );

    expect(tokens).toEqual(['已', '完成']);
  });
});

describe('gemini chat adapter remote request governance', () => {
  beforeEach(() => {
    geminiMocks.GoogleGenAI.mockReset();
    geminiMocks.create.mockReset();
    geminiMocks.sendMessageStream.mockReset();
    geminiMocks.sendMessageStream.mockImplementation(async function* () {
      yield { text: 'hello' };
    });
    geminiMocks.create.mockReturnValue({
      sendMessageStream: geminiMocks.sendMessageStream,
    });
    geminiMocks.GoogleGenAI.mockImplementation(() => ({
      chats: { create: geminiMocks.create },
    }));
  });

  it('does not pass userParams httpOptions or retryOptions into Gemini config', async () => {
    const abortController = new AbortController();
    const tokens: string[] = [];

    await geminiAdapter.executeStream({
      messages: [
        {
          messageId: 'message-1',
          role: 'user',
          content: 'hello',
          createdAt: 1,
        },
      ],
      systemPrompt: 'system prompt',
      modelId: 'gemini-test',
      userParams: {
        httpOptions: { timeout: 1 },
        retryOptions: { retries: 2 },
      },
      contextWindowTokens: 4096,
      apiConfig: { apiKey: 'test-key' },
      requestTrace: undefined,
      onToken: (text) => {
        tokens.push(text);
      },
      abortSignal: abortController.signal,
    });

    expect(tokens).toEqual(['hello']);
    const createCall = geminiMocks.create.mock.calls[0];
    if (createCall === undefined) {
      throw new Error('Gemini chat create was not called.');
    }
    const createArg = createCall[0] as { config: Record<string, unknown> };
    expect(createArg.config['abortSignal']).toBe(abortController.signal);
    expect(Object.prototype.hasOwnProperty.call(createArg.config, 'httpOptions')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(createArg.config, 'retryOptions')).toBe(false);
  });
});
