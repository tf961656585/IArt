import { beforeEach, describe, expect, it } from 'vitest';

import { createNodeGraph } from '../../types/nodeGraph';
import { createGraphNode, type GraphNode, type ImageInputNodeData } from '../../types/node';
import { useCanvasStore } from '../canvasStore';

type HistoryImageNodeData = {
  label?: string;
  imageUrl?: string;
  cachedContent?: {
    data: string;
    mimeType: string;
    originalUrl: string;
    cachedAt: number;
  };
  onRender?: () => void;
  domRef?: Element;
  reactNode?: unknown;
  nested?: {
    keep: string;
    skip?: () => void;
  };
  list?: unknown[];
};

type HistoryImageNode = Omit<GraphNode, 'data'> & { data: HistoryImageNodeData };

const buildImageInputData = (
  overrides: Partial<ImageInputNodeData> = {},
): ImageInputNodeData => ({
  label: undefined,
  description: undefined,
  runtimeRef: undefined,
  assetId: undefined,
  imageUrl: null,
  imageMeta: undefined,
  lastExecutionId: undefined,
  lastSourceNodeId: undefined,
  lastSourcePortId: undefined,
  valueSource: undefined,
  mediaError: undefined,
  derivedFromNodeId: undefined,
  derivedOp: undefined,
  taskInfo: undefined,
  cachedContent: undefined,
  originalImageMeta: undefined,
  resizePercent: undefined,
  outpaintModelId: undefined,
  ...overrides,
});

const asGraphNodeData = (value: unknown): GraphNode['data'] => value as GraphNode['data'];

const expectHistoryImageNode = (node: GraphNode | undefined): HistoryImageNode => {
  expect(node).toBeDefined();
  if (!node) throw new Error('Expected history image node');
  return node as HistoryImageNode;
};

const resetStore = () => {
  useCanvasStore.setState((state) => {
    state.nodeGraph = null;
    state.mediaAssets = {};
    state.selectedNodeIds = [];
    state.selectedAnnotationIds = [];
    state.editingAnnotationId = null;
    state.pendingAnnotationBinding = null;
    state.history = [];
    state.historyIndex = -1;
    state.deferredHistoryBaseline = null;
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
  });
};

