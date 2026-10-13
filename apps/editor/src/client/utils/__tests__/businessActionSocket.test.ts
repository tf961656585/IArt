import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EDITOR_BACKEND_MESSAGE_TYPE,
} from '@iart/contracts/editor-backend-contract';

const getRuntimeBackendBaseUrlMock = vi.fn();

vi.mock('@/client/store/runtimeStore', () => ({
  getRuntimeBackendBaseUrl: getRuntimeBackendBaseUrlMock,
}));

type SubmitEnvelopePayload = {
  actionId: string;
  actionName: string;
  actionClass: string;
  projectPath: string;
  nodeGraphId?: string | null;
};

type AckEnvelopePayload = SubmitEnvelopePayload & {
  type: string;
  accepted: boolean;
  taskId?: string;
  emittedAt: number;
};

type ResultEnvelopePayload = SubmitEnvelopePayload & {
  type: string;
  result?: unknown;
  emittedAt: number;
};

type SocketEventType = 'open' | 'message' | 'close' | 'error';
type SocketEvent = Event | CloseEvent | MessageEvent<string>;
type SocketListener = (event: SocketEvent) => void;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isSubmitEnvelopePayload = (value: unknown): value is SubmitEnvelopePayload => {
  if (!isRecord(value)) return false;
  return (
    typeof value['actionId'] === 'string'
    && typeof value['actionName'] === 'string'
    && typeof value['actionClass'] === 'string'
    && typeof value['projectPath'] === 'string'
  );
};

const parseSubmitPayload = (raw: string): SubmitEnvelopePayload => {
  const parsed: unknown = JSON.parse(raw);
  if (!isSubmitEnvelopePayload(parsed)) {
    throw new Error('invalid submit payload in test');
  }
  return parsed;
};

class TypedMockWebSocket {
  static instances: TypedMockWebSocket[] = [];
  static OPEN = 1;
  readonly listeners: Record<SocketEventType, Set<SocketListener>> = {
    open: new Set(),
    message: new Set(),
    close: new Set(),
    error: new Set(),
  };
  readyState = TypedMockWebSocket.OPEN;

  constructor(public readonly url: string) {
    TypedMockWebSocket.instances.push(this);
    queueMicrotask(() => this.emit('open', new Event('open')));
  }

  addEventListener(type: SocketEventType, handler: SocketListener): void {
    this.listeners[type].add(handler);
  }

  send(_raw: string): void {}

  close(): void {
    this.emit('close', new CloseEvent('close'));
  }

  protected emit(type: SocketEventType, event: SocketEvent): void {
    for (const handler of this.listeners[type]) {
      handler(event);
    }
  }

  protected emitAck(payload: AckEnvelopePayload): void {
    this.emit(
      'message',
      new MessageEvent<string>('message', {
        data: JSON.stringify(payload),
      }),
    );
  }

  protected emitResult(payload: ResultEnvelopePayload): void {
    this.emit(
      'message',
      new MessageEvent<string>('message', {
        data: JSON.stringify(payload),
      }),
    );
  }
}

class MockAckThenResultWebSocket extends TypedMockWebSocket {
  override send(raw: string): void {
    const payload = parseSubmitPayload(raw);
    queueMicrotask(() =>
      this.emitAck({
        type: EDITOR_BACKEND_MESSAGE_TYPE.ACK,
        actionId: payload.actionId,
        actionName: payload.actionName,
        actionClass: payload.actionClass,
        accepted: true,
        projectPath: payload.projectPath,
        ...(payload.nodeGraphId !== undefined ? { nodeGraphId: payload.nodeGraphId } : {}),
        emittedAt: Date.now(),
      }),
    );
    queueMicrotask(() =>
      this.emitResult({
        type: EDITOR_BACKEND_MESSAGE_TYPE.RESULT,
        actionId: payload.actionId,
        actionName: payload.actionName,
        actionClass: payload.actionClass,
        projectPath: payload.projectPath,
        ...(payload.nodeGraphId !== undefined ? { nodeGraphId: payload.nodeGraphId } : {}),
        result: { url: '/files/demo.png' },
        emittedAt: Date.now(),
      }),
    );
  }
}

class MockAckOnlyWebSocket extends TypedMockWebSocket {
  override send(raw: string): void {
    const payload = parseSubmitPayload(raw);
    queueMicrotask(() =>
      this.emitAck({
        type: EDITOR_BACKEND_MESSAGE_TYPE.ACK,
        actionId: payload.actionId,
        actionName: payload.actionName,
        actionClass: payload.actionClass,
        accepted: true,
        projectPath: payload.projectPath,
        emittedAt: Date.now(),
      }),
    );
  }
}

const installMockWebSocket = (SocketCtor: typeof TypedMockWebSocket): void => {
  SocketCtor.instances = [];
  vi.stubGlobal('WebSocket', SocketCtor);
};

describe('businessActionSocket', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    TypedMockWebSocket.instances = [];
    getRuntimeBackendBaseUrlMock.mockReturnValue('http://127.0.0.1:4100');
  });

  it('本地 Hub 已解析时，返回本地 business websocket 地址', async () => {
    const { buildBusinessActionSocketUrl } = await import('../businessActionSocket');

    expect(buildBusinessActionSocketUrl()).toBe('ws://127.0.0.1:4100/ws/business');
  });

  it('submitBusinessSyncAction 收到 result 后返回业务结果', async () => {
    installMockWebSocket(MockAckThenResultWebSocket);
    const { submitBusinessSyncAction } = await import('../businessActionSocket');

    const result = await submitBusinessSyncAction<{ url: string }>({
      actionId: 'action-sync-1',
      actionName: 'media.upload',
      projectPath: '/tmp/demo.iartproj',
      payload: {
        mode: 'project_local',
      },
    });

    expect(TypedMockWebSocket.instances[0]?.url).toBe('ws://127.0.0.1:4100/ws/business');
    expect(result.actionId).toBe('action-sync-1');
    expect(result.result.url).toBe('/files/demo.png');
  });

  it('桌面 bootstrap 缺失 backend base 时返回 null，而不是猜 localhost', async () => {
    getRuntimeBackendBaseUrlMock.mockReturnValue(null);
    const { buildBusinessActionSocketUrl } = await import('../businessActionSocket');

    expect(buildBusinessActionSocketUrl()).toBeNull();
  });

  it('submitBusinessSyncAction 超时时应携带 ACK/RESULT 观测字段', async () => {
    installMockWebSocket(MockAckOnlyWebSocket);
    const { submitBusinessSyncAction } = await import('../businessActionSocket');

    let caught: unknown;
    try {
      await submitBusinessSyncAction({
        actionId: 'action-timeout-1',
        actionName: 'session.open',
        projectPath: '/tmp/demo.iartproj',
        payload: {},
        timeoutMs: 10,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const timeoutError = caught as Error & {
      code?: string;
      body?: {
        code?: string;
        detail?: {
          ackReceived?: boolean;
          resultReceived?: boolean;
          socketOpened?: boolean;
          actionName?: string;
        };
      };
    };
    expect(timeoutError.message).toBe('Business action submit timeout');
    expect(timeoutError.code).toBe('business_action_submit_timeout');
    expect(timeoutError.body?.code).toBe('business_action_submit_timeout');
    expect(timeoutError.body?.detail?.ackReceived).toBe(true);
    expect(timeoutError.body?.detail?.resultReceived).toBe(false);
    expect(timeoutError.body?.detail?.socketOpened).toBe(true);
    expect(timeoutError.body?.detail?.actionName).toBe('session.open');
  });
});
