/**
 * Chat Streaming Engine
 *
 * 调用 ChatAdapter 执行流式对话，通过 WS 推送 token、complete、error 事件。
 * 负责：model asset 配置解析、媒体准备、context window 截断、适配器调用。
 *
 * 对话区域已退役（决策 #21）：会话级流式（executeChatStream / cancelChatStream）
 * 已移除；本模块保留核心执行器（executeChatCompletionCore），供临时 Chat
 * Completion（编辑器文本 AI 能力）与 agent 语言推理底座复用。
 */

import { randomUUID } from 'node:crypto';
import {
  getChatAdapter,
  truncateToContextWindow,
} from '@iart/chat-adapter';
import type { ChatToolCall, ChatToolDefinition } from '@iart/chat-adapter';
import {
  type ChatAdapterId,
  type InternalMessage,
  type ChatUsage,
  type ProtocolAdapterId,
} from '@iart/contracts';
import { resolveChatAdapterIdFromProtocolAdapter } from '@iart/contracts';
import { buildExecutionSnapshot } from './provider-connection/execution-snapshot.cjs';
import { acquireLease, releaseLease } from './provider-connection/credential-store.cjs';
import { getCustomChatModel } from './provider-connection/custom-chat-model-store.cts';
import * as loggingModule from './logging.cjs';
import { logError, logInfo } from './logging.cjs';
import type { BusinessClient } from './business-actions/common.cjs';

// ────────────────────────────────────────────
// 1. 请求类型
// ────────────────────────────────────────────

export type ChatUserParamsMap = Record<string, unknown>;
type ChatCoreLogMetaMap = Record<string, unknown>;

type ChatErrorDetails = {
  message: string;
  stack: string | null;
};

export function describeError(error: unknown): ChatErrorDetails {
  if (error instanceof Error) {
    return {
      message: error.message || String(error),
      stack: typeof error.stack === 'string' && error.stack.trim() ? error.stack : null,
    };
  }
  return {
    message: String(error),
    stack: null,
  };
}

// ────────────────────────────────────────────
// 2. Model Asset Config 解析
// ────────────────────────────────────────────

async function resolveChatModelConfig(
  modelAssetId: string,
  requestedThinkingTier: string | undefined,
): Promise<{
  chatAdapterId: ChatAdapterId;
  contextWindowTokens: number;
  /** 用户声明的回复上限；`undefined` = 不声明，适配器不发该参数、由服务商决定。 */
  maxOutputTokens: number | undefined;
  apiModelName: string;
  apiConfig: { apiKey: string; baseUrl: string; leaseId: string };
  thinkingTier: string | undefined;
}> {
  const apiConfig = await resolveApiConfig(modelAssetId);
  const capability = resolveChatModelCapability(modelAssetId);

  /* 对话协议以模型记录自带的 protocol_adapter_id 为唯一来源（2026-09-26 起协议归属模型级，
     spec 03 §1）：协议随快照的 adapter_id 冻结进来，记录协议不是对话协议时显式失败，不静默回退。 */
  const chatAdapterId = resolveChatAdapterIdFromProtocolAdapter(apiConfig.protocolAdapterId);
  if (!chatAdapterId) {
    throw new Error(
      `chat model ${modelAssetId} is bound to a non-chat protocol adapter: ${apiConfig.protocolAdapterId}`,
    );
  }

  return {
    chatAdapterId,
    contextWindowTokens: capability.contextWindowTokens,
    maxOutputTokens: capability.maxOutputTokens,
    /* 请求发给服务商的模型名取接入冻结的 remote_model_id，不取产品 model_id
       （spec 03 §6.1 单记录口径）：model_id 是身份与显示名，自建模型的线上模型名普遍不同。 */
    apiModelName: apiConfig.remoteModelId,
    apiConfig,
    thinkingTier: resolveThinkingTier(capability.enabledThinkingTiers, requestedThinkingTier),
  };
}

type ChatModelCapability = {
  contextWindowTokens: number;
  maxOutputTokens: number | undefined;
  /** 该模型记录上启用的思考档位（spec 37 v4.0.0：档位随自建对话模型记录走）。 */
  enabledThinkingTiers: string[];
};

/**
 * 解析对话模型的能力来源（spec 37「对话模型的唯一来源」）。
 *
 * 对话模型只有一个来源：**用户自建模型记录**（`config/custom-chat-models.json`，2026-09-25
 * 起能力属性与接入归属一体）。软件不再内置对话模型能力包，能力包格式也不再承载
 * `chat_streaming` 驱动，所以这里不再有「先查已装包」的分支——保留它只会在包目录里永远
 * 查不到，白白让读代码的人以为包也是一条来源。
 *
 * 没有记录即不是一个模型：显式失败，不得按名称或默认值替它推断一份能力。
 *
 * 自建模型按纯文本对话缺省，没有媒体准备，所以本能力集里没有媒体上传字段——
 * 对话链路上的媒体准备已随包形态一并退场。
 */
