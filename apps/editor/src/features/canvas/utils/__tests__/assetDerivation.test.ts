import { beforeEach, describe, expect, it } from 'vitest';
import type { MediaAsset } from '@iart/contracts';
import { createNodeGraph } from '../../types/nodeGraph';
import { useCanvasStore } from '../../store/canvasStore';
import {
  applyOutpaintResultToAssetNode,
  bindOutpaintTaskToAssetNode,
  createDerivedAssetNode,
} from '../assetDerivation';
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

const addSourceAssetNode = (): GraphNode<AssetNodeData> => {
  const node = useCanvasStore.getState().addNode('asset', { x: 0, y: 0 }, {
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
