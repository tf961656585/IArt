import { beforeEach, describe, expect, it } from 'vitest';

import type {
  RuntimeMediaAssetView,
  RuntimeTaskOutputView,
  RuntimeTaskView,
  TaskStateNotification,
} from '@iart/contracts';
import { TaskStateNotificationSchema } from '@iart/contracts';

import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import { getGroupMembers } from '@/features/canvas/services/groupMembership';
import {
  applyTaskStateChanged,
} from '@/features/promptdock/projection/taskProjectionService';
import { createNodeGraph } from '@/features/canvas/types/nodeGraph';
import type { AssetNodeData, GraphNode, TaskNodeData } from '@/features/canvas/types/node';
import { createTestNodeGraphParams } from '@/features/canvas/components/__tests__/fixtures/canvasTestBuilders';
import { ASSET_NODE_DEFAULT_SIZE } from '@/features/canvas/nodes/asset/assetNodeFactory';
import { TASK_BATCH_GAP_X, TASK_BATCH_GAP_Y } from '@/features/canvas/utils/taskNodePlacement';

/**
 * 成功任务 morph 的替换继任语义（spec docs/runtime/画布节点组.md AG-CN-017、
 * docs/editor/画布注释.md「替换继任」、docs/promptdock 生成主链成功行）。
 *
 * 任务节点成功后被资产节点原位替换时：
 * - 全部继任资产节点保持任务节点的容器成员身份（容器不因替换变空）；
 * - 任务节点无容器归属时，继任资产节点为自由节点；
 * - 绑定到任务节点的注释改绑首个继任资产节点（不级联删除）；
 * - 选中态不迁移（任务节点随删除清理选中）；
 * - 额外资产落位与提交受理期同一网格步距口径。
 *
 * 宿主搭建沿用画布 store 真实实例 + 真实投影服务（不 mock store）：
 * 输入经共享契约 TaskStateNotificationSchema 校验后喂 applyTaskStateChanged。
 */

const GRAPH_ID = 'graph-morph-membership';

const resetStore = (): void => {
  useCanvasStore.setState((state) => {
    state.nodeGraph = null;
    state.mediaAssets = {};
    state.selectedNodeIds = [];
    state.selectedAnnotationIds = [];
    state.editingAnnotationId = null;
    state.history = [];
    state.historyIndex = -1;
    state.historyBatchActive = false;
    state.deferredHistoryBaseline = null;
    state.hasUnsavedChanges = false;
    state.ui.canvasContainerSize = null;
  });
};

const setupGraph = (): void => {
  const graph = createNodeGraph(createTestNodeGraphParams('morph-membership'));
  graph.id = GRAPH_ID;
  graph.viewport = { x: 0, y: 0, zoom: 1 };
  useCanvasStore.setState((state) => {
    state.nodeGraph = graph;
    state.mediaAssets = {};
  });
};

const requireGraph = (): ReturnType<typeof createNodeGraph> => {
  const graph = useCanvasStore.getState().nodeGraph;
  if (!graph) throw new Error('nodeGraph 为空');
  return graph;
};

const findTaskNodes = (taskId: string): GraphNode<TaskNodeData>[] =>
  requireGraph().nodes.filter(
    (node): node is GraphNode<TaskNodeData> =>
      node.type === 'task' && (node.data as TaskNodeData).taskId === taskId,
  );

const findAssetNodes = (assetId: string): GraphNode<AssetNodeData>[] =>
  requireGraph().nodes.filter(
    (node): node is GraphNode<AssetNodeData> =>
      node.type === 'asset' && (node.data as AssetNodeData).assetId === assetId,
  );

const requireAssetNode = (assetId: string): GraphNode<AssetNodeData> => {
  const node = findAssetNodes(assetId)[0];
  if (!node) throw new Error(`继任资产节点未落画布：${assetId}`);
  return node;
};

const addTaskNode = (taskId: string): GraphNode<TaskNodeData> => {
  const node = useCanvasStore.getState().addNode('task', { x: 320, y: 260 }, {
    label: 'gpt-image-2',
    modelId: 'gpt-image-2',
    taskId,
    taskIndex: 0,
    batchId: 'batch-morph-1',
    status: 'generating',
    progressPercent: null,
    progressPhase: null,
    errorMessage: null,
    failure: null,
    createdAt: 1,
    updatedAt: 1,
  } satisfies TaskNodeData);
  if (!node) throw new Error('任务节点创建失败');
  return node as GraphNode<TaskNodeData>;
};

// ── 运行域夹具（形状与 backend 实际写入一致；无 agentLineage 的普通任务链路）──

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

const runtimeTaskView = (taskId: string): RuntimeTaskView => ({
  taskId,
  status: 'succeeded',
  projectPath: '/proj',
  batchId: 'batch-morph-1',
  metadata: { modelId: 'gpt-image-2' },
  createdAt: 1,
  updatedAt: 2,
});

const stateChanged = (params: { taskId: string; assetIds: string[] }): TaskStateNotification => ({
  type: 'task:state-changed',
  projectPath: '/proj',
  task: runtimeTaskView(params.taskId),
  outputs: params.assetIds.map((assetId) => outputRow(params.taskId, assetId)),
  mediaAssets: params.assetIds.map((assetId) => mediaAssetView(assetId)),
});

beforeEach(() => {
  resetStore();
  setupGraph();
});

