import type { InternalMessage } from '@iart/contracts';
import { CHAT_WS_MESSAGE_TYPE } from '@iart/contracts';
import type { BusinessClient } from './business-actions/common.cjs';
import {
  type ChatUserParamsMap,
  describeError,
  executeChatCompletionCore,
  sendChatJson,
} from './chat-streaming-engine.cts';

export interface ChatTemporaryCompletionRequest {
  client: BusinessClient;
  requestId: string;
  modelId: string;
  systemPromptText: string | undefined;
  messages: InternalMessage[];
  userParams: ChatUserParamsMap | undefined;
  /** 请求的思考档位（spec 37）；缺省 = 不思考。 */
  thinkingTier: string | undefined;
}

export function executeTemporaryChatCompletion(request: ChatTemporaryCompletionRequest): void {
  const abortController = new AbortController();

  const run = async (): Promise<void> => {
    try {
      const result = await executeChatCompletionCore({
        traceScope: 'temporary',
        requestId: request.requestId,
        sessionId: undefined,
        modelId: request.modelId,
        systemPromptText: request.systemPromptText,
        messages: request.messages,
        userParams: request.userParams ?? {},
        thinkingTier: request.thinkingTier,
        abortSignal: abortController.signal,
        onModelConfigResolved: undefined,
        onToken: (text: string) => {
          sendChatJson(request.client, {
            type: CHAT_WS_MESSAGE_TYPE.TEMPORARY_TOKEN,
            requestId: request.requestId,
            text,
          });
        },
      });

      sendChatJson(request.client, {
        type: CHAT_WS_MESSAGE_TYPE.TEMPORARY_COMPLETE,
        requestId: request.requestId,
        message: result.message,
        usage: result.usage,
      });
    } catch (error: unknown) {
      const errorDetails = describeError(error);
      sendChatJson(request.client, {
        type: CHAT_WS_MESSAGE_TYPE.TEMPORARY_ERROR,
        requestId: request.requestId,
        error: errorDetails.message,
      });
    }
  };

  void run();
}
