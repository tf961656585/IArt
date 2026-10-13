/**
 * Agent Execution
 *
 * `agent:*` WebSocket 执行编排：一次 `agent:submit_prompt` 的完整生命周期
 * （受理 → 加载正式历史 → 流式 token → 完成/失败/取消收口）。
 *
 * 语义事实源: docs/agent/04-执行管道与WS协议.md
 * - 项目作用域唯一来源是 payload 的 `projectPath`，且必须是当前已注册项目作用域
 *   （Desktop Main 经 `runtime:project-scope-*` 同步的注册表，见 checkOpenedProjectScope）。
 * - 正式历史读取走 Backend → Main 读取通道 `runtime:read-agent-messages`（本模块只读，不落库）。
 * - 语言流式执行复用 chat 域底座（chat-streaming-engine 的 executeChatCompletionCore）。
 * - 不设超时、不自动重试、无 fallback；失败一律以 `agent:error` 收口，
 *   不以相似模型/默认服务/环境变量替代。
 * - 不落库、不写会话消息：正式消息与本地发送留痕由 Editor 侧写入。
 */

import * as z from 'zod';
import {
  AGENT_WS_MESSAGE_TYPE,
  AgentClientMessageSchema,
  AgentMessageRecordSchema,
  type AgentCancel,
  type AgentClientMessage,
  type AgentMessageRecord,
  type AgentReferenceAssetBrief,
  type AgentSubmitPrompt,
  type ChatMessageContent,
  type InternalMessage,
  type InternalToolCall,
} from '@iart/contracts';

import type { BusinessClient } from './business-actions/common.cts';
import { sendReadAgentMessages } from './backend-ipc-sender.cts';
import {
  describeError,
  executeChatCompletionCore,
} from './chat-streaming-engine.cts';
import {
  AGENT_TOOL_LOOP_ROUND_LIMIT,
  listAgentToolProjections,
} from './agent-tool-registry.cts';
import {
  cancelAgentToolCall,
  getPendingToolDecisionIdsForTests,
  resolveToolDecision,
  runAgentToolBatch,
  setToolProposalTimeoutMsForTests,
  validateToolDecision,
} from './agent-tool-loop.cts';
import {
  sendAgentAccepted,
  sendAgentAssistantMessage,
  sendAgentComplete,
  sendAgentError,
  sendAgentToken,
} from './agent-ws-senders.cts';
import { logDebug, logError, logInfo, logWarn } from './logging.cts';
import { getRegisteredProjectScopePaths } from './project-media-scope.cts';

// ────────────────────────────────────────────
// 1. 在途请求登记（按 agentSessionId 单飞）
// ────────────────────────────────────────────

type AgentInFlightEntry = {
  requestId: string;
  abortController: AbortController;
};

/**
 * 同一 `agentSessionId` 同时只允许一个在途请求；不同会话互不影响。
 *
 * 重复提交按 `invalid_request` 拒绝（不排队、不打断在途请求）——排队会让用户以为
 * 新提交已生效，打断会让已完成的部分内容失去收口方。
 */
const inFlightBySession = new Map<string, AgentInFlightEntry>();

/**
 * `confirm` 档的批级决裁登记（勾选提交 / 整轮驳回 / 批级超时）都在 `agent-tool-loop.cts`
 * （谁登记、谁结算）；本模块只做消息路由与循环推进，不持有工具调用状态。
 */

/** 正式历史读取结果经 RuntimeTransactionResult.data 返回 `AgentMessageRecord[]`。 */
const AgentMessageRecordListSchema = z.array(AgentMessageRecordSchema);

// ────────────────────────────────────────────
// 2. 测试注入点（生产路径不得调用）
// ────────────────────────────────────────────

type AgentCoreExecutor = typeof executeChatCompletionCore;
let coreExecutor: AgentCoreExecutor = executeChatCompletionCore;

// ────────────────────────────────────────────
// 3. 消息入口
// ────────────────────────────────────────────

/**
 * `agent:*` WS 消息入口（websocket.cts 的前缀分流终点）。
 *
 * 解析失败或未知类型时尽力回一条 `agent:error`（`invalid_request`）：
 * 能从原始 JSON 提到 `requestId` 就带上，提不到只留日志（Editor 无请求可归属）。
 */
