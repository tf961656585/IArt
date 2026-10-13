import { beforeEach, describe, expect, it } from 'vitest';
import { useCanvasStore } from '../canvasStore';
import { createNodeGraph } from '../../types/nodeGraph';
import { createGraphNode } from '../../types/node';
import type { AudioInputNodeData, ModelNodeData } from '../../types/node';
import { createDefaultResultAreaEmbeddedData } from '../../services/resultAreaEmbeddedFactory';

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

/**
 * 构造承载内嵌结果区的 model 节点 data。
 * resultArea 已退化为 ModelNodeData.resultArea 子结构，不再是独立 GraphNode。
 */
const buildModelData = (
  overrides: Partial<ModelNodeData> = {},
): ModelNodeData => ({
  label: 'Model',
  description: undefined,
  runtimeRef: undefined,
  shellModelId: undefined,
  modelId: 'test-model',
  currentOverrideId: undefined,
  formValues: {},
  portMapping: {},
  inlineControlsCollapsed: undefined,
  inlineAdvancedGroupsExpanded: undefined,
  lastExecutionId: undefined,
  taskInfo: undefined,
  executionPreferences: undefined,
  promptPresetSnapshots: undefined,
  resultArea: createDefaultResultAreaEmbeddedData(),
  ...overrides,
});

const expectNodeGraph = () => {
  const graph = useCanvasStore.getState().nodeGraph;
  expect(graph).toBeDefined();
  if (!graph) throw new Error('Expected nodeGraph');
  return graph;
};

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
    state.dirtyRevision = 0;
    state.dirty = {
      graph: false,
      viewport: false,
      fullReplace: false,
      mediaAssets: false,
      nodes: {},
      removedNodes: {},
    };
    state.structureRevision = 0;
    state.taskRevision = 0;
    state.positionRevision = 0;
    state.viewportRevision = 0;
    state.layoutRevision = 0;
    state.clipboardPayload = null;
    state.ui.desiredSizeByNodeId = {};
  });
};

describe('canvasStore.submitNodeSizeProposal / acceptDesiredSize', () => {
  beforeEach(() => {
    resetStore();
  });

  it('accept 后应只写入 ui.desiredSizeByNodeId（不改 node）', () => {
    const graph = createNodeGraph({
      name: '测试画板',
      description: undefined,
      tags: undefined,
      category: undefined,
    });
    graph.id = 'graph-node-size-commit-runtime-only';
    graph.meta = { ...(graph.meta ?? {}), updatedAt: '2020-01-01T00:00:00.000Z' };
    const textNode = createGraphNode({
      type: 'audioInput',
      position: { x: 0, y: 0 },
      data: buildAudioInputData({ label: '文本' }),
    });
    textNode.id = 'node-1';
    graph.nodes = [textNode];

    useCanvasStore.setState((state) => {
      state.nodeGraph = graph;
      state.hasUnsavedChanges = false;
      state.structureRevision = 0;
    });

    const prevState = useCanvasStore.getState();
    const prevUpdatedAt = prevState.nodeGraph?.meta?.updatedAt;
    const prevRevision = prevState.structureRevision;
    useCanvasStore.getState().submitNodeSizeProposal({
      nodeId: 'node-1',
      source: 'resultAreaAutoScale',
      semanticKey: 'semantic-1',
      desiredSize: { width: 320, height: 180 },
      priority: 80,
      reason: 'result-area:auto-scale',
    });
    useCanvasStore.getState().acceptDesiredSize('node-1');

    const nextState = useCanvasStore.getState();
    const nextGraph = expectNodeGraph();
    const nextNode = nextGraph.nodes.find((n) => n.id === 'node-1');
    expect(nextNode).toBeDefined();
    if (!nextNode) return;

    expect(nextNode.size).toBeUndefined();
    expect(nextState.ui.desiredSizeByNodeId['node-1']?.size).toEqual({ width: 320, height: 180 });
    expect(nextState.structureRevision).toBe(prevRevision);
    expect(nextState.hasUnsavedChanges).toBe(false);
    expect(nextGraph.meta.updatedAt).toBe(prevUpdatedAt);
  });

  it('重复提交相同 semantic proposal 应保持 no-op', () => {
    const graph = createNodeGraph({
      name: '测试画板',
      description: undefined,
      tags: undefined,
      category: undefined,
    });
    graph.id = 'graph-node-size-commit-runtime-noop';
    const resultAreaNode = createGraphNode({
      type: 'model',
      position: { x: 0, y: 0 },
      data: buildModelData(),
    });
    resultAreaNode.id = 'node-1';
    graph.nodes = [resultAreaNode];

    useCanvasStore.setState((state) => {
      state.nodeGraph = graph;
      state.hasUnsavedChanges = false;
      state.structureRevision = 0;
    });

    useCanvasStore.getState().submitNodeSizeProposal({
      nodeId: 'node-1',
      source: 'resultAreaAutoScale',
      semanticKey: 'semantic-2',
      desiredSize: { width: 320, height: 180 },
      priority: 80,
      reason: 'result-area:auto-scale',
    });
    useCanvasStore.getState().acceptDesiredSize('node-1');
    const first = useCanvasStore.getState();
    useCanvasStore.getState().submitNodeSizeProposal({
      nodeId: 'node-1',
      source: 'resultAreaAutoScale',
      semanticKey: 'semantic-2',
      desiredSize: { width: 320, height: 180 },
      priority: 80,
      reason: 'result-area:auto-scale',
    });
    useCanvasStore.getState().acceptDesiredSize('node-1');
    const second = useCanvasStore.getState();

    expect(second.ui.desiredSizeByNodeId['node-1']?.size).toEqual({ width: 320, height: 180 });
    expect(second.structureRevision).toBe(first.structureRevision);
  });
});
