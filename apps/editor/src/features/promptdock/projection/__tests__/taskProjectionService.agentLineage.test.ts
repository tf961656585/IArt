import { beforeEach, describe, expect, it } from 'vitest';

import type {
  RuntimeMediaAssetView,
  RuntimeTaskOutputView,
  RuntimeTaskView,
  TaskStateNotification,
  TaskStateSnapshot,
} from '@iart/contracts';
import { AGENT_TASK_LINEAGE_METADATA_KEY, TaskStateNotificationSchema } from '@iart/contracts';

import { buildProjectDelta, useCanvasStore } from '@/features/canvas/store/canvasStore';
import {
  applyTaskStateChanged,
  applyTaskStateSnapshot,
} from '@/features/promptdock/projection/taskProjectionService';
import { createNodeGraph } from '@/features/canvas/types/nodeGraph';
import type { NodeGraph } from '@/features/canvas/types/nodeGraph';
import type { AssetNodeData, GraphNode, NodePosition, TaskNodeData } from '@/features/canvas/types/node';
import { createTestNodeGraphParams } from '@/features/canvas/components/__tests__/fixtures/canvasTestBuilders';
import { ASSET_NODE_DEFAULT_SIZE } from '@/features/canvas/nodes/asset/assetNodeFactory';
import {
  TASK_BATCH_GAP_X,
  TASK_BATCH_GAP_Y,
  computeTaskBatchPlacement,
} from '@/features/canvas/utils/taskNodePlacement';

/**
 * agent 派生任务产物落画布资产节点（spec docs/agent/04「血缘与画布投影」、
 * docs/agent/02「产物资产节点与血缘归属」）。
 *
 * 拍板口径（2026-09-22 容器化改写后）：派生产物默认落为画布资产节点；任务节点仍不落
 * 画布；落位锚定所属 Agent 节点周围聚拢，且**产物自动包含**——创建即建立成员关系
 * （groupId 指向该 Agent 节点，默认初值可拖入/拖出改写）；所属 Agent 节点不存在时退回
 * 默认落位且不建立成员关系；存量历史产物不补落（可经参考区按素材 ID 兜底引用）。
 *
 * 宿主搭建沿用画布 store 真实实例（不 mock store）：落位断言依赖真实
 * computeTaskBatchPlacement + 真实 store.addNode 的合成结果。
 */

const GRAPH_ID = 'graph-agent-products';
const CONTAINER = { width: 1440, height: 900 };

/** 默认视口（0,0,1）+ 1440×900 容器的安全区（fitView padding 20/20/35/20）。 */
const SAFE_RECT = {
  x: CONTAINER.width * 0.2,
  y: CONTAINER.height * 0.2,
  width: CONTAINER.width * 0.6,
  height: CONTAINER.height * (1 - 0.2 - 0.35),
};

const AGENT_SESSION_ID = 'sess-1';

const resetStore = (): void => {
  useCanvasStore.setState((state) => {
    state.nodeGraph = null;
    state.mediaAssets = {};
    state.selectedNodeIds = [];
    state.history = [];
    state.historyIndex = -1;
    state.hasUnsavedChanges = false;
    state.ui.canvasContainerSize = null;
  });
};

const setupGraph = (): void => {
  const graph = createNodeGraph(createTestNodeGraphParams('agent-products'));
  graph.id = GRAPH_ID;
  graph.viewport = { x: 0, y: 0, zoom: 1 };
  useCanvasStore.setState((state) => {
    state.nodeGraph = graph;
    state.mediaAssets = {};
    state.ui.canvasContainerSize = CONTAINER;
  });
};

const requireGraph = (): NodeGraph => {
  const graph = useCanvasStore.getState().nodeGraph;
  if (!graph) throw new Error('nodeGraph 为空');
  return graph;
};

const requireViewport = () => {
  const viewport = requireGraph().viewport;
  if (!viewport) throw new Error('viewport 未设置');
  return viewport;
};

