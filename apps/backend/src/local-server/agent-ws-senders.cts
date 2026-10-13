/**
 * Agent WS 事件发送器（spec 04「会话发送主链」的 agent:* 服务端事件）。
 *
 * 独立的发送器模块：`agent-execution.cts`（会话发送主链）与 `agent-tool-loop.cts`（工具调用
 * 循环编排）都只经这里发出 agent:* 事件，避免两处各写一遍载荷拼装，也避免发送器与编排模块
 * 相互 import 成环。载荷形状由 contracts 的 `AgentServerMessageSchema` 系列承载。
 */

import {
  AGENT_WS_MESSAGE_TYPE,
  type AgentAccepted,
  type AgentAssistantMessageEvent,
  type AgentComplete,
  type AgentError,
  type AgentToken,
  type AgentToolCallEvent,
  type AgentToolResultEvent,
  type AgentWsErrorCode,
  type ChatMessageContent,
} from '@iart/contracts';

import type { BusinessClient } from './business-actions/common.cts';
import { sendJson } from './business-actions/events.cts';

const sendAgentAccepted = (client: BusinessClient, payload: Omit<AgentAccepted, 'type'>): void => {
  const accepted: AgentAccepted = { type: AGENT_WS_MESSAGE_TYPE.ACCEPTED, ...payload };
  sendJson(client.ws, accepted);
};

const sendAgentToken = (client: BusinessClient, payload: Omit<AgentToken, 'type'>): void => {
  const token: AgentToken = { type: AGENT_WS_MESSAGE_TYPE.TOKEN, ...payload };
  sendJson(client.ws, token);
};

const sendAgentComplete = (client: BusinessClient, payload: Omit<AgentComplete, 'type'>): void => {
  const complete: AgentComplete = { type: AGENT_WS_MESSAGE_TYPE.COMPLETE, ...payload };
  sendJson(client.ws, complete);
};

const sendAgentAssistantMessage = (
  client: BusinessClient,
  payload: Omit<AgentAssistantMessageEvent, 'type'>,
): void => {
  const event: AgentAssistantMessageEvent = {
    type: AGENT_WS_MESSAGE_TYPE.ASSISTANT_MESSAGE,
    ...payload,
  };
  sendJson(client.ws, event);
};

const sendAgentToolCall = (
  client: BusinessClient,
  payload: Omit<AgentToolCallEvent, 'type'>,
): void => {
  const event: AgentToolCallEvent = { type: AGENT_WS_MESSAGE_TYPE.TOOL_CALL, ...payload };
  sendJson(client.ws, event);
};

const sendAgentToolResult = (
  client: BusinessClient,
  payload: Omit<AgentToolResultEvent, 'type'>,
): void => {
  const event: AgentToolResultEvent = { type: AGENT_WS_MESSAGE_TYPE.TOOL_RESULT, ...payload };
  sendJson(client.ws, event);
};

const sendAgentError = (
  client: BusinessClient,
  payload: {
    requestId: string;
    agentSessionId: string;
    code: AgentWsErrorCode;
    message: string;
    partialContent: ChatMessageContent | null;
  },
): void => {
  const errorPayload: AgentError = {
    type: AGENT_WS_MESSAGE_TYPE.ERROR,
    requestId: payload.requestId,
    agentSessionId: payload.agentSessionId,
    code: payload.code,
    message: payload.message,
    partialContent: payload.partialContent,
  };
  sendJson(client.ws, errorPayload);
};

export {
  sendAgentAccepted,
  sendAgentToken,
  sendAgentComplete,
  sendAgentAssistantMessage,
  sendAgentToolCall,
  sendAgentToolResult,
  sendAgentError,
};
