// @spec: FTB-014
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
import { getGroupMembers } from '@/features/canvas/services/groupMembership';
import {
  applyTaskStateChanged,
  createTaskProjectionsForAcceptance,
} from '@/features/promptdock/projection/taskProjectionService';
import { DEFAULT_SNAP_GRID, createNodeGraph } from '@/features/canvas/types/nodeGraph';
import { alignToGrid } from '@/features/canvas/layout/layoutPrimitives';
import type { AssetNodeData, GraphNode, TaskNodeData } from '@/features/canvas/types/node';
import { createTestNodeGraphParams } from '@/features/canvas/components/__tests__/fixtures/canvasTestBuilders';
import { ASSET_NODE_DEFAULT_SIZE } from '@/features/canvas/nodes/asset/assetNodeFactory';
import { TASK_BATCH_GAP_X } from '@/features/canvas/utils/taskNodePlacement';

/**
 * 批次收口整块重排（方案二）：
 * - 触发：批次全部任务到达终态（succeeded/failed/cancelled）时执行一次，挂接在
 *   task:state-changed 终态通知链路上（真实链路：受理 → 投影创建 → 终态通知驱动）；
 * - 自由桶只重排该批已成功产物节点；失败任务节点不进入自由桶；同容器桶按容器内整理排布容器全部显式成员（含失败任务节点）；整批无成功产物不重排；
 * - 自由桶：按 task_index 升序网格（每行 3）整块重排，重排后整块包围盒左上角与重排前一致，
 *   整块经防重叠搜索落位；
 * - 同容器桶：产物归属同一容器时按容器内整理语义排布，成员身份保持、块锚点按 AL-GC-006 吸附到最近网格点；
 * - 单条原子历史记录入撤销栈。
 */

const GRAPH_ID = 'graph-batch-completion';

