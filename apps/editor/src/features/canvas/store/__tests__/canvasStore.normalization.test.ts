import { beforeEach, describe, expect, it } from 'vitest';
import { useCanvasStore } from '../canvasStore';
import { createNodeGraph, CURRENT_NODE_GRAPH_SCHEMA_VERSION, type NodeGraph } from '../../types/nodeGraph';
import { nodeRegistry } from '../../nodes/registry';
import { setRuntimeProjectedModels } from '@/client/config/models.config';


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
    state.clipboardPayload = null;
    state.ui.desiredSizeByNodeId = {};
  });
};

type LooseNodeGraph = Omit<NodeGraph, 'nodes'> & {
  nodes: unknown[];
};

const createLooseGraph = (name: string): LooseNodeGraph => {
  const graph = createNodeGraph({ name, description: undefined, tags: undefined, category: undefined });
  graph.meta.schemaVersion = CURRENT_NODE_GRAPH_SCHEMA_VERSION - 1;
  return graph;
};

const asNodeGraph = (graph: LooseNodeGraph): NodeGraph => graph as NodeGraph;

const readRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};


const getLoadedGraph = (): NodeGraph => {
  const loadedGraph = useCanvasStore.getState().nodeGraph;
  expect(loadedGraph).toBeDefined();
  if (!loadedGraph) {
    throw new Error('loadNodeGraph 后 nodeGraph 不应为空');
  }
  return loadedGraph;
};

describe('canvasStore.loadNodeGraph - ID 规范化', () => {
  beforeEach(() => {
    resetStore();
    setRuntimeProjectedModels([]);
  });

  it('应当修正重复或缺失的节点 ID', async () => {
    const graph = createLooseGraph('测试画板');
    graph.nodes = [
      {
        id: 'dup',
        type: 'videoInput',
        data: {
          label: '重复1',
          segments: [{ kind: 'local', id: 'local-1', enabled: true, text: '' }],
          separator: 'comma',
          customSeparator: '',
        },
        position: { x: 0, y: 0 },
      },
      {
        id: 'dup',
        type: 'videoInput',
        data: {
          label: '重复2',
          segments: [{ kind: 'local', id: 'local-1', enabled: true, text: '' }],
          separator: 'comma',
          customSeparator: '',
        },
        position: { x: 10, y: 10 },
      },
      {
        id: '',
        type: 'imageInput',
        data: {
          label: '缺失 ID',
          imageUrl: null,
        },
        position: { x: 20, y: 20 },
      },
    ];

    await useCanvasStore.getState().loadNodeGraph(asNodeGraph(graph));

    const loaded = getLoadedGraph();
    const nodeIds = loaded.nodes.map((node) => node.id);

    expect(new Set(nodeIds).size).toBe(loaded.nodes.length);
    expect(nodeIds[0]).toBe('dup');
    expect(nodeIds[1]).not.toBe('dup');
    expect(nodeIds[2]).not.toBe('');
  });

  it('应当为缺失 data 的节点填充默认值', async () => {
    const graph = createLooseGraph('测试画板');
    graph.nodes = [
      {
        id: 'text-1',
        type: 'videoInput',
        data: undefined,
        position: { x: 0, y: 0 },
      },
    ];

    await useCanvasStore.getState().loadNodeGraph(asNodeGraph(graph));

    const loadedNode = getLoadedGraph().nodes[0];
    expect(loadedNode).toBeDefined();
    if (!loadedNode) return;
    expect(loadedNode.data).toMatchObject({
      label: '视频素材',
    });
  });

  it('应当清理历史 size 与 measuredSize 字段', async () => {
    const graph = createLooseGraph('测试画板');
    graph.nodes = [
      {
        id: 'text-1',
        type: 'videoInput',
        data: {
          label: '文本输入',
          segments: [{ kind: 'local', id: 'local-1', enabled: true, text: '' }],
          separator: 'comma',
          customSeparator: '',
        },
        position: { x: 0, y: 0 },
        measuredSize: { width: 999, height: 888 },
      },
    ];

    await useCanvasStore.getState().loadNodeGraph(asNodeGraph(graph));

    const loadedNode = getLoadedGraph().nodes[0];
    expect(loadedNode).toBeDefined();
    if (!loadedNode) return;
    expect(loadedNode.size).toBeUndefined();
    expect(Reflect.get(loadedNode, 'measuredSize')).toBeUndefined();
  });

  it('应当在 load 边界剥离 legacy selected 与 selectedSlotIds，不残留进 store', async () => {
    // 独立 resultArea 节点已废弃（schemaVersion 2→3 折叠迁移会丢弃孤儿 resultArea），
    // 且 selectedSlotIds → outputSlotIds 的迁移口径已不存在（当前仅剥离），
    // 故改用 textInput 节点承载 legacy selected/selectedSlotIds 的剥离断言。
    const graph = createLooseGraph('selection-steady-state-migration');
    graph.meta.schemaVersion = CURRENT_NODE_GRAPH_SCHEMA_VERSION - 1;
    graph.nodes = [
      {
        id: 'text-1',
        type: 'videoInput',
        data: {
          label: '文本',
          segments: [{ kind: 'local', id: 'local-1', enabled: true, text: '' }],
          separator: 'comma',
          customSeparator: '',
          selectedSlotIds: ['slot-1'],
        },
        position: { x: 0, y: 0 },
        selected: true,
      },
    ];

    await useCanvasStore.getState().loadNodeGraph(asNodeGraph(graph));

    const loaded = getLoadedGraph();
    const loadedNode = loaded.nodes[0];
    expect(loadedNode).toBeDefined();
    if (!loadedNode) return;
    expect('selected' in loadedNode).toBe(false);
    expect(readRecord(loadedNode.data)['selectedSlotIds']).toBeUndefined();
    expect(useCanvasStore.getState().lastLoadDiagnostics).toMatchObject({
      path: 'repair',
      stripLegacySelectionSteadyState: 1,
    });
    expect(useCanvasStore.getState().hasUnsavedChanges).toBe(true);
  });

  it('nodeRegistry.createNode 不应写入默认 size', () => {
    const node = nodeRegistry.createNode('videoInput', { x: 0, y: 0 }, undefined);
    expect(node).toBeDefined();
    if (!node) return;
    expect(node.size).toBeUndefined();
  });

  it('应当保留当前 taskInfo 的 canonical modelId', async () => {
    const graph = createLooseGraph('当前字段加载测试');
    graph.nodes = [
      {
        id: 'image-current',
        type: 'imageInput',
        data: {
          label: '当前任务节点',
          imageUrl: null,
          taskInfo: {
            taskId: 'task-current',
            modelId: 'gemini-3-pro-image',
            createdAt: 1,
            updatedAt: 2,
          },
        },
        position: { x: 100, y: 0 },
      },
    ];

    await useCanvasStore.getState().loadNodeGraph(asNodeGraph(graph));

    const loadedNodes = getLoadedGraph().nodes;
    const imageNode = loadedNodes.find((node) => node.id === 'image-current');

    expect(readRecord(imageNode?.data)['taskInfo']).toMatchObject({
      taskId: 'task-current',
      modelId: 'gemini-3-pro-image',
    });
  });

});