describe('canvasStore history', () => {
  beforeEach(() => {
    resetStore();
  });

  it('saveToHistory 会排除 cachedContent，并截断 base64 媒体 URL', () => {
    const graph = createNodeGraph({ name: 'history-save', description: undefined, tags: undefined, category: undefined });
    const imageNode = createGraphNode({
      type: 'imageInput',
      position: { x: 0, y: 0 },
      data: buildImageInputData({
        label: '图片',
        imageUrl: 'data:image/png;base64,' + 'A'.repeat(64),
        cachedContent: {
          data: 'data:image/png;base64,' + 'B'.repeat(64),
          mimeType: 'image/png',
          originalUrl: 'https://example.com/image.png',
          cachedAt: 1,
        },
      }),
    });
    imageNode.id = 'image-1';
    graph.nodes = [imageNode];

    useCanvasStore.setState((state) => {
      state.nodeGraph = graph;
    });

    useCanvasStore.getState().saveToHistory();

    const entry = useCanvasStore.getState().history[0];
    expect(entry).toBeDefined();
    if (!entry) return;
    expect(entry.kind).toBe('snapshot');
    if (entry.kind !== 'snapshot') return;
    const entryNode = expectHistoryImageNode(entry.nodes[0]);
    expect(entryNode.data.cachedContent).toBeUndefined();
    expect(entryNode.data.imageUrl).toContain('[history-snapshot]');
    expect(Object.prototype.hasOwnProperty.call(entryNode, 'selected')).toBe(false);
  });

  it('saveToHistory 只保存可克隆纯数据，不把函数、DOM 或 React 节点写入快照', () => {
    const graph = createNodeGraph({ name: 'history-pure-data', description: undefined, tags: undefined, category: undefined });
    const unsafeImageNode = createGraphNode({
      type: 'imageInput',
      position: { x: 0, y: 0 },
      data: asGraphNodeData({
        ...buildImageInputData({
          label: 'unsafe',
          imageUrl: 'https://example.com/image.png',
        }),
        onRender: () => undefined,
        domRef: document.createElement('div'),
        reactNode: {
          $$typeof: Symbol.for('react.element'),
          props: { children: 'bad' },
        },
        nested: {
          keep: 'yes',
          skip: () => undefined,
        },
        list: ['ok', () => undefined, document.createElement('span')],
      }),
    });
    unsafeImageNode.id = 'image-unsafe';
    graph.nodes = [unsafeImageNode];

    useCanvasStore.setState((state) => {
      state.nodeGraph = graph;
    });

    expect(() => useCanvasStore.getState().saveToHistory()).not.toThrow();

    const entry = useCanvasStore.getState().history[0];
    expect(entry).toBeDefined();
    if (!entry) return;
    expect(entry.kind).toBe('snapshot');
    if (entry.kind !== 'snapshot') return;
    expect(() => structuredClone(entry)).not.toThrow();
    const entryNode = expectHistoryImageNode(entry.nodes[0]);
    expect(entryNode.data.onRender).toBeUndefined();
    expect(entryNode.data.domRef).toBeUndefined();
    expect(entryNode.data.reactNode).toBeUndefined();
    expect(entryNode.data.nested).toEqual({ keep: 'yes' });
    expect(entryNode.data.list).toEqual(['ok', null, null]);
  });

  it('commitDeferredHistoryBaseline 只在空 history 时提交首个基线', () => {
    const graph = createNodeGraph({ name: 'history-baseline', description: undefined, tags: undefined, category: undefined });
    const baselineNode = createGraphNode({
      type: 'imageInput',
      position: { x: 0, y: 0 },
      data: asGraphNodeData({
        ...buildImageInputData({
          label: 'baseline',
        }),
        onRender: () => undefined,
        domRef: document.createElement('div'),
      }),
    });
    baselineNode.id = 'baseline-unsafe';
    graph.nodes = [baselineNode];

    useCanvasStore.setState((state) => {
      state.nodeGraph = graph;
      state.deferredHistoryBaseline = {
        nodeGraph: graph,
      };
      state.history = [];
      state.historyIndex = -1;
    });

    useCanvasStore.getState().commitDeferredHistoryBaseline();
    const snapshot = useCanvasStore.getState();

    expect(snapshot.history).toHaveLength(1);
    expect(snapshot.historyIndex).toBe(0);
    expect(snapshot.deferredHistoryBaseline).toBeNull();
    expect(() => structuredClone(snapshot.history[0])).not.toThrow();
    const firstEntry = snapshot.history[0];
    expect(firstEntry?.kind).toBe('snapshot');
    if (firstEntry?.kind !== 'snapshot') return;
    const entryNode = expectHistoryImageNode(firstEntry.nodes[0]);
    expect(entryNode.data.onRender).toBeUndefined();
    expect(entryNode.data.domRef).toBeUndefined();
  });

  it('undo/redo 会恢复节点图，同时保留当前会话的 cachedContent 与真实媒体 URL', () => {
    const graph = createNodeGraph({ name: 'history-undo-redo', description: undefined, tags: undefined, category: undefined });
    const imageNode = createGraphNode({
      type: 'imageInput',
      position: { x: 0, y: 0 },
      data: buildImageInputData({
        label: '初始',
        imageUrl: 'data:image/png;base64,' + 'A'.repeat(64),
        cachedContent: {
          data: 'data:image/png;base64,' + 'B'.repeat(64),
          mimeType: 'image/png',
          originalUrl: 'https://example.com/image.png',
          cachedAt: 1,
        },
      }),
    });
    imageNode.id = 'image-1';
    graph.nodes = [imageNode];

    useCanvasStore.setState((state) => {
      state.nodeGraph = graph;
    });

    useCanvasStore.getState().saveToHistory();

    useCanvasStore.setState((state) => {
      if (!state.nodeGraph) return;
      const imageNode = expectHistoryImageNode(state.nodeGraph.nodes[0]);
      imageNode.data = {
        ...imageNode.data,
        label: '当前会话',
        imageUrl: 'https://example.com/runtime.png',
        cachedContent: {
          data: 'runtime-cache',
          mimeType: 'image/png',
          originalUrl: 'https://example.com/runtime.png',
          cachedAt: 2,
        },
      };
    });

    useCanvasStore.getState().saveToHistory();
    const taskRevisionBeforeUndo = useCanvasStore.getState().taskRevision;

    useCanvasStore.getState().undo();
    const afterUndo = useCanvasStore.getState();
    const undoNode = expectHistoryImageNode(afterUndo.nodeGraph?.nodes[0]);
    expect(undoNode.data.label).toBe('初始');
    expect(undoNode.data.imageUrl).toBe('https://example.com/runtime.png');
    expect(undoNode.data.cachedContent).toEqual({
      data: 'runtime-cache',
      mimeType: 'image/png',
      originalUrl: 'https://example.com/runtime.png',
      cachedAt: 2,
    });
    expect(afterUndo.historyIndex).toBe(0);
    expect(afterUndo.taskRevision).toBe(taskRevisionBeforeUndo + 1);

    useCanvasStore.getState().redo();
    const afterRedo = useCanvasStore.getState();
    const redoNode = expectHistoryImageNode(afterRedo.nodeGraph?.nodes[0]);
    expect(redoNode.data.label).toBe('当前会话');
    expect(redoNode.data.imageUrl).toBe('https://example.com/runtime.png');
    expect(redoNode.data.cachedContent?.data).toBe('runtime-cache');
    expect(afterRedo.historyIndex).toBe(1);
  });

  // 回归：拖拽释放提交位置（updateNodePositionsBatch）依赖 immer 的 Patches
  // 插件。若未调用 enablePatches()，produceWithPatches 会抛出
  // "The plugin for 'Patches' has not been loaded"，导致位置无法写入 store，
  // 拖拽释放后节点弹回起点。
  it('updateNodePositionsBatch 将位置写入 nodeGraph.nodes，且不抛 immer 插件错误', () => {
    const graph = createNodeGraph({ name: 'position-batch', description: undefined, tags: undefined, category: undefined });
    const imageNode = createGraphNode({
      type: 'imageInput',
      position: { x: 0, y: 0 },
      data: buildImageInputData({ label: '拖拽节点' }),
    });
    imageNode.id = 'drag-1';
    graph.nodes = [imageNode];

    useCanvasStore.setState((state) => {
      state.nodeGraph = graph;
    });

    expect(() => {
      useCanvasStore.getState().updateNodePositionsBatch([
        { id: 'drag-1', position: { x: 200, y: 200 } },
      ]);
    }).not.toThrow();

    const after = useCanvasStore.getState().nodeGraph?.nodes[0];
    expect(after?.position).toEqual({ x: 200, y: 200 });
  });

  // 回归：patch 历史条目的 apply 路径必须与生成路径基准一致。
  // patch 由 produceWithPatches 基于 nodeGraph.nodes 数组生成（路径形如
  // [index, "position"]），apply 时必须作用于 nodeGraph.nodes 而非整个
  // nodeGraph，否则报 "Cannot apply patch, path doesn't resolve"。
  it('位置 patch 条目支持 undo/redo 正确还原', () => {
    const graph = createNodeGraph({ name: 'position-undo', description: undefined, tags: undefined, category: undefined });
    const imageNode = createGraphNode({
      type: 'imageInput',
      position: { x: 0, y: 0 },
      data: buildImageInputData({ label: 'undo 节点' }),
    });
    imageNode.id = 'undo-1';
    graph.nodes = [imageNode];

    useCanvasStore.setState((state) => {
      state.nodeGraph = graph;
    });

    useCanvasStore.getState().saveToHistory();

    useCanvasStore.getState().updateNodePositionsBatch([
      { id: 'undo-1', position: { x: 300, y: 300 } },
    ]);
    const afterMove = useCanvasStore.getState().nodeGraph?.nodes[0];
    expect(afterMove?.position).toEqual({ x: 300, y: 300 });

    useCanvasStore.getState().undo();
    const afterUndo = useCanvasStore.getState().nodeGraph?.nodes[0];
    expect(afterUndo?.position).toEqual({ x: 0, y: 0 });

    useCanvasStore.getState().redo();
    const afterRedo = useCanvasStore.getState().nodeGraph?.nodes[0];
    expect(afterRedo?.position).toEqual({ x: 300, y: 300 });
  });
});