const resolveChatModelCapability = (modelAssetId: string): ChatModelCapability => {
  const declared = getCustomChatModel(modelAssetId);
  if (declared) {
    return {
      contextWindowTokens: declared.context_window_tokens,
      // null（不声明）在能力层表达成 undefined：适配器据此不发该参数、由服务商决定。
      maxOutputTokens: declared.max_output_tokens ?? undefined,
      enabledThinkingTiers: [...declared.enabled_thinking_tiers],
    };
  }
  throw new Error(
    `chat model has no declaration source (not a user-declared custom model): ${modelAssetId}`,
  );
};

/**
 * 把请求里的思考档位收敛成实际发送的档位（spec 37「思考档位」）。
 *
 * - 未选择（缺省）按 `off` 处理，**不得静默提升**为更高档位；
 * - 选了该模型未启用的档位时按未选择处理并留痕（不静默发送、也不报错中断本轮对话）。
 */
const resolveThinkingTier = (
  enabledTiers: string[],
  requestedTier: string | undefined,
): string | undefined => {
  if (typeof requestedTier !== 'string') return undefined;
  const trimmed = requestedTier.trim();
  if (!trimmed) return undefined;
  if (!enabledTiers.includes(trimmed)) {
    loggingModule.logDebug('[chat-streaming-engine] thinking tier not enabled for this model, treated as off', {
      requestedTier: trimmed,
      enabledTiers,
    });
    return undefined;
  }
  return trimmed;
};

// ────────────────────────────────────────────
// 3. API Config 解析（含 baseUrl）
// ────────────────────────────────────────────

/**
 * 解析 chat 模型的端点与凭证明文。
 *
 * 与任务主链同源：模型的 active 接入记录（deployment 或自建模型记录）→ ExecutionSnapshot
 * （服务商连接的 base_url 与协议适配器）→ CredentialLease（凭证明文）。未接入服务商、凭证
 * 缺失或不可读时抛错，由调用方按阶段报错——不回退到任何写死的网关或全局密钥槽位。
 *
 * 返回的 leaseId 由调用方在流式会话结束后释放。
 */
async function resolveApiConfig(
  modelAssetId: string,
): Promise<{
  apiKey: string;
  baseUrl: string;
  protocolAdapterId: ProtocolAdapterId;
  /** 该接入在服务商那边对应的模型名（快照冻结值）：对话请求的线上模型名。 */
  remoteModelId: string;
  leaseId: string;
}> {
  const snapshotResult = buildExecutionSnapshot({ modelId: modelAssetId });
  if (!snapshotResult.ok) {
    throw new Error(
      `chat model has no usable active access target: ${modelAssetId} (${snapshotResult.code})`,
    );
  }
  const { snapshot } = snapshotResult;
  const credentialRef = snapshot.credential_ref;
  if (!credentialRef) {
    throw new Error(`chat model connection carries no credential: ${modelAssetId}`);
  }
  const leaseResult = await acquireLease({
    connectionId: snapshot.connection_id,
    credentialRef,
    credentialVersion: typeof snapshot.credential_version === 'number' ? snapshot.credential_version : 0,
    connectionRevision: snapshot.connection_revision,
  });
  if (!leaseResult) {
    throw new Error(`chat model credential is unreadable: ${modelAssetId}`);
  }
  return {
    apiKey: leaseResult.value,
    baseUrl: snapshot.base_url,
    protocolAdapterId: snapshot.adapter_id,
    remoteModelId: snapshot.remote_model_id,
    leaseId: leaseResult.lease.leaseId,
  };
}

// ────────────────────────────────────────────
// 4. 流式执行引擎
// ────────────────────────────────────────────

export const sendChatJson = (client: BusinessClient, data: unknown): void => {
  if (client.closed) return;
  try {
    client.ws.send(JSON.stringify(data));
  } catch {
    // client disconnected
  }
};

type ChatCompletionCoreParams = {
  traceScope: 'session' | 'temporary';
  requestId: string | undefined;
  sessionId: string | undefined;
  modelId: string;
  systemPromptText: string | undefined;
  messages: InternalMessage[];
  userParams: ChatUserParamsMap | undefined;
  /** 请求的思考档位（spec 37）；缺省 = 不思考，执行前按该模型启用关系收敛。 */
  thinkingTier: string | undefined;
  abortSignal: AbortSignal;
  onModelConfigResolved: (() => void) | undefined;
  onToken: (text: string) => void;
  /**
   * 工具清单与工具调用回调（spec 04「工具调用循环语义」）。缺省 = 本轮不声明工具能力。
   * 适配器不支持工具协议时显式抛错（UNSUPPORTED_TOOL_CALLING），不静默降级。
   */
  tools?: ChatToolDefinition[] | undefined;
  onToolCall?: ((toolCall: ChatToolCall) => void) | undefined;
};

