/* @vitest-environment node */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatStreamParams, InternalMessage } from '../src/types';
import { anthropicMessagesAdapter } from '../src/anthropic-messages';
import { geminiAdapter } from '../src/gemini';
import { openaiChatAdapter } from '../src/openai-chat';
import { openaiResponsesAdapter } from '../src/openai-responses';

/**
 * 工具调用（function calling）在适配器层的三个契约面：
 *
 * 1. openai_chat 请求体携带 OpenAI 形状的 tools，流式 delta.tool_calls 按 index 聚合
 *    后经 onToolCall 逐条交付（spec 04「工具调用循环语义」的协议底座）；
 * 2. assistant toolCalls 与 tool 角色消息按协议形状序列化（tool_call_id 关联不丢）；
 * 3. 其余适配器显式拒绝（UNSUPPORTED_TOOL_CALLING），不静默降级——
 *    静默丢弃 tools 会让模型「以为能调用」而实际无人执行。
 */

const mocks = vi.hoisted(() => ({
  openaiChatCreate: vi.fn(),
  openaiResponsesCreate: vi.fn(),
  anthropicMessagesStream: vi.fn(),
  geminiChatsCreate: vi.fn(),
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
  messages: [{ messageId: 'message-1', role: 'user', content: '画一只猫', createdAt: 1 }],
  modelId: 'upstream-model',
  userParams: {},
  contextWindowTokens: 128000,
  apiConfig: { apiKey: 'test-key', baseUrl: 'https://byok.example.com/v1' },
  requestTrace: undefined,
  onToken: () => undefined,
  ...overrides,
});

const tools = [
  {
    name: 'generate_image',
    description: '生成一张图片',
    parameters: { type: 'object', properties: { prompt: { type: 'string' } } },
  },
];

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
  mocks.geminiChatsCreate.mockReturnValue({
    sendMessageStream: async function* () {
      yield { text: 'hello' };
    },
  });
});

describe('openai_chat tool calling', () => {
  it('请求体携带 OpenAI 形状的 tools，未声明时不发该字段', async () => {
    await openaiChatAdapter.executeStream(baseParams({ tools }));

    expect(firstRequest(mocks.openaiChatCreate)['tools']).toEqual([
      {
        type: 'function',
        function: {
          name: 'generate_image',
          description: '生成一张图片',
          parameters: { type: 'object', properties: { prompt: { type: 'string' } } },
        },
      },
    ]);

    await openaiChatAdapter.executeStream(baseParams());
    const secondRequest = mocks.openaiChatCreate.mock.calls[1]?.[0] as Record<string, unknown>;
    expect(secondRequest).not.toHaveProperty('tools');
  });

  it('流式 delta.tool_calls 跨分片按 index 聚合，流结束后逐条交付', async () => {
    const collected: Array<{ id: string; name: string; argsJson: string }> = [];
    mocks.openaiChatCreate.mockImplementation(async function* () {
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call-1', function: { name: 'generate_image', arguments: '' } },
                { index: 1, id: 'call-2', function: { name: 'crop_image', arguments: '' } },
              ],
            },
          },
        ],
      };
      yield {
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"prompt"' } }] } }],
      };
      yield {
        choices: [
          { delta: { content: '正在生成', tool_calls: [{ index: 0, function: { arguments: ':"一只猫"}' } }] } },
        ],
      };
      yield {
        choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '{"asset_id":"a1"}' } }] } }],
      };
    });

    const tokens: string[] = [];
    await openaiChatAdapter.executeStream(
      baseParams({
        tools,
        onToken: (text) => tokens.push(text),
        onToolCall: (toolCall) => collected.push(toolCall),
      }),
    );

    // 文本与 tool_calls 共存：token 正常交付，聚合结果按 index 序且 arguments 跨片拼接完整。
    expect(tokens).toEqual(['正在生成']);
    expect(collected).toEqual([
      { id: 'call-1', name: 'generate_image', argsJson: '{"prompt":"一只猫"}' },
      { id: 'call-2', name: 'crop_image', argsJson: '{"asset_id":"a1"}' },
    ]);
  });

  it('assistant toolCalls 与 tool 角色消息按协议形状序列化', async () => {
    const messages: InternalMessage[] = [
      { messageId: 'm1', role: 'user', content: '画一只猫', createdAt: 1 },
      {
        messageId: 'm2',
        role: 'assistant',
        content: '',
        createdAt: 2,
        toolCalls: [{ id: 'call-1', name: 'generate_image', argsJson: '{"prompt":"一只猫"}' }],
      },
      {
        messageId: 'm3',
        role: 'tool',
        content: '已生成 1 张图片 asset-2',
        createdAt: 3,
        toolCallId: 'call-1',
        toolName: 'generate_image',
      },
    ];
    await openaiChatAdapter.executeStream(baseParams({ messages, tools }));

    const serialized = firstRequest(mocks.openaiChatCreate)['messages'] as Array<
      Record<string, unknown>
    >;
    expect(serialized[1]).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: { name: 'generate_image', arguments: '{"prompt":"一只猫"}' },
        },
      ],
    });
    expect(serialized[2]).toEqual({
      role: 'tool',
      tool_call_id: 'call-1',
      content: '已生成 1 张图片 asset-2',
    });
  });
});

describe('tool calling is rejected on other adapters', () => {
  it.each([
    ['openai_responses', openaiResponsesAdapter],
    ['anthropic_messages', anthropicMessagesAdapter],
    ['gemini', geminiAdapter],
  ])('%s 携带 tools 时显式拒绝', async (_name, adapter) => {
    await expect(adapter.executeStream(baseParams({ tools }))).rejects.toThrow(
      'UNSUPPORTED_TOOL_CALLING',
    );
  });

  it.each([
    ['openai_responses', openaiResponsesAdapter],
    ['anthropic_messages', anthropicMessagesAdapter],
    ['gemini', geminiAdapter],
  ])('%s 未声明工具时不受影响', async (_name, adapter) => {
    await expect(adapter.executeStream(baseParams())).resolves.toBeUndefined();
  });
});