export const handleAgentMessage = (client: BusinessClient, raw: unknown): void => {
  const rawRequestId = readRawString(raw, 'requestId');
  const rawAgentSessionId = readRawString(raw, 'agentSessionId');
  const parseResult = AgentClientMessageSchema.safeParse(raw);
  if (!parseResult.success) {
    logWarn('[agent-execution] agent websocket message parse failed', {
      requestId: rawRequestId || null,
      agentSessionId: rawAgentSessionId || null,
      error: parseResult.error.message,
    });
    if (!rawRequestId) return;
    sendAgentError(client, {
      requestId: rawRequestId,
      agentSessionId: rawAgentSessionId,
      code: 'invalid_request',
      message: `Invalid agent message: ${parseResult.error.message}`,
      partialContent: null,
    });
    return;
  }

  const message: AgentClientMessage = parseResult.data;
  switch (message.type) {
    case AGENT_WS_MESSAGE_TYPE.SUBMIT_PROMPT:
      void executeAgentSubmitPrompt({ client, message });
      return;
    case AGENT_WS_MESSAGE_TYPE.CANCEL:
      cancelAgentRequest(message);
      return;
    case AGENT_WS_MESSAGE_TYPE.TOOL_DECISION: {
      const invalidReason = validateToolDecision(message);
      if (invalidReason !== null) {
        logWarn('[agent-execution] tool decision rejected: invalid decision payload', {
          requestId: message.requestId || null,
          agentSessionId: message.agentSessionId || null,
          decision: message.decision,
          decisionCount: message.decision === 'submit' ? message.decisions.length : 0,
          reason: invalidReason,
        });
        sendAgentError(client, {
          requestId: message.requestId,
          agentSessionId: message.agentSessionId,
          code: 'invalid_request',
          message: `Invalid tool decision: ${invalidReason}`,
          partialContent: null,
        });
        return;
      }
      resolveToolDecision(message);
      return;
    }
    default:
      // schema 是封闭判别联合；走到这里说明契约新增了类型但本模块未接线。
      logWarn('[agent-execution] unsupported agent message type', {
        requestId: readRawString(raw, 'requestId') || null,
        type: readRawString(raw, 'type') || null,
      });
      return;
  }
};

/**
 * 取消路由：`agent:cancel` 携带 `toolCallId` 时为单条取消（spec 04「工具调用循环语义·
 * 单条取消」）——只中止该条目的执行与派生任务，整轮继续；缺省（null）为整请求取消。
 *
 * 整请求取消只 abort，不在这里发事件——收口由该请求自身的执行循环负责（`cancelled` +
 * partialContent），避免"取消已在完成后的请求"发出与 `agent:complete` 冲突的收口事件。
 */
export const cancelAgentRequest = (cancel: AgentCancel): void => {
  const toolCallId = (cancel.toolCallId ?? '').trim();
  if (toolCallId) {
    cancelAgentToolCall(cancel);
    return;
  }
  const agentSessionId = cancel.agentSessionId.trim();
  const requestId = cancel.requestId.trim();
  if (!agentSessionId) {
    logWarn('[agent-execution] cancel ignored: empty agentSessionId', { requestId: requestId || null });
    return;
  }
  const entry = inFlightBySession.get(agentSessionId);
  if (!entry) {
    logDebug('[agent-execution] cancel ignored: no in-flight request for session', {
      agentSessionId,
      requestId: requestId || null,
    });
    return;
  }
  if (requestId && entry.requestId !== requestId) {
    logDebug('[agent-execution] cancel ignored: requestId does not match in-flight request', {
      agentSessionId,
      requestId,
      inFlightRequestId: entry.requestId,
    });
    return;
  }
  logInfo('[agent-execution] cancelling in-flight request', {
    agentSessionId,
    requestId: entry.requestId,
  });
  entry.abortController.abort();
};

// ────────────────────────────────────────────
// 4. 提交执行编排
// ────────────────────────────────────────────

export type AgentSubmitPromptRequest = {
  client: BusinessClient;
  message: AgentSubmitPrompt;
};

/**
 * 一轮提交的完整生命周期。永不 reject：所有失败路径都以 `agent:error` 收口。
 *
 * 事件顺序：`agent:accepted`（受理，Editor 据此把 user 消息写入正式历史）
 * → `agent:token`* → `agent:complete` / `agent:error`。
 */