// 台账是模块级内存态（跨测试共存于同一 worker）：每个测试用独立 batchId，杜绝上一例的
// finalized 台账污染下一例的收口触发。
let currentBatchId = 'batch-completion-1';
const nextBatchId = (): string => {
  currentBatchId = `batch-completion-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  return currentBatchId;
};

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
  const graph = createNodeGraph(createTestNodeGraphParams('batch-completion'));
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

const findTaskNode = (taskId: string): GraphNode<TaskNodeData> | null =>
  requireGraph().nodes.find(
    (node): node is GraphNode<TaskNodeData> =>
      node.type === 'task' && (node.data as TaskNodeData).taskId === taskId,
  ) ?? null;

const findAssetNode = (assetId: string): GraphNode<AssetNodeData> => {
  const node = requireGraph().nodes.find(
    (node): node is GraphNode<AssetNodeData> =>
      node.type === 'asset' && (node.data as AssetNodeData).assetId === assetId,
  );
  if (!node) throw new Error(`产物资产节点缺失：${assetId}`);
  return node;
};

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

const acceptBatch = (taskCount: number): void => {
  const accepted = createTaskProjectionsForAcceptance({
    nodeGraphId: GRAPH_ID,
    response: acceptanceResponse(nextBatchId(), taskCount),
    modelId: 'model-a',
    referenceAssetIds: [],
    selectCreatedNodes: true,
  });
  if (!accepted.ok) throw new Error(`受理失败：${accepted.reason}`);
};

const drive = (params: { taskId: string; status: RuntimeTaskView['status']; assetIds: string[] }): void => {
  const notification = stateChanged(params);
  TaskStateNotificationSchema.parse(notification);
  applyTaskStateChanged(notification);
};

const flushAsyncFinalize = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 20));
};

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

describe('批次收口整块重排', () => {
  it('全部终态后自由桶按 task_index 网格重排：失败节点原地保留、包围盒左上角保持、单条历史', async () => {
    acceptBatch(3);
    // 受理期任务节点按网格相邻；散开模拟用户排布
    const t1 = findTaskNode('task_1');
    const t2 = findTaskNode('task_2');
    const t3 = findTaskNode('task_3');
    if (!t1 || !t2 || !t3) throw new Error('受理未创建任务节点');
    useCanvasStore.getState().updateNodePosition(t1.id, { x: 100, y: 100 });
    useCanvasStore.getState().updateNodePosition(t2.id, { x: 1500, y: 800 });
    useCanvasStore.getState().updateNodePosition(t3.id, { x: 2600, y: 1500 });

    drive({ taskId: 'task_1', status: 'succeeded', assetIds: ['asset-1'] });
    drive({ taskId: 'task_2', status: 'succeeded', assetIds: ['asset-2'] });
    const a1 = findAssetNode('asset-1');
    const a2 = findAssetNode('asset-2');
    expect(a1.position).toEqual({ x: 100, y: 100 });
    expect(a2.position).toEqual({ x: 1500, y: 800 });

    // 最后一个任务到达终态 → 批次收口
    const historyLengthBefore = useCanvasStore.getState().history.length;
    drive({ taskId: 'task_3', status: 'failed', assetIds: [] });
    await flushAsyncFinalize();

    // 失败任务节点原地保留
    const failedNode = findTaskNode('task_3');
    expect(failedNode?.position).toEqual({ x: 2600, y: 1500 });

    // 产物按 task_index 升序网格（每行 3）：task_1 产物在前，同排相邻不重叠
    //（列宽按成员真实有效尺寸取 max，间隔固定 40，不钉死具体宽度）
    const rearrangedA1 = findAssetNode('asset-1');
    const rearrangedA2 = findAssetNode('asset-2');
    expect(rearrangedA1.position).toEqual({ x: 100, y: 100 });
    expect(rearrangedA2.position.x).toBeGreaterThanOrEqual(
      rearrangedA1.position.x + ASSET_NODE_DEFAULT_SIZE.width + TASK_BATCH_GAP_X,
    );
    expect(rearrangedA2.position.y).toBe(rearrangedA1.position.y);
    // 整块包围盒左上角与重排前一致
    expect(rearrangedA1.position).toEqual({ x: 100, y: 100 });
    // 不与失败任务节点真实占位相交（注册表默认 240×160）
    expect(
      rectsIntersect(
        { x: rearrangedA2.position.x, y: rearrangedA2.position.y, width: ASSET_NODE_DEFAULT_SIZE.width, height: ASSET_NODE_DEFAULT_SIZE.height },
        { x: 2600, y: 1500, width: 240, height: 160 },
      ),
    ).toBe(false);

    // 单条原子历史记录：收口前后的历史增量恰为 1，undo 一步回到散布位置
    expect(useCanvasStore.getState().history.length).toBe(historyLengthBefore + 1);
    useCanvasStore.getState().undo();
    expect(findAssetNode('asset-1').position).toEqual({ x: 100, y: 100 });
    expect(findAssetNode('asset-2').position).toEqual({ x: 1500, y: 800 });
  });

  it('同容器桶按容器内整理语义排布：成员身份保持、块锚点吸附网格', async () => {
    acceptBatch(2);
    const t1 = findTaskNode('task_1');
    const t2 = findTaskNode('task_2');
    if (!t1 || !t2) throw new Error('受理未创建任务节点');
    useCanvasStore.getState().updateNodePosition(t1.id, { x: 100, y: 100 });
    useCanvasStore.getState().updateNodePosition(t2.id, { x: 1400, y: 700 });
    const groupId = useCanvasStore.getState().createGroup([t1.id, t2.id], undefined);
    if (groupId === null) throw new Error('建组失败');

    drive({ taskId: 'task_1', status: 'succeeded', assetIds: ['asset-1'] });
    drive({ taskId: 'task_2', status: 'succeeded', assetIds: ['asset-2'] });
    await flushAsyncFinalize();

    const a1 = findAssetNode('asset-1');
    const a2 = findAssetNode('asset-2');
    // 成员身份保持：产物仍在原组
    expect(a1.groupId).toBe(groupId);
    expect(a2.groupId).toBe(groupId);
    expect(getGroupMembers(requireGraph(), groupId)).toHaveLength(2);

    // 容器内整理语义：成员被排布为相邻网格（不再保持散布），锚点（成员包围盒左上角）
    // 按 AL-GC-006 只吸附一次到最近网格点（默认画板网格 15px，100 → 105），块内相对位置不变。
    expect(Math.abs(a2.position.x - a1.position.x)).toBeLessThan(800);
    expect(Math.abs(a2.position.y - a1.position.y)).toBeLessThan(60);
    const minX = Math.min(a1.position.x, a2.position.x);
    const minY = Math.min(a1.position.y, a2.position.y);
    expect(minX).toBe(alignToGrid(100, DEFAULT_SNAP_GRID[0]));
    expect(minY).toBe(alignToGrid(100, DEFAULT_SNAP_GRID[1]));
    // 产物两两不重叠
    expect(
      rectsIntersect(
        { x: a1.position.x, y: a1.position.y, width: ASSET_NODE_DEFAULT_SIZE.width, height: ASSET_NODE_DEFAULT_SIZE.height },
        { x: a2.position.x, y: a2.position.y, width: ASSET_NODE_DEFAULT_SIZE.width, height: ASSET_NODE_DEFAULT_SIZE.height },
      ),
    ).toBe(false);
  });

  it('每批次至多执行一次：重复终态通知不再重排', async () => {
    acceptBatch(2);
    const t1 = findTaskNode('task_1');
    const t2 = findTaskNode('task_2');
    if (!t1 || !t2) throw new Error('受理未创建任务节点');
    useCanvasStore.getState().updateNodePosition(t1.id, { x: 100, y: 100 });
    useCanvasStore.getState().updateNodePosition(t2.id, { x: 1500, y: 800 });

    drive({ taskId: 'task_1', status: 'succeeded', assetIds: ['asset-1'] });
    drive({ taskId: 'task_2', status: 'succeeded', assetIds: ['asset-2'] });
    await flushAsyncFinalize();
    const afterFirst = findAssetNode('asset-2').position;

    // 晚到的重复终态通知（如快照补投）：收口已执行，不再重排
    drive({ taskId: 'task_2', status: 'succeeded', assetIds: ['asset-2'] });
    await flushAsyncFinalize();
    expect(findAssetNode('asset-2').position).toEqual(afterFirst);
  });

  it('整批无成功产物：不重排，失败任务节点原地保留', async () => {
    acceptBatch(2);
    const t1 = findTaskNode('task_1');
    const t2 = findTaskNode('task_2');
    if (!t1 || !t2) throw new Error('受理未创建任务节点');
    useCanvasStore.getState().updateNodePosition(t1.id, { x: 100, y: 100 });
    useCanvasStore.getState().updateNodePosition(t2.id, { x: 1500, y: 800 });

    drive({ taskId: 'task_1', status: 'failed', assetIds: [] });
    drive({ taskId: 'task_2', status: 'failed', assetIds: [] });
    await flushAsyncFinalize();

    expect(findTaskNode('task_1')?.position).toEqual({ x: 100, y: 100 });
    expect(findTaskNode('task_2')?.position).toEqual({ x: 1500, y: 800 });
  });

  it('未收口批次：失败任务复活撤销终态记账，再次终态时只收口一次', async () => {
    acceptBatch(3);
    const t1 = findTaskNode('task_1');
    const t2 = findTaskNode('task_2');
    const t3 = findTaskNode('task_3');
    if (!t1 || !t2 || !t3) throw new Error('受理未创建任务节点');
    useCanvasStore.getState().updateNodePosition(t1.id, { x: 100, y: 100 });
    useCanvasStore.getState().updateNodePosition(t2.id, { x: 1500, y: 800 });
    useCanvasStore.getState().updateNodePosition(t3.id, { x: 2600, y: 1500 });

    // task_1 先失败并被记账，但批次未收口。
    drive({ taskId: 'task_1', status: 'failed', assetIds: [] });
    // 重新查询结果：failed → polling 撤销 task_1 的终态记账。
    drive({ taskId: 'task_1', status: 'polling', assetIds: [] });
    expect(findTaskNode('task_1')?.data.status).toBe('polling');

    // 其余两个任务成功：若复活没有撤销记账，此刻（failed+2 succeeded）就会误触发收口；
    // 撤销后只记 2/3，三个产物都停在各自的 morph 原位，不重排。
    drive({ taskId: 'task_2', status: 'succeeded', assetIds: ['asset-2'] });
    drive({ taskId: 'task_3', status: 'succeeded', assetIds: ['asset-3'] });
    await flushAsyncFinalize();
    expect(findAssetNode('asset-2').position).toEqual({ x: 1500, y: 800 });
    expect(findAssetNode('asset-3').position).toEqual({ x: 2600, y: 1500 });

    // 复活任务最终成功 → 3/3 终态，收口恰好一次。
    const historyBeforeFinalize = useCanvasStore.getState().history.length;
    drive({ taskId: 'task_1', status: 'succeeded', assetIds: ['asset-1'] });
    await flushAsyncFinalize();

    // 历史增量 = 1（task_1 成功 morph 的替换继任）+ 1（收口整块重排的单条原子历史）。
    expect(useCanvasStore.getState().history.length).toBe(historyBeforeFinalize + 2);
    const a1 = findAssetNode('asset-1');
    const a2 = findAssetNode('asset-2');
    expect(a1.position).toEqual({ x: 100, y: 100 });
    expect(a2.position.x).toBeGreaterThanOrEqual(
      a1.position.x + ASSET_NODE_DEFAULT_SIZE.width + TASK_BATCH_GAP_X,
    );
    expect(a2.position.y).toBe(a1.position.y);

    // 重复终态通知不再二次收口。
    drive({ taskId: 'task_1', status: 'succeeded', assetIds: ['asset-1'] });
    await flushAsyncFinalize();
    expect(useCanvasStore.getState().history.length).toBe(historyBeforeFinalize + 2);
  });

  it('已收口批次：失败任务复活不撤销收口，成功 morph 后不再次重排', async () => {
    acceptBatch(2);
    const t1 = findTaskNode('task_1');
    const t2 = findTaskNode('task_2');
    if (!t1 || !t2) throw new Error('受理未创建任务节点');
    useCanvasStore.getState().updateNodePosition(t1.id, { x: 100, y: 100 });
    useCanvasStore.getState().updateNodePosition(t2.id, { x: 1500, y: 800 });

    drive({ taskId: 'task_1', status: 'succeeded', assetIds: ['asset-1'] });
    // task_2 失败 → 全批终态 → 收口（一次）。
    drive({ taskId: 'task_2', status: 'failed', assetIds: [] });
    await flushAsyncFinalize();
    const a1AfterFinalize = findAssetNode('asset-1').position;
    const task2Position = findTaskNode('task_2')?.position;

    // 已收口批次上的复活：不撤销收口、不重排。
    drive({ taskId: 'task_2', status: 'polling', assetIds: [] });
    drive({ taskId: 'task_2', status: 'succeeded', assetIds: ['asset-2'] });
    await flushAsyncFinalize();

    expect(findAssetNode('asset-1').position).toEqual(a1AfterFinalize);
    // 复活成功的产物在原任务节点位置原位 morph，不参与第二次整批重排。
    expect(findAssetNode('asset-2').position).toEqual(task2Position);
  });
});
