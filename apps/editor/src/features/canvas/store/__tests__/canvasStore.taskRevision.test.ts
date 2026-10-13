import { beforeEach, describe, expect, it } from 'vitest';
import { useCanvasStore } from '../canvasStore';
import { createNodeGraph } from '../../types/nodeGraph';
import { createGraphNode } from '../../types/node';
import type { AudioInputNodeData, NodeTaskInfo } from '../../types/node';

const buildAudioInputData = (
  overrides: Partial<AudioInputNodeData> = {},
): AudioInputNodeData => ({
  label: undefined,
  description: undefined,
  runtimeRef: undefined,
  assetId: undefined,
  audioUrl: null,
  valueSource: undefined,
  mediaError: undefined,
  lastExecutionId: undefined,
  lastSourceNodeId: undefined,
  lastSourcePortId: undefined,
  taskInfo: undefined,
  cachedContent: undefined,
  duration: undefined,
  segments: [],
  segmentModeEnabled: undefined,
  ...overrides,
});

const buildTaskInfo = (overrides: Partial<NodeTaskInfo> = {}): NodeTaskInfo => ({
  taskId: undefined,
  remoteRequestId: undefined,
  taskIndex: undefined,
  modelId: 'gemini',
  status: undefined,
  progress: undefined,
  createdAt: 0,
  updatedAt: 0,
  error: undefined,
  failure: undefined,
  batchId: undefined,
  ...overrides,
});

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

describe('canvasStore.taskRevision', () => {
  beforeEach(() => {
    resetStore();
  });

  it('非任务字段变更不应递增 taskRevision', () => {
    const graph = createNodeGraph({ name: 'taskRevision-nonTask', description: undefined, tags: undefined, category: undefined });
    graph.id = 'graph-taskRevision-nonTask';
    const node = createGraphNode({
      type: 'audioInput',
      position: { x: 0, y: 0 },
      data: buildAudioInputData({ label: '文本' }),
    });
    node.id = 'node-1';
    graph.nodes = [node];

    useCanvasStore.setState((state) => {
      state.nodeGraph = graph;
      state.structureRevision = 0;
      state.dataRevision = 0;
      state.taskRevision = 0;
    });

    useCanvasStore.getState().updateNodeData('node-1', { label: '文本2' }, undefined);

    expect(useCanvasStore.getState().taskRevision).toBe(0);
    // spec 已收口：label 变更只 bump dataRevision，不 bump structureRevision
    expect(useCanvasStore.getState().structureRevision).toBe(0);
    expect(useCanvasStore.getState().dataRevision).toBe(1);
  });

  it('taskInfo 变更应递增 taskRevision', () => {
    const graph = createNodeGraph({ name: 'taskRevision-taskInfo', description: undefined, tags: undefined, category: undefined });
    graph.id = 'graph-taskRevision-taskInfo';
    const node = createGraphNode({
      type: 'audioInput',
      position: { x: 0, y: 0 },
      data: buildAudioInputData({ label: '文本' }),
    });
    node.id = 'node-1';
    graph.nodes = [node];

    useCanvasStore.setState((state) => {
      state.nodeGraph = graph;
      state.structureRevision = 0;
      state.dataRevision = 0;
      state.taskRevision = 0;
    }, undefined);

    useCanvasStore.getState().updateNodeData('node-1', {
      taskInfo: buildTaskInfo({
        taskId: 'task-1',
        taskIndex: 0,
        status: 'generating',
        createdAt: 1,
        updatedAt: 2,
      }),
    }, undefined);

    expect(useCanvasStore.getState().taskRevision).toBe(1);
    // spec 已收口：taskInfo 变更只 bump dataRevision，不 bump structureRevision
    expect(useCanvasStore.getState().structureRevision).toBe(0);
    expect(useCanvasStore.getState().dataRevision).toBe(1);
  });

  it('undo/redo 应递增 taskRevision（保持与 nodeGraph 一致的唤醒信号）', () => {
    const graph = createNodeGraph({ name: 'taskRevision-undo', description: undefined, tags: undefined, category: undefined });
    graph.id = 'graph-taskRevision-undo';
    const node = createGraphNode({
      type: 'audioInput',
      position: { x: 0, y: 0 },
      data: buildAudioInputData({ label: '文本' }),
    });
    node.id = 'node-1';
    graph.nodes = [node];

    useCanvasStore.setState((state) => {
      state.nodeGraph = graph;
      state.structureRevision = 0;
      state.taskRevision = 0;
    });

    useCanvasStore.getState().saveToHistory();
    useCanvasStore.getState().updateNodeData('node-1', { label: '文本2' }, undefined);
    useCanvasStore.getState().saveToHistory();

    const beforeUndo = useCanvasStore.getState().taskRevision;
    useCanvasStore.getState().undo();
    expect(useCanvasStore.getState().taskRevision).toBe(beforeUndo + 1);

    const beforeRedo = useCanvasStore.getState().taskRevision;
    useCanvasStore.getState().redo();
    expect(useCanvasStore.getState().taskRevision).toBe(beforeRedo + 1);
  });
});
