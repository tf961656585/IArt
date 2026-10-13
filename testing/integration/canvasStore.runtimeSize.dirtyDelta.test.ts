import { beforeEach, describe, expect, it } from 'vitest';

import { buildProjectDelta, useCanvasStore } from '@/features/canvas/store/canvasStore';
import { createNodeGraph } from '@/features/canvas/types/nodeGraph';

const resetStore = () => {
  useCanvasStore.setState((state) => {
    state.nodeGraph = null;
    state.selectedNodeIds = [];
    state.selectedEdgeIds = [];
    state.selectedAnnotationIds = [];
    state.editingAnnotationId = null;
    state.pendingAnnotationBinding = null;
    state.isDragging = false;
    state.isConnecting = false;
    state.connectionSnap = null;
    state.portQuickAddRequest = null;
    state.history = [];
    state.historyIndex = -1;
    state.hasUnsavedChanges = false;
    state.dirtyRevision = 0;
    state.defaultEdgeType = 'bezier';
    state.structureRevision = 0;
    state.taskRevision = 0;
    state.positionRevision = 0;
    state.viewportRevision = 0;
    state.layoutRevision = 0;
    state.clipboardPayload = null;
    state.ui.desiredSizeByNodeId = {};
  });
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  isRecord(value) ? value : null;

const findNodeById = (value: unknown, nodeId: string): Record<string, unknown> | null => {
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    if (isRecord(item) && item['id'] === nodeId) {
      return item;
    }
  }
  return null;
};

