export type MockBusinessActionPayload = {
  type?: string;
  actionId: string;
  actionName: string;
  actionClass: string;
  projectPath: string;
  nodeGraphId: string | null;
  payload: Record<string, unknown>;
  requestedAt?: string;
};

type MockSocketEvent = { data: string };
type MockSocketListener = (event?: MockSocketEvent) => void;

type MockBusinessResult = Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const readString = (record: Record<string, unknown>, key: string): string => {
  const value = record[key];
  return typeof value === 'string' ? value : '';
};

const parseSubmitPayload = (raw: string): MockBusinessActionPayload => {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) throw new Error('mock business submit payload is not object');
  const payload = parsed['payload'];
  const type = readString(parsed, 'type');
  return {
    ...(type ? { type } : {}),
    actionId: readString(parsed, 'actionId'),
    actionName: readString(parsed, 'actionName'),
    actionClass: readString(parsed, 'actionClass'),
    projectPath: readString(parsed, 'projectPath'),
    nodeGraphId: typeof parsed['nodeGraphId'] === 'string' ? parsed['nodeGraphId'] : null,
    payload: isRecord(payload) ? payload : {},
    ...(readString(parsed, 'requestedAt') ? { requestedAt: readString(parsed, 'requestedAt') } : {}),
  };
};

export class MockBusinessActionWebSocket {
  static instances: MockBusinessActionWebSocket[] = [];
  static OPEN = 1;
  static resolveResult: (payload: MockBusinessActionPayload) => MockBusinessResult = () => ({ success: true });

  readyState = MockBusinessActionWebSocket.OPEN;
  listeners = new Map<string, Set<MockSocketListener>>();
  sentPayloads: MockBusinessActionPayload[] = [];

  constructor(public readonly url: string) {
    MockBusinessActionWebSocket.instances.push(this);
    queueMicrotask(() => this.emit('open'));
  }

  static reset(resolveResult?: (payload: MockBusinessActionPayload) => MockBusinessResult): void {
    MockBusinessActionWebSocket.instances = [];
    MockBusinessActionWebSocket.resolveResult = resolveResult ?? (() => ({ success: true }));
  }

  addEventListener(type: string, handler: MockSocketListener): void {
    const set = this.listeners.get(type) ?? new Set<MockSocketListener>();
    set.add(handler);
    this.listeners.set(type, set);
  }

  send(raw: string): void {
    const payload = parseSubmitPayload(raw);
    this.sentPayloads.push(payload);
    queueMicrotask(() =>
      this.emit('message', {
        data: JSON.stringify({
          type: 'editor_backend_business_ack',
          actionId: payload.actionId,
          actionName: payload.actionName,
          actionClass: payload.actionClass,
          accepted: true,
          projectPath: payload.projectPath,
          nodeGraphId: payload.nodeGraphId,
          emittedAt: Date.now(),
        }),
      }),
    );
    queueMicrotask(() =>
      this.emit('message', {
        data: JSON.stringify({
          type: 'editor_backend_business_result',
          actionId: payload.actionId,
          actionName: payload.actionName,
          actionClass: payload.actionClass,
          projectPath: payload.projectPath,
          nodeGraphId: payload.nodeGraphId,
          result: MockBusinessActionWebSocket.resolveResult(payload),
          emittedAt: Date.now(),
        }),
      }),
    );
  }

  close(): void {
    this.emit('close');
  }

  emit(type: string, event?: MockSocketEvent): void {
    for (const handler of this.listeners.get(type) ?? []) {
      handler(event);
    }
  }
}
