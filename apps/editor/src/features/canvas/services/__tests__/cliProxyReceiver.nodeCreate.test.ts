// @spec: CLI-056
//
// CLI 代理执行通道 · canvas node create（资产回填画布）测试：
// 真实 store + 真实接收器 → 真实 addNode action；输入经真实 CliProxyCommandSchema 构造
//（契约驱动的命令形状，不手写绕过校验的载荷）。
//
// 覆盖：成功创建资产节点（字段形状 / 组归属 / 一条撤销记录）、无坐标时复用防重叠落位、
// dry-run 零副作用（零节点、零历史、node_id/operation_id 为 null）、未知资产 / 目标非节点组 /
// 目标组不存在 / 只给单轴被拒且画布零改动。

import { beforeEach, describe, expect, it } from 'vitest';

import { CliProxyCommandResponseSchema, CliProxyCommandSchema } from '@iart/contracts';
import type { CliProxyCommandResponse, MediaAsset } from '@iart/contracts';
import { useCanvasStore } from '../../store/canvasStore';
import { createNodeGraph } from '../../types/nodeGraph';
import type { AssetNodeData, GraphNode, GroupNodeData, TextInputNodeData } from '../../types';
import { executeCliProxyCommand } from '../cliProxyReceiver';
import { computeCliPlacementPositions } from '../cliCanvasPlacement';

const createTestGraph = () =>
  createNodeGraph({
    name: 'cli-proxy-node-create-test',
    description: undefined,
    tags: undefined,
    category: undefined,
  });

const makeMediaAsset = (id: string, mediaType: MediaAsset['mediaType']): MediaAsset => ({
  id,
  mediaType,
  original: {
    url: `local-media://spid_test/${id}.png`,
    projectRef: null,
    fileKey: `${id}.png`,
    sourceUrl: null,
    sourceFileName: null,
    mimeType: mediaType === 'video' ? 'video/mp4' : 'image/png',
    sizeBytes: 10,
    width: 1024,
    height: 768,
    durationMs: null,
    fps: null,
  },
  thumbnail: {
    url: null,
    mimeType: null,
    width: null,
    height: null,
    status: 'missing',
    generatedAt: null,
    error: null,
  },
  lifecycle: { createdAt: 1, updatedAt: 1 },
});

const resetStore = () => {
  useCanvasStore.setState((state) => {
    state.nodeGraph = null;
    state.mediaAssets = {};
    state.selectedNodeIds = [];
    state.selectedAnnotationIds = [];
    state.history = [];
    state.historyIndex = -1;
    state.historyBatchActive = false;
    state.ui.canvasContainerSize = { width: 1440, height: 900 };
  });
};

const seedMediaAssets = (assets: readonly MediaAsset[]): void => {
  useCanvasStore.getState().setProjectMediaAssets(
    Object.fromEntries(assets.map((asset) => [asset.id, asset])),
    { source: 'user-action' },
  );
};

const addGroupNode = (id: string): void => {
  const node: GraphNode<GroupNodeData> = {
    id,
    type: 'group',
    position: { x: 0, y: 0 },
    data: {
      label: '节点组',
      description: undefined,
      runtimeRef: undefined,
      name: `组-${id}`,
      collapsed: false,
      color: '#22C55E',
    },
    draggable: true,
    size: undefined,
    style: undefined,
    groupId: undefined,
  };
  useCanvasStore.setState((state) => {
    if (state.nodeGraph) {
      state.nodeGraph.nodes.push(node);
      state.structureRevision += 1;
    }
  });
};

const addTextInputNode = (id: string): void => {
  const node: GraphNode<TextInputNodeData> = {
    id,
    type: 'textInput',
    position: { x: 0, y: 0 },
    data: {
      label: undefined,
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
    },
    draggable: true,
    size: undefined,
    style: undefined,
    groupId: undefined,
  };
  useCanvasStore.setState((state) => {
    if (state.nodeGraph) {
      state.nodeGraph.nodes.push(node);
      state.structureRevision += 1;
    }
  });
};

