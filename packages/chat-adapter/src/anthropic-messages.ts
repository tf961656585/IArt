import type Anthropic from '@anthropic-ai/sdk';
import type { ChatAdapter, ChatStreamParams, InternalMessage, ChatMessageContent } from './types.js';
import { assertNoToolsOrThrow } from './types.js';
import { createAnthropicClient, createChatHttpTraceFetch } from './sdk-clients.js';
import { ANTHROPIC_THINKING_REPLY_HEADROOM, resolveAnthropicThinking } from './thinking-tiers.js';

/**
 * Anthropic Messages 协议下没声明输出上限时使用的回复上限。
 *
 * `max_tokens` 在本协议里是**必填**字段（不是可省略的可选参数），因此这里必须有一个数：
 * 保持本适配器一直以来的取值，不因为新增「最大输出 token」声明而改变未声明模型的行为。
 */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 16384;

function toAnthropicContent(
  content: ChatMessageContent,
): Anthropic.ContentBlockParam[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  return content.map((part) => {
    if (part.type === 'text') return { type: 'text' as const, text: part.text };
    if (part.type === 'image') {
      return {
        type: 'image' as const,
        source: { type: 'url' as const, url: part.url },
      };
    }
    return { type: 'text' as const, text: `[${part.type} content]` };
  });
}

function toAnthropicMessages(
  messages: InternalMessage[],
  systemPrompt?: string,
): { system?: string; messages: Anthropic.MessageParam[] } {
  const filtered = messages.filter((m) => m.role !== 'system');
  const anthropicMessages: Anthropic.MessageParam[] = filtered.map((msg) => ({
    role: msg.role === 'assistant' ? 'assistant' : 'user',
    content: toAnthropicContent(msg.content),
  }));

  const result: { system?: string; messages: Anthropic.MessageParam[] } = {
    messages: anthropicMessages,
  };
  if (systemPrompt != undefined) {
    result.system = systemPrompt;
  }
  return result;
}

export const anthropicMessagesAdapter: ChatAdapter = {
  async executeStream(params: ChatStreamParams): Promise<void> {
    assertNoToolsOrThrow('anthropic_messages', params.tools);
    const client =
      params.requestTrace === undefined
        ? createAnthropicClient(params.apiConfig)
        : createAnthropicClient(params.apiConfig, {
            fetch: createChatHttpTraceFetch(params.requestTrace),
          });

    const { system, messages } = toAnthropicMessages(
      params.messages,
      params.systemPrompt,
    );

    const userParams = (params.userParams ?? {}) as Record<string, unknown>;
    /* 回复上界的优先级：本次请求的直接指定（userParams，MCP/WS 调用方可传）→ 用户为该模型
       声明的「最大输出 token」→ 本协议默认值。请求级指定压过模型级声明，与 userParams 末尾
       展开的既有口径一致。 */
    const requestedMaxTokens = typeof userParams['max_tokens'] === 'number'
      ? userParams['max_tokens']
      : typeof userParams['maxTokens'] === 'number'
        ? userParams['maxTokens']
        : params.maxOutputTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS;

    /* 思考档位 → thinking.budget_tokens（spec 37）；不思考时不发该字段。
       Anthropic 要求 max_tokens 严格大于思考预算，否则整个请求被拒——预算高于用户声明的上界时
       按预算抬高，否则该档位根本发不出去。这是协议约束压过声明值的一处，且**会超过用户声明的
       上界**；抬高仅发生在「声明值 < 预算 + 预留」时（spec 37「最大输出 token」节已载明）。 */
    const thinking = resolveAnthropicThinking(params.thinkingTier);
    const maxTokens = thinking === null
      ? requestedMaxTokens
      : Math.max(requestedMaxTokens, thinking.budget_tokens + ANTHROPIC_THINKING_REPLY_HEADROOM);

    const { max_tokens: _, maxTokens: __, ...restParams } = userParams;

    const stream = client.messages.stream(
      {
        model: params.modelId,
        max_tokens: maxTokens,
        ...(system != undefined ? { system } : {}),
        messages,
        ...(thinking === null ? {} : { thinking }),
        ...restParams,
      },
      { signal: params.abortSignal },
    );

    stream.on('text', (text) => {
      params.onToken(text);
    });

    const finalMessage = await stream.finalMessage();

    if (finalMessage.usage && params.onUsage) {
      params.onUsage({
        inputTokens: finalMessage.usage.input_tokens,
        outputTokens: finalMessage.usage.output_tokens,
      });
    }
  },
};