describe('成功任务 morph 的替换继任语义（AG-CN-017）', () => {
  // @spec: FTB-006, AG-CN-017
  it('组内任务节点成功：首个资产原位继任并保持组员身份，组存活非空', () => {
    const taskNode = addTaskNode('task-g1');
    const groupId = useCanvasStore.getState().createGroup([taskNode.id], undefined);
    if (groupId === null) throw new Error('建组失败');

    const notification = stateChanged({ taskId: 'task-g1', assetIds: ['asset-g1'] });
    TaskStateNotificationSchema.parse(notification);
    applyTaskStateChanged(notification);

    // 任务节点被替换移除，首个资产原位继任
    expect(findTaskNodes('task-g1')).toHaveLength(0);
    const asset = requireAssetNode('asset-g1');
    expect(asset.position).toEqual(taskNode.position);
    // 成员身份保持：继任资产仍在原组
    expect(asset.groupId).toBe(groupId);
    // 组存活非空：组节点还在，且成员集合含继任资产
    const graph = requireGraph();
    expect(graph.nodes.some((n) => n.id === groupId && n.type === 'group')).toBe(true);
    expect(getGroupMembers(graph, groupId).some((n) => n.id === asset.id)).toBe(true);
  });

  // @spec: AG-CN-017
  it('多产物全部入组，且额外资产与首个资产按受理期同款网格步距排布', () => {
    const taskNode = addTaskNode('task-multi');
    const groupId = useCanvasStore.getState().createGroup([taskNode.id], undefined);
    if (groupId === null) throw new Error('建组失败');

    applyTaskStateChanged(
      stateChanged({
        taskId: 'task-multi',
        assetIds: ['asset-m1', 'asset-m2', 'asset-m3', 'asset-m4'],
      }),
    );

    expect(findTaskNodes('task-multi')).toHaveLength(0);
    const assets = ['asset-m1', 'asset-m2', 'asset-m3', 'asset-m4'].map(requireAssetNode);
    // 全部继任资产保持组员身份
    for (const asset of assets) {
      expect(asset.groupId).toBe(groupId);
    }
    const graph = requireGraph();
    expect(getGroupMembers(graph, groupId)).toHaveLength(4);

    // 网格步距与受理期口径一致（TASK_BATCH_GAP_X/Y + 每行 3 个，锚点为首个资产原位）：
    // asset2 在首行第 3 列、asset4 在第 2 行第 1 列。
    const stepX = ASSET_NODE_DEFAULT_SIZE.width + TASK_BATCH_GAP_X;
    const stepY = ASSET_NODE_DEFAULT_SIZE.height + TASK_BATCH_GAP_Y;
    const firstX = assets[0]?.position.x ?? 0;
    const firstY = assets[0]?.position.y ?? 0;
    expect(assets[1]?.position.x).toBe(firstX + stepX);
    expect(assets[2]?.position.x).toBe(firstX + stepX * 2);
    expect(assets[3]?.position.y).toBe(firstY + stepY);
    // 相邻产物不重叠（间距不小于节点宽）
    expect((assets[1]?.position.x ?? 0) - (assets[0]?.position.x ?? 0)).toBeGreaterThanOrEqual(
      ASSET_NODE_DEFAULT_SIZE.width,
    );
  });

  // @spec: FTB-006
  it('无组任务节点成功：继任资产为自由节点，无悬空 groupId', () => {
    addTaskNode('task-free');

    applyTaskStateChanged(stateChanged({ taskId: 'task-free', assetIds: ['asset-free'] }));

    expect(findTaskNodes('task-free')).toHaveLength(0);
    const asset = requireAssetNode('asset-free');
    expect(asset.groupId).toBeUndefined();
    // 全图无悬空 groupId（指向不存在容器的引用）
    for (const node of requireGraph().nodes) {
      if (typeof node.groupId !== 'string') continue;
      expect(requireGraph().nodes.some((n) => n.id === node.groupId)).toBe(true);
    }
  });

  // @spec: AG-CN-017
  it('绑定任务节点的注释改绑首个继任资产节点，不随替换级联删除', () => {
    const taskNode = addTaskNode('task-ann');
    const annotation = useCanvasStore.getState().addAnnotationForNode(taskNode.id);
    expect(annotation).toBeTruthy();

    applyTaskStateChanged(stateChanged({ taskId: 'task-ann', assetIds: ['asset-ann'] }));

    const asset = requireAssetNode('asset-ann');
    const annotations = requireGraph().annotations ?? [];
    const rebound = annotations.find((ann) => ann.id === annotation?.id);
    expect(rebound).toBeTruthy();
    expect(rebound?.binding).toEqual({ type: 'node', nodeId: asset.id });
  });

  it('替换前选中的任务节点：替换后无选中（不迁移到继任节点）', () => {
    const taskNode = addTaskNode('task-sel');
    useCanvasStore.getState().projectSelectionContract({
      selectedNodeIds: [taskNode.id],
      selectedAnnotationIds: [],
      editingAnnotationId: null,
      pendingAnnotationBinding: null,
    });
    expect(useCanvasStore.getState().selectedNodeIds).toEqual([taskNode.id]);

    applyTaskStateChanged(stateChanged({ taskId: 'task-sel', assetIds: ['asset-sel'] }));

    expect(useCanvasStore.getState().selectedNodeIds).toEqual([]);
  });
});
