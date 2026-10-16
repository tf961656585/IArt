import { beforeEach, describe, expect, it } from 'vitest';

import type {
  RuntimeMediaAssetView,
  RuntimeTaskOutputView,
  RuntimeTaskView,
  TaskStateNotification,
} from '@iart/contracts';
import { TaskStateNotificationSchema } from '@iart/contracts';
import type { PromptDockBatchSubmitResponse } from '@iart/contracts';

import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import {
  applyTaskStateChanged,
  createTaskProjectionsForAcceptance,
} from '@/features/promptdock/projection/taskProjectionService';
import { createNodeGraph } from '@/features/canvas/types/nodeGraph';
import type { AssetNodeData, GraphNode, TaskNodeData } from '@/features/canvas/types/node';
import { createTestNodeGraphParams } from '@/features/canvas/components/__tests__/fixtures/canvasTestBuilders';
import { ASSET_NODE_DEFAULT_SIZE } from '@/features/canvas/nodes/asset/assetNodeFactory';

/**
 * 成功时刻追加资产防重叠（方案一成功侧）：
 * - 首个资产原位继任语义不变（位置 = 任务节点原点）；
 * - 同任务追加资产不再无条件网格步进，以继任位置为锚做防重叠搜索，
 *   追加资产两两不重叠、且不与画布既有内容（真实尺寸）重叠。
 *
 * 输入从真实链路源头产生：真实批次受理（createTaskProjectionsForAcceptance）创建任务节点，
 * 通知经共享契约 TaskStateNotificationSchema 校验后喂 applyTaskStateChanged。
 */

const GRAPH_ID = 'graph-success-placement';

