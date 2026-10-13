/**
 * Chat Contract
 *
 * 临时 Chat Completion 跨进程共享数据模型的 Zod schema + TypeScript 类型。
 *
 * 对话区域已退役（决策 #21，见 docs/chat/06-已裁定决策记录.md）：
 * 会话级流式（chat:send_message / chat:cancel 及会话存储 IPC）随之移除；
 * 本契约只保留临时补全（chat:temporary_completion）与语言推理底座共享类型
 * （ChatAdapterId / InternalMessage / ChatMessageContent）。
 *
 * 设计依据: docs/agent/*（临时 Chat Completion 面向 agent 协议底座）
 */

import * as z from 'zod';
import { ThinkingTierSchema } from './thinking-tier-contract';

// ────────────────────────────────────────────
// 1. ChatAdapterId — 适配器标识符
// ────────────────────────────────────────────

export const CHAT_ADAPTER_IDS = [
  'openai_chat',
  'openai_responses',
  'anthropic_messages',
  'gemini',
] as const;

export type ChatAdapterId = (typeof CHAT_ADAPTER_IDS)[number];

export const ChatAdapterIdSchema = z.enum(CHAT_ADAPTER_IDS);

// ────────────────────────────────────────────
// 2. ChatMessageContent — 统一内部消息内容格式
// ────────────────────────────────────────────

export const ChatTextPartSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

export const ChatImagePartSchema = z.object({
  type: z.literal('image'),
  url: z.string(),
});

export const ChatAudioPartSchema = z.object({
  type: z.literal('audio'),
  url: z.string(),
});

export const ChatVideoPartSchema = z.object({
  type: z.literal('video'),
  url: z.string(),
});

export const ChatMessagePartSchema = z.discriminatedUnion('type', [
  ChatTextPartSchema,
  ChatImagePartSchema,
  ChatAudioPartSchema,
  ChatVideoPartSchema,
]);

export const ChatMessageContentSchema: z.ZodType<ChatMessageContent> = z.union([
  z.string(),
  z.array(ChatMessagePartSchema),
]);

export type ChatMessageContent =
  | string
  | Array<
      | { type: 'text'; text: string }
      | { type: 'image'; url: string }
      | { type: 'audio'; url: string }
      | { type: 'video'; url: string }
    >;

// ────────────────────────────────────────────
// 3. InternalMessage — 运行时消息格式（WS 传输 + adapter 输入）
// ────────────────────────────────────────────

export const ChatRoleSchema = z.enum(['user', 'assistant', 'system', 'tool']);

export type ChatRole = z.infer<typeof ChatRoleSchema>;

/**
 * assistant 消息携带的工具调用请求（模型请求调用工具时填充）。
 *
 * `argsJson` 是调用参数的 JSON 字符串（协议侧原样透传，不做字段级解释）。
 */
export const InternalToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  argsJson: z.string(),
});

export type InternalToolCall = z.infer<typeof InternalToolCallSchema>;

const InternalMessageBaseSchema = z.object({
  messageId: z.string(),
  content: ChatMessageContentSchema,
  createdAt: z.number(),
  tokenCount: z.number().optional(),
  isPartial: z.boolean().optional(),
});

/**
 * 运行时消息格式，按 `role` 判别：
 *
 * - `user` / `system`：对话消息。
 * - `assistant`：模型回复；请求工具调用时携带 `toolCalls`。
 * - `tool`：工具结果回传消息，`toolCallId` 指向被结算的 tool_call，`toolName` 为工具名。
 *   该角色只存在于对话模型上下文（LLM 循环内拼装），不进入 agent 会话正式历史
 *   （会话侧以 `tool_call` / `tool_result` 消息体承载，见 agent-contract）。
 */
export const InternalMessageSchema = z.discriminatedUnion('role', [
  InternalMessageBaseSchema.extend({ role: z.literal('user') }),
  InternalMessageBaseSchema.extend({ role: z.literal('system') }),
  InternalMessageBaseSchema.extend({
    role: z.literal('assistant'),
    toolCalls: z.array(InternalToolCallSchema).optional(),
  }),
  InternalMessageBaseSchema.extend({
    role: z.literal('tool'),
    toolCallId: z.string(),
    toolName: z.string(),
  }),
]);