describe('canvasStore runtime size dirty delta', () => {
  const commitDeclaredSize = (nodeId: string, size: { width: number; height: number }, semanticKey: string) => {
    useCanvasStore.getState().submitNodeSizeProposal({
      nodeId,
      source: 'resultAreaAutoScale',
      semanticKey,
      desiredSize: size,
      priority: 80,
      reason: 'test:runtime-size-delta',
    });
    useCanvasStore.getState().acceptDesiredSize(nodeId);
  };

  beforeEach(() => {
    resetStore();
  });

  it('仅 committed declared size 后 buildProjectDelta 应返回 null', () => {
    const graph = createNodeGraph({ name: '测试画板' });
    graph.id = 'graph-runtime-size-delta-null';
    graph.meta = { ...(graph.meta ?? {}), updatedAt: '2020-01-01T00:00:00.000Z' };
    graph.nodes = [
      {
        id: 'node-1',
        type: 'textInput',
        position: { x: 0, y: 0 },
        data: { label: 'size-check' },
        inputs: [],
        outputs: [],
      },
    ];

    useCanvasStore.setState((state) => {
      state.nodeGraph = graph;
      state.hasUnsavedChanges = false;
      state.dirtyRevision = 0;
      state.structureRevision = 0;
    });

    commitDeclaredSize('node-1', { width: 320, height: 180 }, 'semantic-delta-null');

    const snapshot = useCanvasStore.getState();
    const { delta } = buildProjectDelta(snapshot);

    expect(snapshot.ui.desiredSizeByNodeId['node-1']?.size).toEqual({ width: 320, height: 180 });
    expect(snapshot.hasUnsavedChanges).toBe(false);
    expect(delta).toBeNull();
  });

  it('先提交 declared size 再 updateNodeData，delta 仅包含真实业务变更', () => {
    const graph = createNodeGraph({ name: '测试画板' });
    graph.id = 'graph-runtime-size-then-data';
    graph.meta = { ...(graph.meta ?? {}), updatedAt: '2020-01-01T00:00:00.000Z' };
    graph.nodes = [
      {
        id: 'node-1',
        type: 'textInput',
        position: { x: 0, y: 0 },
        data: { label: '旧标签' },
        inputs: [],
        outputs: [],
      },
    ];

    useCanvasStore.setState((state) => {
      state.nodeGraph = graph;
      state.hasUnsavedChanges = false;
      state.dirtyRevision = 0;
      state.structureRevision = 0;
    });

    commitDeclaredSize('node-1', { width: 360, height: 220 }, 'semantic-delta-then-data');
    useCanvasStore.getState().updateNodeData('node-1', { label: '新标签' }, 'test:business-change');

    const snapshot = useCanvasStore.getState();
    const { delta } = buildProjectDelta(snapshot);

    expect(snapshot.hasUnsavedChanges).toBe(true);
    expect(delta).not.toBeNull();
    expect(delta?.nodes?.upsert?.some((node) => node.id === 'node-1')).toBe(true);

    const node = findNodeById(delta?.nodes?.upsert, 'node-1');
    const nodeData = asRecord(node?.['data']);
    expect(nodeData?.['label']).toBe('新标签');
    expect(node?.['size']).toBeUndefined();
    expect(node?.['measuredSize']).toBeUndefined();
  });

  it('load 边界剥离目标态节点的旧持久化运行时布局字段（size / measuredSize / sizeMode）', async () => {
    const graph = createNodeGraph({ name: '测试画板' });
    graph.id = 'graph-load-strip-legacy-layout';
    graph.meta = {
      ...(graph.meta ?? {}),
      schemaVersion: 2,
      updatedAt: '2020-01-01T00:00:00.000Z',
    };
    graph.nodes = [
      {
        id: 'node-1',
        type: 'task',
        position: { x: 0, y: 0 },
        data: {
          label: '任务节点',
          modelId: 'gemini-3-pro-image',
          taskId: 'task-1',
          taskIndex: 0,
          batchId: 'batch-1',
          status: 'succeeded',
          progressPercent: null,
          progressPhase: null,
          errorMessage: null,
          failure: null,
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
          sizeMode: 'auto',
        },
        size: { width: 420, height: 360 },
        measuredSize: { width: 420, height: 360 },
        inputs: [],
        outputs: [],
      },
    ];

    await useCanvasStore.getState().loadNodeGraph(graph);

    const snapshot = useCanvasStore.getState();
    const node = findNodeById(snapshot.nodeGraph?.nodes, 'node-1');
    const nodeData = asRecord(node?.['data']);
    expect(nodeData).not.toBeNull();
    expect(node?.['size']).toBeUndefined();
    expect(node?.['measuredSize']).toBeUndefined();
    expect(nodeData?.['sizeMode']).toBeUndefined();
  });

  it('load 边界不触碰无旧布局字段的目标态节点 data', async () => {
    const graph = createNodeGraph({ name: '测试画板' });
    graph.id = 'graph-load-keep-clean-task-data';
    graph.nodes = [
      {
        id: 'node-1',
        type: 'task',
        position: { x: 0, y: 0 },
        data: {
          label: '任务节点',
          modelId: 'gemini-3-pro-image',
          taskId: 'task-1',
          taskIndex: 0,
          batchId: 'batch-1',
          status: 'succeeded',
          progressPercent: null,
          progressPhase: null,
          errorMessage: null,
          failure: null,
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
        },
        inputs: [],
        outputs: [],
      },
    ];

    await useCanvasStore.getState().loadNodeGraph(graph);

    const snapshot = useCanvasStore.getState();
    const node = findNodeById(snapshot.nodeGraph?.nodes, 'node-1');
    const nodeData = asRecord(node?.['data']);
    expect(nodeData?.['label']).toBe('任务节点');
    expect(nodeData?.['resultAreaAutoLayoutState']).toBeUndefined();
  });

  it('loadNodeGraph 后应清空 desiredSizeByNodeId，保证重启链路从首帧单列重新判定', async () => {
    const graph = createNodeGraph({ name: '测试画板' });
    graph.id = 'graph-runtime-size-reset';
    graph.nodes = [
      {
        id: 'node-1',
        type: 'task',
        position: { x: 0, y: 0 },
        data: {
          label: '任务节点',
          modelId: 'gemini-3-pro-image',
          taskId: 'task-1',
          taskIndex: 0,
          batchId: 'batch-1',
          status: 'succeeded',
          progressPercent: null,
          progressPhase: null,
          errorMessage: null,
          failure: null,
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
        },
        inputs: [],
        outputs: [],
      },
    ];

    useCanvasStore.setState((state) => {
      state.ui.desiredSizeByNodeId = {
        'node-1': { size: { width: 520, height: 380 }, state: 'accepted', semanticKey: 'test-load-clear' },
      };
    });

    await useCanvasStore.getState().loadNodeGraph(graph);
    const snapshot = useCanvasStore.getState();
    expect(snapshot.ui.desiredSizeByNodeId).toEqual({});
  });
});