const findAssetNodes = (assetId: string): GraphNode<AssetNodeData>[] =>
  requireGraph().nodes.filter(
    (node): node is GraphNode<AssetNodeData> =>
      node.type === 'asset' && (node.data as AssetNodeData).assetId === assetId,
  );

const requireAssetNode = (assetId: string): GraphNode<AssetNodeData> => {
  const node = findAssetNodes(assetId)[0];
  if (!node) throw new Error(`产物资产节点未落画布：${assetId}`);
  return node;
};

const findTaskNodes = (taskId: string): GraphNode<TaskNodeData>[] =>
  requireGraph().nodes.filter(
    (node): node is GraphNode<TaskNodeData> =>
      node.type === 'task' && (node.data as TaskNodeData).taskId === taskId,
  );

const findAgentNodeById = (nodeId: string): GraphNode | undefined =>
  requireGraph().nodes.find((node) => node.id === nodeId);

/** 产出与宿主 Agent 节点的聚拢关系：x/y 各自不超过 steps 个网格步距。 */
const isClusteredAround = (position: NodePosition, anchor: NodePosition, steps: number): boolean => {
  const dx = Math.abs(position.x - anchor.x);
  const dy = Math.abs(position.y - anchor.y);
  return (
    dx <= steps * (ASSET_NODE_DEFAULT_SIZE.width + TASK_BATCH_GAP_X) &&
    dy <= steps * (ASSET_NODE_DEFAULT_SIZE.height + TASK_BATCH_GAP_Y)
  );
};

const rectsOverlap = (left: NodePosition, right: NodePosition): boolean =>
  left.x < right.x + ASSET_NODE_DEFAULT_SIZE.width &&
  right.x < left.x + ASSET_NODE_DEFAULT_SIZE.width &&
  left.y < right.y + ASSET_NODE_DEFAULT_SIZE.height &&
  right.y < left.y + ASSET_NODE_DEFAULT_SIZE.height;

const insideRect = (position: NodePosition, rect: typeof SAFE_RECT): boolean =>
  position.x >= rect.x &&
  position.y >= rect.y &&
  position.x + ASSET_NODE_DEFAULT_SIZE.width <= rect.x + rect.width &&
  position.y + ASSET_NODE_DEFAULT_SIZE.height <= rect.y + rect.height;

/**
 * 无锚点时的默认落位基底期望：与实现共用同一抽象（computeTaskBatchPlacement，
 * 安全区优先 + 网格步距防重叠 + 环形搜索），不另写平行落位算法。
 */
const defaultPlacementBase = (nodes: ReadonlyArray<GraphNode>): NodePosition =>
  computeTaskBatchPlacement({
    viewport: requireViewport(),
    containerSize: useCanvasStore.getState().ui.canvasContainerSize,
    nodes,
    count: 1,
    nodeSize: ASSET_NODE_DEFAULT_SIZE,
    perRow: 3,
    referencePositions: [],
  }).base;

const seedAgentNode = (position: NodePosition, agentSessionId: string = AGENT_SESSION_ID): GraphNode => {
  const node = useCanvasStore.getState().addNode('agent', position, { agentSessionId });
  if (!node) throw new Error('Agent 节点创建失败');
  return node;
};

// ── 运行域夹具（形状与 backend 实际写入一致：metadata.modelId + metadata.agentLineage）──

const mediaAssetView = (assetId: string): RuntimeMediaAssetView => ({
  assetId,
  mediaType: 'image',
  original: {
    url: `local-media://project-a/images/${assetId}.png`,
    sourceFileName: null,
    projectRef: 'project-a',
    fileKey: `images/${assetId}.png`,
    sourceUrl: `https://remote.example/${assetId}.png`,
    mimeType: 'image/png',
    sizeBytes: 1024,
    width: 800,
    height: 600,
    durationMs: null,
    fps: null,
  },
  thumbnail: {
    url: `local-media://project-a/thumbs/${assetId}.png`,
    mimeType: 'image/png',
    width: 200,
    height: 150,
    status: 'ready',
    generatedAt: 1,
    error: null,
  },
  lifecycle: { createdAt: 1, updatedAt: 1 },
});

