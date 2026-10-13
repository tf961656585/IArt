export type {
  ChatAdapter,
  ChatAdapterConfig,
  ChatAdapterId,
  ChatMessageContent,
  ChatRequestTrace,
  ChatStreamParams,
  ChatToolCall,
  ChatToolDefinition,
  InternalMessage,
} from './types.js';
export { CHAT_ADAPTER_IDS } from './types.js';
export { openaiChatAdapter } from './openai-chat.js';
export { openaiResponsesAdapter } from './openai-responses.js';
export { anthropicMessagesAdapter } from './anthropic-messages.js';
export { geminiAdapter } from './gemini.js';
export { truncateToContextWindow, estimateTokens } from './context-window.js';
export {
  ANTHROPIC_THINKING_BUDGETS,
  ANTHROPIC_THINKING_REPLY_HEADROOM,
  canChatAdapterExpressThinkingTier,
  resolveAnthropicThinking,
  resolveGeminiThinkingLevel,
  resolveOpenAIReasoningEffort,
} from './thinking-tiers.js';

import type { ChatAdapter, ChatAdapterId } from './types.js';
import { openaiChatAdapter } from './openai-chat.js';
import { openaiResponsesAdapter } from './openai-responses.js';
import { anthropicMessagesAdapter } from './anthropic-messages.js';
import { geminiAdapter } from './gemini.js';

const adapterMap: Record<ChatAdapterId, ChatAdapter> = {
  openai_chat: openaiChatAdapter,
  openai_responses: openaiResponsesAdapter,
  anthropic_messages: anthropicMessagesAdapter,
  gemini: geminiAdapter,
};

export function getChatAdapter(id: ChatAdapterId): ChatAdapter {
  const adapter = adapterMap[id];
  if (!adapter) {
    throw new Error(`Unknown chat adapter: ${id}`);
  }
  return adapter;
}
