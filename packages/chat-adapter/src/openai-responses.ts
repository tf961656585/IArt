import type OpenAI from 'openai';
import type { ChatAdapter, ChatMessageContent, ChatStreamParams, InternalMessage } from './types.js';
import { assertNoToolsOrThrow } from './types.js';
import { createChatHttpTraceFetch, createOpenAIClient } from './sdk-clients.js';
import { resolveOpenAIReasoningEffort } from './thinking-tiers.js';

type ResponseInputItem = OpenAI.Responses.ResponseInputItem;
type ResponseInputText = OpenAI.Responses.ResponseInputText;
type ResponseInputImage = OpenAI.Responses.ResponseInputImage;

function toResponsesContent(content: ChatMessageContent): string | Array<ResponseInputText | ResponseInputImage> {
  if (typeof content === 'string') return content;
  return content.map((part): ResponseInputText | ResponseInputImage => {
    if (part.type === 'text') {
      return { type: 'input_text', text: part.text };
    }
    if (part.type === 'image') {
      return { type: 'input_image', image_url: part.url, detail: 'auto' };
    }
    return { type: 'input_text', text: `[${part.type} content]` };
  });
}

function toResponsesInput(
  messages: InternalMessage[],
  systemPrompt?: string,
): Array<ResponseInputItem> {
  const items: Array<ResponseInputItem> = [];

  if (systemPrompt) {
    items.push({ role: 'system', content: systemPrompt });
  }

  for (const msg of messages) {
    items.push({ role: msg.role as 'user' | 'assistant' | 'system', content: toResponsesContent(msg.content) });
  }

  return items;
}

type ResponsesStreamCallbacks = {
  onToken: (text: string) => void;
  onUsage: ((usage: { inputTokens: number; outputTokens: number }) => void) | undefined;
};

function readField(value: unknown, fieldName: string): unknown {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  return Reflect.get(value, fieldName);
}

function readStringField(value: unknown, fieldName: string): string | undefined {
  const fieldValue = readField(value, fieldName);
  return typeof fieldValue === 'string' ? fieldValue : undefined;
}

function extractContentText(content: unknown): string {
  if (!Array.isArray(content)) {
    return '';
  }

  let text = '';
  for (const part of content) {
    if (readStringField(part, 'type') !== 'output_text') {
      continue;
    }
    const partText = readStringField(part, 'text');
    if (partText !== undefined) {
      text += partText;
    }
  }
  return text;
}

function extractResponseOutputText(response: unknown): string | undefined {
  const directText = readStringField(response, 'output_text');
  if (directText !== undefined) {
    return directText;
  }

  const output = readField(response, 'output');
  if (!Array.isArray(output)) {
    return undefined;
  }

  let text = '';
  for (const item of output) {
    text += extractContentText(readField(item, 'content'));
  }
  return text.length === 0 ? undefined : text;
}

function emitUsage(response: unknown, callbacks: ResponsesStreamCallbacks): void {
  if (callbacks.onUsage === undefined) {
    return;
  }

  const usage = readField(response, 'usage');
  const inputTokens = readField(usage, 'input_tokens');
  const outputTokens = readField(usage, 'output_tokens');
  if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') {
    return;
  }

  callbacks.onUsage({
    inputTokens,
    outputTokens,
  });
}

export async function consumeOpenAIResponsesStream(
  stream: AsyncIterable<unknown>,
  callbacks: ResponsesStreamCallbacks,
): Promise<void> {
  let emittedText = '';

  const emitText = (text: string | undefined): void => {
    if (text === undefined || text.length === 0) {
      return;
    }
    emittedText += text;
    callbacks.onToken(text);
  };

  const emitTextTail = (text: string | undefined): void => {
    if (text === undefined || text.length === 0) {
      return;
    }
    if (emittedText.length === 0) {
      emitText(text);
      return;
    }
    if (text === emittedText) {
      return;
    }
    if (!text.startsWith(emittedText)) {
      return;
    }
    emitText(text.slice(emittedText.length));
  };

  for await (const event of stream) {
    const eventType = readStringField(event, 'type');

    if (eventType === 'response.output_text.delta') {
      emitText(readStringField(event, 'delta'));
      continue;
    }

    if (eventType === 'response.output_text.done') {
      emitTextTail(readStringField(event, 'text'));
      continue;
    }

    if (eventType === 'response.completed') {
      const response = readField(event, 'response');
      emitTextTail(extractResponseOutputText(response));
      emitUsage(response, callbacks);
    }
  }
}

export const openaiResponsesAdapter: ChatAdapter = {
  async executeStream(params: ChatStreamParams): Promise<void> {
    assertNoToolsOrThrow('openai_responses', params.tools);
    const client =
      params.requestTrace === undefined
        ? createOpenAIClient(params.apiConfig)
        : createOpenAIClient(params.apiConfig, {
            fetch: createChatHttpTraceFetch(params.requestTrace),
          });

    // 思考档位 → reasoning.effort（spec 37）；不思考时不发该字段。
    // 自定义档位可能超出 SDK 的枚举字面量，这里按 SDK 参数类型收口（同 openai-chat 的口径）。
    const reasoningEffort = resolveOpenAIReasoningEffort(params.thinkingTier);

    const stream = await client.responses.create(
      {
        model: params.modelId,
        input: toResponsesInput(params.messages, params.systemPrompt),
        stream: true,
        ...(reasoningEffort === null
          ? {}
          : { reasoning: { effort: reasoningEffort as OpenAI.ReasoningEffort } }),
        // 最大输出 token → `max_output_tokens`（spec 37）。Responses 协议里该字段的上界
        // 同样含思考 token，与用户声明的语义一致。
        ...(params.maxOutputTokens === undefined
          ? {}
          : { max_output_tokens: params.maxOutputTokens }),
        ...params.userParams,
      },
      { signal: params.abortSignal },
    );

    await consumeOpenAIResponsesStream(stream, {
      onToken: params.onToken,
      onUsage: params.onUsage,
    });
  },
};