const assetNodes = (): GraphNode<AssetNodeData>[] =>
  (useCanvasStore.getState().nodeGraph?.nodes ?? []).filter(
    (node): node is GraphNode<AssetNodeData> => node.type === 'asset',
  );

const parseResponse = (raw: unknown): CliProxyCommandResponse =>
  CliProxyCommandResponseSchema.parse(raw);

/** 用真实契约构造代理命令（输入从契约源头产生，不由测试手工捏造形状）。 */
const buildCommand = (body: Record<string, unknown>) =>
  CliProxyCommandSchema.parse({ command: 'canvas.node.create', request_id: 'req-nc', ...body });

describe('canvas node create（资产回填画布，CLI-056）', () => {
  beforeEach(async () => {
    resetStore();
    await useCanvasStore.getState().loadNodeGraph(createTestGraph());
    // 建一个历史基线（生产环境项目加载后即存在），使「一次创建 = 一条撤销记录」可直接比较。
    useCanvasStore.getState().saveToHistory();
  });

  it('成功：创建资产节点（assetId/mediaType/来源三字段）、落位给定坐标、入组成员、一条撤销记录', async () => {
    seedMediaAssets([makeMediaAsset('asset-1', 'image')]);
    addGroupNode('g-1');
    const historyBefore = useCanvasStore.getState().history.length;

    const response = parseResponse(
      await executeCliProxyCommand(
        buildCommand({
          asset: 'asset-1',
          group: 'g-1',
          x: 120,
          y: -40,
          source_batch_id: 'batch-1',
          source_task_id: 'task-1',
          source_model_id: 'model-a',
        }),
      ),
    );
    if (response.command !== 'canvas.node.create' || 'error' in response) {
      throw new Error('expected node create success response');
    }

    expect(response.dry_run).toBe(false);
    expect(response.asset_id).toBe('asset-1');
    expect(response.group_id).toBe('g-1');
    expect(typeof response.node_id).toBe('string');
    expect(typeof response.operation_id).toBe('string');
    expect(response.position).toEqual({ x: 120, y: -40 });

    const [node] = assetNodes();
    expect(node?.id).toBe(response.node_id);
    expect(node?.type).toBe('asset');
    expect(node?.position).toEqual({ x: 120, y: -40 });
    expect(node?.groupId).toBe('g-1');
    expect(node?.data).toMatchObject({
      assetId: 'asset-1',
      mediaType: 'image',
      sourceBatchId: 'batch-1',
      sourceTaskId: 'task-1',
      sourceModelId: 'model-a',
    });

    // 一次创建 = 一条撤销记录（addNode 既有行为，非合批态自行入栈）
    expect(useCanvasStore.getState().history.length).toBe(historyBefore + 1);
  });

  it('导入素材无生成来源：三字段落空串（AssetNodeData 的非空 string 口径），不伪造来源', async () => {
    seedMediaAssets([makeMediaAsset('asset-imp', 'video')]);

    const response = parseResponse(
      await executeCliProxyCommand(buildCommand({ asset: 'asset-imp' })),
    );
    if (response.command !== 'canvas.node.create' || 'error' in response) {
      throw new Error('expected node create success response');
    }
    const [node] = assetNodes();
    expect(node?.data).toMatchObject({
      assetId: 'asset-imp',
      mediaType: 'video',
      sourceBatchId: '',
      sourceTaskId: '',
      sourceModelId: '',
    });
    expect(response.group_id).toBeNull();
  });

  it('无坐标：复用导入链的防重叠落位（同一几何源 computeCliPlacementPositions）', async () => {
    seedMediaAssets([makeMediaAsset('asset-1', 'image')]);
    const planned = computeCliPlacementPositions(['asset']);
    const expected = planned?.[0];
    if (expected === undefined) throw new Error('expected placement');

    const response = parseResponse(await executeCliProxyCommand(buildCommand({ asset: 'asset-1' })));
    if (response.command !== 'canvas.node.create' || 'error' in response) {
      throw new Error('expected node create success response');
    }
    expect(response.position).toEqual(expected);
    expect(assetNodes()[0]?.position).toEqual(expected);
  });

  it('dry-run：只做校验与落位计算，零节点、零历史，node_id/operation_id 为 null', async () => {
    seedMediaAssets([makeMediaAsset('asset-1', 'image')]);
    addGroupNode('g-1');
    const nodesBefore = useCanvasStore.getState().nodeGraph?.nodes.length;
    const historyBefore = useCanvasStore.getState().history.length;

    const response = parseResponse(
      await executeCliProxyCommand(buildCommand({ asset: 'asset-1', group: 'g-1', x: 5, y: 6, dry_run: true })),
    );
    if (response.command !== 'canvas.node.create' || 'error' in response) {
      throw new Error('expected node create success response');
    }
    expect(response).toMatchObject({
      node_id: null,
      operation_id: null,
      dry_run: true,
      asset_id: 'asset-1',
      group_id: 'g-1',
      position: { x: 5, y: 6 },
    });
    expect(useCanvasStore.getState().nodeGraph?.nodes.length).toBe(nodesBefore);
    expect(assetNodes()).toHaveLength(0);
    expect(useCanvasStore.getState().history.length).toBe(historyBefore);
  });

  it('未知资产 → asset_not_found（画布零改动）', async () => {
    seedMediaAssets([makeMediaAsset('asset-1', 'image')]);
    const response = parseResponse(await executeCliProxyCommand(buildCommand({ asset: 'asset-ghost' })));
    if (response.command !== 'canvas.node.create' || !('error' in response)) {
      throw new Error('expected error response');
    }
    expect(response.error.code).toBe('asset_not_found');
    expect(response.error.message).toContain('asset-ghost');
    expect(assetNodes()).toHaveLength(0);
  });

  it('目标不是节点组（普通节点 / Agent 容器）→ command_rejected；目标组不存在 → group_not_found', async () => {
    seedMediaAssets([makeMediaAsset('asset-1', 'image')]);
    addTextInputNode('n-1');

    const notGroup = parseResponse(
      await executeCliProxyCommand(buildCommand({ asset: 'asset-1', group: 'n-1' })),
    );
    if (notGroup.command !== 'canvas.node.create' || !('error' in notGroup)) throw new Error('expected error');
    expect(notGroup.error.code).toBe('command_rejected');

    const missingGroup = parseResponse(
      await executeCliProxyCommand(buildCommand({ asset: 'asset-1', group: 'g-ghost' })),
    );
    if (missingGroup.command !== 'canvas.node.create' || !('error' in missingGroup)) throw new Error('expected error');
    expect(missingGroup.error.code).toBe('group_not_found');
    expect(missingGroup.error.message).toContain('g-ghost');

    expect(assetNodes()).toHaveLength(0);
  });

  it('只给单轴坐标 → command_rejected（执行侧兜底，画布零改动）', async () => {
    seedMediaAssets([makeMediaAsset('asset-1', 'image')]);
    const response = parseResponse(await executeCliProxyCommand(buildCommand({ asset: 'asset-1', x: 10 })));
    if (response.command !== 'canvas.node.create' || !('error' in response)) throw new Error('expected error');
    expect(response.error.code).toBe('command_rejected');
    expect(response.error.message).toContain('--x 与 --y');
    expect(assetNodes()).toHaveLength(0);
  });

  it('同一资产重复放入：允许产生多个资产节点（与重复导入先例一致，不阻断）', async () => {
    seedMediaAssets([makeMediaAsset('asset-1', 'image')]);
    const first = parseResponse(await executeCliProxyCommand(buildCommand({ asset: 'asset-1', x: 0, y: 0 })));
    const second = parseResponse(await executeCliProxyCommand(buildCommand({ asset: 'asset-1', x: 300, y: 0 })));
    if (first.command !== 'canvas.node.create' || 'error' in first) throw new Error('expected success');
    if (second.command !== 'canvas.node.create' || 'error' in second) throw new Error('expected success');
    expect(second.node_id).not.toBe(first.node_id);
    expect(assetNodes()).toHaveLength(2);
  });
});