const outputRow = (taskId: string, assetId: string): RuntimeTaskOutputView => ({
  outputId: `out-${assetId}`,
  taskId,
  mediaType: 'image',
  assetId,
  textValue: null,
  sortOrder: 0,
});

const runtimeTaskView = (params: {
  taskId: string;
  status?: RuntimeTaskView['status'];
  batchId?: string;
  agentSessionId?: string | null;
}): RuntimeTaskView => {
  const lineage =
    params.agentSessionId === null
      ? null
      : { agentSessionId: params.agentSessionId ?? AGENT_SESSION_ID, toolCallId: 'call-1' };
  return {
    taskId: params.taskId,
    status: params.status ?? 'succeeded',
    projectPath: '/proj',
    batchId: params.batchId ?? 'batch-agent-1',
    metadata: {
      modelId: 'gpt-image-2',
      model_id: 'gpt-image-2',
      batchId: params.batchId ?? 'batch-agent-1',
      ...(lineage ? { [AGENT_TASK_LINEAGE_METADATA_KEY]: lineage } : {}),
    },
    createdAt: 1,
    updatedAt: 2,
  };
};

const stateChanged = (params: {
  taskId: string;
  assetId: string;
  status?: RuntimeTaskView['status'];
  batchId?: string;
  agentSessionId?: string | null;
}): TaskStateNotification => ({
  type: 'task:state-changed',
  projectPath: '/proj',
  task: runtimeTaskView(params),
  outputs: [outputRow(params.taskId, params.assetId)],
  mediaAssets: [mediaAssetView(params.assetId)],
});

beforeEach(() => {
  resetStore();
  setupGraph();
});

