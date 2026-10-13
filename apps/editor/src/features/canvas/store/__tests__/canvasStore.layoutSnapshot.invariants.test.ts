import { beforeEach, describe, expect, it } from 'vitest';
import { useCanvasStore } from '../canvasStore';
import { createNodeGraph } from '../../types/nodeGraph';
import { selectLayoutSnapshotNodes } from '../selectors';
import type { TextInputNodeData } from '../../types/node';


const resetStore = () => {
  useCanvasStore.setState((state) => {
    state.nodeGraph = null;
    state.selectedNodeIds = [];
    state.selectedAnnotationIds = [];
    state.editingAnnotationId = null;
    state.pendingAnnotationBinding = null;
    state.isDragging = false;
    state.isConnecting = false;
    state.history = [];
    state.historyIndex = -1;
    state.hasUnsavedChanges = false;
    state.structureRevision = 0;
    state.taskRevision = 0;
    state.positionRevision = 0;
    state.viewportRevision = 0;
    state.layoutRevision = 0;
    state.clipboardPayload = null;
  });
};

describe('selectLayoutSnapshotNodes invariants', () => {
  beforeEach(() => {
    resetStore();
  });

  it('task-index-sync updates do not change layout snapshot identity', () => {
    const graph = createNodeGraph({
      name: '测试画板',
      description: undefined,
      tags: undefined,
      category: undefined,
    });
    graph.id = 'graph-layoutSnapshot-task-index-sync';
    graph.meta = { ...(graph.meta ?? {}), updatedAt: '2020-01-01T00:00:00.000Z' };
    const textInputData: TextInputNodeData = {
      label: '文本',
      description: undefined,
      runtimeRef: undefined,
      segments: [],
      lastExecutionId: undefined,
      lastSourceNodeId: undefined,
      lastSourcePortId: undefined,
      separator: undefined,
      customSeparator: undefined,
      promptPresetSnapshots: undefined,
      taskInfo: undefined,
      promptInterview: undefined,
    };
    graph.nodes = [
      {
        id: 'node-1',
        type: 'textInput',
        position: { x: 0, y: 0 },
        data: textInputData,
        draggable: true,
        size: undefined,
        style: undefined,
        groupId: undefined,
      },
    ];

    useCanvasStore.setState((state) => {
      state.nodeGraph = graph;
    });

    const first = selectLayoutSnapshotNodes(useCanvasStore.getState());

    useCanvasStore
      .getState()
      .updateNodeData('node-1', { taskInfo: { status: 'running', taskId: 'task-1' } }, 'task-index-sync');

    const second = selectLayoutSnapshotNodes(useCanvasStore.getState());
    expect(second).toBe(first);
    expect(second[0]).toBe(first[0]);

    useCanvasStore.getState().updateNodePositionsBatch([{ id: 'node-1', position: { x: 10, y: 0 } }]);
    const third = selectLayoutSnapshotNodes(useCanvasStore.getState());
    expect(third).not.toBe(second);
    expect(third[0]).not.toBe(second[0]);
  });

  it('selection updates do not change layout snapshot identity', () => {
    const graph = createNodeGraph({
      name: '测试画板',
      description: undefined,
      tags: undefined,
      category: undefined,
    });
    graph.id = 'graph-layoutSnapshot-selection';
    graph.meta = { ...(graph.meta ?? {}), updatedAt: '2020-01-01T00:00:00.000Z' };
    const textInputData: TextInputNodeData = {
      label: '文本',
      description: undefined,
      runtimeRef: undefined,
      segments: [],
      lastExecutionId: undefined,
      lastSourceNodeId: undefined,
      lastSourcePortId: undefined,
      separator: undefined,
      customSeparator: undefined,
      promptPresetSnapshots: undefined,
      taskInfo: undefined,
      promptInterview: undefined,
    };
    graph.nodes = [
      {
        id: 'node-1',
        type: 'textInput',
        position: { x: 0, y: 0 },
        data: textInputData,
        draggable: true,
        size: undefined,
        style: undefined,
        groupId: undefined,
      },
      {
        id: 'node-2',
        type: 'textInput',
        position: { x: 120, y: 0 },
        data: textInputData,
        draggable: true,
        size: undefined,
        style: undefined,
        groupId: undefined,
      },
    ];

    useCanvasStore.setState((state) => {
      state.nodeGraph = graph;
    });

    const first = selectLayoutSnapshotNodes(useCanvasStore.getState());

    useCanvasStore.getState().projectSelectionContract({
      selectedNodeIds: ['node-1', 'node-2'],
      selectedAnnotationIds: [],
      editingAnnotationId: null,
      pendingAnnotationBinding: null,
    });

    const second = selectLayoutSnapshotNodes(useCanvasStore.getState());
    expect(second).toBe(first);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
  });
});
