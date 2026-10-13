import type OpenAI from 'openai';
import type {
  ChatAdapter,
  ChatMessageContent,
  ChatStreamParams,
  ChatToolCall,
  InternalMessage,
} from './types.js';
import { createChatHttpTraceFetch, createOpenAIClient } from './sdk-clients.js';
import { resolveOpenAIReasoningEffort } from './thinking-tiers.js';

function toOpenAIUserContent(content: ChatMessageContent): OpenAI.ChatCompletionUserMessageParam['content'] {
  if (typeof content === 'string') return content;
  return content.map((part) => {
    if (part.type === 'text') return { type: 'text' as const, text: part.text };
    if (part.type === 'image') {
      return { type: 'image_url' as const, image_url: { url: part.url } };
    }
    return { type: 'text' as const, text: `[${part.type} content]` };
  });
}

/** 工具结果消息内容固定为文本（协议侧 tool 消息只接受字符串）。 */
function contentToText(content: ChatMessageContent): string {
  if (typeof content === 'string') return content;
  return content
    .map((part) => (part.type === 'text' ? part.text : `[${part.type} content]`))
    .join('');
}

function toOpenAIMessages(
  messages: InternalMessage[],
  systemPrompt?: string,
): OpenAI.ChatCompletionMessageParam[] {
  const result: OpenAI.ChatCompletionMessageParam[] = [];

  if (systemPrompt) {
    result.push({ role: 'system', content: systemPrompt });
  }

  for (const msg of messages) {
    if (msg.role === 'system') {
      result.push({ role: 'system', content: typeof msg.content === 'string' ? msg.content : toOpenAIUserContent(msg.content) as string });
    } else if (msg.role === 'assistant') {
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        result.push({
          role: 'assistant',
          content: typeof msg.content === 'string' ? msg.content : toOpenAIUserContent(msg.content) as string,
          tool_calls: msg.toolCalls.map((toolCall) => ({
            id: toolCall.id,
            type: 'function' as const,
            function: { name: toolCall.name, arguments: toolCall.argsJson },
          })),
        });
        continue;
      }
      result.push({ role: 'assistant', content: typeof msg.content === 'string' ? msg.content : toOpenAIUserContent(msg.content) as string });
    } else if (msg.role === 'tool') {
      result.push({
        role: 'tool',
        tool_call_id: msg.toolCallId,
        content: contentToText(msg.content),
      });
    } else {
      result.push({ role: 'user', content: toOpenAIUserContent(msg.content) });
    }
  }

  return result;
}

/**
 * 流式 `delta.tool_calls` 聚合器：同一 tool_call 的增量按 `index` 分片到达
 * （id / name 首片携带，arguments 跨多片拼接），流结束后按 index 序交付。
 */
class StreamingToolCallCollector {
  private readonly partialByIndex = new Map<
    number,
    { id: string; name: string; argsJson: string }
  >();

  absorb(
    chunks: OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta.ToolCall[] | undefined,
  ): void {
    if (!chunks) return;
    for (const chunk of chunks) {
      const existing = this.partialByIndex.get(chunk.index) ?? {
        id: '',
        name: '',
        argsJson: '',
      };
      if (chunk.id) existing.id = chunk.id;
      if (chunk.function?.name) existing.name += chunk.function.name;
      if (chunk.function?.arguments) existing.argsJson += chunk.function.arguments;
      this.partialByIndex.set(chunk.index, existing);
    }
  }

  /** 返回聚合完成的 tool_calls（按 index 升序）；id 缺失的分片视为不完整，不交付。 */
  drain(): ChatToolCall[] {
    return [...this.partialByIndex.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, partial]) => partial)
      .filter((partial) => partial.id && partial.name);
  }
}

export const openaiChatAdapter: ChatAdapter = {
  async executeStream(params: ChatStreamParams): Promise<void> {
    const client =
      params.requestTrace === undefined
        ? createOpenAIClient(params.apiConfig)
        : createOpenAIClient(params.apiConfig, {
            fetch: createChatHttpTraceFetch(params.requestTrace),
          });

    // 思考档位 → reasoning_effort（spec 37）；不思考时不发该字段。
    // 自定义档位是用户与服务商约定的值，可能超出 SDK 的枚举字面量（'minimal' | 'low' | ... ）：
    // 这里按 SDK 参数类型收口，值本身仍是档位标识，不做翻译。
    const reasoningEffort = resolveOpenAIReasoningEffort(params.thinkingTier);

    // 工具清单 → function calling；缺省不发（provider 默认 auto 选择，不额外声明 tool_choice）。
    const tools = params.tools?.length
      ? params.tools.map((tool) => ({
          type: 'function' as const,
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        }))
      : undefined;

    const collector = new StreamingToolCallCollector();

    const stream = await client.chat.completions.create(
      {
        model: params.modelId,
        messages: toOpenAIMessages(params.messages, params.systemPrompt),
        stream: true,
        stream_options: { include_usage: true },
        ...(reasoningEffort === null
          ? {}
          : { reasoning_effort: reasoningEffort as OpenAI.ReasoningEffort }),
        // 最大输出 token → `max_completion_tokens`（spec 37）。不用 `max_tokens`：它已废弃，
        // 且 o 系列与 GPT-5 族会直接拒绝该参数（SDK 类型定义同口径）。semantic 上也更对——
        // `max_completion_tokens` 的上界含思考 token，正是用户要限制的那个总量。
        ...(params.maxOutputTokens === undefined
          ? {}
          : { max_completion_tokens: params.maxOutputTokens }),
        ...(tools === undefined ? {} : { tools }),
        ...params.userParams,
      },
      { signal: params.abortSignal },
    );

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      const delta = choice?.delta;
      if (delta?.content) {
        params.onToken(delta.content);
      }
      if (delta?.tool_calls) {
        collector.absorb(delta.tool_calls);
      }
      if (chunk.usage && params.onUsage) {
        params.onUsage({
          inputTokens: chunk.usage.prompt_tokens,
          outputTokens: chunk.usage.completion_tokens,
        });
      }
    }

    if (params.onToolCall) {
      for (const toolCall of collector.drain()) {
        params.onToolCall(toolCall);
      }
    }
  },
};
