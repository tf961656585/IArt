import type { DynamicRecord } from '@/client/utils/typeGuards';

import {
  EDITOR_BACKEND_ACTION_CLASS,
  EDITOR_BACKEND_COMPAT,
  EDITOR_BACKEND_MESSAGE_TYPE,
  type EditorBackendBusinessResultEnvelope,
  type EditorBackendBusinessSubmitEnvelope,
} from '@iart/contracts/editor-backend-contract';
import { getRuntimeBackendBaseUrl } from '@/client/store/runtimeStore';

const normalizeString = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed || '';
};

const isLoopbackHostname = (value: string): boolean => {
  const normalized = value.trim().toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1';
};

export const buildBusinessActionSocketUrl = (): string | null => {
  const runtimeBase = normalizeString(getRuntimeBackendBaseUrl());
  const base = runtimeBase ? `${runtimeBase}${EDITOR_BACKEND_COMPAT.wsPath}` : '';
  if (!base) return null;

  try {
    const parsed = new URL(base);
    if (!isLoopbackHostname(parsed.hostname)) {
      return null;
    }
    parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
    parsed.pathname = EDITOR_BACKEND_COMPAT.wsPath;
    parsed.search = '';
    return parsed.toString();
  } catch {
    return null;
  }
};

const buildBusinessSocketUnavailableError = (message: string): Error => {
  const error = new Error(message) as Error & {
    code: string | undefined;
    body: { code: string; message: string } | undefined;
  };
  error.name = 'BusinessActionSocketUnavailableError';
  error.code = 'business_action_socket_unavailable';
  error.body = {
    code: 'business_action_socket_unavailable',
    message,
  };
  return error;
};

const buildBusinessActionError = (message: string, code = 'business_action_failed'): Error => {
  const error = new Error(message) as Error & {
    code: string | undefined;
    body: { code: string; message: string } | undefined;
  };
  error.name = 'BusinessActionError';
  error.code = code;
  error.body = { code, message };
  return error;
};

const buildBusinessActionTimeoutError = (value: {
  actionId: string;
  actionName: string;
  actionClass: string;
  timeoutMs: number;
  socketOpened: boolean;
  ackReceived: boolean;
  resultReceived: boolean;
  lastMessageType: string | null;
}): Error => {
  const actionName = normalizeString(value.actionName);
  const stage =
    actionName === 'session.open'
      ? 'session-attach'
      : actionName === 'presence.open' || actionName === 'presence.heartbeat' || actionName === 'presence.close'
        ? 'project-presence'
        : null;
  const message = 'Business action submit timeout';
  const error = new Error(message) as Error & {
    code: string | undefined;
    body: {
      code: string;
      message: string;
      detail: DynamicRecord | undefined;
      stage: string | undefined;
      source: string | undefined;
      action: string | undefined;
    } | undefined;
  };
  const detail = {
    actionId: value.actionId,
    actionName: value.actionName,
    actionClass: value.actionClass,
    timeoutMs: value.timeoutMs,
    socketOpened: value.socketOpened,
    ackReceived: value.ackReceived,
    resultReceived: value.resultReceived,
    lastMessageType: value.lastMessageType,
  };
  error.name = 'BusinessActionTimeoutError';
  error.code = 'business_action_submit_timeout';
  error.body = {
    code: 'business_action_submit_timeout',
    message,
    stage: stage ?? undefined,
    action: actionName || undefined,
    source: 'client',
    detail,
  };
  return error;
};

type BusinessActionMessage =
  | EditorBackendBusinessResultEnvelope
  | DynamicRecord;

type BusinessActionErrorPayload = {
  message: unknown | undefined;
  code: unknown | undefined;
};


const isRecord = (value: unknown): value is DynamicRecord =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const readRecordValue = (record: object, key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor !== undefined ? descriptor.value : undefined;
};

const readBusinessActionErrorPayload = (
  message: BusinessActionMessage,
): BusinessActionErrorPayload | null => {
  const value = readRecordValue(message, 'error');
  return isRecord(value)
    ? {
        message: readRecordValue(value, 'message'),
        code: readRecordValue(value, 'code'),
      }
    : null;
};

const parseJsonUnknown = (value: string): unknown => JSON.parse(value) as unknown;

const parseBusinessActionMessage = (value: string): BusinessActionMessage => {
  const parsed = parseJsonUnknown(value);
  if (!isRecord(parsed)) {
    throw new Error('Business action response is not an object');
  }
  return parsed;
};

const readMessageType = (message: BusinessActionMessage): string =>
  normalizeString(message.type);

const readMessageActionId = (message: BusinessActionMessage): string =>
  normalizeString(message.actionId);

const readBusinessError = (
  message: BusinessActionMessage,
): { message: string; code: string } | null => {
  const rawError = readBusinessActionErrorPayload(message);
  if (!rawError) return null;
  return {
    message: typeof rawError.message === 'string' ? rawError.message : 'Business action failed',
    code: typeof rawError.code === 'string' ? rawError.code : 'business_action_failed',
  };
};

