// @spec: FTB-014
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import type { TaskStateNotification } from '@iart/contracts';

import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import { createNodeGraph } from '@/features/canvas/types/nodeGraph';
import type { TaskNodeData } from '@/features/canvas/types/node';
import { createTestNodeGraphParams } from '@/features/canvas/components/__tests__/fixtures/canvasTestBuilders';
import { useCanvasTaskIndexSync } from '../useCanvasTaskIndexSync';

/**
 * 通知链路消费「重新查询结果」的 failed → polling 复活（spec：docs/editor/
 * 失败任务重新查询-design.md §4.1）。
 *
 * 覆盖真实入口：IPC handler 注册 → 共享契约 TaskStateNotificationSchema 校验 →
 * applyTaskStateChanged → 任务投影 O(1) 更新。断言失败摘要、failure 与旧进度被清空，
 * 且节点身份不变（不新建节点/批次）。
 */

const GRAPH_ID = 'graph-requery-notification';
const TASK_ID = 'task-requery-notify';

type TaskStateChangedHandler = (message: unknown) => void;

let taskStateChangedHandler: TaskStateChangedHandler | null = null;

const buildElectronMock = () => ({
  onTaskStateChanged: vi.fn((handler: TaskStateChangedHandler) => {
    taskStateChangedHandler = handler;
  }),
  onTaskStateSnapshot: vi.fn(() => undefined),
  onMediaAssetsChanged: vi.fn(() => undefined),
  removeTaskStateListeners: vi.fn(() => {
    taskStateChangedHandler = null;
  }),
});

let electronMock: ReturnType<typeof buildElectronMock>;

/** 稳定回调：renderHook 每次渲染都新建函数会让 effect 反复重跑（无限渲染）。 */
const handleStatusChange = (): void => undefined;

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const resetStore = (): void => {
  useCanvasStore.setState((state) => {
    state.nodeGraph = null;
    state.mediaAssets = {};
    state.selectedNodeIds = [];
    state.selectedAnnotationIds = [];
    state.editingAnnotationId = null;
    state.history = [];
    state.historyIndex = -1;
    state.historyBatchActive = false;
    state.deferredHistoryBaseline = null;
    state.hasUnsavedChanges = false;
    state.ui.canvasContainerSize = null;
    state.ui.lastMeasuredSizeByNodeId = {};
    state.ui.layoutModelByNodeId = {};
  });
};

const setupFailedTaskNode = (): string => {
  const graph = createNodeGraph(createTestNodeGraphParams('requery-notification'));
  graph.id = GRAPH_ID;
  graph.viewport = { x: 0, y: 0, zoom: 1 };
  useCanvasStore.setState((state) => {
    state.nodeGraph = graph;
    state.mediaAssets = {};
    state.ui.canvasContainerSize = { width: 1440, height: 900 };
  });
  const node = useCanvasStore.getState().addNode(
    'task',
    { x: 320, y: 260 },
    {
      label: 'model-a',
      modelId: 'model-a',
      taskId: TASK_ID,
      taskIndex: 0,
      batchId: 'batch-requery-notify',
      status: 'failed',
      progressPercent: 55,
      progressPhase: 'polling',
      errorMessage: '查询超时',
      failure: {
        code: 'TASK_EXECUTION_FAILED',
        message: '查询超时',
        stage: 'polling_timeout',
      },
      remoteRequestId: 'remote-request-1',
      createdAt: 1,
      updatedAt: 1,
    } satisfies TaskNodeData,
  );
  if (!node) throw new Error('任务节点创建失败');
  return node.id;
};

const findTaskNode = (): { id: string; data: TaskNodeData } | null => {
  const graph = useCanvasStore.getState().nodeGraph;
  if (!graph) return null;
  const node = graph.nodes.find(
    (candidate) =>
      candidate.type === 'task' && (candidate.data as TaskNodeData).taskId === TASK_ID,
  );
  return node ? { id: node.id, data: node.data as TaskNodeData } : null;
};

const pollingNotification = (): TaskStateNotification => ({
  type: 'task:state-changed',
  projectPath: '/proj',
  task: {
    taskId: TASK_ID,
    status: 'polling',
    projectPath: '/proj',
    batchId: 'batch-requery-notify',
    remoteRequestId: 'remote-request-1',
    progressPercent: null,
    progressPhase: null,
    errorMessage: null,
    createdAt: 1,
    updatedAt: 2,
  },
  outputs: [],
  mediaAssets: [],
});

describe('useCanvasTaskIndexSync - 重新查询复活通知', () => {
  beforeEach(() => {
    resetStore();
    taskStateChangedHandler = null;
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
    vi.unstubAllGlobals();
  });

  it('failed → polling 通知驱动同一任务节点清空失败事实与旧进度', async () => {
    const nodeId = setupFailedTaskNode();

    const { unmount } = renderHook(() =>
      useCanvasTaskIndexSync(GRAPH_ID, {
        enabled: undefined,
        connectTimeoutMs: undefined,
        onStatusChange: handleStatusChange,
      }),
    );

    await act(async () => {
      await flush();
    });

    expect(taskStateChangedHandler).toBeTypeOf('function');

    await act(async () => {
      taskStateChangedHandler?.(pollingNotification());
      await flush();
    });

    const revived = findTaskNode();
    expect(revived).not.toBeNull();
    expect(revived?.id).toBe(nodeId);
    expect(revived?.data.status).toBe('polling');
    expect(revived?.data.failure).toBeNull();
    expect(revived?.data.errorMessage).toBeNull();
    expect(revived?.data.progressPercent).toBeNull();
    expect(revived?.data.progressPhase).toBeNull();
    expect(revived?.data.remoteRequestId).toBe('remote-request-1');

    await act(async () => {
      unmount();
      await flush();
    });
  });
});
