/**
 * 对话适配器类型定义
 *
 * 共享类型（ChatAdapterId, ChatMessageContent, InternalMessage）从 @iart/contracts 导入，
 * 本文件只定义适配器内部接口。
 */

import type {
  InternalMessage,
} from '@iart/contracts';

export type {
  ChatAdapterId,
  ChatMessageContent,
  InternalMessage,
} from '@iart/contracts';
export { CHAT_ADAPTER_IDS } from '@iart/contracts';

// ---- 适配器接口 ----

export type ChatRequestTrace = (message: string, meta: unknown) => void;

export interface ChatAdapterConfig {
  baseUrl?: string;
  apiKey: string;
}

/**
 * 工具定义（function calling）。`parameters` 是工具参数的 JSON Schema 对象，
 * 由调用方（agent 工具注册表）投影，适配器原样透传给协议侧，不做字段级解释。
 */
export interface ChatToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** 模型请求的一次工具调用（流式增量聚合完成后的稳定形状）。 */
export interface ChatToolCall {
  id: string;
  name: string;
  argsJson: string;
}

export interface ChatStreamParams {
  messages: InternalMessage[];
  systemPrompt?: string;
  modelId: string;
  userParams: Record<string, unknown>;
  contextWindowTokens: number;
  apiConfig: ChatAdapterConfig;
  requestTrace: ChatRequestTrace | undefined;
  /**
   * 思考档位标识（spec 37「思考档位」）。缺省 = 不思考（`off`），适配器不发任何档位字段；
   * 档位到厂商参数的翻译由本包内的 `thinking-tiers.ts` 统一承担。
   */
  thinkingTier?: string;
  /**
   * 最大输出 token（spec 37「对话模型的唯一来源」）：一次回复最多生成多少 token，含思考 token。
   *
   * 缺省 = 用户没声明，适配器**不发**该字段，由服务商决定——这与「发一个我们挑的默认值」不同，
   * 后者会给每个模型强加一道无人声明的上限。
   *
   * 与思考档位同法：这里是协议无关的统一语义，各协议落到自己的字段（Chat Completions 的
   * `max_completion_tokens`、Responses 的 `max_output_tokens`、Anthropic 的 `max_tokens`、
   * Gemini 的 `maxOutputTokens`），不在本包之外维护并列映射表。
   */
  maxOutputTokens?: number;
  /**
   * 工具清单（function calling）。缺省 = 本轮不声明工具能力。
   *
   * 适配器职责边界：openai_chat 透传并在流结束后回调聚合完成的 tool_calls；
   * 其余适配器（openai_responses / anthropic_messages / gemini）显式拒绝，不静默降级——
   * 静默丢弃工具会让模型「以为能调用」而实际无人执行。
   */
  tools?: ChatToolDefinition[];
  /**
   * 工具调用回调：流结束后，对本响应聚合完成的每条 tool_call 逐条回调（按协议侧顺序）。
   * 文本 token 与 tool_calls 可在同一响应共存；仅请求携带 tools 时才会有回调。
   */
  onToolCall?: (toolCall: ChatToolCall) => void;
  onToken: (text: string) => void;
  onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
  abortSignal?: AbortSignal;
}

export interface ChatAdapter {
  executeStream(params: ChatStreamParams): Promise<void>;
}

/**
 * 工具调用能力当前只在 openai_chat 适配器落地；其余协议收到工具清单时显式拒绝，
 * 不静默降级——静默丢弃 tools 会让模型「以为能调用」而实际无人执行。
 */
export function assertNoToolsOrThrow(
  adapterId: string,
  tools: ChatToolDefinition[] | undefined,
): void {
  if (tools && tools.length > 0) {
    throw new Error(
      `UNSUPPORTED_TOOL_CALLING: chat adapter ${adapterId} does not support tool calling`,
    );
  }
}