describe('agent 派生任务产物的画布投影', () => {
  // @spec: AG-EX-001
  it('派生任务成功：产物落为画布资产节点，任务节点不落画布', () => {
    // 夹具先过共享契约校验：证明测试输入是合法的 task:state-changed 形状。
    const notification = stateChanged({ taskId: 'task-agent-1', assetId: 'asset-p1' });
    TaskStateNotificationSchema.parse(notification);

    applyTaskStateChanged(notification);

    const assetNodes = findAssetNodes('asset-p1');
    expect(assetNodes).toHaveLength(1);
    expect(requireAssetNode('asset-p1').data).toMatchObject({
      assetId: 'asset-p1',
      sourceTaskId: 'task-agent-1',
      sourceBatchId: 'batch-agent-1',
      sourceModelId: 'gpt-image-2',
      mediaType: 'image',
    });
    // 任务节点仍不落画布（agent 派生任务无任务节点投影）
    expect(findTaskNodes('task-agent-1')).toHaveLength(0);
    // 产物是正式资产：媒体记录并入画布资产注册表，可被引用
    expect(useCanvasStore.getState().mediaAssets['asset-p1']).toBeTruthy();
  });

  // @spec: AG-NP-001
  it('落位锚定所属 Agent 节点周围聚拢：连续产物同簇、不落回安全区中心、不移动视口', () => {
    const agentNode = seedAgentNode({ x: 900, y: 500 });
    const viewportBefore = { ...requireViewport() };
    const defaultBase = defaultPlacementBase(requireGraph().nodes);

    applyTaskStateChanged(stateChanged({ taskId: 'task-agent-1', assetId: 'asset-p1' }));
    const first = requireAssetNode('asset-p1');
    // 锚定所属 Agent 节点周围聚拢（相邻一个网格步距内），而非落回安全区中心
    expect(isClusteredAround(first.position, agentNode.position, 1)).toBe(true);
    expect(first.position).not.toEqual(defaultBase);

    // 同一会话的连续产物：仍以该 Agent 节点为锚点，且互不重叠
    applyTaskStateChanged(stateChanged({ taskId: 'task-agent-2', assetId: 'asset-p2' }));
    const second = requireAssetNode('asset-p2');
    expect(isClusteredAround(second.position, agentNode.position, 2)).toBe(true);
    expect(second.position).not.toEqual(first.position);

    // 落位不移动视口
    expect(requireViewport()).toEqual(viewportBefore);
  });

  // @spec: AG-NP-002
  it('所属 Agent 节点不存在：退回默认落位（安全区优先），不移动视口、不建立成员关系', () => {
    // 所属 Agent 节点不存在（已删除 / 恢复后尚未重建）
    const viewportBefore = { ...requireViewport() };
    const expected = defaultPlacementBase(requireGraph().nodes);

    applyTaskStateChanged(stateChanged({ taskId: 'task-agent-1', assetId: 'asset-p1' }));

    // 不因缺锚点失败或被丢弃
    const product = requireAssetNode('asset-p1');
    // 退回默认落位：安全区优先
    expect(insideRect(product.position, SAFE_RECT)).toBe(true);
    expect(product.position).toEqual(expected);
    // 无锚点不建立成员关系（spec 02 AG-NP-002 Then）
    expect(product.groupId).toBeUndefined();
    // 不移动视口
    expect(requireViewport()).toEqual(viewportBefore);
  });

  // @spec: AG-NP-002
  it('缺锚点且安全区中心被占用：按网格步距让位不重叠，不丢弃', () => {
    // 安全区中心已被既有节点占住：缺锚点落位按网格步距让位，不与既有节点重叠、不丢弃
    const centerBase = defaultPlacementBase(requireGraph().nodes);
    const blocker = seedAgentNode(centerBase, 'other-session');
    expect(blocker.position).toEqual(centerBase);

    applyTaskStateChanged(stateChanged({ taskId: 'task-agent-1', assetId: 'asset-p1' }));

    const product = requireAssetNode('asset-p1');
    expect(rectsOverlap(product.position, blocker.position)).toBe(false);
    expect(insideRect(product.position, SAFE_RECT)).toBe(true);
  });

  // @spec: AG-CT-001
  it('产物自动入容器：产物节点 groupId 指向 Agent 节点，容器属性不新增 group 节点类型', () => {
    const agentNode = seedAgentNode({ x: 900, y: 500 });

    applyTaskStateChanged(stateChanged({ taskId: 'task-agent-1', assetId: 'asset-p1' }));
    applyTaskStateChanged(stateChanged({ taskId: 'task-agent-2', assetId: 'asset-p2' }));

    const products = [...findAssetNodes('asset-p1'), ...findAssetNodes('asset-p2')];
    expect(products).toHaveLength(2);
    for (const product of products) {
      // 产物自动包含（默认初值）：创建即入容器，groupId 指向该 Agent 节点
      expect(product.groupId).toBe(agentNode.id);
    }
    // 容器属性不新增节点类型：Agent 容器仍是 agent 类型，画布不因此出现 group 类型节点
    expect(requireGraph().nodes.some((node) => node.type === 'group')).toBe(false);
    // Agent 节点自身不是任何容器的成员（它是容器，不是成员）
    expect(findAgentNodeById(agentNode.id)?.groupId).toBeUndefined();
  });

  // @spec: AG-CT-001
  it('产物成员关系持久化恢复：buildProjectDelta 出站不剥 groupId，重开画布后成员关系仍在', async () => {
    const agentNode = seedAgentNode({ x: 900, y: 500 });
    applyTaskStateChanged(stateChanged({ taskId: 'task-agent-1', assetId: 'asset-p1' }));
    const product = requireAssetNode('asset-p1');
    expect(product.groupId).toBe(agentNode.id);

    // 保存项目：真实 buildProjectDelta 出站（剥运行时 size，不剥 groupId）
    const { delta } = buildProjectDelta(
      {
        nodeGraph: requireGraph(),
        mediaAssets: useCanvasStore.getState().mediaAssets,
        dirtyRevision: useCanvasStore.getState().dirtyRevision,
        dirty: useCanvasStore.getState().dirty,
      },
      { forceFullReplace: true },
    );
    expect(delta).not.toBeNull();
    const upserted = delta?.nodes?.upsert ?? [];
    const serializedProduct = upserted.find((node) => node.id === product.id);
    expect(serializedProduct?.groupId).toBe(agentNode.id);

    // 重新打开画布：节点 JSON 整存整取（JSON round-trip 模拟持久化边界）→ loadNodeGraph 恢复
    const reopenedGraph: NodeGraph = JSON.parse(
      JSON.stringify({
        ...(delta?.graph ?? {}),
        nodes: upserted,
      }),
    ) as NodeGraph;
    await useCanvasStore.getState().loadNodeGraph(reopenedGraph);

    const restoredProduct = requireAssetNode('asset-p1');
    const restoredAgent = findAgentNodeById(agentNode.id);
    expect(restoredAgent).toBeTruthy();
    // 重开后成员关系仍在，成员节点不丢失、不被重建为自由节点
    expect(restoredProduct.groupId).toBe(agentNode.id);
  });

  // @spec: AG-EX-002
  it('存量历史产物不补落：快照携带已成功任务也不造节点', () => {
    // 存量历史产物：快照携带已成功任务也不补落画布节点
    const snapshot: TaskStateSnapshot = {
      type: 'task:state-snapshot',
      projectPath: '/proj',
      tasks: [runtimeTaskView({ taskId: 'task-agent-history' })],
      taskOutputsByTaskId: { 'task-agent-history': [outputRow('task-agent-history', 'asset-hist')] },
      mediaAssetsByTaskId: { 'task-agent-history': [mediaAssetView('asset-hist')] },
    };

    applyTaskStateSnapshot(snapshot);

    expect(findAssetNodes('asset-hist')).toHaveLength(0);
    expect(requireGraph().nodes.filter((node) => node.type === 'asset')).toHaveLength(0);
  });

  it('非血缘任务成功仍按原位 morph（既有语义不回归）', () => {
    const taskNode = useCanvasStore.getState().addNode('task', { x: 320, y: 260 }, {
      label: 'gpt-image-2',
      modelId: 'gpt-image-2',
      taskId: 'task-plain-1',
      taskIndex: 0,
      batchId: 'batch-plain-1',
      status: 'generating',
      progressPercent: null,
      progressPhase: null,
      errorMessage: null,
      failure: null,
      createdAt: 1,
      updatedAt: 1,
    } satisfies TaskNodeData);
    if (!taskNode) throw new Error('任务节点创建失败');

    applyTaskStateChanged(
      stateChanged({ taskId: 'task-plain-1', assetId: 'asset-plain-1', agentSessionId: null }),
    );

    expect(findAssetNodes('asset-plain-1')).toHaveLength(1);
    expect(requireAssetNode('asset-plain-1').position).toEqual(taskNode.position);
    expect(findTaskNodes('task-plain-1')).toHaveLength(0);
  });

  it('派生产物失败/取消不产生画布节点', () => {
    applyTaskStateChanged(
      stateChanged({ taskId: 'task-agent-failed', assetId: 'asset-failed', status: 'failed' }),
    );
    applyTaskStateChanged(
      stateChanged({ taskId: 'task-agent-cancelled', assetId: 'asset-cancelled', status: 'cancelled' }),
    );

    expect(findAssetNodes('asset-failed')).toHaveLength(0);
    expect(findAssetNodes('asset-cancelled')).toHaveLength(0);
    expect(requireGraph().nodes).toHaveLength(0);
  });
});