const createBusinessSocketSubmitPromise = async <T>(value: {
  actionId: string;
  actionName: string;
  actionClass: (typeof EDITOR_BACKEND_ACTION_CLASS)[keyof typeof EDITOR_BACKEND_ACTION_CLASS];
  projectPath: string;
  nodeGraphId: string | null | undefined;
  payload: unknown;
  timeoutMs: number | undefined;
  onMessage: (
    payload: BusinessActionMessage,
    controls: { resolve: (value: T) => void; reject: (error: Error) => void },
  ) => void;
}): Promise<T> => {
  const actionId = normalizeString(value.actionId);
  const actionName = normalizeString(value.actionName);
  const projectPath = normalizeString(value.projectPath);
  if (!actionId || !actionName || !projectPath) {
    throw buildBusinessSocketUnavailableError('Business action submit requires actionId and projectPath');
  }
  const socketUrl = buildBusinessActionSocketUrl();
  if (!socketUrl) {
    throw buildBusinessSocketUnavailableError('Business action socket url unavailable');
  }
  if (typeof WebSocket === 'undefined') {
    throw buildBusinessSocketUnavailableError('WebSocket unavailable');
  }

  const submitPayload: EditorBackendBusinessSubmitEnvelope = {
    type: EDITOR_BACKEND_MESSAGE_TYPE.SUBMIT,
    actionId,
    actionName,
    actionClass: value.actionClass,
    projectPath,
    nodeGraphId: normalizeString(value.nodeGraphId) || null,
    payload: value.payload,
    requestedAt: new Date().toISOString(),
  };

  const timeoutMs =
    Number.isFinite(value.timeoutMs) && Number(value.timeoutMs) > 0 ? Number(value.timeoutMs) : 5000;

  return await new Promise<T>((resolve, reject) => {
    const ws = new WebSocket(socketUrl);
    let settled = false;
    let timerId: ReturnType<typeof setTimeout> | null = null;
    let socketOpened = false;
    let ackReceived = false;
    let resultReceived = false;
    let lastMessageType: string | null = null;

    const cleanup = () => {
      if (timerId) {
        clearTimeout(timerId);
        timerId = null;
      }
      try {
        ws.close();
      } catch {
        // ignore
      }
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const succeed = (payload: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(payload);
    };

    ws.addEventListener('open', () => {
      socketOpened = true;
      try {
        ws.send(JSON.stringify(submitPayload));
      } catch (error) {
        fail(error instanceof Error ? error : new Error('Business action send failed'));
      }
    });

    ws.addEventListener('message', (event) => {
      let parsed: BusinessActionMessage;
      try {
        parsed = parseBusinessActionMessage(String(event.data));
      } catch {
        fail(new Error('Business action response is not valid JSON'));
        return;
      }
      const messageType = readMessageType(parsed) || null;
      if (messageType) {
        lastMessageType = messageType;
      }
      if (readMessageActionId(parsed) === actionId) {
        if (messageType === EDITOR_BACKEND_MESSAGE_TYPE.ACK) {
          ackReceived = true;
        } else if (messageType === EDITOR_BACKEND_MESSAGE_TYPE.RESULT) {
          resultReceived = true;
        }
      }
      value.onMessage(parsed, { resolve: succeed, reject: fail });
    });

    ws.addEventListener('error', () => {
      fail(new Error('Business action socket error'));
    });

    ws.addEventListener('close', () => {
      if (!settled) {
        fail(new Error('Business action socket closed before ack'));
      }
    });

    timerId = setTimeout(() => {
      fail(
        buildBusinessActionTimeoutError({
          actionId,
          actionName,
          actionClass: value.actionClass,
          timeoutMs,
          socketOpened,
          ackReceived,
          resultReceived,
          lastMessageType,
        }),
      );
    }, timeoutMs);
  });
};

type BusinessSyncActionDefaults = {
  actionId: string;
  actionName: string;
  projectPath: string;
  nodeGraphId: string | null | undefined;
  payload: unknown;
  timeoutMs: number | undefined;
};

export type BusinessSyncActionInput = Pick<BusinessSyncActionDefaults, 'actionId' | 'actionName' | 'projectPath' | 'payload'> &
  Partial<Omit<BusinessSyncActionDefaults, 'actionId' | 'actionName' | 'projectPath' | 'payload'>>;

export const submitBusinessSyncAction = async <TResult = unknown>(value: BusinessSyncActionInput): Promise<EditorBackendBusinessResultEnvelope & { result: TResult }> =>
  createBusinessSocketSubmitPromise({
    actionId: value.actionId,
    actionName: value.actionName,
    projectPath: value.projectPath,
    nodeGraphId: value.nodeGraphId,
    payload: value.payload,
    timeoutMs: value.timeoutMs,
    actionClass: EDITOR_BACKEND_ACTION_CLASS.BUSINESS_SYNC,
    onMessage: (parsed, controls) => {
      if (readMessageActionId(parsed) !== value.actionId) {
        return;
      }
      if (readMessageType(parsed) === EDITOR_BACKEND_MESSAGE_TYPE.RESULT) {
        const error = readBusinessError(parsed);
        if (error) {
          controls.reject(buildBusinessActionError(error.message, error.code));
          return;
        }
        controls.resolve(parsed as EditorBackendBusinessResultEnvelope & { result: TResult });
      }
    },
  });