export async function executeAgentSubmitPrompt(request: AgentSubmitPromptRequest): Promise<void> {
  const { client, message } = request;
  const requestId = message.requestId.trim();
  const agentSessionId = message.agentSessionId.trim();
  const projectPath = message.projectPath.trim();
  const modelId = message.modelId.trim();

  const validationFailure = validateSubmitPrompt({
    requestId,
    agentSessionId,
    projectPath,
    modelId,
    content: message.content,
  });
  if (validationFailure) {
    logWarn('[agent-execution] submit rejected: invalid request', {
      requestId: requestId || null,
      agentSessionId: agentSessionId || null,
      reason: validationFailure,
    });
    sendAgentError(client, {
      requestId,
      agentSessionId,
      code: 'invalid_request',
      message: validationFailure,
      partialContent: null,
    });
    return;
  }

  if (inFlightBySession.has(agentSessionId)) {
    logWarn('[agent-execution] submit rejected: request already in flight for session', {
      requestId,
      agentSessionId,
      inFlightRequestId: inFlightBySession.get(agentSessionId)?.requestId ?? null,
    });
    sendAgentError(client, {
      requestId,
      agentSessionId,
      code: 'invalid_request',
      message: 'A request is already in flight for this agent session',
      partialContent: null,
    });
    return;
  }

  const abortController = new AbortController();
  inFlightBySession.set(agentSessionId, { requestId, abortController });
  let streamedText = '';
  let modelConfigResolved = false;

  try {
    const scopeCheck = checkOpenedProjectScope({ requestId, agentSessionId, projectPath });
    if (!scopeCheck.ok) {
      logWarn('[agent-execution] submit rejected: project scope not acceptable', {
        requestId,
        agentSessionId,
        projectPath,
        reason: scopeCheck.message,
        openedProjectCount: scopeCheck.openedProjectCount,
      });
      sendAgentError(client, {
        requestId,
        agentSessionId,
        code: 'invalid_request',
        message: scopeCheck.message,
        partialContent: null,
      });
      return;
    }

    const history = await readAgentMessageHistory({ projectPath, agentSessionId, requestId });
    if (!history.ok) {
      logWarn('[agent-execution] submit failed: agent session history unavailable', {
        requestId,
        agentSessionId,
        projectPath,
        error: history.message,
      });
      sendAgentError(client, {
        requestId,
        agentSessionId,
        code: 'execution_failed',
        message: history.message,
        partialContent: null,
      });
      return;
    }

    // 历史读取期间被取消：本轮从未受理，不发 accepted（Editor 不写正式历史），直接收口
    if (abortController.signal.aborted) {
      logInfo('[agent-execution] request cancelled before acceptance', {
        requestId,
        agentSessionId,
      });
      sendAgentError(client, {
        requestId,
        agentSessionId,
        code: 'cancelled',
        message: 'Agent request cancelled',
        partialContent: null,
      });
      return;
    }

    // 历史读取完成后再受理：Editor 在收到 accepted 后才写 user 消息，
    // 保证本轮用户消息不会同时出现在"历史"与本轮追加里。
    sendAgentAccepted(client, { requestId, agentSessionId });

    const messages: InternalMessage[] = [
      ...history.messages,
      buildUserMessage({ requestId, content: message.content }),
    ];
    const assetInventoryPrompt = buildAssetInventorySystemPrompt(message.referenceAssets);

    // 工具调用循环（spec 04「工具调用循环语义」）：流式回复 → 工具调用批 → 批级裁定与并发
    // 执行 → 结果配对拼回上下文 → 再次调用；轮数达上限后的请求不再携带 tools，强制模型文本收口。
    let finalContent: ChatMessageContent = '';
    let round = 0;
    for (;;) {
      const includeTools = round < AGENT_TOOL_LOOP_ROUND_LIMIT;
      const projections = includeTools ? listAgentToolProjections() : [];
      // 本轮模型请求的工具调用收集口：不传 onToolCall 时流式引擎不会让适配器把聚合完成的
      // tool_calls 交回来（聚合结果被丢弃），循环首轮即收口。
      const streamedToolCalls: InternalToolCall[] = [];
      const result = await coreExecutor({
        traceScope: 'session',
        requestId,
        sessionId: agentSessionId,
        modelId,
        systemPromptText: assetInventoryPrompt,
        messages,
        userParams: {},
        thinkingTier: message.thinkingTier,
        abortSignal: abortController.signal,
        tools: includeTools ? projections.map((projection) => projection.definition) : undefined,
        onToolCall: (toolCall: InternalToolCall) => {
          streamedToolCalls.push(toolCall);
        },
        onModelConfigResolved: () => {
          modelConfigResolved = true;
        },
        onToken: (delta: string) => {
          streamedText += delta;
          sendAgentToken(client, { requestId, agentSessionId, delta });
        },
      });
      messages.push(result.message);
      streamedText = '';

      // 生产路径经回调交出本轮的 tool_calls（与 result.message.toolCalls 同源）；测试注入的
      // 假执行器只回填 message.toolCalls，故以它兜底。
      const roundToolCalls: InternalToolCall[] =
        streamedToolCalls.length > 0
          ? streamedToolCalls
          : 'toolCalls' in result.message && result.message.toolCalls
            ? result.message.toolCalls
            : [];
      if (roundToolCalls.length === 0) {
        finalContent = result.message.content;
        break;
      }

      // 中间轮助手消息定稿（携带工具调用），Editor 据此落一条 assistant 消息。
      sendAgentAssistantMessage(client, {
        requestId,
        agentSessionId,
        content: result.message.content,
        toolCalls: roundToolCalls,
      });

      // 工具批并发执行 + 批级屏障（spec 04「工具调用循环语义」）：本批全部条目并发派发，
      // 结果按 toolCallId 逐条配对回灌；全部条目终态（`allSettled`）后才判断取消并推进下一轮
      // ——避免未 await 的兄弟条目在请求收口后继续发事件。
      const followUps = await runAgentToolBatch({
        client,
        submit: message,
        toolCalls: roundToolCalls,
        abortController,
      });
      messages.push(...followUps);
      if (abortController.signal.aborted) {
        throw new Error('Agent request cancelled during tool execution');
      }
      round += 1;
    }

    sendAgentComplete(client, {
      requestId,
      agentSessionId,
      content: finalContent,
    });
  } catch (error: unknown) {
    const errorDetails = describeError(error);
    if (abortController.signal.aborted) {
      logInfo('[agent-execution] request cancelled', {
        requestId,
        agentSessionId,
        streamedTextChars: streamedText.length,
      });
      sendAgentError(client, {
        requestId,
        agentSessionId,
        code: 'cancelled',
        message: errorDetails.message || 'Agent request cancelled',
        partialContent: partialContentOrNull(streamedText),
      });
      return;
    }
    logError('[agent-execution] request failed', {
      requestId,
      agentSessionId,
      modelId,
      modelConfigResolved,
      streamedTextChars: streamedText.length,
      error: errorDetails.message,
      stack: errorDetails.stack,
    });
    sendAgentError(client, {
      requestId,
      agentSessionId,
      code: modelConfigResolved ? 'execution_failed' : 'model_unavailable',
      message: errorDetails.message,
      partialContent: partialContentOrNull(streamedText),
    });
  } finally {
    const entry = inFlightBySession.get(agentSessionId);
    if (entry && entry.requestId === requestId) {
      inFlightBySession.delete(agentSessionId);
    } else if (entry) {
      logDebug('[agent-execution] in-flight entry left intact: owned by another request', {
        agentSessionId,
        requestId,
        inFlightRequestId: entry.requestId,
      });
    }
  }
}

