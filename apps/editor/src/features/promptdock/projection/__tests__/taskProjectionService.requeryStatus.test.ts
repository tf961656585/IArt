// @spec: FTB-014
import { beforeEach, describe, expect, it } from 'vitest';

import type {
  PromptDockBatchSubmitResponse,
  RuntimeMediaAssetView,
  RuntimeTaskFailure,
  RuntimeTaskOutputView,
  RuntimeTaskView,
  TaskStateNotification,
} from '@iart/contracts';
import { TaskStateNotificationSchema } from '@iart/contracts';

import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import {
  applyTaskStateChanged,
  createTaskProjectionsForAcceptance,
} from '@/features/promptdock/projection/taskProjectionService';
import { createNodeGraph } from '@/features/canvas/types/nodeGraph';
import type { AssetNodeData, GraphNode, TaskNodeData } from '@/features/canvas/types/node';
import { createTestNodeGraphParams } from '@/features/canvas/components/__tests__/fixtures/canvasTestBuilders';

/**
 * 「重新查询结果」状态流（spec：docs/editor/失败任务重新查询-design.md §4.1 / §5）。
 *
 * 真实链路：受理响应创建任务投影 → task:state-changed（failed → polling → succeeded）经共享
 * 契约 schema 校验后驱动投影。断言：
 * - 同一任务节点身份不变（failed → polling 不新建节点、不新建批次）；
 * - 复活时显式清空 failure / errorMessage / 旧进度，不靠 `??` 继承；
 * - 感知到远端任务号（remoteRequestId）供下一步动作矩阵接线；
 * - 成功沿用既有 morph：原任务节点原位变成资产节点。
 */

const GRAPH_ID = 'graph-requery-status';
const TASK_ID = 'task-requery-1';
const MODEL_ID = 'model-a';

