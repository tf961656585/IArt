import { beforeEach, describe, expect, it } from 'vitest';
import { cast } from '@/lib/utils';
import { useCanvasStore } from '../canvasStore';
import {
  createNodeGraph,
  CURRENT_NODE_GRAPH_SCHEMA_VERSION,
} from '../../types/nodeGraph';
import type { GraphNode } from '../../types/node';
import {
  createTextInputDataFixture,
  createTextInputNodeFixture,
} from '../../components/__tests__/fixtures/canvasTestBuilders';


const expectNodeGraph = () => {
  const graph = useCanvasStore.getState().nodeGraph;
  expect(graph).toBeDefined();
  if (!graph) throw new Error('Expected nodeGraph');
  return graph;
};

const expectNode = (node: GraphNode | undefined): GraphNode => {
  expect(node).toBeDefined();
  if (!node) throw new Error('Expected node');
  return node;
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
    state.clipboardPayload = null;
  });
};

describe('canvasStore.loadNodeGraph', () => {
  beforeEach(() => {
    resetStore();
  });

  it('应当为缺失坐标的节点补齐默认位置，避免 ReactFlow 读取 undefined.x', async () => {
    const graph = createNodeGraph({ name: '测试画板', description: undefined, tags: undefined, category: undefined });
    graph.meta.schemaVersion = CURRENT_NODE_GRAPH_SCHEMA_VERSION - 1;
    graph.nodes = [
      cast<GraphNode>({
        id: 'n1',
        type: 'videoInput',
        // 模拟旧数据：缺少 position
        data: {
          label: '文本输入',
          segments: [{ kind: 'local', id: 'local-1', enabled: true, text: '' }],
          separator: 'comma',
          customSeparator: '',
        },
      }),
    ];

    await useCanvasStore.getState().loadNodeGraph(graph);

    const loaded = expectNodeGraph();
    expect(expectNode(loaded.nodes[0]).position).toEqual({ x: 0, y: 0 });
  });

  it('应当为旧项目补齐 meta，避免拖放新增节点时报错', async () => {
    const graph = createNodeGraph({ name: '测试画板', description: undefined, tags: undefined, category: undefined });
    const legacyGraph = cast<Omit<typeof graph, 'meta'> & { meta?: typeof graph.meta }>(graph);
    delete legacyGraph.meta;

    await useCanvasStore.getState().loadNodeGraph(graph);

    const loaded = expectNodeGraph();
    expect(typeof loaded.meta?.updatedAt).toBe('string');

    const node = useCanvasStore.getState().addNode('videoInput', { x: 10, y: 20 }, undefined);
    expect(node).not.toBeNull();
    expect(typeof expectNodeGraph().meta.updatedAt).toBe('string');
  });

});

describe('canvasStore.updateNodePositionsBatch', () => {
  beforeEach(() => {
    resetStore();
  });

  it('移动节点后应当可以通过 undo 还原位置', () => {
    const graph = createNodeGraph({ name: '测试画板', description: undefined, tags: undefined, category: undefined });
    graph.nodes = [
      createTextInputNodeFixture({
        id: 'n1',
        position: { x: 0, y: 0 },
        data: createTextInputDataFixture({
          label: '文本输入',
          segments: [{ kind: 'local', id: 'local-1', enabled: true, text: '' }],
          separator: 'comma',
          customSeparator: '',
        }),
      }),
    ];
    useCanvasStore.setState((state) => {
      state.nodeGraph = graph;
    });
    useCanvasStore.getState().saveToHistory();

    const beforePos = expectNode(expectNodeGraph().nodes.find((n) => n.id === 'n1')).position;
    expect(beforePos).toEqual({ x: 0, y: 0 });

    useCanvasStore.getState().updateNodePositionsBatch([{ id: 'n1', position: { x: 100, y: 200 } }]);
    const afterPos = expectNode(expectNodeGraph().nodes.find((n) => n.id === 'n1')).position;
    expect(afterPos).toEqual({ x: 100, y: 200 });

    useCanvasStore.getState().undo();
    const undonePos = expectNode(expectNodeGraph().nodes.find((n) => n.id === 'n1')).position;
    expect(undonePos).toEqual({ x: 0, y: 0 });
  });
});