type SubmitPromptValidationInput = {
  requestId: string;
  agentSessionId: string;
  projectPath: string;
  modelId: string;
  content: ChatMessageContent;
};

/** 校验返回失败原因（字符串）或 null（通过）。schema 只保证形状，非空性在本层收口。 */
const validateSubmitPrompt = (input: SubmitPromptValidationInput): string | null => {
  if (!input.requestId) return 'requestId is required';
  if (!input.agentSessionId) return 'agentSessionId is required';
  if (!input.projectPath) return 'projectPath is required';
  if (!input.modelId) return 'modelId is required';
  if (typeof input.content === 'string') {
    if (!input.content.trim()) return 'content is empty';
    return null;
  }
  if (input.content.length === 0) return 'content is empty';
  return null;
};

const buildUserMessage = (params: {
  requestId: string;
  content: ChatMessageContent;
}): InternalMessage => ({
  messageId: `agent_user_${params.requestId}`,
  role: 'user',
  content: params.content,
  createdAt: Date.now(),
});

// ────────────────────────────────────────────
// 4.5 工具调用循环编排（spec 04「工具调用循环语义」）
//
// 工具批的编排（批内去重、批级裁定、并发执行、终态结算）在 `agent-tool-loop.cts`；
// 本模块只负责循环推进：流式回复 → 本批 tool_calls → 交给工具批模块 → 结果配对拼回上下文
// → 再次调用。
// ────────────────────────────────────────────