const batchId = `batch-requery-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

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
    state.ui.lastMeasuredSizeByNodeId = {};
    state.ui.layoutModelByNodeId = {};
  });
};

const setupGraph = (): void => {
  const graph = createNodeGraph(createTestNodeGraphParams('requery-status'));
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

const findTaskNode = (): GraphNode<TaskNodeData> | null =>
  requireGraph().nodes.find(
    (node): node is GraphNode<TaskNodeData> =>
      node.type === 'task' && (node.data as TaskNodeData).taskId === TASK_ID,
  ) ?? null;

const findAssetNode = (assetId: string): GraphNode<AssetNodeData> | null =>
  requireGraph().nodes.find(
    (node): node is GraphNode<AssetNodeData> =>
      node.type === 'asset' && (node.data as AssetNodeData).assetId === assetId,
  ) ?? null;

const acceptanceResponse = (): PromptDockBatchSubmitResponse => ({
  batch_id: batchId,
  intent_snapshot: {
    batch_id: batchId,
    model_id: MODEL_ID,
    model_version: '1.0.0',
    prompt: '一只猫',
    params: {},
    task_count: 1,
    task_ids: [TASK_ID],
    created_at: '2026-10-28T00:00:00.000Z',
  },
  tasks: [{ task_id: TASK_ID, task_index: 0 }],
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

const outputRow = (assetId: string): RuntimeTaskOutputView => ({
  outputId: `out-${assetId}`,
  taskId: TASK_ID,
  mediaType: 'image',
  assetId,
  textValue: null,
  sortOrder: 0,
});

const requeryFailure = (): RuntimeTaskFailure => ({
  code: 'TASK_EXECUTION_FAILED',
  message: '查询超时',
  stage: 'polling_timeout',
});

const runtimeTaskView = (params: {
  status: RuntimeTaskView['status'];
  remoteRequestId?: string | null;
  progressPercent?: number;
  progressPhase?: string;
  errorMessage?: string;
  failure?: RuntimeTaskFailure | null;
}): RuntimeTaskView => ({
  taskId: TASK_ID,
  status: params.status,
  projectPath: '/proj',
  batchId,
  metadata: { modelId: MODEL_ID },
  createdAt: 1,
  updatedAt: 2,
  ...(params.remoteRequestId !== undefined ? { remoteRequestId: params.remoteRequestId } : {}),
  ...(params.progressPercent !== undefined ? { progressPercent: params.progressPercent } : {}),
  ...(params.progressPhase !== undefined ? { progressPhase: params.progressPhase } : {}),
  ...(params.errorMessage !== undefined ? { errorMessage: params.errorMessage } : {}),
  ...(params.failure !== undefined ? { failure: params.failure } : {}),
});

const drive = (params: {
  task: RuntimeTaskView;
  assetIds?: string[];
}): void => {
  const assetIds = params.assetIds ?? [];
  const notification: TaskStateNotification = {
    type: 'task:state-changed',
    projectPath: '/proj',
    task: params.task,
    outputs: assetIds.map((assetId) => outputRow(assetId)),
    mediaAssets: assetIds.map((assetId) => mediaAssetView(assetId)),
  };
  // 真实链路同款：通知先过共享契约 schema 再进投影。
  TaskStateNotificationSchema.parse(notification);
  applyTaskStateChanged(notification);
};

const acceptSingleTask = (): void => {
  const accepted = createTaskProjectionsForAcceptance({
    nodeGraphId: GRAPH_ID,
    response: acceptanceResponse(),
    modelId: MODEL_ID,
    referenceAssetIds: [],
    selectCreatedNodes: false,
  });
  if (!accepted.ok) throw new Error(`受理失败：${accepted.reason}`);
};

beforeEach(() => {
  resetStore();
  setupGraph();
});

describe('重新查询状态流：failed → polling → succeeded', () => {
  // @spec: 失败任务重新查询-design.md §4.1
  it('复活保持同一任务节点，清空失败事实与旧进度，成功原位 morph', () => {
    acceptSingleTask();
    const acceptedNode = findTaskNode();
    if (!acceptedNode) throw new Error('受理未创建任务节点');
    const acceptedNodeId = acceptedNode.id;
    const acceptedPosition = acceptedNode.position;
    // 受理期还没有远端任务号。
    expect(acceptedNode.data.remoteRequestId ?? null).toBeNull();

    // 第一次失败：查询类阶段（可重查），带进度与错误摘要。
    drive({
      task: runtimeTaskView({
        status: 'failed',
        remoteRequestId: 'remote-request-1',
        progressPercent: 42,
        progressPhase: 'polling',
        errorMessage: '查询超时',
        failure: requeryFailure(),
      }),
    });

    const failedNode = findTaskNode();
    if (!failedNode) throw new Error('失败后任务节点丢失');
    expect(failedNode.id).toBe(acceptedNodeId);
    expect(failedNode.data.status).toBe('failed');
    expect(failedNode.data.failure?.stage).toBe('polling_timeout');
    expect(failedNode.data.errorMessage).toBe('查询超时');
    expect(failedNode.data.progressPercent).toBe(42);
    expect(failedNode.data.progressPhase).toBe('polling');

    // 重新查询受理后的 polling 通知：后端不带 failure/error/progress（轮询起始态）。
    drive({
      task: runtimeTaskView({
        status: 'polling',
        remoteRequestId: 'remote-request-1',
      }),
    });

    const pollingNode = findTaskNode();
    if (!pollingNode) throw new Error('复活后任务节点丢失');
    // 同一节点身份：不新建节点、不新建批次。
    expect(pollingNode.id).toBe(acceptedNodeId);
    expect(pollingNode.data.status).toBe('polling');
    expect(pollingNode.data.failure).toBeNull();
    expect(pollingNode.data.errorMessage).toBeNull();
    // 旧进度不继承（42 / 'polling' 必须清零，否则等待态继续显示上一次失败的进度）。
    expect(pollingNode.data.progressPercent).toBeNull();
    expect(pollingNode.data.progressPhase).toBeNull();
    // 远端任务号进入本地投影，供动作矩阵/后续接线消费。
    expect(pollingNode.data.remoteRequestId).toBe('remote-request-1');

    // 成功：沿用既有 morph（首个资产原位继任）。
    drive({
      task: runtimeTaskView({
        status: 'succeeded',
        remoteRequestId: 'remote-request-1',
      }),
      assetIds: ['asset-requery-1'],
    });

    expect(findTaskNode()).toBeNull();
    const asset = findAssetNode('asset-requery-1');
    if (!asset) throw new Error('成功产物资产节点缺失');
    expect(asset.position).toEqual(acceptedPosition);
    expect(asset.data.sourceTaskId).toBe(TASK_ID);
    expect(asset.data.sourceBatchId).toBe(batchId);
  });

  // @spec: 失败任务重新查询-design.md §5.3「失败回卡由最新阶段决定按钮」
  it('再次失败回到 failed：新阶段覆盖旧阶段，动作矩阵据最新阶段重算', () => {
    acceptSingleTask();
    drive({
      task: runtimeTaskView({
        status: 'failed',
        remoteRequestId: 'remote-request-1',
        failure: requeryFailure(),
        errorMessage: '查询超时',
      }),
    });
    drive({
      task: runtimeTaskView({
        status: 'polling',
        remoteRequestId: 'remote-request-1',
      }),
    });
    drive({
      task: runtimeTaskView({
        status: 'failed',
        remoteRequestId: 'remote-request-1',
        failure: { code: 'REMOTE_FAILED', message: '服务商判定失败', stage: 'remote_failure' },
        errorMessage: '服务商判定失败',
      }),
    });

    const failedNode = findTaskNode();
    if (!failedNode) throw new Error('再次失败后任务节点丢失');
    expect(failedNode.data.status).toBe('failed');
    expect(failedNode.data.failure?.stage).toBe('remote_failure');
    expect(failedNode.data.errorMessage).toBe('服务商判定失败');
  });
});
