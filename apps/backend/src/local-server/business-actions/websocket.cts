import type * as http from "node:http";

import { attachPathWebSocketServer } from "../ws-upgrade-router.cts";
import {
  CHAT_WS_MESSAGE_TYPE,
  ChatClientMessageSchema,
} from "@iart/contracts";
import {
  type BusinessClient,
  type BusinessWebSocket,
  asRecord,
  EDITOR_BACKEND_ACTION_CLASS,
  EDITOR_BACKEND_COMPAT,
  isRecord,
  normalizeBusinessError,
  normalizeEditorBackendBusinessSubmit,
} from "./common.cts";
import { executeBusinessSyncAction } from "./sync-actions.cts";
import {
  buildBusinessErrorPayload,
  buildBusinessSyncAckPayload,
  buildBusinessSyncResultPayload,
  businessClients,
  sendJson,
} from "./events.cts";
import {
  executeTemporaryChatCompletion,
} from "../chat-temporary-completion.cts";
import { handleAgentMessage } from "../agent-execution.cts";
import { logWarn } from "../logging.cts";

export const BUSINESS_WS_PATH = EDITOR_BACKEND_COMPAT.wsPath;
type BusinessActionWebSocketServer = {
  on: (event: "connection", listener: (ws: BusinessWebSocket) => void) => void;
};
export const attachBusinessActionWebSocketServer = (server: unknown) => {
  const wss = attachPathWebSocketServer(
    server as http.Server<
      typeof http.IncomingMessage,
      typeof http.ServerResponse
    >,
    BUSINESS_WS_PATH,
  ) as BusinessActionWebSocketServer;
  wss.on("connection", (ws: BusinessWebSocket) => {
    const client: BusinessClient = {
      ws,
      actionIds: new Set(),
      taskIds: new Set(),
      closed: false,
    };
    businessClients.add(client);
    const cleanup = () => {
      client.closed = true;
      businessClients.delete(client);
    };
    ws.on("message", async (raw: unknown) => {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(String(raw));
      } catch {
        sendJson(
          ws,
          buildBusinessErrorPayload(
            null,
            "invalid_json",
            "Invalid business submit payload",
          ),
        );
        return;
      }

      // Chat messages use discriminated union with type field
      const parsedRecord = asRecord(parsed);
      const messageType = typeof (parsedRecord !== null && parsedRecord !== undefined ? parsedRecord.type : undefined) === 'string' ? (parsedRecord as { type: string }).type : '';
      if (messageType.startsWith('chat:')) {
        handleChatMessage(client, parsed);
        return;
      }

      // Agent messages use their own discriminated union (agent:*)，不复用 chat 通道
      if (messageType.startsWith('agent:')) {
        handleAgentMessage(client, parsed);
        return;
      }

      // Standard business action envelope
      const submit = normalizeEditorBackendBusinessSubmit(parsed, null);
      if (!submit) {
        sendJson(
          ws,
          buildBusinessErrorPayload(
            parsed,
            "invalid_submit",
            "Invalid business submit envelope",
          ),
        );
        return;
      }
      const submitRecord = asRecord(submit);
      if (
        submitRecord.actionClass === EDITOR_BACKEND_ACTION_CLASS.BUSINESS_SYNC
      ) {
        sendJson(ws, buildBusinessSyncAckPayload(submit));
        try {
          const execution = asRecord(await executeBusinessSyncAction(submit));
          if (execution.ok !== true) {
            sendJson(
              ws,
              buildBusinessErrorPayload(
                submit,
                execution.code || "business_action_failed",
                execution.message || "Business action failed",
                isRecord(execution.detail)
                  ? { detail: execution.detail }
                  : null,
              ),
            );
            return;
          }
          sendJson(
            ws,
            buildBusinessSyncResultPayload(submit, execution.result),
          );
        } catch (error) {
          const normalizedError = normalizeBusinessError(error);
          sendJson(
            ws,
            buildBusinessErrorPayload(
              submit,
              normalizedError.code,
              normalizedError.message,
            ),
          );
        }
        return;
      }
      sendJson(
        ws,
        buildBusinessErrorPayload(
          submit,
          "unsupported_action",
          "WS business-action does not create tasks. Use HTTP POST /api/tasks.",
        ),
      );
      return;
    });
    ws.on("close", cleanup);
    ws.on("error", cleanup);
  });
  return wss;
};

function handleChatMessage(client: BusinessClient, raw: unknown): void {
  const rawRequestId = extractRawChatRequestId(raw);
  const parseResult = ChatClientMessageSchema.safeParse(raw);
  if (!parseResult.success) {
    logWarn('chat websocket message parse failed', {
      requestId: rawRequestId,
      error: parseResult.error.message,
    });
    sendJson(client.ws, {
      type: CHAT_WS_MESSAGE_TYPE.TEMPORARY_ERROR,
      requestId: rawRequestId,
      error: `Invalid chat message: ${parseResult.error.message}`,
    });
    return;
  }

  const msg = parseResult.data;

  switch (msg.type) {
    case CHAT_WS_MESSAGE_TYPE.TEMPORARY_COMPLETION:
      executeTemporaryChatCompletion({
        client,
        requestId: msg.requestId,
        modelId: msg.modelId,
        systemPromptText: msg.systemPrompt ?? undefined,
        messages: msg.messages,
        userParams: msg.userParams ?? {},
        thinkingTier: msg.thinkingTier,
      });
      break;
  }
}

function extractRawChatRequestId(raw: unknown): string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return '';
  }
  const requestId: unknown = Reflect.get(raw, 'requestId');
  return typeof requestId === 'string' ? requestId : '';
}
