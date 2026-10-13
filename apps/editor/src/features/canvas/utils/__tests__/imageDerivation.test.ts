import { beforeEach, describe, expect, it } from 'vitest';
import { createNodeGraph } from '../../types/nodeGraph';
import { useCanvasStore } from '../../store/canvasStore';
import { createDerivedImageInputNode, createDerivedImageInputNodesGrid } from '../imageDerivation';
import type { GraphNode, ImageInputNodeData, NodeGraph } from '../../types';
import type { MediaAsset } from '@iart/contracts';
import {
  createMediaAssetFixture,
  createTestNodeGraphParams,
} from '../../components/__tests__/fixtures/canvasTestBuilders';


const resetStore = () => {
  useCanvasStore.setState((state) => {
    state.nodeGraph = null;
    state.selectedNodeIds = [];
    state.history = [];
    state.historyIndex = -1;
    state.hasUnsavedChanges = false;
  });
};

const requireValue = <T>(value: T | null | undefined, message: string): T => {
  expect(value).toBeTruthy();
  if (value == null) {
    throw new Error(message);
  }
  return value;
};

const requireGraph = (): NodeGraph =>
  requireValue(useCanvasStore.getState().nodeGraph, 'nodeGraph 为空');

const isImageInputNode = (node: GraphNode): node is GraphNode<ImageInputNodeData> =>
  node.type === 'imageInput';

const requireImageInputNode = (graph: NodeGraph, nodeId: string): GraphNode<ImageInputNodeData> => {
  const node = graph.nodes.find((entry) => entry.id === nodeId);
  expect(node).toBeDefined();
  if (!node || !isImageInputNode(node)) {
    throw new Error(`未找到 imageInput 节点: ${nodeId}`);
  }
  return node;
};

const createMediaAsset = (id: string, url: string): MediaAsset => createMediaAssetFixture({
  id,
  original: {
    url,
    projectRef: 'prj_demo',
    fileKey: url.replace('/project-media/prj_demo/', ''),
    sourceUrl: '/project-media/prj_demo/source.png',
    sourceFileName: null,
    mimeType: 'image/png',
    sizeBytes: null,
    width: 100,
    height: 100,
    durationMs: null,
    fps: null,
  },
});

const createSelectionRecorder = () => {
  const calls: Array<{ nodeIds: string[]; reason: string }> = [];
  return {
    calls,
    selectNodes: (nodeIds: string[], reason: string) => {
      calls.push({ nodeIds, reason });
    },
  };
};

describe('createDerivedImageInputNode', () => {
  beforeEach(() => {
    resetStore();
  });

  it('应当创建下游 imageInput 节点并选中（血缘由节点 data 承载）', () => {
    const graph = createNodeGraph(createTestNodeGraphParams('测试画板'));
    useCanvasStore.setState((state) => {
      state.nodeGraph = graph;
    });

    const source = requireValue(
      useCanvasStore.getState().addNode(
        'imageInput',
        { x: 0, y: 0 },
        { imageUrl: '/files/source.png', valueSource: 'upload' }
      ),
      'source 节点创建失败'
    );

    const selection = createSelectionRecorder();
    const created = requireValue(
      createDerivedImageInputNode({
        sourceNodeId: source.id,
        resultUrl: '/project-media/prj_demo/derived.png',
        assetId: 'asset-derived',
        mediaAsset: createMediaAsset('asset-derived', '/project-media/prj_demo/derived.png'),
        derivedOp: { type: 'resize', percent: 50, kernel: 'nearest' },
        selectNodes: selection.selectNodes,
      }),
      '衍生节点创建失败'
    );

    const stored = requireGraph();
    const derivedNode = requireImageInputNode(stored, created.id);
    expect(derivedNode.data.imageUrl).toBe('/project-media/prj_demo/derived.png');
    expect(derivedNode.data.assetId).toBe('asset-derived');
    expect(derivedNode.data.valueSource).toBe('processed');
    expect(derivedNode.data.derivedFromNodeId).toBe(source.id);
    expect(derivedNode.data.derivedOp).toEqual({ type: 'resize', percent: 50, kernel: 'nearest' });

    expect(derivedNode.data.taskInfo).toBeUndefined();
    expect(derivedNode.data.lastExecutionId).toBeUndefined();
    expect(derivedNode.data.lastSourceNodeId).toBeUndefined();
    expect(derivedNode.data.lastSourcePortId).toBeUndefined();

    // 素材节点不持有输入端口：血缘由 derivedFromNodeId 承载

    expect(selection.calls).toEqual([{ nodeIds: [created.id], reason: 'image-derivation' }]);
  });

  it('应当支持 mirrorX / mirrorY / edgeDetect 等衍生操作类型', () => {
    const graph = createNodeGraph(createTestNodeGraphParams('测试画板'));
    useCanvasStore.setState((state) => {
      state.nodeGraph = graph;
    });

    const source = requireValue(
      useCanvasStore.getState().addNode(
        'imageInput',
        { x: 0, y: 0 },
        { imageUrl: '/files/source.png', valueSource: 'upload' }
      ),
      'source 节点创建失败'
    );

    const created = requireValue(
      createDerivedImageInputNode({
        sourceNodeId: source.id,
        resultUrl: '/project-media/prj_demo/derived.png',
        assetId: 'asset-mirror-x',
        mediaAsset: createMediaAsset('asset-mirror-x', '/project-media/prj_demo/derived.png'),
        derivedOp: { type: 'mirrorX' },
      }),
      'mirrorX 创建失败'
    );

    const stored = requireGraph();
    const derivedNode = requireImageInputNode(stored, created.id);
    expect(derivedNode.data.derivedOp).toEqual({ type: 'mirrorX' });
    expect(derivedNode.data.taskInfo).toBeUndefined();
    expect(derivedNode.data.lastExecutionId).toBeUndefined();
    expect(derivedNode.data.lastSourceNodeId).toBeUndefined();
    expect(derivedNode.data.lastSourcePortId).toBeUndefined();

    const created2 = requireValue(
      createDerivedImageInputNode({
        sourceNodeId: source.id,
        resultUrl: '/project-media/prj_demo/derived2.png',
        assetId: 'asset-mirror-y',
        mediaAsset: createMediaAsset('asset-mirror-y', '/project-media/prj_demo/derived2.png'),
        derivedOp: { type: 'mirrorY' },
      }),
      'mirrorY 创建失败'
    );

    const stored2 = requireGraph();
    const derivedNode2 = requireImageInputNode(stored2, created2.id);
    expect(derivedNode2.data.derivedOp).toEqual({ type: 'mirrorY' });
    expect(derivedNode2.data.taskInfo).toBeUndefined();
    expect(derivedNode2.data.lastExecutionId).toBeUndefined();
    expect(derivedNode2.data.lastSourceNodeId).toBeUndefined();
    expect(derivedNode2.data.lastSourcePortId).toBeUndefined();

    const created3 = requireValue(
      createDerivedImageInputNode({
        sourceNodeId: source.id,
        resultUrl: '/project-media/prj_demo/derived3.png',
        assetId: 'asset-edge',
        mediaAsset: createMediaAsset('asset-edge', '/project-media/prj_demo/derived3.png'),
        derivedOp: { type: 'edgeDetect', mode: 'sobel', threshold: 128 },
      }),
      'edgeDetect 创建失败'
    );

    const stored3 = requireGraph();
    const derivedNode3 = requireImageInputNode(stored3, created3.id);
    expect(derivedNode3.data.derivedOp).toEqual({
      type: 'edgeDetect',
      mode: 'sobel',
      threshold: 128,
    });
    expect(derivedNode3.data.taskInfo).toBeUndefined();
    expect(derivedNode3.data.lastExecutionId).toBeUndefined();
    expect(derivedNode3.data.lastSourceNodeId).toBeUndefined();
    expect(derivedNode3.data.lastSourcePortId).toBeUndefined();
  });
});

