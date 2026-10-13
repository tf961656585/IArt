/* @vitest-environment node */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatStreamParams } from '../src/types';
import { anthropicMessagesAdapter } from '../src/anthropic-messages';
import { geminiAdapter } from '../src/gemini';
import { openaiChatAdapter } from '../src/openai-chat';
import { openaiResponsesAdapter } from '../src/openai-responses';

/**
 * 「最大输出 token」落到各协议字段的映射（spec 37「对话模型的唯一来源」）。
 *
 * 统一语义 → 各家字段的翻译是各适配器的责任，本文件按协议逐个钉住**发出去的字段名**：
 * 这条链路出问题的形态是「配置存下了、界面也显示了，但请求里根本没带」——
 * 类型门禁与上层测试都看不见，只有核对请求体才能暴露。
 *
 * 同时钉住「未声明 = 不发该字段」：给未声明的模型补一个我们挑的默认数字，等于强加一道
 * 无人声明的上限（Anthropic 例外：该协议的 `max_tokens` 是必填字段，另有默认值）。
 */

const mocks = vi.hoisted(() => ({
  openaiChatCreate: vi.fn(),
  openaiResponsesCreate: vi.fn(),
  anthropicMessagesStream: vi.fn(),
  geminiChatsCreate: vi.fn(),
  geminiSendMessageStream: vi.fn(),
}));

vi.mock('../src/sdk-clients', () => ({
  createOpenAIClient: () => ({
    chat: { completions: { create: mocks.openaiChatCreate } },
    responses: { create: mocks.openaiResponsesCreate },
  }),
  createAnthropicClient: () => ({ messages: { stream: mocks.anthropicMessagesStream } }),
  createChatHttpTraceFetch: () => (): Promise<Response> => Promise.resolve(new Response('')),
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    readonly chats = { create: mocks.geminiChatsCreate };
  },
}));

const baseParams = (overrides: Partial<ChatStreamParams> = {}): ChatStreamParams => ({
  messages: [{ messageId: 'message-1', role: 'user', content: 'hello', createdAt: 1 }],
  modelId: 'upstream-model',
  userParams: {},
  contextWindowTokens: 128000,
  apiConfig: { apiKey: 'test-key', baseUrl: 'https://byok.example.com/v1' },
  requestTrace: undefined,
  onToken: () => undefined,
  ...overrides,
});

/** 取某个 mock 第一次调用时传入的请求体。 */
const firstRequest = (mock: ReturnType<typeof vi.fn>): Record<string, unknown> => {
  const call = mock.mock.calls[0];
  if (call === undefined) throw new Error('adapter did not call the SDK');
  return call[0] as Record<string, unknown>;
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.openaiChatCreate.mockImplementation(async function* () {
    yield { choices: [] };
  });
  mocks.openaiResponsesCreate.mockImplementation(async function* () {
    yield { type: 'response.completed', response: {} };
  });
  mocks.anthropicMessagesStream.mockImplementation(() => ({
    on: () => undefined,
    finalMessage: async () => ({ usage: { input_tokens: 1, output_tokens: 1 } }),
  }));
  mocks.geminiChatsCreate.mockReturnValue({ sendMessageStream: mocks.geminiSendMessageStream });
  mocks.geminiSendMessageStream.mockImplementation(async function* () {
    yield { text: 'hello' };
  });
});

describe('OpenAI Chat Completions', () => {
  it('声明的输出上限发成 max_completion_tokens（不是已废弃的 max_tokens）', async () => {
    await openaiChatAdapter.executeStream(baseParams({ maxOutputTokens: 8192 }));

    const request = firstRequest(mocks.openaiChatCreate);
    expect(request['max_completion_tokens']).toBe(8192);
    expect(request).not.toHaveProperty('max_tokens');
  });

  it('未声明时不发该字段（由服务商决定，不补默认值）', async () => {
    await openaiChatAdapter.executeStream(baseParams());

    expect(firstRequest(mocks.openaiChatCreate)).not.toHaveProperty('max_completion_tokens');
  });
});

describe('OpenAI Responses', () => {
  it('声明的输出上限发成 max_output_tokens', async () => {
    await openaiResponsesAdapter.executeStream(baseParams({ maxOutputTokens: 8192 }));

    expect(firstRequest(mocks.openaiResponsesCreate)['max_output_tokens']).toBe(8192);
  });

  it('未声明时不发该字段', async () => {
    await openaiResponsesAdapter.executeStream(baseParams());

    expect(firstRequest(mocks.openaiResponsesCreate)).not.toHaveProperty('max_output_tokens');
  });
});

describe('Anthropic Messages', () => {
  it('声明的输出上限发成 max_tokens', async () => {
    await anthropicMessagesAdapter.executeStream(baseParams({ maxOutputTokens: 8192 }));

    expect(firstRequest(mocks.anthropicMessagesStream)['max_tokens']).toBe(8192);
  });

  it('未声明时落到本协议默认值（max_tokens 是必填字段，不能省略）', async () => {
    await anthropicMessagesAdapter.executeStream(baseParams());

    expect(firstRequest(mocks.anthropicMessagesStream)['max_tokens']).toBe(16384);
  });

  /* 协议约束压过声明值的一处：Anthropic 要求 max_tokens 严格大于思考预算，否则整个请求被拒。
     声明值小于「预算 + 预留」时按预算抬高——抬高是唯一能让该档位发出去的做法。 */
  it('思考预算高于声明的上限时按预算抬高（否则请求被协议拒绝）', async () => {
    await anthropicMessagesAdapter.executeStream(baseParams({ maxOutputTokens: 2048, thinkingTier: 'high' }));

    const request = firstRequest(mocks.anthropicMessagesStream);
    expect(request['thinking']).toEqual({ type: 'enabled', budget_tokens: 16384 });
    expect(request['max_tokens']).toBe(16384 + 1024);
  });

  it('声明的上限高于思考预算时原样发送，不压低也不抬高', async () => {
    await anthropicMessagesAdapter.executeStream(baseParams({ maxOutputTokens: 40000, thinkingTier: 'minimal' }));

    const request = firstRequest(mocks.anthropicMessagesStream);
    expect(request['thinking']).toEqual({ type: 'enabled', budget_tokens: 1024 });
    expect(request['max_tokens']).toBe(40000);
  });
});

describe('Gemini', () => {
  it('声明的输出上限发成 config.maxOutputTokens', async () => {
    await geminiAdapter.executeStream(baseParams({ maxOutputTokens: 8192 }));

    const config = firstRequest(mocks.geminiChatsCreate)['config'] as Record<string, unknown>;
    expect(config['maxOutputTokens']).toBe(8192);
  });

  it('未声明时不发该字段', async () => {
    await geminiAdapter.executeStream(baseParams());

    const config = firstRequest(mocks.geminiChatsCreate)['config'] as Record<string, unknown>;
    expect(config).not.toHaveProperty('maxOutputTokens');
  });
});