type ChatCompletionCoreResult = {
  message: InternalMessage;
  usage: ChatUsage;
};

const buildChatCoreLogMeta = (
  params: ChatCompletionCoreParams,
  extra: ChatCoreLogMetaMap,
): ChatCoreLogMetaMap => ({
  traceScope: params.traceScope,
  requestId: params.requestId ?? null,
  sessionId: params.sessionId ?? null,
  modelId: params.modelId,
  ...extra,
});


export async function executeChatCompletionCore(
  params: ChatCompletionCoreParams,
): Promise<ChatCompletionCoreResult> {
  let phase = 'resolve_model_config';
  let adapterId: ChatAdapterId | null = null;
  let contextWindowTokens: number | null = null;
  let baseUrl: string | null = null;
  let truncatedMessageCount: number | null = null;
  let streamedTokenEvents = 0;
  let streamedTextChars = 0;

  let credentialLeaseId: string | null = null;
  try {
    const modelConfig = await resolveChatModelConfig(params.modelId, params.thinkingTier);
    credentialLeaseId = modelConfig.apiConfig.leaseId;
    adapterId = modelConfig.chatAdapterId;
    contextWindowTokens = modelConfig.contextWindowTokens;
    baseUrl =
      typeof modelConfig.apiConfig.baseUrl === 'string' && modelConfig.apiConfig.baseUrl.trim()
        ? modelConfig.apiConfig.baseUrl
        : null;

    if (params.onModelConfigResolved !== undefined) {
      params.onModelConfigResolved();
    }

    phase = 'truncate_context_window';
    const truncated = truncateToContextWindow(params.messages, modelConfig.contextWindowTokens);
    truncatedMessageCount = truncated.length;

    phase = 'resolve_adapter';
    const adapter = getChatAdapter(modelConfig.chatAdapterId);

    let fullText = '';
    const assistantMessageId = randomUUID();
    const createdAt = Date.now();
    let latestUsage: ChatUsage | undefined;

    phase = 'execute_stream';
    const collectedToolCalls: ChatToolCall[] = [];
    await adapter.executeStream({
      messages: truncated,
      modelId: modelConfig.apiModelName,
      userParams: params.userParams ?? {},
      contextWindowTokens: modelConfig.contextWindowTokens,
      apiConfig: modelConfig.apiConfig,
      requestTrace: undefined,
      abortSignal: params.abortSignal,
      ...(params.systemPromptText != null ? { systemPrompt: params.systemPromptText } : {}),
      ...(modelConfig.thinkingTier != null ? { thinkingTier: modelConfig.thinkingTier } : {}),
      ...(modelConfig.maxOutputTokens != null ? { maxOutputTokens: modelConfig.maxOutputTokens } : {}),
      ...(params.tools && params.tools.length > 0 ? { tools: params.tools } : {}),
      ...(params.onToolCall
        ? {
            onToolCall: (toolCall: ChatToolCall) => {
              collectedToolCalls.push(toolCall);
              params.onToolCall?.(toolCall);
            },
          }
        : {}),
      onToken: (text: string) => {
        fullText += text;
        streamedTokenEvents += 1;
        streamedTextChars += text.length;
        params.onToken(text);
      },
      onUsage: (u: ChatUsage) => {
        latestUsage = u;
      },
    });

    const usage = latestUsage ?? { inputTokens: 0, outputTokens: 0 };
    const assistantMessage: InternalMessage = {
      messageId: assistantMessageId,
      role: 'assistant',
      content: fullText,
      createdAt,
      tokenCount: usage.outputTokens,
      ...(collectedToolCalls.length > 0 ? { toolCalls: collectedToolCalls } : {}),
    };

    return { message: assistantMessage, usage };
  } catch (error: unknown) {
    const errorDetails = describeError(error);
    const logMeta = buildChatCoreLogMeta(params, {
      adapterId,
      baseUrl,
      contextWindowTokens,
      phase,
      truncatedMessageCount,
      streamedTokenEvents,
      streamedTextChars,
      error: errorDetails.message,
      stack: errorDetails.stack,
    });
    if (params.abortSignal.aborted) {
      logInfo('chat completion core cancelled', logMeta);
    } else {
      logError('chat completion core failed', logMeta);
    }
    throw error;
  } finally {
    // 流式会话结束（成功 / 失败 / 取消）后释放凭证租约
    if (credentialLeaseId !== null) {
      releaseLease(credentialLeaseId);
    }
  }
}

// 测试导出：档位收敛与模型能力解析是决定「发什么」的两处判据，单测直接钉住口径（spec 37）。
export const __test_only__ = {
  resolveThinkingTier,
  resolveChatModelCapability,
  resolveChatModelConfig,
};