// 台账是模块级内存态：每个测试用独立 batchId，杜绝上一例的 finalized 台账污染下一例。
let currentBatchId = 'batch-success-1';
const nextBatchId = (): string => {
  currentBatchId = `batch-success-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  return currentBatchId;
};

const resetStore = (): void => {
  useCanvasStore.setState((state) => {
    state.nodeGraph = null;
    state.mediaAssets = {};
    state.selectedNodeIds = [];
    state.selectedAnnotationIds = [];
    state.editingAnnotationId = null;
    state.pendingAnnotationBinding = null;
    state.history = [];
    state.historyIndex = -1;
    state.historyBatchActive = false;
    state.deferredHistoryBaseline = null;
    state.hasUnsavedChanges = false;
    state.ui.canvasContainerSize = null;
    state.ui.lastMeasuredSizeByNodeId = {};
    state.ui.layoutModelByNodeId = {};
  });
};

const setupGraph = (): void => {
  const graph = createNodeGraph(createTestNodeGraphParams('success-placement'));
  graph.id = GRAPH_ID;
  graph.viewport = { x: 0, y: 0, zoom: 1 };
  useCanvasStore.setState((state) => {
    state.nodeGraph = graph;
    state.mediaAssets = {};
    state.ui.canvasContainerSize = { width: 1440, height: 900 };
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

const findAssetNodesByTask = (taskId: string): GraphNode<AssetNodeData>[] =>
  requireGraph().nodes.filter(
    (node): node is GraphNode<AssetNodeData> =>
      node.type === 'asset' && (node.data as AssetNodeData).sourceTaskId === taskId,
  );

const makeTaskData = (taskId: string, batchId: string, taskIndex: number): TaskNodeData => ({
  label: 'model-a',
  modelId: 'model-a',
  taskId,
  taskIndex,
  batchId,
  status: 'generating',
  progressPercent: null,
  progressPhase: null,
  errorMessage: null,
  failure: null,
  createdAt: 1,
  updatedAt: 1,
});

// ── 受理响应与运行域夹具（形状与 backend 实际写入一致）──

const acceptanceResponse = (batchId: string, taskCount: number): PromptDockBatchSubmitResponse => ({
  batch_id: batchId,
  intent_snapshot: {
    batch_id: batchId,
    model_id: 'model-a',
    model_version: '1.0.0',
    prompt: '一只猫',
    params: {},
    task_count: taskCount,
    task_ids: Array.from({ length: taskCount }, (_, index) => `task_${index + 1}`),
    created_at: '2026-10-15T00:00:00.000Z',
  },
  tasks: Array.from({ length: taskCount }, (_, index) => ({
    task_id: `task_${index + 1}`,
    task_index: index,
  })),
});

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

const outputRow = (taskId: string, assetId: string, sortOrder: number): RuntimeTaskOutputView => ({
  outputId: `out-${assetId}`,
  taskId,
  mediaType: 'image',
  assetId,
  textValue: null,
  sortOrder,
});

const runtimeTaskView = (taskId: string, status: RuntimeTaskView['status']): RuntimeTaskView => ({
  taskId,
  status,
  projectPath: '/proj',
  batchId: currentBatchId,
  metadata: { modelId: 'model-a' },
  createdAt: 1,
  updatedAt: 2,
});

const stateChanged = (params: {
  taskId: string;
  status: RuntimeTaskView['status'];
  assetIds: string[];
}): TaskStateNotification => ({
  type: 'task:state-changed',
  projectPath: '/proj',
  task: runtimeTaskView(params.taskId, params.status),
  outputs: params.assetIds.map((assetId, index) => outputRow(params.taskId, assetId, index)),
  mediaAssets: params.assetIds.map((assetId) => mediaAssetView(assetId)),
});

const rectsIntersect = (
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;

beforeEach(() => {
  resetStore();
  setupGraph();
});

describe('成功时刻追加资产防重叠', () => {
  it('追加资产不与真实尺寸既有节点重叠（无条件网格步进被替换为防重叠搜索）', () => {
    // 批次含 2 个任务且只驱动 task_1：批次未收口，隔离 morph 时刻语义
    //（批次收口重排是另一阶段，由 batchCompletion 测试覆盖）。
    const accepted = createTaskProjectionsForAcceptance({
      nodeGraphId: GRAPH_ID,
      response: acceptanceResponse(nextBatchId(), 2),
      modelId: 'model-a',
      referenceAssetIds: [],
      selectCreatedNodes: true,
    });
    expect(accepted.ok).toBe(true);

    const taskNode = findTaskNodes('task_1')[0];
    if (!taskNode) throw new Error('受理未创建任务节点');
    const origin = taskNode.position;

    // 既有障碍节点：实测 700×600，恰好覆盖追加资产的经典网格位（原点右侧第 1、2 列），
    // 不覆盖首个资产的原点位（原位继任语义不受影响）。
    const obstacle = useCanvasStore.getState().addNode(
      'task',
      { x: origin.x + ASSET_NODE_DEFAULT_SIZE.width + 40, y: origin.y - 100 },
      makeTaskData('task-obstacle', 'batch-obstacle', 0),
    );
    if (!obstacle) throw new Error('障碍节点创建失败');
    // 有效尺寸最高优先档是 Layout Model（真实链路里 addNode 即重算）；测试用它钉住障碍真实占位
    useCanvasStore.setState((state) => {
      state.ui.layoutModelByNodeId = {
        [obstacle.id]: { width: 700, height: 600 },
      };
    });
    const obstacleRect = {
      x: origin.x + ASSET_NODE_DEFAULT_SIZE.width + 40,
      y: origin.y - 100,
      width: 700,
      height: 600,
    };

    const notification = stateChanged({
      taskId: 'task_1',
      status: 'succeeded',
      assetIds: ['asset-1', 'asset-2', 'asset-3'],
    });
    TaskStateNotificationSchema.parse(notification);
    applyTaskStateChanged(notification);

    expect(findTaskNodes('task_1')).toHaveLength(0);
    const assets = findAssetNodesByTask('task_1');
    expect(assets).toHaveLength(3);

    // 首个资产原位继任语义不变
    const first = assets.find((node) => (node.data as AssetNodeData).assetId === 'asset-1');
    if (!first) throw new Error('首个继任资产缺失');
    expect(first.position).toEqual(origin);

    // 追加资产（第 2、3 个）不得与障碍节点真实占位相交
    const extras = assets.filter((node) => node.id !== first.id);
    expect(extras).toHaveLength(2);
    for (const extra of extras) {
      expect(
        rectsIntersect(
          { x: extra.position.x, y: extra.position.y, width: ASSET_NODE_DEFAULT_SIZE.width, height: ASSET_NODE_DEFAULT_SIZE.height },
          obstacleRect,
        ),
        '追加资产与既有节点真实占位相交',
      ).toBe(false);
      // 也不与首个继任资产相交
      expect(
        rectsIntersect(
          { x: extra.position.x, y: extra.position.y, width: ASSET_NODE_DEFAULT_SIZE.width, height: ASSET_NODE_DEFAULT_SIZE.height },
          { x: origin.x, y: origin.y, width: ASSET_NODE_DEFAULT_SIZE.width, height: ASSET_NODE_DEFAULT_SIZE.height },
        ),
        '追加资产与首个继任资产相交',
      ).toBe(false);
    }
    // 追加资产两两不重叠（矩形判定）
    for (const a of extras) {
      for (const b of extras) {
        if (a.id >= b.id) continue;
        expect(
          rectsIntersect(
            { x: a.position.x, y: a.position.y, width: ASSET_NODE_DEFAULT_SIZE.width, height: ASSET_NODE_DEFAULT_SIZE.height },
            { x: b.position.x, y: b.position.y, width: ASSET_NODE_DEFAULT_SIZE.width, height: ASSET_NODE_DEFAULT_SIZE.height },
          ),
          '追加资产两两相交',
        ).toBe(false);
      }
    }
  });

  it('锚点空闲时追加资产按网格口径排布且收口不二次移动（锚点=首个资产原位）', () => {
    // 单任务批次：收口重排的网格与 morph 网格同口径且锚点空闲，收口后位置不变（收口无操作）。
    const accepted = createTaskProjectionsForAcceptance({
      nodeGraphId: GRAPH_ID,
      response: acceptanceResponse(nextBatchId(), 1),
      modelId: 'model-a',
      referenceAssetIds: [],
      selectCreatedNodes: true,
    });
    expect(accepted.ok).toBe(true);

    applyTaskStateChanged(
      stateChanged({
        taskId: 'task_1',
        status: 'succeeded',
        assetIds: ['asset-a1', 'asset-a2', 'asset-a3', 'asset-a4'],
      }),
    );

    const assets = ['asset-a1', 'asset-a2', 'asset-a3', 'asset-a4'].map((assetId) => {
      const node = findAssetNodesByTask('task_1').find(
        (candidate) => (candidate.data as AssetNodeData).assetId === assetId,
      );
      if (!node) throw new Error(`继任资产缺失：${assetId}`);
      return node;
    });
    const firstX = assets[0]?.position.x ?? 0;
    const firstY = assets[0]?.position.y ?? 0;
    // 空闲场景下与网格口径一致（格子按媒体期望布局尺寸取列最大宽/行最大高，此处媒体
    // 800×600 → 320×240 大于默认 240×180，步距随真实尺寸放大）：第 2、3 个在首行右邻
    // 且互不压叠，第 4 个在第 2 行首列。
    const minAssetWidth = ASSET_NODE_DEFAULT_SIZE.width;
    const minAssetHeight = ASSET_NODE_DEFAULT_SIZE.height;
    expect(assets[1]?.position.x).toBeGreaterThanOrEqual(firstX + minAssetWidth + 40);
    expect(assets[1]?.position.y).toBe(firstY);
    expect(assets[2]?.position.x).toBeGreaterThanOrEqual((assets[1]?.position.x ?? 0) + minAssetWidth);
    expect(assets[2]?.position.y).toBe(firstY);
    expect(assets[3]?.position.x).toBe(firstX);
    expect(assets[3]?.position.y).toBeGreaterThanOrEqual(firstY + minAssetHeight + 40);
  });
});
