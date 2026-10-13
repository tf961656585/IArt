import { request } from './client';
import { isRecord, toStringSafe, type UnknownRecord } from '../utils/typeGuards';

export const CHAT_COMPLETIONS_ENDPOINT = '/v1/chat/completions' as const;

/**
 * Chat Completions 内容分段（兼容 OpenAI Vision / 多模态）
 * - 纯文本：content 为 string
 * - 多段内容：content 为数组（如 { type:"text", text:"..." } / { type:"image_url", image_url:{ url:"..." } }）
 */
export type ChatCompletionContentPart =
  | string
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | UnknownRecord;

export type ChatCompletionMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string | ChatCompletionContentPart[];
};

type ChatCompletionsRequestBodyDefaults = {
  model: string;
  messages: ChatCompletionMessage[];
  stream: false;
  temperature: number | undefined;
  top_p: number | undefined;
  frequency_penalty: number | undefined;
  presence_penalty: number | undefined;
};

export type ChatCompletionsRequestBody =
  Pick<ChatCompletionsRequestBodyDefaults, 'model' | 'messages' | 'stream'> &
  Partial<Omit<ChatCompletionsRequestBodyDefaults, 'model' | 'messages' | 'stream'>>;

export type ChatCompletionsResponse = {
  id: string | undefined;
  model: string | undefined;
  object: string | undefined;
  created: number | undefined;
  choices: Array<{
    index: number | undefined;
    message: {
      role: string | undefined;
      content: unknown | undefined;
      reasoning_content: unknown | undefined;
    } | undefined;
    finish_reason: string | undefined;
  }> | undefined;
  error: { message: string | undefined } | null | undefined;
};

export type ChatCompletionResult = {
  model: string;
  content: string;
  raw: ChatCompletionsResponse;
};

const extractTextFromContent = (content: unknown): string => {
  if (typeof content === 'string') return content;

  // 兼容 OpenAI Vision/多段内容格式
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item === 'string') {
        parts.push(item);
        continue;
      }
      if (isRecord(item)) {
        const text = toStringSafe((item as TextContentPart).text);
        if (text) parts.push(text);
      }
    }
    return parts.join('');
  }

  return '';
};

type TextContentPart = UnknownRecord & { text: unknown | undefined };
type RawChatResponse = UnknownRecord & {
  error: unknown | undefined;
  choices: unknown | undefined;
};
type RawChatError = UnknownRecord & {
  message: unknown | undefined;
};
type RawChatChoice = UnknownRecord & {
  message: unknown | undefined;
};
type RawChatMessage = UnknownRecord & {
  content: unknown | undefined;
};

export const extractChatCompletionText = (response: unknown): string => {
  if (!isRecord(response)) return '';
  const rawResponse = response as RawChatResponse;
  const error = rawResponse.error;
  if (isRecord(error)) {
    const rawError = error as RawChatError;
    const message = toStringSafe(rawError.message);
    if (message) {
      throw new Error(message);
    }
  }

  const rawChoices = rawResponse.choices;
  const choices: unknown[] = Array.isArray(rawChoices) ? rawChoices : [];
  const first = choices[0];
  if (!isRecord(first)) return '';
  const rawChoice = first as RawChatChoice;
  const message = rawChoice.message;
  if (!isRecord(message)) return '';
  const rawMessage = message as RawChatMessage;
  return extractTextFromContent(rawMessage.content);
};

export const createChatCompletion = async (body: ChatCompletionsRequestBody): Promise<ChatCompletionsResponse> => {
  return request<ChatCompletionsResponse>({
    method: 'POST',
    endpoint: CHAT_COMPLETIONS_ENDPOINT,
    body,
    taskMeta: {
      modelId: body.model,
    },
    includeAuth: true,
    responseType: 'json',
  });
};

type ChatCompletionWithModelParamsDefaults = {
  model: string;
  messages: ChatCompletionMessage[];
  temperature: number | undefined;
  top_p: number | undefined;
  frequency_penalty: number | undefined;
  presence_penalty: number | undefined;
};

export type ChatCompletionWithModelParams =
  Pick<ChatCompletionWithModelParamsDefaults, 'model' | 'messages'> &
  Partial<Omit<ChatCompletionWithModelParamsDefaults, 'model' | 'messages'>>;

export async function createChatCompletionWithModel(params: ChatCompletionWithModelParams): Promise<ChatCompletionResult> {
  const model = params.model.trim();
  if (!model) {
    throw new Error('还没有可用的模型，请到设置里检查可用模型。');
  }

  const raw = await createChatCompletion({
    model,
    messages: params.messages,
    stream: false,
    temperature: params.temperature,
    top_p: params.top_p,
    frequency_penalty: params.frequency_penalty,
    presence_penalty: params.presence_penalty,
  });
  const content = extractChatCompletionText(raw).trim();
  if (!content) {
    throw new Error('模型没有返回内容，请重试。');
  }
  return { model, content, raw };
}
