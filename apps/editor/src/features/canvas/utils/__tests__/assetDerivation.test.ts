import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaAsset } from '@iart/contracts';
import { createNodeGraph } from '../../types/nodeGraph';
import { useCanvasStore } from '../../store/canvasStore';
import {
  applyOutpaintResultToAssetNode,
  bindOutpaintTaskToAssetNode,
  createDerivedAssetNode,
  createDerivedAssetNodesInGrid,
} from '../assetDerivation';
import {
  DERIVED_NODE_HEIGHT_ESTIMATE,
  DERIVED_NODE_WIDTH_ESTIMATE,
} from '../derivedNodePlacement';
import type { AssetNodeData, GraphNode, NodeGraph } from '../../types';
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

const requireGraph = (): NodeGraph => {
  const graph = useCanvasStore.getState().nodeGraph;
  expect(graph).toBeTruthy();
  if (!graph) throw new Error('nodeGraph 为空');
  return graph;
};

const createMediaAsset = (id: string, url: string): MediaAsset =>
  createMediaAssetFixture({
    id,
    original: {
      url,
      projectRef: 'prj_demo',
      fileKey: 'derived.png',
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

const addSourceAssetNode = (position: { x: number; y: number } = { x: 0, y: 0 }): GraphNode<AssetNodeData> => {
  const node = useCanvasStore.getState().addNode('asset', position, {
    label: 'gpt-image-2',
    sourceBatchId: 'b1',
    sourceTaskId: 't1',
    sourceModelId: 'gpt-image-2',
    mediaType: 'image',
    assetId: 'asset-src',
  });
  expect(node).toBeTruthy();
  if (!node) throw new Error('source 资产节点创建失败');
  return node as GraphNode<AssetNodeData>;
};

describe('createDerivedAssetNode（加工产出 = 独立资产节点 + 血缘，spec 媒体工具加工）', () => {
  beforeEach(() => {
    resetStore();
    const graph = createNodeGraph(createTestNodeGraphParams('测试画板'));
    useCanvasStore.setState((state) => {
      state.nodeGraph = graph;
    });
    useCanvasStore.getState().setProjectMediaAssets(
      { 'asset-src': createMediaAsset('asset-src', '/project-media/prj_demo/src.png') },
      { source: 'user-action' },
    );
  });

  it('产出资产节点携带 derivedFrom 血缘、独立落位、源节点不变', () => {
    const source = addSourceAssetNode();
    const selectCalls: Array<{ nodeIds: string[]; reason: string }> = [];

    const created = createDerivedAssetNode({
      sourceNodeId: source.id,
      assetId: 'asset-derived',
      mediaAsset: createMediaAsset('asset-derived', '/project-media/prj_demo/derived.png'),
      mediaType: 'image',
      derivedFrom: { sourceAssetId: 'asset-src', tool: 'crop' },
      label: '裁剪图片',
      selectNodes: (nodeIds, reason) => selectCalls.push({ nodeIds, reason }),
    });

    expect(created).toBeTruthy();
    const graph = requireGraph();
    const derived = graph.nodes.find((n) => n.id === created?.id);
    expect(derived?.type).toBe('asset');
    const data = derived?.data as AssetNodeData;
    expect(data.assetId).toBe('asset-derived');
    expect(data.derivedFrom).toEqual({ sourceAssetId: 'asset-src', tool: 'crop' });
    expect(data.sourceTaskId).toBe('');
    // 非破坏：源资产节点与源资产 id 不变
    const src = graph.nodes.find((n) => n.id === source.id);
    expect((src?.data as AssetNodeData).assetId).toBe('asset-src');
    // 血缘由节点 data 承载，不产生其他画布关系
    expect(selectCalls).toEqual([{ nodeIds: [created?.id ?? ''], reason: 'asset-derivation' }]);
    // 结果资产注册进 mediaAssets
    expect(useCanvasStore.getState().mediaAssets['asset-derived']).toBeTruthy();
  });

  it('源节点不存在 → null 留痕，不产出节点', () => {
    const created = createDerivedAssetNode({
      sourceNodeId: 'missing',
      assetId: 'asset-derived',
      mediaAsset: null,
      mediaType: 'image',
      derivedFrom: { sourceAssetId: 'asset-src', tool: 'crop' },
    });
    expect(created).toBeNull();
    expect(requireGraph().nodes.every((n) => (n.data as AssetNodeData).assetId !== 'asset-derived')).toBe(true);
  });

  it('缺 assetId → null（前置校验：参数未就位不提交）', () => {
    const source = addSourceAssetNode();
    expect(
      createDerivedAssetNode({
        sourceNodeId: source.id,
        assetId: '',
        mediaAsset: null,
        mediaType: 'image',
        derivedFrom: { sourceAssetId: 'asset-src', tool: 'crop' },
      }),
    ).toBeNull();
  });
});

describe('扩图任务绑定与结果回填（加工是资产上的动作）', () => {
  beforeEach(() => {
    resetStore();
    const graph = createNodeGraph(createTestNodeGraphParams('测试画板'));
    useCanvasStore.setState((state) => {
      state.nodeGraph = graph;
    });
  });

  it('bindOutpaintTaskToAssetNode 写入 outpaintTaskId', () => {
    const source = addSourceAssetNode();
    bindOutpaintTaskToAssetNode(source.id, 'task-out-1');
    const node = requireGraph().nodes.find((n) => n.id === source.id);
    expect((node?.data as AssetNodeData).outpaintTaskId).toBe('task-out-1');
  });

  it('applyOutpaintResultToAssetNode 换绑结果资产并清除任务锚定', () => {
    const source = addSourceAssetNode();
    bindOutpaintTaskToAssetNode(source.id, 'task-out-1');
    applyOutpaintResultToAssetNode({
      nodeId: source.id,
      resultAssetId: 'asset-out-result',
      mediaAsset: createMediaAsset('asset-out-result', '/project-media/prj_demo/out.png'),
    });
    const node = requireGraph().nodes.find((n) => n.id === source.id);
    const data = node?.data as AssetNodeData;
    expect(data.assetId).toBe('asset-out-result');
    expect(data.outpaintTaskId).toBeUndefined();
    expect(useCanvasStore.getState().mediaAssets['asset-out-result']).toBeTruthy();
  });
});

describe('createDerivedAssetNode 成员关系继承（AG-CN-017 / 成员节点创建落布默认初值）', () => {
  beforeEach(() => {
    resetStore();
    const graph = createNodeGraph(createTestNodeGraphParams('测试画板'));
    useCanvasStore.setState((state) => {
      state.nodeGraph = graph;
    });
    useCanvasStore.getState().setProjectMediaAssets(
      { 'asset-src': createMediaAsset('asset-src', '/project-media/prj_demo/src.png') },
      { source: 'user-action' },
    );
  });

  it('源在组内：派生资产入同组（groupId 继承源节点）', () => {
    const source = addSourceAssetNode();
    const groupId = useCanvasStore.getState().createGroup([source.id], undefined);
    if (groupId === null) throw new Error('建组失败');

    const created = createDerivedAssetNode({
      sourceNodeId: source.id,
      assetId: 'asset-derived',
      mediaAsset: createMediaAsset('asset-derived', '/project-media/prj_demo/derived.png'),
      mediaType: 'image',
      derivedFrom: { sourceAssetId: 'asset-src', tool: 'crop' },
    });

    expect(created).toBeTruthy();
    expect(created?.groupId).toBe(groupId);
  });

  it('源无组：派生资产自由落布（groupId undefined）', () => {
    const source = addSourceAssetNode();

    const created = createDerivedAssetNode({
      sourceNodeId: source.id,
      assetId: 'asset-derived',
      mediaAsset: null,
      mediaType: 'image',
      derivedFrom: { sourceAssetId: 'asset-src', tool: 'crop' },
    });

    expect(created).toBeTruthy();
    expect(created?.groupId).toBeUndefined();
  });
});

describe('createDerivedAssetNodesInGrid（分割/智能切图的批量产出）', () => {
  const createTileMediaAsset = (assetId: string): MediaAsset =>
    createMediaAsset(assetId, `/project-media/prj_demo/${assetId}.png`);

  beforeEach(() => {
    resetStore();
    const graph = createNodeGraph(createTestNodeGraphParams('测试画板'));
    useCanvasStore.setState((state) => {
      state.nodeGraph = graph;
    });
    useCanvasStore.getState().setProjectMediaAssets(
      { 'asset-src': createMediaAsset('asset-src', '/project-media/prj_demo/src.png') },
      { source: 'user-action' },
    );
  });

  it('2×2 四个图块 → 四个资产节点、血缘正确、素材已注册、按源图坐标摆成 2×2、一次性全选', () => {
    const source = addSourceAssetNode();
    const selectCalls: Array<{ nodeIds: string[]; reason: string }> = [];

    const created = createDerivedAssetNodesInGrid({
      sourceNodeId: source.id,
      mediaType: 'image',
      derivedFrom: { sourceAssetId: 'asset-src', tool: 'split' },
      sourceSize: { width: 200, height: 200 },
      items: [
        { assetId: 'asset-tile-0', mediaAsset: createTileMediaAsset('asset-tile-0'), label: '图块 0', sourceRect: { x: 0, y: 0, width: 100, height: 100 }, row: 0, col: 0 },
        { assetId: 'asset-tile-1', mediaAsset: createTileMediaAsset('asset-tile-1'), label: '图块 1', sourceRect: { x: 100, y: 0, width: 100, height: 100 }, row: 0, col: 1 },
        { assetId: 'asset-tile-2', mediaAsset: createTileMediaAsset('asset-tile-2'), label: '图块 2', sourceRect: { x: 0, y: 100, width: 100, height: 100 }, row: 1, col: 0 },
        { assetId: 'asset-tile-3', mediaAsset: createTileMediaAsset('asset-tile-3'), label: '图块 3', sourceRect: { x: 100, y: 100, width: 100, height: 100 }, row: 1, col: 1 },
      ],
      selectNodes: (nodeIds, reason) => selectCalls.push({ nodeIds, reason }),
    });

    expect(created).toHaveLength(4);
    const graph = requireGraph();
    const createdIds = (created ?? []).map((node) => node.id);
    const state = useCanvasStore.getState();

    for (const nodeId of createdIds) {
      const node = graph.nodes.find((entry) => entry.id === nodeId);
      expect(node?.type).toBe('asset');
      const data = node?.data as AssetNodeData;
      expect(data.derivedFrom).toEqual({ sourceAssetId: 'asset-src', tool: 'split' });
      expect(data.assetId).toMatch(/^asset-tile-\d$/);
      // 产出资产注册进项目媒体资产表
      expect(state.mediaAssets[data.assetId]).toBeTruthy();
    }

    // 血缘与内容：每块各自独立，不合并成单节点
    const assetIds = createdIds.map((nodeId) => {
      const node = graph.nodes.find((entry) => entry.id === nodeId);
      return (node?.data as AssetNodeData).assetId;
    });
    expect(new Set(assetIds).size).toBe(4);

    // 按源图坐标摆成 2×2：第 1 行 x 不同 y 相同，第 1 列 y 不同 x 相同（不是纵向长列）
    const positions = createdIds.map((nodeId) => {
      const node = graph.nodes.find((entry) => entry.id === nodeId);
      return node?.position ?? { x: 0, y: 0 };
    });
    const [p0, p1, p2, p3] = positions as [
      { x: number; y: number },
      { x: number; y: number },
      { x: number; y: number },
      { x: number; y: number },
    ];
    expect(p1.x).toBeGreaterThan(p0.x);
    expect(p1.y).toBe(p0.y);
    expect(p2.x).toBe(p0.x);
    expect(p2.y).toBeGreaterThan(p0.y);
    expect(p3.x).toBeGreaterThan(p0.x);
    expect(p3.y).toBeGreaterThan(p0.y);

    // 同批不重叠（按展示尺寸估算口径）
    for (const [i, a] of positions.entries()) {
      for (const [j, b] of positions.entries()) {
        if (j <= i) continue;
        const dx = Math.abs(a.x - b.x);
        const dy = Math.abs(a.y - b.y);
        expect(dx >= DERIVED_NODE_WIDTH_ESTIMATE || dy >= DERIVED_NODE_HEIGHT_ESTIMATE).toBe(true);
      }
    }

    // 整批一次选中
    expect(selectCalls).toEqual([{ nodeIds: createdIds, reason: 'asset-derivation' }]);

    // 非破坏：源资产节点不变
    const sourceAfter = graph.nodes.find((node) => node.id === source.id);
    expect((sourceAfter?.data as AssetNodeData).assetId).toBe('asset-src');
  });

  it('智能切图按每一块在原图中的真实 x/y 排列（左右 / 上下关系保持）', () => {
    const source = addSourceAssetNode();

    const created = createDerivedAssetNodesInGrid({
      sourceNodeId: source.id,
      mediaType: 'image',
      derivedFrom: { sourceAssetId: 'asset-src', tool: 'smartSplit' },
      sourceSize: { width: 1000, height: 1000 },
      items: [
        { assetId: 'el-0', mediaAsset: createTileMediaAsset('el-0'), label: '元素 0', sourceRect: { x: 0, y: 0, width: 100, height: 100 } },
        { assetId: 'el-1', mediaAsset: createTileMediaAsset('el-1'), label: '元素 1', sourceRect: { x: 400, y: 0, width: 100, height: 100 } },
        { assetId: 'el-2', mediaAsset: createTileMediaAsset('el-2'), label: '元素 2', sourceRect: { x: 0, y: 500, width: 100, height: 100 } },
      ],
    });

    expect(created).toHaveLength(3);
    const graph = requireGraph();
    const byAssetId = new Map(
      (created ?? []).map((node) => {
        const live = graph.nodes.find((entry) => entry.id === node.id);
        return [(live?.data as AssetNodeData).assetId, live?.position ?? { x: 0, y: 0 }] as const;
      }),
    );
    const p0 = byAssetId.get('el-0');
    const p1 = byAssetId.get('el-1');
    const p2 = byAssetId.get('el-2');
    if (!p0 || !p1 || !p2) throw new Error('元素节点缺失');
    // 同一行的第二个元素在右侧、与第一个同高
    expect(p1.x).toBeGreaterThan(p0.x);
    expect(p1.y).toBe(p0.y);
    // 下方元素与第一个同列、在其下方（不是单列顺延：两个元素在原图同一行）
    expect(p2.x).toBe(p0.x);
    expect(p2.y).toBeGreaterThan(p0.y);
  });

  it('目标位置已有节点 → 整批平移，保持批内相对布局（不逐块下推）', () => {
    const source = addSourceAssetNode();
    const blocker = useCanvasStore.getState().addNode('asset', { x: 260, y: 0 }, {
      label: '占位',
      sourceBatchId: '',
      sourceTaskId: '',
      sourceModelId: '',
      mediaType: 'image',
      assetId: 'asset-blocker',
    });
    expect(blocker).toBeTruthy();

    const created = createDerivedAssetNodesInGrid({
      sourceNodeId: source.id,
      mediaType: 'image',
      derivedFrom: { sourceAssetId: 'asset-src', tool: 'split' },
      sourceSize: { width: 200, height: 200 },
      items: [
        { assetId: 'asset-tile-0', mediaAsset: createTileMediaAsset('asset-tile-0'), label: '图块 0', sourceRect: { x: 0, y: 0, width: 100, height: 100 } },
        { assetId: 'asset-tile-1', mediaAsset: createTileMediaAsset('asset-tile-1'), label: '图块 1', sourceRect: { x: 100, y: 0, width: 100, height: 100 } },
        { assetId: 'asset-tile-2', mediaAsset: createTileMediaAsset('asset-tile-2'), label: '图块 2', sourceRect: { x: 0, y: 100, width: 100, height: 100 } },
        { assetId: 'asset-tile-3', mediaAsset: createTileMediaAsset('asset-tile-3'), label: '图块 3', sourceRect: { x: 100, y: 100, width: 100, height: 100 } },
      ],
    });

    expect(created).toHaveLength(4);
    const graph = requireGraph();
    const positions = (created ?? []).map((node) => {
      const live = graph.nodes.find((entry) => entry.id === node.id);
      return live?.position ?? { x: 0, y: 0 };
    });
    const [p0, p1, p2, p3] = positions as [
      { x: number; y: number },
      { x: number; y: number },
      { x: number; y: number },
      { x: number; y: number },
    ];
    // 整批被移到占位节点右侧，但批内 2×2 的相对关系不变
    expect(p0.x).toBeGreaterThan(260 + DERIVED_NODE_WIDTH_ESTIMATE);
    expect(p1.x - p0.x).toBeGreaterThan(0);
    expect(p1.y).toBe(p0.y);
    expect(p2.x).toBe(p0.x);
    expect(p2.y - p0.y).toBeGreaterThan(0);
    expect(p3.x - p2.x).toBe(p1.x - p0.x);
    expect(p3.y).toBe(p2.y);
    expect(p3.y - p0.y).toBe(p2.y - p0.y);
  });

  it('缺原始几何（只有 row/col）→ 等距网格兜底，仍不重叠', () => {
    const source = addSourceAssetNode();

    const created = createDerivedAssetNodesInGrid({
      sourceNodeId: source.id,
      mediaType: 'image',
      derivedFrom: { sourceAssetId: 'asset-src', tool: 'split' },
      items: [
        { assetId: 'asset-tile-0', mediaAsset: null, label: '图块 0', row: 0, col: 0 },
        { assetId: 'asset-tile-1', mediaAsset: null, label: '图块 1', row: 0, col: 1 },
      ],
    });

    expect(created).toHaveLength(2);
    const graph = requireGraph();
    const positions = (created ?? []).map((node) => {
      const live = graph.nodes.find((entry) => entry.id === node.id);
      return live?.position ?? { x: 0, y: 0 };
    });
    expect(positions[1]?.x).toBeGreaterThan(positions[0]?.x ?? 0);
    expect(positions[1]?.y).toBe(positions[0]?.y);
  });

  it('任一图块缺 assetId → 返回 null 且不创建任何节点', () => {
    const source = addSourceAssetNode();
    const selectNodes = vi.fn();

    const created = createDerivedAssetNodesInGrid({
      sourceNodeId: source.id,
      mediaType: 'image',
      derivedFrom: { sourceAssetId: 'asset-src', tool: 'split' },
      items: [
        { assetId: 'asset-tile-0', mediaAsset: createTileMediaAsset('asset-tile-0'), label: '图块 0', row: 0, col: 0 },
        { assetId: '', mediaAsset: null, label: '图块 1', row: 0, col: 1 },
      ],
      selectNodes,
    });

    expect(created).toBeNull();
    expect(selectNodes).not.toHaveBeenCalled();
    const graph = requireGraph();
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]?.id).toBe(source.id);
  });
});