/**
 * 会话资产清单注入：模型据此以 assetId 引用资产（生成参考输入 / 加工工具的 asset_id 参数）。
 * 资产事实源仍在项目库，这里只投影引用与展示所需的简报。
 */
const buildAssetInventorySystemPrompt = (
  referenceAssets: ReadonlyArray<AgentReferenceAssetBrief> | undefined,
): string | undefined => {
  if (!referenceAssets || referenceAssets.length === 0) return undefined;
  const lines = referenceAssets.map((brief) => {
    const dims = brief.width !== null && brief.height !== null ? ` ${brief.width}x${brief.height}` : '';
    const duration =
      brief.durationMs !== null && brief.durationMs > 0 ? ` 时长${Math.round(brief.durationMs / 1000)}s` : '';
    const summary = brief.summary.trim() ? ` ${brief.summary.trim()}` : '';
    return `- assetId: ${brief.assetId}（${brief.mediaType}${dims}${duration}）${summary}`;
  });
  return ['当前会话可用资产清单（工具调用时按 assetId 引用）：', ...lines].join('\n');
};

const partialContentOrNull = (streamedText: string): ChatMessageContent | null =>
  streamedText ? streamedText : null;


// ────────────────────────────────────────────
// 5. 正式历史加载
// ────────────────────────────────────────────

type AgentHistoryLoadResult =
  | { ok: true; messages: InternalMessage[] }
  | { ok: false; message: string };

/**
 * 加载并投影正式历史。
 *
 * 失败（IPC 失败 / 数据不合法）返回 `ok: false`，由调用方以 `agent:error` 收口——
 * 不得静默当空历史：那会让模型丢上下文且无人察觉。
 */
const readAgentMessageHistory = async (params: {
  projectPath: string;
  agentSessionId: string;
  requestId: string;
}): Promise<AgentHistoryLoadResult> => {
  let result: Awaited<ReturnType<typeof sendReadAgentMessages>>;
  try {
    result = await sendReadAgentMessages({
      projectPath: params.projectPath,
      agentSessionId: params.agentSessionId,
    });
  } catch (error: unknown) {
    const errorDetails = describeError(error);
    return {
      ok: false,
      message: `Failed to read agent session history: ${errorDetails.message}`,
    };
  }

  if (!result.success) {
    return {
      ok: false,
      message: `Failed to read agent session history: ${result.error ?? 'unknown error'}`,
    };
  }

  const parsed = AgentMessageRecordListSchema.safeParse(result.data);
  if (!parsed.success) {
    logWarn('[agent-execution] agent session history payload invalid', {
      agentSessionId: params.agentSessionId,
      projectPath: params.projectPath,
      error: parsed.error.message,
    });
    return {
      ok: false,
      message: `Agent session history payload is invalid: ${parsed.error.message}`,
    };
  }

  const visibleRecords: AgentMessageRecord[] = [];
  for (const record of parsed.data) {
    if (record.requestId === params.requestId) {
      logDebug('[agent-execution] history record skipped: belongs to the current request', {
        agentSessionId: params.agentSessionId,
        seq: record.seq,
      });
      continue;
    }
    visibleRecords.push(record);
  }
  return { ok: true, messages: projectHistoryRecords(visibleRecords) };
}

