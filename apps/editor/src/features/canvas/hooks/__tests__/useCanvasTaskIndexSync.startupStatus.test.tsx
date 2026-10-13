import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useCanvasTaskIndexSync } from '../useCanvasTaskIndexSync';

vi.mock('@/client/utils/apiConfig', () => ({
  resolveApiEndpoint: vi.fn((value: string) => value),
}));

type TaskStateChangedHandler = (message: unknown) => void;
type TaskStateSnapshotHandler = (message: unknown) => void;

type ElectronTaskListenerMock = {
  onTaskStateChanged: ReturnType<typeof vi.fn<TaskStateChangedHandler>>;
  onTaskStateSnapshot: ReturnType<typeof vi.fn<TaskStateSnapshotHandler>>;
  removeTaskStateListeners: ReturnType<typeof vi.fn<() => void>>;
};

let taskStateChangedHandler: TaskStateChangedHandler | null = null;
let taskStateSnapshotHandler: TaskStateSnapshotHandler | null = null;
let electronMock: ElectronTaskListenerMock;

const buildElectronMock = (): ElectronTaskListenerMock => ({
  onTaskStateChanged: vi.fn((handler: TaskStateChangedHandler) => {
    taskStateChangedHandler = handler;
  }),
  onTaskStateSnapshot: vi.fn((handler: TaskStateSnapshotHandler) => {
    taskStateSnapshotHandler = handler;
  }),
  removeTaskStateListeners: vi.fn(() => {
    taskStateChangedHandler = null;
    taskStateSnapshotHandler = null;
  }),
});

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('useCanvasTaskIndexSync - startup status', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    taskStateChangedHandler = null;
    taskStateSnapshotHandler = null;
    electronMock = buildElectronMock();
    const windowEvents = new EventTarget();
    vi.stubGlobal('window', {
      addEventListener: windowEvents.addEventListener.bind(windowEvents),
      removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
      dispatchEvent: windowEvents.dispatchEvent.bind(windowEvents),
      electron: electronMock,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('缺少 graph id 时保持 idle，且不会注册 IPC listener', async () => {
    const statuses: string[] = [];
    const handleStatusChange = (status: { level: string | null; code: string | null }) => {
      statuses.push(`${status.level}:${status.code}`);
    };

    const { result, unmount } = renderHook(() =>
      useCanvasTaskIndexSync(null, {
        enabled: undefined,
        connectTimeoutMs: undefined,
        onStatusChange: handleStatusChange,
      }),
    );

    await act(async () => {
      await flush();
    });

    expect(result.current).toMatchObject({ level: 'idle', code: null });
    expect(statuses).toContain('idle:null');
    expect(electronMock.onTaskStateChanged).not.toHaveBeenCalled();
    expect(electronMock.onTaskStateSnapshot).not.toHaveBeenCalled();

    await act(async () => {
      unmount();
      await flush();
    });
  });

  it('显式禁用时保持 idle，且不会注册 IPC listener', async () => {
    const statuses: string[] = [];
    const handleStatusChange = (status: { level: string | null; code: string | null }) => {
      statuses.push(`${status.level}:${status.code}`);
    };

    const { result, unmount } = renderHook(() =>
      useCanvasTaskIndexSync('graph-disabled', {
        enabled: false,
        connectTimeoutMs: undefined,
        onStatusChange: handleStatusChange,
      }),
    );

    await act(async () => {
      await flush();
    });

    expect(result.current).toMatchObject({ level: 'idle', code: null });
    expect(statuses).toContain('idle:null');
    expect(electronMock.onTaskStateChanged).not.toHaveBeenCalled();
    expect(electronMock.onTaskStateSnapshot).not.toHaveBeenCalled();

    await act(async () => {
      unmount();
      await flush();
    });
  });

  it('启用时进入 connected，并注册 task state IPC listeners', async () => {
    const statuses: string[] = [];
    const handleStatusChange = (status: { level: string | null; code: string | null }) => {
      statuses.push(`${status.level}:${status.code}`);
    };

    const { result, unmount } = renderHook(() =>
      useCanvasTaskIndexSync('graph-connected', {
        enabled: undefined,
        connectTimeoutMs: undefined,
        onStatusChange: handleStatusChange,
      }),
    );

    await act(async () => {
      await flush();
    });

    expect(result.current).toMatchObject({ level: 'connected', code: null });
    expect(statuses).toContain('connected:null');
    expect(electronMock.onTaskStateChanged).toHaveBeenCalledTimes(1);
    expect(electronMock.onTaskStateSnapshot).toHaveBeenCalledTimes(1);
    expect(taskStateChangedHandler).toBeTypeOf('function');
    expect(taskStateSnapshotHandler).toBeTypeOf('function');

    await act(async () => {
      unmount();
      await flush();
    });
  });

  it('卸载时移除 task state IPC listeners', async () => {
    const { unmount } = renderHook(() => useCanvasTaskIndexSync('graph-cleanup', undefined));

    await act(async () => {
      await flush();
    });

    expect(taskStateChangedHandler).toBeTypeOf('function');
    expect(taskStateSnapshotHandler).toBeTypeOf('function');

    await act(async () => {
      unmount();
      await flush();
    });

    expect(electronMock.removeTaskStateListeners).toHaveBeenCalledTimes(1);
    expect(taskStateChangedHandler).toBeNull();
    expect(taskStateSnapshotHandler).toBeNull();
  });
});