export type InternalMessage = z.infer<typeof InternalMessageSchema>;

// ────────────────────────────────────────────
// 4. WS 消息类型常量（临时补全）
// ────────────────────────────────────────────

export const CHAT_WS_MESSAGE_TYPE = Object.freeze({
  // Client → Server
  TEMPORARY_COMPLETION: 'chat:temporary_completion',
  // Server → Client
  TEMPORARY_TOKEN: 'chat:temporary_token',
  TEMPORARY_COMPLETE: 'chat:temporary_complete',
  TEMPORARY_ERROR: 'chat:temporary_error',
} as const);

export type ChatWsMessageType =
  (typeof CHAT_WS_MESSAGE_TYPE)[keyof typeof CHAT_WS_MESSAGE_TYPE];

// ────────────────────────────────────────────
// 5. Client → Server WS 消息 Schema
// ────────────────────────────────────────────

export const ChatUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
});

export type ChatUsage = z.infer<typeof ChatUsageSchema>;

export const ChatTemporaryCompletionSchema = z.object({
  type: z.literal(CHAT_WS_MESSAGE_TYPE.TEMPORARY_COMPLETION),
  requestId: z.string(),
  modelId: z.string(),
  systemPrompt: z.string().optional(),
  messages: z.array(InternalMessageSchema),
  userParams: z.record(z.unknown()).optional(),
  /**
   * 思考档位标识（spec 37「思考档位」）。缺省 = 不思考，不得静默提升为更高档位；
   * 传了该模型未启用的档位时，执行侧按未选择处理并留痕。
   */
  thinkingTier: ThinkingTierSchema.optional(),
});

export type ChatTemporaryCompletion = z.infer<typeof ChatTemporaryCompletionSchema>;

export const ChatClientMessageSchema = z.discriminatedUnion('type', [
  ChatTemporaryCompletionSchema,
]);

export type ChatClientMessage = z.infer<typeof ChatClientMessageSchema>;

// ────────────────────────────────────────────
// 6. Server → Client WS 消息 Schema
// ────────────────────────────────────────────

export const ChatTemporaryTokenSchema = z.object({
  type: z.literal(CHAT_WS_MESSAGE_TYPE.TEMPORARY_TOKEN),
  requestId: z.string(),
  text: z.string(),
});

export type ChatTemporaryToken = z.infer<typeof ChatTemporaryTokenSchema>;

export const ChatTemporaryCompleteSchema = z.object({
  type: z.literal(CHAT_WS_MESSAGE_TYPE.TEMPORARY_COMPLETE),
  requestId: z.string(),
  message: InternalMessageSchema,
  usage: ChatUsageSchema,
});

export type ChatTemporaryComplete = z.infer<typeof ChatTemporaryCompleteSchema>;

export const ChatTemporaryErrorSchema = z.object({
  type: z.literal(CHAT_WS_MESSAGE_TYPE.TEMPORARY_ERROR),
  requestId: z.string(),
  error: z.string(),
});

export type ChatTemporaryError = z.infer<typeof ChatTemporaryErrorSchema>;

export const ChatServerMessageSchema = z.discriminatedUnion('type', [
  ChatTemporaryTokenSchema,
  ChatTemporaryCompleteSchema,
  ChatTemporaryErrorSchema,
]);

export type ChatServerMessage = z.infer<typeof ChatServerMessageSchema>;

// ────────────────────────────────────────────
// 7. 类型守卫
// ────────────────────────────────────────────

export function isChatClientMessage(msg: unknown): msg is ChatClientMessage {
  return ChatClientMessageSchema.safeParse(msg).success;
}

export function isChatServerMessage(msg: unknown): msg is ChatServerMessage {
  return ChatServerMessageSchema.safeParse(msg).success;
}