/**
 * 正式消息记录 → 底座消息投影（spec 04「工具调用循环语义·历史投影规则」）。
 *
 * - `chat` 为对话消息；`tool_call` / `tool_result`（自 2026-09-18 批次产生数据）投影为模型
 *   上下文的 assistant toolCalls 与 tool 角色消息——工具链路跨轮可见，模型可继续引用历史产物资产。
 * - 同一批的**连续** `tool_call` 记录合并为一条携带完整 `toolCalls` 的 assistant 消息，其后跟随
 *   本批 tool 结果消息（并发执行下结果记录按完成序落库，配对依据是 `toolCallId`）。串行历史的
 *   连续段长度为 1，投影结果与旧行为一致（向后兼容）。
 * - 两条不变量：每条 `tool_call` 有按 `toolCallId` 配对的结果、每条结果有对应的调用。中断或
 *   历史缺口的残留（无结果的调用 / 无调用的结果 / 同 id 重复结果）在此丢弃并留痕——否则下一次
 *   模型调用会因孤儿 tool 消息整体报错（单条坏记录不该让整轮上下文不可用）。
 */
const projectHistoryRecords = (
  records: ReadonlyArray<AgentMessageRecord>,
): InternalMessage[] => {
  const calledToolCallIds = new Set<string>();
  const resultedToolCallIds = new Set<string>();
  for (const record of records) {
    if (record.body.kind === 'tool_call') calledToolCallIds.add(record.body.toolCallId);
    if (record.body.kind === 'tool_result') resultedToolCallIds.add(record.body.toolCallId);
  }
  const pairedToolCallIds = new Set(
    [...calledToolCallIds].filter((toolCallId) => resultedToolCallIds.has(toolCallId)),
  );

  const messages: InternalMessage[] = [];
  const answeredToolCallIds = new Set<string>();
  let index = 0;
  while (index < records.length) {
    const record = records[index];
    if (record === undefined) break;
    if (record.body.kind === 'tool_call') {
      const batch: AgentMessageRecord[] = [record];
      index += 1;
      while (index < records.length && records[index]?.body.kind === 'tool_call') {
        const head = records[index];
        if (head) batch.push(head);
        index += 1;
      }
      const batchBase = historyRecordBase(record);
      const toolCalls = batch.flatMap((candidate) => {
        if (candidate.body.kind !== 'tool_call') return [];
        if (!pairedToolCallIds.has(candidate.body.toolCallId)) {
          logDebug('[agent-execution] history tool_call skipped: no paired tool result', {
            agentSessionId: candidate.agentSessionId,
            seq: candidate.seq,
            toolCallId: candidate.body.toolCallId,
          });
          return [];
        }
        return [
          {
            id: candidate.body.toolCallId,
            name: candidate.body.toolName,
            argsJson: candidate.body.argsJson,
          },
        ];
      });
      if (toolCalls.length > 0) {
        messages.push({ ...batchBase, role: 'assistant', content: '', toolCalls });
      }
      continue;
    }
    const projected = projectHistoryRecord(record, pairedToolCallIds, answeredToolCallIds);
    if (projected) messages.push(projected);
    index += 1;
  }
  return messages;
};

/** 记录 → 投影消息的公共字段（消息身份取记录（会话 + seq），保证投影稳定可追溯）。 */
const historyRecordBase = (record: AgentMessageRecord) => ({
  messageId: `${record.agentSessionId}#${record.seq}`,
  createdAt: record.createdAt,
  ...(record.isPartial ? { isPartial: true } : {}),
});

/**
 * 单条记录投影（`tool_call` 记录由 `projectHistoryRecords` 按批合并，不经本函数）。
 *
 * `tool_result` 只在有配对调用、且该 id 尚未被投影过时产出 tool 消息；其余（无调用的结果、
 * 同 id 重复结果、非对话消息体）留痕丢弃（见 `projectHistoryRecords` 的不变量说明）。
 */