describe('createDerivedImageInputNodesGrid', () => {
  beforeEach(() => {
    resetStore();
  });

  it('应当按网格创建多个图块节点并多选', () => {
    const graph = createNodeGraph(createTestNodeGraphParams('测试画板'));
    useCanvasStore.setState((state) => {
      state.nodeGraph = graph;
    });

    const source = requireValue(
      useCanvasStore.getState().addNode(
        'imageInput',
        { x: 0, y: 0 },
        { imageUrl: '/files/source.png', valueSource: 'upload' }
      ),
      'source 节点创建失败'
    );

    const selection = createSelectionRecorder();
    const created = requireValue(
      createDerivedImageInputNodesGrid({
        sourceNodeId: source.id,
        rows: 2,
        cols: 2,
        horizontalPercents: [50],
        verticalPercents: [50],
        tiles: [
          { index: 0, row: 0, col: 0, assetId: 'asset-tile-0', mediaAsset: createMediaAsset('asset-tile-0', '/project-media/prj_demo/tile_0.png'), url: '/project-media/prj_demo/tile_0.png', width: 100, height: 100 },
          { index: 1, row: 0, col: 1, assetId: 'asset-tile-1', mediaAsset: createMediaAsset('asset-tile-1', '/project-media/prj_demo/tile_1.png'), url: '/project-media/prj_demo/tile_1.png', width: 100, height: 100 },
          { index: 2, row: 1, col: 0, assetId: 'asset-tile-2', mediaAsset: createMediaAsset('asset-tile-2', '/project-media/prj_demo/tile_2.png'), url: '/project-media/prj_demo/tile_2.png', width: 100, height: 100 },
          { index: 3, row: 1, col: 1, assetId: 'asset-tile-3', mediaAsset: createMediaAsset('asset-tile-3', '/project-media/prj_demo/tile_3.png'), url: '/project-media/prj_demo/tile_3.png', width: 100, height: 100 },
        ],
        selectNodes: selection.selectNodes,
      }),
      '网格节点创建失败'
    );
    expect(created.length).toBe(4);

    const stored = requireGraph();
    const createdIds = created.map((node) => node.id);

    for (const id of createdIds) {
      const node = requireImageInputNode(stored, id);
      expect(node.data.valueSource).toBe('processed');
      expect(node.data.assetId).toMatch(/^asset-tile-/);
      expect(node.data.derivedFromNodeId).toBe(source.id);
      expect(node.data.derivedOp?.type).toBe('split');
      // 素材节点不持有输入端口：血缘由节点 data 承载
    }

    expect(selection.calls).toEqual([{ nodeIds: createdIds, reason: 'image-derivation' }]);
  });
});