const projectHistoryRecord = (
  record: AgentMessageRecord,
  pairedToolCallIds: ReadonlySet<string>,
  answeredToolCallIds: Set<string>,
): InternalMessage | null => {
  const base = historyRecordBase(record);
  if (record.body.kind === 'chat') {
    return { ...base, role: record.role, content: record.body.content };
  }
  if (record.body.kind === 'tool_result') {
    const toolCallId = record.body.toolCallId;
    if (!pairedToolCallIds.has(toolCallId) || answeredToolCallIds.has(toolCallId)) {
      logDebug('[agent-execution] history tool_result skipped: no unique paired tool call', {
        agentSessionId: record.agentSessionId,
        seq: record.seq,
        toolCallId,
        hasToolCall: pairedToolCallIds.has(toolCallId),
      });
      return null;
    }
    answeredToolCallIds.add(toolCallId);
    const assetLine =
      record.body.assetIds.length > 0 ? `产物 assetId: ${record.body.assetIds.join(', ')}` : '';
    const errorLine = record.body.errorSummary ? `错误: ${record.body.errorSummary}` : '';
    return {
      ...base,
      role: 'tool',
      content: [`工具 ${record.body.toolName} ${record.body.status}`, record.body.summary, assetLine, errorLine]
        .filter(Boolean)
        .join('；'),
      toolCallId,
      toolName: record.body.toolName,
    };
  }
  logDebug('[agent-execution] history record skipped: non-chat message body', {
    agentSessionId: record.agentSessionId,
    seq: record.seq,
    kind: record.body.kind,
  });
  return null;
};

// ────────────────────────────────────────────
// 6. 项目作用域裁定
// ────────────────────────────────────────────

type ProjectScopeCheckResult =
  | { ok: true; openedProjectCount: number }
  | { ok: false; message: string; openedProjectCount: number };

/**
 * 裁定本次提交的项目作用域（读取正式历史必须的项目定位）。
 *
 * 作用域唯一来源是 payload 的 `projectPath`(contracts AgentSubmitPromptSchema)：不按原始 JSON
 * 之外的提示推断、不按「当前唯一已打开项目」猜测——猜错会静默读到别的会话历史。
 * 「已打开」的裁定权威是 Desktop Main 经 `runtime:project-scope-register/sync/unregister`
 * 同步的项目作用域注册表（project-media-scope）：editor 窗口打开项目时注册、关闭时注销、
 * backend 重启后全量重放。不查这套注册表以外的推断源。
 */
const checkOpenedProjectScope = (params: {
  requestId: string;
  agentSessionId: string;
  projectPath: string;
}): ProjectScopeCheckResult => {
  let openedPaths: unknown;
  try {
    openedPaths = getRegisteredProjectScopePaths();
  } catch (error: unknown) {
    logWarn('[agent-execution] opened project lookup failed', {
      requestId: params.requestId,
      agentSessionId: params.agentSessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      message: 'Opened project list is unavailable',
      openedProjectCount: 0,
    };
  }
  const openedProjects = Array.isArray(openedPaths)
    ? openedPaths.filter((item: unknown): item is string => typeof item === 'string' && item.length > 0)
    : [];
  if (!openedProjects.includes(params.projectPath)) {
    return {
      ok: false,
      message: 'projectPath is not an open project',
      openedProjectCount: openedProjects.length,
    };
  }
  return { ok: true, openedProjectCount: openedProjects.length };
};

/** 与 `extractRawChatRequestId` 同款的原始 JSON 字段读取（schema 之外的路由/归属信息）。 */
const readRawString = (raw: unknown, key: string): string => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return '';
  const value: unknown = Reflect.get(raw, key);
  return typeof value === 'string' ? value.trim() : '';
};

// ────────────────────────────────────────────
// 8. 测试导出
// ────────────────────────────────────────────

/**
 * 测试注入：`setCoreExecutorForTests` 替换语言推理底座，单测不得发真实请求、不得消耗真实费用。
 *
 * 项目作用域不设注入点：单测经 project-store 真实建立「已打开项目」状态，
 * 保证测的就是生产路径上的裁定逻辑。
 */
export const __test_only__ = {
  setCoreExecutorForTests: (executor: AgentCoreExecutor | null): void => {
    coreExecutor = executor ?? executeChatCompletionCore;
  },
  getInFlightRequestIdForTests: (agentSessionId: string): string | null =>
    inFlightBySession.get(agentSessionId)?.requestId ?? null,
  /** 待决提案登记（含批级超时定时器）：结算后必须为空，否则批级定时器仍在跑。 */
  getPendingToolDecisionIdsForTests,
  /** 批级提案超时时长注入（测试专用）；null 恢复 10 分钟产品语义。 */
  setToolProposalTimeoutMsForTests: (timeoutMs: number | null): void => {
    setToolProposalTimeoutMsForTests(timeoutMs);
  },
  clearForTests: (): void => {
    inFlightBySession.clear();
    coreExecutor = executeChatCompletionCore;
    setToolProposalTimeoutMsForTests(null);
  },
};
